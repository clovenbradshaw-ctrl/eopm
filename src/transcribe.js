/**
 * transcribe.js — audio → text, with the timestamps that make text
 * clickable back into the audio it came from.
 *
 * Exposes `window.Transcribe` so the Babel-compiled drive UI
 * (public/drive-view.jsx, a classic script — see main.js's own header for
 * why the split exists) can call it without needing a module graph of its
 * own. Same bridge pattern as `window.MatrixLive`.
 *
 * The pipeline:
 *   bytes (whatever codec the file is) --[Web Audio]--> mono 16kHz PCM
 *     --[Worker, transcribe-worker.js]--> Whisper --> { text, chunks }
 *
 * Decoding happens on the main thread (the Web Audio API's decoder is not
 * available in a worker in every browser this app targets); the model
 * download and the actual inference — the expensive, blocking part — run
 * in the worker, so a multi-minute file never freezes the tab.
 *
 * The worker is one instance, reused across calls. Loading the model is a
 * one-time network fetch (browser HTTP cache carries it across reloads);
 * dropping the worker between transcriptions would re-pay that cost.
 */

const SAMPLE_RATE = 16000;

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./transcribe-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, type } = e.data;
    const job = pending.get(id);
    if (!job) return;
    if (type === 'progress') { job.onProgress?.(e.data.progress); return; }
    pending.delete(id);
    if (type === 'done') job.resolve(e.data.result);
    else job.reject(new Error(e.data.message || 'transcription failed'));
  };
  worker.onerror = (e) => {
    // A worker-level error (e.g. the module failed to load) has no `id` to
    // route to — it means every job in flight lost its worker.
    const err = new Error(e.message || 'transcription worker crashed');
    for (const job of pending.values()) job.reject(err);
    pending.clear();
    worker = null;
  };
  return worker;
}

/**
 * Decode arbitrary audio bytes to mono 16kHz Float32 PCM — the shape
 * Whisper wants, and the same shape the-fold's server-side ffmpeg path
 * produces (`-ar 16000 -ac 1 -f f32le`), done here with the Web Audio API
 * instead of a subprocess since this app has no server of its own.
 */
async function decodeToPcm16k(bytes) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const probe = new AudioCtx();
  let decoded;
  try {
    decoded = await probe.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } finally {
    probe.close().catch(() => {});
  }
  if (decoded.sampleRate === SAMPLE_RATE && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0).slice();
  }
  // Resample + downmix by rendering through an OfflineAudioContext at the
  // target rate — the standard way to get a browser's own resampler to do
  // this instead of hand-rolling one.
  const duration = decoded.duration;
  const offline = new OfflineAudioContext(1, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

/**
 * Transcribe one audio file. `onProgress` receives worker status objects
 * ({status:'downloading', file, pct} while the model fetches, then
 * {status:'transcribing'}). Resolves to { text, chunks: [{text, start,
 * end}] } — `start`/`end` in seconds, `null` when Whisper didn't attach a
 * timestamp to that chunk.
 */
export async function transcribeAudio(bytes, mime, { onProgress } = {}) {
  onProgress?.({ status: 'decoding' });
  const pcm = await decodeToPcm16k(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage(
      { id, pcm, sampleRate: SAMPLE_RATE },
      [pcm.buffer]
    );
  });
}

export function isSupported() {
  return !!(window.AudioContext || window.webkitAudioContext) && typeof Worker !== 'undefined';
}

window.Transcribe = { transcribeAudio, isSupported };
