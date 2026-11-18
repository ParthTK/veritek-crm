// Document storage: a folder on disk (<data>/files) for local use, or a private Google Cloud Storage bucket
// when CRM_FILES_BUCKET is set (Cloud Run). Calls are synchronous like the database — the bucket requests
// run in the database worker (see db-worker.js) — so the services stay unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { FILE_DIR, gcsCall } from './db.js';

export const BUCKET = process.env.CRM_FILES_BUCKET || '';
const PREFIX = process.env.CRM_FILES_PREFIX || '';
/** Where documents are kept, for logs and the system page. */
export const STORAGE_LABEL = BUCKET ? `gs://${BUCKET}/${PREFIX}` : FILE_DIR;

function checkKey(key) {
  if (!key || typeof key !== 'string' || key.includes('..') || key.startsWith('/') || key.includes('\\')) throw new Error('Invalid storage key');
  return key;
}
const onDisk = (key) => path.join(FILE_DIR, ...checkKey(key).split('/'));
const toBuffer = (u8) => (u8 ? Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength) : null);

/** Stores a file. Without `overwrite`, an existing key is an error (keys are unique per upload). */
export function putFile(key, data, { contentType = 'application/octet-stream', overwrite = false } = {}) {
  if (BUCKET) {
    gcsCall('put', BUCKET, PREFIX + checkKey(key), data, contentType);
    return;
  }
  const p = onDisk(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data, overwrite ? undefined : { flag: 'wx' });
}

/** The file's bytes, or null when it is not there. */
export function getFile(key) {
  if (BUCKET) return toBuffer(gcsCall('get', BUCKET, PREFIX + checkKey(key)));
  const p = onDisk(key);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

export function fileExists(key) {
  if (BUCKET) return gcsCall('exists', BUCKET, PREFIX + checkKey(key));
  return fs.existsSync(onDisk(key));
}

export function deleteFile(key) {
  if (BUCKET) {
    gcsCall('remove', BUCKET, PREFIX + checkKey(key));
    return;
  }
  fs.rmSync(onDisk(key), { force: true });
}

/** Keys under a folder-like prefix (e.g. 'backups/backup-2026-…/'). */
export function listFiles(prefix) {
  if (BUCKET) return gcsCall('list', BUCKET, PREFIX + prefix).map((k) => k.slice(PREFIX.length));
  const folder = prefix.replace(/\/$/, '');
  const base = folder ? onDisk(folder) : FILE_DIR;
  if (!fs.existsSync(base)) return [];
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(folder ? `${folder}/${r}` : r);
    }
  };
  walk(base, '');
  return out;
}

export function deletePrefix(prefix) {
  if (!BUCKET) {
    fs.rmSync(onDisk(prefix.replace(/\/$/, '')), { recursive: true, force: true });
    return;
  }
  for (const key of listFiles(prefix)) deleteFile(key);
}
