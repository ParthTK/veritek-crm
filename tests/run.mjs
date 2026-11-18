// Fills a throwaway database with the tests' sample data (tests/sample-data.mjs), starts the API on a spare port
// and runs the acceptance journey, the Objects & QR suite, the flow and people suites and a read-only sweep of
// every endpoint against it, then checks a clean installation. The real database is never touched, and the
// throwaway folder is deleted at the end.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veritek-test-'));
const env = { ...process.env, CRM_DATA_DIR: dataDir, PORT: '4399' };

const run = (args, opts = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', ...args], { cwd: root, env, stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  let out = '';
  p.stdout?.on('data', (c) => { out += c; });
  p.stderr?.on('data', (c) => { out += c; });
  p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${args[0]} exited with ${code}\n${out}`))));
});

async function waitForServer(url, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}

console.log(`Building the sample test data in ${dataDir} …`);
await run(['tests/sample-data.mjs'], { quiet: true });

const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

let code = 1;
try {
  await waitForServer('http://localhost:4399/api/auth/me');
  await run(['tests/journey.mjs'], { quiet: false });
  await run(['tests/objects.mjs'], { quiet: false });
  await run(['tests/flow.mjs'], { quiet: false });
  await run(['tests/people.mjs'], { quiet: false });
  await run(['tests/sweep.mjs'], { quiet: false });
  await run(['tests/baseline.mjs'], { quiet: false }); // its own server and data folder
  code = 0;
} catch (err) {
  console.error(`\n${err.message}`);
  if (serverLog.trim()) console.error(`\n--- server log ---\n${serverLog}`);
} finally {
  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await Promise.race([stopped, new Promise((r) => setTimeout(r, 3000))]);
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    console.log(`(left the test database behind at ${dataDir})`);
  }
}
process.exit(code);
