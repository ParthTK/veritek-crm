// People & access: an administrator's phone is the number the website's WhatsApp product finder recognises
// (it reads users.phone, role and active itself). The phone rules must match the website's, an administrator's
// phone must give a full number, other roles' phones are saved as typed, and the phone stays optional.
// Runs against a seeded database.
import { whatsappNumber, phoneParts, finderPhoneProblem } from '../shared/rules.js';
import { ROLES, PRODUCT_FINDER_ROLES } from '../shared/constants.js';

const BASE = process.env.API || 'http://localhost:4399/api';
let failures = 0;
let checks = 0;
const log = (ok, msg, extra = '') => {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${!ok && extra ? ` — ${extra}` : ''}`);
};

// ---------------------------------------------------------------- the website's rules
log(JSON.stringify(PRODUCT_FINDER_ROLES) === JSON.stringify(['super_admin', 'management']) && PRODUCT_FINDER_ROLES.every((r) => ROLES.some((x) => x.value === r)),
  'the product finder roles are exactly super_admin and management, both real roles');
const same = [
  ['+91 98200 11111', '919820011111'], ['98200 11111', '919820011111'], ['098200 11111', '919820011111'], ['0091 98200 11111', '919820011111'],
  ['+91-98200-11111 (WhatsApp)', '919820011111'], ['+971 50 123 4567', '971501234567'], ['2345 6789', ''], ['+1 234 567 8901 2345 6', ''], ['', ''],
];
const wrong = same.filter(([raw, want]) => whatsappNumber(raw) !== want);
log(!wrong.length, 'numbers are read as the website reads them: digits, 00 and a leading 0 dropped, ten digits are Indian, 11–15 digits',
  wrong.map(([raw, want]) => `${raw} → ${whatsappNumber(raw)} (want ${want})`).join('; '));
const parts = phoneParts('98200 11111 / +971 50 123 4567; 98200 22222 or 98200 33333, 98200 44444 OR 98200 55555');
log(parts.length === 6 && parts.every((p) => whatsappNumber(p)), 'one field holds several numbers, separated by , ; / or "or"', JSON.stringify(parts));
log(phoneParts('Works mobile: 98200 11111').length === 1, '"or" inside a word does not split a number');
log(finderPhoneProblem('+91 98200 11111') === null && finderPhoneProblem('98200 11111 / +971 50 123 4567') === null, 'full numbers pass');
log(Boolean(finderPhoneProblem('2345 678')) && Boolean(finderPhoneProblem('reception')), 'a short number or no number fails');
log(/“22222”/.test(finderPhoneProblem('+91 98200 11111 / 22222') || ''), 'a second number that is not full is named');

// ---------------------------------------------------------------- through Settings → People & access
const login = await (await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@veritek.example', password: 'Veritek@123' }) })).json();
if (!login.token) throw new Error(`login failed: ${login.error}`);
const call = async (path, method = 'GET', body) => {
  const headers = { authorization: `Bearer ${login.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const stamp = Date.now().toString().slice(-6);
const person = (key, role, phone) => ({ name: `Phone test ${key} ${stamp}`, role, department: 'management', email: `${key}.${stamp}@people-test.example`, password: `First-${stamp}x1`, phone });
const phoneError = (r) => r.status === 400 && r.data?.details?.fields?.phone;
const stored = async (id) => (await call('/admin/users')).data.find((u) => u.id === id);

const shortNumber = await call('/admin/users', 'POST', person('mgmt', 'management', '2345 678'));
log(phoneError(shortNumber), 'management with a phone that is not a full number is refused on the phone field', JSON.stringify(shortNumber.data));
log(/country code/.test(shortNumber.data?.details?.fields?.phone || ''), 'the message asks for the country code', shortNumber.data?.details?.fields?.phone);
const tooLong = await call('/admin/users', 'POST', person('long', 'super_admin', '+91 98200 11111 / +91 98200 22222 / +91 98200 33333'));
log(phoneError(tooLong), 'an administrator phone longer than is kept on creation is refused, not cut short', JSON.stringify(tooLong.data));
const mgmt = await call('/admin/users', 'POST', person('mgmt', 'management', '+91 98200 11111'));
log(mgmt.status === 201, 'management with a full number is created', JSON.stringify(mgmt.data));
log((await stored(mgmt.data?.id))?.phone === '+91 98200 11111', 'the phone is saved exactly as typed');
const noPhone = await call('/admin/users', 'POST', person('admin', 'super_admin', ''));
log(noPhone.status === 201, 'a super admin without a phone is still allowed (the phone is optional)', JSON.stringify(noPhone.data));

const badEdit = await call(`/admin/users/${mgmt.data?.id}`, 'PUT', { phone: 'ext. 23' });
log(phoneError(badEdit), 'editing an administrator to a number that is not full is refused', JSON.stringify(badEdit.data));
const twoNumbers = '98200 11111 / +971 50 123 4567';
const goodEdit = await call(`/admin/users/${mgmt.data?.id}`, 'PUT', { phone: twoNumbers });
log(goodEdit.status === 200 && (await stored(mgmt.data?.id))?.phone === twoNumbers, 'an administrator may give two full numbers in one field', JSON.stringify(goodEdit.data));
log((await call(`/admin/users/${mgmt.data?.id}`, 'PUT', { phone: '' })).status === 200 && (await stored(mgmt.data?.id))?.phone === null, 'an administrator\'s phone can be cleared');

const exec = await call('/admin/users', 'POST', person('exec', 'sales_executive', 'Reception, ext. 23'));
log(exec.status === 201 && (await stored(exec.data?.id))?.phone === 'Reception, ext. 23', 'other roles\' phones are not checked and are saved as typed', JSON.stringify(exec.data));
log(phoneError(await call(`/admin/users/${exec.data?.id}`, 'PUT', { role: 'management' })), 'promoting someone to management checks the phone they already have');
const promoted = await call(`/admin/users/${exec.data?.id}`, 'PUT', { role: 'management', phone: '0091 98200 55555' });
log(promoted.status === 200 && (await stored(exec.data?.id))?.role === 'management', 'promotion with a full number succeeds', JSON.stringify(promoted.data));

// active is the switch the website reads: 1 while they work here, 0 once deactivated.
await call(`/admin/users/${mgmt.data?.id}/deactivate`, 'POST', {});
const off = (await stored(mgmt.data?.id))?.active;
await call(`/admin/users/${mgmt.data?.id}/reactivate`, 'POST', {});
log(off === 0 && (await stored(mgmt.data?.id))?.active === 1, 'deactivation sets active to 0 and reactivation back to 1');

console.log(failures ? `\n${failures} OF ${checks} PEOPLE CHECKS FAILED` : `\nALL ${checks} PEOPLE CHECKS PASSED`);
process.exit(failures ? 1 : 0);
