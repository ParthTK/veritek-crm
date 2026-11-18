# Veritek CRM — customer, quotation and order control

The CRM for Veritek's panel-meter business: one record per customer, every enquiry tracked to a decision,
quotations priced from the approved price list with discount and margin approvals, confirmed orders followed
line by line through production, QC and dispatch, and the money and service that follow.

Built to the *Veritek CRM Development Specification v1.0* (16 Nov 2026), and keeping every module of the
earlier system (products & price list, quotation builder, campaigns, objects & QR codes, team targets,
customer portal, production board, dispatches, payments and complaints).

```
Enquiry → Quotation (approval) → Customer link → Order → Production → QC → Dispatch → Invoice → Receipt → Service
```

## Modules

| Area | What it does |
|---|---|
| **Overview & work queue** | Daily enquiries, replied / not replied, pending quotations, active orders, production status and delays, then the exceptions: overdue follow-ups, late or stale order lines, customers not informed, approvals waiting |
| **Follow-ups** | One task list for every person; outcomes recorded in a few taps, the next action scheduled in the same step |
| **Sales dashboard** | Enquiries, weighted pipeline, quotations, orders, receivables, target vs achievement, salespeople |
| **Past customers** | Dormant buyers to reconnect with, with reasons and outcomes kept |
| **Customers & contacts** | The starting point: unified profile (history, enquiries, quotations, orders, payments, complaints, exhibitions visited, deals in progress); duplicate checks and merge; regions, tags, interests, credit hold |
| **Enquiries** | Added against a customer: details, notes, source, reply status, follow-ups and assigned person; list and stage board with a 30/60/90-day forecast |
| **Quotations** | Builder priced from the product master (standard / dealer / distributor list), configurator options, discounts, GST, freight; approval routing; immutable revisions with comparison; issue evidence; customer link to accept or ask for changes; idempotent conversion to an order |
| **Sales pipeline** | Every live deal across enquiry → quotation → confirmation → payment → production → dispatch, showing where it is, how long it has been there and why it is stuck |
| **Exhibitions** | Exhibitions attended, customers visited and enquiries generated (Exhibition as a lead source is linked to the event), follow-up by salesperson, cost and return; also dealer meets and other events |
| **Active orders** | Line-level quantities, production progress, payment status, original / forecast / agreed dates kept separately, delay reasons, customer communication, cancellations, amendments, payment holds |
| **Production board** | Every active line by phase with blocker, forecast, payment status and freshness; QC passes recorded by Quality |
| **Dispatches** | Planned and actual shipments, transport details, delivery and proof of delivery, customer notification, reversals |
| **Payments** | Invoice register, receipts with TDS and deductions, credit notes, advances, ageing, promises, holds |
| **Complaints & service** | Severity, warranty, site visits, root cause vs reported symptom, resolution, feedback rating, quality insights |
| **Products & prices** | Price list with minimum price and cost, GST, warranty, lead time, configurator options, datasheets |
| **QR module** | A separate module, not part of the sales flow: permanent QR codes for machines, panels and documents; public scan pages; labels; its own settings |
| **Reports** | 24 defined reports with stated definitions, denominators and drill-down to the records; CSV export |
| **Team & approvals** | Approval queue, monthly targets, performance shown with workload |
| **Settings** | People and access, approval policy, quotation defaults, reminders, regions, factories, assignment rules, dropdowns, imports, backups, audit log |

## Quick start

Requires **Node.js 22.13+**. The database is PostgreSQL: Google Cloud SQL in production, and an embedded
PostgreSQL (PGlite) in `data/pgdata` locally — nothing else to install. Production runs on Google Cloud Run;
see [docs/deploy-google-cloud.md](docs/deploy-google-cloud.md).

```bash
npm install
npm run dev          # API on :4000 and the web app on :5173 → open http://localhost:5173
```

On first start the server creates the embedded database in `data/pgdata` and fills it with dated demo data (customers,
enquiries, quotations, orders, dispatches, invoices, complaints, objects). Rebuild it at any time with:

```bash
npm run seed
```

Production-style (one process serving the built app):

```bash
npm run build && npm start   # http://localhost:4000
```

| Command | What it does |
|---|---|
| `npm run dev` | API with `--watch` plus the Vite dev server |
| `npm run build` | Builds the React app into `client/dist` |
| `npm start` | Serves the API and the built app on one port |
| `npm run seed` | Drops and rebuilds the demo database (refuses if it holds real accounts) |
| `npm test` | Seeds a throwaway database and runs the acceptance journey (82 checks), the Objects & QR suite, the customer-to-dispatch flow (57 checks) and a sweep of every endpoint, then checks a clean installation |
| `npm run snapshot` | Rebuilds `seed/veritek-demo.tar.gz` + `seed/files`, the demo data shipped with a serverless deployment |
| `npm run backup` | Backs up every table and the documents with a checksummed manifest |
| `npm run restore-test` | Reads the latest backup back and reconciles records, files and quantities |
| `npm run restore -- <backup>` | Restores a backup into an empty database |

For a real installation start without demo data: `CRM_NO_DEMO=1 CRM_ADMIN_EMAIL=… npm start` gives the
product models (prices blank), sales regions, settings and one administrator, and nothing else —
see [docs/setup.md](docs/setup.md).

## Demo accounts

Password for every demo account: `Veritek@123`.

| Email | Role | Sees |
|---|---|---|
| `admin@veritek.example` | Super admin | Everything, including settings, users and the audit log |
| `md@veritek.example` | Management | All records and reports; approves quotations |
| `viewer@veritek.example` | Read-only management | Dashboards, profiles and reports; cannot change anything |
| `coordinator@veritek.example` | Data coordinator | Work queue; records updates on behalf of others; imports |
| `saleshead@veritek.example` | Sales head | All regions; approvals above the manager threshold; targets |
| `rsm.west@veritek.example` | Regional sales manager | West region customers; approves West quotations |
| `saurav@veritek.example` | Sales executive (West) | Their own customers and work |
| `kavya@veritek.example` | Export executive | Their own export customers |
| `commercial@veritek.example` | Quotation / commercial | Quotations, PO checks and order entry for all customers |
| `production@veritek.example` | Production (Unit 1) | Their factory's order lines — quantities and dates, no prices |
| `quality@veritek.example` | Quality / QC | Passes lines from QC to ready |
| `dispatch@veritek.example` | Dispatch | Ready lines, dispatch planning and posting, deliveries |
| `accounts@veritek.example` | Accounts | Invoices, receipts, TDS, advances, holds |
| `service@veritek.example` | Service | Complaints, site visits, feedback |

Demo QR objects with a password use `veritek2026`.

## Project layout

```
client/            React 19 + Vite app (pages/, components/, lib/)
server/            Express 5 API
  migrations/      Database schema (001_initial.sql), applied automatically
  routes/          HTTP endpoints, each guarded by a permission
  services/        Business rules (quotes, orders, finance, complaints, objects …)
  access.js        Record scope and value redaction for every response
shared/            Constants, permissions, dates and rules used by both server and client
scripts/           dev runner, demo snapshot, backup / restore test
tests/             Acceptance journey, customer-to-dispatch flow, Objects & QR suite, endpoint sweep, clean installation
docs/              Delivery pack (setup, configuration, permissions, imports, backup, guides)
api/index.js       Serverless entry (Vercel) — demo use; data resets on cold start
```

## Delivery pack

Everything a new owner needs is in [`docs/`](docs/README.md): setup and environment, configuration
list, permission matrix, import templates, backup and restore procedure, test evidence, known
limitations, hosting and ownership, the administrator guide and the coordinator quick guide.
