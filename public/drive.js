/* drive.js — the document store, read as a projection of the log.
 *
 * A "drive" is not a second database. Documents and folders are ordinary
 * entities in the same append-only room log every table folds out of, so
 * they time-travel, replay, and sync exactly like a row does:
 *
 *   folder   INS _folder {name, parent}      DEF name / parent      SEG _trashed
 *   document INS _doc    {name, mime, size, folder}
 *                        DEF file  → the `__media` ref (bytes on the media
 *                                    store, key inside the megolm event)
 *                        DEF name / folder                          SEG _trashed
 *
 * Both types start with `_`, so sidebar.jsx's buildSets() already keeps them
 * out of the user's set list — the drive is a lens on the log, not a table.
 *
 * ── Attachment is a reference, not a container ──────────────────────────
 *
 * A record "has" a document by naming it: a field of type `attachment` holds
 * an ARRAY OF DOC ANCHORS, written with a plain DEF like any other cell.
 * Nothing about the document lives inside the record.
 *
 *   attach  DEF <record> <field> [...existing, docAnchor]
 *   detach  DEF <record> <field> [...existing without docAnchor]
 *
 * So detaching is a write to the RECORD, never to the document — which is
 * why a file removed from a record stays in the drive, and why a file
 * uploaded straight into a record shows up in the drive the moment it is
 * INS'd. There is no second copy to keep in step, and "used in N records" is
 * just the reverse index of those DEFs (see `usageIndex`).
 *
 * Pure: no DOM and no globals beyond the assignment at the bottom, so it is
 * testable from Node with a `module` shim. The bytes themselves are handled
 * by media.js through window.MatrixLive; this file only ever handles refs.
 */

(function () {
  'use strict';

  const DOC_TYPE = '_doc';
  const FOLDER_TYPE = '_folder';
  const TRASH_PARTITION = '_trashed';
  const ATTACHMENT_TYPE = 'attachment';

  // ── Trash ──────────────────────────────────────────────────────────────
  // Deletion is a SEG into `_trashed`, matching the app's existing tombstone
  // convention: the log stays append-only, and scrubbing to a moment before
  // the SEG still shows the file where it was.

  function isTrashed(state, entity) {
    if (!entity) return true;
    return entity._partition === TRASH_PARTITION ||
           state.partitions?.[entity._anchor] === TRASH_PARTITION;
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  function allDocs(state, { includeTrashed = false } = {}) {
    return Object.values(state?.entities || {})
      .filter(e => e?._type === DOC_TYPE)
      .filter(e => includeTrashed || !isTrashed(state, e));
  }

  function allFolders(state, { includeTrashed = false } = {}) {
    return Object.values(state?.entities || {})
      .filter(e => e?._type === FOLDER_TYPE)
      .filter(e => includeTrashed || !isTrashed(state, e));
  }

  function getDoc(state, anchor) {
    const e = state?.entities?.[anchor];
    return e && e._type === DOC_TYPE ? e : null;
  }

  /** Documents filed directly in `folderAnchor` (null = the drive root). */
  function docsIn(state, folderAnchor, opts) {
    const target = folderAnchor || null;
    return allDocs(state, opts).filter(d => (d.folder || null) === target);
  }

  /** Sub-folders of `folderAnchor` (null = the drive root). */
  function foldersIn(state, folderAnchor, opts) {
    const target = folderAnchor || null;
    return allFolders(state, opts).filter(f => (f.parent || null) === target);
  }

  /**
   * Root → … → folder, for the breadcrumb. Defends against a parent cycle
   * (two concurrent moves can cross) by bailing once an anchor repeats.
   */
  function folderPath(state, folderAnchor) {
    const out = [];
    const seen = new Set();
    let cur = folderAnchor;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const f = state?.entities?.[cur];
      if (!f || f._type !== FOLDER_TYPE) break;
      out.unshift(f);
      cur = f.parent || null;
    }
    return out;
  }

  /**
   * Would moving `folderAnchor` under `targetAnchor` make a folder its own
   * ancestor? Guards the move before it writes a cycle into the log.
   */
  function wouldCycle(state, folderAnchor, targetAnchor) {
    if (!folderAnchor) return false;
    if (folderAnchor === targetAnchor) return true;
    return folderPath(state, targetAnchor).some(f => f._anchor === folderAnchor);
  }

  /** Every descendant folder anchor of `folderAnchor`, itself excluded. */
  function descendantFolders(state, folderAnchor, opts) {
    const out = [];
    const queue = [folderAnchor];
    const seen = new Set([folderAnchor]);
    while (queue.length) {
      for (const child of foldersIn(state, queue.pop(), opts)) {
        if (seen.has(child._anchor)) continue;
        seen.add(child._anchor);
        out.push(child._anchor);
        queue.push(child._anchor);
      }
    }
    return out;
  }

  // ── The attachment reverse index ───────────────────────────────────────

  /**
   * Which fields on which entity types are attachment fields, per the
   * declared schema: { entityType: [fieldName, …] }.
   */
  function attachmentFields(state) {
    const out = {};
    const fields = state?.schema?.fields || {};
    for (const [type, cols] of Object.entries(fields)) {
      if (!Array.isArray(cols)) continue;
      const names = cols.filter(c => c?.type === ATTACHMENT_TYPE).map(c => c.name);
      if (names.length) out[type] = names;
    }
    return out;
  }

  /** Normalize a cell value into an array of doc anchors. */
  function anchorsInCell(value) {
    if (Array.isArray(value)) return value.filter(v => typeof v === 'string' && v);
    if (typeof value === 'string' && value) return [value];
    return [];
  }

  /**
   * docAnchor → [{ anchor, type, field, label }] — every record that names
   * this document. Built by walking the declared attachment fields, so it
   * costs one pass over the entities that actually have such a field rather
   * than a scan of every value in the workspace.
   */
  function usageIndex(state) {
    const byType = attachmentFields(state);
    const index = new Map();
    if (!Object.keys(byType).length) return index;
    for (const e of Object.values(state?.entities || {})) {
      const fields = byType[e?._type];
      if (!fields) continue;
      for (const field of fields) {
        for (const docAnchor of anchorsInCell(e[field])) {
          if (!index.has(docAnchor)) index.set(docAnchor, []);
          index.get(docAnchor).push({
            anchor: e._anchor,
            type: e._type,
            field,
            label: recordLabel(e),
          });
        }
      }
    }
    return index;
  }

  function recordLabel(entity) {
    return entity?.Name || entity?.Title || entity?.name || entity?.title ||
           entity?.body || entity?.claim || entity?.what || entity?._anchor || '';
  }

  // ── Writes ─────────────────────────────────────────────────────────────
  //
  // Every writer takes the app's `emit(op, content)` and the operator table,
  // so demo rooms and live rooms travel the identical path.
  //
  // Emits are AWAITED in sequence, never fired off together. `emit` queues to
  // the outbox, which sends FIFO, and the homeserver stamps `origin_server_ts`
  // on receipt — so three concurrent enqueues can reach the server in any
  // order and come back with a `DEF` timestamped before the `INS` that
  // creates its entity. (The fold parks and replays such a write rather than
  // dropping it, but the ordering is ours to get right at the source.)

  function makeAnchor(ME, type, payload, sender, ts) {
    return ME.makeAnchor(type, payload, sender || '@you:demo', ts);
  }

  /** INS a folder. Resolves to its anchor. */
  async function createFolder(ctx, { name, parent = null }) {
    const { emit, ME, sender } = ctx;
    const payload = { name: name || 'untitled folder', parent: parent || null };
    const anchor = makeAnchor(ME, FOLDER_TYPE, payload, sender, Date.now());
    await emit(ME.OP.INS, { anchor, entity_type: FOLDER_TYPE, payload });
    return anchor;
  }

  /**
   * INS a document for an already-uploaded blob. `ref` is the `__media`
   * envelope from MatrixLive.uploadBlob (or a local demo ref). Returns the
   * doc anchor — attach it to a record by DEF'ing it into an attachment cell.
   */
  async function createDoc(ctx, { name, ref, folder = null, mime, size }) {
    const { emit, ME, sender } = ctx;
    const payload = {
      name: name || ref?.name || 'file',
      mime: mime || ref?.mime || 'application/octet-stream',
      size: size != null ? size : (ref?.size || 0),
      folder: folder || null,
    };
    const anchor = makeAnchor(ME, DOC_TYPE, payload, sender, Date.now());
    await emit(ME.OP.INS, { anchor, entity_type: DOC_TYPE, payload });
    // The ref rides in its own DEF rather than the INS payload: the anchor is
    // the hash of the payload, so keeping the (large, per-upload-unique) file
    // envelope out of it means re-uploading the same file to the same folder
    // is idempotent at the anchor level.
    await emit(ME.OP.DEF, { anchor, path: 'file', value: ref });
    await emit(ME.OP.DEF, { anchor, path: 'uploaded_at', value: new Date().toISOString() });
    return anchor;
  }

  function renameEntity(ctx, anchor, name) {
    const { emit, ME } = ctx;
    emit(ME.OP.DEF, { anchor, path: 'name', value: name });
  }

  /** Move a document into a folder (null = the drive root). */
  function moveDoc(ctx, anchor, folder) {
    const { emit, ME } = ctx;
    emit(ME.OP.DEF, { anchor, path: 'folder', value: folder || null });
  }

  /** Move a folder under another (null = the drive root). */
  function moveFolder(ctx, anchor, parent) {
    const { emit, ME } = ctx;
    emit(ME.OP.DEF, { anchor, path: 'parent', value: parent || null });
  }

  /** SEG into the trash partition. Reversible — see `restore`. */
  function trash(ctx, anchor) {
    const { emit, ME } = ctx;
    emit(ME.OP.SEG, { anchor, partition: TRASH_PARTITION });
  }

  function restore(ctx, anchor) {
    const { emit, ME } = ctx;
    emit(ME.OP.SEG, { anchor, partition: '' });
  }

  // ── Attach / detach ────────────────────────────────────────────────────

  /**
   * Add `docAnchor` to a record's attachment cell. Idempotent — attaching a
   * document twice leaves one reference.
   */
  function attach(ctx, record, field, docAnchor) {
    const { emit, ME } = ctx;
    const current = anchorsInCell(record?.[field]);
    if (current.includes(docAnchor)) return current;
    const next = [...current, docAnchor];
    emit(ME.OP.DEF, { anchor: record._anchor, path: field, value: next });
    return next;
  }

  /**
   * Drop `docAnchor` from a record's attachment cell. The document itself is
   * NOT touched: this is a DEF on the record, so the file keeps its place in
   * the drive, its folder, and every other record that references it.
   */
  function detach(ctx, record, field, docAnchor) {
    const { emit, ME } = ctx;
    const current = anchorsInCell(record?.[field]);
    const next = current.filter(a => a !== docAnchor);
    if (next.length === current.length) return current;
    emit(ME.OP.DEF, { anchor: record._anchor, path: field, value: next });
    return next;
  }

  /** Resolve an attachment cell to live doc entities, dropping dead refs. */
  function resolveCell(state, value) {
    return anchorsInCell(value)
      .map(a => getDoc(state, a))
      .filter(d => d && !isTrashed(state, d));
  }

  // ── Presentation helpers ───────────────────────────────────────────────

  const KIND_BY_MIME = [
    [/^image\//,                                     'image'],
    [/^video\//,                                     'video'],
    [/^audio\//,                                     'audio'],
    [/pdf/,                                          'pdf'],
    [/(zip|tar|gzip|compressed|7z|rar)/,             'archive'],
    [/(sheet|excel|csv|tab-separated)/,              'sheet'],
    [/(word|opendocument\.text|rtf)/,                'doc'],
    [/(presentation|powerpoint)/,                    'slides'],
    [/(json|xml|yaml|javascript|typescript|x-sh)/,   'code'],
    [/^text\//,                                      'text'],
  ];

  /** Coarse family for icon + preview decisions. */
  function kindOf(doc) {
    const mime = (doc?.mime || '').toLowerCase();
    const name = (doc?.name || '').toLowerCase();
    for (const [re, kind] of KIND_BY_MIME) if (re.test(mime)) return kind;
    if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(name)) return 'image';
    if (/\.pdf$/.test(name)) return 'pdf';
    if (/\.(csv|tsv|xlsx?)$/.test(name)) return 'sheet';
    if (/\.(docx?|rtf|odt)$/.test(name)) return 'doc';
    if (/\.(pptx?|key|odp)$/.test(name)) return 'slides';
    if (/\.(zip|tar|gz|7z|rar)$/.test(name)) return 'archive';
    if (/\.(json|ya?ml|xml|js|ts|py|sh|css|html?)$/.test(name)) return 'code';
    if (/\.(txt|md|log)$/.test(name)) return 'text';
    if (/\.(mp4|mov|webm|mkv)$/.test(name)) return 'video';
    if (/\.(mp3|wav|ogg|m4a|flac)$/.test(name)) return 'audio';
    return 'file';
  }

  // Phosphor icon per family — the drive's whole visual vocabulary.
  const ICON_BY_KIND = {
    image: 'image', video: 'film-strip', audio: 'music-note', pdf: 'file-pdf',
    archive: 'file-zip', sheet: 'table', doc: 'file-doc', slides: 'presentation',
    code: 'file-code', text: 'file-text', file: 'file',
  };

  function iconFor(doc) { return ICON_BY_KIND[kindOf(doc)] || 'file'; }

  /**
   * How the viewer should open this file:
   *
   *   image|video|audio|pdf  the browser renders the bytes directly
   *   native                 docview.js parses it into blocks (Office, ODF,
   *                          csv, markdown, json, rtf, zip listings)
   *   text                   monospace source
   *   none                   download-only
   *
   * `native` is checked before `text` so a .md or .csv gets its structure
   * rather than its source. Nothing is ever handed to a remote renderer —
   * the bytes are only plaintext inside this tab (see docview.js).
   */
  function viewerFor(doc) {
    const kind = kindOf(doc);
    if (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf') return kind;
    const DV = typeof window !== 'undefined' ? window.DocView : null;
    if (DV && DV.canView(doc)) return 'native';
    if (kind === 'text' || kind === 'code') return 'text';
    return 'none';
  }

  function isPreviewable(doc) { return viewerFor(doc) !== 'none'; }

  function fmtBytes(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  /**
   * Name a file that would otherwise collide with a sibling: "report.pdf"
   * becomes "report (2).pdf". Drive semantics — the log would happily hold
   * two files with the same name, but the user would not.
   */
  function uniqueName(name, taken) {
    const existing = new Set((taken || []).map(n => String(n).toLowerCase()));
    if (!existing.has(String(name).toLowerCase())) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; i < 1000; i++) {
      const candidate = `${stem} (${i})${ext}`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }
    return `${stem} (${Date.now()})${ext}`;
  }

  /** Sorters the drive toolbar offers. Folders always lead in the listing. */
  const SORTS = {
    name:     (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true }),
    modified: (a, b) => (b._updated || b._created || 0) - (a._updated || a._created || 0),
    size:     (a, b) => (b.size || 0) - (a.size || 0),
  };

  const api = {
    DOC_TYPE, FOLDER_TYPE, TRASH_PARTITION, ATTACHMENT_TYPE, SORTS,
    isTrashed, allDocs, allFolders, getDoc, docsIn, foldersIn,
    folderPath, wouldCycle, descendantFolders,
    attachmentFields, anchorsInCell, usageIndex, recordLabel,
    createFolder, createDoc, renameEntity, moveDoc, moveFolder, trash, restore,
    attach, detach, resolveCell,
    kindOf, iconFor, viewerFor, isPreviewable, fmtBytes, uniqueName,
    version: 1,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Drive = api;
})();
