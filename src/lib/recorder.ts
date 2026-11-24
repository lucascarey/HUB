/**
 * Records one spoken phrase from the microphone and returns it as 16 kHz WAV (base64).
 * Stops by itself after ~1.2 s of silence once speech started, after 12 s, or after 6 s with no speech.
 * Used where the browser's speech recognizer is missing (the desktop app, Firefox).
 */
const RATE = 16000;
const WORKLET = `
class Rec extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("rec", Rec);
`;

let cancelCurrent: (() => void) | null = null;

/** Stops a recording in progress early (what was heard so far is kept). */
export function stopRecording() {
  cancelCurrent?.();
}

export async function recordPhrase(onLevel?: (level: number) => void): Promise<string | null> {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: RATE });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const src = ctx.createMediaStreamSource(media);
  const node = new AudioWorkletNode(ctx, "rec");
  const chunks: Float32Array[] = [];

  const result = await new Promise<Float32Array[] | null>((resolve) => {
    let spoke = false;
    let quietSince = performance.now();
    const start = performance.now();
    // Noise floor: adapts during the first half second.
    let floor = 0.004;
    const finish = (ok: boolean) => {
      cancelCurrent = null;
      node.port.onmessage = null;
      resolve(ok && spoke ? chunks : null);
    };
    cancelCurrent = () => finish(true);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const s = e.data;
      chunks.push(s);
      let sum = 0;
      for (let i = 0; i < s.length; i++) sum += s[i] * s[i];
      const rms = Math.sqrt(sum / s.length);
      onLevel?.(Math.min(1, rms * 12));
      const t = performance.now();
      if (t - start < 500) floor = Math.max(floor, rms * 1.5);
      const loud = rms > Math.max(0.012, floor * 2.2);
      if (loud) {
        spoke = true;
        quietSince = t;
      }
      if (spoke && t - quietSince > 1200) finish(true);
      else if (!spoke && t - start > 6000) finish(false);
      else if (t - start > 12000) finish(true);
    };
    src.connect(node);
  });

  media.getTracks().forEach((t) => t.stop());
  await ctx.close().catch(() => {});
  return result ? toWavBase64(result) : null;
}

function toWavBase64(chunks: Float32Array[]) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks)
    for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i])) * 32767, true);
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
