# Veritek CRM — manufacturing sales & order management

A CRM built around how a manufacturing company actually sells: every enquiry is tracked from the
first call through quotation, negotiation, purchase order, production, quality check, dispatch,
payment, after-sales service and the repeat order that follows.

It is not a customer database with a sales tab bolted on. The quotation module prices from an
approved price master and enforces discount/margin approvals; orders carry the shop floor, dispatch
and receivables with them; and background automation chases the things people forget.

```
Lead → Requirement → Quotation → Negotiation → Purchase order → Production
     → Quality check → Dispatch → Payment → Service → Repeat order
```

---

## Quick start

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there is nothing to compile).

```bash
npm install
npm run dev          # API on :4000, web on :5173 — open http://localhost:5173
```

The first start creates `data/crm.sqlite` and loads ~18 months of demo data. To rebuild that data
from scratch at any time:

```bash
npm run seed         # drops and re-creates the demo database
```

For a production-style run (single process serving the built frontend):

```bash
npm run build && npm start   # http://localhost:4000
```

| Command | What it does |
|---|---|
| `npm run dev` | API with `--watch` plus the Vite dev server |
| `npm run build` | Builds the React app into `client/dist` |
| `npm start` | Serves the API and the built app on one port |
| `npm run seed` | Rebuilds the demo database |
| `npm test` | Seeds a throwaway database and runs the end-to-end journey test |

Environment variables: `PORT` (default 4000), `CRM_DB`, `CRM_DATA_DIR`.

### Demo accounts

Password for every account: `Veritek@123`. Each role lands in a different workspace, so sign in as a
few to see the access model at work.

| Email | Role | What they see |
|---|---|---|
| `admin@veritek.example` | Super Admin | Everything, plus settings and the audit log |
| `md@veritek.example` | Management | Company-wide dashboard, reports, approvals |
| `saleshead@veritek.example` | Sales Head | All regions, approvals above the manager threshold, targets |
| `rsm.west@veritek.example` | Regional Sales Manager | West India only — leads, quotes, approvals for that region |
| `rohan@veritek.example` | Sales Executive | Only their own customers and leads |
| `commercial@veritek.example` | Quotation / Commercial | Quotations, PO verification, order creation |
| `production@veritek.example` | Production (Unit 1) | Orders at their unit — quantities, dates, material; no prices |
| `quality@veritek.example` | Quality | Quality checks; only this role can pass QC |
| `dispatch@veritek.example` | Dispatch | Ready-to-ship orders, shipments, e-way bills, POD |
| `accounts@veritek.example` | Accounts | Invoices, receipts, TDS, credit notes, ageing |
| `service@veritek.example` | Service | Complaints, site visits, root cause, feedback |

---

## The modules

Navigation follows the order of the sales journey.

1. **Dashboard** — leads, follow-ups due, quotation funnel, order value, production, dispatch,
   receivables, salesperson performance, region/source split, monthly target vs achievement, and an
   **Action required** panel (overdue follow-ups, expiring quotations, delayed production, pending
   approvals, unpaid invoices).
2. **Leads** — the 11-stage enquiry pipeline. An open lead cannot exist without a next action and a
   follow-up date; the API rejects it, so nothing goes quiet by accident.
3. **Opportunities** — the qualified pipeline as a drag-and-drop board with a weighted 30/60/90-day
   forecast. Dropping a card asks for the next action before it moves.
4. **Customers** — company master with contacts, credit terms, tags and a segment panel that filters
   by status, type, value band, region, state, industry, product interest, source, campaign and tag.
   The **Timeline** tab merges calls, WhatsApp, email, requirements, samples, quotations, orders,
   production updates, dispatches, payments and complaints into one chronological view.
5. **Contacts** — every person across all customers, by role, with call/WhatsApp/email shortcuts.
6. **Follow-Ups** — what is due now, with the context to act, plus **smart reminders**: leads without
   a next action, quotations expiring, no response for 7+ days, samples awaiting feedback, POs
   promised but not received, repeat-order opportunities and customers gone quiet.
7. **Quotations** — build from the price master with a product configurator, live tax/margin
   calculation and an approval preview. Every revision is kept as a version; versions can be compared
   line by line, showing who changed the price or discount. A shareable customer link marks the quote
   **viewed** and lets the customer accept or request a revision.
8. **Sales Orders** — created from an accepted quotation without re-entering anything, then moved
   through 14 stages with the business rules enforced (no confirmation before the advance, no packing
   before QC passes, no "dispatched" until everything has shipped).
9. **Production Tracking** — planned vs actual dates, quantity produced, material constraints, QC
   status, delay reasons and revised dates. Sales can answer "where is my order?" without calling the
   factory.
10. **Dispatches** — one order can ship in several parts: invoice, e-way bill, transporter, vehicle,
    LR/AWB, boxes, tracking link, proof of delivery and receipt confirmation.
11. **Payments** — order value, advance, invoices, receipts with TDS and deductions, credit notes,
    ageing (0–30/31–60/61–90/90+) and collection follow-ups. Sales sees status; only accounts and
    management see deductions, references and credit limits.
12. **Products** — categories, SKUs, specifications, standard/dealer/distributor prices, minimum
    selling price, cost, GST, warranty, lead time, stock type, datasheets and configurator options.
13. **Exhibitions & Campaigns** — a page per event: leads collected, assigned, meetings, quotations,
    orders, revenue, conversion rate and cost versus revenue.
14. **Complaints & Service** — registration with serial number, invoice and warranty status, site
    visit, root cause, resolution and customer feedback, plus a quality view of repeated product
    failures.
15. **Reports** — 17 reports (lead source conversion, exhibition ROI, salesperson conversion,
    quotation-to-order, sales cycle, lost reasons, discount & margin, forecast, region revenue,
    product demand, top customers, repeat-order rate, dormant customers, payment ageing, order delays,
    complaint trends, daily/weekly summaries), each with a chart, a table and CSV export.
16. **Team & Approvals** — approval queue, users and their access scope, monthly targets, performance.
17. **Settings** — company profile, approval thresholds, follow-up and dormancy rules, automation
    switches, lead-assignment rules, masters, the role/permission matrix and the audit log.

### Customer-facing links (no login)

- `/portal/quote/:token` — the quotation as the customer sees it. Opening it marks the quote viewed;
  they can accept or request a revision, which lands back in the CRM.
- `/portal/order/:token` — order tracking: milestones, production progress, shipments and updates.

---

## Access control

Three layers, all enforced on the server:

- **Module permissions** — a role/permission map in `shared/constants.js` (`leads.edit`,
  `production.edit`, `payments.edit`, `approvals.decide`, …).
- **Row scope** — Sales Executives see their own customers and leads; Regional Managers see their
  region; Production sees its own unit; everyone else sees the company (`server/access.js`).
- **Field redaction** — commercial values, cost/margin and finance detail (TDS, deductions, bank
  references, credit limits) are stripped from API responses for roles that should not see them, so
  the shop floor gets quantities and dates without prices.

## Automation

Runs every 15 minutes (configurable in Settings → Automation, where each rule can be switched off and
run on demand):

assign leads by region/product rules · create and update follow-up reminders · escalate overdue
follow-ups to managers · expire quotations past validity · warn about expiring quotations, silence
after 7 days, samples awaiting feedback and promised POs · notify managers of large quotations ·
request approval for excessive discounts · alert production when an order is confirmed · warn about
delayed or at-risk deliveries · notify sales when an order is dispatched · remind accounts about
overdue payments and raise collection tasks · flag dormant customers and repeat-order opportunities ·
generate daily and weekly management summaries.

To keep the noise reasonable, automatically created re-engagement and repeat-order tasks are capped
per salesperson per day.

---

## Architecture

```
shared/constants.js     stages, statuses, roles and permissions — imported by API and UI alike
server/
  index.js              Express app, static hosting, error handling, scheduler
  schema.sql  db.js     SQLite schema and a small query helper (node:sqlite, WAL, transactions)
  access.js  auth.js    scoping, redaction, sessions, permission guards
  services/             business rules: leads, quotes, orders, timeline, automation
  routes/               one router per module + the public customer portal
  seed.js               demo data: replays ~18 months through the real services
client/src/
  components/           UI kit, charts, domain components (activity log, timeline, pickers)
  pages/                one file per screen
tests/                  end-to-end journey test (npm test)
```

**Why the seed replays history rather than inserting rows:** it drives the real services with a
pinned clock, so every lead history, quotation version, approval, stage change, invoice and payment
in the demo database is internally consistent — the same code path a user would take.

**Charts** are hand-built SVG components following one visual system: thin rounded bars from a single
baseline, 2px lines, a hairline grid, a fixed colour-blind-safe categorical order, a legend whenever
there are two or more series, and hover tooltips.

## Deployment

**Demo on Vercel** — live at **https://veritekcrm.vercel.app** (`vercel deploy --prod`).

Vercel runs the API as a serverless function with a read-only bundle and an ephemeral `/tmp`, so:

- `npm run snapshot` builds `seed/crm-seed.sqlite`, which ships with the function and is copied into
  `/tmp` on cold start. Every screen is fully populated the moment the app loads.
- Anything a visitor changes lives only in that instance's copy, and uploads are not kept. The app
  detects this (`VERCEL` / `CRM_EPHEMERAL`) and shows a banner saying so.
- Sessions are signed tokens in this mode instead of database rows, because a session written by one
  instance would be invisible to the next. Signing uses `CRM_TOKEN_SECRET` (set as a Vercel
  environment variable), falling back to a digest of the bundled snapshot.
- The automation scheduler does not run on serverless; use Settings → Automation → **Run now**.
- Re-run `npm run snapshot` and redeploy whenever the demo data should be re-dated to today.

**For real use, give the app a disk** (Render, Railway, Fly.io, a VM or a container): it runs as a
single process — `npm run build && npm start` — with `data/` holding the SQLite file and uploads.
Nothing else changes: database sessions, the scheduler and file uploads all work as designed.
Point `CRM_DATA_DIR` at the mounted volume.

## Testing

```bash
npm test
```

Seeds an isolated database and walks the whole journey over HTTP as nine different roles: lead →
activity → stage move → quotation needing approval → manager approval → send → customer portal accept
→ revision creating version 2 → PO conversion → advance payment → production → quality check →
partial dispatch with invoice → delivery → payment with TDS → complaint → resolution → customer
tracking page → timeline, including the negative cases (an executive cannot approve their own
quotation, production cannot pass its own QC, packing is blocked before QC, a region's leads are
invisible to another region, dispatch quantities cannot exceed what is pending).

## Notes and limits

- Email and WhatsApp are **not** sent by the system: "Send" records the event, schedules the
  follow-up and gives you a link plus pre-filled mail/WhatsApp actions to deliver it yourself.
- Attachments (including browser-recorded voice notes) are stored under `data/uploads`.
- The database is a single SQLite file in `data/` — copy it to back up, delete it to start over.
- Money is stored in rupees as numbers and rendered in the Indian system (lakh/crore); GST is applied
  per line from the product master.
