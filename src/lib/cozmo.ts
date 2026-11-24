/**
 * Cozmo-style eye shapes, ported from esp32-eyes (Alastair Aitchison / Playful Technology, Luis Llamas; AGPL-3.0):
 * https://github.com/playfultechnology/esp32-eyes — EyePresets.h, FaceExpression.cpp, EyeDrawer.h.
 * Units are the original 128×64 OLED pixels; the canvas scales them.
 */

export interface EyeConfig {
  offsetX: number; offsetY: number; height: number; width: number;
  slopeTop: number; slopeBottom: number; radiusTop: number; radiusBottom: number;
}

const P = (offsetX: number, offsetY: number, height: number, width: number, slopeTop: number, slopeBottom: number, radiusTop: number, radiusBottom: number): EyeConfig =>
  ({ offsetX, offsetY, height, width, slopeTop, slopeBottom, radiusTop, radiusBottom });

const Preset = {
  Normal: P(0, 0, 40, 40, 0, 0, 8, 8),
  Happy: P(0, 0, 10, 40, 0, 0, 10, 0),
  Glee: P(0, 0, 8, 40, 0, 0, 8, 0),
  Sad: P(0, 0, 15, 40, -0.5, 0, 1, 10),
  Worried: P(0, 0, 25, 40, -0.1, 0, 6, 10),
  WorriedAlt: P(0, 0, 35, 40, -0.2, 0, 6, 10),
  Focused: P(0, 0, 14, 40, 0.2, 0, 3, 1),
  Annoyed: P(0, 0, 12, 40, 0, 0, 0, 10),
  AnnoyedAlt: P(0, 0, 5, 40, 0, 0, 0, 4),
  Surprised: P(-2, 0, 45, 45, 0, 0, 16, 16),
  Skeptic: P(0, 0, 40, 40, 0, 0, 10, 10),
  SkepticAlt: P(0, -6, 26, 40, 0.3, 0, 1, 10),
  Frustrated: P(3, -5, 12, 40, 0, 0, 0, 10),
  Unimpressed: P(3, 0, 12, 40, 0, 0, 1, 10),
  UnimpressedAlt: P(3, -3, 22, 40, 0, 0, 1, 16),
  Sleepy: P(0, -2, 14, 40, -0.5, -0.5, 3, 3),
  SleepyAlt: P(0, -2, 8, 40, -0.5, -0.5, 3, 3),
  Suspicious: P(0, 0, 22, 40, 0, 0, 8, 3),
  SuspiciousAlt: P(0, -3, 16, 40, 0.2, 0, 6, 3),
  Squint: P(-10, -3, 35, 35, 0, 0, 8, 8),
  SquintAlt: P(5, 0, 20, 20, 0, 0, 5, 5),
  Angry: P(-3, 0, 20, 40, 0.3, 0, 2, 12),
  Furious: P(-2, 0, 30, 40, 0.4, 0, 2, 8),
  Scared: P(-3, 0, 40, 40, -0.1, 0, 12, 8),
  Awe: P(2, 0, 35, 45, -0.1, 0.1, 12, 12),
};

/** Every emotion, with the Spanish name Jarvis uses for it. Right eye, left eye. */
export const EMOTIONS = {
  normal: [Preset.Normal, Preset.Normal],
  enojado: [Preset.Angry, Preset.Angry],
  euforico: [Preset.Glee, Preset.Glee],
  feliz: [Preset.Happy, Preset.Happy],
  triste: [Preset.Sad, Preset.Sad],
  preocupado: [Preset.Worried, Preset.WorriedAlt],
  concentrado: [Preset.Focused, Preset.Focused],
  molesto: [Preset.Annoyed, Preset.AnnoyedAlt],
  sorprendido: [Preset.Surprised, Preset.Surprised],
  esceptico: [Preset.Skeptic, Preset.SkepticAlt],
  frustrado: [Preset.Frustrated, Preset.Frustrated],
  desganado: [Preset.Unimpressed, Preset.UnimpressedAlt],
  dormido: [Preset.Sleepy, Preset.SleepyAlt],
  sospechoso: [Preset.Suspicious, Preset.SuspiciousAlt],
  picaro: [Preset.Squint, Preset.SquintAlt],
  furioso: [Preset.Furious, Preset.Furious],
  asustado: [Preset.Scared, Preset.Scared],
  asombrado: [Preset.Awe, Preset.Awe],
} satisfies Record<string, [EyeConfig, EyeConfig]>;

export type Emotion = keyof typeof EMOTIONS;
export const EMOTION_NAMES = Object.keys(EMOTIONS) as Emotion[];
export const isEmotion = (s: string): s is Emotion => s in EMOTIONS;

/** The left eye is drawn mirrored, as in the original. */
export function orient(c: EyeConfig, mirrored: boolean): EyeConfig {
  return {
    ...c,
    offsetX: mirrored ? -c.offsetX : c.offsetX,
    offsetY: -c.offsetY,
    slopeTop: mirrored ? c.slopeTop : -c.slopeTop,
    slopeBottom: mirrored ? c.slopeBottom : -c.slopeBottom,
  };
}

export function mix(a: EyeConfig, b: EyeConfig, t: number): EyeConfig {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    offsetX: l(a.offsetX, b.offsetX), offsetY: l(a.offsetY, b.offsetY),
    height: l(a.height, b.height), width: l(a.width, b.width),
    slopeTop: l(a.slopeTop, b.slopeTop), slopeBottom: l(a.slopeBottom, b.slopeBottom),
    radiusTop: l(a.radiusTop, b.radiusTop), radiusBottom: l(a.radiusBottom, b.radiusBottom),
  };
}

/** Traces one eye as a smooth path (same geometry as EyeDrawer::Draw, with real arcs). */
export function eyePath(ctx: CanvasRenderingContext2D, cx: number, cy: number, c: EyeConfig) {
  const dTop = (c.height * c.slopeTop) / 2;
  const dBottom = (c.height * c.slopeBottom) / 2;
  let rt = Math.max(0, c.radiusTop);
  let rb = Math.max(0, c.radiusBottom);
  const total = c.height + dTop - dBottom;
  if (rt > 0 && rb > 0 && total - 1 < rt + rb) {
    const k = Math.max(0, total - 1) / (rt + rb);
    rt *= k;
    rb *= k;
  }
  const x = cx + c.offsetX, y = cy + c.offsetY, w = c.width / 2, h = c.height / 2;
  const TL = { x: x - w + rt, y: y - h + rt - dTop };
  const TR = { x: x + w - rt, y: y - h + rt + dTop };
  const BL = { x: x - w + rb, y: y + h - rb - dBottom };
  const BR = { x: x + w - rb, y: y + h - rb + dBottom };
  ctx.beginPath();
  ctx.moveTo(TL.x, TL.y - rt);
  ctx.lineTo(TR.x, TR.y - rt);
  ctx.arc(TR.x, TR.y, rt, -Math.PI / 2, 0);
  ctx.lineTo(BR.x + rb, BR.y);
  ctx.arc(BR.x, BR.y, rb, 0, Math.PI / 2);
  ctx.lineTo(BL.x, BL.y + rb);
  ctx.arc(BL.x, BL.y, rb, Math.PI / 2, Math.PI);
  ctx.lineTo(TL.x - rt, TL.y);
  ctx.arc(TL.x, TL.y, rt, Math.PI, (Math.PI * 3) / 2);
  ctx.closePath();
}
