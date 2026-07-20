'use strict';
/* ============================================================
   Storage abstraction for LedgerBook.
   - If DATABASE_URL is set -> Postgres (production).
   - Otherwise -> local JSON files under ./data (zero-setup dev).
   Both backends expose the same async interface.
   ============================================================ */
const fs = require('fs');
const path = require('path');

/* ---------------- File backend (local dev) ---------------- */
function fileStore(dataDir) {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const USERS = path.join(dataDir, 'users.json');
  const COMPS = path.join(dataDir, 'companies.json');
  if (!fs.existsSync(USERS)) fs.writeFileSync(USERS, '{}');
  if (!fs.existsSync(COMPS)) fs.writeFileSync(COMPS, '{}');
  const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8') || '{}');
  const wr = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
  const booksFile = (id) => path.join(dataDir, 'books_' + id + '.json');
  const plaidFile = (id) => path.join(dataDir, 'plaid_' + id + '.json');
  const backupDir = path.join(dataDir, 'backups');
  const backupFile = (id) => path.join(backupDir, id + '.json');
  return {
    kind: 'file',
    async init() { if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true }); },
    async getUser(email) { return rd(USERS)[email] || null; },
    async setUser(email, obj) { const u = rd(USERS); u[email] = obj; wr(USERS, u); },
    async findUserByToken(token) { const u = rd(USERS); for (const e in u) if (u[e].token === token) return Object.assign({ email: e }, u[e]); return null; },
    async allUsers() { return rd(USERS); },
    async allCompanies() { return rd(COMPS); },
    async getCompany(id) { return rd(COMPS)[id] || null; },
    async setCompany(id, obj) { const c = rd(COMPS); c[id] = obj; wr(COMPS, c); },
    async delCompany(id) { const c = rd(COMPS); delete c[id]; wr(COMPS, c); try { fs.unlinkSync(booksFile(id)); } catch (e) {} try { fs.unlinkSync(plaidFile(id)); } catch (e) {} },
    // ---- Plaid bank connections (access tokens live server-side only) ----
    async getPlaidItems(companyId) { const f = plaidFile(companyId); if (!fs.existsSync(f)) return []; let o = {}; try { o = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { o = {}; } return Object.keys(o).map((itemId) => Object.assign({ itemId }, o[itemId])); },
    async setPlaidItem(companyId, itemId, obj) { const f = plaidFile(companyId); let o = {}; if (fs.existsSync(f)) { try { o = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { o = {}; } } o[itemId] = obj; fs.writeFileSync(f, JSON.stringify(o, null, 2)); },
    async delPlaidItem(companyId, itemId) { const f = plaidFile(companyId); if (!fs.existsSync(f)) return; let o = {}; try { o = JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch (e) { o = {}; } delete o[itemId]; fs.writeFileSync(f, JSON.stringify(o, null, 2)); },
    async getBooks(id) { const f = booksFile(id); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; },
    async setBooks(id, data) { fs.writeFileSync(booksFile(id), JSON.stringify(data)); },
    async addBackup(id, snapshot) { if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true }); fs.writeFileSync(backupFile(id), JSON.stringify(snapshot)); },
    async listBackups() { if (!fs.existsSync(backupDir)) return []; return fs.readdirSync(backupDir).filter((f) => f.endsWith('.json')).map((f) => { const id = f.replace(/\.json$/, ''); const st = fs.statSync(path.join(backupDir, f)); return { id, createdAt: st.mtime.toISOString(), sizeBytes: st.size }; }).sort((a, b) => a.createdAt < b.createdAt ? 1 : -1); },
    async getBackup(id) { const f = backupFile(id); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; },
    async pruneBackups(keep) { const list = await this.listBackups(); for (const b of list.slice(keep)) { try { fs.unlinkSync(backupFile(b.id)); } catch (e) {} } },
    async restore(snapshot) {
      wr(USERS, snapshot.users || {}); wr(COMPS, snapshot.companies || {});
      // clear existing books then write from snapshot
      for (const f of fs.readdirSync(dataDir)) if (/^books_.*\.json$/.test(f)) { try { fs.unlinkSync(path.join(dataDir, f)); } catch (e) {} }
      for (const id in (snapshot.books || {})) if (snapshot.books[id]) fs.writeFileSync(booksFile(id), JSON.stringify(snapshot.books[id]));
    },
  };
}

/* ---------------- Postgres backend (production) ---------------- */
function pgStore(url) {
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1|\/)/.test(url) || /host=(localhost|127\.0\.0\.1)/.test(url) || url.indexOf('/tmp') !== -1;
  const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
  const mapCompany = (r) => r ? { name: r.name, owner: r.owner, members: r.members || {}, rev: r.rev || 0, updatedAt: r.updated_at, created: r.created } : null;
  return {
    kind: 'postgres',
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS users(
        email TEXT PRIMARY KEY, salt TEXT, hash TEXT, token TEXT, name TEXT,
        created TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS companies(
        id TEXT PRIMARY KEY, name TEXT, owner TEXT, members JSONB DEFAULT '{}'::jsonb,
        rev INTEGER DEFAULT 0, updated_at TIMESTAMPTZ, created TIMESTAMPTZ DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS books(company_id TEXT PRIMARY KEY, data JSONB)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS backups(id TEXT PRIMARY KEY, created TIMESTAMPTZ DEFAULT now(), data JSONB)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS plaid_items(
        company_id TEXT, item_id TEXT, access_token TEXT, institution TEXT,
        accounts JSONB DEFAULT '[]'::jsonb, created TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY(company_id, item_id))`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_token ON users(token)`);
    },
    async getUser(email) { const r = await pool.query('SELECT * FROM users WHERE email=$1', [email]); return r.rows[0] || null; },
    async setUser(email, obj) {
      await pool.query(
        `INSERT INTO users(email,salt,hash,token,name) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(email) DO UPDATE SET salt=$2,hash=$3,token=$4,name=$5`,
        [email, obj.salt, obj.hash, obj.token, obj.name || '']);
    },
    async findUserByToken(token) { const r = await pool.query('SELECT * FROM users WHERE token=$1', [token]); return r.rows[0] || null; },
    async allUsers() { const r = await pool.query('SELECT * FROM users'); const o = {}; for (const row of r.rows) o[row.email] = { salt: row.salt, hash: row.hash, token: row.token, name: row.name, created: row.created }; return o; },
    async allCompanies() { const r = await pool.query('SELECT * FROM companies'); const o = {}; for (const row of r.rows) o[row.id] = mapCompany(row); return o; },
    async getCompany(id) { const r = await pool.query('SELECT * FROM companies WHERE id=$1', [id]); return mapCompany(r.rows[0]); },
    async setCompany(id, obj) {
      await pool.query(
        `INSERT INTO companies(id,name,owner,members,rev,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)
         ON CONFLICT(id) DO UPDATE SET name=$2,owner=$3,members=$4::jsonb,rev=$5,updated_at=$6`,
        [id, obj.name, obj.owner, JSON.stringify(obj.members || {}), obj.rev || 0, obj.updatedAt || new Date().toISOString()]);
    },
    async delCompany(id) { await pool.query('DELETE FROM companies WHERE id=$1', [id]); await pool.query('DELETE FROM books WHERE company_id=$1', [id]); await pool.query('DELETE FROM plaid_items WHERE company_id=$1', [id]); },
    // ---- Plaid bank connections (access tokens live server-side only) ----
    async getPlaidItems(companyId) { const r = await pool.query('SELECT * FROM plaid_items WHERE company_id=$1 ORDER BY created', [companyId]); return r.rows.map((row) => ({ itemId: row.item_id, accessToken: row.access_token, institution: row.institution, accounts: row.accounts || [], created: row.created })); },
    async setPlaidItem(companyId, itemId, obj) { await pool.query(`INSERT INTO plaid_items(company_id,item_id,access_token,institution,accounts) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(company_id,item_id) DO UPDATE SET access_token=$3,institution=$4,accounts=$5::jsonb`, [companyId, itemId, obj.accessToken, obj.institution || '', JSON.stringify(obj.accounts || [])]); },
    async delPlaidItem(companyId, itemId) { await pool.query('DELETE FROM plaid_items WHERE company_id=$1 AND item_id=$2', [companyId, itemId]); },
    async getBooks(id) { const r = await pool.query('SELECT data FROM books WHERE company_id=$1', [id]); return r.rows[0] ? r.rows[0].data : null; },
    async setBooks(id, data) {
      await pool.query(
        `INSERT INTO books(company_id,data) VALUES($1,$2::jsonb)
         ON CONFLICT(company_id) DO UPDATE SET data=$2::jsonb`,
        [id, JSON.stringify(data)]);
    },
    async addBackup(id, snapshot) { await pool.query(`INSERT INTO backups(id,created,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET data=$3::jsonb`, [id, snapshot.createdAt || new Date().toISOString(), JSON.stringify(snapshot)]); },
    async listBackups() { const r = await pool.query(`SELECT id, created, octet_length(data::text) AS size FROM backups ORDER BY created DESC`); return r.rows.map((row) => ({ id: row.id, createdAt: row.created, sizeBytes: +row.size })); },
    async getBackup(id) { const r = await pool.query('SELECT data FROM backups WHERE id=$1', [id]); return r.rows[0] ? r.rows[0].data : null; },
    async pruneBackups(keep) { await pool.query(`DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY created DESC LIMIT $1)`, [keep]); },
    async restore(snapshot) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM books'); await client.query('DELETE FROM companies'); await client.query('DELETE FROM users');
        for (const email in (snapshot.users || {})) { const u = snapshot.users[email]; await client.query(`INSERT INTO users(email,salt,hash,token,name) VALUES($1,$2,$3,$4,$5)`, [email, u.salt, u.hash, u.token, u.name || '']); }
        for (const id in (snapshot.companies || {})) { const c = snapshot.companies[id]; await client.query(`INSERT INTO companies(id,name,owner,members,rev,updated_at) VALUES($1,$2,$3,$4::jsonb,$5,$6)`, [id, c.name, c.owner, JSON.stringify(c.members || {}), c.rev || 0, c.updatedAt || new Date().toISOString()]); }
        for (const id in (snapshot.books || {})) if (snapshot.books[id]) await client.query(`INSERT INTO books(company_id,data) VALUES($1,$2::jsonb)`, [id, JSON.stringify(snapshot.books[id])]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    },
  };
}

module.exports = function createStore() {
  const url = process.env.DATABASE_URL;
  if (url) { console.log('Storage: Postgres'); return pgStore(url); }
  console.log('Storage: local files (./data) — set DATABASE_URL for Postgres');
  return fileStore(path.join(__dirname, 'data'));
};
