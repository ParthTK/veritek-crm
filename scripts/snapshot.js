// Builds the demo snapshot shipped with a serverless deployment: seed/veritek-seed.sqlite plus the demo
// documents in seed/files. On a cold start the server copies both into its temporary data folder.
// Run it whenever you want the demo data refreshed (the data is dated relative to the day it was generated).
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDb = path.join(root, 'seed', 'veritek-seed.sqlite');
const outFiles = path.join(root, 'seed', 'files');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'veritek-snapshot-'));
const dbPath = path.join(work, 'veritek.sqlite');

console.log('Generating demo data…');
const res = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/seed.js', '--reset'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CRM_DATA_DIR: work, CRM_DB: dbPath, CRM_NO_SNAPSHOT: '1' },
});
if (res.status !== 0) process.exit(res.status ?? 1);

// Fold the write-ahead log into the main file so the snapshot is a single self-contained file.
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; VACUUM;');
const referenced = new Set(db.prepare('SELECT storage_key FROM attachments').all().map((r) => r.storage_key));
db.close();

fs.mkdirSync(path.dirname(outDb), { recursive: true });
fs.copyFileSync(dbPath, outDb);

// Replace the shipped documents with exactly the ones the new database references.
fs.rmSync(outFiles, { recursive: true, force: true });
fs.mkdirSync(outFiles, { recursive: true });
let copied = 0;
let bytes = 0;
const srcFiles = path.join(work, 'files');
for (const name of fs.existsSync(srcFiles) ? fs.readdirSync(srcFiles) : []) {
  if (!referenced.has(name)) continue;
  fs.copyFileSync(path.join(srcFiles, name), path.join(outFiles, name));
  copied++;
  bytes += fs.statSync(path.join(outFiles, name)).size;
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`Snapshot written to seed/veritek-seed.sqlite (${(fs.statSync(outDb).size / 1024 / 1024).toFixed(1)} MB) and ${copied} document(s) to seed/files (${(bytes / 1024).toFixed(0)} KB)`);
