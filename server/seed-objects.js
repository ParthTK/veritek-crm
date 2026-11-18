// Demo content for the Objects & QR module: equipment, products and documents with real attached files,
// permanent codes and a believable scan history. Files go through the normal private document storage.
import { get, insert, run } from './db.js';
import { nowIso, today, audit } from './util.js';
import { addDays } from '../shared/dates.js';
import { hashPassword } from './auth.js';
import { newPublicId, publicUrlFor } from './services/objects.js';
import { storeAttachment } from './services/attachments.js';
import { zipFiles } from './lib/codes.js';

export const DEMO_OBJECT_PASSWORD = 'veritek2026';
const BASE_URL = 'https://veritekcrm.vercel.app';

// ------------------------------------------------------------------ file builders
const esc = (s) => String(s).replace(/([()\\])/g, '\\$1');

/** A small, genuinely valid PDF so previews and downloads work in the demo. */
export function buildPdf(title, lines) {
  const body = [`BT /F1 18 Tf 60 780 Td (${esc(title)}) Tj ET`, ...lines.map((line, i) => `BT /F1 11 Tf 60 ${742 - i * 18} Td (${esc(line)}) Tj ET`)].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/** A minimal .xlsx (inline strings only) so the Excel preview has something real to render. */
export function buildXlsx(sheetName, rows) {
  const cell = (value, ref) => {
    const text = value === null || value === undefined ? '' : String(value);
    const numeric = text !== '' && !Number.isNaN(Number(text)) && !/^0\d/.test(text);
    return numeric
      ? `<c r="${ref}"><v>${text}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))}</t></is></c>`;
  };
  const col = (n) => String.fromCharCode(65 + n);
  const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, `${col(c)}${r + 1}`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return zipFiles([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

// ------------------------------------------------------------------ demo content
// The category templates are generic set-up, so a clean installation starts with them too.
const CATEGORIES = [
  {
    name: 'Machines & equipment', description: 'Anything on the shop floor or at a customer site',
    fields: [
      { label: 'Model number', type: 'text' }, { label: 'Serial number', type: 'text' }, { label: 'Commissioned on', type: 'date' }, { label: 'Warranty expiry', type: 'date' },
      { label: 'Service interval', type: 'dropdown', options: ['Monthly', 'Quarterly', 'Half-yearly', 'Annual'] }, { label: 'Under AMC', type: 'checkbox' },
    ],
  },
  {
    name: 'Finished products', description: 'Catalogue items shipped to customers',
    fields: [{ label: 'Model', type: 'text' }, { label: 'Specification', type: 'notes' }, { label: 'Product page', type: 'url' }, { label: 'Warranty (months)', type: 'number' }],
  },
  {
    name: 'Documents & certificates', description: 'Calibration certificates, test reports, approvals',
    fields: [{ label: 'Issued by', type: 'text' }, { label: 'Issue date', type: 'date' }, { label: 'Valid until', type: 'date' }, { label: 'Reference', type: 'text' }],
  },
  {
    name: 'Facilities & assets', description: 'Rooms, vehicles, tools, furniture',
    fields: [{ label: 'Asset tag', type: 'text' }, { label: 'Responsible person', type: 'text' }, { label: 'Purchase date', type: 'date' }, { label: 'Condition', type: 'dropdown', options: ['New', 'Good', 'Needs attention'] }],
  },
];

const fieldKey = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Creates the starter object categories (with their field templates). Returns name → id. */
export function seedObjectCategories(adminId) {
  const ids = {};
  for (const c of CATEGORIES) {
    ids[c.name] = insert('object_categories', {
      name: c.name, description: c.description,
      field_template: JSON.stringify(c.fields.map((f) => ({ key: fieldKey(f.label), ...f, public: true }))), created_by: adminId, created_at: nowIso(),
    });
  }
  return ids;
}

/** Seeds the object register. `users` are publicUser objects; `products` maps product code to id. */
export function seedObjects({ users, products, rand }) {
  const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const admin = users.admin;
  const categoryIds = seedObjectCategories(admin.id);
  const customerFor = (name) => get('SELECT id, company_name FROM customers WHERE company_name = ? AND merged_into_id IS NULL', name);
  const orderFor = (customerId) => get("SELECT id FROM orders WHERE customer_id = ? AND status = 'confirmed' ORDER BY received_date DESC LIMIT 1", customerId);

  const defs = [
    {
      name: 'Energy monitoring panel — Plant 2 incomer', category: 'Machines & equipment',
      description: 'Panel with eight VIPS 98EFR multifunction meters on the plant 2 incomer and feeders, reporting over RS-485.',
      location: 'Sahyadri Switchgear · Pune · Plant 2 LT room', owner: 'Maintenance', serial: 'EMP-2026-0114', product: 'VIPS 98EFR', customer: 'Sahyadri Switchgear',
      fields: { 'Model number': 'EMP-8F', 'Serial number': 'EMP-2026-0114', 'Commissioned on': addDays(today(), -210), 'Warranty expiry': addDays(today(), 155), 'Service interval': 'Quarterly', 'Under AMC': true },
      docs: [
        { title: 'Installation & operating manual', type: 'pdf', lines: ['8 × VIPS 98EFR multifunction meters, 400/5 A CTs', 'Enclosure: CRCA, IP42, wall mounted', 'Isolate the incomer before opening the door.', 'RS-485 daisy chain with 120 ohm termination at the last meter.'] },
        { title: 'Maintenance log', type: 'xlsx', sheet: 'Maintenance', rows: [['Date', 'Activity', 'Technician', 'Hours', 'Result'], [addDays(today(), -180), 'Commissioning and FAT', 'Deepak Kumar', 6, 'Passed'], [addDays(today(), -90), 'Quarterly inspection', 'Sandeep More', 2, 'Passed'], [addDays(today(), -8), 'CT terminal re-torque', 'Deepak Kumar', 3, 'Feeder 6 CT terminal tightened']] },
        { title: 'Test certificate', type: 'pdf', lines: ['Routine tests as per IS/IEC 61439-1', 'Insulation resistance: 520 MOhm at 500 V DC', 'HV withstand: 2.5 kV for 60 s - passed', 'Witnessed by: Meena Joshi, QC'] },
        { title: 'Internal costing sheet', type: 'pdf', private: true, lines: ['Material cost: as per BOM rev 4', 'Not for customer circulation.'] },
      ],
      scans: 46,
    },
    {
      name: 'Tenant metering panel — Tower B', category: 'Machines & equipment',
      description: '24-way tenant metering panel with VIPS 96MF meters and a Modbus TCP gateway.',
      location: 'Metro Controls · Bengaluru · Tower B basement', owner: 'Facilities', serial: 'TMP-2026-0067', product: 'VIPS 96MF', customer: 'Metro Controls',
      fields: { 'Model number': 'TMP-24', 'Serial number': 'TMP-2026-0067', 'Commissioned on': addDays(today(), -120), 'Warranty expiry': addDays(today(), 245), 'Service interval': 'Half-yearly', 'Under AMC': false },
      docs: [
        { title: 'Meter schedule by tenant', type: 'xlsx', sheet: 'Meters', rows: [['Meter', 'Tenant', 'Floor', 'CT ratio', 'Commissioned'], ...Array.from({ length: 12 }, (_, i) => [`96MF-${100 + i}`, `Tenant ${String.fromCharCode(65 + i)}`, `${1 + (i % 6)}`, '200/5', addDays(today(), -120)])] },
        { title: 'Wiring diagram', type: 'pdf', lines: ['Single line diagram, incomer to 24 feeders', 'Modbus TCP gateway in the top section', 'CT polarity: P1 towards the supply'] },
        { title: 'Commissioning report', type: 'pdf', lines: ['All 24 meters communicating', 'CT polarity verified on every feeder', 'Handover completed 16 weeks ago'] },
      ],
      scans: 31,
    },
    {
      name: 'VIPS 98EFR Multifunction Power Meter', category: 'Finished products',
      description: 'Panel-mount multifunction power meter with RS-485 Modbus RTU. Product information for anyone holding the unit.',
      location: 'Catalogue item', owner: 'Product management', product: 'VIPS 98EFR',
      fields: { Model: 'VIPS 98EFR', Specification: 'Class 0.5S · 63 parameters · 96×96 mm · RS-485 Modbus RTU · 90–270 V AC auxiliary', 'Product page': 'https://www.veritekindia.com/products.html', 'Warranty (months)': 24 },
      docs: [
        { title: 'Product datasheet', type: 'pdf', lines: ['Accuracy class 0.5S for active energy', 'Measures 63 electrical parameters', 'Communication: RS-485, Modbus RTU, up to 38400 baud', 'Dimensions: 96 x 96 x 60 mm, panel cut-out 92 x 92 mm'] },
        { title: 'Installation guide', type: 'pdf', lines: ['Use x/5 A CTs on all three phases', 'Observe CT polarity (P1 to P2 towards the load)', 'Set the CT ratio in the SETUP menu before use'] },
        { title: 'Modbus register map', type: 'xlsx', sheet: 'Registers', rows: [['Register', 'Parameter', 'Unit', 'Type'], ['30001', 'Voltage L1-N', 'V', 'float'], ['30003', 'Voltage L2-N', 'V', 'float'], ['30005', 'Voltage L3-N', 'V', 'float'], ['30013', 'Current L1', 'A', 'float'], ['30025', 'Active power total', 'kW', 'float'], ['30053', 'Energy import', 'kWh', 'float'], ['30061', 'Power factor', '-', 'float']] },
      ],
      scans: 88,
    },
    {
      name: 'Calibration certificate — Reference meter RM-04', category: 'Documents & certificates',
      description: 'NABL calibration certificate for the reference standard used on the test bench.', location: 'Unit 1 · Test bench', owner: 'Quality',
      fields: { 'Issued by': 'National Test House, Mumbai', 'Issue date': addDays(today(), -75), 'Valid until': addDays(today(), 290), Reference: 'NTH/CAL/2026/4471' },
      docs: [{ title: 'Calibration certificate', type: 'pdf', lines: ['Reference standard: RM-04, class 0.05', 'Calibrated at 230 V, 5 A, PF 1.0 and 0.5L', 'Maximum deviation observed: 0.018%', 'Certificate valid for 12 months from the issue date'] }],
      scans: 12, single: true,
    },
    {
      name: 'Meter test bench TB-02', category: 'Machines & equipment',
      description: 'Three-position test bench used for final calibration of panel and multifunction meters.', location: 'Unit 1 · Vasai · QC lab', owner: 'Quality', serial: 'TB-02',
      fields: { 'Model number': 'TB-3P', 'Serial number': 'TB-02', 'Commissioned on': addDays(today(), -540), 'Warranty expiry': addDays(today(), -175), 'Service interval': 'Monthly', 'Under AMC': true },
      docs: [
        { title: 'Operating procedure', type: 'pdf', lines: ['Warm up the reference standard for 30 minutes', 'Run the 5-point calibration for every meter', 'Record results in the QC log before packing'] },
        { title: 'Monthly verification log', type: 'xlsx', sheet: 'Verification', rows: [['Date', 'Position 1 error %', 'Position 2 error %', 'Position 3 error %', 'Remarks'], [addDays(today(), -50), 0.02, 0.03, 0.02, 'Normal'], [addDays(today(), -20), 0.02, 0.02, 0.04, 'Normal'], [addDays(today(), -2), 0.03, 0.02, 0.06, 'Position 3 drifting — recheck']] },
      ],
      scans: 24,
    },
    {
      name: 'Forklift FL-02 — service record', category: 'Facilities & assets',
      description: '2.5 tonne diesel forklift used in the dispatch bay.', location: 'Unit 1 · Dispatch bay', owner: 'Stores',
      fields: { 'Asset tag': 'VT-FL-02', 'Responsible person': 'Imran Shaikh', 'Purchase date': addDays(today(), -690), Condition: 'Good' },
      docs: [{ title: 'Service history', type: 'xlsx', sheet: 'Services', rows: [['Date', 'Service', 'Vendor', 'Cost'], [addDays(today(), -300), '500 hour service', 'Vasai Forklift Services', 14500], [addDays(today(), -120), 'Hydraulic hose replacement', 'Vasai Forklift Services', 8200], [addDays(today(), -15), '1000 hour service', 'Vasai Forklift Services', 19800]] }],
      scans: 9,
    },
    {
      name: 'VIPS MOD-485 communication module — setup', category: 'Finished products',
      description: 'Setup instructions and firmware notes for the RS-485 communication module.', owner: 'Product management', product: 'VIPS MOD-485',
      fields: { Model: 'VIPS MOD-485', Specification: 'Plug-in RS-485 module · Modbus RTU · isolated port', 'Product page': 'https://www.veritekindia.com/products.html', 'Warranty (months)': 18 },
      docs: [
        { title: 'Quick start guide', type: 'pdf', lines: ['1. Switch the meter off and plug the module in', '2. Set the address and baud rate in the COMM menu', '3. Terminate the last device on the bus with 120 ohm', '4. Poll register 30001 to confirm communication'] },
        { title: 'Firmware release notes 2.4', type: 'pdf', lines: ['Fixes the address reset seen on 2.3', 'Adds 38400 baud support', 'Recommended for every module in the field'] },
      ],
      scans: 63,
    },
    {
      name: 'Assembly line — tooling cabinet 3', category: 'Facilities & assets',
      description: 'Torque screwdrivers and crimping tools. Scan for the calibration status of each tool.', location: 'Unit 2 · Nashik · Assembly', owner: 'Production',
      fields: { 'Asset tag': 'VT-TOOL-03', 'Responsible person': 'Ramesh Kulkarni', 'Purchase date': addDays(today(), -430), Condition: 'Good' },
      docs: [{ title: 'Tool calibration status', type: 'xlsx', sheet: 'Tools', rows: [['Tool', 'ID', 'Last calibrated', 'Due', 'Status'], ['Torque screwdriver 0.5-2 Nm', 'TS-11', addDays(today(), -160), addDays(today(), 205), 'OK'], ['Torque screwdriver 2-5 Nm', 'TS-12', addDays(today(), -350), addDays(today(), 15), 'Due soon'], ['Crimping tool', 'CR-04', addDays(today(), -200), addDays(today(), 165), 'OK']] }],
      scans: 17,
    },
  ];

  const store = (name, buffer, objectId) => storeAttachment({ buffer, name, entityType: 'object', entityId: objectId }, admin).id;
  const codesFor = (id, createdAt, both) => {
    const publicId = get('SELECT public_id FROM objects WHERE id = ?', id).public_id;
    const url = publicUrlFor(publicId, BASE_URL);
    insert('object_codes', { object_id: id, code_type: 'qr', permanent_url: url, payload: url, created_by: admin.id, created_at: createdAt });
    if (both) insert('object_codes', { object_id: id, code_type: 'barcode', permanent_url: url, payload: publicId, created_by: admin.id, created_at: createdAt });
  };

  let created = 0;
  for (const def of defs) {
    const createdAt = `${addDays(today(), -ri(40, 220))}T10:00:00.000Z`;
    const template = CATEGORIES.find((c) => c.name === def.category).fields;
    const customFields = template.map((f) => ({ key: fieldKey(f.label), label: f.label, type: f.type, options: f.options, value: def.fields[f.label] ?? (f.type === 'checkbox' ? false : ''), public: true }));
    const customer = def.customer ? customerFor(def.customer) : null;
    const id = insert('objects', {
      public_id: newPublicId(), name: def.name, description: def.description, category_id: categoryIds[def.category], location: def.location, owner_name: def.owner,
      serial_number: def.serial, visibility: 'public', custom_fields: JSON.stringify(customFields), single_file_direct: def.single ? 1 : 0, show_updated: 1, status: 'active',
      customer_id: customer?.id ?? null, product_id: def.product ? products[def.product] ?? null : null, order_id: customer ? orderFor(customer.id)?.id ?? null : null,
      created_by: admin.id, created_at: createdAt, updated_at: `${addDays(today(), -ri(1, 30))}T11:00:00.000Z`,
    });
    def.docs.forEach((doc, index) => {
      const buffer = doc.type === 'xlsx' ? buildXlsx(doc.sheet, doc.rows.map((row) => row.map((cell) => String(cell)))) : buildPdf(doc.title, doc.lines);
      const attachmentId = store(`${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.${doc.type}`, buffer, id);
      insert('object_files', {
        object_id: id, attachment_id: attachmentId, title: doc.title, description: doc.description ?? null, visibility: doc.private ? 'private' : 'public',
        sort_order: index, version_group: index + 1, version_no: 1, is_current: 1, uploaded_by: admin.id, uploaded_at: createdAt,
      });
    });
    codesFor(id, createdAt, rand() < 0.5);
    // Scan history, weighted towards recent days and mobile devices (no personal identifiers).
    let total = 0;
    for (let d = 29; d >= 0; d--) {
      const likelihood = (30 - d) / 30;
      const count = rand() < likelihood * 0.55 ? ri(1, Math.max(1, Math.round(def.scans / 12))) : 0;
      for (let n = 0; n < count && total < def.scans; n++) {
        total++;
        insert('scan_events', {
          object_id: id, scanned_at: `${addDays(today(), -d)}T${String(ri(3, 13)).padStart(2, '0')}:${String(ri(0, 59)).padStart(2, '0')}:00.000Z`,
          device_type: rand() < 0.78 ? 'mobile' : rand() < 0.5 ? 'tablet' : 'desktop', approximate_location: pick(['Pune, IN', 'Mumbai, IN', 'Bengaluru, IN', 'Nashik, IN', 'Dubai, AE', null]), source: 'qr',
        });
      }
    }
    run('UPDATE objects SET scan_count = ?, last_scanned_at = (SELECT MAX(scanned_at) FROM scan_events WHERE object_id = ?) WHERE id = ?', total, id, id);
    audit('object', id, 'create', { name: def.name });
    created++;
  }

  // One archived object: retired codes explain themselves instead of returning "not found".
  const archivedAt = `${addDays(today(), -400)}T09:00:00.000Z`;
  const archivedId = insert('objects', {
    public_id: newPublicId(), name: 'Air compressor AC-01 (replaced)', description: 'Replaced by AC-03 in the utility room.', category_id: categoryIds['Facilities & assets'],
    location: 'Unit 1 · Utility room', owner_name: 'Maintenance', visibility: 'public', custom_fields: '[]', status: 'archived', archived_at: `${addDays(today(), -24)}T09:00:00.000Z`,
    archive_note: 'This compressor was decommissioned. Scan the label on AC-03 for the current machine.', created_by: admin.id, created_at: archivedAt, updated_at: `${addDays(today(), -24)}T09:00:00.000Z`,
  });
  codesFor(archivedId, archivedAt, false);

  // One password-protected object.
  const privateId = insert('objects', {
    public_id: newPublicId(), name: 'Tender pricing pack — municipal water works', description: 'Commercial pack shared with the consultant. Ask the sales owner for the password.',
    category_id: categoryIds['Documents & certificates'], owner_name: 'Sales', visibility: 'password', password_hash: hashPassword(DEMO_OBJECT_PASSWORD), custom_fields: '[]', status: 'active',
    created_by: admin.id, created_at: `${addDays(today(), -30)}T09:00:00.000Z`, updated_at: `${addDays(today(), -12)}T09:00:00.000Z`,
  });
  const pack = store('tender-pricing-pack.pdf', buildPdf('Tender pricing pack', ['Confidential - shared with the consultant only', 'Item rates as per tender schedule B', 'Validity: 90 days from submission']), privateId);
  insert('object_files', { object_id: privateId, attachment_id: pack, title: 'Pricing pack', visibility: 'public', sort_order: 0, version_group: 1, version_no: 1, is_current: 1, uploaded_by: admin.id, uploaded_at: nowIso() });
  codesFor(privateId, nowIso(), false);
  return { objects: created + 2, categories: Object.keys(categoryIds).length, passwordObjectId: privateId };
}
