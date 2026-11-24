/**
 * Browsers create audio "frozen" (suspended) until the person touches the page. When that happens,
 * try to resume right away and again on the first click or key press anywhere.
 */
const pending = new Set<AudioContext>();
let listening = false;

function resumeAll() {
  for (const c of pending) {
    if (c.state === "closed") pending.delete(c);
    else void c.resume().then(() => c.state === "running" && pending.delete(c)).catch(() => {});
  }
  if (!pending.size && listening) {
    listening = false;
    window.removeEventListener("pointerdown", resumeAll, true);
    window.removeEventListener("keydown", resumeAll, true);
  }
}

/** Returns true when the audio is running; false when it needs one touch to start. */
export async function ensureRunning(ctx: AudioContext): Promise<boolean> {
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  if (ctx.state === "running") return true;
  pending.add(ctx);
  if (!listening) {
    listening = true;
    window.addEventListener("pointerdown", resumeAll, true);
    window.addEventListener("keydown", resumeAll, true);
  }
  return false;
}

export function audioNeedsTouch() {
  return [...pending].some((c) => c.state === "suspended");
}
