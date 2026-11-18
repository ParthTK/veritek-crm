// The starter category templates for the object register (Objects & QR). They are generic set-up, so a clean
// installation starts with them; administrators change or add categories in the QR module.
import { insert } from './db.js';
import { nowIso } from './util.js';

export const OBJECT_CATEGORIES = [
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

export const fieldKey = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Creates the starter object categories (with their field templates). Returns name → id. */
export function createObjectCategories(adminId) {
  const ids = {};
  for (const c of OBJECT_CATEGORIES) {
    ids[c.name] = insert('object_categories', {
      name: c.name, description: c.description,
      field_template: JSON.stringify(c.fields.map((f) => ({ key: fieldKey(f.label), ...f, public: true }))), created_by: adminId, created_at: nowIso(),
    });
  }
  return ids;
}
