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
| **Overview & work queue** | Exceptions first: overdue follow-ups, late or stale order lines, customers not informed, approvals waiting |
| **Follow-ups** | One task list for every person; outcomes recorded in a few taps, the next action scheduled in the same step |
| **Sales dashboard** | Enquiries, weighted pipeline, quotations, orders, receivables, target vs achievement, salespeople |
| **Past customers** | Dormant buyers to reconnect with, with reasons and outcomes kept |
| **Enquiries & pipeline** | Capture in under a minute (customer, product, source, owner, next action); kanban by stage with a 30/60/90-day forecast |
| **Quotations** | Builder priced from the product master (standard / dealer / distributor list), configurator options, discounts, GST, freight; approval routing; immutable revisions with comparison; issue evidence; customer link to accept or ask for changes; idempotent conversion to an order |
| **Customers & contacts** | Unified profile (history, enquiries, quotations, orders, payments, complaints, equipment); duplicate checks and merge; regions, tags, interests, credit hold |
| **Campaigns** | Exhibitions and events with their enquiry funnel, follow-up by salesperson, cost and return per currency |
| **Active orders** | Line-level quantities, original / forecast / agreed dates kept separately, delay reasons, customer communication, cancellations, amendments, payment holds |
| **Production board** | Every active line by phase with blocker, forecast and freshness; QC passes recorded by Quality |
| **Dispatches** | Planned and actual shipments, transport details, delivery and proof of delivery, customer notification, reversals |
| **Payments** | Invoice register, receipts with TDS and deductions, credit notes, advances, ageing, promises, holds |
| **Complaints & service** | Severity, warranty, site visits, root cause vs reported symptom, resolution, feedback rating, quality insights |
| **Products & prices** | Price list with minimum price and cost, GST, warranty, lead time, configurator options, datasheets |
| **Objects & QR** | Permanent QR codes for machines, panels and documents; public scan pages; labels |
| **Reports** | 24 defined reports with stated definitions, denominators and drill-down to the records; CSV export |
| **Team & approvals** | Approval queue, monthly targets, performance shown with workload |
| **Settings** | People and access, approval policy, quotation defaults, reminders, regions, factories, assignment rules, dropdowns, imports, backups, audit log |

## Quick start

Requires **Node.js 22.13+** (the database is the built-in `node:sqlite` — nothing to compile).

```bash
npm install
npm run dev          # API on :4000 and the web app on :5173 → open http://localhost:5173
```

On first start the server creates `data/veritek.sqlite` and fills it with dated demo data (customers,
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
| `npm run seed` | Drops and rebuilds the demo database |
| `npm test` | Seeds a throwaway database and runs the acceptance journey (82 checks) and the Objects & QR suite |
| `npm run snapshot` | Rebuilds `seed/veritek-seed.sqlite` + `seed/files`, the demo data shipped with a serverless deployment |
| `npm run backup` | Backs up the database and all documents with a checksummed manifest |
| `npm run restore-test` | Restores the latest backup in isolation and reconciles records, files and quantities |

For a real installation start with an empty database: `CRM_NO_DEMO=1 CRM_ADMIN_EMAIL=… npm start` —
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
tests/             End-to-end acceptance journey and Objects & QR suite
docs/              Delivery pack (setup, configuration, permissions, imports, backup, guides)
api/index.js       Serverless entry (Vercel) — demo use; data resets on cold start
```

## Delivery pack

Everything a new owner needs is in [`docs/`](docs/README.md): setup and environment, configuration
list, permission matrix, import templates, backup and restore procedure, test evidence, known
limitations, hosting and ownership, the administrator guide and the coordinator quick guide.
