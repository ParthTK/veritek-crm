# Environment & setup

## Requirements

- **Node.js 22.13 or newer**
- **Database: PostgreSQL.** In production this is Google Cloud SQL (or any PostgreSQL 15+ server). Without a
  database server configured, the CRM runs an embedded PostgreSQL (PGlite) in `data/pgdata` — used for local
  work and the tests, with nothing else to install.
- **Documents:** a Google Cloud Storage bucket in production, or the `data/files` folder locally.

The production set-up on Google Cloud (Cloud Run, Cloud SQL, Cloud Storage, Cloud Scheduler) is described
step by step in [deploy-google-cloud.md](deploy-google-cloud.md).

## Install

```bash
npm install
npm run build
```

## Run

| Purpose | Command |
|---|---|
| Development (API with reload + web dev server) | `npm run dev` → <http://localhost:5173> |
| Production-style (one process serving API and app) | `npm start` → <http://localhost:4000> |

Locally both use the embedded database in `data/pgdata`. Only one process may open that folder at a time.

## First start: a clean installation

On first start, if the database has no users, the server sets up a clean installation (`server/setup.js`).
There is no demo data: no sample customers, people, enquiries, quotations, orders, campaigns, objects or
documents. It creates the reference data only — the five sales regions, the product categories and the 19
product models with their specifications (standard, dealer, distributor, minimum and cost prices,
configurator price changes and stock quantities left blank), the starter object categories, default settings
and dropdowns — and one super administrator from `CRM_ADMIN_EMAIL` / `CRM_ADMIN_PASSWORD` (or prints a
temporary password). That person must change the password at first sign-in, then fills in prices and
factories and creates everyone else under Settings → People & access.

```bash
CRM_ADMIN_EMAIL=it@veritekindia.com CRM_ADMIN_PASSWORD='<a strong password>' npm start
```

The automatic tests use their own sample data (`tests/sample-data.mjs`). It is built only inside the tests'
throwaway folder, which is deleted afterwards, and it refuses any database that already has accounts.

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
| `CRM_DATABASE_URL` | — | PostgreSQL connection string. Alternatively set the standard `PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` (on Cloud Run `PGHOST` is the Cloud SQL socket `/cloudsql/<instance>`). With neither, the embedded database is used |
| `CRM_PG_SCHEMA` | — | Schema holding the CRM's tables when the database is shared (production: `crm`) |
| `CRM_FILES_BUCKET` | — | Google Cloud Storage bucket for documents and backups. Without it, `data/files` |
| `CRM_DATA_DIR` | `./data` | Local folder: the embedded database (`pgdata/`) and documents (`files/`) |
| `CRM_PGLITE_DIR` | `<data>/pgdata` | Embedded database folder |
| `CRM_ADMIN_EMAIL`, `CRM_ADMIN_PASSWORD` | — | First administrator of a new installation (used only while there are no users) |
| `CRM_NO_SCHEDULER` | — | `1` = do not run the reminder evaluator and daily backup in this process (Cloud Run: Cloud Scheduler calls `POST /api/internal/scheduled` instead) |
| `CRM_CRON_SECRET` | — | Shared secret Cloud Scheduler sends in the `X-Cron-Secret` header. Without it the endpoint does not exist |
| `CRM_TOKEN_SECRET` | generated | Signs short-lived public links. Generated and stored in the database if not set |
| `CRM_FILE_SECRET` | generated | Signs short-lived document links. Generated and stored in the database if not set |
| `CRM_ENV` / `NODE_ENV` | `development` | `production` hides the environment badge |
| `CRM_DB_TIMEOUT_MS` | `120000` | How long a single database call may take before it is abandoned |

Secrets belong in the host's secret store (Google Secret Manager in production), never in the repository.

## How the server talks to the database

The application code uses one synchronous data API (`all`, `get`, `run`, `insert`, `update`, `tx` in
`server/db.js`). Queries run in a worker thread that holds the single database connection, and the request
waits for each answer — so statements and transactions are handled one at a time, exactly as the code
expects. Run one instance (Cloud Run: maximum instances 1); for Veritek's team size one instance is ample.

## Updating

On Google Cloud, redeploy (see [deploy-google-cloud.md](deploy-google-cloud.md)). Elsewhere:

```bash
git pull && npm install && npm run build && <restart the service>
```

The schema is applied automatically at start-up (`server/migrations`). Take a backup first (`npm run backup`).
