// Builds the demo snapshot shipped with a serverless deployment: seed/veritek-demo.tar.gz (a PGlite data
// folder) plus the demo documents in seed/files. On a cold start the server restores both into its temporary
// data folder. Run it whenever you want the demo data refreshed (the data is dated relative to the day it was
// generated).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDb = path.join(root, 'seed', 'veritek-demo.tar.gz');
const outFiles = path.join(root, 'seed', 'files');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'veritek-snapshot-'));
const env = { ...process.env, CRM_DATA_DIR: work, CRM_NO_SNAPSHOT: '1' };
delete env.CRM_DATABASE_URL;
delete env.PGHOST;

console.log('Generating demo data…');
const res = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/seed.js', '--reset'], { cwd: root, stdio: 'inherit', env });
if (res.status !== 0) process.exit(res.status ?? 1);

// Dump the data folder and list the documents the database references (in a child process, so the database
// module picks up this work folder).
fs.mkdirSync(path.dirname(outDb), { recursive: true });
const dump = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', `
  const db = await import(${JSON.stringify(new URL('../server/db.js', import.meta.url).href)});
  const keys = db.all('SELECT storage_key FROM attachments').map((r) => r.storage_key);
  db.dumpDatabase(${JSON.stringify(outDb)});
  db.closeDb();
  process.stdout.write(JSON.stringify(keys));
`], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (dump.status !== 0) {
  console.error(dump.stderr);
  process.exit(dump.status ?? 1);
}
const referenced = new Set(JSON.parse(dump.stdout.trim().split('\n').pop()));

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
const old = path.join(root, 'seed', 'veritek-seed.sqlite');
if (fs.existsSync(old)) fs.rmSync(old);
console.log(`Snapshot written to seed/veritek-demo.tar.gz (${(fs.statSync(outDb).size / 1024 / 1024).toFixed(1)} MB) and ${copied} document(s) to seed/files (${(bytes / 1024).toFixed(0)} KB)`);
