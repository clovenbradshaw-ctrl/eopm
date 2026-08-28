/* docview.js — read the common document formats in the browser, natively.
 *
 * The drive keeps every file end-to-end encrypted: the bytes only ever exist
 * as plaintext inside the tab that holds the room key. Handing them to Google
 * Docs Viewer or an Office web preview would undo exactly the property the
 * rest of this app is built to hold. So the viewer parses them here instead —
 * no network, no CDN, no external renderer.
 *
 * Everything below turns bytes into a list of BLOCKS the React viewer draws:
 *
 *   { type:'h', level, text }        heading
 *   { type:'p', text }               paragraph
 *   { type:'li', level, text }       list item
 *   { type:'table', rows }           rows of cell strings
 *   { type:'sheet', name, rows }     one spreadsheet tab
 *   { type:'slide', n, title, lines }one presentation slide
 *   { type:'code', text, lang }      monospace, unwrapped
 *   { type:'files', entries }        archive listing
 *   { type:'hr' } { type:'quote', text }
 *
 * OOXML (.docx/.xlsx/.pptx) and ODF (.odt/.ods/.odp) are ZIPs of XML, so the
 * work is: inflate the entries (DecompressionStream does the actual deflate),
 * then pull the handful of tags that carry the content. That's deliberately a
 * *content* reader, not a layout engine — it recovers text, structure, tables
 * and sheets, and says so plainly rather than pretending to be Word.
 *
 * Pure: no DOM APIs (its own XML tokenizer, so no DOMParser) and no globals
 * beyond the assignment at the bottom — testable from Node with a `module`
 * shim, which is where the format fixtures live.
 */

(function () {
  'use strict';

  const decoder = new TextDecoder();
  const dec = (bytes) => decoder.decode(bytes);

  // ── ZIP ────────────────────────────────────────────────────────────────
  //
  // Enough of the format to read an OOXML/ODF/plain archive: walk the End Of
  // Central Directory back from the tail, read each central-directory header,
  // then inflate the local entry. Store (0) and deflate (8) are the only
  // methods these formats ever use.

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  function findEOCD(bytes) {
    // The comment field is variable-length, so the signature is searched for
    // from the end — capped at 64KB + 22, the largest legal comment.
    const min = Math.max(0, bytes.length - 65558);
    for (let i = bytes.length - 22; i >= min; i--) {
      if (u32(bytes, i) === 0x06054b50) return i;
    }
    return -1;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('this browser cannot inflate deflate streams');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const chunks = [];
    let total = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /**
   * Read a ZIP into { entries: [{name, size, compressedSize}], read(name) }.
   * Entries inflate lazily — an .xlsx with 40 sheets shouldn't decompress all
   * of them to show the first.
   */
  async function openZip(bytes) {
    const eocd = findEOCD(bytes);
    if (eocd < 0) throw new Error('not a zip archive');
    const count = u16(bytes, eocd + 10);
    let ptr = u32(bytes, eocd + 16);
    const index = new Map();
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (u32(bytes, ptr) !== 0x02014b50) break;
      const method = u16(bytes, ptr + 10);
      const compressedSize = u32(bytes, ptr + 20);
      const size = u32(bytes, ptr + 24);
      const nameLen = u16(bytes, ptr + 28);
      const extraLen = u16(bytes, ptr + 30);
      const commentLen = u16(bytes, ptr + 32);
      const localOffset = u32(bytes, ptr + 42);
      const name = dec(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
      const rec = { name, size, compressedSize, method, localOffset };
      index.set(name, rec);
      entries.push(rec);
      ptr += 46 + nameLen + extraLen + commentLen;
    }

    async function read(name) {
      const rec = index.get(name);
      if (!rec) return null;
      // The local header repeats the name/extra lengths, and they can differ
      // from the central directory's — always trust the local copy.
      const lo = rec.localOffset;
      if (u32(bytes, lo) !== 0x04034b50) return null;
      const nameLen = u16(bytes, lo + 26);
      const extraLen = u16(bytes, lo + 28);
      const start = lo + 30 + nameLen + extraLen;
      const raw = bytes.subarray(start, start + rec.compressedSize);
      if (rec.method === 0) return raw;
      if (rec.method === 8) return await inflateRaw(raw);
      throw new Error(`unsupported zip compression (method ${rec.method})`);
    }

    async function readText(name) {
      const b = await read(name);
      return b ? dec(b) : null;
    }

    return { entries, read, readText, has: (n) => index.has(n) };
  }

  // ── XML ────────────────────────────────────────────────────────────────
  //
  // A pull tokenizer, not a tree builder. Office XML is machine-generated and
  // can be huge; streaming through it in one pass keeps the memory flat and
  // avoids depending on DOMParser (which would make this module untestable
  // outside a browser).

  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };

  function unescapeXml(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X'
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[ent] !== undefined ? ENTITIES[ent] : m;
    });
  }

  function parseAttrs(src) {
    const attrs = {};
    const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(src))) {
      attrs[m[1]] = unescapeXml(m[3] !== undefined ? m[3] : m[4]);
    }
    return attrs;
  }

  /**
   * Walk `xml`, calling handlers as tags open/close and text appears.
   *   onOpen(name, attrs, selfClosing)
   *   onClose(name)
   *   onText(text)   — already entity-decoded, never called with ''
   */
  function walkXml(xml, { onOpen, onClose, onText }) {
    let i = 0;
    const n = xml.length;
    while (i < n) {
      const lt = xml.indexOf('<', i);
      if (lt === -1) {
        if (onText) { const t = unescapeXml(xml.slice(i)); if (t) onText(t); }
        return;
      }
      if (lt > i && onText) {
        const t = unescapeXml(xml.slice(i, lt));
        if (t) onText(t);
      }
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt);
        const body = xml.slice(lt + 9, end === -1 ? n : end);
        if (body && onText) onText(body);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
        const end = xml.indexOf('>', lt);
        i = end === -1 ? n : end + 1;
        continue;
      }
      const gt = xml.indexOf('>', lt);
      if (gt === -1) return;
      const inner = xml.slice(lt + 1, gt);
      i = gt + 1;
      if (inner[0] === '/') {
        if (onClose) onClose(inner.slice(1).trim());
        continue;
      }
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const sp = body.search(/[\s]/);
      const name = (sp === -1 ? body : body.slice(0, sp)).trim();
      const attrs = sp === -1 ? {} : parseAttrs(body.slice(sp));
      if (onOpen) onOpen(name, attrs, selfClosing);
      if (selfClosing && onClose) onClose(name);
    }
  }

  /** Drop the namespace prefix: `w:p` → `p`, `text:h` → `h`. */
  function local(name) {
    const c = name.indexOf(':');
    return c === -1 ? name : name.slice(c + 1);
  }

  // ── .docx ──────────────────────────────────────────────────────────────

  const DOCX_HEADING = /^(?:heading|Heading|berschrift)\s*([1-6])$/;

  async function readDocx(bytes) {
    const zip = await openZip(bytes);
    const xml = await zip.readText('word/document.xml');
    if (!xml) throw new Error('no word/document.xml — is this really a .docx?');
    const blocks = [];

    let para = null;          // { text, style, listLevel, numbered }
    let inTable = false;
    let rows = null, row = null, cell = null;
    let cellDepth = 0;
    let skipDepth = 0;        // inside w:instrText / deleted runs

    function flushPara() {
      if (!para) return;
      const text = para.text.replace(/[ \t]+\n/g, '\n').trim();
      const p = para;
      para = null;
      if (cell) { if (text) cell.push(text); return; }
      if (!text) return;
      const h = DOCX_HEADING.exec(p.style || '');
      if (h) blocks.push({ type: 'h', level: Math.min(3, +h[1]), text });
      else if (p.style === 'Title') blocks.push({ type: 'h', level: 1, text });
      else if (p.style === 'Subtitle') blocks.push({ type: 'h', level: 3, text });
      else if (p.style === 'Quote' || p.style === 'IntenseQuote') blocks.push({ type: 'quote', text });
      else if (p.listLevel != null) blocks.push({ type: 'li', level: p.listLevel, text });
      else blocks.push({ type: 'p', text });
    }

    walkXml(xml, {
      onOpen(nameRaw, attrs, selfClosing) {
        const name = local(nameRaw);
        if (name === 'instrText' || name === 'delText') { skipDepth++; return; }
        switch (name) {
          case 'tbl':   flushPara(); inTable = true; rows = []; break;
          case 'tr':    if (inTable) row = []; break;
          case 'tc':    if (inTable) { cell = []; cellDepth = 0; } break;
          case 'p':     para = { text: '', style: null, listLevel: null }; break;
          case 'pStyle': if (para) para.style = attrs['w:val'] || attrs.val || null; break;
          case 'ilvl':  if (para) para.listLevel = parseInt(attrs['w:val'] || attrs.val || '0', 10) || 0; break;
          case 'numPr': if (para && para.listLevel == null) para.listLevel = 0; break;
          case 'br':    if (para) para.text += '\n'; break;
          case 'tab':   if (para) para.text += '\t'; break;
          default: break;
        }
        if (selfClosing && (name === 'instrText' || name === 'delText')) skipDepth--;
      },
      onClose(nameRaw) {
        const name = local(nameRaw);
        if (name === 'instrText' || name === 'delText') { skipDepth = Math.max(0, skipDepth - 1); return; }
        switch (name) {
          case 'p':   flushPara(); break;
          case 'tc':  if (inTable && row) { row.push(cell.join('\n')); cell = null; } break;
          case 'tr':  if (inTable && row) { rows.push(row); row = null; } break;
          case 'tbl':
            if (rows && rows.length) blocks.push({ type: 'table', rows });
            inTable = false; rows = null; break;
          default: break;
        }
      },
      onText(text) {
        if (skipDepth > 0) return;
        if (para) para.text += text;
      },
    });
    flushPara();
    if (!blocks.length) blocks.push({ type: 'p', text: '(the document has no readable text)' });
    return { format: 'docx', blocks };
  }

  // ── .xlsx ──────────────────────────────────────────────────────────────

  /** "AB12" → column index 27 (0-based). */
  function colIndex(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const c = ref.charCodeAt(i);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    const out = [];
    let cur = null;
    walkXml(xml, {
      onOpen(nameRaw) { if (local(nameRaw) === 'si') cur = []; },
      onClose(nameRaw) { if (local(nameRaw) === 'si' && cur) { out.push(cur.join('')); cur = null; } },
      onText(t) { if (cur) cur.push(t); },
    });
    return out;
  }

  function parseSheet(xml, shared) {
    const rows = [];
    let row = null, rowIdx = 0;
    let cellRef = null, cellType = null, inValue = false, inInline = false;
    let value = '';
    walkXml(xml, {
      onOpen(nameRaw, attrs) {
        const name = local(nameRaw);
        if (name === 'row') { row = []; rowIdx = parseInt(attrs.r || '0', 10) || rows.length + 1; }
        else if (name === 'c') { cellRef = attrs.r || ''; cellType = attrs.t || 'n'; value = ''; }
        else if (name === 'v') inValue = true;
        else if (name === 'is' || name === 't') inInline = cellType === 'inlineStr' || cellType === 'str';
      },
      onClose(nameRaw) {
        const name = local(nameRaw);
        if (name === 'v') inValue = false;
        else if (name === 'is') inInline = false;
        else if (name === 'c' && row) {
          const at = cellRef ? colIndex(cellRef) : row.length;
          let text = value;
          if (cellType === 's') text = shared[parseInt(value, 10)] ?? '';
          while (row.length < at) row.push('');
          row[at] = text;
          cellRef = null; cellType = null; value = '';
        } else if (name === 'row' && row) {
          // Preserve blank rows so the sheet keeps its shape, but not a
          // trailing sea of them.
          while (rows.length < rowIdx - 1) rows.push([]);
          rows.push(row);
          row = null;
        }
      },
      onText(t) { if (inValue || inInline) value += t; },
    });
    while (rows.length && rows[rows.length - 1].every(c => !c)) rows.pop();
    return rows;
  }

  async function readXlsx(bytes) {
    const zip = await openZip(bytes);
    const shared = parseSharedStrings(await zip.readText('xl/sharedStrings.xml'));

    // Sheet names live in the workbook; the r:id → file mapping lives in the
    // rels. When either is missing we fall back to file order, which is right
    // often enough and never wrong in a way that loses data.
    const workbook = await zip.readText('xl/workbook.xml');
    const rels = await zip.readText('xl/_rels/workbook.xml.rels');
    const relTarget = new Map();
    if (rels) {
      walkXml(rels, { onOpen(n, a) {
        if (local(n) === 'Relationship' && a.Id && a.Target) relTarget.set(a.Id, a.Target);
      } });
    }
    const sheetDefs = [];
    if (workbook) {
      walkXml(workbook, { onOpen(n, a) {
        if (local(n) === 'sheet') sheetDefs.push({ name: a.name || `sheet${sheetDefs.length + 1}`, rid: a['r:id'] });
      } });
    }
    if (!sheetDefs.length) {
      for (const e of zip.entries) {
        if (/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)) sheetDefs.push({ name: e.name.split('/').pop(), path: e.name });
      }
    }

    const blocks = [];
    for (const def of sheetDefs) {
      let path = def.path;
      if (!path) {
        const target = def.rid ? relTarget.get(def.rid) : null;
        path = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : null;
      }
      if (!path || !zip.has(path)) continue;
      const rows = parseSheet(await zip.readText(path), shared);
      blocks.push({ type: 'sheet', name: def.name, rows });
    }
    if (!blocks.length) throw new Error('no readable worksheets in this workbook');
    return { format: 'xlsx', blocks };
  }

  // ── .pptx ──────────────────────────────────────────────────────────────

  async function readPptx(bytes) {
    const zip = await openZip(bytes);
    const slides = zip.entries
      .map(e => e.name)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => (parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10)));
    if (!slides.length) throw new Error('no slides in this presentation');

    const blocks = [];
    for (let i = 0; i < slides.length; i++) {
      const xml = await zip.readText(slides[i]);
      const lines = [];
      let para = null;
      walkXml(xml, {
        onOpen(nameRaw) { if (local(nameRaw) === 'p') para = []; },
        onClose(nameRaw) {
          if (local(nameRaw) !== 'p') return;
          const text = (para || []).join('').trim();
          if (text) lines.push(text);
          para = null;
        },
        onText(t) { if (para) para.push(t); },
      });
      // A slide's first line is nearly always its title placeholder.
      blocks.push({ type: 'slide', n: i + 1, title: lines[0] || '', lines: lines.slice(1) });
    }
    return { format: 'pptx', blocks };
  }

  // ── OpenDocument (.odt / .ods / .odp) ──────────────────────────────────

  async function readOdf(bytes, ext) {
    const zip = await openZip(bytes);
    const xml = await zip.readText('content.xml');
    if (!xml) throw new Error('no content.xml — is this really an OpenDocument file?');

    const blocks = [];
    let text = null, heading = 0, listDepth = 0;
    let table = null, row = null, cell = null, tableName = '';
    let repeat = 1;

    function flush() {
      if (text === null) return;
      const t = text.trim();
      text = null;
      if (cell) { if (t) cell.push(t); return; }
      if (!t) return;
      if (heading) blocks.push({ type: 'h', level: Math.min(3, heading), text: t });
      else if (listDepth) blocks.push({ type: 'li', level: listDepth - 1, text: t });
      else blocks.push({ type: 'p', text: t });
    }

    walkXml(xml, {
      onOpen(nameRaw, attrs, selfClosing) {
        const name = local(nameRaw);
        if (name === 'list') listDepth++;
        else if (name === 'table') { flush(); table = []; tableName = attrs['table:name'] || `table ${blocks.length + 1}`; }
        else if (name === 'table-row') { row = []; repeat = parseInt(attrs['table:number-rows-repeated'] || '1', 10) || 1; }
        else if (name === 'table-cell') {
          cell = [];
          const rep = parseInt(attrs['table:number-columns-repeated'] || '1', 10) || 1;
          cell._repeat = Math.min(rep, 64);
        }
        else if (name === 'h') { flush(); heading = parseInt(attrs['text:outline-level'] || '1', 10) || 1; text = ''; }
        else if (name === 'p') { flush(); heading = 0; text = ''; }
        else if (name === 'line-break') { if (text !== null) text += '\n'; }
        else if (name === 'tab') { if (text !== null) text += '\t'; }
        else if (name === 's' && selfClosing) { if (text !== null) text += ' '; }
      },
      onClose(nameRaw) {
        const name = local(nameRaw);
        if (name === 'list') listDepth = Math.max(0, listDepth - 1);
        else if (name === 'h' || name === 'p') { flush(); heading = 0; }
        else if (name === 'table-cell' && row) {
          const v = cell.join('\n');
          for (let i = 0; i < (cell._repeat || 1); i++) row.push(v);
          cell = null;
        }
        else if (name === 'table-row' && table && row) {
          // A run of identical empty rows is how ODS pads a sheet — keep one.
          const reps = row.some(c => c) ? Math.min(repeat, 64) : 1;
          for (let i = 0; i < reps; i++) table.push(row.slice());
          row = null;
        }
        else if (name === 'table' && table) {
          while (table.length && table[table.length - 1].every(c => !c)) table.pop();
          if (table.length) {
            blocks.push(ext === 'ods'
              ? { type: 'sheet', name: tableName, rows: table }
              : { type: 'table', rows: table });
          }
          table = null;
        }
      },
      onText(t) { if (text !== null) text += t; },
    });
    flush();
    if (!blocks.length) blocks.push({ type: 'p', text: '(the document has no readable text)' });
    return { format: ext || 'odf', blocks };
  }

  // ── Plain formats ──────────────────────────────────────────────────────

  function parseDelimited(text, sep) {
    if (sep === ',' && typeof window !== 'undefined' && window.CsvImport?.parseCSV) {
      return window.CsvImport.parseCSV(text);
    }
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"' && cur === '') inQ = true;
      else if (ch === sep) { row.push(cur); cur = ''; }
      else if (ch === '\r') { /* swallow */ }
      else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  /**
   * A deliberately small markdown reader: headings, lists, quotes, rules,
   * fenced code, and pipe tables. Inline emphasis is left as written — this
   * is a document viewer, not a markdown renderer, and showing `**bold**`
   * verbatim is more honest than half-parsing it.
   */
  function readMarkdown(text) {
    const blocks = [];
    const lines = text.split(/\r?\n/);
    let para = [];
    let fence = null, code = [];

    const flushPara = () => {
      if (!para.length) return;
      blocks.push({ type: 'p', text: para.join(' ').trim() });
      para = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fence !== null) {
        if (line.trimEnd() === fence || line.startsWith(fence)) {
          blocks.push({ type: 'code', text: code.join('\n'), lang: null });
          fence = null; code = [];
        } else code.push(line);
        continue;
      }
      const fenceOpen = /^\s*(```|~~~)(.*)$/.exec(line);
      if (fenceOpen) { flushPara(); fence = fenceOpen[1]; code = []; continue; }

      if (!line.trim()) { flushPara(); continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flushPara(); blocks.push({ type: 'h', level: Math.min(3, h[1].length), text: h[2].trim() }); continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); blocks.push({ type: 'hr' }); continue; }
      const q = /^\s*>\s?(.*)$/.exec(line);
      if (q) { flushPara(); blocks.push({ type: 'quote', text: q[1] }); continue; }
      const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        flushPara();
        blocks.push({ type: 'li', level: Math.floor(li[1].length / 2), text: li[2] });
        continue;
      }
      // A pipe table: header, a --- separator row, then body rows.
      if (line.includes('|') && /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1] || '')) {
        flushPara();
        const rows = [];
        const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
        rows.push(cells(line));
        i++;
        while (i + 1 < lines.length && lines[i + 1].includes('|')) rows.push(cells(lines[++i]));
        blocks.push({ type: 'table', rows });
        continue;
      }
      para.push(line.trim());
    }
    flushPara();
    if (fence !== null && code.length) blocks.push({ type: 'code', text: code.join('\n'), lang: null });
    return { format: 'markdown', blocks };
  }

  // RTF groups whose contents are metadata, not body text. A reader that only
  // strips control words spills the font and colour tables into the document
  // ("Arial;Times New Roman;…" before the first paragraph), so these are
  // skipped whole, braces and all.
  const RTF_SKIP_GROUPS = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'listtable',
    'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'colorschememapping',
    'latentstyles', 'datastore', 'xmlnstbl', 'header', 'footer', 'footnote',
  ]);

  /**
   * RTF: walk the group structure, skipping metadata destinations, and turn
   * control words into the characters they stand for. Not a typesetter — it
   * recovers the words and the paragraph breaks.
   */
  function readRtf(text) {
    let out = '';
    let depth = 0;
    const skipTo = [];          // depths at which we are inside a skipped group
    const skipping = () => skipTo.length > 0;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') {
        depth++;
        // Look ahead for the destination this group opens with.
        const m = /^\{\\\*?\\?([a-zA-Z]+)/.exec(text.slice(i, i + 24));
        const isIgnorable = text[i + 1] === '\\' && text[i + 2] === '*';
        if (isIgnorable || (m && RTF_SKIP_GROUPS.has(m[1]))) skipTo.push(depth);
        continue;
      }
      if (ch === '}') {
        if (skipTo.length && skipTo[skipTo.length - 1] === depth) skipTo.pop();
        depth--;
        continue;
      }
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === '\\' || next === '{' || next === '}') {
          if (!skipping()) out += next;
          i++;
          continue;
        }
        if (next === "'") {                       // \'e9 — a raw code-page byte
          const hex = text.slice(i + 2, i + 4);
          if (!skipping()) out += String.fromCharCode(parseInt(hex, 16) || 0);
          i += 3;
          continue;
        }
        const word = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(text.slice(i));
        if (!word) { i++; continue; }
        i += word[0].length - 1;
        if (skipping()) continue;
        const name = word[1], arg = word[2];
        if (name === 'par' || name === 'line') out += '\n';
        else if (name === 'tab') out += '\t';
        else if (name === 'u' && arg != null) out += String.fromCharCode(((+arg) + 65536) % 65536);
        continue;
      }
      if (!skipping() && ch !== '\r') out += ch;
    }

    const blocks = out.split(/\n+/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(text => ({ type: 'p', text }));
    if (!blocks.length) blocks.push({ type: 'p', text: '(no readable text)' });
    return { format: 'rtf', blocks };
  }

  async function readArchive(bytes) {
    const zip = await openZip(bytes);
    const entries = zip.entries
      .filter(e => !e.name.endsWith('/'))
      .map(e => ({ name: e.name, size: e.size, compressedSize: e.compressedSize }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { format: 'zip', blocks: [{ type: 'files', entries }] };
  }

  // ── Dispatch ───────────────────────────────────────────────────────────

  function extOf(name) {
    const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // ext → how the viewer should handle it. 'native' means this module parses
  // it into blocks; 'media' means the browser renders the bytes directly
  // (img/video/audio/iframe); 'text' means show it as monospace source.
  const HANDLERS = {
    docx: 'docx', docm: 'docx', dotx: 'docx',
    xlsx: 'xlsx', xlsm: 'xlsx', xltx: 'xlsx',
    pptx: 'pptx', pptm: 'pptx', potx: 'pptx',
    odt: 'odf', ods: 'odf', odp: 'odf', odg: 'odf',
    rtf: 'rtf',
    csv: 'delimited', tsv: 'delimited',
    md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    json: 'json', geojson: 'json',
    zip: 'archive',
  };

  const MIME_HANDLERS = [
    [/officedocument\.wordprocessingml/, 'docx'],
    [/officedocument\.spreadsheetml/, 'xlsx'],
    [/officedocument\.presentationml/, 'pptx'],
    [/opendocument/, 'odf'],
    [/rtf/, 'rtf'],
    [/(^text\/csv|tab-separated)/, 'delimited'],
    [/markdown/, 'markdown'],
    [/json/, 'json'],
    [/(zip|x-zip-compressed)/, 'archive'],
  ];

  /** Which reader (if any) can turn this document into blocks. */
  function handlerFor(doc) {
    const byExt = HANDLERS[extOf(doc?.name)];
    if (byExt) return byExt;
    const mime = String(doc?.mime || '').toLowerCase();
    for (const [re, h] of MIME_HANDLERS) if (re.test(mime)) return h;
    return null;
  }

  function canView(doc) { return handlerFor(doc) !== null; }

  /**
   * Parse `bytes` into { format, blocks } for the viewer. Throws with a
   * plain-language message when the file isn't what its name claims.
   */
  async function read(bytes, doc) {
    const handler = handlerFor(doc);
    const ext = extOf(doc?.name);
    switch (handler) {
      case 'docx':      return await readDocx(bytes);
      case 'xlsx':      return await readXlsx(bytes);
      case 'pptx':      return await readPptx(bytes);
      case 'odf':       return await readOdf(bytes, ext);
      case 'archive':   return await readArchive(bytes);
      case 'rtf':       return readRtf(dec(bytes));
      case 'delimited': return { format: ext || 'csv', blocks: [{ type: 'table', rows: parseDelimited(dec(bytes), ext === 'tsv' ? '\t' : ',') }] };
      case 'markdown':  return readMarkdown(dec(bytes));
      case 'json': {
        const text = dec(bytes);
        try {
          return { format: 'json', blocks: [{ type: 'code', text: JSON.stringify(JSON.parse(text), null, 2), lang: 'json' }] };
        } catch {
          return { format: 'json', blocks: [{ type: 'code', text, lang: 'json' }] };
        }
      }
      default:
        throw new Error('no native reader for this format');
    }
  }

  const api = {
    canView, handlerFor, read, extOf,
    openZip, walkXml, unescapeXml, local,
    readDocx, readXlsx, readPptx, readOdf, readMarkdown, readRtf, readArchive,
    parseDelimited, parseSheet, parseSharedStrings, colIndex,
    version: 1,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.DocView = api;
})();
