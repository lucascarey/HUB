import type { ItemType } from "./types";

const pad = (n: number) => String(n).padStart(2, "0");
export const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local date `n` days from today, as YYYY-MM-DD. */
export const dayOff = (n: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return iso(d);
};

export const fmtDate = (s: string) => {
  try {
    return new Date(`${s}T00:00`).toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short" });
  } catch {
    return s;
  }
};

/** Best guess of what kind of thing a quick capture is. */
export function guessType(text: string): ItemType {
  const s = text.toLowerCase();
  if (/\$|debo|deuda|pagar|cobrar|prest[eé]|plata|usd|d[oó]lar/.test(s)) return "dinero";
  if (/entrevista|reuni[oó]n|turno|cumple|parcial|examen|partido|a las \d/.test(s)) return "evento";
  if (/^idea|se me ocurri|podr[ií]a|qu[eé] tal si/.test(s)) return "idea";
  if (/todos los d[ií]as|por semana|cada d[ií]a|h[aá]bito/.test(s)) return "habito";
  if (/^proyecto/.test(s)) return "proyecto";
  return "tarea";
}
