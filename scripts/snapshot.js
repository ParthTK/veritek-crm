// Builds seed/crm-seed.sqlite — the demo database shipped with a serverless deployment
// and copied into /tmp on cold start. Run it whenever you want the demo data refreshed
// (the data is dated relative to the day it was generated).
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'seed', 'crm-seed.sqlite');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'veritek-snapshot-'));
const dbPath = path.join(work, 'crm.sqlite');

console.log('Generating demo data…');
const res = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/seed.js', '--reset'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CRM_DATA_DIR: work, CRM_DB: dbPath },
});
if (res.status !== 0) process.exit(res.status ?? 1);

// Fold the write-ahead log into the main file so the snapshot is a single self-contained file.
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;');
db.close();

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(dbPath, out);
fs.rmSync(work, { recursive: true, force: true });
console.log(`Snapshot written to seed/crm-seed.sqlite (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
