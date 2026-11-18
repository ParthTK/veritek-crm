// A clean installation, set up automatically the first time the CRM starts on an empty database: the sales
// regions, the product categories and models (with specifications, no prices), the object-register category
// templates, default settings and dropdowns, and one administrator. There are no sample companies, people or
// records: prices, dealer/distributor prices, minimum price, cost, configurator price changes and stock are left
// blank for the company to fill in, and factories and everyone else are added under Settings.
import crypto from 'node:crypto';
import { insert, tx, migrate } from './db.js';
import { setSetting, resetSettingsCache, installSecret } from './util.js';
import { hashPassword } from './auth.js';
import { ensureDropdownDefaults } from './services/admin.js';
import { createObjectCategories } from './object-categories.js';

export const REGIONS = [
  ['West', 'Maharashtra, Gujarat, Goa, Madhya Pradesh'],
  ['North', 'Delhi, Punjab, Haryana, Rajasthan, Uttar Pradesh'],
  ['South', 'Tamil Nadu, Karnataka, Kerala, Telangana, Andhra Pradesh'],
  ['East', 'West Bengal, Odisha, Bihar, Assam'],
  ['Export', 'Customers outside India'],
];

export const FAMILIES = ['Panel meters', 'Multifunction meters', 'Energy meters', 'Current transformers', 'Protection relays', 'Timers', 'SMPS', 'Accessories'];

// [code, name, family, details]; configurator options are [group, choice, extra lead-time days].
export const CATALOGUE = [
  ['VIPS 70L', 'Digital panel meter 72×72, LED', 'Panel meters', { model: '72×72 mm · 3½-digit LED', hsn: '90303390', lead: 10, warranty: 24, stock: 'stock', options: [['Display colour', 'Red LED', 0], ['Display colour', 'Green LED', 0], ['Auxiliary supply', '90–270 V AC', 0], ['Auxiliary supply', '24 V DC', 3]] }],
  ['VIPS 83P', 'Programmable panel meter 96×96', 'Panel meters', { model: '96×96 mm · programmable input', hsn: '90303390', lead: 12, warranty: 24, stock: 'stock', options: [['Output', 'None', 0], ['Output', '2 relay outputs', 2], ['Output', '4–20 mA retransmission', 3]] }],
  ['VIPS 44D', 'Dual-display ammeter / voltmeter', 'Panel meters', { model: '96×48 mm · dual 4-digit display', hsn: '90303390', lead: 10, warranty: 24, stock: 'stock' }],
  ['VIPS 98EFR', 'Multifunction power meter, RS-485', 'Multifunction meters', { model: 'Class 0.5S · 63 parameters · Modbus RTU', hsn: '90303390', lead: 18, warranty: 36, stock: 'made_to_order', options: [['Communication', 'RS-485 Modbus RTU', 0], ['Communication', 'Modbus TCP (Ethernet)', 5], ['Accuracy class', 'Class 1.0', 0], ['Accuracy class', 'Class 0.5S', 0], ['Accuracy class', 'Class 0.2S', 7]] }],
  ['VIPS 96MF', 'Multifunction meter, Modbus TCP', 'Multifunction meters', { model: '96×96 mm · Modbus TCP', hsn: '90303390', lead: 15, warranty: 36, stock: 'made_to_order', options: [['Auxiliary supply', '90–270 V AC', 0], ['Auxiliary supply', '24–60 V DC', 3]] }],
  ['VIPS EM3', 'Three-phase energy meter, class 1', 'Energy meters', { model: 'Class 1 · CT-operated · pulse output', hsn: '90283010', lead: 12, warranty: 24, stock: 'stock' }],
  ['VIPS EM1', 'Single-phase DIN-rail energy meter', 'Energy meters', { model: '1-module DIN rail · 5(32) A', hsn: '90283010', lead: 7, warranty: 24, stock: 'stock' }],
  ['CT 100/5A', 'Resin-cast current transformer 100/5 A', 'Current transformers', { model: 'Class 1 · 5 VA · moulded', hsn: '85043100', lead: 8, warranty: 12, stock: 'stock' }],
  ['CT 200/5A', 'Resin-cast current transformer 200/5 A', 'Current transformers', { model: 'Class 1 · 5 VA · moulded', hsn: '85043100', lead: 8, warranty: 12, stock: 'stock' }],
  ['CT 400/5A', 'Resin-cast current transformer 400/5 A', 'Current transformers', { model: 'Class 0.5 · 10 VA · moulded', hsn: '85043100', lead: 10, warranty: 12, stock: 'stock', options: [['Accuracy class', 'Class 1', 0], ['Accuracy class', 'Class 0.5', 2]] }],
  ['CT 800/5A', 'Ring-type current transformer 800/5 A', 'Current transformers', { model: 'Ring type · 15 VA', hsn: '85043100', lead: 12, warranty: 12, stock: 'made_to_order' }],
  ['VIPS PT-110', 'Panel-mount potential transformer', 'Current transformers', { model: '415/110 V · 50 VA', hsn: '85043100', lead: 15, warranty: 12, stock: 'made_to_order' }],
  ['VIPS MOD-485', 'RS-485 communication module', 'Accessories', { model: 'Plug-in · isolated RS-485', hsn: '85176290', lead: 7, warranty: 18, stock: 'stock' }],
  ['VIPS DSP-7', 'Replacement display module', 'Accessories', { model: 'Spare display for 72/96 mm meters', hsn: '90309000', lead: 5, warranty: 6, stock: 'stock' }],
  ['VIPS 83M', 'Earth leakage relay with CBCT input', 'Protection relays', { model: '30 mA – 30 A adjustable · 2 C/O contacts', hsn: '85364900', lead: 14, warranty: 24, stock: 'made_to_order' }],
  ['VIPS 99MF', 'Multifunction timer, 8 functions', 'Timers', { model: '48×48 mm · 0.1 s – 999 h', hsn: '91070000', lead: 7, warranty: 18, stock: 'stock' }],
  ['VIPS 99SD', 'Star-delta timer', 'Timers', { model: 'DIN rail · 0–60 s star time', hsn: '91070000', lead: 7, warranty: 18, stock: 'stock' }],
  ['VIPS 2424', 'SMPS 24 V DC, 1 A, DIN rail', 'SMPS', { model: '24 W · DIN rail', hsn: '85044090', lead: 6, warranty: 24, stock: 'stock' }],
  ['VIPS 24120', 'SMPS 24 V DC, 5 A, DIN rail', 'SMPS', { model: '120 W · DIN rail', hsn: '85044090', lead: 8, warranty: 24, stock: 'stock' }],
];

/** Creates the first super administrator, who must change the password at first sign-in. Returns the id. */
export function bootstrapAdmin() {
  const email = process.env.CRM_ADMIN_EMAIL || 'admin@localhost';
  const password = process.env.CRM_ADMIN_PASSWORD || `Vt-${crypto.randomBytes(6).toString('base64url')}9`;
  const stamp = new Date().toISOString();
  const id = insert('users', { name: 'Administrator', email, role: 'super_admin', department: 'management', login_enabled: 1, password_hash: hashPassword(password), must_change_password: 1, active: 1, created_at: stamp, updated_at: stamp });
  console.log(`Created the first administrator: ${email}${process.env.CRM_ADMIN_PASSWORD ? '' : ` / temporary password ${password}`} (must be changed at first sign-in)`);
  return id;
}

export function cleanInstallation() {
  migrate();
  resetSettingsCache();
  ensureDropdownDefaults();
  const stamp = new Date().toISOString();
  tx(() => {
    REGIONS.forEach(([name, states], i) => insert('regions', { name, states, active: 1, sort_order: i }));
    const adminId = bootstrapAdmin();
    setSetting('escalation', { defaultManagerId: adminId });
    const cat = {};
    FAMILIES.forEach((name, i) => { cat[name] = insert('product_categories', { name, description: null, active: 1, sort_order: i, created_at: stamp }); });
    for (const [code, name, family, d] of CATALOGUE) {
      const pid = insert('products', {
        code, name, family, category_id: cat[family], model: d.model, hsn: d.hsn, default_unit: 'pcs', integer_qty: 1, price_currency: 'INR',
        gst_rate: 18, warranty_months: d.warranty, lead_time_days: d.lead, stock_type: d.stock, description: `${name}. ${d.model}.`,
        specs: JSON.stringify({ Model: d.model, 'HSN code': d.hsn, Warranty: `${d.warranty} months` }), active: 1, created_at: stamp, updated_at: stamp,
      });
      (d.options || []).forEach(([group, choice, leadDelta], i) => insert('product_options', {
        product_id: pid, group_name: group, name: choice, price_delta_minor: 0, cost_delta_minor: 0, lead_time_delta: leadDelta, active: 1, sort_order: i,
      }));
    }
    createObjectCategories(adminId);
  });
  resetSettingsCache();
  installSecret();
  console.log(`Clean installation ready: ${CATALOGUE.length} products (prices blank), ${REGIONS.length} regions.`);
}
