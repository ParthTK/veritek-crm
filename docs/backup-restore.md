# Backup & restore

The database and the stored documents are backed up **together**, so a restore never has links to
missing files.

## Automatic daily backup

Settings → Calendar & rules → *Scheduler & backups*: daily backup after the chosen local hour (default
02:00), keeping the last 14. Each backup is a folder in `CRM_BACKUP_DIR` (default `data/backups`) holding:

- `veritek.sqlite` — a consistent copy of the database
- `files/` — every stored document
- `manifest.json` — record counts per table, each file's checksum, and quantity totals

A failed backup notifies the administrators and shows on Settings → System & backups. Point
`CRM_BACKUP_DIR` at a different disk or a mounted cloud bucket so a disk failure does not take the
backups with it, and copy them off the server regularly.

## Manual backup

From Settings → System & backups (**Back up now**), or on the server:

```bash
npm run backup
```

## Restore test (prove a backup works)

Run regularly, and before any upgrade:

```bash
npm run restore-test                # latest backup
npm run restore-test -- <folder>    # a specific backup
```

It restores into an isolated temporary folder and checks database integrity, record counts against the
manifest, every document's checksum, that order quantities still reconcile with dispatch and
cancellation events, and that every document link resolves. Example output:

```
ok   Database integrity — ok
ok   Record counts match the manifest — 8619 records across 20 tables
ok   Every attachment restored with a matching checksum — 153 file(s) verified
ok   Order quantities reconcile with dispatch and cancellation events — confirmed 23481, dispatched 19101, cancelled 215
ok   Document links point to restored files — All links resolve
```

## Restoring for real

1. Stop the service.
2. Move the current `data/veritek.sqlite` (and `-wal`, `-shm` if present) and `data/files/` aside — do not delete them.
3. Copy `veritek.sqlite` from the chosen backup into the data folder, and the backup's `files/` into `data/files/`.
4. Start the service; sign in as an administrator and check Settings → System & backups and a few recent records.

Recovery targets proposed by the specification: at most 24 hours of data loss and restoration within one
working day — met by the daily backup plus this procedure, subject to the hosting agreement.

## Full export

Settings → System & backups → **Download full export** gives a ZIP of every table as CSV plus the stored documents —
Veritek's own copy of its data, independent of this software.
