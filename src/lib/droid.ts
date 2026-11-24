/**
 * Cosmo's droid voice: little beeps and chirps instead of words (the words show in his speech bubble).
 * Synthesised on the fly with Web Audio, so it's free and instant. The mood changes the melody.
 */
import { ensureRunning } from "./audio-unlock";

let ctx: AudioContext | null = null;
let stopAt = 0;
let nodes: OscillatorNode[] = [];

type Mood = "normal" | "happy" | "sad" | "question" | "alert";

export function moodFor(emotion: string, text = ""): Mood {
  if (/triste|desganado|dormido/.test(emotion)) return "sad";
  if (/feliz|picaro|asombrado|sorprendido/.test(emotion)) return "happy";
  if (/enojado|sospechoso/.test(emotion)) return "alert";
  if (/\?\s*$/.test(text.trim())) return "question";
  return "normal";
}

/** Plays a burst of chirps that roughly matches the length of the text; returns how long it lasts (s). */
export function chirp(text: string, mood: Mood = "normal", maxNotes = 9): number {
  if (typeof window === "undefined") return 0;
  ctx ??= new AudioContext();
  void ensureRunning(ctx);
  hush();
  const notes = Math.max(2, Math.min(maxNotes, Math.round(text.length / 22) + 2));
  const base = mood === "sad" ? 520 : mood === "happy" ? 1100 : mood === "alert" ? 900 : 820;
  let t = ctx.currentTime + 0.03;
  const out = ctx.createGain();
  out.gain.value = 0.12;
  out.connect(ctx.destination);
  for (let i = 0; i < notes; i++) {
    const last = i === notes - 1;
    const dur = 0.05 + Math.random() * 0.09;
    const f0 = base * (0.7 + Math.random() * 0.8);
    // The last note bends: up for a question or happy, down for sad, otherwise random.
    const bend = last
      ? mood === "question" || mood === "happy" ? 1.8 : mood === "sad" ? 0.55 : 0.8 + Math.random() * 0.6
      : 0.75 + Math.random() * 0.7;
    const o = ctx.createOscillator();
    o.type = Math.random() < 0.6 ? "sine" : "square";
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * bend, t + dur * (last ? 1.8 : 1));
    const g = ctx.createGain();
    const len = dur * (last ? 1.8 : 1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.type === "square" ? 0.35 : 1, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + len + 0.02);
    nodes.push(o);
    t += len + 0.025 + (Math.random() < 0.2 ? 0.09 : 0);
  }
  stopAt = t;
  return t - ctx.currentTime;
}

export function chirping() {
  return !!ctx && ctx.currentTime < stopAt;
}

export function hush() {
  for (const n of nodes) {
    try {
      n.stop();
    } catch {}
  }
  nodes = [];
  stopAt = 0;
}
