/**
 * Streaming "Hey Jarvis" detector: a TypeScript port of openWakeWord's feature pipeline
 * (github.com/dscripka/openWakeWord, Apache-2.0; models from its v0.5.1 release).
 * Feed 16 kHz int16-range samples; it reports a score per 80 ms frame.
 */
import type * as Ort from "onnxruntime-web";

const CHUNK = 1280; // 80 ms at 16 kHz
const MEL_BINS = 32;
const MEL_WINDOW = 76; // mel frames per embedding
const EMB = 96;
const EMB_WINDOW = 16; // embeddings per prediction

export interface Models {
  mel: Ort.InferenceSession;
  emb: Ort.InferenceSession;
  ww: Ort.InferenceSession;
}

export class WakeWordStream {
  private raw = new Float32Array(0);
  private pending = new Float32Array(0);
  private mel: Float32Array[] = Array.from({ length: MEL_WINDOW }, () => new Float32Array(MEL_BINS).fill(1));
  private emb: Float32Array[] = [];
  private frames = 0;

  constructor(private ort: typeof Ort, private m: Models) {}

  /** Adds audio; returns the scores for every complete 80 ms frame. */
  async push(samples: Float32Array): Promise<number[]> {
    this.pending = concat(this.pending, samples);
    const out: number[] = [];
    while (this.pending.length >= CHUNK) {
      const chunk = this.pending.subarray(0, CHUNK);
      this.pending = this.pending.slice(CHUNK);
      out.push(await this.frame(chunk));
    }
    return out;
  }

  private async frame(chunk: Float32Array) {
    const { ort, m } = this;
    // Melspectrogram over the new chunk plus 3 hops of context, as openWakeWord does.
    this.raw = concat(this.raw, chunk).slice(-(CHUNK + 160 * 3));
    const melOut = await m.mel.run({ [m.mel.inputNames[0]]: new ort.Tensor("float32", this.raw, [1, this.raw.length]) });
    const spec = melOut[m.mel.outputNames[0]].data as Float32Array;
    for (let i = 0; i + MEL_BINS <= spec.length; i += MEL_BINS) {
      const row = new Float32Array(MEL_BINS);
      for (let j = 0; j < MEL_BINS; j++) row[j] = spec[i + j] / 10 + 2;
      this.mel.push(row);
    }
    if (this.mel.length > 200) this.mel = this.mel.slice(-120);

    const win = new Float32Array(MEL_WINDOW * MEL_BINS);
    this.mel.slice(-MEL_WINDOW).forEach((r, i) => win.set(r, i * MEL_BINS));
    const embOut = await m.emb.run({ [m.emb.inputNames[0]]: new ort.Tensor("float32", win, [1, MEL_WINDOW, MEL_BINS, 1]) });
    this.emb.push(Float32Array.from(embOut[m.emb.outputNames[0]].data as Float32Array));
    if (this.emb.length > EMB_WINDOW) this.emb.shift();

    this.frames++;
    // Like openWakeWord, ignore the first frames while the buffers fill.
    if (this.emb.length < EMB_WINDOW || this.frames < 20) return 0;
    const feats = new Float32Array(EMB_WINDOW * EMB);
    this.emb.forEach((e, i) => feats.set(e, i * EMB));
    const res = await m.ww.run({ [m.ww.inputNames[0]]: new ort.Tensor("float32", feats, [1, EMB_WINDOW, EMB]) });
    return (res[m.ww.outputNames[0]].data as Float32Array)[0];
  }
}

function concat(a: Float32Array, b: Float32Array) {
  const c = new Float32Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}
