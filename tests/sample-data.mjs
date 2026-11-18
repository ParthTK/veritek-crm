// Sample data for the automatic tests only — never part of the app or of a real installation. `npm test`
// builds it in a throwaway folder and deletes it afterwards. It replays ~18 months of business through the real
// services with a pinned clock, so every enquiry, quotation revision, production update, date revision,
// dispatch and follow-up is internally consistent — produced by the same code paths a user would take. The
// final weeks are staged to show the situations in the specification's reference screens (all fictional).
import { fileURLToPath } from 'node:url';
import { all, get, run, insert, update, tx, migrate, closeDb, DB_PATH } from '../server/db.js';
import {
  setClock, now, withContext, setSetting, resetSettingsCache, resetDropdownCache, settings, nextCode, setCounter, today, installSecret,
} from '../server/util.js';
import { hashPassword, publicUser } from '../server/auth.js';
import { ensureDropdownDefaults, deactivateUser } from '../server/services/admin.js';
import { createCustomer, mergeCustomers, setDoNotContact, addContact } from '../server/services/customers.js';
import { createEnquiry, changeStage, setLineOutcome } from '../server/services/enquiries.js';
import { completeTask, rescheduleTask, recordActivity, createTask } from '../server/services/tasks.js';
import {
  createQuotation, issueRevision, recordOutcome, newRevision, updateDraft, convertToOrder, submitForApproval, decideApproval,
} from '../server/services/quotes.js';
import {
  createOrder, quickUpdate, recordCommunication, postDispatch, recordDispatchNotice, cancelQuantity, reverseDispatch, setCommitment,
} from '../server/services/orders.js';
import { recordUpdate, openLinkedEnquiry, closeCase } from '../server/services/reactivation.js';
import { createInvoice, recordReceipt, setPromise, placeHold, setFinanceAsOf, recordAdvance } from '../server/services/finance.js';
import { saveCampaign } from '../server/services/campaigns.js';
import { saveTargets } from '../server/services/team.js';
import { addDocument } from '../server/services/products.js';
import { createComplaint, updateComplaint } from '../server/services/complaints.js';
import { storeAttachment } from '../server/services/attachments.js';
import { storeUpload, commitImport } from '../server/services/imports.js';
import { runEvaluator } from '../server/services/alerts.js';
import { REGIONS, FAMILIES, CATALOGUE } from '../server/setup.js';
import {
  addDays, addWorkingDays, onOrNextWorkingDay, isWorkingDay, localDate, zonedToUtc, zonedParts,
} from '../shared/dates.js';
import { seedObjects } from './sample-objects.mjs';

// Every sample account signs in with this password (the tests use it).
export const SAMPLE_PASSWORD = 'Veritek@123';
const TZ = 'Asia/Kolkata';

// ------------------------------------------------------------------ deterministic randomness
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(20261117);
const chance = (p) => rnd() < p;
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let x = rnd() * total;
  for (const [v, w] of pairs) {
    x -= w;
    if (x <= 0) return v;
  }
  return pairs[0][0];
};

// ------------------------------------------------------------------ min-heap event queue
class Heap {
  constructor() {
    this.a = [];
    this.seq = 0;
  }

  push(t, fn) {
    const node = { t, s: this.seq++, fn };
    const a = this.a;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t < node.t || (a[p].t === node.t && a[p].s < node.s)) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = node;
  }

  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const less = (x, y) => x.t < y.t || (x.t === y.t && x.s < y.s);
        if (l < a.length && less(a[l], m === i ? last : a[m])) m = l;
        if (r < a.length && less(a[r], m === i ? last : a[m])) m = r;
        if (m === i) break;
        a[i] = a[m];
        i = m;
      }
      a[i] = last;
    }
    return top;
  }

  get size() {
    return this.a.length;
  }
}

// ------------------------------------------------------------------ master data
// One sample sign-in per role (password SAMPLE_PASSWORD); Suresh is a named owner who does not sign in.
const PEOPLE = [
  { key: 'admin', name: 'Anita Rao', email: 'admin@veritek.example', role: 'super_admin', department: 'management', designation: 'Director' },
  { key: 'md', name: 'Vikram Shah', email: 'md@veritek.example', role: 'management', department: 'management', designation: 'Managing Director' },
  { key: 'board', name: 'Raghav Menon', email: 'viewer@veritek.example', role: 'viewer', department: 'management', designation: 'Board member (read-only)' },
  { key: 'coord', name: 'Priya Nair', email: 'coordinator@veritek.example', role: 'coordinator', department: 'coordination', designation: 'Sales & order coordinator' },
  { key: 'head', name: 'Sanjay Kapoor', email: 'saleshead@veritek.example', role: 'sales_head', department: 'sales', designation: 'Head — Sales & Export' },
  { key: 'arjun', name: 'Arjun Patel', email: 'rsm.west@veritek.example', role: 'regional_manager', department: 'sales', designation: 'Regional Sales Manager — West', region: 'West' },
  { key: 'saurav', name: 'Saurav Mehta', email: 'saurav@veritek.example', role: 'sales_executive', department: 'sales', designation: 'Sales Engineer', region: 'West' },
  { key: 'kavya', name: 'Kavya Iyer', email: 'kavya@veritek.example', role: 'sales_executive', department: 'export', designation: 'Export Manager', region: 'Export' },
  { key: 'rahul', name: 'Rahul Verma', email: 'rahul@veritek.example', role: 'sales_executive', department: 'sales', designation: 'Sales Engineer', region: 'South' },
  { key: 'farida', name: 'Farida Khan', email: 'commercial@veritek.example', role: 'commercial', department: 'commercial', designation: 'Commercial Executive' },
  { key: 'ramesh', name: 'Ramesh Kulkarni', email: 'production@veritek.example', role: 'production', department: 'production', designation: 'Production Head', factory: 'Unit 1 — Vasai' },
  { key: 'meena', name: 'Meena Joshi', email: 'quality@veritek.example', role: 'quality', department: 'qc', designation: 'QC In-charge', factory: 'Unit 1 — Vasai' },
  { key: 'imran', name: 'Imran Shaikh', email: 'dispatch@veritek.example', role: 'dispatch', department: 'dispatch', designation: 'Dispatch Supervisor' },
  { key: 'suresh', name: 'Suresh Pillai', email: null, role: 'staff', department: 'purchase', designation: 'Purchase Officer' },
  { key: 'neha', name: 'Neha Gupta', email: 'accounts@veritek.example', role: 'accounts', department: 'accounts', designation: 'Accounts Manager' },
  { key: 'joseph', name: 'Joseph D\'Souza', email: 'service@veritek.example', role: 'service', department: 'service', designation: 'Service Engineer' },
];

const FACTORIES = [['Unit 1 — Vasai', 'Vasai (E), Palghar'], ['Unit 2 — Nashik', 'Ambad MIDC, Nashik']];

// Sample prices (INR), for the test data only: [standard price, { option: [price change, cost change] }]. Dealer /
// distributor / minimum / cost prices are derived from the standard price.
const SAMPLE_PRICES = {
  'VIPS 70L': [1450, { 'Green LED': [60, 30], '24 V DC': [120, 70] }],
  'VIPS 83P': [2350, { '2 relay outputs': [420, 240], '4–20 mA retransmission': [560, 310] }],
  'VIPS 44D': [1900],
  'VIPS 98EFR': [7800, { 'Modbus TCP (Ethernet)': [1650, 980], 'Class 1.0': [-400, -260], 'Class 0.2S': [1450, 870] }],
  'VIPS 96MF': [6400, { '24–60 V DC': [350, 210] }],
  'VIPS EM3': [4200], 'VIPS EM1': [1350], 'CT 100/5A': [520], 'CT 200/5A': [610], 'CT 400/5A': [780, { 'Class 0.5': [140, 80] }],
  'CT 800/5A': [1150], 'VIPS PT-110': [2900], 'VIPS MOD-485': [1250], 'VIPS DSP-7': [640], 'VIPS 83M': [3200],
  'VIPS 99MF': [980], 'VIPS 99SD': [760], 'VIPS 2424': [890], 'VIPS 24120': [2150],
};
// The real product catalogue with those prices: [code, name, family, standard price, details], options as
// [group, choice, price change, cost change, extra lead days]. The first 13 are the ones the simulation trades in.
const PRODUCTS = CATALOGUE.map(([code, name, family, d]) => {
  const [price, options = {}] = SAMPLE_PRICES[code] || [1000];
  return [code, name, family, price, { ...d, options: d.options?.map(([group, choice, lead]) => [group, choice, ...(options[choice] || [0, 0]), lead]) }];
});

// Indian cities to states (regions come from the state list on each region).
const CITY_STATE = {
  Pune: 'Maharashtra', Mumbai: 'Maharashtra', Nashik: 'Maharashtra', Kolhapur: 'Maharashtra', Ratnagiri: 'Maharashtra', Ahmedabad: 'Gujarat', Vadodara: 'Gujarat',
  Rajkot: 'Gujarat', Surat: 'Gujarat', Indore: 'Madhya Pradesh', Jabalpur: 'Madhya Pradesh', Chennai: 'Tamil Nadu', Coimbatore: 'Tamil Nadu', Bengaluru: 'Karnataka',
  Hyderabad: 'Telangana', Kochi: 'Kerala', Rajahmundry: 'Andhra Pradesh', Ludhiana: 'Punjab', Delhi: 'Delhi', Jaipur: 'Rajasthan', Kolkata: 'West Bengal',
};
const STATE_CODE = { Maharashtra: '27', Gujarat: '24', 'Madhya Pradesh': '23', 'Tamil Nadu': '33', Karnataka: '29', Telangana: '36', Kerala: '32', 'Andhra Pradesh': '37', Punjab: '03', Delhi: '07', Rajasthan: '08', 'West Bengal': '19' };

const CAMPAIGNS = [
  { key: 'elecrama', name: 'ELECRAMA 2025 — Greater Noida', type: 'exhibition', location: 'India Expo Centre, Greater Noida', offset: 64, days: 5, cost: 650000, target: 120, stall: 'Hall 4 · H4-B21', segment: 'domestic' },
  { key: 'mee', name: 'Middle East Energy 2026 — Dubai', type: 'exhibition', location: 'Dubai World Trade Centre', offset: 300, days: 3, cost: 980000, target: 60, stall: 'S2-E14', segment: 'export' },
  { key: 'autoexpo', name: 'Automation Expo — Mumbai', type: 'exhibition', location: 'Bombay Exhibition Centre, Goregaon', offset: 566, days: 4, cost: 420000, target: 80, stall: 'Hall 2 · B-44', segment: 'domestic' },
  { key: 'meet', name: 'Panel builders meet — Pune', type: 'dealer_meet', location: 'Hotel Hyatt, Pune', offset: 452, days: 1, cost: 120000, target: 40, segment: 'domestic' },
];

// [name, country, city, types, owner, pattern]; patterns: regular, occasional, dormant, lost, new, quiet
const CUSTOMERS = [
  ['Gulf Panel Co.', 'AE', 'Sharjah', ['oem'], 'kavya', 'regular'],
  ['Orion Controls', 'IN', 'Pune', ['manufacturer'], 'saurav', 'dormant'],
  ['Delta Electrical', 'IN', 'Ahmedabad', ['dealer'], 'arjun', 'lost'],
  ['Nova Panels', 'IN', 'Chennai', ['oem'], 'saurav', 'lost'],
  ['Apex Panels', 'IN', 'Mumbai', ['oem'], 'saurav', 'regular'],
  ['Metro Controls', 'IN', 'Bengaluru', ['manufacturer'], 'arjun', 'regular'],
  ['Sahyadri Switchgear', 'IN', 'Pune', ['oem'], 'saurav', 'regular'],
  ['Shakti Power Systems', 'IN', 'Nashik', ['manufacturer'], 'arjun', 'occasional'],
  ['Kaveri Electricals', 'IN', 'Coimbatore', ['dealer'], 'rahul', 'occasional'],
  ['Vardhman Panel Works', 'IN', 'Ludhiana', ['oem'], 'arjun', 'dormant'],
  ['Indus Automation', 'IN', 'Vadodara', ['manufacturer'], 'saurav', 'regular'],
  ['Sunrise Electro Controls', 'IN', 'Hyderabad', ['oem'], 'arjun', 'occasional'],
  ['Precision Panels & Controls', 'IN', 'Rajkot', ['oem'], 'saurav', 'dormant'],
  ['Arihant Switchboards', 'IN', 'Indore', ['dealer'], 'rahul', 'occasional'],
  ['Bharat Electro Systems', 'IN', 'Delhi', ['distributor'], 'arjun', 'regular'],
  ['Coastal Power Solutions', 'IN', 'Kochi', ['end_user'], 'saurav', 'lost'],
  ['Neelkanth Electricals', 'IN', 'Jaipur', ['dealer'], 'arjun', 'dormant'],
  ['Om Sai Panel Industries', 'IN', 'Nashik', ['oem'], 'saurav', 'occasional'],
  ['Unique Controls', 'IN', 'Kolkata', ['manufacturer'], 'arjun', 'lost'],
  ['Techno Power Engineers', 'IN', 'Chennai', ['oem'], 'rahul', 'dormant'],
  ['Eastern Switchgear', 'IN', 'Kolkata', ['oem'], 'arjun', 'regular'],
  ['Western Panel Builders', 'IN', 'Mumbai', ['oem'], 'saurav', 'new'],
  ['Rajdhani Power Controls', 'IN', 'Delhi', ['manufacturer'], 'arjun', 'new'],
  ['Agni Electro Works', 'IN', 'Hyderabad', ['oem'], 'saurav', 'quiet'],
  ['Mahalaxmi Switchgear', 'IN', 'Kolhapur', ['dealer'], 'arjun', 'occasional'],
  ['Al Noor Electromechanical', 'AE', 'Dubai', ['oem'], 'kavya', 'regular'],
  ['Emirates Switchgear LLC', 'AE', 'Abu Dhabi', ['manufacturer'], 'kavya', 'occasional'],
  ['Riyadh Power Panels', 'SA', 'Riyadh', ['oem'], 'kavya', 'regular'],
  ['Dammam Electrical Industries', 'SA', 'Dammam', ['manufacturer'], 'kavya', 'dormant'],
  ['Muscat Controls', 'OM', 'Muscat', ['oem'], 'kavya', 'occasional'],
  ['Doha Electro Panels', 'QA', 'Doha', ['oem'], 'kavya', 'lost'],
  ['Savannah Power Ltd', 'KE', 'Nairobi', ['distributor'], 'kavya', 'occasional'],
  ['Lagos Switchboards Ltd', 'NG', 'Lagos', ['oem'], 'kavya', 'dormant'],
  ['Dhaka Power Engineering', 'BD', 'Dhaka', ['manufacturer'], 'kavya', 'regular'],
  ['Lanka Electro Systems', 'LK', 'Colombo', ['distributor'], 'kavya', 'lost'],
  ['Himalaya Electricals', 'NP', 'Kathmandu', ['dealer'], 'kavya', 'new'],
  ['Nile Panel Industries', 'EG', 'Cairo', ['oem'], 'kavya', 'dormant'],
  ['Kilimanjaro Electricals', 'TZ', 'Dar es Salaam', ['distributor'], 'kavya', 'quiet'],
];

const FIRST = ['Rajesh', 'Amit', 'Sunita', 'Vivek', 'Deepa', 'Manoj', 'Kiran', 'Farhan', 'Ahmed', 'Rashid', 'Omar', 'Grace', 'Peter', 'Nimal', 'Tariq', 'Sanjay', 'Leela', 'Joseph', 'Hassan', 'Ritu'];
const LAST = ['Shah', 'Iyer', 'Kulkarni', 'Reddy', 'Menon', 'Ali', 'Khan', 'Fernando', 'Otieno', 'Okafor', 'Rahman', 'Desai', 'Bose', 'Gupta', 'Al Mansoori', 'Mwangi'];
const ROLES = ['Purchase Manager', 'Director', 'Projects Head', 'Procurement Executive', 'Technical Manager'];
const DIAL = { IN: '+91 98', AE: '+971 50', SA: '+966 55', OM: '+968 92', QA: '+974 55', KE: '+254 72', NG: '+234 80', BD: '+880 17', LK: '+94 77', NP: '+977 98', EG: '+20 10', TZ: '+255 75' };
const CURRENCY = { IN: 'INR', AE: 'AED', SA: 'USD', OM: 'USD', QA: 'USD', KE: 'USD', NG: 'USD', BD: 'USD', LK: 'USD', NP: 'INR', EG: 'USD', TZ: 'USD' };
const FX = { INR: 1, USD: 1 / 83, AED: 1 / 22.6 };

/** A tiny but valid PDF used for sample quotation and PO documents. */
function samplePdf(text) {
  const body = `BT /F1 14 Tf 60 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${body.length} >> stream\n${body}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) {
    offsets.push(out.length);
    out += `${o}\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function buildSampleData() {
  migrate();
  resetSettingsCache();
  ensureDropdownDefaults();
  rnd = mulberry32(20261117);
  const started = Date.now();

  const realNow = new Date();
  const END = localDate(realNow, TZ);
  const START = addDays(END, -540);
  const cal = settings().calendar;
  const endHour = zonedParts(realNow, TZ).hour;
  const SIM_END = Date.parse(zonedToUtc(END, endHour >= 11 ? '11:00' : `${String(Math.max(endHour, 8)).padStart(2, '0')}:${String(zonedParts(realNow, TZ).minute).padStart(2, '0')}`, TZ));
  const q = new Heap();
  let clockMs = Date.parse(zonedToUtc(START, '09:00', TZ));
  const at = (date, time) => Date.parse(zonedToUtc(date, time, TZ));
  const setTime = (ms) => {
    clockMs = Math.max(clockMs, ms);
    setClock(new Date(clockMs).toISOString());
  };
  const curDate = () => localDate(new Date(clockMs), TZ);
  const workTime = () => `${String(int(9, 18)).padStart(2, '0')}:${pick(['05', '15', '20', '30', '40', '45', '55'])}`;
  /** Schedules fn on a working day, `days` after the current simulated day, during working hours. */
  const later = (days, fn, { time } = {}) => {
    const d = onOrNextWorkingDay(addDays(curDate(), Math.max(0, Math.round(days))), cal);
    let t = at(d, time || workTime());
    if (t <= clockMs) t = clockMs + int(20, 90) * 60000;
    if (t > SIM_END) return;
    q.push(t, fn);
  };
  const on = (date, fn, time) => {
    const t = at(onOrNextWorkingDay(date, cal), time || workTime());
    if (t > SIM_END) return;
    q.push(t, fn);
  };

  // ---------------------------------------------------------------- people, products, settings
  setTime(at(START, '08:00'));
  const U = {};
  const REG = {};
  const FAC = {};
  const CAT = {};
  tx(() => {
    const stamp = new Date(clockMs).toISOString();
    REGIONS.forEach(([name, states], i) => { REG[name] = insert('regions', { name, states, active: 1, sort_order: i }); });
    for (const [name, location] of FACTORIES) FAC[name] = insert('factories', { name, location, active: 1 });
    const hash = hashPassword(SAMPLE_PASSWORD);
    for (const p of PEOPLE) {
      const login = p.role !== 'staff';
      const id = insert('users', {
        name: p.name, email: p.email, phone: null, role: p.role, department: p.department, designation: p.designation, region_id: p.region ? REG[p.region] : null,
        factory_id: p.factory ? FAC[p.factory] : null, login_enabled: login ? 1 : 0, password_hash: login ? hash : null,
        must_change_password: 0, active: 1, created_at: stamp, updated_at: stamp,
      });
      U[p.key] = id;
    }
    for (const k of ['head', 'coord', 'farida', 'ramesh', 'neha', 'joseph', 'board']) update('users', U[k], { manager_id: U.md });
    update('users', U.md, { manager_id: U.admin });
    update('users', U.arjun, { manager_id: U.head });
    for (const k of ['saurav', 'rahul']) update('users', U[k], { manager_id: U.arjun });
    update('users', U.kavya, { manager_id: U.head });
    for (const k of ['meena', 'suresh', 'imran']) update('users', U[k], { manager_id: U.ramesh });
    setSetting('escalation', { defaultManagerId: U.md });
    FAMILIES.forEach((name, i) => { CAT[name] = insert('product_categories', { name, description: null, active: 1, sort_order: i, created_at: stamp }); });
    const rupees = (n) => Math.round(n * 100);
    for (const [code, name, family, std, d] of PRODUCTS) {
      const pid = insert('products', {
        code, name, family, category_id: CAT[family], model: d.model, hsn: d.hsn, default_unit: 'pcs', integer_qty: 1, price_currency: 'INR',
        standard_price_minor: rupees(std), dealer_price_minor: rupees(Math.round(std * 0.88)), distributor_price_minor: rupees(Math.round(std * 0.82)),
        min_price_minor: rupees(Math.round(std * 0.8)), cost_price_minor: rupees(Math.round(std * 0.62)), gst_rate: 18, warranty_months: d.warranty, lead_time_days: d.lead,
        stock_type: d.stock, stock_qty: d.stock === 'stock' ? int(40, 400) : null, description: `${name}. ${d.model}.`,
        specs: JSON.stringify({ Model: d.model, 'HSN code': d.hsn, Warranty: `${d.warranty} months` }), active: 1, created_at: stamp, updated_at: stamp,
      });
      (d.options || []).forEach(([group, opt, priceDelta, costDelta, leadDelta], i) => insert('product_options', {
        product_id: pid, group_name: group, name: opt, price_delta_minor: rupees(priceDelta), cost_delta_minor: rupees(costDelta), lead_time_delta: leadDelta, active: 1, sort_order: i,
      }));
    }
    insert('products', {
      code: 'VIPS 21A', name: 'Analogue ammeter (discontinued)', family: 'Panel meters', category_id: CAT['Panel meters'], default_unit: 'pcs', integer_qty: 1, price_currency: 'INR',
      standard_price_minor: 68000, gst_rate: 18, stock_type: 'stock', active: 0, created_at: stamp, updated_at: stamp,
    });
    // Default enquiry owners: West → Saurav, other Indian regions → Arjun, export → Kavya.
    insert('assignment_rules', { region_id: REG.West, user_id: U.saurav, priority: 10, active: 1 });
    for (const r of ['North', 'South', 'East']) insert('assignment_rules', { region_id: REG[r], user_id: U.arjun, priority: 20, active: 1 });
    insert('assignment_rules', { segment: 'export', user_id: U.kavya, priority: 10, active: 1 });
    insert('assignment_rules', { category_id: CAT.SMPS, region_id: REG.West, user_id: U.arjun, priority: 5, active: 1 });
    setCounter('SO', 900);
    setCounter('Q', 1900);
    setCounter('ENQ', 1100);
    setCounter('DSP', 400);
  });
  resetSettingsCache();
  const user = (key) => ({ ...publicUser(get('SELECT * FROM users WHERE id = ?', U[key])), raw: null });
  const as = (key, fn) => withContext({ userId: U[key], source: 'seed' }, () => fn(user(key)));
  const P = Object.fromEntries(all('SELECT * FROM products').map((p) => [p.code, p]));
  const price = (code) => PRODUCTS.find((p) => p[0] === code)?.[3] ?? 1000;
  const failures = [];
  let poSeq = 0;
  // Each attempt runs in its own savepoint: in PostgreSQL a failed statement would otherwise spoil the
  // surrounding transaction for the steps after it.
  const safe = (label, fn) => {
    try {
      return tx(fn);
    } catch (err) {
      failures.push(`${label}: ${err.message}${err.details?.fields ? ` ${JSON.stringify(err.details.fields)}` : ''}`);
      return null;
    }
  };

  // ---------------------------------------------------------------- customers
  const C = {};
  const custInfo = {};
  as('coord', (u) => {
    for (const [name, country, city, types, owner, pattern] of CUSTOMERS) {
      const first = pick(FIRST);
      const last = pick(LAST);
      const domain = `${name.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 14)}.example`;
      const contacts = [{ name: `${first} ${last}`, role: pick(ROLES), phone: `${DIAL[country]} ${int(100, 999)} ${int(1000, 9999)}`, email: `${first.toLowerCase()}@${domain}`, is_primary: true }];
      if (chance(0.45)) contacts.push({ name: `${pick(FIRST)} ${pick(LAST)}`, role: pick(ROLES), phone: chance(0.6) ? `${DIAL[country]} ${int(100, 999)} ${int(1000, 9999)}` : null, email: `accounts@${domain}` });
      const state = country === 'IN' ? CITY_STATE[city] || null : null;
      const export_ = country !== 'IN';
      const valueCategory = pattern === 'regular' ? (chance(0.5) ? 'key_account' : 'high_value') : pattern === 'occasional' ? 'regular' : pattern === 'new' ? 'regular' : 'low_value';
      const industry = types.includes('dealer') || types.includes('distributor') ? 'Electrical trading' : types.includes('end_user') ? pick(['Utilities', 'Infrastructure', 'Data centre']) : pick(['Panel building', 'Switchgear', 'Panel building']);
      const interests = [...new Set([pick(FAMILIES.slice(0, 4)), pick(FAMILIES.slice(0, 4)), ...(chance(0.3) ? [pick(FAMILIES.slice(4))] : [])])].map((f) => CAT[f]);
      const tags = [
        ...(valueCategory === 'key_account' ? ['Key account'] : []), ...(types.includes('oem') ? ['Panel builder'] : []), ...(export_ ? ['Export'] : []),
        ...(pattern === 'dormant' ? ['Reconnect'] : []), ...(chance(0.15) ? ['Tender'] : []),
      ];
      const id = createCustomer({
        company_name: name, country_code: country, city, state, types, owner_id: U[owner], contacts, industry, value_category: valueCategory, tags, interests,
        gstin: state ? `${STATE_CODE[state]}AAB${name.replace(/[^A-Z]/g, '').padEnd(2, 'X').slice(0, 2)}${int(1000, 9999)}F1Z${int(1, 9)}` : null,
        billing_address: `${pick(['Plot', 'Unit', 'Gala'])} ${int(2, 140)}, ${pick(['MIDC', 'GIDC', 'Industrial Estate', 'Free Zone', 'Industrial Area'])}, ${city}${state ? `, ${state}` : ''}`,
        payment_terms: export_ ? '30% advance, balance against documents' : pick(['30 days from invoice', '45 days from invoice', '100% against proforma before dispatch']),
        payment_terms_days: export_ ? 45 : pick([30, 30, 45]), credit_limit: pattern === 'regular' && !export_ ? String(int(10, 40) * 100000) : undefined, credit_currency: 'INR',
        acquisition_source: pattern === 'new' ? pick(['website', 'exhibition', 'dealer_referral']) : pattern === 'lost' ? pick(['website', 'email', 'outbound']) : pick(['exhibition', 'dealer_referral', 'field_visit', 'outbound', 'website']),
        website: `www.${name.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 14)}.example`,
      }, u, { skipDuplicateCheck: true });
      C[name] = id;
      custInfo[id] = { name, country, owner, pattern, currency: CURRENCY[country], segment: country === 'IN' ? 'domestic' : 'export' };
    }
  });

  // ---------------------------------------------------------------- campaigns (enquiries are linked after the simulation)
  const CMP = {};
  as('head', (u) => {
    for (const cp of CAMPAIGNS) {
      const start = addDays(START, cp.offset);
      CMP[cp.key] = { ...cp, start, end: addDays(start, cp.days - 1) };
      CMP[cp.key].id = safe('campaign', () => saveCampaign(null, {
        name: cp.name, type: cp.type, location: cp.location, start_date: start, end_date: addDays(start, cp.days - 1), cost: String(cp.cost), cost_currency: 'INR',
        target_leads: cp.target, stall: cp.stall, status: addDays(start, cp.days) < END ? 'completed' : 'planned', owner_id: cp.segment === 'export' ? U.kavya : U.head,
        description: cp.type === 'exhibition' ? 'Stall with live demo panels: panel meters, multifunction meters and CTs.' : 'Evening product update for panel builders and dealers.',
      }, u))?.id;
    }
  });

  // ---------------------------------------------------------------- deal simulation
  const SOURCES_DOM = [['existing_customer', 30], ['website', 15], ['whatsapp', 15], ['email', 15], ['exhibition', 8], ['field_visit', 8], ['dealer_referral', 6], ['outbound', 3]];
  const SOURCES_EXP = [['existing_customer', 25], ['email', 30], ['whatsapp', 15], ['exhibition', 15], ['dealer_referral', 10], ['website', 5]];
  const LOST = [['price', 30], ['delivery_time', 20], ['competitor', 14], ['spec_mismatch', 9], ['project_postponed', 9], ['no_response', 8], ['certification', 4], ['unknown', 6]];
  const DELAYS = [['raw_material', 40], ['staff_shortage', 10], ['machine_tool', 10], ['technical_clarification', 10], ['quality_rework', 10], ['other_work', 10], ['customer_approval', 6], ['payment_hold', 4]];
  const ACTION_OWNER = { raw_material: 'suresh', staff_shortage: 'ramesh', machine_tool: 'ramesh', technical_clarification: 'coord', quality_rework: 'meena', other_work: 'ramesh', customer_approval: null, payment_hold: 'neha' };
  const NOTES = {
    raw_material: ['Waiting for display modules', 'LED displays delayed by supplier', 'Shortage of CT cores', 'PCB lot delayed at vendor'],
    staff_shortage: ['Two assemblers on leave', 'Winding team short-staffed'],
    machine_tool: ['Wave-soldering machine under repair', 'Calibration bench down'],
    technical_clarification: ['Awaiting confirmation of CT ratio', 'Customer to confirm communication protocol'],
    quality_rework: ['Calibration drift found at QC — rework', 'Display flicker on batch — rework'],
    other_work: ['Priority export order taken first'],
    customer_approval: ['Awaiting drawing approval from customer'],
    payment_hold: ['Advance not yet received'],
  };
  const ownerKey = (cid) => {
    const o = get('SELECT owner_id FROM customers WHERE id = ?', cid).owner_id;
    return Object.keys(U).find((k) => U[k] === o) || 'coord';
  };
  const contactOf = (cid) => get('SELECT id FROM contacts WHERE customer_id = ? ORDER BY is_primary DESC, id LIMIT 1', cid)?.id;

  function makeLines(cid, { known = 0.85, qtyKnown = 0.8, max = 3 } = {}) {
    const n = weighted([[1, 60], [2, 28], [3, 12]]);
    const codes = new Set();
    while (codes.size < Math.min(n, max)) codes.add(pick(PRODUCTS.slice(0, 13).map((p) => p[0])));
    return [...codes].map((code) => {
      const isKnown = chance(known);
      const qty = chance(qtyKnown) ? pick([10, 20, 25, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300]) : null;
      return isKnown ? { product_id: P[code].id, qty, unit: 'pcs' } : { requirement: `${P[code].family.replace(/s$/, '')} — model to be confirmed`, qty, unit: 'pcs', _code: code };
    });
  }

  function productionPlan(orderId, ownerK) {
    const lines = all('SELECT * FROM order_lines WHERE order_id = ?', orderId);
    for (const l of lines) {
      const commit = l.original_commitment_date || addDays(curDate(), int(20, 35));
      const lead = Math.max(6, Math.round((Date.parse(commit) - Date.parse(curDate())) / 86400000));
      const delayed = chance(0.3);
      const reason = delayed ? weighted(DELAYS) : null;
      const delayDays = delayed ? int(2, 12) : 0;
      const reporter = chance(0.7) ? 'coord' : 'ramesh';
      const entered = (k) => (k === 'ramesh' ? 'ramesh' : 'coord');
      // QC passes (QC -> ready) are made by the quality in-charge, or by the coordinator on QC's behalf.
      const upd = (changes, extra = {}, qc = false) => {
        const cur = get('SELECT * FROM order_lines WHERE id = ?', l.id);
        if (cur.confirmed_qty - cur.dispatched_qty - cur.cancelled_qty <= 0) return null;
        if (changes.phase === 'qc' && ['ready', 'dispatched'].includes(cur.phase)) return null;
        const who = qc ? (reporter === 'ramesh' ? 'meena' : 'coord') : entered(reporter);
        return as(who, (u) => safe(`update ${orderId}`, () => quickUpdate(l.id, {
          ...changes, reported_by_id: who === 'coord' ? U[qc ? 'meena' : pick(['ramesh', 'meena'])] : undefined, ...extra,
        }, u)));
      };
      later(int(1, Math.min(5, lead - 3)), () => upd({ phase: 'production', work_status: 'in_progress' }));
      const mid = Math.max(3, Math.floor(lead * 0.45));
      if (chance(0.6)) later(mid, () => upd({ still_on_track: true }));
      if (delayed) {
        const reportAt = Math.max(2, Math.floor(lead * (0.4 + rnd() * 0.3)));
        later(reportAt, () => {
          const forecast = addDays(commit, delayDays);
          const actionOwner = ACTION_OWNER[reason] || ownerK;
          const res = upd({
            issue_code: reason, stage_note: pick(NOTES[reason]), forecast_ready_date: addDays(forecast, -1), forecast_dispatch_date: forecast,
            action: { owner_id: U[actionOwner], due_date: addWorkingDays(curDate(), int(1, 4), cal), purpose: reason === 'raw_material' ? 'Confirm material delivery date' : undefined },
          });
          if (!res || res.unchanged) return;
          const o = get('SELECT * FROM orders WHERE id = ?', orderId);
          if (chance(0.78)) {
            later(int(0, 2), () => as(ownerK, (u) => safe('communicate', () => recordCommunication(orderId, {
              line_ids: [l.id], channel: pick(['phone', 'email', 'whatsapp']), contact_id: contactOf(o.customer_id),
              outcome: chance(0.5) ? 'accepted_revised_date' : 'informed_awaiting', agreed_date: forecast, note: `Explained the delay (${pick(NOTES[reason]).toLowerCase()})`,
            }, u))));
          }
          later(Math.max(1, delayDays + int(-2, 3)), () => {
            upd({ resolve_issue: true });
            const t = get("SELECT id FROM tasks WHERE line_id = ? AND status = 'open' AND kind = 'internal' ORDER BY id LIMIT 1", l.id);
            if (t) as('coord', (u) => safe('complete action', () => completeTask(t.id, { channel: 'internal', note: 'Blocker cleared', reported_by_id: U[ACTION_OWNER[reason] || 'ramesh'] }, u)));
          });
        });
      }
      const qcDay = Math.max(4, lead - int(4, 8) + delayDays);
      later(qcDay, () => {
        upd({ phase: 'qc', work_status: 'in_progress' });
        if (chance(0.05)) later(1, () => upd({ phase: 'production', work_status: 'in_progress', note: 'Rework: calibration drift found at QC' }));
      });
      const readyDay = Math.max(qcDay + 1, lead - int(0, 4) + delayDays + (chance(0.15) ? int(1, 4) : 0));
      later(readyDay, () => {
        const now0 = get('SELECT * FROM order_lines WHERE id = ?', l.id);
        const required = now0.confirmed_qty - now0.cancelled_qty;
        if (required - now0.dispatched_qty <= 0) return;
        const partial = chance(0.2) && required >= 20;
        upd({ phase: 'ready', work_status: partial ? 'in_progress' : 'phase_complete', ready_qty: partial ? Math.max(now0.dispatched_qty, Math.round(required * 0.6)) : required, qc_summary: partial ? 'First lot passed QC' : 'Passed QC — calibration and insulation tests OK' }, {}, true);
        later(int(0, 3), () => {
          const cur = get('SELECT * FROM order_lines WHERE id = ?', l.id);
          const rem = cur.confirmed_qty - cur.dispatched_qty - cur.cancelled_qty;
          if (rem <= 0) return;
          const qty = partial ? Math.min(rem, Math.round(cur.confirmed_qty * 0.6) - cur.dispatched_qty) : rem;
          if (qty <= 0) return;
          const d = as(chance(0.7) ? 'coord' : 'ramesh', (u) => safe('dispatch', () => postDispatch({
            lines: [{ line_id: l.id, qty }], dispatch_date: curDate(), reference: `PK-${int(1000, 9999)}`, carrier: pick(['VRL Logistics', 'Gati', 'Blue Dart', 'DHL Express', 'Aramex', 'Safexpress']),
            tracking_no: `${pick(['LR', 'AWB'])}${int(100000, 999999)}`, invoice_ref: `INV/${int(1000, 9999)}`,
          }, u)));
          if (d && chance(0.82)) as(ownerKey(get('SELECT customer_id FROM orders WHERE id = ?', orderId).customer_id), (u) => safe('notify', () => recordDispatchNotice(d.id, { channel: pick(['email', 'whatsapp']), contact_id: contactOf(get('SELECT customer_id FROM orders WHERE id = ?', orderId).customer_id) }, u)));
          if (partial) {
            later(int(4, 9), () => {
              const fresh = get('SELECT * FROM order_lines WHERE id = ?', l.id);
              upd({ ready_qty: fresh.confirmed_qty - fresh.cancelled_qty, work_status: 'phase_complete' });
              later(int(0, 2), () => {
                const c2 = get('SELECT * FROM order_lines WHERE id = ?', l.id);
                const r2 = c2.confirmed_qty - c2.dispatched_qty - c2.cancelled_qty;
                if (r2 > 0) as('coord', (u) => safe('dispatch2', () => postDispatch({ lines: [{ line_id: l.id, qty: r2 }], dispatch_date: curDate(), reference: `PK-${int(1000, 9999)}`, carrier: 'VRL Logistics', tracking_no: `LR${int(100000, 999999)}`, override_reason: 'Balance completed and packed on dispatch day' }, u)));
              });
            });
          }
        });
      });
      if (chance(0.05)) {
        later(int(5, Math.max(6, lead - 2)), () => as('coord', (u) => {
          const cur = get('SELECT * FROM order_lines WHERE id = ?', l.id);
          const rem = cur.confirmed_qty - cur.dispatched_qty - cur.cancelled_qty;
          if (rem > 4) safe('cancel', () => cancelQuantity(l.id, { qty: Math.floor(rem * 0.25), reason_code: pick(['customer_cancelled', 'spec_change', 'project_cancelled']), requested_source: 'customer', note: 'Customer reduced the requirement' }, u));
        }));
      }
    }
  }

  function startDeal(cid, date, { forceOutcome = null, linesOpts, source = null, campaignId = null } = {}) {
    on(date, () => {
      const info = custInfo[cid];
      const ownerK = ownerKey(cid);
      const res = as(ownerK === 'kavya' || chance(0.5) ? ownerK : 'coord', (u) => safe('enquiry', () => createEnquiry({
        customer_id: cid, contact_id: contactOf(cid), owner_id: U[ownerK], source_code: source || weighted(info.segment === 'export' ? SOURCES_EXP : SOURCES_DOM),
        source_event: null, campaign_id: campaignId || undefined, lines: makeLines(cid, linesOpts), received_at: new Date(clockMs - int(5, 240) * 60000).toISOString(),
      }, u)));
      if (!res) return;
      const deal = { cid, enquiryId: res.id, ownerK, forceOutcome };
      if (chance(0.05) && !forceOutcome) {
        later(int(0, 2), () => as(ownerK, (u) => safe('cancel enq', () => changeStage(deal.enquiryId, { stage: 'cancelled', cancel_reason_code: pick(['duplicate', 'withdrawn', 'invalid']) }, u))));
        return;
      }
      later(chance(0.7) ? 0 : int(1, 2), () => respond(deal, 0));
    });
  }

  function openTask(enquiryId) {
    return get("SELECT * FROM tasks WHERE enquiry_id = ? AND status = 'open' ORDER BY overdue_at LIMIT 1", enquiryId);
  }

  function respond(deal, attempts) {
    const t = openTask(deal.enquiryId);
    if (!t) return;
    const noAnswer = attempts < 2 && chance(0.15);
    as(deal.ownerK, (u) => safe('respond', () => completeTask(t.id, {
      channel: pick(['phone', 'phone', 'whatsapp', 'email']), outcome: noAnswer ? 'no_answer' : pick(['quotation_requested', 'requirement_confirmed', 'spec_clarification']),
      contact_id: contactOf(deal.cid), note: noAnswer ? null : pick(['Shared requirement and target price', 'Needs datasheet and price', 'Confirmed quantities and delivery location', null]),
      next: { purpose: noAnswer ? 'Call back' : 'Send quotation', owner_id: U[deal.ownerK], due_date: addWorkingDays(curDate(), noAnswer ? 1 : int(1, 3), cal) },
    }, u)));
    if (noAnswer) later(1, () => respond(deal, attempts + 1));
    else later(int(1, 4), () => quote(deal));
  }

  function quote(deal) {
    const e = get('SELECT * FROM enquiries WHERE id = ?', deal.enquiryId);
    if (!e || !['new', 'clarification', 'quote_to_prepare'].includes(e.stage)) return;
    const info = custInfo[deal.cid];
    const fx = FX[info.currency] || 1;
    const lines = all('SELECT * FROM enquiry_lines WHERE enquiry_id = ? ORDER BY sort', deal.enquiryId).map((l) => {
      const code = l.product_id ? get('SELECT code FROM products WHERE id = ?', l.product_id).code : pick(PRODUCTS.slice(0, 13).map((p) => p[0]));
      const qty = l.qty || pick([20, 40, 50, 100, 150]);
      return { enquiry_line_id: l.id, product_id: P[code].id, description: P[code].name, qty, unit: 'pcs', unit_price: (price(code) * fx * (0.92 + rnd() * 0.16)).toFixed(2) };
    });
    as(deal.ownerK, (u) => {
      const qres = safe('quote', () => createQuotation({ enquiry_id: deal.enquiryId, currency: info.currency, lines, validity_date: addDays(curDate(), 30), delivery_terms: `${int(3, 6)} weeks from PO`, payment_terms: info.segment === 'export' ? '30% advance, balance against documents' : '30 days from invoice' }, u));
      if (!qres) return;
      deal.quotationId = qres.quotation_id;
      deal.revisionId = qres.revision_id;
      let docId = null;
      if (chance(0.5)) {
        const number = get('SELECT number FROM quotations WHERE id = ?', qres.quotation_id).number;
        docId = safe('quote doc', () => storeAttachment({ buffer: samplePdf(`Veritek quotation ${number} rev 1 — ${info.name}`), name: `${number}-rev1.pdf`, entityType: 'enquiry', entityId: deal.enquiryId }, u))?.id;
      }
      safe('issue', () => issueRevision(qres.revision_id, {
        sent_at: new Date(clockMs).toISOString(), channel: pick(['email', 'email', 'whatsapp']), contact_id: contactOf(deal.cid), document_id: docId,
        summary: docId ? null : `${lines.length} line(s), ${info.currency}, delivery ${int(3, 6)} weeks`,
        next: { purpose: 'Follow up quotation', owner_id: U[deal.ownerK], due_date: addWorkingDays(curDate(), int(2, 5), cal) },
      }, u));
    });
    later(int(2, 6), () => followUp(deal, 0));
  }

  function followUp(deal, round) {
    const t = openTask(deal.enquiryId);
    if (!t) return;
    const outcome = deal.forceOutcome || weighted([['won', 46], ['lost', 33], ['revise', round ? 0 : 14], ['hold', 4], ['wait', round < 2 ? 8 : 0]]);
    as(deal.ownerK, (u) => {
      if (outcome === 'wait' || outcome === 'revise') {
        safe('followup', () => completeTask(t.id, {
          channel: pick(['phone', 'email', 'whatsapp']), outcome: outcome === 'revise' ? 'price_concern' : pick(['quotation_discussed', 'waiting_for_customer']), contact_id: contactOf(deal.cid),
          note: outcome === 'revise' ? 'Asked for a better price on volume' : 'Decision expected after internal approval',
          next: { purpose: outcome === 'revise' ? 'Send revised offer' : 'Confirm purchase decision', owner_id: U[deal.ownerK], due_date: addWorkingDays(curDate(), int(2, 6), cal) },
        }, u));
        if (outcome === 'revise') {
          later(int(1, 3), () => as(deal.ownerK, (u2) => {
            const r = safe('new rev', () => newRevision(deal.quotationId, u2));
            if (!r) return;
            const rev = get('SELECT * FROM quote_revisions WHERE id = ?', r.revision_id);
            const lines = JSON.parse(rev.lines).map((l) => ({ ...l, unit_price: ((l.unit_price_minor / 100) * 0.94).toFixed(2) }));
            safe('upd draft', () => updateDraft(r.revision_id, { lines, change_note: 'Volume discount on request' }, u2));
            approveIfNeeded(r.revision_id, deal.cid, u2);
            safe('issue2', () => issueRevision(r.revision_id, { sent_at: new Date(clockMs).toISOString(), channel: 'email', summary: 'Revised offer: 6% volume discount', next: { purpose: 'Follow up quotation', owner_id: U[deal.ownerK], due_date: addWorkingDays(curDate(), int(2, 5), cal) } }, u2));
            deal.revisionId = r.revision_id;
            later(int(3, 8), () => followUp(deal, round + 1));
          }));
        } else {
          safe('awaiting', () => changeStage(deal.enquiryId, { stage: 'awaiting_decision' }, u));
          later(int(3, 9), () => followUp(deal, round + 1));
        }
        return;
      }
      if (outcome === 'hold') {
        safe('hold', () => completeTask(t.id, { channel: 'phone', outcome: 'waiting_for_customer', note: 'Project on hold until budget approval', no_followup_reason: 'On hold' }, u));
        safe('hold stage', () => changeStage(deal.enquiryId, { stage: 'on_hold', hold_review_date: addDays(curDate(), int(20, 45)), hold_reason: 'Customer budget approval pending' }, u));
        return;
      }
      if (outcome === 'lost') {
        const reason = deal.lostReason || weighted(LOST);
        safe('lost task', () => completeTask(t.id, { channel: 'phone', outcome: 'not_interested', contact_id: contactOf(deal.cid), note: 'Customer decided not to proceed', no_followup_reason: 'Closed as lost' }, u));
        safe('lost', () => changeStage(deal.enquiryId, { stage: 'lost', lost_reason_code: reason, competitor: reason === 'competitor' ? pick(['Secure Meters', 'Rishabh', 'Elmeasure', 'Local assembler']) : null, lost_note: reason === 'other' ? 'Other' : null }, u));
        return;
      }
      // won
      safe('won task', () => completeTask(t.id, { channel: pick(['email', 'phone']), outcome: 'order_confirmed', contact_id: contactOf(deal.cid), note: 'PO received by email', no_followup_reason: 'Order confirmed' }, u));
      convert(deal, u);
    });
  }

  /** A revision beyond the discount / margin policy is submitted and decided by the right approver. */
  function approveIfNeeded(revisionId, cid, owner) {
    const rev = get('SELECT approval_role, approval_status FROM quote_revisions WHERE id = ?', revisionId);
    if (!rev?.approval_role || rev.approval_status === 'approved') return;
    const sub = safe('submit approval', () => submitForApproval(revisionId, owner));
    if (!sub?.approval_id) return;
    const region = get('SELECT region_id FROM customers WHERE id = ?', cid)?.region_id;
    const approver = rev.approval_role === 'regional_manager' && region === REG.West ? 'arjun' : ['regional_manager', 'sales_head'].includes(rev.approval_role) ? 'head' : 'md';
    as(approver, (a) => safe('decide approval', () => decideApproval(sub.approval_id, { decision: 'approved', comments: 'Volume justifies the discount' }, a)));
  }

  function convert(deal, u) {
    const rev = get('SELECT * FROM quote_revisions WHERE id = ?', deal.revisionId);
    if (!rev) return;
    const info = custInfo[deal.cid];
    const lines = JSON.parse(rev.lines);
    const partial = chance(0.1) && lines[0].qty >= 20;
    const base = addDays(curDate(), info.segment === 'export' ? int(28, 45) : int(18, 35));
    const conv = lines.map((l, i) => ({
      index: l.index, qty: partial && i === 0 ? Math.round(l.qty * 0.6) : l.qty,
      ...(chance(0.06) ? { commitment_state: 'uncommitted' } : { original_commitment_date: onOrNextWorkingDay(i && chance(0.3) ? addDays(base, int(7, 14)) : base, cal) }),
    }));
    let poDoc = null;
    if (chance(0.4)) poDoc = safe('po doc', () => storeAttachment({ buffer: samplePdf(`Purchase order from ${info.name}`), name: `PO-${info.name.split(' ')[0]}-${int(100, 999)}.pdf`, entityType: 'enquiry', entityId: deal.enquiryId }, u))?.id;
    const res = safe('convert', () => convertToOrder(deal.revisionId, {
      lines: conv, po_reference: `${info.name.split(' ')[0].toUpperCase().slice(0, 4)}/PO/${curDate().slice(2, 4)}${String(++poSeq).padStart(3, "0")}`, received_date: curDate(), confirmation_type: 'po',
      confirmation_document_id: poDoc, confirm: true,
    }, u));
    if (!res) return;
    if (partial) {
      const el = get('SELECT id FROM enquiry_lines WHERE id = ?', lines[0].enquiry_line_id);
      if (el) safe('remainder lost', () => setLineOutcome(el.id, { outcome: 'lost', reason_code: pick(['price', 'project_postponed']), note: 'Customer ordered part of the quantity' }, u));
    }
    for (const l of all("SELECT id FROM order_lines WHERE order_id = ? AND commitment_state = 'uncommitted'", res.order_id)) {
      later(int(2, 5), () => as(deal.ownerK, (u2) => safe('commit', () => setCommitment(l.id, { original_commitment_date: onOrNextWorkingDay(addDays(curDate(), int(18, 30)), cal) }, u2))));
    }
    productionPlan(res.order_id, deal.ownerK);
  }

  function repeatOrder(cid, date) {
    on(date, () => {
      const info = custInfo[cid];
      const ownerK = ownerKey(cid);
      const fx = FX[info.currency] || 1;
      const codes = [...new Set(Array.from({ length: weighted([[1, 70], [2, 30]]) }, () => pick(PRODUCTS.slice(0, 13).map((p) => p[0]))))];
      const commit = onOrNextWorkingDay(addDays(curDate(), info.segment === 'export' ? int(25, 40) : int(15, 30)), cal);
      const id = as('coord', (u) => safe('repeat order', () => createOrder({
        customer_id: cid, owner_id: U[ownerK], source_code: 'repeat_order', po_reference: `${info.name.split(' ')[0].toUpperCase().slice(0, 4)}/PO/${curDate().slice(2, 4)}${String(++poSeq).padStart(3, "0")}`,
        received_date: curDate(), currency: info.currency,
        lines: codes.map((code) => ({ product_id: P[code].id, confirmed_qty: pick([20, 30, 50, 60, 100, 120, 200]), unit: 'pcs', unit_price: (price(code) * fx).toFixed(2), commitment_state: 'committed', original_commitment_date: commit })),
        confirm: true,
      }, u)));
      if (id) productionPlan(id, ownerK);
    });
  }

  // Schedule history by customer pattern.
  for (const [name, , , , , pattern] of CUSTOMERS) {
    const cid = C[name];
    const window = { regular: [0, 540], occasional: [0, 540], dormant: [0, 300], lost: [60, 520], new: [470, 538], quiet: [0, 200] }[pattern];
    const enquiries = { regular: int(7, 10), occasional: int(3, 5), dormant: int(3, 5), lost: int(1, 3), new: int(1, 2), quiet: 1 }[pattern];
    for (let i = 0; i < enquiries; i++) {
      const d = addDays(START, int(window[0], window[1]));
      startDeal(cid, d, { forceOutcome: pattern === 'lost' ? 'lost' : pattern === 'dormant' && chance(0.3) ? 'won' : null });
    }
    if (pattern === 'regular') for (let i = 0; i < int(3, 5); i++) repeatOrder(cid, addDays(START, int(20, 520)));
    if (pattern === 'dormant') repeatOrder(cid, addDays(START, int(40, 200)));
    // Current workload: recent enquiries and repeat orders so today's lists are realistically full.
    if (['regular', 'occasional', 'new'].includes(pattern)) {
      for (let i = 0; i < int(1, 2); i++) startDeal(cid, addDays(START, int(512, 539)));
      if (pattern !== 'new' && chance(0.6)) repeatOrder(cid, addDays(START, int(505, 535)));
    }
  }

  // Enquiries collected at each campaign (stall visitors and meet attendees), worked through the same pipeline.
  for (const cp of Object.values(CMP)) {
    if (!cp.id || cp.start > END) continue;
    const pool = CUSTOMERS.filter(([, country, , , , pattern]) => (cp.segment === 'export' ? country !== 'IN' : country === 'IN') && pattern !== 'lost').map(([name]) => C[name]);
    const n = cp.type === 'exhibition' ? int(9, 13) : int(5, 7);
    for (let i = 0; i < n; i++) {
      const d = addDays(cp.start, int(0, cp.days + 4));
      if (d < END) startDeal(pick(pool), d, { source: cp.type === 'exhibition' ? 'exhibition' : 'dealer_referral', campaignId: cp.id });
    }
  }

  // ---------------------------------------------------------------- reference situations (spec screens)
  const D = (n) => addDays(END, n);

  // Reactivation history: reconnecting with dormant customers, one won back, one not pursued.
  on(D(-70), () => as('arjun', (u) => {
    const cid = C['Vardhman Panel Works'];
    const rc = safe('vardhman case', () => recordUpdate(cid, { reason_code: 'price', note: 'Moved to a cheaper local brand last year', action_type: 'call', due_date: curDate(), owner_id: U.arjun }, u));
    if (!rc) return;
    later(1, () => as('arjun', (u2) => {
      safe('vardhman call', () => completeTask(rc.task_id, { channel: 'phone', outcome: 'requirement_confirmed', contact_id: contactOf(cid), note: 'New panel line starting — open to a fresh offer', next: { purpose: 'Send revised offer', owner_id: U.arjun, due_date: addWorkingDays(curDate(), 2, cal) } }, u2));
      later(2, () => as('arjun', (u3) => {
        const e = safe('vardhman enquiry', () => openLinkedEnquiry(cid, { owner_id: U.arjun, lines: [{ product_id: P['VIPS 70L'].id, qty: 120, unit: 'pcs' }, { product_id: P['CT 200/5A'].id, qty: 240, unit: 'pcs' }] }, u3));
        const t = get("SELECT id FROM tasks WHERE reactivation_case_id = ? AND status = 'open'", rc.case_id);
        if (t) safe('close reconnect task', () => completeTask(t.id, { channel: 'email', outcome: 'quotation_requested', contact_id: contactOf(cid), no_followup_reason: 'New enquiry opened' }, u3));
        if (e) startPath({ cid, enquiryId: e.id, ownerK: 'arjun', forceOutcome: 'won' });
      }));
    }));
  }));
  on(D(-50), () => as('saurav', (u) => {
    const cid = C['Precision Panels & Controls'];
    const rc = safe('precision case', () => recordUpdate(cid, { reason_code: 'competitor', action_type: 'call', due_date: curDate(), owner_id: U.saurav }, u));
    if (!rc) return;
    later(1, () => as('saurav', (u2) => {
      safe('precision no answer', () => completeTask(rc.task_id, { channel: 'phone', outcome: 'no_answer', contact_id: contactOf(cid), next: { purpose: 'Call customer', owner_id: U.saurav, due_date: addWorkingDays(curDate(), 2, cal) } }, u2));
      later(2, () => as('saurav', (u3) => {
        const t = get("SELECT id FROM tasks WHERE reactivation_case_id = ? AND status = 'open'", rc.case_id);
        if (t) safe('precision call', () => completeTask(t.id, { channel: 'phone', outcome: 'not_interested', contact_id: contactOf(cid), note: 'Now buying through a distributor', no_followup_reason: 'Not pursuing' }, u3));
        safe('precision close', () => closeCase(rc.case_id, { status: 'not_pursuing', reason_code: 'served_by_dealer', note: 'Buying through Bharat Electro Systems', review_date: D(90) }, u3));
      }));
    }));
  }));
  on(D(-30), () => as('kavya', (u) => {
    const cid = C['Dammam Electrical Industries'];
    const rc = safe('dammam case', () => recordUpdate(cid, { reason_code: 'delivery_time', note: 'Last two orders shipped late', action_type: 'call', due_date: curDate(), owner_id: U.kavya }, u));
    if (!rc) return;
    later(1, () => as('kavya', (u2) => safe('dammam call', () => completeTask(rc.task_id, { channel: 'whatsapp', outcome: 'callback_requested', contact_id: contactOf(cid), note: 'Asked us to call back after their tender result', next: { purpose: 'Call back', owner_id: U.kavya, due_date: D(-2) } }, u2))));
  }));
  // Orion Controls: past buyer, last order ~8 months ago, a later enquiry lost on delivery time, call due today.
  repeatOrder(C['Orion Controls'], D(-245));
  on(D(-200), () => {
    const cid = C['Orion Controls'];
    as('saurav', (u) => {
      const res = safe('orion enq', () => createEnquiry({ customer_id: cid, owner_id: U.saurav, source_code: 'existing_customer', lines: [{ product_id: P['VIPS 70L'].id, qty: 150, unit: 'pcs' }] }, u));
      if (res) startPath({ cid, enquiryId: res.id, ownerK: 'saurav', forceOutcome: 'lost', lostReason: 'delivery_time' });
    });
  });
  // Delta Electrical: lost quotation on price two months ago; revised offer due.
  on(D(-75), () => as('arjun', (u) => {
    const res = safe('delta enq', () => createEnquiry({ customer_id: C['Delta Electrical'], owner_id: U.arjun, source_code: 'dealer_referral', lines: [{ product_id: P['VIPS 98EFR'].id, qty: 60, unit: 'pcs' }] }, u));
    if (res) startPath({ cid: C['Delta Electrical'], enquiryId: res.id, ownerK: 'arjun', forceOutcome: 'lost', lostReason: 'price' });
  }));
  // Nova Panels: quotation closed with no reason given — ask why they did not proceed.
  on(D(-125), () => as('saurav', (u) => {
    const res = safe('nova enq', () => createEnquiry({ customer_id: C['Nova Panels'], owner_id: U.saurav, source_code: 'website', lines: [{ product_id: P['VIPS 83P'].id, qty: 80, unit: 'pcs' }] }, u));
    if (res) startPath({ cid: C['Nova Panels'], enquiryId: res.id, ownerK: 'saurav', forceOutcome: 'lost', lostReason: 'unknown' });
  }));

  function startPath(deal) {
    later(0, () => respond(deal, 2));
  }

  // Current orders mirroring the overview: Gulf Panel (shortage), Apex (dispatch overdue, ready), Metro (on track).
  const scripted = {};
  on(D(-24), () => as('kavya', (u) => {
    scripted.gulf = safe('gulf order', () => createOrder({
      customer_id: C['Gulf Panel Co.'], owner_id: U.kavya, source_code: 'po_received', po_reference: 'GP/PO/2026/114', received_date: curDate(), currency: 'AED',
      lines: [{ product_id: P['VIPS 70L'].id, confirmed_qty: 100, unit: 'pcs', unit_price: '64.00', commitment_state: 'committed', original_commitment_date: D(2) }],
      confirm: true, confirmation_note: 'PO received by email from Rashid (Purchase)',
    }, u));
  }), '10:10');
  on(D(-20), () => scripted.gulf && as('coord', (u) => safe('gulf p', () => quickUpdate(get('SELECT id FROM order_lines WHERE order_id = ?', scripted.gulf).id, { phase: 'production', work_status: 'in_progress', reported_by_id: U.ramesh }, u))), '11:00');
  on(D(-14), () => as('saurav', (u) => {
    scripted.apex = safe('apex order', () => createOrder({
      customer_id: C['Apex Panels'], owner_id: U.saurav, source_code: 'repeat_order', po_reference: 'APX-4471', received_date: curDate(), currency: 'INR',
      lines: [{ product_id: P['VIPS 83P'].id, confirmed_qty: 50, unit: 'pcs', unit_price: '2310.00', commitment_state: 'committed', original_commitment_date: D(-2) }], confirm: true,
    }, u));
  }), '12:00');
  on(D(-10), () => scripted.apex && as('coord', (u) => safe('apex p', () => quickUpdate(get('SELECT id FROM order_lines WHERE order_id = ?', scripted.apex).id, { phase: 'production', work_status: 'in_progress', reported_by_id: U.ramesh }, u))), '10:30');
  on(D(-3), () => scripted.apex && as('coord', (u) => safe('apex ready', () => quickUpdate(get('SELECT id FROM order_lines WHERE order_id = ?', scripted.apex).id, { phase: 'ready', work_status: 'phase_complete', ready_qty: 50, reported_by_id: U.meena }, u))), '16:00');
  on(D(-9), () => as('arjun', (u) => {
    scripted.metro = safe('metro order', () => createOrder({
      customer_id: C['Metro Controls'], owner_id: U.arjun, source_code: 'repeat_order', po_reference: 'MC/0925', received_date: curDate(), currency: 'INR',
      lines: [{ product_id: P['CT 100/5A'].id, confirmed_qty: 40, unit: 'pcs', unit_price: '515.00', commitment_state: 'committed', original_commitment_date: D(3) }], confirm: true,
    }, u));
  }), '11:20');
  on(D(-6), () => scripted.metro && as('coord', (u) => safe('metro p', () => quickUpdate(get('SELECT id FROM order_lines WHERE order_id = ?', scripted.metro).id, { phase: 'production', work_status: 'in_progress', reported_by_id: U.ramesh }, u))), '10:00');

  // Orders held up before production: an advance overdue for a week, one just requested, and a draft nobody confirmed.
  on(D(-7), () => as('coord', (u) => safe('advance order', () => createOrder({
    customer_id: C['Western Panel Builders'], owner_id: U[ownerKey(C['Western Panel Builders'])], source_code: 'po_received', po_reference: 'WPB/PO/2231', received_date: curDate(), currency: 'INR',
    payment_terms: '40% advance, balance before dispatch', advance_pct: 40, advance_required: '58000.00',
    lines: [{ product_id: P['VIPS 98EFR'].id, confirmed_qty: 20, unit: 'pcs', unit_price: '7250.00', commitment_state: 'committed', original_commitment_date: D(18) }], confirm: true, confirmation_note: 'PO received; production starts on receipt of advance',
  }, u))), '11:40');
  on(D(-1), () => as('coord', (u) => safe('advance order 2', () => createOrder({
    customer_id: C['Sahyadri Switchgear'], owner_id: U[ownerKey(C['Sahyadri Switchgear'])], source_code: 'po_received', po_reference: 'SSG-8841', received_date: curDate(), currency: 'INR',
    payment_terms: '30% advance, balance against proforma', advance_pct: 30, advance_required: '18900.00',
    lines: [{ product_id: P['CT 400/5A'].id, confirmed_qty: 80, unit: 'pcs', unit_price: '787.50', commitment_state: 'committed', original_commitment_date: D(14) }], confirm: true,
  }, u))), '15:10');
  on(D(-5), () => as('coord', (u) => safe('draft order', () => createOrder({
    customer_id: C['Apex Panels'], owner_id: U[ownerKey(C['Apex Panels'])], source_code: 'po_received', po_reference: 'APX-4502', received_date: curDate(), currency: 'INR',
    lines: [{ product_id: P['VIPS 70L'].id, confirmed_qty: 60, unit: 'pcs', unit_price: '1425.00' }], notes: 'Waiting for the signed PO copy before confirming',
  }, u))), '16:05');

  // ---------------------------------------------------------------- run the simulation
  let events = 0;
  while (q.size) {
    const ev = q.pop();
    if (ev.t > SIM_END) continue;
    setTime(ev.t);
    events++;
    tx(() => ev.fn());
  }

  // ---------------------------------------------------------------- finishing touches at "today"
  setTime(Math.max(clockMs, at(END, '09:20')));
  tx(() => {
    // Today's shortage report on the Gulf Panel order (raw material, waiting for displays; purchase to confirm today).
    if (scripted.gulf) {
      const line = get('SELECT id FROM order_lines WHERE order_id = ?', scripted.gulf).id;
      as('coord', (u) => safe('gulf shortage', () => quickUpdate(line, {
        issue_code: 'raw_material', stage_note: 'Waiting for display modules', forecast_ready_date: D(4), forecast_dispatch_date: D(4), reported_by_id: U.ramesh,
        action: { owner_id: U.suresh, due_date: END, purpose: 'Confirm display module delivery' },
        as_of: new Date(clockMs - 40 * 60000).toISOString(), note: 'Reported in the morning production check',
      }, u)));
    }
    if (scripted.metro) as('ramesh', (u) => safe('metro today', () => quickUpdate(get('SELECT id FROM order_lines WHERE order_id = ?', scripted.metro).id, { phase: 'qc', work_status: 'in_progress' }, u)));

    // Reactivation work on past customers (reason next to next action, from the same task record).
    as('saurav', (u) => safe('orion case', () => recordUpdate(C['Orion Controls'], { reason_code: 'delivery_time', note: 'Required delivery was 7 days', action_type: 'call', due_date: END, owner_id: U.saurav }, u)));
    as('arjun', (u) => safe('delta case', () => recordUpdate(C['Delta Electrical'], { reason_code: 'price', note: 'Competitor quoted 8% lower', action_type: 'revised_quote', due_date: D(1), owner_id: U.arjun }, u)));
    const novaTask = get("SELECT t.id FROM tasks t JOIN enquiries e ON e.id = t.enquiry_id WHERE e.customer_id = ? AND t.status = 'open' AND t.purpose_code = 'ask_feedback' LIMIT 1", C['Nova Panels']);
    if (novaTask) as('saurav', (u) => safe('nova reschedule', () => rescheduleTask(novaTask.id, { due_date: END, reason: 'Purchase head was travelling — asked us to call after the 15th' }, u)));

    // A do-not-contact preference, a provisional enquiry, a back-entered call and a technical issue note.
    as('admin', (u) => safe('dnc', () => setDoNotContact(C['Lagos Switchboards Ltd'], { do_not_contact: true, reason: 'Asked not to be contacted after a change of ownership', source: 'Email from customer' }, u)));
    as('coord', (u) => {
      safe('provisional', () => createEnquiry({
        new_customer: { company_name: 'Bhoomi Electricals', provisional: true, country_code: 'IN', city: 'Surat', contacts: [{ name: 'Mr. Joshi', phone: '+91 97 1234 5678' }], confirm_not_duplicate: true },
        owner_id: U.arjun, source_code: 'whatsapp', lines: [{ requirement: 'Unspecified / needs clarification — "meters for 3 panels"' }], requirement_note: 'WhatsApp message: needs meters for three panels, will share drawings',
      }, u));
      const gulf = C['Gulf Panel Co.'];
      safe('backdated', () => recordActivity({ customer_id: gulf, contact_id: contactOf(gulf), channel: 'phone', outcome: 'delivery_concern', note: 'Customer asked for delivery confirmation on the open order', occurred_at: new Date(at(addWorkingDays(D(-4), 0, cal), '17:30')).toISOString(), reported_by_id: U.kavya }, u));
      const sah = C['Sahyadri Switchgear'];
      safe('tech issue', () => recordActivity({ customer_id: sah, contact_id: contactOf(sah), channel: 'phone', outcome: 'other', note: 'Two VIPS 98EFR units show communication errors on site — collecting serial numbers', technical_issue: true }, u));
    });
    // A draft order with missing details.
    as('saurav', (u) => safe('draft', () => createOrder({ customer_id: C['Western Panel Builders'], owner_id: U.saurav, received_date: END, lines: [{ product_id: P['VIPS 44D'].id, confirmed_qty: 30, unit: 'pcs', commitment_state: 'uncommitted' }], confirm: false, notes: 'Verbal order — PO to follow' }, u)));
  });

  // Duplicates: one authorised merge already done, one candidate left for review.
  tx(() => as('coord', (u) => {
    const dup = safe('dup1', () => createCustomer({ company_name: 'Shakti Power Sys.', country_code: 'IN', city: 'Nashik', owner_id: U.arjun, contacts: [{ name: 'Accounts', email: 'accounts@shaktipowersyst.example' }] }, u, { skipDuplicateCheck: true }));
    if (dup) as('admin', (a) => safe('merge', () => mergeCustomers(C['Shakti Power Systems'], dup, 'Same company entered twice from an old price list', a)));
    const orionPhone = get('SELECT phone_raw FROM contacts WHERE customer_id = ? ORDER BY id LIMIT 1', C['Orion Controls']).phone_raw;
    safe('dup2', () => createCustomer({ company_name: 'Orion Control Systems', country_code: 'IN', city: 'Pune', owner_id: U.saurav, contacts: [{ name: 'Front desk', phone: orionPhone }] }, u, { skipDuplicateCheck: true }));
  }));

  // A deactivated salesperson: history keeps their name; open work moved to Arjun.
  tx(() => as('admin', (u) => safe('deactivate', () => deactivateUser(U.rahul, { reassign_to: U.arjun, reason: 'Left the company' }, u))));

  // Legacy import: past customers from the old sheet, some with unknown dates, and two legacy orders.
  tx(() => as('coord', (u) => {
    const csv = [
      'external_id,company_name,country,city,segment,types,owner_email,contact_name,phone,email,last_order_date,first_order_date,order_count,notes',
      'OLD-101,Konkan Power Panels,IN,Ratnagiri,domestic,oem,saurav@veritek.example,Mr. Sawant,+91 94220 11223,,14/03/2025,02/05/2022,7,From the 2023 price-list sheet',
      'OLD-102,Vindhya Switchgear,IN,Jabalpur,domestic,dealer,arjun@veritek.example,Mr. Tiwari,+91 98260 44556,,,,4,"Last order date not recorded in the old sheet"',
      'OLD-103,Sharjah Electro Mechanical,AE,Sharjah,export,oem,kavya@veritek.example,Mr. Haddad,+971 50 765 4321,purchase@sem.example,22/01/2025,,3,',
      'OLD-104,Godavari Electricals,IN,Rajahmundry,domestic,dealer,arjun@veritek.example,,,godavari@example.in,05/08/2024,,2,No contact person recorded',
      'OLD-105,Tapti Panels,IN,Surat,domestic,oem,saurav@veritek.example,Ms. Patel,+91 99090 22110,,,,,',
    ].join('\n');
    const up = safe('upload', () => storeUpload(Buffer.from(csv), 'old-customer-sheet.csv', u));
    if (up) safe('import', () => commitImport({ batch_key: 'seed-legacy-customers', upload_id: up.upload_id, type: 'customers', date_format: 'DD/MM/YYYY', source_system: 'old-sheet' }, u));
    const orders = [
      'order_ref,line_ref,customer_ref,customer_name,po_reference,received_date,owner_email,product_code,qty,unit,unit_price,currency,original_commitment_date,phase,dispatched_qty,dispatch_date',
      `L-2207,1,OLD-101,Konkan Power Panels,KPP/119,02/03/2025,saurav@veritek.example,VIPS 70L,60,pcs,1390,INR,,received,60,`,
      `L-2207,2,OLD-101,Konkan Power Panels,KPP/119,02/03/2025,saurav@veritek.example,CT 200/5A,120,pcs,,INR,28/03/2025,received,120,26/03/2025`,
      `L-2311,1,OLD-103,Sharjah Electro Mechanical,SEM-55,10/01/2025,kavya@veritek.example,VIPS 98EFR,20,pcs,95,USD,,received,20,`,
    ].join('\n');
    const up2 = safe('upload2', () => storeUpload(Buffer.from(orders), 'legacy-orders.csv', u));
    if (up2) safe('import2', () => commitImport({ batch_key: 'seed-legacy-orders', upload_id: up2.upload_id, type: 'order_lines', date_format: 'DD/MM/YYYY', source_system: 'old-sheet' }, u));
  }));

  // P1: invoices for recent dispatches, receipts, a broken promise and a payment hold; complaints.
  tx(() => {
    const recent = all(`SELECT d.id, d.dispatch_date, d.customer_id, MIN(dl.order_id) AS order_id, SUM(dl.qty * l.unit_price_minor) AS value, MIN(o.currency) AS currency
      FROM dispatches d JOIN dispatch_lines dl ON dl.dispatch_id = d.id JOIN order_lines l ON l.id = dl.line_id JOIN orders o ON o.id = dl.order_id
      WHERE d.status = 'posted' AND d.dispatch_date >= ? AND l.unit_price_minor IS NOT NULL GROUP BY d.id ORDER BY d.dispatch_date`, D(-150));
    let n = 0;
    const money2 = (minor) => (Math.round(minor) / 100).toFixed(2);
    for (const r of recent) {
      n++;
      setTime(Math.max(clockMs, at(END, '09:40')));
      const domestic = (r.currency || 'INR') === 'INR';
      const taxable = Math.round(r.value);
      const tax = domestic ? Math.round(taxable * 0.18) : 0;
      const inv = as('neha', (u) => safe('invoice', () => createInvoice({
        invoice_ref: `INV/${r.dispatch_date.slice(2, 4)}-${String(n).padStart(4, '0')}`, customer_id: r.customer_id, order_id: r.order_id, invoice_date: r.dispatch_date,
        due_date: addDays(r.dispatch_date, custInfo[r.customer_id]?.segment === 'export' ? 45 : 30), currency: r.currency || 'INR',
        taxable_amount: money2(taxable), tax_amount: money2(tax), gross_amount: money2(taxable + tax), owner_id: U.neha, source: 'Tally export',
      }, u)));
      if (!inv) continue;
      const due = addDays(r.dispatch_date, 30);
      if (due < D(-10) && chance(0.82)) {
        // Domestic customers often deduct 2% TDS (on the taxable value); the balance arrives by NEFT / RTGS.
        const tds = domestic && chance(0.5) ? Math.round(taxable * 0.02) : 0;
        as('neha', (u) => safe('receipt', () => recordReceipt(inv.id, {
          amount: money2(taxable + tax - tds), tds_amount: tds ? money2(tds) : undefined, mode: domestic ? pick(['neft', 'rtgs', 'upi']) : 'tt',
          effective_date: addDays(due, int(-5, 8)) > END ? END : addDays(due, int(-5, 8)), reference: `${domestic ? 'NEFT' : 'SWIFT'}${int(100000, 999999)}`,
        }, u)));
      } else if (due < END && chance(0.35)) as('kavya', (u) => safe('promise', () => setPromise(inv.id, { promise_date: addDays(END, -int(1, 6)), note: 'Customer promised transfer this week' }, u)));
    }
    // Advances received against recent export orders (30% terms); one still awaited.
    for (const o of all(`SELECT o.id, o.advance_required_minor FROM orders o WHERE o.status = 'confirmed' AND o.closed_at IS NULL AND o.advance_required_minor > 0 AND o.po_reference NOT IN ('WPB/PO/2231', 'SSG-8841') ORDER BY o.id DESC LIMIT 6`).slice(1)) {
      as('neha', (u) => safe('advance', () => recordAdvance(o.id, { amount: money2(o.advance_required_minor), effective_date: D(-int(3, 20)), mode: 'tt', reference: `SWIFT${int(100000, 999999)}` }, u)));
    }
    setFinanceAsOf({ as_of: D(-1), reconciliation: 'not_reconciled', source: 'Tally export (daily)' }, { id: U.neha });
    const holdOrder = get("SELECT o.id FROM orders o WHERE o.status = 'confirmed' AND o.closed_at IS NULL AND o.customer_id = ? ORDER BY o.id DESC LIMIT 1", C['Dhaka Power Engineering']);
    if (holdOrder) as('neha', (u) => safe('hold', () => placeHold(holdOrder.id, { reason: 'Advance payment not received (30% as per terms)' }, u)));

    const shipped = all("SELECT d.id, d.customer_id, dl.order_id, dl.line_id, l.product_id FROM dispatches d JOIN dispatch_lines dl ON dl.dispatch_id = d.id JOIN order_lines l ON l.id = dl.line_id WHERE d.status = 'posted' AND d.dispatch_date >= ? ORDER BY d.id DESC LIMIT 30", D(-120));
    const cats = ['reading_accuracy', 'display', 'communication', 'physical_damage', 'installation', 'delivery_quantity'];
    shipped.slice(0, 7).forEach((s, i) => {
      const k = as('coord', (u) => safe('complaint', () => createComplaint({
        customer_id: s.customer_id, contact_id: contactOf(s.customer_id), order_id: s.order_id, line_id: s.line_id, product_id: s.product_id, original_dispatch_id: s.id, received_date: D(-int(2, 40)),
        category_code: cats[i % cats.length], description: ['Reading differs from the reference meter by 2%', 'Two displays show missing segments', 'Modbus communication drops intermittently', 'One unit received with a cracked bezel', 'Wiring diagram does not match terminal layout', 'Short supply: 2 pieces less than packing list', 'Calibration certificate missing'][i],
        severity: ['high', 'medium', 'critical', 'medium', 'low', 'medium', 'low'][i], installation_date: chance(0.6) ? D(-int(20, 60)) : undefined,
        owner_id: U[pick(['joseph', 'coord', 'saurav', 'kavya'])], next_response_date: addWorkingDays(D(-1), int(0, 3), cal), serial_batch: chance(0.5) ? `B${int(2400, 2600)}-${int(10, 99)}` : null,
      }, u)));
      if (k && i === 2) as('joseph', (u) => safe('site visit', () => updateComplaint(k.id, { status: 'assessing', site_visit_date: D(2), site_visit_notes: 'Check RS-485 termination and earthing at site' }, u)));
      if (k && i >= 3) {
        as('joseph', (u) => safe('complaint resolve', () => updateComplaint(k.id, {
          status: 'resolved', root_cause_code: pick(['component', 'transit', 'application', 'no_fault']), resolution_code: pick(['replacement', 'technical_guidance', 'repair']),
          resolution_summary: 'Replacement units sent under warranty; customer confirmed working', resolved_date: D(-1), customer_feedback: 'Satisfied with response time', feedback_rating: int(3, 5),
        }, u)));
      }
    });
  });

  // A dispatch entered against the wrong order line and reversed (correction trail).
  tx(() => {
    const line = get(`SELECT l.id, l.confirmed_qty - l.dispatched_qty - l.cancelled_qty AS rem FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE o.status = 'confirmed' AND o.closed_at IS NULL AND l.ready_qty >= 10 AND l.confirmed_qty - l.dispatched_qty - l.cancelled_qty >= 10 LIMIT 1`);
    if (line) {
      const d = as('coord', (u) => safe('wrong dispatch', () => postDispatch({ lines: [{ line_id: line.id, qty: 5 }], dispatch_date: D(-1), reference: 'PK-9999', carrier: 'Gati', override_reason: 'Ready quantity not yet reported' }, u)));
      if (d) as('admin', (u) => safe('reverse', () => reverseDispatch(d.id, { reason: 'Entered against the wrong order — the shipment was for another customer' }, u)));
    }
  });

  // ---------------------------------------------------------------- merged-module sample data
  tx(() => {
    // Campaign enquiries: exhibition enquiries in the weeks after each show, and dealer referrals after the meet.
    for (const cp of Object.values(CMP)) {
      if (!cp.id) continue;
      const toDate = addDays(cp.start, cp.type === 'exhibition' ? 45 : 30);
      const source = cp.type === 'exhibition' ? 'exhibition' : 'dealer_referral';
      run(`UPDATE enquiries SET campaign_id = ?, source_event = COALESCE(source_event, ?) WHERE campaign_id IS NULL AND source_code = ? AND received_at >= ? AND received_at < ?
        AND customer_id IN (SELECT id FROM customers WHERE segment = ?)`, cp.id, cp.name, source, zonedToUtc(cp.start, '00:00', TZ), zonedToUtc(toDate, '00:00', TZ), cp.segment);
      run(`UPDATE customers SET campaign_id = ?, acquisition_source = ? WHERE campaign_id IS NULL AND id IN (SELECT e.customer_id FROM enquiries e WHERE e.campaign_id = ?
        AND e.received_at = (SELECT MIN(e2.received_at) FROM enquiries e2 WHERE e2.customer_id = e.customer_id))`, cp.id, source, cp.id);
    }
    // An exhibition enquiry always names its exhibition; any that fell outside a show's window were field leads.
    run("UPDATE enquiries SET source_code = 'field_visit', source_event = NULL WHERE source_code = 'exhibition' AND campaign_id IS NULL");
    // Who we met at each exhibition: the customer behind every exhibition enquiry, plus visitors with no enquiry yet.
    const ASKED = ['Asked for the datasheet and a budget price', 'Wants a demo at their plant next month', 'Comparing with their current supplier', 'Needs Modbus output for a new MCC panel', 'Checked delivery time for a project lot'];
    const NO_ENQUIRY = [
      ['Multifunction meters for panel retrofits', 'Took the catalogue; call after their budget review', 'follow_up'], ['Current transformers for an upcoming substation job', 'Project not yet awarded — check back next quarter', 'follow_up'],
      ['Energy meters for tenant billing', 'Asked for a reference site in their city', 'follow_up'], ['General product range', 'Visited out of interest, no current requirement', 'no_interest'], ['Timers and SMPS for control panels', 'Buys through a dealer; shared dealer contact', 'no_interest'],
    ];
    const stamp = new Date(clockMs).toISOString();
    for (const cp of Object.values(CMP)) {
      if (!cp.id || cp.type !== 'exhibition' || cp.start > END) continue;
      const showDay = () => addDays(cp.start, int(0, cp.days - 1));
      for (const e of all(`SELECT e.id, e.customer_id, e.contact_id, e.owner_id, (SELECT COALESCE(p.code, el.requirement) FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = e.id ORDER BY el.sort LIMIT 1) AS product
        FROM enquiries e WHERE e.campaign_id = ? ORDER BY e.received_at`, cp.id)) {
        const details = { interest: e.product, notes: pick(ASKED), met_by: e.owner_id, visited_on: showDay() };
        const visit = get('SELECT id, enquiry_id FROM exhibition_visits WHERE campaign_id = ? AND customer_id = ?', cp.id, e.customer_id);
        if (visit) update('exhibition_visits', visit.id, { ...details, enquiry_id: visit.enquiry_id || e.id, outcome: 'enquiry' });
        else insert('exhibition_visits', { ...details, campaign_id: cp.id, customer_id: e.customer_id, contact_id: e.contact_id, enquiry_id: e.id, outcome: 'enquiry', created_by: e.owner_id, created_at: stamp, updated_at: stamp });
      }
      const others = all('SELECT c.id, c.owner_id FROM customers c WHERE c.segment = ? AND c.merged_into_id IS NULL AND c.id NOT IN (SELECT customer_id FROM exhibition_visits WHERE campaign_id = ?) ORDER BY c.id', cp.segment, cp.id);
      for (const [interest, notes, outcome] of NO_ENQUIRY) {
        if (!others.length) break;
        const c = others.splice(int(0, others.length - 1), 1)[0];
        insert('exhibition_visits', { campaign_id: cp.id, customer_id: c.id, visited_on: showDay(), met_by: c.owner_id, interest, notes, outcome, created_by: c.owner_id, created_at: stamp, updated_at: stamp });
      }
    }
    // Opportunity details on open enquiries (estimate, probability, temperature, expected decision).
    for (const e of all("SELECT e.id, e.stage, c.segment FROM enquiries e JOIN customers c ON c.id = e.customer_id WHERE e.stage IN ('new','clarification','quote_to_prepare','quote_sent','awaiting_decision','on_hold')")) {
      const est = get(`SELECT SUM(COALESCE(el.qty, 50) * COALESCE(p.standard_price_minor, 150000)) AS v FROM enquiry_lines el LEFT JOIN products p ON p.id = el.product_id WHERE el.enquiry_id = ?`, e.id).v;
      const exportFx = e.segment === 'export';
      update('enquiries', e.id, {
        est_value_minor: exportFx ? Math.round((est || 0) / 83) : est, est_currency: exportFx ? 'USD' : 'INR', temperature: pick(['hot', 'warm', 'warm', 'cold']),
        probability: chance(0.4) ? pick([25, 40, 50, 60, 75]) : null, expected_decision_date: e.stage === 'on_hold' ? null : addDays(END, int(3, 85)),
      });
    }
    // Factories and priorities on orders.
    for (const o of all("SELECT o.id, (SELECT p.family FROM order_lines l JOIN products p ON p.id = l.product_id WHERE l.order_id = o.id ORDER BY l.line_no LIMIT 1) AS family, o.closed_at FROM orders o WHERE o.status = 'confirmed'")) {
      update('orders', o.id, { factory_id: o.family === 'Current transformers' ? FAC['Unit 2 — Nashik'] : FAC['Unit 1 — Vasai'], priority: !o.closed_at && chance(0.18) ? pick(['high', 'high', 'urgent']) : 'normal' });
    }
  });

  // Monthly INR targets for the domestic sales team (export sales are in other currencies and not converted).
  tx(() => as('head', (u) => {
    const fyStart = END.slice(5, 7) >= '04' ? Number(END.slice(0, 4)) : Number(END.slice(0, 4)) - 1;
    const months = Array.from({ length: 12 }, (_, i) => `${fyStart + Math.floor((3 + i) / 12)}-${String(((3 + i) % 12) + 1).padStart(2, '0')}`);
    const base = { saurav: 900000, arjun: 1200000 };
    const entries = Object.entries(base).flatMap(([k, amt]) => months.map((m, i) => ({ user_id: U[k], month: m, amount: String(Math.round(amt * (1 + (i % 3) * 0.05))) })));
    safe('targets', () => saveTargets({ entries, currency: 'INR' }, u));
  }));

  // Quotations waiting for approval (discount beyond policy), visible in the approval queue.
  tx(() => {
    setTime(Math.max(clockMs, at(END, '10:15')));
    const pendingQuote = (ownerK, customerName, items, note) => as(ownerK, (u) => {
      const cid = C[customerName];
      const q = safe('approval quote', () => createQuotation({ customer_id: cid, source_code: 'existing_customer', subject: note, owner_id: U[ownerK], lines: items.map(([code, qty, disc]) => ({ product_id: P[code].id, qty, discount_pct: disc })) }, u));
      if (q) safe('approval submit', () => submitForApproval(q.revision_id, u));
    });
    pendingQuote('saurav', 'Indus Automation', [['VIPS 98EFR', 80, 14], ['CT 400/5A', 240, 12]], 'Plant expansion — 80 metering points');
    pendingQuote('arjun', 'Bharat Electro Systems', [['VIPS 70L', 500, 22], ['VIPS 83P', 120, 20]], 'Distributor stocking order — annual rates');
  });

  // Product datasheets (generated PDFs) and links to the public product page.
  tx(() => as('admin', (u) => {
    for (const code of ['VIPS 98EFR', 'VIPS 96MF', 'VIPS 70L', 'CT 400/5A', 'VIPS 83M']) {
      const d = PRODUCTS.find((x) => x[0] === code);
      const a = safe('datasheet', () => storeAttachment({ buffer: samplePdf(`${code} datasheet — ${d[1]} — ${d[4].model}`), name: `${code.replace(/[^A-Za-z0-9]+/g, '-')}-datasheet.pdf`, entityType: 'product', entityId: P[code].id }, u));
      if (a) safe('product doc', () => addDocument(P[code].id, { title: `${code} datasheet`, doc_type: 'datasheet', attachment_id: a.id }, u));
      safe('product link', () => addDocument(P[code].id, { title: 'Product range on veritekindia.com', doc_type: 'brochure', url: 'https://www.veritekindia.com/products.html' }, u));
    }
  }));

  // Samples shared with no reply yet (the reminder asks for feedback), and a planned dispatch for tomorrow.
  tx(() => {
    for (const name of ['Agni Electro Works', 'Kilimanjaro Electricals']) {
      const cid = C[name];
      const owner = ownerKey(cid);
      as(owner, (u) => safe('sample', () => recordActivity({ customer_id: cid, contact_id: contactOf(cid), channel: 'meeting', outcome: 'sample_shared', note: 'Left a VIPS 70L sample and the catalogue with the purchase team', occurred_at: new Date(at(addWorkingDays(D(-9), 0, cal), '15:00')).toISOString() }, u)));
    }
    const ready = get(`SELECT l.id, l.ready_qty - l.dispatched_qty AS waiting FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE o.status = 'confirmed' AND o.closed_at IS NULL AND l.ready_qty - l.dispatched_qty >= 5 AND l.confirmed_qty - l.dispatched_qty - l.cancelled_qty >= 5 ORDER BY l.id DESC LIMIT 1`);
    if (ready) as('imran', (u) => safe('planned dispatch', () => postDispatch({ planned: true, planned_date: addWorkingDays(END, 1, cal), lines: [{ line_id: ready.id, qty: Math.floor(ready.waiting) }], carrier: 'VRL Logistics', vehicle_number: 'MH 48 AG 2231', boxes: 4 }, u)));
  });

  // Objects & QR register.
  tx(() => as('admin', () => seedObjects({ users: { admin: user('admin') }, products: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, v.id])), rand: () => rnd() })));
  installSecret();

  // Run the reminder evaluator as of "today" so alerts and reconnect tasks exist from the start.
  setTime(Math.max(clockMs, SIM_END));
  const evaluation = runEvaluator({ trigger: 'seed' });
  setClock(null);

  const counts = Object.fromEntries(['products', 'customers', 'contacts', 'campaigns', 'enquiries', 'quotations', 'quote_revisions', 'approvals', 'orders', 'order_lines', 'order_updates', 'dispatches', 'cancellations', 'tasks', 'activities', 'reactivation_cases', 'alerts', 'invoices', 'receipts', 'complaints', 'objects', 'attachments']
    .map((t) => [t, get(`SELECT COUNT(*) AS n FROM ${t}`).n]));
  console.log(`Sample data ready in ${((Date.now() - started) / 1000).toFixed(1)} s — ${events} simulated events.`, counts);
  console.log(`Evaluator: ${evaluation.status}`);
  if (failures.length) {
    console.log(`${failures.length} simulated step(s) were rejected by business rules (expected occasionally):`);
    for (const f of failures.slice(0, 12)) console.log(`  - ${f}`);
  }
  return { counts, failures };
}

// `node tests/sample-data.mjs` fills the EMPTY database in CRM_DATA_DIR (the tests' throwaway folder). It refuses a
// database that already has accounts, so sample records can never be mixed into real data.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let accounts = 0;
  try {
    accounts = get('SELECT COUNT(*) AS n FROM users').n;
  } catch {
    /* no tables yet */
  }
  if (accounts) {
    console.error(`Nothing was changed: ${DB_PATH} already has accounts. Sample data only goes into an empty, throwaway database.`);
    process.exit(1);
  }
  buildSampleData();
  closeDb();
}
