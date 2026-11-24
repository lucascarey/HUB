/**
 * "Hey Jarvis" wake word that runs on the device with openWakeWord models (no account, no key,
 * no audio leaves the device). Keeps listening with the tab in the background.
 */
import { WakeWordStream } from "./oww";

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("tap", Tap);
`;
const THRESHOLD = 0.5;

let stream: WakeWordStream | null = null;
let loading: Promise<WakeWordStream> | null = null;
let ctx: AudioContext | null = null;
let media: MediaStream | null = null;
let listening = false;
let busy = false;
let cooldownUntil = 0;
let onWake: () => void = () => {};

async function load() {
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.wasmPaths = "/ort/";
  ort.env.wasm.numThreads = 1;
  const open = (f: string) => ort.InferenceSession.create(`/models/${f}.onnx`, { executionProviders: ["wasm"] });
  const [mel, emb, ww] = await Promise.all([open("melspectrogram"), open("embedding_model"), open("hey_jarvis_v0.1")]);
  return new WakeWordStream(ort, { mel, emb, ww });
}

/** Starts listening for "Hey Jarvis"; calls cb on each detection. Throws if the models or microphone fail. */
export async function startWakeWord(cb: () => void) {
  onWake = cb;
  if (listening) return;
  listening = true;
  try {
    stream ??= await (loading ??= load());
    media = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!listening) return stopTracks();
    ctx = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const src = ctx.createMediaStreamSource(media);
    const tap = new AudioWorkletNode(ctx, "tap");
    const queue: Float32Array[] = [];
    tap.port.onmessage = async (e: MessageEvent<Float32Array>) => {
      // Float [-1, 1] → the int16 range the models were trained on.
      const s = e.data;
      for (let i = 0; i < s.length; i++) s[i] *= 32767;
      queue.push(s);
      if (busy) return;
      busy = true;
      try {
        while (queue.length && stream) {
          for (const score of await stream.push(queue.shift()!)) {
            if (score >= THRESHOLD && listening && performance.now() > cooldownUntil) {
              cooldownUntil = performance.now() + 2000;
              onWake();
            }
          }
        }
      } finally {
        busy = false;
      }
    };
    src.connect(tap);
  } catch (e) {
    listening = false;
    loading = null;
    await stopWakeWord();
    throw e;
  }
}

function stopTracks() {
  media?.getTracks().forEach((t) => t.stop());
  media = null;
}

/** Stops listening and frees the microphone (the models stay loaded, so it restarts instantly). */
export async function stopWakeWord() {
  listening = false;
  stopTracks();
  const c = ctx;
  ctx = null;
  await c?.close().catch(() => {});
}
