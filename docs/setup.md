# Environment & setup

## Requirements

- **Node.js 22.13 or newer** (the database is the built-in `node:sqlite`; there is no separate database server)
- About 200 MB of disk for the application, plus room for the database, documents and backups
- A persistent disk for the `data/` folder in production (database, uploaded documents, backups)

## Install

```bash
npm install
npm run build
```

## Run

| Purpose | Command |
|---|---|
| Development (API with reload + web dev server) | `npm run dev` → <http://localhost:5173> |
| Production (one process serving API and app) | `npm start` → <http://localhost:4000> |

Put the production process behind a TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer)
so every request is HTTPS. Keep it running with a service manager (systemd, PM2, a container restart policy).

## First start: demo data or a clean system

On first start, if the database has no users:

- **Demo** (default): the server loads dated demo data — customers, enquiries, quotations, orders,
  dispatches, invoices, complaints and QR objects — with one demo account per role (password `Veritek@123`).
- **Clean installation**: start with `CRM_NO_DEMO=1`. The server creates one super administrator from
  `CRM_ADMIN_EMAIL` / `CRM_ADMIN_PASSWORD` (or prints a temporary password). That person must change the
  password at first sign-in, then creates everyone else under Settings → People & access.

```bash
CRM_NO_DEMO=1 CRM_ADMIN_EMAIL=it@veritekindia.com CRM_ADMIN_PASSWORD='<a strong password>' npm start
```

Then, as the administrator:

1. **Settings → Company & commercial** — company profile (printed on quotations), approval thresholds,
   quotation defaults, reminders, QR public address.
2. **Settings → Regions, factories & rules** — sales regions with their states, factories, enquiry
   assignment rules, customer tags.
3. **Products & prices** — categories, models, prices, minimum price and cost, configurator options, datasheets.
4. **Settings → People & access** — one account per person with role, region or factory; named owners
   who do not sign in.
5. **Settings → Imports** — customers, enquiries and open order lines from the old sheets (see [imports.md](imports.md)).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `CRM_DATA_DIR` | `./data` | Folder for the database, documents (`files/`) and backups |
| `CRM_DB` | `<data>/veritek.sqlite` | Database file |
| `CRM_BACKUP_DIR` | `<data>/backups` | Where backups are written — point this at a different disk or a mounted bucket |
| `CRM_NO_DEMO` | — | `1` = never load demo data; create a first administrator instead |
| `CRM_ADMIN_EMAIL`, `CRM_ADMIN_PASSWORD` | — | First administrator for a clean installation |
| `CRM_NO_SCHEDULER` | — | `1` = do not run the reminder evaluator and daily backup in this process |
| `CRM_TOKEN_SECRET` | — | Signs session tokens on serverless hosting where sessions cannot be stored. Set a long random value there |
| `CRM_FILE_SECRET` | generated | Signs short-lived document links. Generated and stored in the database if not set |
| `CRM_ENV` / `NODE_ENV` | `development` | `production` hides the environment badge |
| `CRM_DEMO` | — | `1` = show the “demo data” banner |
| `CRM_NO_SNAPSHOT` | — | `1` = do not restore `seed/veritek-seed.sqlite` into an empty data folder |

Secrets belong in the host's secret store or environment, never in the repository.

## Serverless demo (Vercel)

`vercel.json` deploys the built app with the API as a serverless function. The data folder is temporary
there: on each cold start the server restores the demo snapshot `seed/veritek-seed.sqlite` and
`seed/files`. This suits a public demo only — changes disappear when the instance is recycled. Refresh the
snapshot with `npm run snapshot` before deploying a demo. For real use, run on a host with a persistent disk.

## Updating

```bash
git pull && npm install && npm run build && <restart the service>
```

The schema is applied automatically at start-up (`server/migrations`). Take a backup first (`npm run backup`).
