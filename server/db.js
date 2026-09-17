import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Serverless platforms give us a read-only bundle and a writable /tmp, so the database
// lives there and is restored from the snapshot shipped with the deployment on cold start.
export const EPHEMERAL = Boolean(process.env.VERCEL || process.env.CRM_EPHEMERAL);
export const DATA_DIR = process.env.CRM_DATA_DIR || (EPHEMERAL ? '/tmp/veritek-data' : path.join(here, '..', 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const DB_PATH = process.env.CRM_DB || path.join(DATA_DIR, 'crm.sqlite');

const SNAPSHOT = path.join(here, '..', 'seed', 'crm-seed.sqlite');
if (!fs.existsSync(DB_PATH) && fs.existsSync(SNAPSHOT)) {
  fs.copyFileSync(SNAPSHOT, DB_PATH);
  console.log(`Restored the demo database from ${path.basename(SNAPSHOT)}`);
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
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const out = {};
    for (const [k, v] of Object.entries(params[0])) out[k] = bindValue(v);
    return [out];
  }
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
  if (!columnCache.has(table)) {
    columnCache.set(table, new Set(all(`PRAGMA table_info(${table})`).map((c) => c.name)));
  }
  return columnCache.get(table);
}

/** Insert only the keys that are real columns of the table. Returns the new row id. */
export function insert(table, data) {
  const cols = columns(table);
  const keys = Object.keys(data).filter((k) => cols.has(k) && data[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const res = run(sql, keys.map((k) => data[k]));
  return Number(res.lastInsertRowid);
}

/** Update only the keys that are real columns (never the id). */
export function update(table, id, data) {
  const cols = columns(table);
  const keys = Object.keys(data).filter((k) => k !== 'id' && cols.has(k) && data[k] !== undefined);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  return Number(run(sql, [...keys.map((k) => data[k]), id]).changes);
}

let txDepth = 0;
/** Run fn inside a transaction; nested calls use savepoints. */
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

export function migrate() {
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  columnCache.clear();
}

export function getSetting(key, fallback) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
