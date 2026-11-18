# Administrator guide

For the super administrator and management. Everything here is in the web app; nothing needs a developer.

## Your own account

- **Password & sign-in security** (click your name, top right): change your password and switch on an
  authenticator-app code (MFA). Administrators should always use MFA.
- People set up by an administrator must choose their own password at first sign-in.

## People & access — Settings → People & access

- **Add person**: name, role, department, designation, email (needed to sign in), phone, *Escalates to*.
  - **Regional sales manager**: choose their *sales region* — they see and approve that region's customers.
  - **Production / Quality**: choose their *factory* — they see confirmed orders for that factory.
  - **Production / Service**: tick *May see commercial values* only if they need prices.
  - **Named owner (no sign-in)**: department people who own actions but do not log in; the coordinator records
    their updates.
  - **Super admin / Management**: their phone is their WhatsApp number with country code (e.g. +91 98200 11111);
    from it they get product files (datasheets, manuals, diagrams) on +91 97694 90155.
- **Reset password**: edit the person and enter a new first password (they must change it at sign-in).
- **Deactivate** when someone leaves: their open customers, enquiries, tasks, orders and complaints must be
  reassigned first; sign-in stops at once; their name stays on every past record.
- The **permission matrix** on the same page shows what each role can do (also in [permissions.md](permissions.md)).

## Company & commercial — Settings → Company & commercial

- **Company profile**: name, GSTIN, address, phone, email, website (printed on quotations and customer pages),
  reporting currency and the month the financial year starts.
- **Quotation approvals**: discount above which the regional manager approves (default 10%), above which the
  sales head approves (18%), minimum margin (22%), who approves prices below the minimum selling price
  (management), the large-quotation value that alerts management, and whether approval is required before
  a quotation can be issued.
- **Quotation defaults**: validity days, payment terms, delivery and warranty text, GST on freight.
- **Sales reminders**: quotation follow-up and expiry warning days, sample feedback, payment reminders,
  repeat-order prompts, management summaries.
- **QR codes & scan pages**: the public address printed into QR codes (set this to the final domain
  *before* printing labels), brand colour, archived-object message, label contents.

## Regions, factories & rules — Settings → Regions, factories & rules

- **Sales regions** with the states they cover: a customer's state places it in a region automatically.
- **Factories**: assign each order to a factory on the order page (*Edit order details*).
- **Enquiry assignment rules**: who owns a new enquiry when the customer has no owner, by region, product
  family and market. Lower priority numbers are checked first. Switch automatic assignment on or off under
  Calendar & rules → Access policy.
- **Customer tags**: colours and names; tags can also be typed on a customer.

## Products & prices — Products & prices

- **Categories** (button on the page): the product families used in filters, assignment rules and reports.
- **New product / Edit product**: code, name, model, category, unit, standard / dealer / distributor price,
  minimum selling price and cost (never shown to customers), GST, HSN, warranty, lead time, stock, technical
  specification. Every price change is recorded in the product's History tab.
- **Configurator**: option groups (e.g. *Communication*, *Supply*) with price, cost and lead-time changes.
  Options already quoted are deactivated instead of deleted.
- **Documents**: upload datasheets and manuals, or link to the website.
- **Deactivate** a model that is no longer sold — it stays on past documents.

## Dropdowns, calendar and rules

- **Settings → Dropdowns**: rename labels, add values, require a note, deactivate values no longer used.
  Used values are never deleted, so history keeps its meaning.
- **Settings → Calendar & rules**: working days, hours and holidays (used for due dates and freshness, never
  for commitment dates); thresholds such as when an order update becomes stale or a customer becomes a
  past customer; access policy; reminder evaluator and backup schedule.

## Approvals and targets — Team & approvals

- **Approvals**: quotations waiting for a decision, with the reasons (discount, margin, minimum price,
  non-catalogue items). Approve with a comment or reject with a reason; the owner is notified.
- **Targets**: monthly targets per salesperson in the reporting currency; achievement is confirmed orders
  by month of confirmation.
- **Performance**: outcomes shown together with workload — never activity counts alone.

## Data, backups and audit — Settings

- **Imports**: see [imports.md](imports.md). Preview first; roll back a wrong batch from the history.
- **System & backups**: *Back up now*, *Restore test*, backup history, *Download full export* (all data as CSV
  plus documents), recent errors (application, reminder and backup failures).
- **Audit log**: who changed what, when and from where — including settings, prices, access and deletions.

## Weekly checklist

1. Settings → System & backups: last backup *ok*, no recurring errors; run a restore test monthly.
2. Team & approvals: nothing waiting more than a day.
3. Overview: stale order lines, customers not informed of date changes, overdue follow-ups.
4. People & access: remove leavers, check new joiners' roles and regions.
