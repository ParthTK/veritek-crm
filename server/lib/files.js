// In-process readers/writers for the formats imports and exports need: CSV, XLSX (read) and ZIP.
import zlib from 'node:zlib';

// ------------------------------------------------------------------ zip
export function readZip(buffer) {
  const files = new Map();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a readable archive');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compressedSize);
    files.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)));
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Builds a .zip (stored, no compression) from [{ name, data }]. */
export function zipFiles(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const d = new Date();
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ------------------------------------------------------------------ xlsx
const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
function excelDate(serial) {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  if (Number.isNaN(d.getTime())) return String(serial);
  return d.toISOString().slice(0, 10);
}
const colIndex = (ref) => [...(ref.match(/^[A-Z]+/)?.[0] || 'A')].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

export function xlsxToSheets(buffer, { maxRows = 20000, maxCols = 60 } = {}) {
  const zip = readZip(buffer);
  const read = (name) => (zip.has(name) ? zip.get(name)().toString('utf8') : '');
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join(''));
  const styles = read('xl/styles.xml');
  const customDates = new Set([...styles.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)]
    .filter(([, , code]) => /[ymd]/i.test(code) && !/[#0]/.test(code)).map(([, id]) => Number(id)));
  const dateStyles = new Set();
  [...(styles.split('<cellXfs')[1] || '').matchAll(/<xf[^>]*numFmtId="(\d+)"[^>]*>/g)].forEach((m, i) => {
    if (DATE_FORMAT_IDS.has(Number(m[1])) || customDates.has(Number(m[1]))) dateStyles.add(i);
  });
  const names = [...read('xl/workbook.xml').matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  const sheets = [];
  for (let i = 1; i <= Math.max(names.length, 1) + 2; i++) {
    const xml = read(`xl/worksheets/sheet${i}.xml`);
    if (!xml) continue;
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) break;
      const cells = [];
      for (const cell of rowMatch[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const raw = cell[2] || '';
        const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
        const type = attrs.match(/t="([^"]+)"/)?.[1];
        const style = Number(attrs.match(/s="(\d+)"/)?.[1] ?? -1);
        let value = '';
        if (type === 's') value = shared[Number(raw.match(/<v>(\d+)<\/v>/)?.[1] ?? -1)] ?? '';
        else if (type === 'inlineStr') value = [...raw.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join('');
        else if (type === 'b') value = raw.includes('>1<') ? 'TRUE' : 'FALSE';
        else {
          const v = raw.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          if (v !== undefined) value = dateStyles.has(style) && v !== '' && !Number.isNaN(Number(v)) ? excelDate(Number(v)) : decodeXml(v);
        }
        const at = ref ? colIndex(ref) : cells.length;
        if (at < maxCols) cells[at] = value;
      }
      for (let c = 0; c < cells.length; c++) if (cells[c] === undefined) cells[c] = '';
      rows.push(cells);
    }
    while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
    sheets.push({ name: names[i - 1] || `Sheet ${i}`, rows });
  }
  if (!sheets.length) throw new Error('No worksheets found');
  return sheets;
}

// ------------------------------------------------------------------ csv
export function csvToRows(text, { maxRows = 20000 } = {}) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delimiter = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const pushRow = () => {
    row.push(field);
    field = '';
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < src.length && rows.length < maxRows; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n') pushRow();
    else if (c !== '\r') field += c;
  }
  if (field || row.length) pushRow();
  return rows;
}

const csvEsc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

/** CSV with optional "# key: value" metadata lines (generated time, timezone, filters…). */
export function toCsv(columns, rows, meta = []) {
  const lines = [];
  for (const [k, v] of meta) lines.push(csvEsc(`# ${k}: ${v}`));
  lines.push(columns.map((c) => csvEsc(c.label)).join(','));
  for (const r of rows) lines.push(columns.map((c) => csvEsc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function sheetsFromUpload(buffer, name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.xlsx')) return xlsxToSheets(buffer);
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return [{ name: 'CSV', rows: csvToRows(buffer.toString('utf8')) }];
  throw new Error('Upload a .csv or .xlsx file');
}
