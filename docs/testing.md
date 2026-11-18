# Test evidence

## Automated acceptance tests

```bash
npm test
```

builds a throwaway database in the system temp folder with the tests' own sample data
(`tests/sample-data.mjs`: fictional companies, people, enquiries and orders, used only here), starts the API on
a spare port and runs the suites below against it over HTTP, then deletes the folder. The real database is
never touched, and the app itself never loads sample data.

### Acceptance journey (`tests/journey.mjs`, 82 checks)

One customer's complete path, checking each rule from the specification as it goes:

| Stage | What is proven |
|---|---|
| Customer | Created with master fields; region inferred from the state; owner set; tags and interests saved; a duplicate company is flagged before creation |
| Enquiry & pipeline | Capture with product, source and next action; follow-up due today; opportunity value, probability, temperature and decision date; weighted pipeline value |
| Quotation | Configurator option priced from the product master; 12% discount routed to the regional manager; cost and margin hidden from the sales executive but visible to management; cannot issue before approval; the executive cannot approve; rejection needs a reason; issue moves the enquiry to *Quotation sent*; issued revisions are immutable |
| Customer link | Opens without sign-in; never shows cost, margin or minimum price; records the view; revision request; revision 2 within policy needs no approval; revision 1 superseded but kept; online acceptance; accepted ≠ won |
| Order | Conversion confirmed; a retried conversion returns the same order (idempotent); enquiry becomes Won; priority and advance carried over; factory and production owner assigned |
| Money in advance | Advance recorded; order leaves the pending-advance list |
| Production & QC | Production sees no prices; sales cannot post production updates; phase moves with forecasts; production cannot pass its own QC; Quality passes QC with a ready quantity and QC summary; board shows it ready |
| Dispatch | A plan changes no balance; posting does; over-dispatch rejected; a future date is refused as a dispatch; final shipment; fully dispatched; delivery with receiver; customer notification recorded |
| Invoice & receipt | Invoice adjusting the advance; the same advance cannot be adjusted twice; future-dated receipt refused; receipt + TDS settles the invoice; sales sees the invoice but not TDS; dispatch has no access to invoices |
| Service | Complaint registered; warranty inferred; cannot resolve without root cause and resolution; resolution and feedback rating |
| Customer views | Tracking link shows both shipments and no commercial values; timeline spans enquiries, quotations and orders; QR object, permanent code and public scan page |
| Access | Another executive cannot open the enquiry; the region's manager can; production has no enquiry access; read-only management cannot change anything; production sees products without prices; only the super administrator manages users |

### Objects & QR (`tests/objects.mjs`, about 50 checks)

Category templates, custom fields, documents (PDF and Excel) with public/internal visibility, permanent QR
and barcode (PNG/SVG, never regenerated), public scan page, case-insensitive ids, document replacement with
version history and restore, password protection, archive message, duplicate with a new identity, bulk
import from a spreadsheet, staff can read but only administrators delete, the admin API is closed to
anonymous callers, and a deleted object's id is never reused.

### Latest run

```
> veritek-crm@2.0.0 test
Seeding a test database in …\veritek-test-eeAayD …
ALL 82 CHECKS PASSED
ALL OBJECT CHECKS PASSED
```

### Customer-to-dispatch flow (`tests/flow.mjs`, 57 checks)

Customer first; exhibition, visitor and linked enquiry; replied / not replied; quotation pending, sent, approved
and rejected; confirmation, advance, production and dispatch, with the sales pipeline, dashboard, order list and
production board checked at each step; every stuck deal states a reason; scope and hidden values by role; QR
data kept out of customer and order records.

### People & access (`tests/people.mjs`)

An administrator's phone is the number the website's WhatsApp product finder recognises. The suite checks
that the phone rules match the website's (digits only; a leading 00 or a leading 0 dropped; ten digits are
Indian; 11–15 digits; several numbers separated by , ; / or "or"). Super admin and Management phones that are
not full numbers are refused on the phone field, the phone stays optional, other roles' phones are saved as
typed, and promoting someone checks the phone they already have. The clean-installation test
(`tests/baseline.mjs`) also checks that `users` keeps the phone, role and active columns the website reads, and
that the website's query against them runs.

### Endpoint sweep (`tests/sweep.mjs`)

Calls every read endpoint, report and export as several roles and fails on any server error.

## Interface checks

Every page was opened in headless Chrome at desktop (1440 px) and phone (390 px) widths, signed in as
the super administrator, with the browser console watched for errors: overview, sales dashboard, pipeline,
enquiries, quotations (register, detail, builder new and edit), products and product detail, campaigns and
campaign detail, contacts, customers and profile, orders and order detail, production board, dispatches,
payments (overview and invoices), complaints and insights, team (approvals and targets), objects and object
detail, reports, settings (people, commercial, masters), the customer quotation link, order tracking and the
QR scan page. Result: no runtime errors and no horizontal page overflow on any page.

Role checks over the API (every page's data calls, for all 13 sign-in roles): each call either succeeded or
was refused with 403/404 by design; no shop-floor response contained prices.

## Backup restore test

`npm run restore-test` on the tests' sample data restored 8,619 records across 20 tables and 153 documents with
matching checksums, with order quantities reconciling against dispatch and cancellation events. See
[backup-restore.md](backup-restore.md).
