# Administrator guide

For the super administrator and management. Everything here is in the web app; nothing needs a developer.

## Your own account

- **Password & sign-in security** (click your name, top right): change your password and switch on an
  authenticator-app code (MFA). Administrators should always use MFA.
- People you add choose their own password when they first sign in.

## People — Settings → People

- **Add person**: name, role, email (needed to sign in), phone and a first password.
  - Roles: Super admin, Management, Coordinator, Sales, Production, Quality / QC, Dispatch, Accounts. The hint
    under the role says what it can do; [permissions.md](permissions.md) has the full list.
  - **Super admin / Management**: their phone is their WhatsApp number with country code (e.g. +91 98200 11111);
    from it they get product files (datasheets, manuals, diagrams) on +91 97694 90155.
- **Reset a password**: edit the person and enter a new password; they change it at their next sign-in.
- **Deactivate** when someone leaves: their open customers, enquiries, follow-ups and orders are handed to
  someone else first; sign-in stops at once; their name stays on every past record.

## Company — Settings → Company

- **Company**: name, GSTIN, address, phone, email and website, printed on quotations.
- **Quotation defaults**: how long a quotation is valid, and the payment, delivery and warranty text filled in
  on every new quotation. A payment term like "30% advance" sets the advance on the order.

## Dropdowns — Settings → Dropdowns

The lists behind the forms: enquiry source / how they found us, lost reasons, delay reasons, contact outcomes,
order cancellation reasons, contact channels and units. Rename a value by typing over it (it saves when you
leave the box or press Enter), add new ones, and untick *Active* to stop offering one. A value already used is
never deleted, so old records keep their meaning.

## Products — Products

- **New product / Edit**: code, name, category, price before GST, GST, HSN, unit, lead time, warranty and a
  description. The price fills in quotations.
- **Documents**: upload datasheets and manuals, or link to them on the website.
- **Categories** (button on the page) group the products.
- **Deactivate** a model that is no longer sold; it stays on past quotations and orders.

## Imports — Settings → Imports

See [imports.md](imports.md). Preview first; nothing is saved until you commit, and a wrong batch can be rolled
back from the history.

## Switched off for now

Regions, factories and assignment rules, the working calendar and reminder rules, backups and the full export,
the audit log, internal quotation approvals, payments register, complaints, reports, targets and the work queue
are kept for later versions. Everything is still recorded (the audit log, for example, keeps every change) and
each can be switched back on; see [configuration.md](configuration.md#modules). Backups still run every day:
Google Cloud SQL backs up the whole database, and the CRM's own daily backup carries on; only its settings page
is switched off ([backup-restore.md](backup-restore.md)).

## Weekly checklist

1. Dashboard: enquiries not replied, delayed orders, follow-ups overdue.
2. Sales pipeline: deals marked *Stuck* and the reason given.
3. Settings → People: remove leavers, check new joiners' roles.
