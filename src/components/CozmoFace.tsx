"use client";

import { useEffect, useRef } from "react";
import { EMOTIONS, eyePath, mix, orient, type Emotion, type EyeConfig } from "@/lib/cozmo";

export type FaceMode = "idle" | "listening" | "thinking" | "speaking";

interface Props {
  emotion: Emotion;
  mode?: FaceMode;
  /** CSS pixel width; the face keeps a 2:1 ratio. */
  size?: number;
  className?: string;
  /** Squarer eyes (the desktop Cosmo). */
  square?: boolean;
  /** Where to look, -1..1 on each axis (null = glance around on his own). Read every frame. */
  gaze?: { current: { x: number; y: number } | null };
}

const W = 128, H = 64, EYE = 40, GAP = 4;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Cozmo's face: two glowing eyes that morph between emotions, blink on their own, glance around,
 * and react to listening / thinking / speaking.
 */
export default function CozmoFace({ emotion, mode = "idle", size = 220, className, square = false, gaze }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const target = useRef<Emotion>(emotion);
  const modeRef = useRef<FaceMode>(mode);
  const squareRef = useRef(square);
  target.current = emotion;
  modeRef.current = mode;
  squareRef.current = square;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let shown: Emotion = target.current;
    let from: [EyeConfig, EyeConfig] = [...EMOTIONS[shown]] as [EyeConfig, EyeConfig];
    let cur: [EyeConfig, EyeConfig] = from;
    let morphStart = 0;
    let nextBlink = performance.now() + 2000 + Math.random() * 3000;
    let blinkStart = -1;
    let look = { x: 0, y: 0 }, lookFrom = { x: 0, y: 0 }, lookTo = { x: 0, y: 0 };
    let lookStart = 0, nextLook = performance.now() + 1500;
    let raf = 0;

    const color = () => getComputedStyle(el).getPropertyValue("--face").trim() || "#4fe3ff";

    const frame = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = el.clientWidth, cssH = el.clientHeight;
      if (el.width !== Math.round(cssW * dpr)) {
        el.width = Math.round(cssW * dpr);
        el.height = Math.round(cssH * dpr);
      }
      const m = modeRef.current;

      // New emotion: morph from wherever the eyes are now.
      if (target.current !== shown) {
        shown = target.current;
        from = cur;
        morphStart = now;
      }
      const t = reduce ? 1 : Math.min(1, (now - morphStart) / 320);
      const goal = EMOTIONS[shown];
      cur = [mix(from[0], goal[0], ease(t)), mix(from[1], goal[1], ease(t))];

      // Blink every few seconds (not while asleep).
      if (blinkStart < 0 && now > nextBlink && shown !== "dormido" && !reduce) blinkStart = now;
      let lid = 1;
      if (blinkStart >= 0) {
        const b = (now - blinkStart) / 180;
        lid = b < 0.5 ? 1 - b * 2 * 0.92 : 0.08 + (b - 0.5) * 2 * 0.92;
        if (b >= 1) {
          blinkStart = -1;
          lid = 1;
          nextBlink = now + (Math.random() < 0.2 ? 250 : 2500 + Math.random() * 4000);
        }
      }

      // Glance around when idle; look up while thinking; centre while listening.
      const g = gaze?.current;
      if (g && m !== "thinking" && !reduce) {
        // Following something (the mouse): track it smoothly, no jumps.
        lookTo = { x: Math.max(-1, Math.min(1, g.x)) * 14, y: Math.max(-1, Math.min(1, g.y)) * 7 };
        lookFrom = look;
        lookStart = now - 130;
        nextLook = now + 1200;
      } else if (now > nextLook && !reduce) {
        lookFrom = look;
        lookTo = m === "thinking" ? { x: (Math.random() - 0.5) * 10, y: -6 }
          : m === "listening" ? { x: 0, y: 0 }
          : { x: (Math.random() - 0.5) * 24, y: (Math.random() - 0.5) * 10 };
        lookStart = now;
        nextLook = now + (m === "thinking" ? 700 : 1800 + Math.random() * 2600);
      }
      const lt = ease(Math.min(1, (now - lookStart) / 260));
      look = { x: lookFrom.x + (lookTo.x - lookFrom.x) * lt, y: lookFrom.y + (lookTo.y - lookFrom.y) * lt };

      // Speaking: a soft bounce. Listening: eyes a little bigger.
      const bounce = m === "speaking" && !reduce ? Math.sin(now / 90) * 1.6 : 0;
      const grow = m === "listening" ? 1.08 : 1;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);
      const s = Math.min(el.width / W, el.height / H);
      ctx.setTransform(s, 0, 0, s, (el.width - W * s) / 2, (el.height - H * s) / 2);
      const c = color();
      ctx.fillStyle = c;
      ctx.shadowColor = c;
      ctx.shadowBlur = 6;

      const cx = W / 2 + look.x, cy = H / 2 + look.y + bounce;
      const eyes: [number, EyeConfig, boolean][] = [
        [cx + EYE / 2 + GAP, cur[0], false],
        [cx - EYE / 2 - GAP, cur[1], true],
      ];
      for (const [x, cfg, mirrored] of eyes) {
        const o = orient(cfg, mirrored);
        const r = squareRef.current ? 0.4 : 1;
        eyePath(ctx, x, cy, {
          ...o, height: Math.max(1.5, o.height * lid * grow), width: o.width * grow,
          radiusTop: o.radiusTop * r, radiusBottom: o.radiusBottom * r,
        });
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [gaze]);

  return (
    <canvas
      ref={canvas}
      className={className}
      style={{ width: size, height: size / 2, display: "block" }}
      role="img"
      aria-label={`Jarvis, ${emotion}`}
    />
  );
}
