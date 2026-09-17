// Demo data: replays ~18 months of a manufacturer's sales and operations through the real
// service layer (with a pinned clock) so every history, version and timeline is consistent.
import { pathToFileURL } from 'node:url';
import { db, all, get, run, insert, update, migrate, tx } from './db.js';
import { hashPassword } from './auth.js';
import { setClock, today, addDays, daysBetween, round2, nowIso, nextNumber } from './util.js';
import { createLead, moveLead, logActivity } from './services/leads.js';
import { createQuotation, updateQuotation, submitQuotation, decideApproval, sendQuotation, setQuotationStatus } from './services/quotes.js';
import {
  convertQuotationToOrder, changeOrderStage, updateProduction, createDispatch, updateDispatch, recordPayment, createCreditNote, loadOrderRow,
} from './services/orders.js';
import { buildSummary, runAutomation } from './services/automation.js';
import { LOSS_REASONS, WIN_REASONS, COMPETITORS, QUOTE_AWAITING } from '../shared/constants.js';

export const DEMO_PASSWORD = 'Veritek@123';

// ------------------------------------------------------------------ deterministic randomness
let s = 20260917;
const rand = () => {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const weighted = (pairs) => {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let x = rand() * total;
  for (const [v, w] of pairs) {
    x -= w;
    if (x <= 0) return v;
  }
  return pairs[0][0];
};

// ------------------------------------------------------------------ reference data
const REGIONS = {
  'West India': { states: { Maharashtra: ['Mumbai', 'Pune', 'Nashik', 'Aurangabad', 'Nagpur', 'Thane'], Gujarat: ['Ahmedabad', 'Vadodara', 'Surat', 'Rajkot'], Goa: ['Verna'], 'Madhya Pradesh': ['Indore', 'Bhopal'] } },
  'North India': { states: { Delhi: ['New Delhi'], Haryana: ['Gurugram', 'Faridabad', 'Manesar'], Punjab: ['Ludhiana', 'Mohali'], 'Uttar Pradesh': ['Noida', 'Lucknow', 'Kanpur'], Rajasthan: ['Jaipur', 'Neemrana'] } },
  'South India': { states: { Karnataka: ['Bengaluru', 'Mysuru', 'Hubballi'], 'Tamil Nadu': ['Chennai', 'Coimbatore', 'Hosur'], Telangana: ['Hyderabad'], Kerala: ['Kochi'], 'Andhra Pradesh': ['Visakhapatnam', 'Sri City'] } },
  'East India': { states: { 'West Bengal': ['Kolkata', 'Durgapur'], Odisha: ['Bhubaneswar'], Jharkhand: ['Jamshedpur'], Bihar: ['Patna'], Assam: ['Guwahati'] } },
  Export: { states: { UAE: ['Dubai'], Kenya: ['Nairobi'], Bangladesh: ['Dhaka'], 'Sri Lanka': ['Colombo'], Nepal: ['Kathmandu'] } },
};
const STATE_CODES = { Maharashtra: '27', Gujarat: '24', Goa: '30', 'Madhya Pradesh': '23', Delhi: '07', Haryana: '06', Punjab: '03', 'Uttar Pradesh': '09', Rajasthan: '08', Karnataka: '29', 'Tamil Nadu': '33', Telangana: '36', Kerala: '32', 'Andhra Pradesh': '37', 'West Bengal': '19', Odisha: '21', Jharkhand: '20', Bihar: '10', Assam: '18' };

const FIRST = ['Rahul', 'Sanjay', 'Anil', 'Prakash', 'Nitin', 'Manoj', 'Sunil', 'Ajay', 'Vivek', 'Harish', 'Ramesh', 'Girish', 'Kiran', 'Pooja', 'Swati', 'Anjali', 'Divya', 'Kavya', 'Shalini', 'Rekha', 'Farhan', 'Joseph', 'Gurpreet', 'Arvind', 'Mahesh', 'Sachin', 'Venkat', 'Srinivas', 'Abhijit', 'Tanmay', 'Nandini', 'Ritu', 'Zubin', 'Hitesh', 'Bhavesh'];
const LAST = ['Joshi', 'Kulkarni', 'Patel', 'Mehta', 'Sharma', 'Gupta', 'Singh', 'Reddy', 'Naidu', 'Iyer', 'Menon', 'Nair', 'Das', 'Ghosh', 'Mukherjee', 'Chatterjee', 'Agarwal', 'Jain', 'Desai', 'Shetty', 'Rao', 'Pillai', 'Bhatt', 'Chauhan', 'Malhotra', 'Kapoor', 'Saxena', 'Thakur', 'Pandey', 'Mishra'];
const DESIGNATIONS = {
  owner: ['Managing Director', 'Director', 'Proprietor', 'CEO'],
  purchase: ['Purchase Manager', 'Head - Procurement', 'Sr. Purchase Executive'],
  technical: ['Electrical Engineer', 'Maintenance Head', 'Project Manager', 'Energy Manager'],
  accounts: ['Accounts Manager', 'Finance Executive'],
  site: ['Site Engineer', 'Plant Head', 'Facility Manager'],
};

const ESTABLISHED = [
  ['Sahyadri Auto Components Pvt. Ltd.', 'oem', 'Automotive', 'Maharashtra', 'Pune', 'key_account'],
  ['Konkan Pharma Industries Ltd.', 'direct', 'Pharma', 'Maharashtra', 'Thane', 'high_value'],
  ['Deccan Electricals & Switchgear', 'dealer', 'Infrastructure', 'Maharashtra', 'Pune', 'high_value'],
  ['Narmada Textile Mills Ltd.', 'direct', 'Textiles', 'Gujarat', 'Surat', 'regular'],
  ['Sabarmati Infra Projects Pvt. Ltd.', 'epc', 'Infrastructure', 'Gujarat', 'Ahmedabad', 'key_account'],
  ['Western Power Solutions', 'distributor', 'Utilities', 'Maharashtra', 'Mumbai', 'key_account'],
  ['Godavari Food Processing Pvt. Ltd.', 'direct', 'Food processing', 'Maharashtra', 'Nashik', 'regular'],
  ['Marine Drive Hospitality Group', 'direct', 'Hospitality', 'Maharashtra', 'Mumbai', 'high_value'],
  ['Malwa Smart Building Systems', 'system_integrator', 'Real estate', 'Madhya Pradesh', 'Indore', 'regular'],
  ['Vidarbha Steel & Alloys Ltd.', 'direct', 'Steel & metals', 'Maharashtra', 'Nagpur', 'high_value'],
  ['Omkar Electrical Contractors', 'contractor', 'Infrastructure', 'Maharashtra', 'Pune', 'regular'],
  ['Shreeji Panel Industries', 'oem', 'Infrastructure', 'Gujarat', 'Vadodara', 'high_value'],
  ['Yamuna Data Centres Pvt. Ltd.', 'direct', 'Data centre', 'Uttar Pradesh', 'Noida', 'key_account'],
  ['Punjab Agro Processors Ltd.', 'direct', 'Food processing', 'Punjab', 'Ludhiana', 'regular'],
  ['Aravali Engineering Consultants', 'consultant', 'Infrastructure', 'Haryana', 'Gurugram', 'regular'],
  ['Capital Electric Traders', 'dealer', 'Retail', 'Delhi', 'New Delhi', 'high_value'],
  ['Neemrana Auto Parts Pvt. Ltd.', 'oem', 'Automotive', 'Rajasthan', 'Neemrana', 'high_value'],
  ['Awadh Healthcare & Hospitals', 'direct', 'Healthcare', 'Uttar Pradesh', 'Lucknow', 'regular'],
  ['Kanpur Municipal Water Works', 'government', 'Water treatment', 'Uttar Pradesh', 'Kanpur', 'regular'],
  ['Pinkcity Hotels & Resorts', 'direct', 'Hospitality', 'Rajasthan', 'Jaipur', 'low_value'],
  ['Himalaya Power Distributors', 'distributor', 'Utilities', 'Haryana', 'Faridabad', 'high_value'],
  ['Cauvery Cement Works Ltd.', 'direct', 'Cement', 'Tamil Nadu', 'Coimbatore', 'high_value'],
  ['Garden City Tech Parks Pvt. Ltd.', 'direct', 'Real estate', 'Karnataka', 'Bengaluru', 'key_account'],
  ['Kaveri Automation Systems', 'system_integrator', 'Automotive', 'Tamil Nadu', 'Hosur', 'regular'],
  ['Charminar Pharma Labs Ltd.', 'direct', 'Pharma', 'Telangana', 'Hyderabad', 'high_value'],
  ['Coromandel Electricals', 'dealer', 'Retail', 'Tamil Nadu', 'Chennai', 'regular'],
  ['Malabar Coast Seafoods Exports', 'direct', 'Food processing', 'Kerala', 'Kochi', 'low_value'],
  ['Deccan Plateau EPC Ltd.', 'epc', 'Infrastructure', 'Telangana', 'Hyderabad', 'high_value'],
  ['Nilgiri Distributors & Agencies', 'distributor', 'Utilities', 'Karnataka', 'Bengaluru', 'regular'],
  ['Vizag Port Logistics Ltd.', 'direct', 'Infrastructure', 'Andhra Pradesh', 'Visakhapatnam', 'regular'],
  ['Hooghly Jute & Textiles Ltd.', 'direct', 'Textiles', 'West Bengal', 'Kolkata', 'regular'],
  ['Kalinga Steel Processing Pvt. Ltd.', 'direct', 'Steel & metals', 'Odisha', 'Bhubaneswar', 'high_value'],
  ['Subarnarekha Engineering Works', 'oem', 'Steel & metals', 'Jharkhand', 'Jamshedpur', 'regular'],
  ['Eastern Electric Stores', 'dealer', 'Retail', 'West Bengal', 'Kolkata', 'low_value'],
  ['Gulf Facility Management LLC', 'distributor', 'Real estate', 'UAE', 'Dubai', 'high_value'],
  ['Nairobi Power Engineering Ltd.', 'distributor', 'Utilities', 'Kenya', 'Nairobi', 'regular'],
];

const PROSPECT_PREFIX = ['Shree', 'Apex', 'Sai', 'Om', 'Precision', 'Nova', 'Vertex', 'Sunrise', 'Indus', 'Tirupati', 'Ashoka', 'Bharat', 'Pioneer', 'Elite', 'Prime', 'Orbit', 'Zenith', 'Trident', 'Suvidha', 'Matrix', 'Galaxy', 'Everest', 'Sapphire', 'Kohinoor', 'Rudra', 'Vishwa', 'Aadhya', 'Srijan'];
const PROSPECT_SUFFIX = [
  ['Engineering Pvt. Ltd.', 'oem', 'Steel & metals'], ['Electricals', 'dealer', 'Retail'], ['Infra Projects Ltd.', 'epc', 'Infrastructure'],
  ['Automation Solutions', 'system_integrator', 'Automotive'], ['Power Systems', 'contractor', 'Utilities'], ['Polymers Ltd.', 'direct', 'Chemicals'],
  ['Lifesciences Pvt. Ltd.', 'direct', 'Pharma'], ['Spinning Mills', 'direct', 'Textiles'], ['Hotels & Resorts', 'direct', 'Hospitality'],
  ['Developers', 'direct', 'Real estate'], ['Auto Components', 'oem', 'Automotive'], ['Foods Pvt. Ltd.', 'direct', 'Food processing'],
  ['Multispeciality Hospital', 'direct', 'Healthcare'], ['Cloud Data Centre', 'direct', 'Data centre'], ['Energy Consultants', 'consultant', 'Utilities'],
  ['Switchgear Distributors', 'distributor', 'Utilities'], ['Cold Storage Pvt. Ltd.', 'direct', 'Food processing'], ['Educational Trust', 'direct', 'Education'],
];

const CATEGORIES = [
  ['Energy Meters', 'Single and three-phase multifunction, power quality and prepaid meters'],
  ['IoT Gateways', 'Edge gateways and wireless nodes for remote monitoring'],
  ['Control Panels', 'APFC, metering, energy monitoring and DG synchronisation panels (made to order)'],
  ['Controllers', 'Power factor controllers, RTUs, DG controllers and PLC kits'],
  ['Sensors & CTs', 'Current transformers, Rogowski coils and environmental sensors'],
  ['Software & Services', 'Energy management cloud, commissioning and AMC'],
];

// [category, sku, name, model, std, dealer, distributor, min, cost, lead, stock_type, warranty, hsn, specs, qtyRange]
const PRODUCTS = [
  ['Energy Meters', 'VT-EM100', 'Single-phase Multifunction Meter', 'EM100-1P', 2850, 2350, 2150, 2250, 1650, 7, 'stock', 24, '90283010', { Accuracy: 'Class 1.0', Display: 'LCD', Communication: 'RS485 Modbus RTU', Mounting: 'DIN rail' }, [20, 300]],
  ['Energy Meters', 'VT-EM300', 'Three-phase Multifunction Meter', 'EM300-3P', 6900, 5700, 5300, 5450, 3950, 7, 'stock', 24, '90283010', { Accuracy: 'Class 0.5S', Parameters: '63 electrical parameters', Communication: 'RS485 Modbus RTU', Size: '96x96 mm' }, [10, 250]],
  ['Energy Meters', 'VT-EM500', 'Power Quality Analyzer', 'EM500-PQ', 18500, 15800, 14900, 15200, 10400, 14, 'stock', 24, '90283010', { Accuracy: 'Class 0.2S', Harmonics: 'Up to 63rd', Logging: '8 GB', Communication: 'Ethernet + RS485' }, [2, 40]],
  ['Energy Meters', 'VT-EM700', 'Multi-circuit Meter (12 channel)', 'EM700-MC12', 24000, 20400, 19200, 19800, 13900, 14, 'stock', 24, '90283010', { Channels: '12 single / 4 three-phase', Communication: 'Modbus TCP', Mounting: 'DIN rail' }, [2, 60]],
  ['Energy Meters', 'VT-EM-PPD', 'Smart Prepaid Meter', 'PPD-1P', 8400, 7100, 6700, 6900, 4950, 21, 'stock', 24, '90283010', { Type: 'Dual source (grid + DG)', Recharge: 'Mobile app / RFID', Communication: 'LoRa' }, [30, 400]],
  ['IoT Gateways', 'VT-GW10', 'Edge IoT Gateway', 'GW10', 21500, 18200, 17000, 17500, 11800, 10, 'stock', 18, '85176290', { Ports: '2x RS485, 1x Ethernet', Cloud: 'MQTT / HTTPS', Storage: '32 GB buffer' }, [2, 40]],
  ['IoT Gateways', 'VT-GW20', 'Industrial Edge Analytics Gateway', 'GW20-EA', 38000, 32300, 30400, 31200, 21500, 14, 'stock', 18, '85176290', { CPU: 'Quad-core ARM', Ports: '4x RS485, 2x Ethernet, 4 DI', Analytics: 'On-device rules engine' }, [1, 20]],
  ['IoT Gateways', 'VT-LORA', 'LoRaWAN Wireless Meter Node', 'LN-868', 9800, 8300, 7800, 8000, 5600, 14, 'stock', 18, '85176290', { Frequency: 'IN865', Range: 'Up to 5 km', Battery: '5 years' }, [5, 120]],
  ['Control Panels', 'VT-APFC', 'APFC Panel', 'APFC-100', 285000, 255000, 245000, 238000, 192000, 28, 'made_to_order', 12, '85371000', { Rating: '100 kVAr base', Steps: '8 step', Enclosure: 'CRCA powder coated' }, [1, 3]],
  ['Control Panels', 'VT-MLDB', 'Metering & LT Distribution Board', 'MLDB-630', 165000, 148000, 142000, 138000, 112000, 25, 'made_to_order', 12, '85371000', { Incomer: '630 A ACB', Outgoings: '12 MCCB', Metering: 'Class 0.5S on all feeders' }, [1, 4]],
  ['Control Panels', 'VT-EMS-PNL', 'Energy Monitoring Panel', 'EMS-12', 220000, 196000, 188000, 184000, 146000, 21, 'made_to_order', 12, '85371000', { Meters: '12 x EM300', Gateway: 'GW20 integrated', Display: '10" HMI' }, [1, 4]],
  ['Control Panels', 'VT-SYNC', 'DG Synchronisation Panel', 'SYNC-2DG', 780000, 705000, 680000, 660000, 552000, 42, 'made_to_order', 12, '85371000', { DG: '2 x 500 kVA', Control: 'Auto load sharing', Breakers: 'Motorised ACB' }, [1, 2]],
  ['Controllers', 'VT-PFC12', '12-step Power Factor Controller', 'PFC-12', 14500, 12200, 11500, 11800, 7900, 7, 'stock', 24, '90328990', { Steps: '12', Display: 'Graphic LCD', Alarm: 'THD / over-temperature' }, [2, 30]],
  ['Controllers', 'VT-RTU200', 'Remote Terminal Unit', 'RTU-200', 64000, 55000, 52000, 53500, 38500, 21, 'stock', 18, '90328990', { IO: '16 DI / 8 DO / 8 AI', Protocols: 'IEC 104, Modbus', Power: '24 V DC' }, [1, 12]],
  ['Controllers', 'VT-DGC', 'Diesel Generator Controller', 'DGC-5', 32000, 27500, 26000, 26800, 18600, 10, 'stock', 18, '90328990', { Modes: 'AMF / manual / remote', Communication: 'RS485 + GSM' }, [1, 15]],
  ['Controllers', 'VT-PLC-M', 'Modular PLC Kit', 'PLC-M16', 48000, 41500, 39500, 40500, 29800, 14, 'stock', 18, '90328990', { CPU: '32-bit', IO: 'Expandable to 256', Programming: 'IEC 61131-3' }, [1, 10]],
  ['Sensors & CTs', 'VT-CT-SC', 'Split-core CT 100-600 A', 'CT-SC600', 1450, 1180, 1100, 1120, 720, 5, 'stock', 12, '85043100', { Ratio: '100-600/5 A', Class: '1.0', Aperture: '36 mm' }, [30, 600]],
  ['Sensors & CTs', 'VT-RCT', 'Rogowski Coil Set (3-phase)', 'RCT-3', 11500, 9800, 9300, 9500, 6400, 10, 'stock', 12, '85043100', { Range: 'Up to 5000 A', Length: '600 mm' }, [2, 40]],
  ['Sensors & CTs', 'VT-TH', 'Temperature & Humidity Sensor', 'TH-485', 3200, 2650, 2500, 2550, 1650, 5, 'stock', 12, '90258090', { Range: '-20 to 80 °C', Communication: 'RS485 Modbus' }, [5, 100]],
  ['Software & Services', 'VT-EMS-CLOUD', 'Energy Management Cloud (annual, per site)', 'EMS-CLOUD', 60000, 54000, 51000, 48000, 12000, 3, 'service', 12, '998313', { Users: 'Unlimited', Reports: 'ISO 50001 dashboards', Retention: '5 years' }, [1, 12]],
  ['Software & Services', 'VT-COMM', 'Installation & Commissioning (per man-day)', 'SRV-COMM', 9500, 9500, 9500, 7600, 4200, 5, 'service', 0, '998719', { Scope: 'Site engineer, testing & handover' }, [2, 12]],
  ['Software & Services', 'VT-AMC', 'Annual Maintenance Contract', 'SRV-AMC', 45000, 42000, 40000, 36000, 16000, 3, 'service', 0, '998719', { Visits: '4 preventive + breakdown', Response: '48 hours' }, [1, 4]],
];

const OPTIONS = {
  'VT-GW10': [['Connectivity', 'Ethernet only', -2000, -1400], ['Connectivity', '4G LTE', 0, 0], ['Connectivity', '4G LTE + Wi-Fi', 1800, 1100], ['Protocol pack', 'Modbus', 0, 0], ['Protocol pack', 'Modbus + BACnet', 4500, 1500], ['Protocol pack', 'IEC 61850', 9000, 3500]],
  'VT-GW20': [['Connectivity', 'Dual Ethernet', 0, 0], ['Connectivity', '4G LTE + Wi-Fi', 3500, 2100], ['I/O expansion', 'None', 0, 0], ['I/O expansion', '8 DI + 4 AI module', 6500, 3900]],
  'VT-APFC': [['Rating', '100 kVAr', 0, 0], ['Rating', '150 kVAr', 85000, 64000], ['Rating', '200 kVAr', 155000, 118000], ['Switching', 'Contactor', 0, 0], ['Switching', 'Thyristor (transient-free)', 68000, 49000], ['Enclosure', 'Indoor IP42', 0, 0], ['Enclosure', 'Outdoor IP55', 22000, 15500]],
  'VT-EMS-PNL': [['Meters', '12 meters', 0, 0], ['Meters', '24 meters', 88000, 61000], ['HMI', '10" HMI', 0, 0], ['HMI', '15" HMI with SCADA licence', 42000, 27000]],
  'VT-EM300': [['Communication', 'RS485 Modbus RTU', 0, 0], ['Communication', 'Modbus TCP (Ethernet)', 1600, 950]],
};

const CAMPAIGNS = [
  { name: 'Edge Gateway GW20 launch webinar', type: 'product_launch', location: 'Online', start: -330, end: -330, cost: 120000, leads: 18, status: 'completed', category: 'IoT Gateways' },
  { name: 'Smart Buildings Summit 2025', type: 'exhibition', location: 'BIEC, Bengaluru', start: -285, end: -283, cost: 600000, leads: 16, status: 'completed', region: 'South India', stall: 'Hall 2, B-14' },
  { name: 'Elecrama 2026', type: 'exhibition', location: 'India Expo Mart, Greater Noida', start: -207, end: -203, cost: 1850000, leads: 44, status: 'completed', stall: 'Hall 4, D-22' },
  { name: 'Dealer Meet West 2026', type: 'dealer_meet', location: 'Hyatt Regency, Pune', start: -95, end: -95, cost: 450000, leads: 12, status: 'completed', region: 'West India' },
  { name: 'Automation Expo 2026', type: 'exhibition', location: 'Bombay Exhibition Centre, Mumbai', start: -29, end: -26, cost: 1200000, leads: 34, status: 'completed', stall: 'Hall 1, A-31' },
  { name: 'Energy Efficiency Expo Chennai 2026', type: 'exhibition', location: 'Chennai Trade Centre', start: 55, end: 57, cost: 550000, leads: 0, status: 'planned', region: 'South India', stall: 'Stall 118' },
];

// ------------------------------------------------------------------ simulation engine
const agenda = new Map();
let currentDay;
const errors = [];
function at(day, fn, label) {
  const d = day < currentDay ? currentDay : day;
  if (!agenda.has(d)) agenda.set(d, []);
  agenda.get(d).push({ fn, label });
}
function exec(label, fn) {
  try {
    return fn();
  } catch (err) {
    errors.push(`${currentDay} ${label}: ${err.message}`);
    return null;
  }
}

const U = {}; // role key -> user row
const usersBy = (pred) => Object.values(U).filter(pred);
const execsIn = (regionId) => usersBy((u) => u.role === 'sales_executive' && u.region_id === regionId);
const rmOf = (regionId) => usersBy((u) => u.role === 'regional_manager' && u.region_id === regionId)[0] || U.saleshead;
const phone = () => `+91 9${ri(100000000, 999999999)}`;
const personName = () => `${pick(FIRST)} ${pick(LAST)}`;
const slug = (name) => name.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 14);

function gstin(state) {
  const code = STATE_CODES[state];
  if (!code) return null;
  const L = () => String.fromCharCode(65 + ri(0, 25));
  return `${code}${L()}${L()}${L()}${L()}${L()}${ri(1000, 9999)}${L()}1Z${ri(1, 9)}`;
}

function regionOfState(state) {
  return Object.entries(REGIONS).find(([, r]) => r.states[state])?.[0];
}

function addContacts(customerId, name, roles) {
  const domain = `${slug(name)}.example`;
  roles.forEach((role, i) => {
    const n = personName();
    insert('contacts', {
      customer_id: customerId, name: n, contact_role: role, designation: pick(DESIGNATIONS[role] || ['Manager']), phone: phone(),
      whatsapp: chance(0.8) ? phone() : null, email: `${n.split(' ')[0].toLowerCase()}@${domain}`,
      preferred_channel: pick(['phone', 'whatsapp', 'whatsapp', 'email']), is_primary: i === 0 ? 1 : 0, created_at: nowIso(),
    });
  });
}

// Per-customer behaviour used by the simulation.
const behaviour = new Map();
function customerBehaviour(customer) {
  if (!behaviour.has(customer.id)) {
    const repeatTypes = ['dealer', 'distributor', 'oem', 'system_integrator', 'contractor', 'epc'];
    behaviour.set(customer.id, {
      pay: weighted([['prompt', 50], ['late', 35], ['very_late', 15]]),
      tds: chance(0.3),
      cycle: repeatTypes.includes(customer.customer_type) ? ri(45, 110) : ri(120, 260),
      repeat: repeatTypes.includes(customer.customer_type) ? chance(0.75) : chance(0.35),
      churnAfter: chance(0.2) ? ri(120, 330) : null,
    });
  }
  return behaviour.get(customer.id);
}

let prospectSerial = 0;
function newProspectPayload(regionName) {
  const region = REGIONS[regionName];
  const state = pick(Object.keys(region.states));
  let name;
  let suffix;
  do {
    suffix = pick(PROSPECT_SUFFIX);
    name = `${pick(PROSPECT_PREFIX)} ${suffix[0]}`;
    prospectSerial++;
  } while (get('SELECT id FROM customers WHERE name = ?', name) && prospectSerial < 5000);
  if (get('SELECT id FROM customers WHERE name = ?', name)) name = `${name} (${pick(region.states[state])})`;
  const city = pick(region.states[state]);
  const exportCustomer = regionName === 'Export';
  return {
    name, customer_type: suffix[1], industry: suffix[2], city, state,
    country: exportCustomer ? state : 'India', pincode: exportCustomer ? null : String(ri(110001, 799999)),
    billing_address: `${ri(1, 250)}, ${pick(['Industrial Estate', 'MIDC', 'Business Park', 'Tech Park', 'Ring Road', 'Industrial Area'])}, ${city}`,
    shipping_address: `Plant ${ri(1, 3)}, ${pick(['Phase II', 'Sector 5', `Survey No. ${ri(10, 400)}`])}, ${city}`,
    region_id: get('SELECT id FROM regions WHERE name = ?', regionName).id, contact_name: personName(),
    contact_role: pick(['purchase', 'owner', 'technical']), designation: pick(DESIGNATIONS.purchase), phone: phone(),
    email: `enquiry@${slug(name)}.example`,
  };
}

const products = {};
const productsByCategory = {};

function buildItems(category, primary, qty) {
  const items = [];
  const opts = all('SELECT * FROM product_options WHERE product_id = ?', primary.id);
  const optionIds = [];
  for (const group of [...new Set(opts.map((o) => o.group_name))]) {
    optionIds.push(pick(opts.filter((o) => o.group_name === group)).id);
  }
  items.push({ product_id: primary.id, qty, option_ids: optionIds });
  if (category === 'Energy Meters' && chance(0.55)) items.push({ product_id: products['VT-CT-SC'].id, qty: qty * 3 });
  if (category === 'Energy Meters' && chance(0.3)) items.push({ product_id: products['VT-GW10'].id, qty: Math.max(1, Math.round(qty / 25)) });
  if (category === 'IoT Gateways' && chance(0.45)) items.push({ product_id: products['VT-EMS-CLOUD'].id, qty: Math.max(1, Math.round(qty / 4)) });
  if (category === 'Control Panels' && chance(0.65)) items.push({ product_id: products['VT-COMM'].id, qty: ri(2, 6) });
  if (category === 'Controllers' && chance(0.4)) items.push({ product_id: products['VT-CT-SC'].id, qty: qty * 3 });
  if (category === 'Software & Services' && primary.sku === 'VT-EMS-CLOUD' && chance(0.5)) items.push({ product_id: products['VT-GW10'].id, qty });
  return items;
}

function estimate(items, priceList) {
  return items.reduce((s, it) => {
    const p = get('SELECT * FROM products WHERE id = ?', it.product_id);
    const price = priceList === 'dealer' ? p.dealer_price : priceList === 'distributor' ? p.distributor_price : p.standard_price;
    return s + it.qty * price;
  }, 0);
}

const REQ_TEXT = {
  'Energy Meters': ['Sub-metering for {n} feeders across the plant', 'Replacement of old analog meters with smart meters', 'Tenant billing meters for new commercial tower', 'Power quality audit and harmonic monitoring'],
  'IoT Gateways': ['Remote monitoring of DG sets and transformers', 'Connect existing Modbus meters to cloud dashboard', 'Edge gateway for multi-site energy analytics', 'BMS integration of electrical parameters'],
  'Control Panels': ['APFC panel to avoid PF penalty on electricity bill', 'LT distribution board with feeder-wise metering', 'Energy monitoring panel for new production block', 'DG synchronisation for 2 x 500 kVA sets'],
  Controllers: ['PF controller retrofit in existing capacitor panels', 'RTU for substation automation', 'DG controllers with remote start/stop', 'PLC-based load shedding scheme'],
  'Sensors & CTs': ['Split-core CTs for retrofit without shutdown', 'Rogowski coils for high-current busbars', 'Temperature monitoring in cold storage'],
  'Software & Services': ['Energy management software for ISO 50001', 'AMC for installed metering system', 'Commissioning support for panel installation'],
};

const CALL_NOTES = [
  ['Discussed application and existing setup', 'Interested, wants technical details', null],
  ['Explained product range and past installations in same industry', 'Asked for catalogue and reference list', null],
  ['Clarified quantity and site conditions with maintenance team', 'Requirement confirmed, budget approved in principle', 'Concerned about delivery timeline'],
  ['Technical presentation to plant engineering team', 'Positive, comparing with existing vendor', 'Wants Modbus TCP support'],
  ['Follow-up call on quotation', 'Evaluating internally, decision in a week', 'Price higher than competitor'],
  ['Negotiation meeting with purchase head', 'Asked for better price and extended warranty', 'Requested 45-day credit'],
];

// ------------------------------------------------------------------ lead lifecycle
function scheduleLead(day, opts) {
  at(day, () => exec('create lead', () => {
    const regionName = opts.regionName || weighted([['West India', 40], ['North India', 22], ['South India', 22], ['East India', 10], ['Export', 6]]);
    let customerId = opts.customerId;
    if (!customerId && opts.existingShare && chance(opts.existingShare)) {
      customerId = get(`SELECT c.id FROM customers c JOIN regions r ON r.id = c.region_id WHERE c.status = 'active' AND r.name = ?
        AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.customer_id = c.id AND l.status = 'open') ORDER BY RANDOM() LIMIT 1`, regionName)?.id;
    }
    const customer = customerId ? get('SELECT * FROM customers WHERE id = ?', customerId) : null;
    const category = opts.category || weighted([['Energy Meters', 30], ['IoT Gateways', 18], ['Control Panels', 20], ['Controllers', 14], ['Sensors & CTs', 8], ['Software & Services', 10]]);
    const primary = pick(productsByCategory[category]);
    const [qmin, qmax] = PRODUCTS.find((p) => p[1] === primary.sku)[14];
    const qty = ri(qmin, qmax);
    const priceList = customer?.customer_type === 'dealer' ? 'dealer' : customer?.customer_type === 'distributor' ? 'distributor' : 'standard';
    const items = buildItems(category, primary, qty);
    const value = Math.round(estimate(items, priceList) / 1000) * 1000;
    const source = opts.source || (customer ? weighted([['existing_customer', 70], ['referral', 15], ['email', 15]]) : weighted([['website', 18], ['referral', 12], ['cold_call', 8], ['indiamart', 14], ['tender', 5], ['dealer', 10], ['email', 10]]));
    const temperature = opts.temperature || weighted([['hot', 25], ['warm', 45], ['cold', 30]]);
    const entryUser = customer?.assigned_to ? get('SELECT * FROM users WHERE id = ?', customer.assigned_to) : opts.enteredBy || U.saleshead;
    const title = `${primary.name}${qty > 1 ? ` x ${qty}` : ''}`;
    const req = pick(REQ_TEXT[category]).replace('{n}', String(ri(6, 40)));
    const leadId = createLead({
      title, customer_id: customer?.id, new_customer: customer ? undefined : newProspectPayload(regionName), requirement: req,
      category_id: primary.category_id, product_id: primary.id, quantity: qty, estimated_value: value,
      expected_close_date: addDays(day, ri(25, 75)), source, campaign_id: opts.campaignId, temperature,
      next_action: 'Call to understand requirement', next_follow_up_date: addDays(day, ri(0, 2)),
      competitor: chance(0.35) ? pick(COMPETITORS) : null,
      tags: [
        ...(temperature === 'hot' && chance(0.4) ? ['Urgent Requirement'] : []),
        ...(chance(0.12) ? ['Price Sensitive'] : []),
        ...(regionName === 'Export' || chance(0.04) ? ['Export Potential'] : []),
        ...(opts.tags || []),
      ],
    }, entryUser);
    const lead = get('SELECT * FROM leads WHERE id = ?', leadId);
    planLead(lead, { items, temperature, category, priceList: customer ? priceList : 'standard' });
  }), 'lead');
}

function ownerOf(lead) {
  return get('SELECT * FROM users WHERE id = ?', lead.assigned_to) || U.saleshead;
}

function act(leadId, type, day, next, summary, extra = {}) {
  const lead = get('SELECT * FROM leads WHERE id = ?', leadId);
  if (!lead || lead.status !== 'open') return;
  const neglect = chance(0.12);
  logActivity({
    type, lead_id: leadId, customer_id: lead.customer_id, contact_id: lead.contact_id, summary: summary[0], customer_response: summary[1], objections: summary[2],
    products_discussed: lead.title, next_action: next.action, follow_up_date: addDays(next.day, neglect ? -ri(2, 6) : 0), ...extra,
  }, ownerOf(lead));
}

function planLead(lead, ctx) {
  const t = ctx.temperature;
  const fate = weighted(t === 'hot' ? [['win', 46], ['lose', 28], ['hold', 5], ['drop', 21]]
    : t === 'warm' ? [['win', 30], ['lose', 36], ['hold', 7], ['drop', 27]]
      : [['win', 12], ['lose', 40], ['hold', 8], ['drop', 40]]);
  const categoryPace = { 'Control Panels': 2.2, 'Software & Services': 1.5, Controllers: 1.3 }[ctx.category] || 1;
  const pace = (t === 'hot' ? 0.6 : t === 'warm' ? 1 : 1.5) * categoryPace;
  const gap = (a, b) => Math.max(1, Math.round(ri(a, b) * pace));
  let d = lead.created_at.slice(0, 10);
  const steps = [];
  const step = (days, fn) => {
    d = addDays(d, days);
    steps.push([d, fn]);
    return d;
  };

  const d1 = addDays(d, gap(0, 2));
  const d2 = addDays(d1, gap(2, 5));
  const d3 = addDays(d2, gap(3, 7));
  const d4 = addDays(d3, gap(3, 7));
  steps.push([d1, () => act(lead.id, pick(['call', 'call', 'whatsapp']), d1, { action: 'Collect detailed requirement / BOQ', day: d2 }, CALL_NOTES[0])]);
  d = d1;
  if (fate === 'drop' && chance(0.6)) {
    step(gap(6, 14), () => moveLead(lead.id, { status: 'lost', win_loss_reason: 'No response from customer', note: 'Multiple attempts, no response' }, ownerOf(lead)));
    return schedule(steps);
  }
  d = d2;
  steps.push([d2, () => {
    act(lead.id, pick(['email', 'whatsapp', 'call']), d2, { action: 'Technical discussion with engineering team', day: d3 }, CALL_NOTES[1], { type: 'requirement' });
    moveLead(lead.id, { stage: 'requirement_identified', next_action: 'Technical discussion with engineering team', next_follow_up_date: d3 }, ownerOf(lead));
  }]);
  if (fate === 'drop') {
    step(gap(10, 25), () => moveLead(lead.id, { status: 'lost', win_loss_reason: pick(['Budget not approved', 'Project cancelled / deferred', 'No response from customer']) }, ownerOf(lead)));
    return schedule(steps);
  }
  const sample = ['Energy Meters', 'IoT Gateways', 'Sensors & CTs', 'Controllers'].includes(ctx.category) && chance(0.45);
  d = d3;
  steps.push([d3, () => {
    act(lead.id, pick(['meeting', 'video', 'meeting', 'factory_visit']), d3, { action: sample ? 'Deliver demo sample' : 'Prepare quotation', day: d4 }, CALL_NOTES[3]);
    moveLead(lead.id, { stage: 'technical_discussion', next_action: sample ? 'Deliver demo sample' : 'Prepare quotation', next_follow_up_date: d4 }, ownerOf(lead));
  }]);
  d = d4;
  if (sample) {
    const d5 = addDays(d4, gap(4, 8));
    step(0, () => act(lead.id, 'sample_delivery', d4, { action: 'Collect sample feedback and prepare quotation', day: d5 }, ['Demo unit delivered and installed on one feeder', 'Will evaluate for a week', null]));
  }
  if (fate === 'hold') {
    step(gap(8, 20), () => moveLead(lead.id, { status: 'on_hold', note: pick(['Project deferred to next quarter', 'Awaiting board approval', 'Site not ready']) }, ownerOf(lead)));
    return schedule(steps);
  }

  // Quotation
  const discountBand = weighted([['std', 62], ['mgr', 26], ['head', 12]]);
  const disc = () => (discountBand === 'std' ? ri(0, 8) : discountBand === 'mgr' ? ri(11, 16) : ri(19, 24));
  const quote = { id: null, items: ctx.items.map((it) => ({ ...it, discount_pct: disc() })) };
  const panelOrder = ctx.category === 'Control Panels';
  const channel = ['dealer', 'distributor'].includes(get('SELECT customer_type FROM customers WHERE id = ?', lead.customer_id)?.customer_type);
  const advancePct = panelOrder ? pick([30, 40, 50]) : channel ? 0 : chance(0.35) ? 30 : 0;
  const paymentTerms = advancePct > 0
    ? `${advancePct}% advance with PO, balance against proforma before dispatch`
    : channel ? '45 days credit from invoice date' : pick(['100% against delivery within 30 days', '45 days credit from invoice']);
  const creator = () => (chance(0.4) ? U.commercial : ownerOf(lead));
  const qDay = step(gap(3, 8), () => {
    const lf = get('SELECT * FROM leads WHERE id = ?', lead.id);
    if (lf.status !== 'open') return;
    quote.id = createQuotation({
      customer_id: lf.customer_id, lead_id: lf.id, contact_id: lf.contact_id, items: quote.items,
      freight: chance(0.5) ? Math.round(estimate(quote.items, ctx.priceList) * 0.015 / 100) * 100 : 0,
      installation: ctx.category === 'Control Panels' && chance(0.3) ? ri(2, 6) * 10000 : 0,
      payment_terms: paymentTerms,
    }, creator());
    approveAndSend(quote.id, lead);
  });
  const afterSend = addDays(qDay, 2);
  steps.push([addDays(afterSend, ri(0, 2)), () => quote.id && exec('view', () => {
    const q = get('SELECT status FROM quotations WHERE id = ?', quote.id);
    if (q.status === 'sent' && chance(0.75)) setQuotationStatus(quote.id, { status: 'viewed' }, null);
  })]);
  d = afterSend;
  const followDay = addDays(d, gap(3, 6));
  step(gap(3, 6), () => quote.id && act(lead.id, 'call', followDay, { action: 'Follow up for decision', day: addDays(followDay, ri(4, 8)) }, CALL_NOTES[4]));

  const negotiate = fate === 'win' ? chance(0.6) : chance(0.5);
  if (negotiate) {
    step(gap(3, 8), () => {
      if (!quote.id) return;
      const q = get('SELECT status FROM quotations WHERE id = ?', quote.id);
      if (!['sent', 'viewed', 'responded'].includes(q.status)) return;
      setQuotationStatus(quote.id, { status: 'negotiation', note: pick(['Customer asked for 5% additional discount', 'Competitor quoted lower, requested revision', 'Wants freight included']) }, ownerOf(lead));
      act(lead.id, 'meeting', addDays(today(), 0), { action: 'Send revised quotation', day: addDays(today(), 3) }, CALL_NOTES[5]);
    });
    const rounds = chance(0.25) ? 2 : 1;
    for (let i = 0; i < rounds; i++) {
      step(gap(2, 5), () => {
        if (!quote.id) return;
        const q = get('SELECT status FROM quotations WHERE id = ?', quote.id);
        if (!['negotiation', 'revision_requested', 'sent', 'viewed', 'responded'].includes(q.status)) return;
        quote.items = quote.items.map((it) => ({ ...it, discount_pct: Math.min(26, it.discount_pct + ri(2, 5)) }));
        updateQuotation(quote.id, { items: quote.items, change_note: pick(['Additional discount after negotiation', 'Revised price to match budget', 'Freight absorbed, discount revised']) }, ownerOf(lead));
        approveAndSend(quote.id, lead);
      });
    }
  }

  if (fate === 'win') {
    step(gap(4, 10), () => {
      if (!quote.id) return;
      const q = get('SELECT status FROM quotations WHERE id = ?', quote.id);
      if (!QUOTE_AWAITING.includes(q.status)) return;
      setQuotationStatus(quote.id, { status: 'accepted', note: 'Commercials agreed, PO under process' }, ownerOf(lead));
    });
    step(gap(2, 9), () => {
      if (!quote.id) return;
      const q = get('SELECT * FROM quotations WHERE id = ?', quote.id);
      if (q.status !== 'accepted') return;
      const cust = get('SELECT * FROM customers WHERE id = ?', q.customer_id);
      const panels = panelOrder;
      const advance = advancePct;
      const orderId = convertQuotationToOrder(quote.id, {
        customer_po_number: `PO/${cust.name.replace(/[^A-Z]/g, '').slice(0, 4) || 'CUST'}/${ri(1000, 9999)}`,
        po_date: today(), advance_pct: advance, priority: weighted([['normal', 70], ['high', 22], ['urgent', 8]]),
        factory_id: panels ? factoryIds.panels : factoryIds.main, win_reason: pick(WIN_REASONS),
        commercial_owner_id: U.commercial.id, accounts_owner_id: U.accounts.id,
        production_owner_id: panels ? U.production2.id : U.production.id, dispatch_owner_id: U.dispatch.id,
      }, pick([U.commercial, ownerOf(lead)]));
      planOrder(orderId, { panels });
    });
  } else {
    step(gap(6, 18), () => {
      if (!quote.id) return;
      const q = get('SELECT status FROM quotations WHERE id = ?', quote.id);
      if (!['sent', 'viewed', 'responded', 'negotiation', 'revision_requested', 'approved'].includes(q.status)) {
        const lf = get('SELECT status FROM leads WHERE id = ?', lead.id);
        if (lf.status === 'open') moveLead(lead.id, { status: 'lost', win_loss_reason: 'No response from customer' }, ownerOf(lead));
        return;
      }
      const reason = weighted([[LOSS_REASONS[0], 30], [LOSS_REASONS[1], 26], [LOSS_REASONS[2], 12], [LOSS_REASONS[3], 8], [LOSS_REASONS[4], 12], [LOSS_REASONS[5], 7], [LOSS_REASONS[7], 5]]);
      setQuotationStatus(quote.id, {
        status: 'rejected', reason, mark_lead_lost: true, competitor: reason === 'Lost to competitor' ? pick(COMPETITORS) : undefined,
        note: reason === 'Lost to competitor' ? 'Order placed with competitor' : null,
      }, ownerOf(lead));
    });
  }
  schedule(steps);
}

function schedule(steps) {
  for (const [day, fn] of steps) at(day, () => exec('lead step', fn), 'lead-step');
}

function approveAndSend(quoteId, lead) {
  const owner = ownerOf(lead);
  const status = submitQuotation(quoteId, owner);
  const send = () => exec('send quote', () => {
    const q = get('SELECT status FROM quotations WHERE id = ?', quoteId);
    if (q.status === 'approved') sendQuotation(quoteId, { channel: pick(['email', 'whatsapp']) }, owner);
  });
  if (status === 'approval_pending') {
    const approval = get("SELECT * FROM approvals WHERE entity = 'quotation' AND entity_id = ? AND status = 'pending'", quoteId);
    const cust = get('SELECT region_id FROM customers WHERE id = (SELECT customer_id FROM quotations WHERE id = ?)', quoteId);
    const approver = approval.required_role === 'regional_manager' ? rmOf(cust.region_id) : approval.required_role === 'sales_head' ? U.saleshead : U.md;
    const decideDay = addDays(today(), ri(0, 2));
    at(decideDay, () => exec('decide approval', () => {
      const a = get('SELECT status FROM approvals WHERE id = ?', approval.id);
      if (a.status !== 'pending') return;
      const reject = chance(0.1);
      decideApproval(approval.id, reject ? 'rejected' : 'approved', reject ? 'Margin too thin, hold at 15% and offer extended warranty instead' : pick(['Approved considering volume', 'OK, strategic account', 'Approved - ensure advance payment', 'Approved']), approver);
      if (reject) {
        const items = get('SELECT * FROM quotation_versions WHERE quotation_id = ? ORDER BY version_no DESC LIMIT 1', quoteId);
        const lines = all('SELECT product_id, qty, discount_pct, config FROM quotation_items WHERE version_id = ?', items.id)
          .map((l) => ({ ...l, discount_pct: Math.min(l.discount_pct, 15) }));
        updateQuotation(quoteId, { items: lines, change_note: 'Discount capped at 15% per approver', warranty_terms: '24 months from supply' }, owner);
        if (submitQuotation(quoteId, owner) === 'approval_pending') {
          const a2 = get("SELECT id FROM approvals WHERE entity = 'quotation' AND entity_id = ? AND status = 'pending'", quoteId);
          decideApproval(a2.id, 'approved', 'Approved at revised terms', approver);
        }
      }
      send();
    }), 'approval');
  } else {
    send();
  }
}

// ------------------------------------------------------------------ order lifecycle
const factoryIds = {};

function planOrder(orderId, { panels }) {
  const o = get('SELECT * FROM sales_orders WHERE id = ?', orderId);
  const c = get('SELECT * FROM customers WHERE id = ?', o.customer_id);
  const b = customerBehaviour(c);
  const start = o.order_date;
  const prod = panels ? U.production2 : U.production;
  const later = (fromDay, a, bb) => addDays(fromDay, ri(a, bb));
  const run2 = (day, label, fn) => at(day, () => exec(label, fn), label);

  let d = later(start, 0, 1);
  run2(d, 'commercial verification', () => changeOrderStage(orderId, { stage: 'commercial_verification', note: 'PO terms checked against quotation' }, U.commercial));
  if (o.advance_required > 0) {
    d = later(d, 1, 2);
    run2(d, 'advance pending', () => changeOrderStage(orderId, { stage: 'advance_pending', note: `Proforma for ${o.advance_pct}% advance shared` }, U.commercial));
    d = later(d, 2, b.pay === 'prompt' ? 5 : 14);
    run2(d, 'advance payment', () => recordPayment({ order_id: orderId, amount: o.advance_required, payment_date: today(), mode: pick(['neft', 'rtgs']), reference: `UTR${ri(100000000, 999999999)}` }, U.accounts));
  } else {
    d = later(d, 1, 2);
    run2(d, 'confirm order', () => changeOrderStage(orderId, { stage: 'order_confirmed', note: 'Credit terms approved' }, U.commercial));
  }
  // Production
  const leadTime = Math.max(...all('SELECT p.lead_time_days FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?', orderId).map((x) => x.lead_time_days), 7);
  const materialIssue = weighted([['available', 72], ['partial', 20], ['shortage', 8]]);
  const delayed = materialIssue !== 'available' ? chance(0.7) : chance(0.12);
  d = later(d, 1, 3);
  run2(d, 'material check', () => {
    const cur = get('SELECT stage FROM sales_orders WHERE id = ?', orderId);
    if (cur.stage !== 'order_confirmed') return false;
    changeOrderStage(orderId, { stage: 'material_check' }, prod);
    updateProduction(orderId, {
      material_status: materialIssue,
      material_constraint: materialIssue === 'available' ? null : pick(['Thyristor modules awaited from supplier', 'CRCA sheet shortage at vendor', 'Import of communication chipset delayed', 'Busbar copper price revision pending']),
      planned_start: addDays(today(), 2), planned_completion: addDays(today(), Math.round(leadTime * 0.8)),
    }, prod);
  });
  d = later(d, 1, 3);
  run2(d, 'schedule production', () => {
    if (get('SELECT stage FROM sales_orders WHERE id = ?', orderId).stage !== 'material_check') return;
    changeOrderStage(orderId, { stage: 'production_scheduled', note: `Slot booked in ${panels ? 'panel shop' : 'assembly line 2'}` }, prod);
  });
  d = later(d, 1, 2);
  run2(d, 'start production', () => {
    if (get('SELECT stage FROM sales_orders WHERE id = ?', orderId).stage !== 'production_scheduled') return;
    changeOrderStage(orderId, { stage: 'under_production' }, prod);
  });
  const buildDays = Math.max(3, Math.round(leadTime * 0.6));
  if (delayed) {
    run2(later(d, 2, 4), 'production delay', () => {
      const p = get('SELECT * FROM production WHERE order_id = ?', orderId);
      if (!p || p.actual_completion) return;
      const extra = ri(5, 18);
      updateProduction(orderId, {
        revised_completion: addDays(p.planned_completion || today(), extra),
        delay_reason: materialIssue !== 'available' ? 'Raw material delay' : pick(['Line capacity constraint', 'Design change requested by customer', 'Vendor quality rejection', 'Power shutdown at plant']),
        update_note: `Completion revised by ${extra} days`,
      }, prod);
      if (chance(0.6)) {
        const cur = get('SELECT * FROM sales_orders WHERE id = ?', orderId);
        updateOrder2(orderId, { revised_delivery_date: addDays(cur.expected_delivery_date, extra), delay_reason: get('SELECT delay_reason FROM production WHERE order_id = ?', orderId).delay_reason });
      }
    });
  }
  const mid = addDays(d, Math.round(buildDays / 2));
  run2(mid, 'progress', () => {
    const items = all('SELECT id, qty FROM order_items WHERE order_id = ?', orderId);
    updateProduction(orderId, { items: items.map((i) => ({ id: i.id, qty_produced: Math.floor(i.qty * (ri(35, 65) / 100)) })), update_note: 'Assembly in progress' }, prod);
  });
  d = addDays(d, buildDays + (delayed ? ri(5, 16) : 0));
  run2(d, 'to QC', () => {
    if (get('SELECT stage FROM sales_orders WHERE id = ?', orderId).stage !== 'under_production') return;
    const items = all('SELECT id, qty FROM order_items WHERE order_id = ?', orderId);
    updateProduction(orderId, { items: items.map((i) => ({ id: i.id, qty_produced: i.qty })) }, prod);
    changeOrderStage(orderId, { stage: 'quality_check' }, prod);
  });
  const qcFail = chance(0.07);
  d = later(d, 1, 2);
  run2(d, 'QC result', () => {
    if (get('SELECT stage FROM sales_orders WHERE id = ?', orderId).stage !== 'quality_check') return;
    updateProduction(orderId, qcFail
      ? { qc_status: 'failed', qc_remarks: 'Insulation resistance test failed on 2 units' }
      : { qc_status: 'passed', qc_remarks: pick(['All routine tests passed', 'Calibration verified, test certificates generated', 'FAT witnessed by customer and passed']) }, U.quality);
  });
  if (qcFail) {
    d = later(d, 2, 4);
    run2(d, 'QC rework', () => updateProduction(orderId, { qc_status: 'passed', qc_remarks: 'Rework done, retest passed' }, U.quality));
  }
  d = later(d, 1, 2);
  run2(d, 'packing', () => {
    if (get('SELECT stage FROM sales_orders WHERE id = ?', orderId).stage !== 'quality_check') return;
    changeOrderStage(orderId, { stage: 'packing' }, prod);
  });
  d = later(d, 1, 1);
  run2(d, 'ready', () => {
    if (get('SELECT stage FROM sales_orders WHERE id = ?', orderId).stage !== 'packing') return;
    changeOrderStage(orderId, { stage: 'ready_for_dispatch' }, prod);
  });

  // Dispatch, possibly in two shipments
  const items = all('SELECT id, qty FROM order_items WHERE order_id = ?', orderId);
  const partial = items.some((i) => i.qty >= 10) && chance(0.3);
  const transporter = pick(['VRL Logistics', 'Gati Express', 'Safexpress', 'TCI Freight', 'Blue Dart Surface', 'Own vehicle']);
  const shipments = partial
    ? [items.map((i) => ({ order_item_id: i.id, qty: Math.ceil(i.qty * 0.6) })), items.map((i) => ({ order_item_id: i.id, qty: i.qty - Math.ceil(i.qty * 0.6) })).filter((x) => x.qty > 0)].filter((l) => l.length)
    : [items.map((i) => ({ order_item_id: i.id, qty: i.qty }))];
  shipments.forEach((lines, n) => {
    d = later(d, n === 0 ? (chance(0.3) ? 4 : 1) : 6, n === 0 ? (panels ? 10 : 3) : 12);
    run2(d, 'dispatch', () => {
      const cur = get('SELECT stage FROM sales_orders WHERE id = ?', orderId);
      if (!['ready_for_dispatch', 'packing'].includes(cur.stage)) return;
      const dispId = createDispatch(orderId, {
        items: lines, dispatch_date: today(), transporter, vehicle_number: `MH${ri(10, 50)} ${pick(['AB', 'CD', 'GT', 'KL'])} ${ri(1000, 9999)}`,
        lr_number: `${ri(100000, 999999)}`, boxes: ri(1, 24), eway_bill: `${ri(1000, 9999)} ${ri(1000, 9999)} ${ri(1000, 9999)}`,
        expected_delivery_date: addDays(today(), ri(2, 6)), create_invoice: true,
      }, U.dispatch);
      planDelivery(dispId, orderId, { panels, b, isLast: n === shipments.length - 1 });
    });
  });
}

function updateOrder2(orderId, patch) {
  const cur = get('SELECT * FROM sales_orders WHERE id = ?', orderId);
  if (!cur) return;
  update('sales_orders', orderId, { ...patch, updated_at: nowIso() });
  insert('production_updates', { order_id: orderId, stage: cur.stage, note: `Delivery date revised to ${patch.revised_delivery_date}`, visible_to_customer: 1, created_by: U.commercial.id, created_at: nowIso() });
}

function planDelivery(dispatchId, orderId, { panels, b, isLast }) {
  const disp = get('SELECT * FROM dispatches WHERE id = ?', dispatchId);
  const deliverDay = addDays(disp.dispatch_date, ri(2, 7));
  at(deliverDay, () => exec('deliver', () => {
    updateDispatch(dispatchId, { status: 'delivered', delivered_date: today(), received_by: personName(), received_confirmed: true }, U.dispatch);
  }), 'deliver');

  // Payment of the invoice raised at dispatch
  if (disp.invoice_id) {
    const inv = get('SELECT * FROM invoice_balances WHERE id = ?', disp.invoice_id);
    const offset = b.pay === 'prompt' ? ri(-6, 3) : b.pay === 'late' ? ri(8, 45) : ri(50, 130);
    const payDay = addDays(inv.due_date, offset);
    const split = b.pay !== 'prompt' && chance(0.4);
    const pay = (fraction, label) => at(label === 'second' ? addDays(payDay, ri(10, 30)) : payDay, () => exec('invoice payment', () => {
      const cur = get('SELECT * FROM invoice_balances WHERE id = ?', inv.id);
      if (cur.balance <= 1) return;
      const cust = customerBehaviour(get('SELECT * FROM customers WHERE id = ?', cur.customer_id));
      const tds = cust.tds && label !== 'second' ? round2(cur.taxable * 0.001) : 0;
      const amount = round2(label === 'second' ? cur.balance : Math.min(cur.balance, cur.balance * fraction) - tds);
      if (amount <= 0) return;
      recordPayment({ invoice_id: inv.id, amount, tds_amount: tds, payment_date: today(), mode: pick(['neft', 'rtgs', 'neft', 'cheque']), reference: `UTR${ri(100000000, 999999999)}` }, U.accounts);
    }), 'payment');
    if (inv.balance > 1) {
      if (split) {
        pay(0.6, 'first');
        pay(0.4, 'second');
      } else pay(1, 'full');
    }
  }

  if (!isLast) return;
  const order = get('SELECT * FROM sales_orders WHERE id = ?', orderId);
  const c = get('SELECT * FROM customers WHERE id = ?', order.customer_id);
  let closeDay = addDays(deliverDay, ri(3, 8));
  if (panels) {
    const installDay = addDays(deliverDay, ri(4, 12));
    at(installDay, () => exec('installation', () => {
      if (get('SELECT stage FROM sales_orders WHERE id = ?', orderId).stage !== 'delivered') return;
      changeOrderStage(orderId, { stage: 'installation', note: 'Service engineer deputed for commissioning' }, pick([U.service, U.service2]));
    }), 'install');
    closeDay = addDays(installDay, ri(5, 12));
  }
  const tryClose = (day, attempt) => at(day, () => exec('close order', () => {
    const o = loadOrderRow(orderId);
    if (!['delivered', 'installation'].includes(o.stage)) return;
    if (o.outstanding > 1 || o.invoiced < o.grand_total - 1) {
      if (attempt < 8) tryClose(addDays(today(), 20), attempt + 1);
      return;
    }
    changeOrderStage(orderId, { stage: 'closed', note: 'Delivered, commissioned and fully paid' }, get('SELECT * FROM users WHERE id = ?', o.sales_owner_id) || U.saleshead);
  }), 'close');
  tryClose(addDays(closeDay, 15), 0);

  // After-sales complaint
  const gw = get("SELECT 1 AS x FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? AND p.sku = 'VT-GW10'", orderId);
  if (chance(gw ? 0.55 : 0.16)) {
    const complaintDay = addDays(deliverDay, ri(15, 120));
    at(complaintDay, () => exec('complaint', () => raiseComplaint(orderId, Boolean(gw))), 'complaint');
  }

  // Repeat business
  const beh = customerBehaviour(c);
  const firstOrder = get("SELECT MIN(order_date) AS d FROM sales_orders WHERE customer_id = ?", c.id).d;
  const churned = beh.churnAfter && daysBetween(firstOrder, deliverDay) > beh.churnAfter;
  if (beh.repeat && !churned) {
    scheduleLead(addDays(deliverDay, Math.round(beh.cycle * (0.8 + rand() * 0.4))), { customerId: c.id, temperature: weighted([['hot', 45], ['warm', 45], ['cold', 10]]) });
  }
}

function raiseComplaint(orderId, gateway) {
  const o = get('SELECT * FROM sales_orders WHERE id = ?', orderId);
  const item = get(
    `SELECT oi.* FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ? AND p.stock_type <> 'service' ORDER BY ${gateway ? "p.sku = 'VT-GW10' DESC," : ''} RANDOM() LIMIT 1`,
    orderId,
  );
  if (!item) return;
  const category = gateway ? weighted([['communication', 70], ['software', 30]]) : weighted([['hardware_failure', 25], ['display', 10], ['calibration', 15], ['installation', 15], ['transit_damage', 15], ['wrong_supply', 10], ['communication', 10]]);
  const descriptions = {
    communication: 'Gateway loses connection to cloud every few hours; data gaps on dashboard',
    software: 'Data upload stops after firmware auto-update; device needs manual restart',
    hardware_failure: 'Unit not powering on after voltage fluctuation',
    display: 'Display segments missing on two meters',
    calibration: 'Energy reading differs from utility meter by ~3%',
    installation: 'CT polarity wrongly connected at site, negative kW shown',
    transit_damage: 'Panel door hinge broken and meter glass cracked on receipt',
    wrong_supply: 'Received 100-600 A CTs instead of 50-250 A as per PO',
  };
  const inv = get('SELECT number, invoice_date FROM invoices WHERE order_id = ? ORDER BY invoice_date LIMIT 1', orderId);
  const tech = pick([U.service, U.service2]);
  const severity = weighted([['low', 20], ['medium', 45], ['high', 28], ['critical', 7]]);
  const cid = insert('complaints', {
    number: nextNumber('CMP'),
    customer_id: o.customer_id, contact_id: o.contact_id, order_id: orderId, product_id: item.product_id,
    serial_number: `${get('SELECT sku FROM products WHERE id = ?', item.product_id).sku.replace('VT-', '')}${ri(24000, 26999)}${ri(100, 999)}`,
    invoice_number: inv?.number, invoice_date: inv?.invoice_date, installation_date: addDays(inv?.invoice_date || o.order_date, ri(3, 15)),
    warranty_status: 'in_warranty', category, severity, description: descriptions[category], status: 'assigned', assigned_to: tech.id,
    created_by: tech.id, created_at: nowIso(), updated_at: nowIso(),
  });
  logActivity({ type: 'call', customer_id: o.customer_id, complaint_id: cid, order_id: orderId, summary: `Complaint logged: ${descriptions[category]}`, customer_response: 'Requested urgent site visit' }, tech);
  const visit = addDays(today(), ri(1, 4));
  at(visit, () => exec('site visit', () => {
    update('complaints', cid, { status: 'site_visit', site_visit_date: today(), site_visit_notes: 'Inspected at site, logs collected', updated_at: nowIso() });
  }), 'visit');
  const resolveDay = addDays(visit, ri(2, 18));
  if (chance(0.25)) at(addDays(visit, 1), () => exec('complaint progress', () => update('complaints', cid, { status: pick(['in_progress', 'awaiting_parts']), updated_at: nowIso() })), 'progress');
  at(resolveDay, () => exec('resolve complaint', () => {
    const rc = {
      communication: ['Firmware 2.3 watchdog bug causing modem hang', 'firmware_update'],
      software: ['Auto-update did not restart data service', 'firmware_update'],
      hardware_failure: ['SMPS failure due to surge beyond rated limit', 'replacement'],
      display: ['LCD connector loose from vibration', 'repair'],
      calibration: ['CT ratio configured incorrectly at site', 'reconfiguration'],
      installation: ['CT polarity reversed by electrical contractor', 'training'],
      transit_damage: ['Inadequate packing for long-distance transport', 'replacement'],
      wrong_supply: ['Dispatch picked wrong CT variant', 'replacement'],
    }[category];
    update('complaints', cid, {
      status: 'resolved', root_cause: rc[0], resolution_type: rc[1], resolution_notes: 'Issue fixed and verified with customer',
      resolved_at: nowIso(), feedback_rating: weighted([[5, 40], [4, 35], [3, 15], [2, 7], [1, 3]]), feedback_comment: pick(['Quick response, thanks', 'Resolved but took time', 'Good support', null]), updated_at: nowIso(),
    });
    if (chance(0.7)) at(addDays(today(), ri(3, 10)), () => exec('close complaint', () => update('complaints', cid, { status: 'closed', closed_at: nowIso() })), 'close-complaint');
  }), 'resolve');
}


// ------------------------------------------------------------------ main
export function seed({ reset = false } = {}) {
  const started = Date.now();
  if (reset) {
    db.exec('PRAGMA foreign_keys = OFF');
    for (const { type, name } of all("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'")) {
      db.exec(`DROP ${type.toUpperCase()} IF EXISTS "${name}"`);
    }
    db.exec('PRAGMA foreign_keys = ON');
    migrate();
  }
  const END = today();
  const START = addDays(END, -540);
  db.exec('PRAGMA synchronous = OFF');
  try {
    tx(() => {
    setClock(`${START}T08:00:00`);
    currentDay = START;

    // Masters
    for (const [name, r] of Object.entries(REGIONS)) insert('regions', { name, states: Object.keys(r.states).join(', ') });
    const region = (name) => get('SELECT id FROM regions WHERE name = ?', name).id;
    factoryIds.main = insert('factories', { name: 'Unit 1 - Bhosari (meters, gateways, controllers)', location: 'MIDC Bhosari, Pune' });
    factoryIds.panels = insert('factories', { name: 'Unit 2 - Chakan (panels)', location: 'Chakan Industrial Area, Pune' });

    const pw = hashPassword(DEMO_PASSWORD);
    const mkUser = (key, name, email, role, designation, extra = {}) => {
      const id = insert('users', { name, email, role, designation, phone: phone(), password_hash: pw, active: 1, created_at: nowIso(), ...extra });
      U[key] = get('SELECT * FROM users WHERE id = ?', id);
      return U[key];
    };
    mkUser('admin', 'Aditi Kulkarni', 'admin@veritek.example', 'super_admin', 'CRM Administrator', { branch: 'Pune HO' });
    mkUser('md', 'Rajesh Mehta', 'md@veritek.example', 'management', 'Managing Director', { branch: 'Pune HO' });
    mkUser('saleshead', 'Vikram Nair', 'saleshead@veritek.example', 'sales_head', 'VP - Sales', { branch: 'Pune HO', manager_id: U.md.id });
    mkUser('rsm_west', 'Sneha Patil', 'rsm.west@veritek.example', 'regional_manager', 'Regional Sales Manager - West', { region_id: region('West India'), branch: 'Pune', manager_id: U.saleshead.id });
    mkUser('rsm_north', 'Amit Khanna', 'rsm.north@veritek.example', 'regional_manager', 'Regional Sales Manager - North', { region_id: region('North India'), branch: 'Gurugram', manager_id: U.saleshead.id });
    mkUser('rsm_south', 'Karthik Raman', 'rsm.south@veritek.example', 'regional_manager', 'Regional Sales Manager - South', { region_id: region('South India'), branch: 'Bengaluru', manager_id: U.saleshead.id });
    mkUser('rsm_east', 'Sourav Banerjee', 'rsm.east@veritek.example', 'regional_manager', 'Regional Sales Manager - East', { region_id: region('East India'), branch: 'Kolkata', manager_id: U.saleshead.id });
    mkUser('se_w1', 'Rohan Deshmukh', 'rohan@veritek.example', 'sales_executive', 'Sr. Sales Engineer', { region_id: region('West India'), branch: 'Pune', manager_id: U.rsm_west.id });
    mkUser('se_w2', 'Priya Shah', 'priya@veritek.example', 'sales_executive', 'Sales Engineer - Panels', { region_id: region('West India'), branch: 'Ahmedabad', manager_id: U.rsm_west.id });
    mkUser('se_w3', 'Omkar Sawant', 'omkar@veritek.example', 'sales_executive', 'Sales Engineer', { region_id: region('West India'), branch: 'Mumbai', manager_id: U.rsm_west.id });
    mkUser('se_n1', 'Neha Verma', 'neha@veritek.example', 'sales_executive', 'Sr. Sales Engineer', { region_id: region('North India'), branch: 'Gurugram', manager_id: U.rsm_north.id });
    mkUser('se_n2', 'Arjun Singh', 'arjun@veritek.example', 'sales_executive', 'Sales Engineer', { region_id: region('North India'), branch: 'Noida', manager_id: U.rsm_north.id });
    mkUser('se_s1', 'Lakshmi Iyer', 'lakshmi@veritek.example', 'sales_executive', 'Sr. Sales Engineer', { region_id: region('South India'), branch: 'Chennai', manager_id: U.rsm_south.id });
    mkUser('se_s2', 'Rahul Reddy', 'rahul@veritek.example', 'sales_executive', 'Sales Engineer', { region_id: region('South India'), branch: 'Hyderabad', manager_id: U.rsm_south.id });
    mkUser('se_e1', 'Ankit Das', 'ankit@veritek.example', 'sales_executive', 'Sales Engineer', { region_id: region('East India'), branch: 'Kolkata', manager_id: U.rsm_east.id });
    mkUser('se_x1', 'Farah Qureshi', 'farah@veritek.example', 'sales_executive', 'Export Sales Manager', { region_id: region('Export'), branch: 'Mumbai', manager_id: U.saleshead.id });
    mkUser('commercial', 'Meera Joshi', 'commercial@veritek.example', 'commercial', 'Commercial Manager', { branch: 'Pune HO' });
    mkUser('production', 'Suresh Pawar', 'production@veritek.example', 'production', 'Production Manager - Unit 1', { factory_id: factoryIds.main });
    mkUser('production2', 'Ganesh Jadhav', 'panels@veritek.example', 'production', 'Production Manager - Unit 2', { factory_id: factoryIds.panels });
    mkUser('quality', 'Kavita Rao', 'quality@veritek.example', 'quality', 'QA Lead', {});
    mkUser('dispatch', 'Imran Shaikh', 'dispatch@veritek.example', 'dispatch', 'Logistics Executive', {});
    mkUser('accounts', 'Pooja Agarwal', 'accounts@veritek.example', 'accounts', 'Accounts Manager', {});
    mkUser('service', 'Deepak Kumar', 'service@veritek.example', 'service', 'Service Engineer', {});
    mkUser('service2', 'Sandeep More', 'sandeep@veritek.example', 'service', 'Sr. Service Engineer', {});

    // Products
    const catIds = {};
    for (const [name, description] of CATEGORIES) catIds[name] = insert('product_categories', { name, description });
    for (const p of PRODUCTS) {
      const id = insert('products', {
        category_id: catIds[p[0]], sku: p[1], name: p[2], model: p[3], standard_price: p[4], dealer_price: p[5], distributor_price: p[6],
        min_price: Math.min(p[7], Math.round((p[6] * 0.94) / 10) * 10), cost_price: p[8], lead_time_days: p[9], stock_type: p[10], warranty_months: p[11], hsn: p[12], specs: p[13],
        gst_rate: 18, stock_qty: p[10] === 'stock' ? ri(20, 400) : 0, unit: p[1] === 'VT-COMM' ? 'Man-day' : p[10] === 'service' ? 'Site' : 'Nos',
        description: `${p[2]} - ${Object.values(p[13]).slice(0, 2).join(', ')}`, created_at: nowIso(), updated_at: nowIso(),
      });
      products[p[1]] = get('SELECT * FROM products WHERE id = ?', id);
      (productsByCategory[p[0]] ||= []).push(products[p[1]]);
      for (const [group, name, price, cost] of OPTIONS[p[1]] || []) insert('product_options', { product_id: id, group_name: group, name, price_delta: price, cost_delta: cost });
      insert('product_documents', { product_id: id, doc_type: 'datasheet', title: `${p[3]} datasheet (PDF)`, url: `https://docs.veritek.example/${p[3].toLowerCase()}/datasheet.pdf` });
      if (p[10] !== 'service') insert('product_documents', { product_id: id, doc_type: 'manual', title: `${p[3]} installation manual`, url: `https://docs.veritek.example/${p[3].toLowerCase()}/manual.pdf` });
      if (['VT-GW10', 'VT-GW20', 'VT-APFC', 'VT-EM500'].includes(p[1])) insert('product_documents', { product_id: id, doc_type: 'video', title: `${p[2]} walkthrough video`, url: `https://videos.veritek.example/${p[3].toLowerCase()}` });
    }
    run("UPDATE products SET status = 'discontinued' WHERE sku = 'VT-DGC'");
    productsByCategory.Controllers = productsByCategory.Controllers.filter((p) => p.sku !== 'VT-DGC');

    // Assignment rules
    insert('lead_assignment_rules', { region_id: region('West India'), category_id: catIds['Control Panels'], user_id: U.se_w2.id, priority: 5, active: 1 });
    insert('lead_assignment_rules', { region_id: region('South India'), category_id: catIds['Software & Services'], user_id: U.se_s1.id, priority: 5, active: 1 });
    insert('lead_assignment_rules', { region_id: region('Export'), category_id: null, user_id: U.se_x1.id, priority: 10, active: 1 });
    insert('lead_assignment_rules', { region_id: region('North India'), category_id: catIds['IoT Gateways'], user_id: U.se_n1.id, priority: 8, active: 1 });

    // Tags
    for (const [name, color] of [['Export Potential', 'teal'], ['Urgent Requirement', 'red'], ['Price Sensitive', 'amber'], ['Sample Sent', 'violet'], ['Strategic Account', 'indigo'], ['Tender', 'blue'], ['Credit Hold', 'red']]) {
      insert('tags', { name, color });
    }

    // Campaigns
    const campaignIds = [];
    for (const c of CAMPAIGNS) {
      const id = insert('campaigns', {
        name: c.name, type: c.type, location: c.location, start_date: addDays(END, c.start), end_date: addDays(END, c.end), cost: c.cost,
        target_leads: c.leads ? Math.round(c.leads * 1.2) : 40, stall: c.stall, status: c.status, owner_id: U.saleshead.id,
        description: `${c.type === 'exhibition' ? 'Stall with live demo of metering, gateways and APFC panel' : 'Engagement programme'} · ${c.location}`, created_at: nowIso(),
      });
      campaignIds.push({ ...c, id });
    }

    // Established customers
    ESTABLISHED.forEach(([name, type, industry, state, city, valueCat], i) => {
      const regionName = regionOfState(state);
      const execs = execsIn(region(regionName));
      const owner = regionName === 'West India' && type === 'oem' ? U.se_w2 : pick(execs.length ? execs : [rmOf(region(regionName))]);
      const export_ = regionName === 'Export';
      const id = insert('customers', {
        code: `CU/${String(i + 1).padStart(4, '0')}`, name, customer_type: type, industry, gstin: export_ ? null : gstin(state), city, state,
        country: export_ ? state : 'India', region_id: region(regionName), website: `www.${slug(name)}.example`,
        billing_address: `${ri(1, 250)}, ${pick(['Industrial Estate', 'MIDC', 'Business Park', 'Tech Park', 'Ring Road'])}, ${city}`,
        shipping_address: `Plant ${ri(1, 3)}, ${pick(['Phase II', 'Sector 5', 'Survey No. ' + ri(10, 400)])}, ${city}`,
        pincode: export_ ? null : String(ri(110001, 799999)), credit_limit: valueCat === 'key_account' ? 5000000 : valueCat === 'high_value' ? 2500000 : 1000000,
        payment_terms: type === 'dealer' || type === 'distributor' ? '45 days credit' : pick(['30 days from invoice', '30% advance, balance 30 days', '60 days credit']),
        payment_terms_days: type === 'dealer' || type === 'distributor' ? 45 : pick([30, 30, 60]), assigned_to: owner.id, status: 'active',
        value_category: valueCat, source: pick(['referral', 'exhibition', 'website', 'dealer', 'cold_call']), created_by: U.admin.id,
        created_at: nowIso(), updated_at: nowIso(),
      });
      addContacts(id, name, ['owner', 'purchase', 'technical', 'accounts', ...(chance(0.5) ? ['site'] : [])].slice(0, ri(3, 5)));
      for (const cat of [...new Set([pick(Object.keys(catIds)), pick(Object.keys(catIds))])]) run('INSERT OR IGNORE INTO customer_interests (customer_id, category_id) VALUES (?, ?)', id, catIds[cat]);
      if (valueCat === 'key_account') run("INSERT INTO taggings (tag_id, entity, entity_id) SELECT id, 'customer', ? FROM tags WHERE name = 'Strategic Account'", id);
      if (regionName === 'Export') run("INSERT INTO taggings (tag_id, entity, entity_id) SELECT id, 'customer', ? FROM tags WHERE name = 'Export Potential'", id);
      scheduleLead(addDays(START, ri(0, 70)), { customerId: id, temperature: weighted([['hot', 55], ['warm', 40], ['cold', 5]]) });
      if (chance(0.5)) scheduleLead(addDays(START, ri(90, 300)), { customerId: id, temperature: 'warm' });
    });
    const tenderCustomer = get("SELECT id FROM customers WHERE name LIKE 'Kanpur%'").id;
    run("INSERT INTO taggings (tag_id, entity, entity_id) SELECT id, 'customer', ? FROM tags WHERE name = 'Tender'", tenderCustomer);

    // Sales targets (taxable order value), FY-wise per salesperson
    for (const u of usersBy((x) => ['sales_executive', 'regional_manager'].includes(x.role))) {
      const base = u.role === 'regional_manager' ? ri(4, 6) * 100000 : u.region_id === region('West India') ? ri(14, 18) * 100000 : ri(9, 13) * 100000;
      for (let m = -18; m <= 7; m++) {
        const dt = new Date(`${END.slice(0, 7)}-01T00:00:00`);
        dt.setMonth(dt.getMonth() + m);
        const month = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
        const seasonal = [3, 2, 1, 0].includes(dt.getMonth()) ? 1.25 : 1; // Q4 push (Jan-Mar) and April
        run('INSERT OR IGNORE INTO sales_targets (user_id, month, amount) VALUES (?, ?, ?)', u.id, month, Math.round((base * seasonal) / 50000) * 50000);
      }
    }

    // Inbound enquiries and campaign bursts
    for (let day = START; day <= END; day = addDays(day, 1)) {
      const dow = new Date(`${day}T00:00:00`).getDay();
      const growth = 0.55 + 0.75 * (daysBetween(START, day) / 540);
      const rate = (dow === 0 ? 0.1 : dow === 6 ? 0.3 : 0.62) * growth;
      if (chance(rate)) scheduleLead(day, { existingShare: 0.3 });
      if (chance(rate * 0.3)) scheduleLead(day, { existingShare: 0.3 });
    }
    for (const c of campaignIds) {
      if (!c.leads) continue;
      const startDay = addDays(END, c.start);
      for (let i = 0; i < c.leads; i++) {
        const existing = c.type === 'dealer_meet' ? get("SELECT id FROM customers WHERE customer_type IN ('dealer','distributor') AND region_id = ? ORDER BY RANDOM() LIMIT 1", region('West India')) : null;
        scheduleLead(addDays(startDay, ri(0, (c.end - c.start) + 3)), {
          campaignId: c.id, source: c.type === 'exhibition' ? 'exhibition' : 'campaign', customerId: existing?.id,
          regionName: c.region || weighted([['West India', 38], ['North India', 28], ['South India', 20], ['East India', 10], ['Export', 4]]),
          temperature: weighted([['hot', 18], ['warm', 42], ['cold', 40]]), category: c.category,
          enteredBy: c.region ? rmOf(region(c.region)) : U.saleshead,
        });
      }
    }

    // Run the simulation day by day
    let processed = 0;
    for (let day = START; day <= END; day = addDays(day, 1)) {
      currentDay = day;
      setClock(`${day}T09:00:00`);
      let queue = agenda.get(day) || [];
      while (queue.length) {
        agenda.set(day, []);
        for (const ev of queue) {
          ev.fn();
          processed++;
        }
        queue = agenda.get(day) || [];
      }
      agenda.delete(day);
      // Quotations past validity expire
      for (const q of all(`SELECT id FROM quotations WHERE status IN (${QUOTE_AWAITING.map((x) => `'${x}'`).join(',')}) AND valid_until < ?`, day)) {
        exec('expire', () => setQuotationStatus(q.id, { status: 'expired', note: 'Validity period ended' }, null));
      }
    }

    // Leads nobody followed up for three weeks are closed as unresponsive.
    for (const l of all("SELECT * FROM leads WHERE status = 'open' AND next_follow_up_date < ?", addDays(END, -21))) {
      setClock(`${addDays(l.next_follow_up_date, ri(7, 14)) > END ? END : addDays(l.next_follow_up_date, ri(7, 14))}T17:00:00`);
      exec('sweep', () => moveLead(l.id, { status: 'lost', win_loss_reason: 'No response from customer', note: 'Closed after repeated follow-ups without response' }, get('SELECT * FROM users WHERE id = ?', l.assigned_to) || U.saleshead, { system: true }));
    }

    // A couple of credit notes
    setClock(`${addDays(END, -5)}T11:00:00`);
    for (const inv of all('SELECT * FROM invoice_balances WHERE balance > 5000 ORDER BY invoice_date DESC LIMIT 2')) {
      exec('credit note', () => createCreditNote({ invoice_id: inv.id, amount: Math.round(inv.balance * 0.03), reason: pick(['Short supply of 2 CTs', 'Price difference as per revised PO']) }, U.accounts));
    }

    // Backfill management summaries for the last two weeks and eight weeks
    setClock(`${END}T07:00:00`);
    for (let i = 1; i <= 14; i++) {
      const d = addDays(END, -i);
      insert('summaries', { period: 'daily', period_key: d, data: buildSummary(d, d), created_at: `${addDays(d, 1)}T02:00:00.000Z` });
    }
    const dow = (new Date(`${END}T00:00:00`).getDay() + 6) % 7;
    for (let w = 1; w <= 8; w++) {
      const start = addDays(END, -dow - 7 * w);
      insert('summaries', { period: 'weekly', period_key: start, data: buildSummary(start, addDays(start, 6)), created_at: `${addDays(start, 7)}T02:00:00.000Z` });
    }

    // Keep recent notifications only; older ones are marked read.
    setClock(null);
    run('DELETE FROM notifications WHERE created_at < ?', `${addDays(END, -12)}T00:00:00`);
    run('UPDATE notifications SET read_at = created_at WHERE created_at < ?', `${addDays(END, -3)}T00:00:00`);
    console.log(`Simulated ${processed} events from ${START} to ${END} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    });
  } finally {
    setClock(null);
  }
  db.exec('PRAGMA synchronous = NORMAL');
  runAutomation({ force: true });

  const counts = Object.fromEntries(['customers', 'contacts', 'leads', 'quotations', 'quotation_versions', 'approvals', 'sales_orders', 'dispatches', 'invoices', 'payments', 'complaints', 'activities', 'followups', 'notifications']
    .map((t) => [t, get(`SELECT COUNT(*) AS n FROM ${t}`).n]));
  console.log('Records:', counts);
  if (errors.length) {
    console.log(`${errors.length} simulated actions were rejected by business rules (expected for some). First few:`);
    const byMsg = {};
    for (const e of errors) {
      const k = e.replace(/^\S+ /, '').replace(/\d+/g, '#');
      byMsg[k] = (byMsg[k] || 0) + 1;
    }
    for (const [m, n] of Object.entries(byMsg).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${n} x ${m}`);
  }
  console.log(`Demo password for all users: ${DEMO_PASSWORD}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed({ reset: process.argv.includes('--reset') });
}
