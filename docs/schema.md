# Schema & migrations

The schema is plain SQL in `server/migrations/001_initial.sql` (63 tables), applied automatically when the
server starts. Later changes are added as new numbered files in the same folder; never edit an applied one.

Conventions used throughout:

- **Money** is stored as integer minor units (paise / cents) with its currency (`…_minor` + `currency`) and is
  never added across currencies. A missing price is `NULL` (unknown), not zero.
- **Instants** (when something happened or was entered) are UTC ISO timestamps; **business dates** (due,
  committed, dispatched, invoice dates) are calendar dates in the Asia/Kolkata business calendar.
- **Optimistic concurrency**: editable rows carry `version`; a stale save is refused rather than overwriting.
- **History is never erased**: corrections are reversal events (`reversed_at`, reason); `history_events` and
  `audit_events` record who did what, when, and from where.
- **Codes** (`ENQ-…`, `Q-…`, `SO-…`, `DSP-…`) come from `counters` and are never reused.

## Tables by area

| Area | Tables |
|---|---|
| Configuration | `settings`, `counters`, `dropdown_options`, `regions`, `factories`, `tags`, `assignment_rules` |
| People & access | `users`, `sessions`, `sales_targets`, `pins` |
| Products | `product_categories`, `products`, `product_options`, `product_documents` |
| Customers | `customers`, `customer_aliases`, `duplicate_dismissals`, `customer_interests`, `taggings`, `contacts` |
| Marketing | `campaigns` (exhibitions and events), `exhibition_visits` (customers met, linked to the enquiry raised) |
| Enquiries | `enquiries`, `enquiry_lines`, `reactivation_cases` |
| Quotations | `quotations`, `quote_revisions` (line snapshot as JSON, totals, approval fields, issue evidence), `approvals` |
| Orders | `orders`, `order_lines` (original / forecast / agreed dates, phase, status, quantities), `line_issues`, `order_updates`, `commitment_changes`, `communication_confirmations`, `cancellations` |
| Dispatch | `dispatches` (planned / posted / reversed / cancelled, transport, delivery), `dispatch_lines` |
| Work | `tasks`, `task_changes`, `activities`, `alerts`, `notifications`, `scheduler_runs`, `summaries` |
| Finance | `invoices`, `receipts` (receipt / credit / advance, TDS, deductions), `payment_holds` |
| Service | `complaints` |
| Documents | `attachments` (content-checked, checksummed, stored by key), `attachment_links` |
| Objects & QR | `object_categories`, `objects`, `object_files`, `object_codes`, `scan_events` |
| Records & operations | `history_events`, `audit_events`, `idempotency_keys`, `error_log`, `import_uploads`, `import_batches`, `import_rows`, `backups` |

Derived values (remaining quantity, line state, freshness, outstanding balance, ageing bucket) are computed
from these events when read, so reports and screens always agree.

## Read by another system: `users` (phone, role, active)

The website's WhatsApp product finder works out who is an administrator from the CRM's own table. It runs
`select phone from crm.users where active = 1 and role in ('super_admin', 'management') and phone is not null`
every 5 minutes. Its database user may read only these three columns, granted by the website's
`admin-portal/schema/finder.sql`, which is run as `postgres`. Treat them as an interface:

- Keep `phone` (text), `role` and `active` as they are, including the role values `super_admin` and
  `management` and the meaning of `active` (1 = active, 0 = deactivated). Moving the number to another column
  needs a matching change in the website.
- Change `users` only with plain `ALTER TABLE`. Never drop and recreate it, and never add a `REVOKE` or a
  default-privilege change that removes other roles' access to it.
- Dropping the table loses the website's grant, and so do `npm run seed -- --reset --yes` and a restore into a
  fresh schema. Afterwards, run `finder.sql` again.
