"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { dayOff } from "@/lib/dates";
import { newId, type GymLog, type HubData } from "@/lib/types";

interface Props {
  gym: GymLog[];
  update: (fn: (d: HubData) => HubData) => void;
  onClose: () => void;
}

export interface ExerciseSummary {
  name: string;
  logs: GymLog[]; // newest first
  last: GymLog;
  best: number;
  /** Heaviest weight of each day, oldest first. */
  series: number[];
  trend: number; // last day's top weight minus the previous day's
}

const norm = (s: string) => s.trim().toLocaleLowerCase("es-AR");
const fmtKg = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1).replace(".", ",")} kg`;

export function summarize(gym: GymLog[]): ExerciseSummary[] {
  const groups = new Map<string, GymLog[]>();
  for (const g of gym) {
    const k = norm(g.exercise);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(g);
  }
  const out: ExerciseSummary[] = [];
  for (const logs of groups.values()) {
    logs.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
    const perDay = new Map<string, number>();
    for (const l of logs) perDay.set(l.date, Math.max(perDay.get(l.date) ?? 0, l.kg));
    const days = [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const series = days.map(([, kg]) => kg);
    out.push({
      name: logs[0].exercise,
      logs,
      last: logs[0],
      best: Math.max(...logs.map((l) => l.kg)),
      series,
      trend: series.length > 1 ? series[series.length - 1] - series[series.length - 2] : 0,
    });
  }
  return out.sort((a, b) => (a.last.date === b.last.date ? 0 : a.last.date < b.last.date ? 1 : -1));
}

export function daysAgo(date: string) {
  const d = Math.round((Date.parse(dayOff(0)) - Date.parse(date)) / 86_400_000);
  if (d <= 0) return "hoy";
  if (d === 1) return "ayer";
  if (d < 30) return `hace ${d} días`;
  return new Date(`${date}T12:00:00`).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
}

function Spark({ values }: { values: number[] }) {
  const v = values.slice(-12);
  if (v.length < 2) return null;
  const w = 84, h = 26, lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((n, i) => `${(i / (v.length - 1)) * w},${h - 3 - ((n - lo) / span) * (h - 6)}`);
  return (
    <svg className="gy-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts.join(" ")} />
      <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r="2.6" />
    </svg>
  );
}

/** Log a set in a few taps and see how each exercise is going. */
export default function GymPanel({ gym, update, onClose }: Props) {
  const ex = useMemo(() => summarize(gym), [gym]);
  const [exercise, setExercise] = useState("");
  const [kg, setKg] = useState("");
  const [reps, setReps] = useState("10");
  const [sets, setSets] = useState("3");
  const [date, setDate] = useState(dayOff(0));
  const [open, setOpen] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const exRef = useRef<HTMLInputElement>(null);
  const kgRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!ex.length) exRef.current?.focus();
  }, [ex.length]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 2500);
    return () => clearTimeout(t);
  }, [saved]);

  /** Picking an exercise you already did fills in what you lifted last time. */
  const pick = (name: string) => {
    setExercise(name);
    const prev = ex.find((e) => norm(e.name) === norm(name));
    if (prev) {
      setKg(String(prev.last.kg));
      setReps(String(prev.last.reps));
      setSets(String(prev.last.sets));
    }
    setTimeout(() => kgRef.current?.select(), 0);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = exercise.trim();
    const w = Number(kg.replace(",", "."));
    if (!name || !Number.isFinite(w) || w < 0) return;
    const known = ex.find((x) => norm(x.name) === norm(name));
    const log: GymLog = {
      id: newId(),
      exercise: known?.name ?? name,
      kg: Math.round(w * 100) / 100,
      reps: Math.max(0, Math.round(Number(reps) || 0)),
      sets: Math.max(1, Math.round(Number(sets) || 1)),
      date: date || dayOff(0),
    };
    const pr = !known || log.kg > known.best;
    update((d) => ({ ...d, gym: [...d.gym, log] }));
    setSaved(`${log.exercise}: ${fmtKg(log.kg)} · ${log.sets}×${log.reps}${pr && known ? " · ¡récord!" : ""}`);
    setOpen(norm(log.exercise));
  };

  const remove = (id: string) => update((d) => ({ ...d, gym: d.gym.filter((g) => g.id !== id) }));

  return (
    <div id="gym" className="panel" role="dialog" aria-label="Gym">
      <button className="x" type="button" aria-label="Cerrar" onClick={onClose}>×</button>
      <div>
        <div className="k" style={{ color: "var(--c-gym)" }}>Gym</div>
        <h3>Cargar peso</h3>
      </div>

      <form className="gy-form" onSubmit={submit}>
        <label className="f gy-ex">
          Ejercicio
          <input
            ref={exRef}
            type="text"
            list="gym-exercises"
            placeholder="Press banca, sentadilla…"
            value={exercise}
            onChange={(e) => {
              const v = e.target.value;
              if (ex.some((x) => x.name === v)) pick(v);
              else setExercise(v);
            }}
            required
            autoComplete="off"
          />
          <datalist id="gym-exercises">
            {ex.map((x) => <option key={x.name} value={x.name} />)}
          </datalist>
        </label>
        <label className="f">
          Kilos
          <input ref={kgRef} type="text" inputMode="decimal" placeholder="40" value={kg} onChange={(e) => setKg(e.target.value)} required />
        </label>
        <label className="f">
          Reps
          <input type="number" inputMode="numeric" min={0} value={reps} onChange={(e) => setReps(e.target.value)} />
        </label>
        <label className="f">
          Series
          <input type="number" inputMode="numeric" min={1} value={sets} onChange={(e) => setSets(e.target.value)} />
        </label>
        <label className="f gy-date">
          Día
          <input type="date" value={date} max={dayOff(0)} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button className="btn main gy-save" type="submit">Guardar</button>
      </form>
      {saved && <p className="gy-saved" role="status">✓ {saved}</p>}

      {ex.length > 0 && (
        <div className="gy-chips" aria-label="Elegir ejercicio">
          {ex.slice(0, 8).map((x) => (
            <button key={x.name} type="button" className="gy-chip" onClick={() => pick(x.name)}>{x.name}</button>
          ))}
        </div>
      )}

      <div className="gy-list">
        {ex.length === 0 && <p className="empty">Todavía no cargaste nada. Escribí el ejercicio, los kilos y guardá: la próxima vez te completa lo último que hiciste.</p>}
        {ex.map((x) => {
          const k = norm(x.name);
          const isOpen = open === k;
          return (
            <div key={k} className={`gy-row${isOpen ? " open" : ""}`}>
              <button type="button" className="gy-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : k)}>
                <span className="gy-name">{x.name}</span>
                <span className="gy-last">
                  <b>{fmtKg(x.last.kg)}</b> · {x.last.sets}×{x.last.reps} · {daysAgo(x.last.date)}
                </span>
                <Spark values={x.series} />
                <span className="gy-meta">
                  {x.trend > 0 ? <span className="up">▲ {fmtKg(x.trend)}</span> : x.trend < 0 ? <span className="down">▼ {fmtKg(-x.trend)}</span> : null}
                  <span>Récord {fmtKg(x.best)}</span>
                </span>
              </button>
              {isOpen && (
                <ul className="gy-hist">
                  {x.logs.slice(0, 30).map((l) => (
                    <li key={l.id}>
                      <span className="gy-d">{daysAgo(l.date)}</span>
                      <span>{fmtKg(l.kg)} · {l.sets}×{l.reps}</span>
                      <button type="button" className="gy-del" aria-label={`Borrar ${fmtKg(l.kg)} del ${l.date}`} onClick={() => remove(l.id)}>✕</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
