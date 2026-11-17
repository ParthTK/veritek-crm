// Backups of the database and its attachments together, plus a restore test that reconciles linked
// files and quantities in an isolated copy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { db, all, get, insert, update, FILE_DIR, BACKUP_DIR } from '../db.js';
import { nowIso, today, settings, sha256, notify, tz } from '../util.js';
import { localDate, zonedParts } from '../../shared/dates.js';

const COUNT_TABLES = ['customers', 'contacts', 'enquiries', 'enquiry_lines', 'quotations', 'quote_revisions', 'orders', 'order_lines', 'dispatches', 'dispatch_lines',
  'cancellations', 'commitment_changes', 'order_updates', 'tasks', 'activities', 'attachments', 'history_events', 'invoices', 'receipts', 'complaints'];

function countsIn(database) {
  return Object.fromEntries(COUNT_TABLES.map((t) => [t, database.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
}
function quantityTotalsIn(database) {
  const q = database.prepare(`SELECT
      (SELECT ROUND(COALESCE(SUM(confirmed_qty), 0), 3) FROM order_lines) AS confirmed,
      (SELECT ROUND(COALESCE(SUM(dl.qty), 0), 3) FROM dispatch_lines dl JOIN dispatches d ON d.id = dl.dispatch_id WHERE d.status = 'posted') AS dispatched_events,
      (SELECT ROUND(COALESCE(SUM(qty), 0), 3) FROM cancellations WHERE reversed_at IS NULL) AS cancelled_events,
      (SELECT ROUND(COALESCE(SUM(dispatched_qty), 0), 3) FROM order_lines) AS dispatched_read_model,
      (SELECT ROUND(COALESCE(SUM(cancelled_qty), 0), 3) FROM order_lines) AS cancelled_read_model`).get();
  return { ...q };
}

export function createBackup(trigger = 'manual') {
  const started = nowIso();
  const id = insert('backups', { trigger, started_at: started, status: 'running' });
  try {
    const dir = path.join(BACKUP_DIR, `backup-${started.replace(/[:.]/g, '-')}`);
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    const dbFile = path.join(dir, 'veritek.sqlite');
    db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
    const atts = all('SELECT id, storage_key, checksum, size FROM attachments');
    let bytes = 0;
    let copied = 0;
    const missing = [];
    for (const a of atts) {
      const src = path.join(FILE_DIR, a.storage_key);
      if (!fs.existsSync(src)) {
        missing.push(a.id);
        continue;
      }
      fs.copyFileSync(src, path.join(dir, 'files', a.storage_key));
      bytes += a.size;
      copied++;
    }
    const manifest = {
      created_at: started, schema: all('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version), counts: countsIn(db),
      quantity_totals: quantityTotalsIn(db), attachments: atts.map((a) => ({ id: a.id, key: a.storage_key, checksum: a.checksum })), missing_files: missing,
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    update('backups', id, {
      finished_at: nowIso(), status: missing.length ? 'warning' : 'ok', path: dir, db_bytes: fs.statSync(dbFile).size, files: copied, file_bytes: bytes,
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
      if (b.path && b.path.startsWith(BACKUP_DIR)) fs.rmSync(b.path, { recursive: true, force: true });
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
 * Restores a backup into an isolated temporary folder and reconciles it: database integrity, record counts
 * against the manifest, every attachment present with a matching checksum, and line quantities matching
 * their dispatch/cancellation events.
 */
export function restoreTest(backupPath) {
  const dir = backupPath || get("SELECT path FROM backups WHERE status IN ('ok','warning') ORDER BY id DESC LIMIT 1")?.path;
  if (!dir || !fs.existsSync(dir)) return { ok: false, checks: [{ name: 'Backup found', ok: false, detail: 'No completed backup to restore' }] };
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veritek-restore-'));
  const checks = [];
  try {
    fs.copyFileSync(path.join(dir, 'veritek.sqlite'), path.join(tmp, 'restored.sqlite'));
    fs.cpSync(path.join(dir, 'files'), path.join(tmp, 'files'), { recursive: true });
    const rdb = new DatabaseSync(path.join(tmp, 'restored.sqlite'));
    const integrity = rdb.prepare('PRAGMA integrity_check').get();
    checks.push({ name: 'Database integrity', ok: Object.values(integrity)[0] === 'ok', detail: Object.values(integrity)[0] });
    const counts = countsIn(rdb);
    const diffs = Object.entries(manifest.counts).filter(([t, n]) => counts[t] !== n).map(([t, n]) => `${t}: manifest ${n}, restored ${counts[t]}`);
    checks.push({ name: 'Record counts match the manifest', ok: !diffs.length, detail: diffs.length ? diffs.join('; ') : `${Object.values(counts).reduce((s, n) => s + n, 0)} records across ${COUNT_TABLES.length} tables` });
    let fileProblems = 0;
    for (const a of rdb.prepare('SELECT id, storage_key, checksum FROM attachments').all()) {
      const p = path.join(tmp, 'files', a.storage_key);
      if (!fs.existsSync(p) || sha256(fs.readFileSync(p)) !== a.checksum) fileProblems++;
    }
    checks.push({ name: 'Every attachment restored with a matching checksum', ok: fileProblems === 0, detail: fileProblems ? `${fileProblems} file(s) missing or changed` : `${counts.attachments} file(s) verified` });
    const q = quantityTotalsIn(rdb);
    const qOk = Math.abs(q.dispatched_events - q.dispatched_read_model) < 0.001 && Math.abs(q.cancelled_events - q.cancelled_read_model) < 0.001
      && JSON.stringify(q) === JSON.stringify(manifest.quantity_totals);
    checks.push({ name: 'Order quantities reconcile with dispatch and cancellation events', ok: qOk, detail: `confirmed ${q.confirmed}, dispatched ${q.dispatched_events}, cancelled ${q.cancelled_events}` });
    const orphans = rdb.prepare("SELECT COUNT(*) AS n FROM attachment_links l LEFT JOIN attachments a ON a.id = l.attachment_id WHERE a.id IS NULL").get().n;
    checks.push({ name: 'Document links point to restored files', ok: orphans === 0, detail: orphans ? `${orphans} broken link(s)` : 'All links resolve' });
    rdb.close();
    return { ok: checks.every((c) => c.ok), backup: dir, created_at: manifest.created_at, checks };
  } catch (err) {
    checks.push({ name: 'Restore', ok: false, detail: err.message });
    return { ok: false, backup: dir, checks };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function listBackups() {
  return all('SELECT * FROM backups ORDER BY id DESC LIMIT 30');
}
