import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');

// Serverless platforms give a read-only bundle and a writable /tmp: the database lives there and is
// restored from the snapshot shipped with the deployment on a cold start.
export const EPHEMERAL = Boolean(process.env.VERCEL || process.env.CRM_EPHEMERAL);
export const ENV = process.env.CRM_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
export const DATA_DIR = process.env.CRM_DATA_DIR || (EPHEMERAL ? '/tmp/veritek-data' : path.join(ROOT, 'data'));
export const FILE_DIR = path.join(DATA_DIR, 'files');
export const BACKUP_DIR = process.env.CRM_BACKUP_DIR || path.join(DATA_DIR, 'backups');
export const DB_PATH = process.env.CRM_DB || path.join(DATA_DIR, 'veritek.sqlite');
fs.mkdirSync(FILE_DIR, { recursive: true });

export const SNAPSHOT = path.join(ROOT, 'seed', 'veritek-seed.sqlite');
const SNAPSHOT_FILES = path.join(ROOT, 'seed', 'files');
export const RESTORED_FROM_SNAPSHOT = !fs.existsSync(DB_PATH) && fs.existsSync(SNAPSHOT) && process.env.CRM_NO_SNAPSHOT !== '1';
if (RESTORED_FROM_SNAPSHOT) {
  fs.copyFileSync(SNAPSHOT, DB_PATH);
  if (fs.existsSync(SNAPSHOT_FILES)) {
    for (const name of fs.readdirSync(SNAPSHOT_FILES)) {
      const target = path.join(FILE_DIR, name);
      if (!fs.existsSync(target)) fs.copyFileSync(path.join(SNAPSHOT_FILES, name), target);
    }
  }
  console.log(`Restored the demo database and documents from ${path.basename(SNAPSHOT)}`);
}

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const statements = new Map();
function prepare(sql) {
  let s = statements.get(sql);
  if (!s) {
    s = db.prepare(sql);
    statements.set(sql, s);
  }
  return s;
}

function bindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function bind(params) {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map(bindValue);
}

export const all = (sql, ...params) => prepare(sql).all(...bind(params));
export const get = (sql, ...params) => prepare(sql).get(...bind(params));
export const run = (sql, ...params) => prepare(sql).run(...bind(params));
export const val = (sql, ...params) => {
  const row = get(sql, ...params);
  return row ? Object.values(row)[0] : undefined;
};

const columnCache = new Map();
export function columns(table) {
  if (!columnCache.has(table)) columnCache.set(table, new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name)));
  return columnCache.get(table);
}

/** Insert only keys that are real columns. Returns the new row id. */
export function insert(table, data) {
  const cols = columns(table);
  const keys = Object.keys(data).filter((k) => cols.has(k) && data[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return Number(run(sql, keys.map((k) => data[k])).lastInsertRowid);
}

/** Update real columns of a row (never the id). Returns the number of changed rows. */
export function update(table, id, data) {
  const cols = columns(table);
  const keys = Object.keys(data).filter((k) => k !== 'id' && cols.has(k) && data[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  return Number(run(sql, [...keys.map((k) => data[k]), id]).changes);
}

/**
 * Optimistic concurrency: update only if the stored version still matches, and bump it.
 * Returns false when someone else saved first.
 */
export function updateVersioned(table, id, expectedVersion, data) {
  const cols = columns(table);
  const keys = Object.keys(data).filter((k) => !['id', 'version'].includes(k) && cols.has(k) && data[k] !== undefined);
  const sets = [...keys.map((k) => `${k} = ?`), 'version = version + 1'];
  const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND version = ?`;
  return Number(run(sql, [...keys.map((k) => data[k]), id, expectedVersion]).changes) === 1;
}

let txDepth = 0;
/** Run fn inside a transaction; nested calls use savepoints so an inner failure can be isolated. */
export function tx(fn) {
  const sp = `sp${txDepth}`;
  db.exec(txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    db.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    txDepth--;
    db.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

/** Applies numbered SQL migrations from server/migrations exactly once each. */
export function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(all('SELECT version FROM schema_migrations').map((r) => r.version));
  const dir = path.join(here, 'migrations');
  const pending = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort();
  for (const file of pending) {
    tx(() => {
      db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
      run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', file, new Date().toISOString());
    });
    console.log(`Applied migration ${file}`);
  }
  columnCache.clear();
  return pending;
}

export function closeDb() {
  try {
    db.close();
  } catch {
    /* already closed */
  }
}
