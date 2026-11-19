# Veritek CRM — customers, enquiries, quotations and orders

The CRM for Veritek's panel-meter business. Version 1 keeps to the daily work, from the first enquiry to the
goods leaving the factory:

```
Customer → Enquiry → Quotation → Order → Payment → Production → Dispatch
```

## Version 1

| Page | What it does |
|---|---|
| **Dashboard** | Enquiries today, not replied, pending quotations, active orders, production and delays; daily enquiries; follow-ups due and delayed orders |
| **Follow-ups** | Everyone's next actions: overdue, today, upcoming. Record what happened and set the next one in the same step |
| **Customers** | A short new-customer form; one page per customer with its enquiries, quotations, orders, exhibitions visited, history, contacts and details |
| **Enquiries** | Added against a customer: products, source, notes, reply status, follow-ups and who it is assigned to. A list, and a drag-and-drop board |
| **Quotations** | Written from the product prices; pending, sent, approved or rejected; new versions; print / PDF. An approved quotation becomes an order |
| **Sales pipeline** | Every live deal across enquiry → quotation → confirmation → payment → production → dispatch: where it is, and why it is stuck. Drag a card on to the next column to take that step |
| **Exhibitions** | Exhibitions attended, customers visited and the enquiries they brought. Exhibition as a source names the exhibition |
| **Orders** | Each item's progress, dispatch date and delay; payments received against the order total; dispatches and delivery |
| **Production** | Every active item by stage; one short form moves it along or records a delay |
| **Dispatch** | What has left, the transporter and LR number, in transit or delivered |
| **Products** | Codes, prices, GST, lead time and datasheets |
| **Settings** | People and roles, company and quotation defaults, dropdown lists, imports |
| **QR codes** | A separate module: permanent QR codes for machines, panels and documents, scan pages and labels |

## Kept for later versions

These parts are built and tested but switched off, so Version 1 stays simple. Their code and data are kept, and
switching one on brings back its pages and reminders ([configuration.md](docs/configuration.md#modules)).

| Module (setting) | What it adds |
|---|---|
| Work queue (`workQueue`) | The coordinator's list of new inputs, orders needing updates and missing information |
| Sales dashboard (`salesDashboard`) | Pipeline value, conversion, and targets against achievement |
| Contacts (`contacts`) | One list of every contact across customers |
| Past customers (`pastCustomers`) | Buyers who have gone quiet, to reconnect with |
| Payments register (`payments`) | Invoices, receipts with TDS and deductions, credit notes, ageing and payment promises |
| Complaints (`complaints`) | Service complaints, site visits, root cause and feedback |
| Reports (`reports`) | 24 reports with definitions and CSV export |
| Team (`team`) | Quotation approvals, monthly targets and performance |
| Admin tools (`adminTools`) | Regions, factories and assignment rules; calendar and reminder rules; backups and full export; audit log; every dropdown list; more person details and roles |

Also off for now: checking discounts and margins before a quotation goes out (`approvals.enabled`), and naming
the person who reported an update entered on someone else's behalf (`access.coordinatorMode`). Version 1 also
has no buttons for price lists, product options and margin checks in the quotation builder, bulk order updates,
planned dispatches, or the customer's own links (accepting a quotation online, following an order); links already
sent keep working. Adding a person offers eight roles; anyone who already has another role keeps it.

## Quick start

Requires **Node.js 22.13+**. The database is PostgreSQL: Google Cloud SQL in production, and an embedded
PostgreSQL (PGlite) in `data/pgdata` locally — nothing else to install. Production runs on Google Cloud Run;
see [docs/deploy-google-cloud.md](docs/deploy-google-cloud.md).

```bash
npm install
npm run dev          # API on :4000 and the web app on :5173 → open http://localhost:5173
```

On first start the server creates the embedded database in `data/pgdata` as a clean installation: the product
models (prices blank), sales regions, settings and one administrator (`CRM_ADMIN_EMAIL` /
`CRM_ADMIN_PASSWORD`, or a temporary password printed in the log), and nothing else. There is no demo data;
see [docs/setup.md](docs/setup.md).

Production-style (one process serving the built app):

```bash
npm run build && npm start   # http://localhost:4000
```

| Command | What it does |
|---|---|
| `npm run dev` | API with `--watch` plus the Vite dev server |
| `npm run build` | Builds the React app into `client/dist` |
| `npm start` | Serves the API and the built app on one port |
| `npm test` | Builds a throwaway database with the tests' sample data and runs the acceptance journey (82 checks), the Objects & QR suite, the customer-to-dispatch flow (81 checks), the people checks and a sweep of every endpoint, then checks a clean installation; the throwaway database is deleted afterwards |
| `npm run backup` | Backs up every table and the documents with a checksummed manifest |
| `npm run restore-test` | Reads the latest backup back and reconciles records, files and quantities |
| `npm run restore -- <backup>` | Restores a backup into an empty database |

## Project layout

```
client/            React 19 + Vite app (pages/, components/, lib/)
server/            Express 5 API
  migrations/      Database schema (001_initial.sql), applied automatically
  routes/          HTTP endpoints, each guarded by a permission
  services/        Business rules (quotes, orders, finance, complaints, objects …)
  access.js        Record scope and value redaction for every response
  setup.js         The clean installation created on first start (regions, product models, first administrator)
shared/            Constants, permissions, dates and rules used by both server and client
scripts/           dev runner, backup / restore test, restore
tests/             Test suites and their sample data (sample-data.mjs) — never deployed or loaded by the app
docs/              Delivery pack (setup, configuration, permissions, imports, backup, guides)
```

## Delivery pack

Everything a new owner needs is in [`docs/`](docs/README.md): setup and environment, configuration
list, permission matrix, import templates, backup and restore procedure, test evidence, known
limitations, hosting and ownership, the administrator guide and the coordinator quick guide.
