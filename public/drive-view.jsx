/* drive-view.jsx — the drive: folders, files, previews, and the attachment
 * picker every table cell shares.
 *
 * The data model lives in drive.js; this file is the surface. Three exports:
 *
 *   window.DriveView          the page (sidebar → "drive")
 *   window.AttachmentControl  the cell/field control for `attachment` columns
 *   window.DriveBytes         { upload, read, objectUrl } — the byte seam
 *
 * Bytes never touch the log. A file is encrypted and pushed to the media
 * store by MatrixLive.uploadBlob, which hands back a `__media` envelope; only
 * that envelope is DEF'd onto the document. Reads go the other way through
 * MatrixLive.readMedia, which prefers the local vault-encrypted mirror and
 * falls back to the homeserver.
 *
 * Demo spaces have no homeserver, so uploads land in an in-tab Map instead.
 * The document event is completely real — it folds, time-travels, and
 * persists with the rest of the demo store — but its bytes are gone on
 * refresh, and the UI says so rather than showing a broken preview.
 */

(function () {
const { useState, useEffect, useMemo, useRef, useCallback } = React;
const D = () => window.Drive;

// ─────────────────────────────────────────────────────────────────────────
// Byte seam
// ─────────────────────────────────────────────────────────────────────────

// Demo-only blob store: synthetic mxc → bytes. Never persisted.
const localBlobs = new Map();
let localSeq = 0;

async function uploadBytes(file, { live, onProgress }) {
  if (live && window.MatrixLive?.uploadBlob) {
    return await window.MatrixLive.uploadBlob(file, {
      name: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      onProgress,
    });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mxc = `local://demo/${++localSeq}`;
  localBlobs.set(mxc, bytes);
  return {
    __media: 0,
    mxc,
    mime: file.type || 'application/octet-stream',
    size: bytes.length,
    name: file.name || 'file',
    local: true,
  };
}

async function readBytes(ref) {
  if (!ref) return null;
  if (ref.mxc && localBlobs.has(ref.mxc)) return localBlobs.get(ref.mxc);
  if (ref.local) return null;                  // demo blob lost to a refresh
  if (!window.MatrixLive?.readMedia) return null;
  try { return await window.MatrixLive.readMedia(ref); }
  catch (e) { console.warn('[drive] read failed:', e?.message || e); return null; }
}

/**
 * The file as a Blob. A file over the homeserver's ceiling is stored as
 * ordered parts; MatrixLive stitches them by reference, so previewing a large
 * document never needs one contiguous buffer. Everything above this line
 * treats the document as a single file, which is what it is.
 */
async function readBlob(ref, mime) {
  if (!ref) return null;
  if (ref.mxc && localBlobs.has(ref.mxc)) {
    return new Blob([localBlobs.get(ref.mxc)], { type: mime || ref.mime || 'application/octet-stream' });
  }
  if (ref.local) return null;
  if (window.MatrixLive?.readMediaBlob) {
    try { return await window.MatrixLive.readMediaBlob(ref); }
    catch (e) { console.warn('[drive] read failed:', e?.message || e); return null; }
  }
  const bytes = await readBytes(ref);
  return bytes ? new Blob([bytes], { type: mime || 'application/octet-stream' }) : null;
}

/** How many media blobs back this document — 1 unless it was chunked. */
function partCount(doc) {
  const ref = doc?.file;
  return ref?.__media === 3 && Array.isArray(ref.parts) ? ref.parts.length : 1;
}

/**
 * Resolve a document's bytes to an object URL for <img>/<iframe>/download.
 * Returns { url, state } where state is 'idle' | 'loading' | 'ready' | 'gone'.
 * The URL is revoked when the doc changes or the component unmounts, so a
 * long browse session doesn't leak a blob per file it previewed.
 */
function useObjectUrl(doc, enabled = true) {
  const [entry, setEntry] = useState({ url: null, state: 'idle' });
  useEffect(() => {
    if (!enabled || !doc?.file) { setEntry({ url: null, state: 'idle' }); return; }
    let cancelled = false;
    let made = null;
    setEntry({ url: null, state: 'loading' });
    (async () => {
      const blob = await readBlob(doc.file, doc.mime);
      if (cancelled) return;
      if (!blob) { setEntry({ url: null, state: 'gone' }); return; }
      made = URL.createObjectURL(blob);
      setEntry({ url: made, state: 'ready' });
    })();
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [doc?._anchor, doc?.file?.mxc, enabled]);
  return entry;
}

/** Hand the file to the browser's downloader — one file, however it's stored. */
async function downloadDoc(doc) {
  const blob = await readBlob(doc?.file, doc?.mime);
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────────

function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function shortSender(mxid) {
  if (!mxid) return '';
  const m = /^@([^:]+):/.exec(mxid);
  return m ? m[1] : mxid;
}

/** The little square thumbnail: a real image preview, or the family icon. */
function DocThumb({ doc, size = 'sm', eager = false }) {
  const drive = D();
  const isImage = drive.kindOf(doc) === 'image';
  const { url, state } = useObjectUrl(doc, isImage && eager);
  if (isImage && state === 'ready' && url) {
    return <span className={`dv-thumb dv-thumb-${size} has-img`}><img src={url} alt="" /></span>;
  }
  return (
    <span className={`dv-thumb dv-thumb-${size} kind-${drive.kindOf(doc)}`}>
      <i className={`ph ph-${drive.iconFor(doc)}`} aria-hidden="true"></i>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Native document rendering
//
// docview.js turns Word/Excel/PowerPoint/OpenDocument/csv/markdown/json/rtf
// and zip listings into blocks; this draws them. The parse runs on the
// plaintext bytes in this tab — nothing is uploaded to a preview service,
// which is the whole reason the readers are hand-rolled.
// ─────────────────────────────────────────────────────────────────────────

const SHEET_ROW_CAP = 500;   // rows drawn per sheet before the "…more" note

function DocBlocks({ blocks }) {
  return (
    <div className="dv-doc">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'h':
            return <div key={i} className={`dv-doc-h h${b.level}`}>{b.text}</div>;
          case 'li':
            return <div key={i} className="dv-doc-li" style={{ marginLeft: 16 + (b.level || 0) * 18 }}>
              <span className="dv-doc-bullet">·</span>{b.text}
            </div>;
          case 'quote':
            return <blockquote key={i} className="dv-doc-quote">{b.text}</blockquote>;
          case 'hr':
            return <hr key={i} className="dv-doc-hr" />;
          case 'code':
            return <pre key={i} className="dv-doc-code">{b.text}</pre>;
          case 'table':
            return <DocTable key={i} rows={b.rows} />;
          case 'sheet':
            return (
              <div key={i} className="dv-doc-sheet">
                <div className="dv-doc-sheet-tab"><i className="ph ph-table" aria-hidden="true"></i> {b.name}</div>
                <DocTable rows={b.rows} header />
              </div>
            );
          case 'slide':
            return (
              <div key={i} className="dv-doc-slide">
                <div className="dv-doc-slide-n">slide {b.n}</div>
                {b.title && <div className="dv-doc-slide-title">{b.title}</div>}
                {b.lines.map((l, j) => <div key={j} className="dv-doc-slide-line">{l}</div>)}
                {!b.title && !b.lines.length && <div className="dv-doc-slide-empty">no text on this slide</div>}
              </div>
            );
          case 'files':
            return (
              <div key={i} className="dv-doc-files">
                <div className="dv-doc-h h3">{b.entries.length} files in this archive</div>
                {b.entries.map((e, j) => (
                  <div key={j} className="dv-doc-file">
                    <span className="dv-doc-file-name">{e.name}</span>
                    <span className="dv-doc-file-size">{D().fmtBytes(e.size)}</span>
                  </div>
                ))}
              </div>
            );
          default:
            return <p key={i} className="dv-doc-p">{b.text}</p>;
        }
      })}
    </div>
  );
}

function DocTable({ rows, header }) {
  const shown = rows.slice(0, SHEET_ROW_CAP);
  const width = shown.reduce((n, r) => Math.max(n, r.length), 0);
  if (!width) return <div className="dv-doc-empty">empty table</div>;
  return (
    <div className="dv-doc-tablewrap">
      <table className="dv-doc-table">
        {header && shown.length > 0 && (
          <thead>
            <tr>{Array.from({ length: width }, (_, c) => <th key={c}>{shown[0][c] ?? ''}</th>)}</tr>
          </thead>
        )}
        <tbody>
          {(header ? shown.slice(1) : shown).map((r, i) => (
            <tr key={i}>{Array.from({ length: width }, (_, c) => <td key={c}>{r[c] ?? ''}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > SHEET_ROW_CAP && (
        <div className="dv-doc-more">
          showing the first {SHEET_ROW_CAP.toLocaleString()} of {rows.length.toLocaleString()} rows —
          download the file for the rest
        </div>
      )}
    </div>
  );
}

/** Fetch the bytes, parse them with docview.js, and draw the result. */
function NativeDoc({ doc }) {
  const [result, setResult] = useState({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setResult({ state: 'loading' });
    (async () => {
      const bytes = await readBytes(doc.file);
      if (cancelled) return;
      if (!bytes) { setResult({ state: 'gone' }); return; }
      try {
        const parsed = await window.DocView.read(bytes, doc);
        if (!cancelled) setResult({ state: 'ready', ...parsed });
      } catch (e) {
        if (!cancelled) setResult({ state: 'error', message: e?.message || String(e) });
      }
    })();
    return () => { cancelled = true; };
  }, [doc?._anchor, doc?.file?.mxc]);

  if (result.state === 'loading') return <div className="dv-preview-none">reading the document…</div>;
  if (result.state === 'gone') return <MissingBytes doc={doc} />;
  if (result.state === 'error') {
    return (
      <div className="dv-preview-none">
        <i className="ph ph-warning" aria-hidden="true"></i>
        <div>couldn’t read this file: {result.message}</div>
        <button className="dv-btn ghost" onClick={() => downloadDoc(doc)}>download instead</button>
      </div>
    );
  }
  return <DocBlocks blocks={result.blocks} />;
}

function MissingBytes({ doc }) {
  return (
    <div className="dv-preview-none">
      <i className="ph ph-cloud-slash" aria-hidden="true"></i>
      <div>
        {doc.file?.local
          ? 'this demo file lived in the tab that uploaded it — the record survived the refresh, the bytes did not'
          : 'bytes not on this device and the media store did not answer'}
      </div>
    </div>
  );
}

/** Text/code source view — the fallback for anything with no richer reader. */
function TextDoc({ doc }) {
  const [text, setText] = useState({ state: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setText({ state: 'loading' });
    (async () => {
      const bytes = await readBytes(doc.file);
      if (cancelled) return;
      setText(bytes
        ? { state: 'ready', body: new TextDecoder().decode(bytes.slice(0, 400_000)), truncated: bytes.length > 400_000 }
        : { state: 'gone' });
    })();
    return () => { cancelled = true; };
  }, [doc?._anchor, doc?.file?.mxc]);

  if (text.state === 'loading') return <div className="dv-preview-none">fetching bytes…</div>;
  if (text.state === 'gone') return <MissingBytes doc={doc} />;
  return (
    <pre className="dv-preview-text">
      {text.body}
      {text.truncated && '\n\n… truncated at 400 KB — download the file for the rest'}
    </pre>
  );
}

function fmtTime(s) {
  if (s == null || !isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function transcribeStatusLabel(p) {
  if (!p) return 'transcribing…';
  if (p.status === 'decoding') return 'decoding audio…';
  if (p.status === 'downloading') return `downloading speech model… ${p.pct != null ? p.pct + '%' : ''}`.trim();
  if (p.status === 'transcribing') return 'transcribing…';
  return 'starting…';
}

/**
 * The transcript panel under an audio player: a "transcribe" button before
 * one exists, then clickable segments that seek the SAME <audio> element
 * the player above it controls (`audioRef`, shared with the caller) and
 * highlight in step with playback. The transcript itself is just another
 * DEF on the document — read straight off `doc.transcript`, not local
 * state — so it's already there on reopen, already synced to every
 * collaborator, and already time-travels with the rest of the log.
 */
function AudioTranscript({ doc, ctx, audioRef }) {
  const drive = D();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [activeIdx, setActiveIdx] = useState(-1);
  const transcript = doc.transcript;
  const chunks = Array.isArray(transcript?.chunks) ? transcript.chunks : [];

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !chunks.length) return;
    function onTime() {
      const t = el.currentTime;
      setActiveIdx(chunks.findIndex(c => c.start != null && c.end != null && t >= c.start && t < c.end));
    }
    el.addEventListener('timeupdate', onTime);
    return () => el.removeEventListener('timeupdate', onTime);
  }, [audioRef, chunks]);

  async function runTranscribe() {
    if (!window.Transcribe?.isSupported?.()) {
      setError('this browser can\'t transcribe audio here (no Web Audio / Worker support)');
      return;
    }
    setError(null);
    setBusy({ status: 'starting' });
    try {
      const bytes = await readBytes(doc.file);
      if (!bytes) throw new Error('the audio bytes are not available on this device');
      const result = await window.Transcribe.transcribeAudio(bytes, doc.mime, { onProgress: setBusy });
      await drive.attachTranscript(ctx, doc._anchor, {
        text: result.text,
        chunks: result.chunks,
        model: 'onnx-community/whisper-base',
        transcribedAt: new Date().toISOString(),
      });
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  function jump(chunk) {
    const el = audioRef.current;
    if (!el || chunk.start == null) return;
    el.currentTime = chunk.start;
    el.play().catch(() => {});
  }

  if (!transcript) {
    return (
      <div className="dv-transcript dv-transcript-empty">
        <button className="dv-btn ghost" onClick={runTranscribe} disabled={!!busy}>
          <i className="ph ph-waveform" aria-hidden="true"></i>
          {busy ? transcribeStatusLabel(busy) : 'transcribe'}
        </button>
        {!busy && !error && (
          <span className="dv-transcript-hint">runs in this tab · downloads a speech model on first use</span>
        )}
        {error && <div className="dv-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="dv-transcript">
      <div className="dv-transcript-head">
        <span>transcript</span>
        <button className="dv-icon-btn" onClick={runTranscribe} disabled={!!busy} title="re-transcribe">
          <i className="ph ph-arrow-clockwise" aria-hidden="true"></i>
        </button>
      </div>
      {busy && <div className="dv-progress"><span className="dv-progress-label">{transcribeStatusLabel(busy)}</span></div>}
      {error && <div className="dv-error">{error}</div>}
      <div className="dv-transcript-body">
        {chunks.length ? chunks.map((c, i) => (
          <span
            key={i}
            className={`dv-transcript-chunk ${i === activeIdx ? 'active' : ''} ${c.start == null ? 'no-time' : ''}`}
            onClick={() => jump(c)}
            title={c.start != null ? `jump to ${fmtTime(c.start)}` : 'no timestamp for this segment'}
          >{c.text} </span>
        )) : <span className="dv-transcript-chunk no-time">{transcript.text}</span>}
      </div>
    </div>
  );
}

/** Full-screen preview of one document, with download + the record backlinks. */
function DocPreviewModal({ doc, state, ctx, onClose, onJumpRecord }) {
  const drive = D();
  const viewer = drive.viewerFor(doc);
  // Only the media viewers need an object URL; the parsers work off raw bytes.
  const needsUrl = viewer === 'image' || viewer === 'pdf' || viewer === 'video' || viewer === 'audio';
  const { url, state: loadState } = useObjectUrl(doc, needsUrl);
  const audioRef = useRef(null);

  useEffect(() => {
    function esc(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const uses = useMemo(
    () => (state ? (drive.usageIndex(state).get(doc._anchor) || []) : []),
    [state, doc._anchor]
  );

  function body() {
    if (viewer === 'none') {
      return (
        <div className="dv-preview-none">
          <i className={`ph ph-${drive.iconFor(doc)}`} aria-hidden="true"></i>
          <div>no reader for this format yet — download it to open</div>
          <button className="dv-btn ghost" onClick={() => downloadDoc(doc)}>download</button>
        </div>
      );
    }
    if (viewer === 'native') return <NativeDoc doc={doc} />;
    if (viewer === 'text') return <TextDoc doc={doc} />;
    if (loadState === 'loading') return <div className="dv-preview-none">fetching bytes…</div>;
    if (loadState === 'gone') return <MissingBytes doc={doc} />;
    if (viewer === 'image') return <img className="dv-preview-img" src={url} alt={doc.name} />;
    if (viewer === 'pdf') return <iframe className="dv-preview-frame" src={url} title={doc.name} />;
    if (viewer === 'video') return <video className="dv-preview-img" src={url} controls />;
    return (
      <div className="dv-audio-wrap">
        <audio ref={audioRef} className="dv-preview-audio" src={url} controls />
        {ctx && <AudioTranscript doc={doc} ctx={ctx} audioRef={audioRef} />}
      </div>
    );
  }

  // Parsed documents scroll as a page; media centers in the frame.
  const paged = viewer === 'native' || viewer === 'text';

  return (
    <div className="dv-modal-backdrop" onClick={onClose}>
      <div className="dv-modal" onClick={e => e.stopPropagation()}>
        <header className="dv-modal-head">
          <DocThumb doc={doc} />
          <div className="dv-modal-title">
            <div className="dv-modal-name">{doc.name}</div>
            <div className="dv-modal-meta">
              {drive.fmtBytes(doc.size)} · {doc.mime || 'unknown type'} · added {relTime(doc._created)}
              {doc._sender ? ` by ${shortSender(doc._sender)}` : ''}
            </div>
          </div>
          <button className="dv-btn" onClick={() => downloadDoc(doc)}>
            <i className="ph ph-download-simple" aria-hidden="true"></i> download
          </button>
          <button className="dv-icon-btn" onClick={onClose} title="close (esc)">✕</button>
        </header>

        <div className={`dv-modal-body ${paged ? 'paged' : ''}`}>{body()}</div>

        <footer className="dv-modal-foot">
          {uses.length === 0 ? (
            <span className="dv-foot-muted">not attached to any record — it lives in the drive on its own</span>
          ) : (
            <>
              <span className="dv-foot-label">attached to</span>
              <div className="dv-uses">
                {uses.map((u, i) => (
                  <button key={i} className="dv-use-pill" onClick={() => onJumpRecord && onJumpRecord(u)}
                          title={`${u.type} · ${u.field}`}>
                    <span className="dv-use-type">{u.type}</span>
                    <span className="dv-use-name">{u.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Upload plumbing shared by the page and the attachment picker
// ─────────────────────────────────────────────────────────────────────────

/**
 * Upload files and INS a document for each. Returns the new doc anchors.
 * `onProgress` gets { done, total, name, pct } — a big file that streams for a
 * minute has to look different from one that has hung, so the byte percentage
 * is reported, not just the file count.
 */
async function uploadFiles(files, { ctx, state, folder, live, onProgress, onError }) {
  const drive = D();
  const anchors = [];
  const errors = [];
  const list = Array.from(files || []);
  // Collision-avoid against what's already filed here AND against the names
  // claimed earlier in this same batch (which aren't in state yet).
  const taken = drive.docsIn(state, folder).map(d => d.name);
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const report = (pct) => onProgress && onProgress({ done: i, total: list.length, name: file.name, pct });
    report(0);
    try {
      const ref = await uploadBytes(file, {
        live,
        onProgress: ({ loaded, total }) => report(total ? Math.round((loaded / total) * 100) : null),
      });
      const name = drive.uniqueName(file.name || 'file', taken);
      taken.push(name);
      anchors.push(await drive.createDoc(ctx, {
        name, ref, folder, mime: file.type, size: file.size,
      }));
    } catch (e) {
      console.warn('[drive] upload failed:', e);
      errors.push(`${file.name} — ${e?.message || e}`);
    }
  }
  onProgress && onProgress(null);
  if (errors.length && onError) onError(errors.join(' · '));
  return anchors;
}

/**
 * The upload line. Shows the byte percentage while a file streams, because a
 * multi-megabyte upload and a hung one look identical otherwise — which is
 * exactly the confusion a bare "uploading 1/1" produces.
 */
function UploadProgress({ progress }) {
  if (!progress || !progress.total) return null;
  const { done, total, name, pct } = progress;
  return (
    <div className="dv-progress">
      <span className="dv-progress-label">
        uploading {Math.min(done + 1, total)}/{total}
        {name ? ` · ${name}` : ''}
        {pct != null ? ` · ${pct}%` : ' · encrypting…'}
      </span>
      <span className="dv-progress-bar">
        <span className="dv-progress-fill" style={{ width: `${pct == null ? 4 : Math.max(2, pct)}%` }} />
      </span>
    </div>
  );
}

/**
 * The homeserver's per-file ceiling, asked once. Worth surfacing up front:
 * an over-limit upload doesn't come back as a tidy 413 — the connection is
 * usually cut mid-body, which the SDK can only report as an abort.
 */
function useUploadLimit(live) {
  const [limit, setLimit] = useState(null);
  useEffect(() => {
    if (!live || !window.MatrixLive?.maxUploadBytes) { setLimit(null); return; }
    let cancelled = false;
    window.MatrixLive.maxUploadBytes()
      .then(n => { if (!cancelled) setLimit(n || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [live]);
  return limit;
}

// ─────────────────────────────────────────────────────────────────────────
// Folder rail
// ─────────────────────────────────────────────────────────────────────────

function FolderNode({ state, folder, depth, current, onOpen, onDropDoc, expanded, toggle }) {
  const drive = D();
  const kids = drive.foldersIn(state, folder._anchor);
  const open = expanded.has(folder._anchor);
  const [over, setOver] = useState(false);
  return (
    <>
      <div
        className={`dv-tree-row ${current === folder._anchor ? 'active' : ''} ${over ? 'drop-over' : ''}`}
        style={{ paddingLeft: 8 + depth * 13 }}
        onClick={() => onOpen(folder._anchor)}
        onDragOver={e => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); onDropDoc(e, folder._anchor); }}
        title={folder.name}
      >
        <button
          className={`dv-tree-caret ${kids.length ? '' : 'empty'}`}
          onClick={e => { e.stopPropagation(); if (kids.length) toggle(folder._anchor); }}
          tabIndex={-1}
          aria-hidden={!kids.length}
        >{kids.length ? (open ? '▾' : '▸') : ''}</button>
        <i className={`ph ph-${open && kids.length ? 'folder-open' : 'folder'}`} aria-hidden="true"></i>
        <span className="dv-tree-name">{folder.name}</span>
      </div>
      {open && kids.map(k => (
        <FolderNode key={k._anchor} state={state} folder={k} depth={depth + 1}
                    current={current} onOpen={onOpen} onDropDoc={onDropDoc}
                    expanded={expanded} toggle={toggle} />
      ))}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────

function DriveView({ room, state, onEmit, scrubber, session, setSelection }) {
  const drive = D();
  const live = !!(session && !session.demo);
  const sender = session?.mxid || '@you:demo';
  const ME = window.MatrixEngine;
  const ctx = useMemo(() => ({ emit: onEmit, ME, sender }), [onEmit, ME, sender]);

  const [folder, setFolder] = useState(null);      // current folder anchor | null = root
  const [view, setView] = useState('grid');        // 'grid' | 'list'
  const [sort, setSort] = useState('modified');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);  // doc anchor
  const [previewing, setPreviewing] = useState(null);
  const [renaming, setRenaming] = useState(null);  // anchor being renamed
  const [renameDraft, setRenameDraft] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [showTrash, setShowTrash] = useState(false);
  const [railOpen, setRailOpen] = useState(false); // mobile: folder rail as a drawer
  useEffect(() => { setRailOpen(false); }, [folder, showTrash]);
  const [progress, setProgress] = useState(null);  // {done,total,name}
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const uploadLimit = useUploadLimit(live);

  const rootFolders = drive.foldersIn(state, null);
  const uses = useMemo(() => drive.usageIndex(state), [state]);
  const trashed = useMemo(
    () => drive.allDocs(state, { includeTrashed: true }).filter(d => drive.isTrashed(state, d)),
    [state]
  );

  // A search spans the whole drive; otherwise you see one folder's contents.
  const searching = query.trim().length > 0;
  const q = query.trim().toLowerCase();

  const shownFolders = useMemo(() => {
    if (showTrash) return [];
    const list = searching
      ? drive.allFolders(state).filter(f => String(f.name || '').toLowerCase().includes(q))
      : drive.foldersIn(state, folder);
    return list.slice().sort(drive.SORTS.name);
  }, [state, folder, q, searching, showTrash]);

  const shownDocs = useMemo(() => {
    const list = showTrash
      ? trashed
      : searching
        ? drive.allDocs(state).filter(d => String(d.name || '').toLowerCase().includes(q))
        : drive.docsIn(state, folder);
    return list.slice().sort(drive.SORTS[sort] || drive.SORTS.name);
  }, [state, folder, q, searching, sort, showTrash, trashed]);

  const selectedDoc = selected ? drive.getDoc(state, selected) : null;
  const crumbs = drive.folderPath(state, folder);

  function openFolder(anchor) {
    setFolder(anchor);
    setShowTrash(false);
    setSelected(null);
    setQuery('');
    if (anchor) {
      // Reveal the path to it in the rail.
      const path = drive.folderPath(state, anchor).map(f => f._anchor);
      setExpanded(prev => new Set([...prev, ...path]));
    }
  }

  const runUpload = useCallback(async (files) => {
    setError(null);
    const made = await uploadFiles(files, {
      ctx, state, folder, live,
      onProgress: setProgress,
      onError: (msg) => setError(msg),
    });
    setProgress(null);
    if (made.length === 1) setSelected(made[0]);
  }, [ctx, state, folder, live]);

  function onDropFiles(e) {
    e.preventDefault();
    setDragOver(false);
    // A doc dragged from the listing onto empty space files it here instead.
    const moved = e.dataTransfer.getData('application/x-eopm-doc');
    if (moved) { drive.moveDoc(ctx, moved, folder); return; }
    if (e.dataTransfer.files?.length) runUpload(e.dataTransfer.files);
  }

  function onDropDoc(e, targetFolder) {
    const docAnchor = e.dataTransfer.getData('application/x-eopm-doc');
    if (docAnchor) { drive.moveDoc(ctx, docAnchor, targetFolder); return; }
    const folderAnchor = e.dataTransfer.getData('application/x-eopm-folder');
    if (folderAnchor && !drive.wouldCycle(state, folderAnchor, targetFolder)) {
      drive.moveFolder(ctx, folderAnchor, targetFolder);
      return;
    }
    if (e.dataTransfer.files?.length) {
      uploadFiles(e.dataTransfer.files, {
        ctx, state, folder: targetFolder, live,
        onProgress: setProgress, onError: setError,
      }).then(() => setProgress(null));
    }
  }

  async function newFolder() {
    const taken = drive.foldersIn(state, folder).map(f => f.name);
    const anchor = await drive.createFolder(ctx, {
      name: drive.uniqueName('untitled folder', taken),
      parent: folder,
    });
    setRenaming(anchor);
    setRenameDraft('untitled folder');
  }

  function commitRename(anchor) {
    const name = renameDraft.trim();
    if (name) drive.renameEntity(ctx, anchor, name);
    setRenaming(null);
  }

  function jumpToRecord(u) {
    if (!setSelection) return;
    setPreviewing(null);
    setSelection({
      kind: 'slice', sliceId: `${u.type}.table`, sliceKind: 'table', tableId: u.type,
    });
  }

  const totalBytes = useMemo(
    () => drive.allDocs(state).reduce((n, d) => n + (d.size || 0), 0),
    [state]
  );
  const docCount = drive.allDocs(state).length;

  return (
    <div className="table-view drive-view">
      {scrubber}

      <div className="page-hero drive-hero">
        <div className="page-hero-eyebrow">
          <span className="page-hero-kind"><span className="page-hero-glyph">▤</span> drive</span>
          <span className="page-hero-sep">/</span>
          <span className="page-hero-crumb">{room?.title || 'workspace'}</span>
        </div>
        <div className="page-hero-title">Drive</div>
        <div className="page-hero-sub">
          Every file in this workspace, whether you filed it here or attached it to a record.
        </div>
        <div className="dv-hero-stats">
          <span><b>{docCount}</b> {docCount === 1 ? 'file' : 'files'}</span>
          <span><b>{drive.fmtBytes(totalBytes)}</b> stored</span>
          <span><b>{drive.allFolders(state).length}</b> folders</span>
          {uploadLimit && (
            <span title="the homeserver's per-upload ceiling — bigger files are split into parts automatically">
              over <b>{drive.fmtBytes(uploadLimit)}</b> uploads in parts
            </span>
          )}
          {!live && <span className="dv-hero-warn">demo · uploads stay in this tab</span>}
        </div>
      </div>

      <div className="dv-body">
        {railOpen && <div className="offcanvas-backdrop" onClick={() => setRailOpen(false)} />}
        <nav className={`dv-rail ${railOpen ? 'open' : ''}`}>
          <div
            className={`dv-tree-row root ${folder === null && !showTrash ? 'active' : ''}`}
            onClick={() => openFolder(null)}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); onDropDoc(e, null); }}
          >
            <span className="dv-tree-caret" />
            <i className="ph ph-hard-drives" aria-hidden="true"></i>
            <span className="dv-tree-name">all files</span>
          </div>
          {rootFolders.slice().sort(drive.SORTS.name).map(f => (
            <FolderNode
              key={f._anchor} state={state} folder={f} depth={1}
              current={showTrash ? null : folder} onOpen={openFolder} onDropDoc={onDropDoc}
              expanded={expanded}
              toggle={(a) => setExpanded(prev => {
                const next = new Set(prev);
                next.has(a) ? next.delete(a) : next.add(a);
                return next;
              })}
            />
          ))}
          <button className="dv-rail-add" onClick={newFolder}>
            <i className="ph ph-folder-plus" aria-hidden="true"></i> new folder
          </button>
          <div className="dv-rail-spacer" />
          <div
            className={`dv-tree-row trash ${showTrash ? 'active' : ''}`}
            onClick={() => { setShowTrash(true); setSelected(null); setQuery(''); }}
          >
            <span className="dv-tree-caret" />
            <i className="ph ph-trash" aria-hidden="true"></i>
            <span className="dv-tree-name">trash</span>
            {trashed.length > 0 && <span className="dv-tree-count">{trashed.length}</span>}
          </div>
        </nav>

        <section
          className={`dv-main ${dragOver ? 'drag-over' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false); }}
          onDrop={onDropFiles}
        >
          <div className="dv-toolbar">
            <button
              className="dv-rail-toggle"
              onClick={() => setRailOpen(o => !o)}
              title="browse folders"
              aria-label="browse folders"
            ><i className="ph ph-folders" aria-hidden="true"></i></button>
            <div className="dv-crumbs">
              {showTrash ? (
                <span className="dv-crumb current">trash</span>
              ) : (
                <>
                  <button className={`dv-crumb ${folder === null ? 'current' : ''}`}
                          onClick={() => openFolder(null)}>all files</button>
                  {crumbs.map(f => (
                    <React.Fragment key={f._anchor}>
                      <span className="dv-crumb-sep">/</span>
                      <button className={`dv-crumb ${f._anchor === folder ? 'current' : ''}`}
                              onClick={() => openFolder(f._anchor)}>{f.name}</button>
                    </React.Fragment>
                  ))}
                </>
              )}
              {searching && <span className="dv-crumb-note">· searching everywhere</span>}
            </div>
            <span className="dv-toolbar-spacer" />
            <div className="dv-search">
              <i className="ph ph-magnifying-glass" aria-hidden="true"></i>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="search files" />
              {query && <button className="dv-search-clear" onClick={() => setQuery('')}>✕</button>}
            </div>
            <select className="dv-sort" value={sort} onChange={e => setSort(e.target.value)} title="sort files">
              <option value="modified">last modified</option>
              <option value="name">name</option>
              <option value="size">size</option>
            </select>
            <div className="dv-viewtoggle">
              <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} title="grid">
                <i className="ph ph-squares-four" aria-hidden="true"></i>
              </button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} title="list">
                <i className="ph ph-list" aria-hidden="true"></i>
              </button>
            </div>
            <button className="dv-btn ghost" onClick={newFolder} disabled={showTrash}>
              <i className="ph ph-folder-plus" aria-hidden="true"></i> folder
            </button>
            <button className="dv-btn" onClick={() => fileRef.current?.click()} disabled={showTrash}>
              <i className="ph ph-upload-simple" aria-hidden="true"></i> upload
            </button>
            <input ref={fileRef} type="file" multiple hidden
                   onChange={e => { runUpload(e.target.files); e.target.value = ''; }} />
          </div>

          {progress && <UploadProgress progress={progress} />}
          {error && (
            <div className="dv-error">
              {error} <button className="tv-inline-link" onClick={() => setError(null)}>dismiss</button>
            </div>
          )}

          <div className={`dv-listing ${view}`}>
            {shownFolders.map(f => (
              <div
                key={f._anchor}
                className="dv-item folder"
                draggable
                onDragStart={e => e.dataTransfer.setData('application/x-eopm-folder', f._anchor)}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); e.stopPropagation(); onDropDoc(e, f._anchor); }}
                onDoubleClick={() => openFolder(f._anchor)}
                onClick={() => view === 'list' && openFolder(f._anchor)}
                title="open folder · drop files or documents onto it to file them here"
              >
                <span className="dv-thumb dv-thumb-sm kind-folder"><i className="ph ph-folder" aria-hidden="true"></i></span>
                {renaming === f._anchor ? (
                  <input
                    autoFocus className="dv-rename" value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(f._anchor)}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename(f._anchor);
                      if (e.key === 'Escape') setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="dv-item-name" onDoubleClick={e => {
                    e.stopPropagation(); setRenaming(f._anchor); setRenameDraft(f.name || '');
                  }}>{f.name}</span>
                )}
                <span className="dv-item-meta">
                  {drive.docsIn(state, f._anchor).length} files
                </span>
                <span className="dv-item-meta dv-col-when">{relTime(f._updated || f._created)}</span>
                <button className="dv-item-x" title="move folder to trash"
                        onClick={e => { e.stopPropagation(); drive.trash(ctx, f._anchor); }}>
                  <i className="ph ph-trash" aria-hidden="true"></i>
                </button>
              </div>
            ))}

            {shownDocs.map(d => {
              const used = uses.get(d._anchor) || [];
              return (
                <div
                  key={d._anchor}
                  className={`dv-item doc ${selected === d._anchor ? 'selected' : ''}`}
                  draggable={!showTrash}
                  onDragStart={e => e.dataTransfer.setData('application/x-eopm-doc', d._anchor)}
                  onClick={() => setSelected(d._anchor)}
                  onDoubleClick={() => setPreviewing(d._anchor)}
                  title="double-click to preview"
                >
                  <DocThumb doc={d} size={view === 'grid' ? 'lg' : 'sm'} eager={view === 'grid'} />
                  {renaming === d._anchor ? (
                    <input
                      autoFocus className="dv-rename" value={renameDraft}
                      onChange={e => setRenameDraft(e.target.value)}
                      onBlur={() => commitRename(d._anchor)}
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitRename(d._anchor);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="dv-item-name" onDoubleClick={e => {
                      e.stopPropagation(); setRenaming(d._anchor); setRenameDraft(d.name || '');
                    }}>{d.name}</span>
                  )}
                  <span className="dv-item-meta">{drive.fmtBytes(d.size)}</span>
                  {used.length > 0 && (
                    <span className="dv-item-used" title={used.map(u => `${u.type} · ${u.label}`).join('\n')}>
                      <i className="ph ph-paperclip" aria-hidden="true"></i>{used.length}
                    </span>
                  )}
                  <span className="dv-item-meta dv-col-when">{relTime(d._updated || d._created)}</span>
                  {showTrash ? (
                    <button className="dv-item-x restore" title="restore to the drive"
                            onClick={e => { e.stopPropagation(); drive.restore(ctx, d._anchor); }}>
                      <i className="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>
                    </button>
                  ) : (
                    <button className="dv-item-x" title="move to trash"
                            onClick={e => { e.stopPropagation(); drive.trash(ctx, d._anchor); }}>
                      <i className="ph ph-trash" aria-hidden="true"></i>
                    </button>
                  )}
                </div>
              );
            })}

            {shownFolders.length === 0 && shownDocs.length === 0 && (
              <div className="dv-empty">
                {showTrash ? 'trash is empty'
                  : searching ? `nothing matches "${query}"`
                  : (
                    <>
                      <i className="ph ph-tray" aria-hidden="true"></i>
                      <div>drop files here, or use <b>upload</b></div>
                      <div className="dv-empty-sub">
                        files you attach to a record from its table land here too
                      </div>
                    </>
                  )}
              </div>
            )}
          </div>
        </section>

        {selectedDoc && (
          <aside className="dv-info">
            <div className="dv-info-head">
              <DocThumb doc={selectedDoc} size="lg" eager />
              <div className="dv-info-name">{selectedDoc.name}</div>
              <button className="dv-icon-btn" onClick={() => setSelected(null)} title="close">✕</button>
            </div>
            <dl className="dv-info-rows">
              <div><dt>type</dt><dd>{selectedDoc.mime || 'unknown'}</dd></div>
              <div><dt>size</dt><dd>{drive.fmtBytes(selectedDoc.size)}</dd></div>
              <div><dt>added</dt><dd>{relTime(selectedDoc._created)}</dd></div>
              <div><dt>by</dt><dd>{shortSender(selectedDoc._sender) || '—'}</dd></div>
              <div><dt>folder</dt><dd>
                {selectedDoc.folder
                  ? (state.entities[selectedDoc.folder]?.name || 'unknown')
                  : 'all files'}
              </dd></div>
              {partCount(selectedDoc) > 1 && (
                <div><dt>stored</dt><dd title="split to fit the homeserver's per-file limit; it opens and downloads as one file">
                  in {partCount(selectedDoc)} encrypted parts
                </dd></div>
              )}
              <div><dt>anchor</dt><dd className="dv-mono">{selectedDoc._anchor}</dd></div>
            </dl>

            <div className="dv-info-section">
              <div className="dv-info-label">attached to</div>
              {(uses.get(selectedDoc._anchor) || []).length === 0 ? (
                <div className="dv-info-empty">no records — this file stands on its own</div>
              ) : (
                <div className="dv-uses">
                  {(uses.get(selectedDoc._anchor) || []).map((u, i) => (
                    <button key={i} className="dv-use-pill" onClick={() => jumpToRecord(u)}
                            title={`${u.type} · field "${u.field}"`}>
                      <span className="dv-use-type">{u.type}</span>
                      <span className="dv-use-name">{u.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="dv-info-section">
              <div className="dv-info-label">move to</div>
              <select
                className="dv-move"
                value={selectedDoc.folder || ''}
                onChange={e => drive.moveDoc(ctx, selectedDoc._anchor, e.target.value || null)}
              >
                <option value="">all files</option>
                {drive.allFolders(state).slice().sort(drive.SORTS.name).map(f => (
                  <option key={f._anchor} value={f._anchor}>
                    {drive.folderPath(state, f._anchor).map(p => p.name).join(' / ')}
                  </option>
                ))}
              </select>
            </div>

            <div className="dv-info-actions">
              <button className="dv-btn" onClick={() => setPreviewing(selectedDoc._anchor)}>
                <i className="ph ph-eye" aria-hidden="true"></i> preview
              </button>
              <button className="dv-btn ghost" onClick={() => downloadDoc(selectedDoc)}>
                <i className="ph ph-download-simple" aria-hidden="true"></i> download
              </button>
            </div>
          </aside>
        )}
      </div>

      {previewing && drive.getDoc(state, previewing) && (
        <DocPreviewModal
          doc={drive.getDoc(state, previewing)}
          state={state}
          ctx={ctx}
          onClose={() => setPreviewing(null)}
          onJumpRecord={jumpToRecord}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Attachment control — the `attachment` column type, in the grid and the
// record panel. Chips are the drive's documents; the × detaches (a DEF on
// the record) and never touches the file.
// ─────────────────────────────────────────────────────────────────────────

function AttachmentPicker({ state, ctx, record, field, live, onClose }) {
  const drive = D();
  const uploadLimit = useUploadLimit(live);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);
  const attached = new Set(drive.anchorsInCell(record?.[field]));

  useEffect(() => {
    function esc(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return drive.allDocs(state)
      .filter(d => !q || String(d.name || '').toLowerCase().includes(q))
      .sort(drive.SORTS.modified)
      .slice(0, 60);
  }, [state, query]);

  async function uploadAndAttach(files) {
    setError(null);
    // Files uploaded from a record land at the drive root: they are drive
    // documents from the moment they exist, and the record just names them.
    const made = await uploadFiles(files, {
      ctx, state, folder: null, live,
      onProgress: setBusy, onError: setError,
    });
    setBusy(null);
    // Read-modify-write once for the whole batch — the record's cell isn't
    // re-folded between our own DEFs, so attaching one at a time would make
    // each write clobber the last.
    if (made.length) {
      const current = drive.anchorsInCell(record?.[field]);
      const next = [...current, ...made.filter(a => !current.includes(a))];
      ctx.emit(ctx.ME.OP.DEF, { anchor: record._anchor, path: field, value: next });
    }
    onClose();
  }

  return (
    <div className="dv-modal-backdrop" onClick={onClose}>
      <div className="dv-picker" onClick={e => e.stopPropagation()}>
        <header className="dv-picker-head">
          <span className="dv-picker-title">attach to <b>{drive.recordLabel(record)}</b></span>
          <button className="dv-icon-btn" onClick={onClose} title="close (esc)">✕</button>
        </header>

        <div className="dv-picker-upload">
          <button className="dv-btn" onClick={() => fileRef.current?.click()}>
            <i className="ph ph-upload-simple" aria-hidden="true"></i> upload a new file
          </button>
          <input ref={fileRef} type="file" multiple hidden
                 onChange={e => { uploadAndAttach(e.target.files); e.target.value = ''; }} />
          <span className="dv-picker-hint">
            it joins the drive too — attaching is a reference, not a copy
            {uploadLimit ? ` · over ${drive.fmtBytes(uploadLimit)} uploads in parts` : ''}
          </span>
        </div>
        {busy && <UploadProgress progress={busy} />}
        {error && <div className="dv-error">{error}</div>}

        <div className="dv-picker-search">
          <i className="ph ph-magnifying-glass" aria-hidden="true"></i>
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)}
                 placeholder="or pick one already in the drive" />
        </div>

        <div className="dv-picker-list">
          {candidates.length === 0 && (
            <div className="dv-info-empty">
              {query ? `nothing in the drive matches "${query}"` : 'the drive is empty — upload something'}
            </div>
          )}
          {candidates.map(d => {
            const on = attached.has(d._anchor);
            return (
              <button
                key={d._anchor}
                className={`dv-picker-row ${on ? 'on' : ''}`}
                onClick={() => {
                  if (on) drive.detach(ctx, record, field, d._anchor);
                  else drive.attach(ctx, record, field, d._anchor);
                  onClose();
                }}
              >
                <DocThumb doc={d} />
                <span className="dv-picker-name">{d.name}</span>
                <span className="dv-picker-meta">{drive.fmtBytes(d.size)}</span>
                {on && <span className="dv-picker-on">attached</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * `wrapTd` renders the control as a grid <td>; without it the caller supplies
 * its own container (the record-detail panel).
 *
 * The session is resolved here rather than threaded down through TableView:
 * MatrixLive.getSession() is null in a demo space and the live session
 * otherwise, which is exactly the live/demo split the upload seam needs.
 */
function AttachmentControl({ state, record, field, onEmit, wrapTd, compact }) {
  const drive = D();
  const ME = window.MatrixEngine;
  const session = window.MatrixLive?.getSession?.() || null;
  const live = !!(session && !session.demo);
  const sender = session?.mxid || '@you:demo';
  const ctx = useMemo(() => ({ emit: onEmit, ME, sender }), [onEmit, ME, sender]);
  const [picking, setPicking] = useState(false);
  const [previewing, setPreviewing] = useState(null);

  const docs = drive.resolveCell(state, record?.[field]);
  const dead = drive.anchorsInCell(record?.[field]).length - docs.length;

  const inner = (
    <div className="att-cell">
      {docs.map(d => (
        <span key={d._anchor} className="att-chip" title={`${d.name} · ${drive.fmtBytes(d.size)}`}>
          <button className="att-chip-open" onClick={() => setPreviewing(d._anchor)}>
            <i className={`ph ph-${drive.iconFor(d)}`} aria-hidden="true"></i>
            <span className="att-chip-name">{d.name}</span>
          </button>
          <button
            className="att-chip-x"
            title="remove from this record · the file stays in the drive"
            onClick={() => drive.detach(ctx, record, field, d._anchor)}
          >✕</button>
        </span>
      ))}
      {dead > 0 && (
        <span className="att-chip missing" title="the document was trashed in the drive">
          {dead} missing
        </span>
      )}
      <button className="att-add" onClick={() => setPicking(true)} title="attach a file">
        <i className="ph ph-paperclip" aria-hidden="true"></i>
        {!compact && !docs.length && <span>attach</span>}
      </button>

      {picking && (
        <AttachmentPicker
          state={state} ctx={ctx} record={record} field={field} live={live}
          onClose={() => setPicking(false)}
        />
      )}
      {previewing && drive.getDoc(state, previewing) && (
        <DocPreviewModal
          doc={drive.getDoc(state, previewing)}
          state={state}
          ctx={ctx}
          onClose={() => setPreviewing(null)}
        />
      )}
    </div>
  );

  if (!wrapTd) return inner;
  return <td className="cell att-td">{inner}</td>;
}

window.DriveView = DriveView;
window.AttachmentControl = AttachmentControl;
window.DocPreviewModal = DocPreviewModal;
window.DriveBytes = { upload: uploadBytes, read: readBytes, download: downloadDoc, useObjectUrl };

})();
