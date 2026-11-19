// Builds client/src/data/world-map.json, the map behind the dashboard's "Where enquiries and sales come from"
// card. Country shapes are Natural Earth (public domain), from the world-atlas npm package, drawn once here in the
// Natural Earth projection so the app needs no mapping library: 1:110m for the world, and 1:50m for the CRM's
// countries too small to appear at that scale (Bahrain, Singapore), so that every CRM country can be shaded.
// Points keep a tenth of a map unit, enough to stay smooth when the map is zoomed in.
//
// Run it again when a country is added to COUNTRIES in shared/constants.js:
//   npm pack world-atlas@2.0.2 --pack-destination <empty folder>   (then unpack the .tgz there)
//   node scripts/world-map.js <that folder>/package
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRIES } from '../shared/constants.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'client/src/data/world-map.json');
const WIDTH = 1000;
const PAD = 6;

// Each CRM country: its ISO numeric code and Natural Earth name, checked against the data below.
const SHAPES = {
  IN: ['356', 'India'], AE: ['784', 'United Arab Emirates'], SA: ['682', 'Saudi Arabia'], OM: ['512', 'Oman'], QA: ['634', 'Qatar'], KW: ['414', 'Kuwait'],
  BH: ['048', 'Bahrain'], KE: ['404', 'Kenya'], NG: ['566', 'Nigeria'], TZ: ['834', 'Tanzania'], EG: ['818', 'Egypt'], ZA: ['710', 'South Africa'],
  BD: ['050', 'Bangladesh'], LK: ['144', 'Sri Lanka'], NP: ['524', 'Nepal'], SG: ['702', 'Singapore'], MY: ['458', 'Malaysia'], GB: ['826', 'United Kingdom'],
  US: ['840', 'United States of America'], DE: ['276', 'Germany'],
};
// Where a country's name goes when its largest piece is not where its business is: Malaysia's is Borneo, and Kuala
// Lumpur is on the peninsula. [lon, lat]
const PLACES = { MY: [101.69, 3.14] };

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node scripts/world-map.js <unpacked world-atlas package folder>');
for (const c of COUNTRIES) if (!SHAPES[c.value]) throw new Error(`${c.value} (${c.label}) is not in SHAPES: add its ISO numeric code and Natural Earth name`);

// ------------------------------------------------------------------ TopoJSON to polygons of [lon, lat]
const crossesDateLine = (r) => r.some((p, i) => i > 0 && Math.abs(p[0] - r[i - 1][0]) > 180);
/**
 * A shape across the 180° line (Fiji, the tip of Russia) would be drawn as a band across the whole map. Its
 * points are made continuous, then drawn twice, once on each side, each copy held at the edge of the map.
 */
function splitAtDateLine(r) {
  const flat = [r[0]];
  for (let i = 1; i < r.length; i++) {
    let lon = r[i][0];
    const prev = flat[i - 1][0];
    while (lon - prev > 180) lon -= 360;
    while (lon - prev < -180) lon += 360;
    flat.push([lon, r[i][1]]);
  }
  const lons = flat.map((p) => p[0]);
  const held = (shift) => flat.map(([lon, lat]) => [Math.max(-180, Math.min(180, lon + shift)), lat]);
  return [held(0), ...(Math.max(...lons) > 180 ? [held(-360)] : []), ...(Math.min(...lons) < -180 ? [held(360)] : [])];
}

/** Every country in a world-atlas file, Antarctica left out, as { id, name, polygons }. */
function shapesIn(file) {
  const topo = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const { scale: [kx, ky], translate: [tx, ty] } = topo.transform;
  const arcs = topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * kx + tx, y * ky + ty];
    });
  });
  const arcPoints = (i) => (i < 0 ? arcs[~i].slice().reverse() : arcs[i]);
  const ring = (indexes) => indexes.flatMap((i, k) => (k ? arcPoints(i).slice(1) : arcPoints(i)));
  const fixDateLine = (polygons) => polygons.flatMap((poly) => (poly.some(crossesDateLine) ? splitAtDateLine(poly[0]).map((piece) => [piece]) : [poly]));
  return topo.objects.countries.geometries.filter((g) => g.properties?.name !== 'Antarctica').map((g) => ({
    id: g.id,
    name: g.properties?.name,
    polygons: fixDateLine(g.type === 'Polygon' ? [g.arcs.map(ring)] : g.type === 'MultiPolygon' ? g.arcs.map((p) => p.map(ring)) : []),
  }));
}

// ------------------------------------------------------------------ Natural Earth projection (as d3-geo's naturalEarth1)
const RAD = Math.PI / 180;
function project([lon, lat]) {
  const l = lon * RAD;
  const p = lat * RAD;
  const p2 = p * p;
  const p4 = p2 * p2;
  return [
    l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
    p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
  ];
}

const world = shapesIn('countries-110m.json');
const detailed = shapesIn('countries-50m.json');
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;
for (const s of world) {
  for (const poly of s.polygons) {
    for (const r of poly) {
      if (crossesDateLine(r)) throw new Error(`${s.name} still crosses the date line`);
      for (const pt of r) {
        const [x, y] = project(pt);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }
}
const S = (WIDTH - PAD * 2) / (maxX - minX);
const HEIGHT = Math.round((maxY - minY) * S + PAD * 2);
const toScreen = (pt) => {
  const [x, y] = project(pt);
  return [(x - minX) * S + PAD, (maxY - y) * S + PAD];
};

// Points in tenths of a unit: '.4' and '-1.2' are valid SVG numbers.
const tenths = (v) => {
  const s = (Math.abs(v) / 10).toFixed(v % 10 === 0 ? 0 : 1).replace(/^0\./, '.');
  return v < 0 ? `-${s}` : s;
};

/** An SVG path: absolute start, relative steps in tenths of a unit, rings too small to see left out. */
function pathOf(polygons) {
  let d = '';
  for (const poly of polygons) {
    for (const r of poly) {
      const pts = [];
      for (const pt of r) {
        const [x, y] = toScreen(pt).map((v) => Math.round(v * 10));
        const last = pts[pts.length - 1];
        if (!last || last[0] !== x || last[1] !== y) pts.push([x, y]);
      }
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      if (pts.length < 3) continue;
      d += `M${tenths(pts[0][0])},${tenths(pts[0][1])}l${pts.slice(1).map((p, i) => `${tenths(p[0] - pts[i][0])},${tenths(p[1] - pts[i][1])}`).join(' ').replace(/ -/g, '-')}z`;
    }
  }
  return d;
}

/** Centre of the largest piece of a country (its outer ring), on screen. */
function anchorOf(polygons) {
  let best = null;
  for (const poly of polygons) {
    const r = poly[0].map(toScreen);
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
      a += f;
      cx += (r[j][0] + r[i][0]) * f;
      cy += (r[j][1] + r[i][1]) * f;
    }
    if (a && (!best || Math.abs(a) > best.area)) best = { area: Math.abs(a), x: cx / (3 * a), y: cy / (3 * a) };
  }
  return [best.x, best.y];
}

/** The box around all of a country, on screen: [left, top, right, bottom]. */
function boxOf(polygons) {
  const pts = polygons.flatMap((poly) => poly[0].map(toScreen));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v * 10) / 10);
}

const round1 = (v) => Math.round(v * 10) / 10;
const countries = {};
const used = new Set();
for (const [code, [id, name]] of Object.entries(SHAPES)) {
  const shape = world.find((s) => s.id === id) || detailed.find((s) => s.id === id);
  if (!shape) throw new Error(`${code} (${name}) is in neither the 1:110m nor the 1:50m data`);
  if (shape.name !== name) throw new Error(`${code}: id ${id} is "${shape.name}" in the data, not "${name}"`);
  const [x, y] = PLACES[code] ? toScreen(PLACES[code]) : anchorOf(shape.polygons);
  countries[code] = { x: round1(x), y: round1(y), box: boxOf(shape.polygons), d: pathOf(shape.polygons) };
  used.add(shape.id);
}
const land = pathOf(world.filter((s) => !used.has(s.id)).flatMap((s) => s.polygons));
const out = {
  source: 'Country shapes: Natural Earth 1:110m, and 1:50m for Bahrain and Singapore (public domain), via the world-atlas package 2.0.2, in the Natural Earth projection. Antarctica is left out. Made by scripts/world-map.js.',
  width: WIDTH,
  height: HEIGHT,
  land,
  countries,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
console.log(`${path.relative(root, OUT)}: ${WIDTH}×${HEIGHT}, ${Object.keys(countries).length} countries, ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
for (const [code, c] of Object.entries(countries)) console.log(`  ${code} at ${c.x},${c.y} · box ${c.box.join(',')} · outline ${c.d.length} chars`);
