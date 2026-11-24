import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { calendar, gmail, refreshAccess } from "./gmail-server";
import { newId } from "./types";

export const TZ = "America/Argentina/Buenos_Aires";

type ItemRow = {
  id: string; type: string; title: string; parent_id: string | null; date: string | null;
  done: boolean; x: number; y: number;
};

const TIPOS = ["proyecto", "tarea", "evento", "idea", "dinero", "habito"] as const;
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha YYYY-MM-DD");

/** Something the assistant changed, so the app knows to reload. */
export type Changed = { hub: boolean; calendar: boolean };

const json = (v: unknown) => JSON.stringify(v);

/** One thing Jarvis can do: a name and description for the model, a zod schema for its arguments, and the code. */
export interface JarvisTool {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  run: (args: never) => Promise<string>;
}
function tool<S extends z.ZodObject>(t: { name: string; description: string; inputSchema: S; run: (args: z.infer<S>) => Promise<string> }): JarvisTool {
  return t as unknown as JarvisTool;
}

/**
 * The tools Jarvis can use, acting as the signed-in person (their Supabase session, so row security applies).
 * Each tool returns a short JSON string or a plain error sentence the model can relay.
 */
export function jarvisTools(sb: SupabaseClient, changed: Changed): JarvisTool[] {
  let access: Promise<string | null> | null = null;
  /** Google access token from the stored refresh token, or null when Google is not connected. */
  const google = () =>
    (access ??= (async () => {
      const { data } = await sb.rpc("hub_gmail_token");
      return data ? refreshAccess(data as string) : null;
    })());
  const noGoogle = "Google no está conectado. Pedile a Lucas que toque “Conectar Google” en la bandeja del HUB.";
  const googleError = (e: unknown) => {
    const msg = String(e);
    if (/invalid_grant/.test(msg)) return noGoogle;
    if (/Calendar 403/.test(msg) && /insufficient|SCOPE/i.test(msg))
      return "Falta el permiso de Calendar: hay que desconectar y volver a conectar Google en la bandeja del HUB, tildando Calendar.";
    if (/SERVICE_DISABLED|accessNotConfigured|has not been used/.test(msg))
      return "La API de Google Calendar está apagada en el proyecto HUBgmail de Google Cloud. Hay que activarla.";
    console.error("jarvis google", e);
    return `Error de Google: ${msg.slice(0, 200)}`;
  };

  const buscarItems = tool({
    name: "buscar_items",
    description:
      "Busca en el HUB: proyectos, tareas, eventos, ideas, plata (deudas/pagos) y hábitos. Devuelve id, tipo, título, fecha, hecho y proyecto. Usalo antes de editar algo para conseguir su id.",
    inputSchema: z.object({
      tipo: z.enum(TIPOS).optional(),
      texto: z.string().optional().describe("Parte del título a buscar"),
      desde: fecha.optional(),
      hasta: fecha.optional(),
      incluir_hechos: z.boolean().optional().describe("Por defecto solo pendientes"),
    }),
    run: async (q) => {
      let query = sb.from("items").select("id,type,title,parent_id,date,done").order("date", { ascending: true, nullsFirst: false }).limit(60);
      if (q.tipo) query = query.eq("type", q.tipo);
      if (q.texto) query = query.ilike("title", `%${q.texto}%`);
      if (q.desde) query = query.gte("date", q.desde);
      if (q.hasta) query = query.lte("date", q.hasta);
      if (!q.incluir_hechos) query = query.eq("done", false);
      const { data, error } = await query;
      if (error) return `Error: ${error.message}`;
      const rows = data as ItemRow[];
      const parents = [...new Set(rows.map((r) => r.parent_id).filter(Boolean))] as string[];
      const names = new Map<string, string>();
      if (parents.length) {
        const { data: ps } = await sb.from("items").select("id,title").in("id", parents);
        for (const p of (ps ?? []) as { id: string; title: string }[]) names.set(p.id, p.title);
      }
      return json(rows.map((r) => ({
        id: r.id, tipo: r.type, titulo: r.title, fecha: r.date, hecho: r.done,
        proyecto: r.parent_id ? names.get(r.parent_id) ?? null : null,
      })));
    },
  });

  const crearItem = tool({
    name: "crear_item",
    description:
      "Crea algo en el HUB: una tarea, idea, evento, deuda/pago (tipo dinero), hábito o proyecto. Si pertenece a un proyecto, pasá su nombre en `proyecto`.",
    inputSchema: z.object({
      tipo: z.enum(TIPOS),
      titulo: z.string().min(1),
      fecha: fecha.optional(),
      proyecto: z.string().optional().describe("Nombre (o parte) del proyecto donde va"),
    }),
    run: async (q) => {
      let parent: ItemRow | null = null;
      if (q.proyecto && q.tipo !== "proyecto") {
        const { data } = await sb.from("items").select("id,type,title,parent_id,date,done,x,y")
          .eq("type", "proyecto").ilike("title", `%${q.proyecto}%`).limit(1);
        parent = (data?.[0] as ItemRow) ?? null;
        if (!parent) return `No encontré un proyecto que se llame “${q.proyecto}”.`;
      }
      const a = Math.random() * Math.PI * 2;
      const row = {
        id: newId(), type: q.tipo, title: q.titulo.trim(), parent_id: parent?.id ?? null, date: q.fecha ?? null,
        // Inside a project, items float around its centre; in the main space, near the middle.
        x: Math.round(Math.cos(a) * (180 + Math.random() * 160)),
        y: Math.round(Math.sin(a) * (120 + Math.random() * 120)),
        done: false, area: "",
      };
      const { error } = await sb.from("items").insert(row);
      if (error) return `Error: ${error.message}`;
      changed.hub = true;
      return json({ ok: true, id: row.id, proyecto: parent?.title ?? null });
    },
  });

  const actualizarItem = tool({
    name: "actualizar_item",
    description: "Cambia algo del HUB por id: marcar hecho/no hecho, renombrar o cambiar la fecha (\"\" la quita).",
    inputSchema: z.object({
      id: z.string(),
      hecho: z.boolean().optional(),
      titulo: z.string().optional(),
      fecha: z.union([fecha, z.literal("")]).optional(),
    }),
    run: async (q) => {
      const patch: Record<string, unknown> = {};
      if (q.hecho !== undefined) patch.done = q.hecho;
      if (q.titulo) patch.title = q.titulo;
      if (q.fecha !== undefined) patch.date = q.fecha || null;
      if (!Object.keys(patch).length) return "No había nada para cambiar.";
      const { data, error } = await sb.from("items").update(patch).eq("id", q.id).select("id,title");
      if (error) return `Error: ${error.message}`;
      if (!data?.length) return "No existe un item con ese id.";
      changed.hub = true;
      return json({ ok: true, titulo: (data[0] as { title: string }).title });
    },
  });

  const verGym = tool({
    name: "ver_gym",
    description: "Lee el registro de gimnasio: series con ejercicio, kilos, repeticiones y fecha. Sirve para récords y progreso.",
    inputSchema: z.object({
      ejercicio: z.string().optional(),
      dias: z.number().int().min(1).max(365).optional().describe("Cuántos días para atrás (por defecto 30)"),
    }),
    run: async (q) => {
      const since = new Date(Date.now() - (q.dias ?? 30) * 86_400_000).toISOString().slice(0, 10);
      let query = sb.from("gym_logs").select("exercise,kg,reps,sets,date").gte("date", since).order("date", { ascending: false }).limit(150);
      if (q.ejercicio) query = query.ilike("exercise", `%${q.ejercicio}%`);
      const { data, error } = await query;
      if (error) return `Error: ${error.message}`;
      return json(data);
    },
  });

  const registrarGym = tool({
    name: "registrar_gym",
    description: "Anota una serie (o varias iguales) en el registro de gimnasio.",
    inputSchema: z.object({
      ejercicio: z.string().min(1),
      kg: z.number().min(0),
      reps: z.number().int().min(0),
      series: z.number().int().min(1).optional(),
      fecha: fecha.optional().describe("Por defecto hoy"),
    }),
    run: async (q) => {
      const row = { id: newId(), exercise: q.ejercicio.trim(), kg: q.kg, reps: q.reps, sets: q.series ?? 1, date: q.fecha ?? todayISO() };
      const { error } = await sb.from("gym_logs").insert(row);
      if (error) return `Error: ${error.message}`;
      changed.hub = true;
      return json({ ok: true });
    },
  });

  const leerMails = tool({
    name: "leer_mails",
    description:
      "Lee Gmail (solo lectura). `busqueda` usa la sintaxis de búsqueda de Gmail; por defecto los no leídos de la bandeja de entrada.",
    inputSchema: z.object({
      busqueda: z.string().optional(),
      max: z.number().int().min(1).max(20).optional(),
    }),
    run: async (q) => {
      try {
        const token = await google();
        if (!token) return noGoogle;
        type Msg = { id: string; snippet: string; internalDate: string; payload: { headers: { name: string; value: string }[] } };
        const list = await gmail<{ messages?: { id: string }[] }>(
          token, `messages?maxResults=${q.max ?? 8}&q=${encodeURIComponent(q.busqueda ?? "is:unread in:inbox")}`,
        );
        const msgs = await Promise.all((list.messages ?? []).map((m) =>
          gmail<Msg>(token, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`)));
        const h = (m: Msg, n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
        return json(msgs.map((m) => ({
          de: h(m, "From"), asunto: h(m, "Subject"), resumen: m.snippet,
          fecha: new Date(Number(m.internalDate)).toLocaleString("es-AR", { timeZone: TZ }),
        })));
      } catch (e) {
        return googleError(e);
      }
    },
  });

  type GEvent = {
    id: string; summary?: string; location?: string; description?: string; htmlLink?: string;
    start: { dateTime?: string; date?: string }; end: { dateTime?: string; date?: string };
  };
  const slim = (e: GEvent) => ({
    id: e.id, titulo: e.summary ?? "(sin título)", inicio: e.start.dateTime ?? e.start.date, fin: e.end.dateTime ?? e.end.date,
    lugar: e.location, todo_el_dia: !!e.start.date,
  });
  /** "2026-11-19T15:00" (Argentina) or "2026-11-19" (all day) → Google's start/end shape. */
  const when = (v: string, allDay: boolean) => (allDay ? { date: v.slice(0, 10) } : { dateTime: v.length === 16 ? `${v}:00` : v, timeZone: TZ });
  const hora = z.string().describe("YYYY-MM-DDTHH:MM en hora de Argentina, o YYYY-MM-DD si es todo el día");

  const verCalendario = tool({
    name: "ver_calendario",
    description: "Lista los eventos de Google Calendar (calendario principal) entre dos fechas, inclusive.",
    inputSchema: z.object({ desde: fecha, hasta: fecha, texto: z.string().optional() }),
    run: async (q) => {
      try {
        const token = await google();
        if (!token) return noGoogle;
        const p = new URLSearchParams({
          timeMin: `${q.desde}T00:00:00-03:00`, timeMax: `${q.hasta}T23:59:59-03:00`,
          singleEvents: "true", orderBy: "startTime", maxResults: "50", timeZone: TZ,
        });
        if (q.texto) p.set("q", q.texto);
        const res = await calendar<{ items: GEvent[] }>(token, `events?${p}`);
        return json(res.items.map(slim));
      } catch (e) {
        return googleError(e);
      }
    },
  });

  const crearEvento = tool({
    name: "crear_evento",
    description: "Crea un evento en Google Calendar. Si no hay hora de fin, dura una hora.",
    inputSchema: z.object({
      titulo: z.string().min(1),
      inicio: hora,
      fin: hora.optional(),
      lugar: z.string().optional(),
      descripcion: z.string().optional(),
      recordatorio_min: z.number().int().min(0).max(40320).optional().describe("Aviso N minutos antes"),
    }),
    run: async (q) => {
      try {
        const token = await google();
        if (!token) return noGoogle;
        const allDay = q.inicio.length === 10;
        const end = q.fin ?? (allDay ? nextDay(q.inicio) : plusHour(q.inicio));
        const ev = await calendar<GEvent>(token, "events", {
          method: "POST",
          body: {
            summary: q.titulo, location: q.lugar, description: q.descripcion,
            start: when(q.inicio, allDay), end: when(end, allDay),
            ...(q.recordatorio_min !== undefined
              ? { reminders: { useDefault: false, overrides: [{ method: "popup", minutes: q.recordatorio_min }] } }
              : {}),
          },
        });
        changed.calendar = true;
        return json({ ok: true, ...slim(ev) });
      } catch (e) {
        return googleError(e);
      }
    },
  });

  const editarEvento = tool({
    name: "editar_evento",
    description: "Cambia un evento de Google Calendar por id (de ver_calendario): título, horario, lugar o descripción.",
    inputSchema: z.object({
      id: z.string(),
      titulo: z.string().optional(),
      inicio: hora.optional(),
      fin: hora.optional(),
      lugar: z.string().optional(),
      descripcion: z.string().optional(),
    }),
    run: async (q) => {
      try {
        const token = await google();
        if (!token) return noGoogle;
        const body: Record<string, unknown> = {};
        if (q.titulo) body.summary = q.titulo;
        if (q.lugar !== undefined) body.location = q.lugar;
        if (q.descripcion !== undefined) body.description = q.descripcion;
        if (q.inicio) {
          const allDay = q.inicio.length === 10;
          body.start = when(q.inicio, allDay);
          body.end = when(q.fin ?? (allDay ? nextDay(q.inicio) : plusHour(q.inicio)), allDay);
        } else if (q.fin) body.end = when(q.fin, q.fin.length === 10);
        const ev = await calendar<GEvent>(token, `events/${encodeURIComponent(q.id)}`, { method: "PATCH", body });
        changed.calendar = true;
        return json({ ok: true, ...slim(ev) });
      } catch (e) {
        return googleError(e);
      }
    },
  });

  const borrarEvento = tool({
    name: "borrar_evento",
    description: "Borra un evento de Google Calendar por id. Solo cuando Lucas lo pide explícitamente.",
    inputSchema: z.object({ id: z.string() }),
    run: async (q) => {
      try {
        const token = await google();
        if (!token) return noGoogle;
        await calendar(token, `events/${encodeURIComponent(q.id)}`, { method: "DELETE" });
        changed.calendar = true;
        return json({ ok: true });
      } catch (e) {
        return googleError(e);
      }
    },
  });

  return [buscarItems, crearItem, actualizarItem, verGym, registrarGym, leerMails, verCalendario, crearEvento, editarEvento, borrarEvento];
}

/** Today in Argentina as YYYY-MM-DD. */
export function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

function nextDay(d: string) {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** "YYYY-MM-DDTHH:MM" plus one hour, staying in local wall-clock time. */
function plusHour(v: string) {
  const t = new Date(`${v.slice(0, 16)}:00Z`);
  t.setUTCHours(t.getUTCHours() + 1);
  return t.toISOString().slice(0, 16);
}
