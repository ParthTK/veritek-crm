// Backups: every table exported (gzipped JSON) together with a manifest of record counts, quantity totals and
// document checksums, kept in the document store (a folder locally, the private bucket on Cloud Run). Locally
// the documents are copied into the backup too; in the bucket they are stored once and never overwritten, so
// the manifest's checksums are enough. The restore test reads a backup back and reconciles it. On Cloud SQL the
// database also has Google's automatic daily backups.
import zlib from 'node:zlib';
import { all, get, insert, update, run, exec, tx, val, migrate, columns } from '../db.js';
import { putFile, getFile, fileExists, listFiles, deletePrefix, BUCKET } from '../storage.js';
import { nowIso, today, settings, sha256, notify, tz } from '../util.js';
import { localDate, zonedParts } from '../../shared/dates.js';

const COUNT_TABLES = ['customers', 'contacts', 'enquiries', 'enquiry_lines', 'quotations', 'quote_revisions', 'orders', 'order_lines', 'dispatches', 'dispatch_lines',
  'cancellations', 'commitment_changes', 'order_updates', 'tasks', 'activities', 'attachments', 'history_events', 'invoices', 'receipts', 'complaints'];

const CHECKSUM_SAMPLE = 25;
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const sum = (rows, f) => round3(rows.reduce((s, r) => s + (Number(f(r)) || 0), 0));

/** Totals that must survive a restore, computed from exported rows (the same way for backup and test). */
function quantityTotals(tables) {
  const posted = new Set((tables.dispatches || []).filter((d) => d.status === 'posted').map((d) => d.id));
  const lines = tables.order_lines || [];
  return {
    confirmed: sum(lines, (l) => l.confirmed_qty),
    dispatched_events: sum((tables.dispatch_lines || []).filter((dl) => posted.has(dl.dispatch_id)), (dl) => dl.qty),
    cancelled_events: sum((tables.cancellations || []).filter((c) => !c.reversed_at), (c) => c.qty),
    dispatched_read_model: sum(lines, (l) => l.dispatched_qty),
    cancelled_read_model: sum(lines, (l) => l.cancelled_qty),
  };
}
const countsOf = (tables) => Object.fromEntries(COUNT_TABLES.map((t) => [t, (tables[t] || []).length]));

function exportTables() {
  const names = all('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename').map((t) => t.tablename);
  // Sessions are not worth restoring (everyone signs in again); everything else is.
  return Object.fromEntries(names.filter((t) => t !== 'sessions').map((t) => [t, all(`SELECT * FROM "${t}" ORDER BY 1`)]));
}

export function createBackup(trigger = 'manual') {
  const started = nowIso();
  const id = insert('backups', { trigger, started_at: started, status: 'running' });
  try {
    const prefix = `backups/backup-${started.replace(/[:.]/g, '-')}/`;
    const tables = exportTables();
    const dump = zlib.gzipSync(JSON.stringify({ format: 'veritek-crm-backup', version: 1, created_at: started, tables }));
    putFile(`${prefix}database.json.gz`, dump, { contentType: 'application/gzip', overwrite: true });
    const atts = tables.attachments || [];
    let bytes = 0;
    let copied = 0;
    const missing = [];
    // In the bucket one listing proves every document is there, without downloading them all.
    const inBucket = BUCKET ? new Set(listFiles('')) : null;
    for (const a of atts) {
      if (inBucket) {
        if (inBucket.has(a.storage_key)) bytes += a.size || 0;
        else missing.push(a.id);
        continue;
      }
      const data = getFile(a.storage_key);
      if (!data) {
        missing.push(a.id);
        continue;
      }
      putFile(`${prefix}files/${a.storage_key}`, data, { overwrite: true });
      copied++;
      bytes += a.size || data.length;
    }
    const manifest = {
      created_at: started, schema: (tables.schema_migrations || []).map((r) => r.version), counts: countsOf(tables), quantity_totals: quantityTotals(tables),
      attachments: atts.map((a) => ({ id: a.id, key: a.storage_key, checksum: a.checksum })), missing_files: missing, documents_copied: !BUCKET,
    };
    putFile(`${prefix}manifest.json`, JSON.stringify(manifest, null, 2), { contentType: 'application/json', overwrite: true });
    update('backups', id, {
      finished_at: nowIso(), status: missing.length ? 'warning' : 'ok', path: prefix, db_bytes: dump.length, files: BUCKET ? atts.length - missing.length : copied, file_bytes: bytes,
      manifest: JSON.stringify({ counts: manifest.counts, missing_files: missing.length }), error: missing.length ? `${missing.length} attachment file(s) were missing from storage` : null,
    });
    prune();
    return get('SELECT * FROM backups WHERE id = ?', id);
  } catch (err) {
    update('backups', id, { finished_at: nowIso(), status: 'failed', error: err.message });
    insert('error_log', { at: nowIso(), method: 'BACKUP', path: trigger, message: err.message, stack: err.stack?.slice(0, 4000) });
    for (const a of all("SELECT id FROM users WHERE role IN ('management','super_admin') AND active = 1")) {
      notify(a.id, { title: 'Backup failed', message: err.message, link: '/settings?tab=system', severity: 'danger', dedupeKey: `backup_fail:${today()}` });
    }
    return get('SELECT * FROM backups WHERE id = ?', id);
  }
}

function prune() {
  const keep = Math.max(1, Number(settings().backup.keep) || 14);
  const done = all("SELECT id, path FROM backups WHERE status IN ('ok','warning') AND path IS NOT NULL ORDER BY id DESC");
  for (const b of done.slice(keep)) {
    try {
      if (b.path && b.path.startsWith('backups/')) deletePrefix(b.path);
      update('backups', b.id, { status: 'pruned' });
    } catch {
      /* leave it */
    }
  }
}

/** Daily scheduled backup after the configured local hour, once per day. */
export function maybeScheduledBackup() {
  const cfg = settings().backup;
  if (!cfg.enabled) return null;
  const hour = zonedParts(new Date(), tz()).hour;
  if (hour < Number(cfg.hour || 0)) return null;
  const day = today();
  const last = get("SELECT started_at FROM backups WHERE trigger = 'scheduled' AND status IN ('ok','warning') ORDER BY id DESC LIMIT 1");
  if (last && localDate(new Date(last.started_at), tz()) === day) return null;
  return createBackup('scheduled');
}

/**
 * Reads a backup back and reconciles it: the export is complete and readable, record counts match the
 * manifest, every document is present with a matching checksum, and line quantities match their dispatch and
 * cancellation events.
 */
export function restoreTest(backupPath) {
  const prefix = backupPath || get("SELECT path FROM backups WHERE status IN ('ok','warning') ORDER BY id DESC LIMIT 1")?.path;
  const manifestRaw = prefix ? getFile(`${prefix}manifest.json`) : null;
  if (!manifestRaw) return { ok: false, checks: [{ name: 'Backup found', ok: false, detail: 'No completed backup to restore' }] };
  const checks = [];
  try {
    const manifest = JSON.parse(manifestRaw.toString('utf8'));
    const raw = getFile(`${prefix}database.json.gz`);
    const dump = raw ? JSON.parse(zlib.gunzipSync(raw).toString('utf8')) : null;
    const tables = dump?.tables || {};
    const expected = all('SELECT tablename FROM pg_tables WHERE schemaname = current_schema()').map((t) => t.tablename).filter((t) => t !== 'sessions');
    const absent = expected.filter((t) => !Array.isArray(tables[t]));
    checks.push({ name: 'Backup readable and complete', ok: Boolean(dump) && !absent.length, detail: !dump ? 'The database export is missing' : absent.length ? `Missing tables: ${absent.join(', ')}` : `${Object.keys(tables).length} tables` });
    const counts = countsOf(tables);
    const diffs = Object.entries(manifest.counts).filter(([t, n]) => counts[t] !== n).map(([t, n]) => `${t}: manifest ${n}, restored ${counts[t]}`);
    checks.push({ name: 'Record counts match the manifest', ok: !diffs.length, detail: diffs.length ? diffs.join('; ') : `${Object.values(counts).reduce((s, n) => s + n, 0)} records across ${COUNT_TABLES.length} tables` });
    let fileProblems = 0;
    let verified = 0;
    const attachments = tables.attachments || [];
    // Local backups hold their own copies: check them all. In the bucket, confirm every document exists from one
    // listing and verify the content of the most recent ones (downloading everything would stall the service).
    const inBucket = manifest.documents_copied ? null : new Set(listFiles(''));
    if (inBucket) fileProblems += attachments.filter((a) => !inBucket.has(a.storage_key)).length;
    const toVerify = inBucket ? attachments.filter((a) => inBucket.has(a.storage_key)).slice(-CHECKSUM_SAMPLE) : attachments;
    for (const a of toVerify) {
      const data = getFile(manifest.documents_copied ? `${prefix}files/${a.storage_key}` : a.storage_key);
      if (!data || sha256(data) !== a.checksum) fileProblems++;
      else verified++;
    }
    checks.push({ name: 'Every attachment restored with a matching checksum', ok: fileProblems === 0, detail: fileProblems ? `${fileProblems} file(s) missing or changed` : inBucket ? `${attachments.length} file(s) present, ${verified} most recent verified by checksum` : `${verified} file(s) verified` });
    const q = quantityTotals(tables);
    const qOk = Math.abs(q.dispatched_events - q.dispatched_read_model) < 0.001 && Math.abs(q.cancelled_events - q.cancelled_read_model) < 0.001
      && JSON.stringify(q) === JSON.stringify(manifest.quantity_totals);
    checks.push({ name: 'Order quantities reconcile with dispatch and cancellation events', ok: qOk, detail: `confirmed ${q.confirmed}, dispatched ${q.dispatched_events}, cancelled ${q.cancelled_events}` });
    const attIds = new Set((tables.attachments || []).map((a) => a.id));
    const orphans = (tables.attachment_links || []).filter((l) => !attIds.has(l.attachment_id)).length;
    checks.push({ name: 'Document links point to restored files', ok: orphans === 0, detail: orphans ? `${orphans} broken link(s)` : 'All links resolve' });
    return { ok: checks.every((c) => c.ok), backup: prefix, created_at: manifest.created_at, checks };
  } catch (err) {
    checks.push({ name: 'Restore', ok: false, detail: err.message });
    return { ok: false, backup: prefix, checks };
  }
}

export function listBackups() {
  return all('SELECT * FROM backups ORDER BY id DESC LIMIT 30');
}

/**
 * Loads a backup into an EMPTY database (a new installation or a fresh schema): creates the tables, loads
 * every row with the foreign keys set aside, restores the keys (which re-checks every link) and moves the id
 * counters past the restored rows — all in one transaction. Documents copied into a local backup are put
 * back; in the bucket they are already in place. Refuses to touch a database that has accounts.
 */
export function restoreBackup(prefix) {
  const raw = getFile(`${prefix}database.json.gz`);
  if (!raw) throw new Error(`No backup at ${prefix}`);
  const dump = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  if (dump.format !== 'veritek-crm-backup') throw new Error('This is not a Veritek CRM backup');
  migrate();
  if (val('SELECT COUNT(*) FROM users')) throw new Error('This database already has accounts. Restore only into an empty database.');
  const existing = new Set(all('SELECT tablename FROM pg_tables WHERE schemaname = current_schema()').map((t) => t.tablename));
  const tables = Object.keys(dump.tables).filter((t) => existing.has(t) && t !== 'schema_migrations');
  let rows = 0;
  tx(() => {
    const fks = all(`SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'f' AND connamespace = current_schema()::regnamespace`);
    for (const f of fks) exec(`ALTER TABLE ${f.tbl} DROP CONSTRAINT "${f.conname}"`);
    for (const t of tables) {
      exec(`DELETE FROM "${t}"`);
      const cols = [...columns(t)];
      const data = dump.tables[t];
      const perBatch = Math.max(1, Math.floor(30000 / cols.length));
      for (let i = 0; i < data.length; i += perBatch) {
        const batch = data.slice(i, i + perBatch);
        run(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${batch.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`,
          batch.flatMap((r) => cols.map((c) => (r[c] === undefined ? null : r[c]))));
      }
      rows += data.length;
    }
    for (const f of fks) exec(`ALTER TABLE ${f.tbl} ADD CONSTRAINT "${f.conname}" ${f.def}`);
    for (const t of tables) {
      if (columns(t).has('id')) run(`SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), COALESCE((SELECT MAX(id) FROM "${t}"), 0) + 1, false)`);
    }
  });
  let documents = 0;
  const manifestRaw = getFile(`${prefix}manifest.json`);
  const manifest = manifestRaw ? JSON.parse(manifestRaw.toString('utf8')) : {};
  if (manifest.documents_copied) {
    for (const a of dump.tables.attachments || []) {
      if (fileExists(a.storage_key)) continue;
      const data = getFile(`${prefix}files/${a.storage_key}`);
      if (data) {
        putFile(a.storage_key, data);
        documents++;
      }
    }
  }
  return { tables: tables.length, rows, documents_restored: documents, created_at: dump.created_at };
}
