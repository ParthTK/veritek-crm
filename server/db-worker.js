// The database worker. It owns the one PostgreSQL connection — Cloud SQL through `pg` in production, or an
// in-process PGlite (PostgreSQL compiled to WebAssembly) for local use, tests and the demo — and answers the
// main thread's calls one at a time (see db.js, which waits for each answer). It also performs Google Cloud
// Storage requests for the file store, so those can be called the same way.
import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';

const { port, signal, config } = workerData;

// PostgreSQL returns 64-bit integers and numerics as text and booleans as true/false; the application was
// written against SQLite, which returns numbers and 0/1. Values here stay well inside 2^53.
const PARSERS = { 20: (v) => Number(v), 1700: (v) => Number(v), 16: (v) => (v === 't' || v === true ? 1 : 0) };

let backend = null;

async function openPg() {
  const pg = (await import('pg')).default;
  for (const [oid, fn] of Object.entries(PARSERS)) pg.types.setTypeParser(Number(oid), fn);
  let client = null;
  let inTransaction = false;
  let transactionLost = false;
  const connect = async () => {
    const c = new pg.Client(config.url ? { connectionString: config.url } : {});
    c.on('error', () => { if (client === c) client = null; }); // dropped connection: reconnect on next use
    await c.connect();
    // The CRM's own schema first; `public` after it only so shared extension types (citext) resolve. The
    // CRM's user has no rights on the website's and portal's tables, wherever they live.
    if (config.schema) await c.query(`SET search_path TO "${config.schema.replace(/"/g, '')}", public`);
    client = c;
    return c;
  };
  const COMMIT = /^\s*COMMIT\s*;?\s*$/i;
  const ROLLBACK = /^\s*ROLLBACK\s*;?\s*$/i;
  const send = async (sql, params) => {
    // After a connection is lost mid-transaction, nothing may run until the caller has ended that transaction:
    // the server has already rolled it back, and later statements must not commit on their own.
    if (transactionLost) {
      if (ROLLBACK.test(sql)) {
        transactionLost = false;
        return { rows: [], rowCount: 0 };
      }
      if (COMMIT.test(sql)) transactionLost = false;
      throw new Error('The database connection was lost during this transaction; it was rolled back');
    }
    // Reads and BEGIN can safely be repeated on a new connection. A write cannot: it may already have happened.
    const repeatable = !inTransaction && /^\s*(SELECT|BEGIN)\b/i.test(sql);
    for (let attempt = 0; ; attempt++) {
      try {
        const c = client || (await connect());
        const r = await c.query(sql, params);
        if (/^\s*BEGIN\b/i.test(sql)) inTransaction = true;
        else if (COMMIT.test(sql) || ROLLBACK.test(sql)) inTransaction = false;
        return r;
      } catch (err) {
        if (err.severity) throw err; // reported by the server: an ordinary statement error
        // The connection itself failed (Cloud SQL maintenance, or it went stale while the container slept).
        const dead = client;
        client = null;
        dead?.end().catch(() => {});
        if (inTransaction) {
          inTransaction = false;
          transactionLost = true;
        }
        if (!repeatable || attempt) throw err;
      }
    }
  };
  return {
    kind: 'postgres',
    query: async (sql, params) => {
      const r = await send(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    exec: async (sql) => {
      await send(sql);
      return null;
    },
    close: async () => { if (client) await client.end(); client = null; },
  };
}

async function openPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const options = { extensions: { citext }, parsers: PARSERS };
  // A fresh data folder can start from a snapshot (the demo deployment ships one).
  if (config.snapshot && config.dataDir && !fs.existsSync(config.dataDir) && fs.existsSync(config.snapshot)) {
    options.loadDataDir = new Blob([fs.readFileSync(config.snapshot)]);
    config.restoredFromSnapshot = true;
  }
  const db = await PGlite.create(config.dataDir ? config.dataDir : 'memory://', options);
  return {
    kind: 'pglite',
    query: async (sql, params) => {
      const r = await db.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
    },
    exec: async (sql) => { await db.exec(sql); return null; },
    dump: async (file) => {
      const blob = await db.dumpDataDir('gzip');
      fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
      return file;
    },
    close: () => db.close(),
  };
}

// ------------------------------------------------------------------ Google Cloud Storage (JSON API)
// On Cloud Run the access token comes from the metadata server for the service's own account.
let gcsToken = null;
async function token() {
  if (gcsToken && gcsToken.expires > Date.now() + 60000) return gcsToken.value;
  if (process.env.CRM_GCS_TOKEN) return process.env.CRM_GCS_TOKEN; // local testing only
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`Could not get a storage access token (${res.status})`);
  const b = await res.json();
  gcsToken = { value: b.access_token, expires: Date.now() + b.expires_in * 1000 };
  return gcsToken.value;
}
const enc = encodeURIComponent;
const GCS = process.env.CRM_GCS_ENDPOINT || 'https://storage.googleapis.com'; // overridable for tests
const gcs = {
  async put(bucket, key, data, contentType = 'application/octet-stream') {
    const res = await fetch(`${GCS}/upload/storage/v1/b/${enc(bucket)}/o?uploadType=media&name=${enc(key)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': contentType }, body: data,
    });
    if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return true;
  },
  async get(bucket, key) {
    const res = await fetch(`${GCS}/storage/v1/b/${enc(bucket)}/o/${enc(key)}?alt=media`, { headers: { Authorization: `Bearer ${await token()}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Storage download failed (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
  async exists(bucket, key) {
    const res = await fetch(`${GCS}/storage/v1/b/${enc(bucket)}/o/${enc(key)}?fields=name`, { headers: { Authorization: `Bearer ${await token()}` } });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`Storage check failed (${res.status})`);
    return true;
  },
  async remove(bucket, key) {
    const res = await fetch(`${GCS}/storage/v1/b/${enc(bucket)}/o/${enc(key)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${await token()}` } });
    if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed (${res.status})`);
    return true;
  },
  async list(bucket, prefix) {
    const names = [];
    let pageToken = '';
    do {
      const res = await fetch(`${GCS}/storage/v1/b/${enc(bucket)}/o?prefix=${enc(prefix)}&fields=items(name),nextPageToken${pageToken ? `&pageToken=${enc(pageToken)}` : ''}`, { headers: { Authorization: `Bearer ${await token()}` } });
      if (!res.ok) throw new Error(`Storage listing failed (${res.status})`);
      const b = await res.json();
      for (const it of b.items || []) names.push(it.name);
      pageToken = b.nextPageToken || '';
    } while (pageToken);
    return names;
  },
};

// ------------------------------------------------------------------ message loop
const opened = (config.url || config.pgEnv ? openPg() : openPglite()).then((b) => { backend = b; return b; });
opened.catch(() => {}); // reported on the first call

async function handle(msg) {
  if (msg.op === 'gcs') return gcs[msg.fn](...msg.args);
  const b = await opened;
  switch (msg.op) {
    case 'open': return { kind: b.kind, restoredFromSnapshot: Boolean(config.restoredFromSnapshot) };
    case 'query': return b.query(msg.sql, msg.params);
    case 'exec': return b.exec(msg.sql);
    case 'dump': return b.dump ? b.dump(msg.file) : null;
    case 'close': await b.close(); return null;
    default: throw new Error(`Unknown database operation ${msg.op}`);
  }
}

parentPort.on('message', async (msg) => {
  let reply;
  try {
    reply = { id: msg.id, result: await handle(msg) };
  } catch (err) {
    reply = { id: msg.id, error: { message: err.message, code: err.code, detail: err.detail, constraint: err.constraint, table: err.table, column: err.column, position: err.position } };
  }
  port.postMessage(reply);
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
});
