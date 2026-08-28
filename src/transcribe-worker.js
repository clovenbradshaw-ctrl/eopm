// transcribe-worker.js — Whisper inference, off the main thread.
//
// Runs entirely in the browser: the model weights come from Hugging Face's
// CDN on first use (the one network dependency this adds — analogous to
// data-chat.js's own lazy load of the Cleo engine from an eoreader3
// deployment), but the AUDIO ITSELF never leaves the tab. The bytes this
// worker transcribes are already-decrypted plaintext handed in by the main
// thread, exactly the plaintext the <audio> element already plays — nothing
// about E2EE changes by adding this.
//
// Deliberately full precision, explicitly requested rather than left to
// the library's per-model default. Two separate reasons converge on the
// same setting:
//
//   1. A known Whisper failure mode is degenerate/hallucinated repetition
//      ("we're going to say we're going to say...") under forced 8-bit
//      quantization on the ONNX web runtime — confirmed by reading a
//      sibling project's own postmortem (ab/vendor/voice.js's fix commit
//      e1b89d5: "revert forced quantization back to the library's default
//      full-precision load. Quantized ONNX speech weights are a known
//      source of exactly this failure mode").
//   2. Leaving `dtype` unset is NOT the same as full precision for this
//      model repo, contrary to what an earlier draft of this comment
//      assumed — measured live: onnx-community/whisper-base's own default
//      dtype resolution picked a mixed-precision decoder file whose
//      embed_tokens weight is quantized without the scale tensor
//      DequantizeLinear needs, and onnxruntime-web refuses to create a
//      session at all ("Missing required scale:
//      model.decoder.embed_tokens.weight_merged_0_scale"). `dtype: 'fp32'`
//      sidesteps this a different way than intended, but the same way: no
//      quantized weights, so no missing-scale failure mode either.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

let asr = null;
let loading = null;

async function ensureModel(onProgress) {
  if (asr) return asr;
  if (!loading) {
    loading = pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', {
      dtype: 'fp32',
      progress_callback: (p) => {
        if (p?.status === 'progress' && typeof p.progress === 'number') {
          onProgress?.({ status: 'downloading', file: p.file, pct: Math.round(p.progress) });
        } else if (p?.status) {
          onProgress?.({ status: p.status, file: p.file });
        }
      },
    });
  }
  asr = await loading;
  return asr;
}

self.onmessage = async (e) => {
  const { id, pcm, sampleRate } = e.data;
  try {
    if (sampleRate !== 16000) {
      throw new Error(`expected 16000Hz mono PCM, got ${sampleRate}Hz`);
    }
    const model = await ensureModel((p) => self.postMessage({ id, type: 'progress', progress: p }));
    self.postMessage({ id, type: 'progress', progress: { status: 'transcribing' } });
    const result = await model(pcm, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      language: 'english',
    });
    const chunks = Array.isArray(result?.chunks)
      ? result.chunks.map((c) => ({
          text: String(c.text || '').trim(),
          start: c.timestamp?.[0] ?? null,
          end: c.timestamp?.[1] ?? null,
        }))
      : [];
    self.postMessage({
      id, type: 'done',
      result: { text: String(result?.text || '').trim(), chunks },
    });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err?.message || String(err) });
  }
};
