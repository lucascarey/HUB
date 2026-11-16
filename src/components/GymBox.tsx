"use client";

import { useMemo } from "react";
import { dayOff } from "@/lib/dates";
import type { GymLog } from "@/lib/types";
import { daysAgo, summarize } from "./GymPanel";

interface Props {
  x: number;
  y: number;
  dragging: boolean;
  gym: GymLog[];
}

/** The Gym cell in the main space: what you lifted last, tap to log more. */
export default function GymBox({ x, y, dragging, gym }: Props) {
  const ex = useMemo(() => summarize(gym).slice(0, 4), [gym]);
  const today = dayOff(0);
  const todaySets = gym.filter((g) => g.date === today).reduce((n, g) => n + g.sets, 0);
  return (
    <section
      className={`gymbox${dragging ? " dragging" : ""}`}
      data-widget="gym"
      style={{ left: x, top: y }}
      aria-label="Gym: tocá para cargar pesos"
    >
      <div className="k">Gym{todaySets ? ` · hoy ${todaySets} series` : ""}</div>
      <h2>Gym</h2>
      {ex.length === 0 ? (
        <p className="gb-empty">Tocá para cargar tu primer peso.</p>
      ) : (
        <ul className="gb-list">
          {ex.map((e) => (
            <li key={e.name}>
              <span className="gb-n">{e.name}</span>
              <span className="gb-v">
                {e.last.kg} kg
                {e.trend > 0 && <i className="up"> ▲</i>}
              </span>
              <span className="gb-d">{daysAgo(e.last.date)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="enter">Cargar →</div>
    </section>
  );
}
