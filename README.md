# LedgerBook — self-hosted, multi-user

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/markmoran4703-cell/Renewal)

> Clicking the button above takes you to Render with this blueprint pre-loaded —
> one click provisions the app **and** its Postgres database.

This is the whole app in one deployable service:

- **The web app** is served at `/` — open the URL and you get LedgerBook.
- **The API** handles accounts, companies, roles, and syncing.
- **Storage** is Postgres in production (via `DATABASE_URL`), or local JSON
  files for zero-setup local development.

Deploy it once and your team opens the same URL, signs in, and shares books
with per-person roles. "Making changes" later = push to your Git repo and it
redeploys automatically.

---

## Deploy to the internet (Render — recommended)

You'll have it live in ~10 minutes. You need a **GitHub account** and a free
**Render account** (https://render.com).

### 1. Put this folder on GitHub

From inside this folder:

```bash
git init
git add .
git commit -m "LedgerBook"
git branch -M main
git remote add origin https://github.com/markmoran4703-cell/Renewal.git
git push -u origin main
```

(Create the empty `ledgerbook` repo on GitHub first, then run the commands.)
If a `.git` folder is already present here, skip `git init` and just set the
remote and push.

### 2. Deploy on Render with the included blueprint

1. In Render: **New ➜ Blueprint**.
2. Connect your GitHub and pick the `Renewal` repo.
3. Render reads **`render.yaml`** and shows two resources: the web service and
   a Postgres database. Click **Apply**.
4. Wait for the first deploy to finish. Render gives you a URL like
   `https://ledgerbook-xxxx.onrender.com`.

That's it. The blueprint wires the database to the app automatically
(`DATABASE_URL`), so there's nothing to configure by hand.

### 3. Use it

- Open your Render URL. The app loads and **auto-points its sync at the same
  address** — no server URL to type.
- Go to **Settings ➜ Cloud sync**, click **Create account**, then **Push** your
  books (or just start entering data).
- Invite teammates from **Members** (viewer / member / admin). They open the
  same URL, sign in, and their device pulls the shared books automatically.

### 4. Make changes later

Edit the files, then:

```bash
git add . && git commit -m "my change" && git push
```

Render redeploys on every push. To change the app UI, edit
`public/index.html` (that's the app) and push.

---

## Live bank feeds (Plaid) — optional

LedgerBook can pull transactions straight from a bank via **Plaid**, in addition
to CSV import. It's **off until you add Plaid keys**, so nothing breaks without them.

1. Create a free developer account at https://dashboard.plaid.com/signup and copy
   your **client_id** and your **Sandbox secret** (Team Settings → Keys).
2. Set env vars on your service: `PLAID_CLIENT_ID`, `PLAID_SECRET`, and
   `PLAID_ENV=sandbox` (use fake test banks — free). Redeploy.
3. In the app: **Import Bank → Connect a bank (live)**. You must be signed in to
   Cloud sync (the connection is stored securely on the server, per company).
   In Sandbox, log into any test bank with username `user_good` / password
   `pass_good`, then **Fetch transactions** and import them like a CSV.
4. To connect **real** banks later, apply for Plaid **Production** access and set
   `PLAID_ENV=production` with your production secret.

Security: bank access tokens are stored **server-side only** and never sent to the
browser; they're also excluded from downloadable backups.

## Run it locally

No database needed for a quick local run — it falls back to JSON files:

```bash
npm install
node server.js
# open http://localhost:4000/
```

To run locally *with* Postgres (to mirror production), set `DATABASE_URL`:

```bash
DATABASE_URL="postgres://user:pass@localhost:5432/ledgerbook" node server.js
```

---

## Roles

| Role   | Read | Edit | Manage members | Delete company |
|--------|:----:|:----:|:--------------:|:--------------:|
| owner  |  ✓   |  ✓   |       ✓        |       ✓        |
| admin  |  ✓   |  ✓   |       ✓        |                |
| member |  ✓   |  ✓   |                |                |
| viewer |  ✓   |      |                |                |

Invited people get access as soon as they register that email address.

---

## Admin dashboard

Open **`/admin`** on your deployment (e.g. `https://your-app.onrender.com/admin`)
and sign in with an admin account to see:

- Totals: users, companies, journal entries, books size, backups.
- Every **company** — owner, member count, entry count, revision, size, last update.
- Every **user** — email, when they joined, how many companies they're in.
- **Backups** — create one on demand, download any snapshot for an offsite copy,
  or restore.

**Who is an admin?** Set `ADMIN_EMAILS` (comma-separated) to the emails allowed
into `/admin`. If you leave it blank, the **first registered account** is
automatically the admin (handy for getting started — set `ADMIN_EMAILS` later to
lock it down).

## Backups

The server takes **automatic full-snapshot backups** on a schedule and keeps the
most recent N. Each snapshot contains all users, companies, and books, so it can
fully restore the system.

- Configure with env vars: `BACKUP_INTERVAL_HOURS` (default `24`, set `0` to
  disable) and `BACKUP_KEEP` (default `14`).
- Snapshots are stored in the database (a `backups` table) — or under
  `data/backups/` in local file mode.
- From `/admin` you can **Back up now**, **Download** a snapshot (keep an offsite
  copy!), or **Restore** one (this overwrites all current data).
- For a full database-level backup you can still use `pg_dump "$DATABASE_URL"`,
  and paid Render Postgres plans add automatic daily backups.
- Individual users can also **Export backup (JSON)** of just their own books from
  the app's Settings.

Because the in-app snapshots live in the same database, treat **Download** (or
`pg_dump`) as your real disaster-recovery copy — keep one somewhere else.

### Data model

- All data lives in Postgres: `users`, `companies`, `books`, and `backups`
  tables (books/backups stored as JSONB).
- Passwords are salted PBKDF2-SHA256 hashes (120k iterations), never plaintext.

### About Render's free tier

- The free **web service** sleeps after ~15 min idle and wakes on the next
  request (a few seconds' cold start). Fine for a small team; upgrade to a paid
  instance to keep it always-on.
- The free **Postgres** is a real managed database but is time-limited by
  Render's current free-database policy. For anything you rely on, upgrade the
  database to a paid plan (a few dollars/month) so it persists and gets
  automatic backups. Your data and setup don't change — only the plan.

---

## Environment variables

| Variable                | Purpose                                                        |
|-------------------------|----------------------------------------------------------------|
| `PORT`                  | Port to listen on (Render sets this automatically).            |
| `DATABASE_URL`          | Postgres connection string. If unset, uses local files.        |
| `ADMIN_EMAILS`          | Comma-separated admin emails. Blank ⇒ first user is admin.     |
| `BACKUP_INTERVAL_HOURS` | Auto-backup interval in hours (default 24; `0` disables).      |
| `BACKUP_KEEP`           | How many backups to retain (default 14).                       |
| `PLAID_ENV`             | Live bank feeds environment: `sandbox` (default) or `production`. |
| `PLAID_CLIENT_ID`       | Plaid client ID. Blank ⇒ live bank feeds disabled (CSV still works). |
| `PLAID_SECRET`          | Plaid secret for the chosen environment. Keep it secret.        |

---

## Security checklist for production

- Render serves your app over **HTTPS** automatically — good. If you self-host
  elsewhere, put it behind HTTPS yourself; passwords/tokens must not travel over
  plain HTTP.
- Consider rate-limiting `/api/login` and `/api/register` if the URL is public.
- Tokens rotate on each login and don't expire; add expiry/refresh if you need
  stricter sessions.

## API reference

Auth is `Authorization: Bearer <token>` from register/login.

| Method | Path                                       | Role needed        |
|--------|--------------------------------------------|--------------------|
| GET    | `/`                                        | — (serves the app) |
| GET    | `/admin`                                   | — (serves admin UI)|
| GET    | `/api/admin/overview`                      | admin              |
| GET    | `/api/admin/backups`                       | admin              |
| POST   | `/api/admin/backups`                       | admin (create)     |
| GET    | `/api/admin/backups/:id`                   | admin (download)   |
| POST   | `/api/admin/backups/:id/restore`           | admin (restore)    |
| GET    | `/api/health`                              | —                  |
| POST   | `/api/register`                     | —                  |
| POST   | `/api/login`                        | —                  |
| GET    | `/api/companies`                    | any user           |
| POST   | `/api/companies`                    | any user           |
| GET    | `/api/companies/:id/members`        | member             |
| POST   | `/api/companies/:id/members`        | owner/admin        |
| DELETE | `/api/companies/:id/members/:email` | owner/admin        |
| DELETE | `/api/companies/:id`                | owner              |
| GET    | `/api/meta?company=:id`             | member             |
| GET    | `/api/data?company=:id`             | member             |
| PUT    | `/api/data?company=:id`             | owner/admin/member |
