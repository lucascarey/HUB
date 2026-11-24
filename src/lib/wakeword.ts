/**
 * "Jarvis" wake word that runs on the device with Picovoice Porcupine (WASM, no audio leaves the device).
 * Needs NEXT_PUBLIC_PICOVOICE_KEY (free personal AccessKey from console.picovoice.ai).
 */
import type { PorcupineWorker } from "@picovoice/porcupine-web";

export const wakeWordKey = process.env.NEXT_PUBLIC_PICOVOICE_KEY ?? "";

let worker: PorcupineWorker | null = null;
let loading: Promise<PorcupineWorker> | null = null;
let listening = false;
let onWake: () => void = () => {};

async function load() {
  const [{ PorcupineWorker, BuiltInKeyword }] = await Promise.all([import("@picovoice/porcupine-web")]);
  return PorcupineWorker.create(
    wakeWordKey,
    [{ builtin: BuiltInKeyword.Jarvis, sensitivity: 0.6 }],
    () => onWake(),
    { publicPath: "/models/porcupine_params.pv", customWritePath: "porcupine_en", version: 1 },
  );
}

/** Starts listening for "Jarvis"; calls cb on each detection. Throws if the key or microphone fails. */
export async function startWakeWord(cb: () => void) {
  onWake = cb;
  if (listening) return;
  listening = true;
  try {
    if (!worker) worker = await (loading ??= load());
    const { WebVoiceProcessor } = await import("@picovoice/web-voice-processor");
    if (listening) await WebVoiceProcessor.subscribe(worker);
  } catch (e) {
    listening = false;
    loading = null;
    throw e;
  }
}

/** Stops listening (keeps the engine loaded so it restarts instantly). */
export async function stopWakeWord() {
  listening = false;
  if (!worker) return;
  const { WebVoiceProcessor } = await import("@picovoice/web-voice-processor");
  await WebVoiceProcessor.unsubscribe(worker);
}
