// A small PDF writer for the documents customers download (invoices, account statements). No dependency: plain
// PDF 1.4 with the two standard fonts every PDF reader has (Helvetica, Helvetica-Bold), text in WinAnsi encoding,
// lines and filled rectangles. Coordinates are in points from the TOP-left of an A4 page, which is how the layouts
// read; the writer flips them for PDF.

const A4 = { width: 595.28, height: 841.89 };

// Glyph widths (per 1000 em) for characters 32–126, from the Helvetica and Helvetica-Bold font metrics.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// The few characters outside ASCII the documents use: [WinAnsi code, width regular, width bold].
const EXTRA = {
  '—': [0x97, 1000, 1000], '–': [0x96, 556, 556], '·': [0xb7, 278, 278], '’': [0x92, 222, 278], '‘': [0x91, 222, 278],
  '“': [0x93, 333, 500], '”': [0x94, 333, 500], '×': [0xd7, 584, 584], '…': [0x85, 1000, 1000], 'é': [0xe9, 556, 556],
  '−': [0x96, 556, 556],   // the minus sign is not in WinAnsi: drawn as the en dash
};

/** Text as the WinAnsi bytes the standard fonts expect; "GH₵" becomes "GHS", anything else unknown becomes "?". */
function encode(text) {
  const s = String(text ?? '').replace(/GH₵|₵/g, 'GHS').replace(/[\r\n\t]+/g, ' ');
  const bytes = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) bytes.push(c);
    else if (EXTRA[ch]) bytes.push(EXTRA[ch][0]);
    else bytes.push(63);
  }
  return bytes;
}

/** The width of a piece of text in points. */
export function textWidth(text, size = 10, bold = false) {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  let w = 0;
  for (const ch of String(text ?? '').replace(/GH₵|₵/g, 'GHS')) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) w += table[c - 32];
    else if (EXTRA[ch]) w += EXTRA[ch][bold ? 2 : 1];
    else w += 556;
  }
  return (w * size) / 1000;
}

/** Break text into lines no wider than `width` (a word longer than the line is cut). */
export function wrap(text, width, size = 10, bold = false) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let word of words) {
    while (textWidth(word, size, bold) > width && word.length > 1) {
      let cut = word.length - 1;
      while (cut > 1 && textWidth(word.slice(0, cut), size, bold) > width) cut -= 1;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size, bold) <= width) line = next;
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => c.map((v) => num(v / 255)).join(' ');
const pdfString = (bytes) => {
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
};

export class PdfDocument {
  constructor({ title = 'Document', author = 'Box for Less' } = {}) {
    this.width = A4.width;
    this.height = A4.height;
    this.title = title;
    this.author = author;
    this.pages = [];
    this.addPage();
  }

  addPage() { this.ops = []; this.pages.push(this.ops); return this; }

  get pageCount() { return this.pages.length; }

  /** Draw on page `i` (0-based) again, e.g. to add "Page 1 of 3" once every page exists. */
  usePage(i) { this.ops = this.pages[i]; return this; }

  /** Text at (x, y-from-top of the baseline). align: left | right (x is the right edge) | center. */
  text(x, y, value, { size = 10, bold = false, color = [24, 49, 83], align = 'left' } = {}) {
    const w = textWidth(value, size, bold);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg ${num(left)} ${num(this.height - y)} Td ${pdfString(encode(value))} Tj ET`);
    return this;
  }

  /** A filled (and/or outlined) rectangle; (x, y) is its top-left corner. */
  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.75 } = {}) {
    const box = `${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re`;
    if (fill && stroke) this.ops.push(`${rgb(fill)} rg ${rgb(stroke)} RG ${num(lineWidth)} w ${box} B`);
    else if (fill) this.ops.push(`${rgb(fill)} rg ${box} f`);
    else if (stroke) this.ops.push(`${rgb(stroke)} RG ${num(lineWidth)} w ${box} S`);
    return this;
  }

  line(x1, y1, x2, y2, { color = [226, 232, 240], width = 0.75 } = {}) {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`);
    return this;
  }

  /** The finished file. */
  toBuffer() {
    const objects = [];             // index i holds object number i + 1
    const add = (body) => { objects.push(body); return objects.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const ops of this.pages) {
      const stream = Buffer.from(ops.join('\n'), 'latin1');
      const content = add({ stream });
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title ${pdfString(encode(this.title))} /Author ${pdfString(encode(this.author))} /Producer (Box for Less) >>`);

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(offset);
      const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
      const parts = typeof body === 'string'
        ? [head, Buffer.from(`${body}\nendobj\n`, 'latin1')]
        : [head, Buffer.from(`<< /Length ${body.stream.length} >>\nstream\n`, 'latin1'), body.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')];
      for (const p of parts) { chunks.push(p); offset += p.length; }
    });
    const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}
