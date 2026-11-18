// Clean installation (CRM_NO_DEMO=1): starts the server on an empty throwaway data folder and checks that
// it holds no demo records — only the reference set-up (regions, product models without prices, object
// categories, settings, dropdowns) and one administrator who must change the password at first sign-in.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veritek-clean-'));
const PORT = '4397';
const BASE = `http://localhost:${PORT}/api`;
const EMAIL = 'admin@clean-test.local';
const FIRST = `Tmp-${crypto.randomBytes(6).toString('hex')}1`;
const NEXT = `New-${crypto.randomBytes(6).toString('hex')}2`;

let checks = 0;
let failures = 0;
const log = (ok, msg, extra = '') => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${extra ? ` — ${extra}` : ''}`);
};

const env = { ...process.env, CRM_DATA_DIR: dataDir, PORT, CRM_NO_DEMO: '1', CRM_ADMIN_EMAIL: EMAIL, CRM_ADMIN_PASSWORD: FIRST, CRM_NO_SCHEDULER: '1' };
const server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'server/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (c) => { serverLog += c; });
server.stderr.on('data', (c) => { serverLog += c; });

const json = async (p, { method = 'GET', body, auth } = {}) => {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};

try {
  const started = Date.now();
  for (;;) {
    try {
      if ((await fetch(`${BASE}/auth/info`)).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - started > 20000) throw new Error('server did not start in time');
    await new Promise((r) => setTimeout(r, 250));
  }
  log(!/Restored the demo database/.test(serverLog), 'the demo snapshot is not restored');
  log(/clean installation/i.test(serverLog), 'the server set up a clean installation');
  log(!serverLog.includes(FIRST), 'a supplied administrator password is not written to the log');

  log((await json('/auth/info')).data?.demo === false, 'the sign-in page lists no demo accounts');
  log((await json('/auth/login', { method: 'POST', body: { email: 'admin@veritek.example', password: 'Veritek@123' } })).status >= 400, 'the demo administrator cannot sign in');
  const first = await json('/auth/login', { method: 'POST', body: { email: EMAIL, password: FIRST } });
  log(Boolean(first.data?.token), 'the first administrator signs in with the supplied password');
  log(first.data?.user?.must_change_password === true && first.data?.user?.role === 'super_admin', 'the first administrator is a super admin who must change the password');
  const changed = await json('/auth/password', { method: 'POST', auth: first.data?.token, body: { current: FIRST, next: NEXT } });
  log(Boolean(changed.data?.token) && changed.data?.user?.must_change_password === false, 'the password change clears the first-sign-in flag');
  const token = changed.data?.token;

  const products = (await json('/products', { auth: token })).data || [];
  log(products.length === 19 && products.every((p) => p.active), '19 active product models', `${products.length}`);
  const priced = products.filter((p) => ['standard_price_minor', 'dealer_price_minor', 'distributor_price_minor', 'min_price_minor', 'cost_price_minor', 'stock_qty'].some((k) => p[k] !== null && p[k] !== undefined));
  log(products.length > 0 && priced.length === 0, 'no product has a price, cost, minimum price or stock quantity', priced.map((p) => p.code).join(', '));
  log(products.every((p) => p.model && p.hsn && p.category_id), 'every product keeps its model, HSN code and category');
  const meta = (await json('/meta', { auth: token })).data || {};
  log(meta.regions?.length === 5 && meta.factories?.length === 0, 'five sales regions and no factories', `${meta.regions?.length} / ${meta.factories?.length}`);
  log(((await json('/object-categories', { auth: token })).data || []).length === 4, 'four starter object categories');
} catch (err) {
  log(false, err.message);
}

const stopped = new Promise((resolve) => server.once('exit', resolve));
server.kill();
await Promise.race([stopped, new Promise((r) => setTimeout(r, 3000))]);

// Every table outside the reference set-up must be empty (the server has stopped, so its embedded
// PostgreSQL data folder can be opened here).
try {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const pg = await PGlite.create(path.join(dataDir, 'pgdata'), { extensions: { citext }, parsers: { 20: Number } });
  const rowsOf = async (sql) => (await pg.query(sql)).rows;
  const one = async (sql) => Object.values((await rowsOf(sql))[0])[0];
  const db = { close: () => pg.close() };
  // audit_events and sessions hold this test's own sign-in and password change.
  const SETUP = new Set(['users', 'regions', 'product_categories', 'products', 'product_options', 'object_categories', 'settings', 'dropdown_options', 'schema_migrations', 'sessions', 'audit_events']);
  const tables = (await rowsOf("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename")).map((t) => t.tablename);
  const filled = [];
  for (const t of tables) {
    const n = await one(`SELECT COUNT(*) AS n FROM "${t}"`);
    if (n > 0) filled.push([t, n]);
  }
  const unexpected = filled.filter(([t]) => !SETUP.has(t));
  log(unexpected.length === 0, 'no demo records in any other table', unexpected.map(([t, n]) => `${t}: ${n}`).join(', '));
  log((await one('SELECT COUNT(*) AS n FROM users')) === 1, 'exactly one account');
  const actions = (await rowsOf('SELECT DISTINCT action FROM audit_events ORDER BY action')).map((a) => a.action).join(', ');
  log(actions === 'password_change, sign_in', 'the audit trail holds only this sign-in and password change', actions);
  log((await one('SELECT COUNT(*) AS n FROM product_options WHERE price_delta_minor <> 0 OR cost_delta_minor <> 0')) === 0, 'configurator options carry no price or cost changes');
  log(fs.readdirSync(path.join(dataDir, 'files')).length === 0, 'no documents in the file store');
  console.log(`(set-up tables in use: ${filled.map(([t, n]) => `${t} ${n}`).join(', ')})`);
  await db.close();
} catch (err) {
  log(false, `database check: ${err.message}`);
}

if (failures && serverLog.trim()) console.error(`\n--- server log ---\n${serverLog.replaceAll(FIRST, '[password]')}`);
try {
  fs.rmSync(dataDir, { recursive: true, force: true });
} catch {
  console.log(`(left the clean test database behind at ${dataDir})`);
}
console.log(failures ? `\n${failures} OF ${checks} CLEAN-INSTALLATION CHECKS FAILED` : `\nALL ${checks} CLEAN-INSTALLATION CHECKS PASSED`);
process.exit(failures ? 1 : 0);
