// Inline previews for office documents, parsed here so the public page never needs a
// third-party viewer: .xlsx and .docx are ZIP archives of XML, CSV is parsed directly.
import zlib from 'node:zlib';

// ------------------------------------------------------------------ zip reading
function readZip(buffer) {
  const files = new Map();
  // Locate the end-of-central-directory record (it may be followed by a comment).
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
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.readUInt16LE(localOffset + 26);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buffer.subarray(start, start + compressedSize);
    files.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)));
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const decodeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

// ------------------------------------------------------------------ xlsx
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Excel serial date (1900 system) to an ISO date string. */
function excelDate(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return serial % 1 ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
}

const colIndex = (ref) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] || 'A';
  return [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
};

export function xlsxToSheets(buffer, { maxRows = 200, maxCols = 30, maxSheets = 5 } = {}) {
  const zip = readZip(buffer);
  const read = (name) => (zip.has(name) ? zip.get(name)().toString('utf8') : '');

  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join(''));

  // Which style indexes represent dates.
  const styles = read('xl/styles.xml');
  const customDateFormats = new Set([...styles.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)]
    .filter(([, , code]) => /[ymd]/i.test(code) && !/[#0]/.test(code)).map(([, id]) => Number(id)));
  const cellXfs = styles.split('<cellXfs')[1] || '';
  const dateStyles = new Set();
  [...cellXfs.matchAll(/<xf[^>]*numFmtId="(\d+)"[^>]*>/g)].forEach((m, i) => {
    const id = Number(m[1]);
    if (DATE_FORMAT_IDS.has(id) || customDateFormats.has(id)) dateStyles.add(i);
  });

  const workbook = read('xl/workbook.xml');
  const names = [...workbook.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => decodeXml(m[1]));

  const sheets = [];
  for (let i = 1; i <= maxSheets; i++) {
    const xml = read(`xl/worksheets/sheet${i}.xml`);
    if (!xml) continue;
    const rows = [];
    let truncated = false;
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const cells = [];
      for (const cell of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1];
        const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
        const type = attrs.match(/t="([^"]+)"/)?.[1];
        const style = Number(attrs.match(/s="(\d+)"/)?.[1] ?? -1);
        const raw = cell[2];
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
    sheets.push({ name: names[i - 1] || `Sheet ${i}`, rows, truncated });
  }
  if (!sheets.length) throw new Error('No worksheets found');
  return sheets;
}

// ------------------------------------------------------------------ docx
export function docxToBlocks(buffer, { maxBlocks = 400 } = {}) {
  const zip = readZip(buffer);
  if (!zip.has('word/document.xml')) throw new Error('Not a readable Word document');
  const xml = zip.get('word/document.xml')().toString('utf8');
  const blocks = [];
  for (const p of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    if (blocks.length >= maxBlocks) break;
    const chunk = p[0];
    const text = [...chunk.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => decodeXml(t[1])).join('');
    const style = chunk.match(/<w:pStyle[^>]*w:val="([^"]*)"/)?.[1] || '';
    const isList = /<w:numPr[ >]/.test(chunk) || /List(Paragraph|Bullet|Number)/i.test(style);
    if (!text.trim()) continue;
    const heading = /^Heading(\d)/i.exec(style);
    blocks.push({ type: heading ? `h${Math.min(3, Number(heading[1]))}` : isList ? 'li' : 'p', text });
  }
  const tables = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].length;
  if (!blocks.length && !tables) throw new Error('No readable text in this document');
  return { blocks, tables };
}

// ------------------------------------------------------------------ csv
export function csvToRows(text, { maxRows = 300, maxCols = 30 } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const pushField = () => {
    if (row.length < maxCols) row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length && rows.length < maxRows; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') pushField();
    else if (c === '\n') pushRow();
    else if (c !== '\r') field += c;
  }
  if (field || row.length) pushRow();
  return rows;
}

/** What kind of inline preview a file supports, from its mime type and name. */
export function previewKind(mime = '', name = '') {
  const ext = name.toLowerCase().split('.').pop();
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'].includes(ext)) return 'image';
  if (mime.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) return 'audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ext === 'xlsx' || ext === 'xlsm') return 'sheet';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'docx') return 'doc';
  if (mime.startsWith('text/') || ['txt', 'md', 'json', 'log'].includes(ext)) return 'text';
  return 'download';
}
