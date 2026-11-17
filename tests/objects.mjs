// Objects & QR module: walks the acceptance criteria — create, attach, generate, scan,
// replace, rename, restrict, import in bulk, restore a version, archive.
import { zipFiles } from '../server/lib/files.js';

const BASE = process.env.API || 'http://localhost:4399/api';

/** A minimal valid one-sheet .xlsx (uploads are content-checked, so a renamed PDF would be refused). */
function makeXlsx(rows) {
  const cell = (v, ref) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${String(v)}</t></is></c>`);
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, `${String.fromCharCode(65 + c)}${r + 1}`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return zipFiles([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Log" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}
let failures = 0;
const log = (ok, msg, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}${extra ? ` — ${extra}` : ''}`);
};

async function login(email) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Veritek@123' }) });
  const b = await r.json();
  if (!b.token) throw new Error(`login failed for ${email}: ${b.error}`);
  const call = async (path, opts = {}) => {
    const res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}`, ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data };
  };
  return { user: b.user, token: b.token, get: (p, o) => call(p, o), post: (p, body) => call(p, { method: 'POST', body }), put: (p, body) => call(p, { method: 'PUT', body }), del: (p) => call(p, { method: 'DELETE' }) };
}
const anon = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined, ...(opts.raw ? {} : {}) });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json().catch(() => null) : Buffer.from(await res.arrayBuffer()) };
};

/** A tiny but valid single-page PDF, so previews and downloads have something real to serve. */
function makePdf(text) {
  const content = `BT /F1 24 Tf 70 700 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/** Raw upload, as the browser sends it: the file is the body, its name travels in the query string. */
const upload = async (api, name, mime, buffer) => {
  const res = await fetch(`${BASE}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: `Bearer ${api.token}`, 'content-type': mime }, body: buffer });
  return res.json();
};

const admin = await login('admin@veritek.example');
const stamp = Date.now().toString().slice(-5);

// ---------------------------------------------------------------- 1. category template + object
const category = await admin.post('/object-categories', {
  name: `Machines ${stamp}`,
  description: 'Shop-floor equipment',
  field_template: [
    { label: 'Model number', type: 'text' },
    { label: 'Purchase date', type: 'date' },
    { label: 'Warranty expiry', type: 'date' },
    { label: 'Under AMC', type: 'checkbox' },
  ],
});
log(category.status === 201, 'create a category template with predefined fields', category.data?.error);

const created = await admin.post('/objects', {
  name: `APFC Panel ${stamp}`,
  description: 'Panel 3 in the press shop',
  category_id: category.data.id,
  location: 'Unit 1 · Press shop',
  owner_name: 'Maintenance',
  serial_number: `APFC-${stamp}`,
  visibility: 'public',
});
log(created.status === 201, 'create an object', created.data?.error);
const id = created.data.id;
let obj = (await admin.get(`/objects/${id}`)).data;
const publicId = obj.public_id;
log(/^[2-9A-HJ-NP-Z]{8}$/.test(publicId), 'public id uses an unambiguous alphabet', publicId);
log(obj.custom_fields.length === 4 && obj.custom_fields[0].label === 'Model number', 'category template seeded the custom fields');

// fill in field values + a dynamic extra field
await admin.put(`/objects/${id}`, {
  custom_fields: [
    ...obj.custom_fields.map((f) => ({ ...f, value: f.type === 'checkbox' ? true : f.type === 'date' ? '2026-04-01' : 'VT-APFC-100-TH' })),
    { label: 'Internal cost centre', type: 'text', value: 'CC-4420', public: false },
  ],
});
obj = (await admin.get(`/objects/${id}`)).data;
log(obj.custom_fields.length === 5, 'add an unlimited custom field on top of the template');

// ---------------------------------------------------------------- 2. documents
const pdfV1 = await upload(admin, 'manual.pdf', 'application/pdf', makePdf('Manual revision A'));
const manual = await admin.post(`/objects/${id}/files`, { attachment_id: pdfV1.id, title: 'Installation manual', description: 'Revision A' });
log(manual.status === 201, 'attach a PDF manual', manual.data?.error);
const sheet = await upload(admin, 'maintenance.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', makeXlsx([['Date', 'Work done', 'Engineer'], ['2026-04-01', 'Commissioning', 'Joseph'], ['2026-07-01', 'Quarterly check', 'Joseph']]));
await admin.post(`/objects/${id}/files`, { attachment_id: sheet.id, title: 'Maintenance log' });
const internal = await upload(admin, 'costing.pdf', 'application/pdf', makePdf('Internal costing'));
await admin.post(`/objects/${id}/files`, { attachment_id: internal.id, title: 'Internal costing', visibility: 'private' });
obj = (await admin.get(`/objects/${id}`)).data;
log(obj.files.length === 3, 'object holds three documents', `${obj.files.length}`);

// ---------------------------------------------------------------- 3. codes
const qr = await admin.post(`/objects/${id}/code`, { code_type: 'qr' });
log(qr.status === 201 && qr.data.permanent_url.endsWith(`/o/${publicId}`), 'generate a permanent QR code', qr.data.permanent_url);
const barcode = await admin.post(`/objects/${id}/code`, { code_type: 'barcode' });
log(barcode.data.payload === publicId, 'barcode encodes the stable object id');
const png = await admin.get(`/objects/${id}/code.png`);
log(png.status === 200 && png.data.subarray(1, 4).toString() === 'PNG', 'download the QR as PNG', `${png.data.length} bytes`);
const svg = await admin.get(`/objects/${id}/code.svg`);
log(svg.status === 200 && svg.data.toString().startsWith('<svg'), 'download the QR as SVG');
const again = await admin.post(`/objects/${id}/code`, { code_type: 'qr' });
log(again.data.id === qr.data.id && again.data.permanent_url === qr.data.permanent_url, 'asking again returns the same code, never a new one');

// ---------------------------------------------------------------- 4. public scan
const scan1 = await anon(`/public/objects/${publicId}`);
log(scan1.status === 200 && scan1.data.state === 'ok', 'scanning the code opens the object', scan1.data?.error);
log(scan1.data.object.files.length === 2, 'private document is hidden from the public page', `${scan1.data.object.files.length} public files`);
log(!JSON.stringify(scan1.data).includes('CC-4420'), 'field marked private is not exposed');
log(scan1.data.object.fields.some((f) => f.value === 'VT-APFC-100-TH'), 'public custom fields are shown');
const lower = await anon(`/public/objects/${publicId.toLowerCase()}`);
log(lower.data.state === 'ok', 'ids are case-insensitive when typed by hand');

const fileId = scan1.data.object.files[0].id;
const raw = await anon(`/public/objects/${publicId}/files/${fileId}/raw`);
log(raw.status === 200 && raw.data.subarray(0, 4).toString() === '%PDF', 'the PDF streams to the scanner');
log(raw.headers.get('content-disposition').startsWith('inline'), 'PDFs open inline rather than forcing a download');

// ---------------------------------------------------------------- 5. edit without regenerating
const pdfV2 = await upload(admin, 'manual-rev-b.pdf', 'application/pdf', makePdf('Manual revision B'));
const replaced = await admin.post(`/objects/${id}/files`, { attachment_id: pdfV2.id, replaces_id: manual.data.id, title: 'Installation manual' });
log(replaced.status === 201, 'replace the manual with a new revision', replaced.data?.error);
await admin.put(`/objects/${id}`, { name: `APFC Panel ${stamp} (renamed)` });
const after = (await admin.get(`/objects/${id}`)).data;
log(after.public_id === publicId, 'renaming and replacing files never changes the public id');
log(after.codes.find((c) => c.code_type === 'qr').permanent_url === qr.data.permanent_url, 'the printed QR still points at the same URL');
const scan2 = await anon(`/public/objects/${publicId}`);
const newFileId = scan2.data.object.files.find((f) => f.title === 'Installation manual').id;
const rawV2 = await anon(`/public/objects/${publicId}/files/${newFileId}/raw`);
log(rawV2.data.toString('latin1').includes('Manual revision B'), 'the original code now serves the updated document');
log(scan2.data.object.files.length === 2, 'the replaced version does not appear as a second document');

// ---------------------------------------------------------------- 6. version history
const versions = (await admin.get(`/objects/${id}`)).data.versions;
log(versions.length === 1 && versions[0].version_no === 1, 'the previous revision is kept in history');
const restore = await admin.post(`/objects/${id}/files/${versions[0].id}/restore`);
log(restore.status === 200, 'restore the earlier revision', restore.data?.error);
const scan3 = await anon(`/public/objects/${publicId}`);
const restoredId = scan3.data.object.files.find((f) => f.title === 'Installation manual').id;
const rawV3 = await anon(`/public/objects/${publicId}/files/${restoredId}/raw`);
log(rawV3.data.toString('latin1').includes('Manual revision A'), 'the restored revision is served, with the URL unchanged');

// ---------------------------------------------------------------- 7. visibility
await admin.put(`/objects/${id}`, { visibility: 'password', password: 'panel-2026' });
const locked = await anon(`/public/objects/${publicId}`);
log(locked.data.state === 'locked' && !locked.data.object, 'password-protected objects reveal nothing before unlocking');
const badFile = await anon(`/public/objects/${publicId}/files/${restoredId}/raw`);
log(badFile.status === 401, 'its documents cannot be fetched by guessing the URL');
const wrong = await anon(`/public/objects/${publicId}/unlock`, { method: 'POST', body: { password: 'nope' } });
log(wrong.status === 401, 'a wrong password is refused');
const unlocked = await anon(`/public/objects/${publicId}/unlock`, { method: 'POST', body: { password: 'panel-2026' } });
log(unlocked.status === 200 && unlocked.data.object.files.length === 2, 'the right password opens the object');
const withToken = await anon(`/public/objects/${publicId}/files/${restoredId}/raw?unlock=${encodeURIComponent(unlocked.data.unlock)}`);
log(withToken.status === 200, 'documents are reachable once unlocked');

await admin.put(`/objects/${id}`, { visibility: 'private' });
const priv = await anon(`/public/objects/${publicId}`);
log(priv.data.state === 'private' && !priv.data.object, 'private objects are never served publicly');
await admin.put(`/objects/${id}`, { visibility: 'public' });

// ---------------------------------------------------------------- 8. analytics
const stats = (await admin.get(`/objects/${id}`)).data.scans;
log(stats.total >= 5, 'scans are counted', `${stats.total} scans`);
log(stats.series.length === 30 && stats.today >= 5, 'daily series and today counts are available');
log(!JSON.stringify(stats).includes('user-agent'), 'analytics keeps no personal identifiers');

// ---------------------------------------------------------------- 9. duplication & archive
const dup = await admin.post(`/objects/${id}/duplicate`, {});
const dupObj = (await admin.get(`/objects/${dup.data.id}`)).data;
log(dupObj.public_id !== publicId && dupObj.files.length === 3 && !dupObj.codes.length,
  'duplicating copies all documents but issues a new identity and no code yet', `${dupObj.files.length} files, id ${dupObj.public_id}`);

await admin.post(`/objects/${id}/archive`, { archived: true, note: 'Machine decommissioned' });
const archived = await anon(`/public/objects/${publicId}`);
log(archived.data.state === 'archived' && archived.data.message === 'Machine decommissioned', 'archived objects show an explanation, not someone else’s data');
await admin.post(`/objects/${id}/archive`, { archived: false });

const unknown = await anon('/public/objects/ZZZZZZZZ');
log(unknown.status === 404 && unknown.data.state === 'unknown', 'an unissued code resolves to nothing, never to another object');

// ---------------------------------------------------------------- 10. bulk import
const rows = [['Asset name', 'Location', 'Serial', 'Voltage class']];
for (let i = 1; i <= 100; i++) rows.push([`Imported meter ${stamp}-${i}`, `Substation ${1 + (i % 7)}`, `SN-${stamp}-${i}`, i % 2 ? '415 V' : '11 kV']);
const csv = Buffer.from(rows.map((r2) => r2.join(',')).join('\n'));
const importFile = await upload(admin, 'objects.csv', 'text/csv', csv);
const preview = await admin.post('/objects/import/preview', { attachment_id: importFile.id });
log(preview.data.total === 100 && preview.data.header[0] === 'Asset name', 'import preview reads the spreadsheet', `${preview.data.total} rows`);
const imported = await admin.post('/objects/import', { attachment_id: importFile.id, mapping: { name: 0, location: 1, serial_number: 2 }, generate_codes: true });
log(imported.data.created.length === 100 && !imported.data.errors.length, 'import creates 100 objects', `${imported.data.errors.length} errors`);
const ids = new Set(imported.data.created.map((o) => o.public_id));
log(ids.size === 100, 'every imported object gets a unique code');
const firstImported = imported.data.created[0];
const importedScan = await anon(`/public/objects/${firstImported.public_id}`);
log(importedScan.data.state === 'ok' && importedScan.data.object.fields.some((f) => f.label === 'Voltage class'), 'unmapped columns become custom fields');

const zip = await admin.get(`/objects/codes.zip?ids=${imported.data.created.slice(0, 20).map((o) => o.id).join(',')}`);
log(zip.status === 200 && zip.data.subarray(0, 4).toString('hex') === '504b0304', 'bulk code download returns a ZIP', `${zip.data.length} bytes`);

// ---------------------------------------------------------------- 11. permissions
const viewer = await login('production@veritek.example');
const viewerRead = await viewer.get(`/objects/${id}`);
log(viewerRead.status === 200, 'staff can read objects');
const viewerDelete = await viewer.del(`/objects/${id}`);
log(viewerDelete.status === 403, 'only administrators can delete an object');
const noAuth = await anon(`/objects/${id}`);
log(noAuth.status === 401, 'the admin API stays closed to anonymous callers');

// ---------------------------------------------------------------- 12. deletion keeps the id retired
const victim = await admin.post('/objects', { name: `Temporary ${stamp}`, visibility: 'public' });
const victimId = (await admin.get(`/objects/${victim.data.id}`)).data.public_id;
await admin.del(`/objects/${victim.data.id}`);
const gone = await anon(`/public/objects/${victimId}`);
log(gone.status === 404, 'a deleted object stops resolving');
const reused = await admin.post('/objects', { name: `Another ${stamp}`, visibility: 'public' });
log((await admin.get(`/objects/${reused.data.id}`)).data.public_id !== victimId, 'its id is never handed to a new object');

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL OBJECT CHECKS PASSED');
process.exit(failures ? 1 : 0);
