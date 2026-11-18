# Import templates

Settings → Imports takes CSV or Excel files for **customers & contacts**, **enquiries** and **open order
lines**. Each template downloads from that page as the column headings only (no example row, so nothing
made-up can be imported by mistake), with a guide sheet explaining every column with an example. Import in
that order — enquiries and orders find their customer by the *Source ID* given in the customer import.

How an import runs:

1. **Upload** the file and **map** its columns to the fields below (headers are matched automatically where possible).
2. **Preview**: every row is validated; errors and possible duplicates are listed per row before anything is written.
3. **Commit**: valid rows are created; each record remembers its import batch and source ID.
4. **Re-import** of the same source IDs updates instead of duplicating.
5. **Roll back** a batch from the import history if it was wrong (super administrator) — records it created are
   removed, everything else is untouched. Rows that failed can be corrected and retried from the batch page.

Blank means **unknown**, never zero or today: an unknown received date stays unknown, an unknown quantity is
not set to 1, an unknown price is not zero, an unknown commitment date is excluded from timeliness
measures. Dates may be `DD/MM/YYYY` or `YYYY-MM-DD`.

## Customers & contacts

| Column | Required | Notes | Example |
|---|:-:|---|---|
| Source ID | | Customer ID in the old system — recognises the same customer on re-import | `TALLY-1023` |
| Company name | ✓ | Registered or trading name (2–200 characters) | `Gulf Panel Co.` |
| Other names | | Other names to search by, separated by `;` | `Gulf Panels LLC` |
| Country | | ISO code (IN, AE…) or country name; blank = unknown | `AE` |
| City | | | `Sharjah` |
| Domestic / export | | `domestic` or `export`; blank = not classified (never guessed from the phone) | `export` |
| Customer types | | `manufacturer; oem; dealer; distributor; end_user; other` | `oem` |
| Owner email | | Accountable owner in this system; blank = the importer | `name@veritekindia.com` |
| Contact name | | Main contact person | `Rashid Ali` |
| Contact role | | Designation | `Purchase Manager` |
| Phone | | With country code if possible | `+971 50 123 4567` |
| Email | | | `rashid@gulfpanel.example` |
| Accounting ID | | Customer reference in the accounting system | `GPC001` |
| First order date | | Historical first order; blank = unknown | `12/02/2024` |
| Last order date | | Historical last order; blank = unknown | `05/03/2026` |
| Historical order count | | Orders before this system | `12` |
| Do not contact | | `yes` / `no` | `no` |
| Notes | | Short note | |

Possible duplicates (similar name, same phone or email) are shown in the preview and are never merged
automatically.

## Enquiries

| Column | Required | Notes | Example |
|---|:-:|---|---|
| Source ID | | Enquiry ID in the old sheet | `ENQ-OLD-77` |
| Customer source ID | | Source ID from the customer import (preferred) | `TALLY-1023` |
| Customer name | ✓ | Used when there is no customer source ID | `Gulf Panel Co.` |
| Contact name / Phone / Email | | | |
| Received date | | Blank = unknown (not set to the import date) | `02/11/2026` |
| Source | | `existing_customer, whatsapp, email, exhibition, field_visit, dealer_referral, outbound, online_portal, tender, campaign, other, unknown` | `exhibition` |
| Event name | | Exhibition or campaign name | `Middle East Energy` |
| Owner email | | Accountable owner | `name@veritekindia.com` |
| Product code | | Product master code; unknown codes are kept as requirement text | `VIPS 70L` |
| Requirement | | Short description when the product is not known | |
| Quantity | | Blank = unknown | `100` |
| Unit | | `pcs, set, m, kg, lot` | `pcs` |
| Stage | | `new, clarification, quote_to_prepare, quote_sent, awaiting_decision, on_hold, won, lost, cancelled` | `quote_sent` |
| Lost reason | | For lost enquiries | |
| Next action / Next action due | | For open enquiries | `Follow up quotation`, `20/11/2026` |
| Notes | | | |

## Open order lines

| Column | Required | Notes | Example |
|---|:-:|---|---|
| Order number (source) | ✓ | Rows with the same order number become one order | `SO-0988` |
| Line ID (source) | | Identifies the line on re-import | `1` |
| Customer source ID | | From the customer import (preferred) | `TALLY-1023` |
| Customer name | ✓ | Used when there is no customer source ID | `Gulf Panel Co.` |
| Customer PO | | | `GP/PO/2026/114` |
| Order received date | | Blank = unknown | `01/11/2026` |
| Sales owner email | | | `name@veritekindia.com` |
| Product code | | | `VIPS 70L` |
| Description / specification | | Used when the product code is unknown | |
| Confirmed quantity | ✓ | Positive number | `100` |
| Unit | | `pcs, set, m, kg, lot` | `pcs` |
| Unit price | | Blank = price unknown (not zero) | `1250.00` |
| Currency | | `INR, USD, EUR, AED…` | `AED` |
| Original committed dispatch date | | Blank = commitment unknown (excluded from timeliness) | `19/11/2026` |
| Current dispatch forecast | | | `21/11/2026` |
| Phase | | `received, production, qc, ready` | `production` |
| Already dispatched | | Historical dispatched quantity | `0` |
| Dispatch date | | Actual date of that dispatch; blank = unknown (not the invoice date) | |
| Cancelled quantity | | | `0` |
| Cancellation reason | | `customer_cancelled, project_cancelled, delivery_delay, spec_change, payment_issue, duplicate_entry, other` | |
| Notes | | | |

## Other data

- **Products & prices**: entered on the Products page (a few dozen models); categories first.
- **Objects & QR**: Objects & QR → Import takes any spreadsheet — map the name column and optionally
  location, serial number, owner and description; every other column becomes a custom field, and a QR
  code can be generated for each row.
- **Invoices and receipts**: entered in Payments, or kept in the accounting system with the data-as-of
  date recorded (Payments → *Data as of*).
