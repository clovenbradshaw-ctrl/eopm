/* Tests for public/docview.js — the in-tab document readers.
 *
 * The point of these readers is that an end-to-end encrypted file is NEVER
 * handed to a remote preview service: the bytes are plaintext only inside the
 * tab that holds the room key, so the parsing happens there. That makes the
 * parsers ours to get right, which is what this file checks — against real
 * ZIP containers built here (store AND deflate paths) rather than mocks.
 *
 *   node test/docview.test.mjs
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// docview.js is a browser IIFE that assigns window.DocView. Load it through a
// window shim so the shipped file is the file under test.
const here = dirname(fileURLToPath(import.meta.url));
const win = {};
new Function('window', readFileSync(join(here, '..', 'public', 'docview.js'), 'utf8'))(win);
const DocView = win.DocView;

let passed = 0;
function ok(name) { console.log('  ok  ' + name); passed++; }
async function test(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + (e.stack || e)); process.exitCode = 1; }
}
const eq = (a, b) => assert.deepStrictEqual(a, b);

// ── A minimal ZIP writer, so the fixtures are real containers ────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** files: { path: string }. `compress` picks method 8 over method 0. */
async function makeZip(files, { compress = false } = {}) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  const put = (arr) => { parts.push(arr); offset += arr.length; };
  const hdr = (size) => new DataView(new ArrayBuffer(size));

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = typeof content === 'string' ? enc.encode(content) : content;
    const stored = compress ? await deflateRaw(raw) : raw;
    const method = compress ? 8 : 0;
    const crc = crc32(raw);
    const localOffset = offset;

    const lh = hdr(30);
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0, true);
    lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, stored.length, true);
    lh.setUint32(22, raw.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    put(new Uint8Array(lh.buffer));
    put(nameBytes);
    put(stored);

    const ch = hdr(46);
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(10, method, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, stored.length, true);
    ch.setUint32(24, raw.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, localOffset, true);
    central.push([new Uint8Array(ch.buffer), nameBytes]);
  }

  const cdStart = offset;
  for (const [h, n] of central) { put(h); put(n); }
  const cdSize = offset - cdStart;

  const eocd = hdr(22);
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  put(new Uint8Array(eocd.buffer));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const DOCX_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Review</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">Revenue rose </w:t></w:r><w:r><w:t>12%</w:t></w:r><w:r><w:t> year over year.</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Hire two engineers</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>Backend first</w:t></w:r></w:p>
  <w:p><w:r><w:instrText>PAGEREF _Toc1 \\h</w:instrText></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>West</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>4,200</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:t>Filed under R&amp;D &lt;draft&gt;.</w:t></w:r></w:p>
</w:body></w:document>`;

const docxBytes = (opts) => makeZip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': DOCX_BODY,
}, opts);

const XLSX_SHARED = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4">
  <si><t>Name</t></si><si><t>Owed</t></si><si><t>Ada</t></si><si><t>Grace</t></si></sst>`;

const XLSX_SHEET = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
  <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>119.5</v></c></row>
  <row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><v>7</v></c></row>
</sheetData></worksheet>`;

const xlsxBytes = () => makeZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Ledger" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': XLSX_SHARED,
  'xl/worksheets/sheet1.xml': XLSX_SHEET,
});

const slide = (title, body) => `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;

const pptxBytes = () => makeZip({
  'ppt/slides/slide1.xml': slide('Why now', 'The window is open'),
  'ppt/slides/slide2.xml': slide('The ask', 'Two engineers'),
  'ppt/slides/slide10.xml': slide('Appendix', 'Sources'),
});

const ODT_BODY = `<office:document-content
  xmlns:office="urn:office" xmlns:text="urn:text" xmlns:table="urn:table">
  <office:body><office:text>
    <text:h text:outline-level="1">Field Notes</text:h>
    <text:p>Arrived at <text:span>dawn</text:span>.</text:p>
    <text:list><text:list-item><text:p>Checked the gauge</text:p></text:list-item></text:list>
    <table:table table:name="Counts">
      <table:table-row><table:table-cell><text:p>site</text:p></table:table-cell><table:table-cell><text:p>n</text:p></table:table-cell></table:table-row>
      <table:table-row><table:table-cell><text:p>north</text:p></table:table-cell><table:table-cell><text:p>12</text:p></table:table-cell></table:table-row>
    </table:table>
  </office:text></office:body></office:document-content>`;

const odtBytes = () => makeZip({ 'content.xml': ODT_BODY, 'mimetype': 'application/vnd.oasis.opendocument.text' });

// ── ZIP ──────────────────────────────────────────────────────────────────

await test('openZip reads stored entries', async () => {
  const zip = await DocView.openZip(await makeZip({ 'a.txt': 'hello', 'b/c.txt': 'world' }));
  eq(zip.entries.map(e => e.name), ['a.txt', 'b/c.txt']);
  eq(await zip.readText('a.txt'), 'hello');
  eq(await zip.readText('b/c.txt'), 'world');
  eq(await zip.readText('nope.txt'), null);
});

await test('openZip inflates deflated entries', async () => {
  const body = 'the same sentence over and over. '.repeat(80);
  const zip = await DocView.openZip(await makeZip({ 'big.txt': body }, { compress: true }));
  assert.ok(zip.entries[0].compressedSize < zip.entries[0].size, 'fixture should actually be compressed');
  eq(await zip.readText('big.txt'), body);
});

await test('openZip rejects bytes that are not an archive', async () => {
  await assert.rejects(() => DocView.openZip(new TextEncoder().encode('not a zip at all')),
    /not a zip archive/);
});

// ── XML tokenizer ────────────────────────────────────────────────────────

await test('walkXml decodes entities and skips comments/CDATA markup', () => {
  const seen = [];
  DocView.walkXml('<a x="1&amp;2"><!-- skip --><b/>t&#65;<![CDATA[<raw>]]></a>', {
    onOpen: (n, attrs, sc) => seen.push(['open', n, attrs.x || '', sc]),
    onClose: (n) => seen.push(['close', n]),
    onText: (t) => seen.push(['text', t]),
  });
  eq(seen, [
    ['open', 'a', '1&2', false],
    ['open', 'b', '', true],
    ['close', 'b'],
    ['text', 'tA'],
    ['text', '<raw>'],
    ['close', 'a'],
  ]);
});

// ── .docx ────────────────────────────────────────────────────────────────

await test('docx: headings, runs joined, lists, tables, entities', async () => {
  const { format, blocks } = await DocView.read(await docxBytes(), { name: 'review.docx' });
  eq(format, 'docx');
  eq(blocks[0], { type: 'h', level: 1, text: 'Quarterly Review' });
  eq(blocks[1], { type: 'p', text: 'Revenue rose 12% year over year.' });
  eq(blocks[2], { type: 'li', level: 0, text: 'Hire two engineers' });
  eq(blocks[3], { type: 'li', level: 1, text: 'Backend first' });
  eq(blocks[4], { type: 'table', rows: [['Region', 'Total'], ['West', '4,200']] });
  eq(blocks[5], { type: 'p', text: 'Filed under R&D <draft>.' });
});

await test('docx: field instruction text never reaches the reader', async () => {
  const { blocks } = await DocView.read(await docxBytes(), { name: 'review.docx' });
  assert.ok(!JSON.stringify(blocks).includes('PAGEREF'), 'PAGEREF leaked into the output');
});

await test('docx: works from a deflated container too', async () => {
  const { blocks } = await DocView.read(await docxBytes({ compress: true }), { name: 'review.docx' });
  eq(blocks[0].text, 'Quarterly Review');
});

await test('docx: a zip with no document.xml says so plainly', async () => {
  const bytes = await makeZip({ 'other.xml': '<x/>' });
  await assert.rejects(() => DocView.read(bytes, { name: 'fake.docx' }), /really a \.docx/);
});

// ── .xlsx ────────────────────────────────────────────────────────────────

await test('xlsx: shared strings, sheet name, and column gaps', async () => {
  const { format, blocks } = await DocView.read(await xlsxBytes(), { name: 'ledger.xlsx' });
  eq(format, 'xlsx');
  eq(blocks.length, 1);
  eq(blocks[0].type, 'sheet');
  eq(blocks[0].name, 'Ledger');
  eq(blocks[0].rows, [
    ['Name', 'Owed'],
    ['Ada', '119.5'],
    ['Grace', '', '7'],     // B3 empty, C3 filled — the gap is preserved
  ]);
});

await test('xlsx: colIndex maps spreadsheet refs to 0-based columns', () => {
  eq(DocView.colIndex('A1'), 0);
  eq(DocView.colIndex('Z9'), 25);
  eq(DocView.colIndex('AA1'), 26);
  eq(DocView.colIndex('AB12'), 27);
});

// ── .pptx ────────────────────────────────────────────────────────────────

await test('pptx: slides in numeric order, first line as the title', async () => {
  const { format, blocks } = await DocView.read(await pptxBytes(), { name: 'pitch.pptx' });
  eq(format, 'pptx');
  eq(blocks.map(b => b.n), [1, 2, 3]);
  eq(blocks.map(b => b.title), ['Why now', 'The ask', 'Appendix']);
  eq(blocks[0].lines, ['The window is open']);
  // slide10 must sort after slide2, not between slide1 and slide2.
  eq(blocks[2].title, 'Appendix');
});

// ── OpenDocument ─────────────────────────────────────────────────────────

await test('odt: headings, spans folded into their paragraph, lists, tables', async () => {
  const { format, blocks } = await DocView.read(await odtBytes(), { name: 'notes.odt' });
  eq(format, 'odt');
  eq(blocks[0], { type: 'h', level: 1, text: 'Field Notes' });
  eq(blocks[1], { type: 'p', text: 'Arrived at dawn.' });
  eq(blocks[2], { type: 'li', level: 0, text: 'Checked the gauge' });
  eq(blocks[3], { type: 'table', rows: [['site', 'n'], ['north', '12']] });
});

await test('ods: tables become sheets, named from the file', async () => {
  const bytes = await makeZip({ 'content.xml': ODT_BODY });
  const { blocks } = await DocView.read(bytes, { name: 'counts.ods' });
  const sheet = blocks.find(b => b.type === 'sheet');
  eq(sheet.name, 'Counts');
  eq(sheet.rows, [['site', 'n'], ['north', '12']]);
});

// ── Plain formats ────────────────────────────────────────────────────────

await test('markdown: headings, lists, quotes, rules, fences, pipe tables', async () => {
  const md = [
    '# Title', '', 'A paragraph that', 'wraps two lines.', '',
    '- one', '- two', '', '> quoted', '', '---', '',
    '```', 'code();', '```', '',
    '| a | b |', '| --- | --- |', '| 1 | 2 |', '',
  ].join('\n');
  const { blocks } = await DocView.read(new TextEncoder().encode(md), { name: 'readme.md' });
  eq(blocks[0], { type: 'h', level: 1, text: 'Title' });
  eq(blocks[1], { type: 'p', text: 'A paragraph that wraps two lines.' });
  eq(blocks[2], { type: 'li', level: 0, text: 'one' });
  eq(blocks[4], { type: 'quote', text: 'quoted' });
  eq(blocks[5], { type: 'hr' });
  eq(blocks[6], { type: 'code', text: 'code();', lang: null });
  eq(blocks[7], { type: 'table', rows: [['a', 'b'], ['1', '2']] });
});

await test('csv: quoted commas and embedded quotes survive', async () => {
  const csv = 'name,note\n"Ada, L.","said ""hi"""\n';
  const { blocks } = await DocView.read(new TextEncoder().encode(csv), { name: 'people.csv' });
  eq(blocks[0].rows, [['name', 'note'], ['Ada, L.', 'said "hi"']]);
});

await test('tsv splits on tabs, not commas', async () => {
  const { blocks } = await DocView.read(new TextEncoder().encode('a\tb\n1,5\t2\n'), { name: 'x.tsv' });
  eq(blocks[0].rows, [['a', 'b'], ['1,5', '2']]);
});

await test('json is pretty-printed; invalid json still shows as written', async () => {
  const okDoc = await DocView.read(new TextEncoder().encode('{"b":1,"a":[2]}'), { name: 'x.json' });
  eq(okDoc.blocks[0].text, '{\n  "b": 1,\n  "a": [\n    2\n  ]\n}');
  const bad = await DocView.read(new TextEncoder().encode('{oops'), { name: 'x.json' });
  eq(bad.blocks[0].text, '{oops');
});

await test('rtf recovers paragraphs and escaped characters', async () => {
  const rtf = String.raw`{\rtf1\ansi{\fonttbl\f0 Arial;}\f0\fs24 Caf\'e9 notes\par Second line\par}`;
  const { blocks } = await DocView.read(new TextEncoder().encode(rtf), { name: 'memo.rtf' });
  eq(blocks.map(b => b.text), ['Café notes', 'Second line']);
});

await test('zip files list their contents', async () => {
  const bytes = await makeZip({ 'b.txt': 'x', 'a/c.txt': 'yy' });
  const { blocks } = await DocView.read(bytes, { name: 'bundle.zip' });
  eq(blocks[0].type, 'files');
  eq(blocks[0].entries.map(e => e.name), ['a/c.txt', 'b.txt']);
  eq(blocks[0].entries[0].size, 2);
});

// ── Dispatch ─────────────────────────────────────────────────────────────

await test('handlerFor prefers the extension, falls back to the MIME type', () => {
  eq(DocView.handlerFor({ name: 'a.docx' }), 'docx');
  eq(DocView.handlerFor({ name: 'a.DOCX' }), 'docx');
  eq(DocView.handlerFor({ name: 'no-extension', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'xlsx');
  eq(DocView.handlerFor({ name: 'a.txt' }), null);
  eq(DocView.handlerFor({ name: 'a.png', mime: 'image/png' }), null);
  eq(DocView.canView({ name: 'deck.pptx' }), true);
  eq(DocView.canView({ name: 'photo.jpg', mime: 'image/jpeg' }), false);
});

await test('an unreadable format reports rather than rendering garbage', async () => {
  await assert.rejects(() => DocView.read(new Uint8Array([1, 2, 3]), { name: 'x.bin' }),
    /no native reader/);
});

console.log(`\nall ${passed} docview checks passed`);
