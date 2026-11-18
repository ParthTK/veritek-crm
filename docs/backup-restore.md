# Backup & restore

There are two independent layers of backup in production:

1. **Google Cloud SQL automatic backups** of the whole database (daily, kept by Google; restored from the
   Google Cloud console — Cloud SQL → `veritek-db` → Backups). This is the first thing to use after a mistake
   or failure, but it restores the *whole* database, website and portal schemas included.
2. **The CRM's own backups**, described below: the CRM's data only, together with its documents, so a
   restore never has links to missing files.

## The CRM's automatic daily backup

Settings → Calendar & rules → *Scheduler & backups*: daily backup after the chosen local hour (default
02:00), keeping the last 14. (On Cloud Run, Cloud Scheduler triggers it; see
[deploy-google-cloud.md](deploy-google-cloud.md).) Each backup is a folder `backups/backup-<time>/` in the
document store — the private bucket in production, `data/files` locally — holding:

- `database.json.gz` — every table, exported in one consistent read
- `manifest.json` — record counts, quantity totals and every document's checksum
- `files/` — copies of the documents (local installations only; in the bucket every document is stored
  once and never overwritten, and deleted objects stay recoverable for the bucket's soft-delete period)

A failed backup notifies the administrators and shows on Settings → System & backups.

## Manual backup

From Settings → System & backups (**Back up now**), or on a machine with access to the database:

```bash
npm run backup
```

## Restore test (prove a backup works)

Run regularly, and before any upgrade — from Settings → System & backups, or:

```bash
npm run restore-test                                   # latest backup
npm run restore-test -- backups/backup-<time>/         # a specific backup
```

It reads the backup back and checks that the export is complete, record counts match the manifest, every
document is present with a matching checksum, order quantities reconcile with dispatch and cancellation
events, and every document link resolves. Example output:

```
ok   Backup readable and complete — 63 tables
ok   Record counts match the manifest — 8331 records across 20 tables
ok   Every attachment restored with a matching checksum — 157 file(s) verified
ok   Order quantities reconcile with dispatch and cancellation events — confirmed 20662, dispatched 15969, cancelled 201
ok   Document links point to restored files — All links resolve
```

## Restoring for real

Restore into an **empty** database — never on top of live data (the command refuses a database that has
accounts):

1. Stop new work (tell users; on Cloud Run you can set the service's maximum instances to 0).
2. Point the CRM at an empty database. On Cloud SQL: create a fresh schema (for example `crm_restore`) owned
   by the CRM's database user and set `CRM_PG_SCHEMA` to it; locally: an empty `CRM_DATA_DIR`.
3. Run `npm run restore -- backups/backup-<time>/` with the same environment variables as the service.
4. Start the CRM against the restored schema, sign in as an administrator and check Settings → System &
   backups and a few recent records. Keep the old schema until you are satisfied, then remove it.
5. The website reads `crm.users` by that name (administrators' WhatsApp numbers; see [schema.md](schema.md)),
   and a new schema does not have its grant. Once the restored data is in the schema named `crm`, run the
   website's `admin-portal/schema/finder.sql` again as `postgres`.

Recovery targets proposed by the specification: at most 24 hours of data loss and restoration within one
working day — met by the daily backups plus this procedure.

## Full export

Settings → System & backups → **Download full export** gives a ZIP of every table as CSV plus the stored documents —
Veritek's own copy of its data, independent of this software.
