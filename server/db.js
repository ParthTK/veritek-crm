// Data access. The application keeps one simple, synchronous API (all / get / run / insert / update / tx),
// backed by PostgreSQL: Cloud SQL (or any PostgreSQL server) when CRM_DATABASE_URL or PGHOST is set, otherwise
// an in-process PGlite database in <data>/pgdata. Queries run in a worker thread (db-worker.js) and this thread
// waits for each answer, so requests are handled one statement at a time — the same serial model the code was
// written for — and transactions never interleave.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');

// Serverless platforms give a read-only bundle and a writable /tmp: a PGlite database lives there and is
// restored from the snapshot shipped with the deployment on a cold start (the demo).
export const EPHEMERAL = Boolean(process.env.VERCEL || process.env.CRM_EPHEMERAL);
export const ENV = process.env.CRM_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
export const DATA_DIR = process.env.CRM_DATA_DIR || (EPHEMERAL ? '/tmp/veritek-data' : path.join(ROOT, 'data'));
export const FILE_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILE_DIR, { recursive: true });

const PG_URL = process.env.CRM_DATABASE_URL || '';
const PG_ENV = !PG_URL && Boolean(process.env.PGHOST);
/** True when the data is in a PostgreSQL server (Cloud SQL); false for the in-process PGlite database. */
export const POSTGRES_SERVER = Boolean(PG_URL || PG_ENV);
export const PG_SCHEMA = process.env.CRM_PG_SCHEMA || '';
export const PGLITE_DIR = process.env.CRM_PGLITE_DIR || path.join(DATA_DIR, 'pgdata');
/** Where the data lives, for logs and the system page (never includes a password). */
export const DB_PATH = POSTGRES_SERVER ? describeServer() : PGLITE_DIR;
function describeServer() {
  try {
    if (PG_URL) {
      const u = new URL(PG_URL);
      return `postgresql://${u.hostname || u.searchParams.get('host') || 'localhost'}${u.pathname}${PG_SCHEMA ? ` (schema ${PG_SCHEMA})` : ''}`;
    }
  } catch { /* fall through */ }
  return `postgresql://${process.env.PGHOST}/${process.env.PGDATABASE || ''}${PG_SCHEMA ? ` (schema ${PG_SCHEMA})` : ''}`;
}

export const SNAPSHOT = path.join(ROOT, 'seed', 'veritek-demo.tar.gz');
const SNAPSHOT_FILES = path.join(ROOT, 'seed', 'files');
// Never for a real installation (CRM_NO_DEMO=1), and not for the seed script, which builds its own data.
const SEED_SCRIPT = /[\\/]server[\\/]seed\.js$/.test(process.argv[1] || '');
export const RESTORED_FROM_SNAPSHOT = !SEED_SCRIPT && !POSTGRES_SERVER && !fs.existsSync(PGLITE_DIR) && fs.existsSync(SNAPSHOT)
  && process.env.CRM_NO_SNAPSHOT !== '1' && process.env.CRM_NO_DEMO !== '1';
if (RESTORED_FROM_SNAPSHOT && fs.existsSync(SNAPSHOT_FILES)) {
  for (const name of fs.readdirSync(SNAPSHOT_FILES)) {
    const target = path.join(FILE_DIR, name);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(SNAPSHOT_FILES, name), target);
  }
}

// ------------------------------------------------------------------ the worker bridge
const TIMEOUT_MS = Number(process.env.CRM_DB_TIMEOUT_MS) || 120000;
let bridge = null;

function startBridge() {
  const { port1, port2 } = new MessageChannel();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const config = {
    url: PG_URL || null, pgEnv: PG_ENV, schema: PG_SCHEMA || null,
    dataDir: POSTGRES_SERVER ? null : PGLITE_DIR, snapshot: RESTORED_FROM_SNAPSHOT ? SNAPSHOT : null,
  };
  // execArgv: [] — the worker must not inherit the parent's flags (`-e`, `--watch`), which can stop it starting.
  const worker = new Worker(new URL('./db-worker.js', import.meta.url), { workerData: { port: port2, signal, config }, transferList: [port2], execArgv: [] });
  worker.unref();
  port1.unref();
  bridge = { worker, port: port1, signal, seq: 0 };
  return bridge;
}

function call(op, payload = {}, timeoutMs = TIMEOUT_MS) {
  const b = bridge || startBridge();
  const id = ++b.seq;
  b.worker.postMessage({ id, op, ...payload });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The worker posts its answer, then bumps the counter and wakes us. Read the counter before looking for
    // the answer, so an answer that lands in between ends the wait at once instead of being missed.
    const seen = Atomics.load(b.signal, 0);
    let msg;
    while ((msg = receiveMessageOnPort(b.port))) {
      const m = msg.message;
      if (m.id !== id) continue; // a late answer to an earlier, timed-out call
      if (m.error) throw dbError(m.error, payload.sql);
      return m.result;
    }
    const left = deadline - Date.now();
    if (left <= 0 || Atomics.wait(b.signal, 0, seen, left) === 'timed-out') {
      // A hung connection: start over with a fresh worker on the next call.
      b.worker.terminate();
      if (bridge === b) bridge = null;
      throw new Error('The database did not answer in time');
    }
  }
}

// PostgreSQL error codes → the messages the rest of the application (and its error handler) recognise.
const CONSTRAINT_MESSAGES = { 23505: 'UNIQUE constraint failed', 23514: 'CHECK constraint failed', 23503: 'FOREIGN KEY constraint failed', 23502: 'NOT NULL constraint failed' };
function dbError(e, sql) {
  const prefix = CONSTRAINT_MESSAGES[e.code];
  const err = new Error(prefix ? `${prefix}: ${e.constraint || e.column || e.detail || e.message}` : e.message);
  Object.assign(err, { code: e.code, detail: e.detail, constraint: e.constraint, table: e.table, column: e.column });
  if (sql) err.sql = sql.slice(0, 2000);
  return err;
}

// ------------------------------------------------------------------ SQL dialect
// The queries keep a few SQLite habits, translated here outside quoted text and comments:
//   `?` placeholders                  → $1, $2, …
//   x = ? COLLATE NOCASE              → lower(x) = lower(?)
//   x IS ? / x IS NOT ?  (null-safe)  → IS NOT DISTINCT FROM / IS DISTINCT FROM
//   LIKE (case-insensitive in SQLite) → ILIKE
//   DESC (NULLs last in SQLite)       → DESC NULLS LAST
const translated = new Map();
export function toPg(sql) {
  const hit = translated.get(sql);
  if (hit) return hit;
  let n = 0;
  let out = '';
  let seg = '';
  const flush = () => {
    out += seg
      .replace(/([A-Za-z_][\w.]*)\s*=\s*\?\s+COLLATE\s+NOCASE\b/g, 'lower($1) = lower(?)')
      .replace(/\bIS\s+NOT\s+\?/g, 'IS DISTINCT FROM ?')
      .replace(/\bIS\s+\?/g, 'IS NOT DISTINCT FROM ?')
      .replace(/\bLIKE\b/gi, 'ILIKE')
      .replace(/\bDESC\b(?!\s+NULLS)/g, 'DESC NULLS LAST')
      .replace(/\?/g, () => `$${++n}`);
    seg = '';
  };
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      flush();
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '-' && sql[i + 1] === '-') {
      flush();
      const end = sql.indexOf('\n', i) === -1 ? sql.length : sql.indexOf('\n', i);
      out += sql.slice(i, end);
      i = end;
    } else if (ch === '/' && sql[i + 1] === '*') {
      flush();
      const end = sql.indexOf('*/', i + 2) === -1 ? sql.length : sql.indexOf('*/', i + 2) + 2;
      out += sql.slice(i, end);
      i = end;
    } else {
      seg += ch;
      i++;
    }
  }
  flush();
  if (translated.size > 5000) translated.clear();
  translated.set(sql, out);
  return out;
}

function bindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function bind(params) {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map(bindValue);
}

function query(sql, params) {
  return call('query', { sql: toPg(sql), params: bind(params) });
}

export const all = (sql, ...params) => query(sql, params).rows;
export const get = (sql, ...params) => query(sql, params).rows[0];
/** Runs a statement. `changes` is the number of rows affected; `lastInsertRowid` is set by `RETURNING id`. */
export const run = (sql, ...params) => {
  const r = query(sql, params);
  return { changes: r.rowCount, lastInsertRowid: r.rows?.[0]?.id };
};
export const val = (sql, ...params) => {
  const row = get(sql, ...params);
  return row ? Object.values(row)[0] : undefined;
};
/** Runs one or more statements without parameters or translation (schema changes). */
export function exec(sql) {
  call('exec', { sql });
}
export const db = { exec };

const columnCache = new Map();
export function columns(table) {
  if (!columnCache.has(table)) {
    // One query for every table: this runs after each start, and a cold start should stay quick.
    columnCache.clear();
    for (const c of all('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()')) {
      if (!columnCache.has(c.table_name)) columnCache.set(c.table_name, new Set());
      columnCache.get(c.table_name).add(c.column_name);
    }
    if (!columnCache.has(table)) columnCache.set(table, new Set());
  }
  return columnCache.get(table);
}

/** Insert only keys that are real columns. Returns the new row id (0 for tables without an id column). */
export function insert(table, data) {
  const cols = columns(table);
  const keys = Object.keys(data).filter((k) => cols.has(k) && data[k] !== undefined);
  const returning = cols.has('id') ? ' RETURNING id' : '';
  const sql = keys.length
    ? `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})${returning}`
    : `INSERT INTO ${table} DEFAULT VALUES${returning}`;
  return Number(run(sql, keys.map((k) => data[k])).lastInsertRowid || 0);
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
/**
 * Run fn inside a transaction; nested calls use savepoints so an inner failure can be isolated. (In
 * PostgreSQL a failed statement spoils the whole transaction, so code that catches an error and carries on
 * must wrap the attempt in its own tx().)
 */
export function tx(fn) {
  const sp = `sp${txDepth}`;
  exec(txDepth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    exec(txDepth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    txDepth--;
    try {
      exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
    } catch {
      /* the original error matters more */
    }
    throw err;
  }
}
export const inTransaction = () => txDepth > 0;

/** Applies numbered SQL migrations from server/migrations exactly once each. */
export function migrate() {
  exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(all('SELECT version FROM schema_migrations').map((r) => r.version));
  const dir = path.join(here, 'migrations');
  const pending = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && !applied.has(f)).sort();
  for (const file of pending) {
    tx(() => {
      exec(fs.readFileSync(path.join(dir, file), 'utf8'));
      run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', file, new Date().toISOString());
    });
    console.log(`Applied migration ${file}`);
  }
  columnCache.clear();
  return pending;
}

/** Drops every table in the current schema (demo rebuilds only — the seed script guards real data). */
export function dropAllTables() {
  const tables = all('SELECT tablename FROM pg_tables WHERE schemaname = current_schema()').map((t) => t.tablename);
  if (tables.length) exec(tables.map((t) => `DROP TABLE IF EXISTS "${t}" CASCADE;`).join('\n'));
  columnCache.clear();
}

/** Size of the CRM's tables in bytes. */
export function databaseBytes() {
  return Number(val("SELECT COALESCE(SUM(pg_total_relation_size(format('%I.%I', schemaname, tablename))), 0) FROM pg_tables WHERE schemaname = current_schema()") || 0);
}

/** Writes a PGlite data-folder snapshot (gzip tarball) to `file`. */
export function dumpDatabase(file) {
  return call('dump', { file }, 600000);
}

/** Google Cloud Storage request run by the worker (see storage.js). */
export function gcsCall(fn, ...args) {
  return call('gcs', { fn, args }, 300000);
}

export function closeDb() {
  if (!bridge) return;
  try {
    call('close', {}, 30000);
  } catch {
    /* already closed */
  }
  bridge.worker.terminate();
  bridge = null;
}
