#!/usr/bin/env node
/* ============================================================
   LedgerBook Server  (v3 — multi-user, Postgres, serves the app)

   • Serves the LedgerBook web app at /  (single deployable unit)
   • Multi-user API: accounts, companies, roles, revisioned books
   • Storage: Postgres when DATABASE_URL is set, else local JSON files

   Run:   npm install && node server.js
   Env:   PORT (default 4000), DATABASE_URL (optional Postgres)
   ============================================================ */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const createStore = require('./storage');

const PORT = process.env.PORT || 4000;
const MAX_BODY = 25 * 1024 * 1024;
const ROLES = ['owner', 'admin', 'member', 'viewer'];
const canWrite = (r) => r === 'owner' || r === 'admin' || r === 'member';
const canManage = (r) => r === 'owner' || r === 'admin';
const store = createStore();

// The app: prefer public/index.html, fall back to ../ledgerbook.html
const APP_CANDIDATES = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, '..', 'ledgerbook.html')];
let APP_HTML = '<h1>LedgerBook</h1><p>App file not found. Place the app at public/index.html.</p>';
for (const p of APP_CANDIDATES) { if (fs.existsSync(p)) { APP_HTML = fs.readFileSync(p, 'utf8'); break; } }
const ADMIN_PATH = path.join(__dirname, 'public', 'admin.html');
let ADMIN_HTML = fs.existsSync(ADMIN_PATH) ? fs.readFileSync(ADMIN_PATH, 'utf8') : '<h1>Admin</h1><p>admin.html not found.</p>';

// Admins are configured via ADMIN_EMAILS (comma-separated). If unset, the FIRST
// registered account is treated as admin (bootstrap convenience).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
async function isAdmin(email) {
  if (!email) return false;
  if (ADMIN_EMAILS.length) return ADMIN_EMAILS.includes(email);
  // bootstrap: no ADMIN_EMAILS set -> the earliest-created user is admin
  const users = await store.allUsers();
  const emails = Object.keys(users);
  if (!emails.length) return false;
  emails.sort((a, b) => new Date(users[a].created || 0) - new Date(users[b].created || 0));
  return email === emails[0];
}

// ---- backups ----
const BACKUP_HOURS = process.env.BACKUP_INTERVAL_HOURS != null ? Number(process.env.BACKUP_INTERVAL_HOURS) : 24;
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 14);
let _backupSeq = 0;
async function buildSnapshot() {
  const companies = await store.allCompanies();
  const users = await store.allUsers();
  const books = {};
  for (const id in companies) books[id] = await store.getBooks(id);
  return { version: 3, createdAt: new Date().toISOString(), counts: { users: Object.keys(users).length, companies: Object.keys(companies).length }, users, companies, books };
}
async function createBackup() {
  const snap = await buildSnapshot();
  const id = 'bk_' + snap.createdAt.replace(/[:.]/g, '-') + '_' + (_backupSeq++);
  await store.addBackup(id, snap);
  if (BACKUP_KEEP > 0) await store.pruneBackups(BACKUP_KEEP);
  return { id, createdAt: snap.createdAt, counts: snap.counts };
}
function startBackupScheduler() {
  if (!BACKUP_HOURS || BACKUP_HOURS <= 0) { console.log('Auto-backup: disabled'); return; }
  const ms = BACKUP_HOURS * 3600 * 1000;
  const tick = async () => { try { const b = await createBackup(); console.log('Auto-backup created:', b.id); } catch (e) { console.error('Auto-backup failed:', e.message); } };
  // first backup shortly after boot if none exists today, then on interval
  setTimeout(async () => { try { const list = await store.listBackups(); const today = new Date().toISOString().slice(0, 10); if (!list.some((b) => (b.createdAt || '').slice(0, 10) === today)) await tick(); } catch (e) {} }, 8000);
  setInterval(tick, ms);
  console.log('Auto-backup: every ' + BACKUP_HOURS + 'h, keeping ' + BACKUP_KEEP);
}

const emailKey = (e) => String(e || '').trim().toLowerCase();
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}
const makeToken = () => crypto.randomBytes(24).toString('hex');
const newId = (p) => p + crypto.randomBytes(6).toString('hex');

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(obj));
}
function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); } else data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
async function authUser(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const u = await store.findUserByToken(m[1]);
  return u ? u.email : null;
}
function roleOfCompany(company, email) {
  if (!company) return null;
  if (company.owner === email) return 'owner';
  return (company.members && company.members[email]) || null;
}
async function companiesForUser(email) {
  const all = await store.allCompanies();
  const out = [];
  for (const id in all) {
    const role = roleOfCompany(all[id], email);
    if (role) out.push({ id, name: all[id].name, role, owner: all[id].owner, rev: all[id].rev || 0, updatedAt: all[id].updatedAt || null });
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = u.pathname;
  const q = u.searchParams;
  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    /* ---------- serve the app ---------- */
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app')) return sendHtml(res, APP_HTML);
    if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin.html')) return sendHtml(res, ADMIN_HTML);
    if (pathname === '/api/health') return send(res, 200, { ok: true, service: 'ledgerbook', version: 3, storage: store.kind, time: new Date().toISOString() });

    /* ---------- register ---------- */
    if (pathname === '/api/register' && req.method === 'POST') {
      const { email, password, name } = await readBody(req);
      const key = emailKey(email);
      if (!key || !password || String(password).length < 4) return send(res, 400, { error: 'Email and a password (4+ chars) required' });
      if (await store.getUser(key)) return send(res, 409, { error: 'Account already exists — sign in instead' });
      const { salt, hash } = hashPassword(password);
      const token = makeToken();
      await store.setUser(key, { salt, hash, token, name: name || '' });
      return send(res, 200, { ok: true, token, email: key, companies: await companiesForUser(key) });
    }

    /* ---------- login ---------- */
    if (pathname === '/api/login' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const key = emailKey(email);
      const usr = await store.getUser(key);
      if (!usr) return send(res, 401, { error: 'No such account' });
      const { hash } = hashPassword(password, usr.salt);
      if (hash !== usr.hash) return send(res, 401, { error: 'Wrong password' });
      usr.token = makeToken();
      await store.setUser(key, usr);
      return send(res, 200, { ok: true, token: usr.token, email: key, companies: await companiesForUser(key) });
    }

    /* everything below requires auth */
    const me = await authUser(req);
    if (!me) return send(res, 401, { error: 'Not authenticated' });

    /* ---------- admin ---------- */
    if (pathname.indexOf('/api/admin/') === 0) {
      if (!(await isAdmin(me))) return send(res, 403, { error: 'Admin access required' });

      if (pathname === '/api/admin/overview' && req.method === 'GET') {
        const usersMap = await store.allUsers();
        const companies = await store.allCompanies();
        const compList = [];
        for (const id in companies) {
          const c = companies[id];
          const books = await store.getBooks(id);
          const sizeBytes = books ? Buffer.byteLength(JSON.stringify(books)) : 0;
          const je = books && Array.isArray(books.journal) ? books.journal.length : 0;
          compList.push({ id, name: c.name, owner: c.owner, members: 1 + Object.keys(c.members || {}).length, rev: c.rev || 0, updatedAt: c.updatedAt, sizeBytes, journalEntries: je });
        }
        const users = Object.keys(usersMap).map((e) => ({ email: e, name: usersMap[e].name || '', created: usersMap[e].created || null, companies: compList.filter((c) => c.owner === e || (companies[c.id].members || {})[e]).length, admin: ADMIN_EMAILS.length ? ADMIN_EMAILS.includes(e) : false }));
        return send(res, 200, { ok: true, storage: store.kind, adminMode: ADMIN_EMAILS.length ? 'env' : 'first-user', users, companies: compList });
      }
      if (pathname === '/api/admin/backups' && req.method === 'GET')
        return send(res, 200, { ok: true, backups: await store.listBackups(), config: { intervalHours: BACKUP_HOURS, keep: BACKUP_KEEP } });
      if (pathname === '/api/admin/backups' && req.method === 'POST')
        return send(res, 200, { ok: true, backup: await createBackup() });
      let bm = pathname.match(/^\/api\/admin\/backups\/([^\/]+)$/);
      if (bm && req.method === 'GET') {
        const snap = await store.getBackup(bm[1]);
        if (!snap) return send(res, 404, { error: 'Backup not found' });
        return send(res, 200, snap);
      }
      let rm = pathname.match(/^\/api\/admin\/backups\/([^\/]+)\/restore$/);
      if (rm && req.method === 'POST') {
        const snap = await store.getBackup(rm[1]);
        if (!snap) return send(res, 404, { error: 'Backup not found' });
        await store.restore(snap);
        return send(res, 200, { ok: true, restored: rm[1], counts: snap.counts });
      }
      return send(res, 404, { error: 'Unknown admin endpoint' });
    }

    /* ---------- list my companies ---------- */
    if (pathname === '/api/companies' && req.method === 'GET')
      return send(res, 200, { ok: true, companies: await companiesForUser(me) });

    /* ---------- create company ---------- */
    if (pathname === '/api/companies' && req.method === 'POST') {
      const { name } = await readBody(req);
      const id = newId('co_');
      await store.setCompany(id, { name: (name || 'My Company').trim(), owner: me, members: {}, rev: 0, updatedAt: new Date().toISOString(), created: new Date().toISOString() });
      return send(res, 200, { ok: true, id, name: (name || 'My Company').trim(), role: 'owner' });
    }

    /* ---------- members ---------- */
    let mm = pathname.match(/^\/api\/companies\/([^\/]+)\/members\/?([^\/]*)$/);
    if (mm) {
      const companyId = mm[1];
      const targetEmail = emailKey(decodeURIComponent(mm[2] || ''));
      const c = await store.getCompany(companyId);
      const myRole = roleOfCompany(c, me);
      if (!myRole) return send(res, 403, { error: 'Not a member of this company' });

      if (req.method === 'GET') {
        const list = [{ email: c.owner, role: 'owner' }].concat(Object.keys(c.members || {}).map((e) => ({ email: e, role: c.members[e] })));
        return send(res, 200, { ok: true, members: list });
      }
      if (req.method === 'POST') {
        if (!canManage(myRole)) return send(res, 403, { error: 'Only owner/admin can add members' });
        const { email, role } = await readBody(req);
        const key = emailKey(email);
        if (!key) return send(res, 400, { error: 'Email required' });
        if (!ROLES.includes(role) || role === 'owner') return send(res, 400, { error: 'Role must be admin, member or viewer' });
        if (key === c.owner) return send(res, 400, { error: 'That user is the owner' });
        c.members = c.members || {}; c.members[key] = role;
        await store.setCompany(companyId, c);
        const exists = !!(await store.getUser(key));
        return send(res, 200, { ok: true, email: key, role, pending: !exists });
      }
      if (req.method === 'DELETE') {
        if (!canManage(myRole)) return send(res, 403, { error: 'Only owner/admin can remove members' });
        if (targetEmail === c.owner) return send(res, 400, { error: 'Cannot remove the owner' });
        if (c.members) delete c.members[targetEmail];
        await store.setCompany(companyId, c);
        return send(res, 200, { ok: true });
      }
    }

    /* ---------- delete company (owner) ---------- */
    let dm = pathname.match(/^\/api\/companies\/([^\/]+)$/);
    if (dm && req.method === 'DELETE') {
      const companyId = dm[1];
      const c = await store.getCompany(companyId);
      if (roleOfCompany(c, me) !== 'owner') return send(res, 403, { error: 'Only the owner can delete a company' });
      await store.delCompany(companyId);
      return send(res, 200, { ok: true });
    }

    /* ---------- meta (poll) ---------- */
    if (pathname === '/api/meta' && req.method === 'GET') {
      const c = await store.getCompany(q.get('company'));
      const role = roleOfCompany(c, me);
      if (!role) return send(res, 403, { error: 'No access to this company' });
      return send(res, 200, { ok: true, rev: c.rev || 0, updatedAt: c.updatedAt || null, role });
    }

    /* ---------- books data ---------- */
    if (pathname === '/api/data') {
      const companyId = q.get('company');
      const c = await store.getCompany(companyId);
      const role = roleOfCompany(c, me);
      if (!role) return send(res, 403, { error: 'No access to this company' });

      if (req.method === 'GET') {
        const data = await store.getBooks(companyId);
        return send(res, 200, { ok: true, data, rev: c.rev || 0, updatedAt: c.updatedAt || null, role });
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        if (!canWrite(role)) return send(res, 403, { error: 'Your role is read-only (viewer)' });
        const body = await readBody(req);
        const data = body.data || body;
        if (!data || typeof data !== 'object' || !Array.isArray(data.accounts)) return send(res, 400, { error: 'Payload must include books with an accounts array' });
        if (typeof body.baseRev === 'number' && body.baseRev < (c.rev || 0) && !body.force)
          return send(res, 409, { error: 'Stale write — server has newer changes', serverRev: c.rev });
        await store.setBooks(companyId, data);
        c.rev = (c.rev || 0) + 1;
        c.updatedAt = new Date().toISOString();
        await store.setCompany(companyId, c);
        return send(res, 200, { ok: true, rev: c.rev, updatedAt: c.updatedAt });
      }
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(res, 400, { error: e.message || 'Bad request' });
  }
});

store.init().then(() => {
  server.listen(PORT, () => {
    console.log('LedgerBook server (v3) on http://localhost:' + PORT + '  ·  storage: ' + store.kind);
    console.log('Open the app at  http://localhost:' + PORT + '/   ·   admin at /admin');
    if (!ADMIN_EMAILS.length) console.log('Admin: ADMIN_EMAILS not set — the first registered account is admin.');
    startBackupScheduler();
  });
}).catch((e) => { console.error('Storage init failed:', e); process.exit(1); });
