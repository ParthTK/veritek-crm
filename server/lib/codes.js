// Code rendering with no image dependencies: QR matrices come from the `qrcode` library,
// Code 128 is encoded here, and both are drawn to SVG or PNG by the renderers below.
import zlib from 'node:zlib';
import QRCode from 'qrcode';

// ------------------------------------------------------------------ QR
/** Returns { size, get(x, y) -> boolean } for the QR modules of `text`. */
export function qrMatrix(text, { errorCorrectionLevel = 'M' } = {}) {
  const qr = QRCode.create(String(text), { errorCorrectionLevel });
  const size = qr.modules.size;
  const data = qr.modules.data;
  return { size, get: (x, y) => Boolean(data[y * size + x]) };
}

// ------------------------------------------------------------------ Code 128
// Code set B covers printable ASCII 32-126, which is all our ids and URLs need.
const CODE128_PATTERNS = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000', '10011000100',
  '10001100100', '11001001000', '11001000100', '11000100100', '10110011100', '10011011100', '10011001110', '10111001100',
  '10011101100', '10011100110', '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010', '11011011000', '11011000110',
  '11000110110', '10100011000', '10001011000', '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110',
  '11100010110', '11101101000', '11101100010', '11100011010', '11101111010', '11001000010', '11110001010', '10100110000',
  '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100', '10011110010', '11110100100', '11110010100',
  '11110010010', '11011011110', '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110', '11110101110', '11010000100',
  '11010010000', '11010011100', '11000111010',
];
const CODE128_START_B = 104;
const CODE128_STOP = '1100011101011';

/** Encodes text as Code 128B and returns an array of bar widths as booleans (true = bar). */
export function code128Bars(text) {
  const value = String(text);
  if (!/^[\x20-\x7e]+$/.test(value)) throw new Error('Code 128 supports printable ASCII characters only');
  const codes = [CODE128_START_B, ...[...value].map((c) => c.charCodeAt(0) - 32)];
  const checksum = codes.reduce((sum, code, i) => sum + code * (i === 0 ? 1 : i), 0) % 103;
  const pattern = [...codes.map((c) => CODE128_PATTERNS[c]), CODE128_PATTERNS[checksum], CODE128_STOP].join('');
  return [...pattern].map((bit) => bit === '1');
}

// ------------------------------------------------------------------ SVG
export function qrSvg(text, { scale = 8, margin = 4, dark = '#000000', light = '#ffffff' } = {}) {
  const { size, get } = qrMatrix(text);
  const dim = (size + margin * 2) * scale;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (get(x, y)) path += `M${(x + margin) * scale},${(y + margin) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + `<rect width="${dim}" height="${dim}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}

export function barcodeSvg(text, { scale = 2, height = 70, margin = 10, dark = '#000000', light = '#ffffff', showText = true } = {}) {
  const bars = code128Bars(text);
  const width = bars.length * scale + margin * 2;
  const textHeight = showText ? 18 : 0;
  const total = height + margin * 2 + textHeight;
  let path = '';
  bars.forEach((bar, i) => {
    if (bar) path += `M${margin + i * scale},${margin}h${scale}v${height}h-${scale}z`;
  });
  const label = showText
    ? `<text x="${width / 2}" y="${margin + height + 14}" text-anchor="middle" font-family="monospace" font-size="13" fill="${dark}">${escapeXml(text)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}" shape-rendering="crispEdges" role="img" aria-label="Barcode ${escapeXml(text)}">`
    + `<rect width="${width}" height="${total}" fill="${light}"/><path d="${path}" fill="${dark}"/>${label}</svg>`;
}

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// ------------------------------------------------------------------ PNG
/** Minimal 8-bit greyscale PNG encoder — enough for crisp black-and-white codes. */
function greyscalePng(width, height, pixels) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // no filter
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, data.length + 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return crc ^ -1;
}

export function qrPng(text, { scale = 10, margin = 4 } = {}) {
  const { size, get } = qrMatrix(text);
  const dim = (size + margin * 2) * scale;
  const pixels = Buffer.alloc(dim * dim, 255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + margin) * scale + dy) * dim + (x + margin) * scale;
        pixels.fill(0, row, row + scale);
      }
    }
  }
  return greyscalePng(dim, dim, pixels);
}

export function barcodePng(text, { scale = 3, height = 120, margin = 12 } = {}) {
  const bars = code128Bars(text);
  const width = bars.length * scale + margin * 2;
  const total = height + margin * 2;
  const pixels = Buffer.alloc(width * total, 255);
  bars.forEach((bar, i) => {
    if (!bar) return;
    for (let y = margin; y < margin + height; y++) {
      const start = y * width + margin + i * scale;
      pixels.fill(0, start, start + scale);
    }
  });
  return greyscalePng(width, total, pixels);
}

// ------------------------------------------------------------------ ZIP (stored, no compression)
/** Builds a .zip from [{ name, data }] — used for bulk code downloads. */
export function zipFiles(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = () => {
    const d = new Date();
    const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
    const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
    return { time, date };
  };
  const { time, date } = dosTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
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
