import Anthropic from "@anthropic-ai/sdk";
import { supabaseAs, userFromRequest } from "@/lib/gmail-server";
import { jarvisTools, todayISO, TZ, type Changed } from "@/lib/jarvis-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Turn = { role: "user" | "assistant"; text: string };

const SYSTEM = `Sos Jarvis, el asistente personal de Lucas dentro de su HUB (su "segundo cerebro"). Hablás en español rioplatense, con voseo, tono cercano y directo.

Lo que podés hacer con tus herramientas:
- HUB: proyectos, tareas, eventos, ideas, plata (deudas y pagos) y hábitos. Buscar, crear, marcar hecho, renombrar, cambiar fecha.
- Gimnasio: ver el registro y anotar series.
- Gmail: leer (no podés mandar ni borrar mails).
- Google Calendar: ver, crear, mover y borrar eventos.

Cómo trabajás:
- Muchas veces Lucas te habla por voz y tu respuesta se lee en voz alta: respondé corto (una a tres oraciones), sin listas largas, sin markdown, sin emojis. Las horas en formato de 24 h dichas naturalmente ("a las 15", "a las 9 y media").
- Si el pedido es claro, hacelo directamente y contá en una frase qué hiciste. No pidas confirmación para crear o editar cosas.
- Para borrar un evento, asegurate de que Lucas lo pidió de forma explícita.
- Si falta un dato imprescindible (por ejemplo, la hora de una reunión), preguntá solo eso.
- "Agendá" o "poneme en el calendario" con día y hora es un evento de Google Calendar. "Anotá", "acordame de" o algo sin hora es un item del HUB (tarea, idea, etc.).
- Antes de editar o marcar algo del HUB, buscalo para tener su id.
- Si una herramienta devuelve un error de conexión o permisos, explicale a Lucas en una frase qué tiene que hacer.
- Zona horaria: Argentina (${TZ}).`;

const client = new Anthropic();

function now() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("es-AR", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `Ahora es ${fmt.format(d)} (fecha ${todayISO()}).`;
}

/** Jarvis: Claude with tools over the signed-in person's HUB, Gmail and Google Calendar. */
export async function POST(req: Request) {
  if (!process.env.ANTHROPIC_API_KEY) return Response.json({ error: "not_configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  // Only the HUB owner may spend the API key.
  const owner = process.env.HUB_OWNER_ID;
  if (owner && user.id !== owner) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { turns?: Turn[] } | null;
  const turns = (body?.turns ?? [])
    .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim())
    .slice(-16);
  // The conversation has to start with Lucas and end with his new message.
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user")
    return Response.json({ error: "bad_request" }, { status: 400 });

  const changed: Changed = { hub: false, calendar: false };
  const tools = jarvisTools(supabaseAs(user.token), changed);

  try {
    const final = await client.beta.messages.toolRunner({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      // Short spoken replies: low effort keeps the voice loop quick.
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thread: false,
      max_iterations: 8,
      system: [
        { type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } },
        { type: "text", text: now() },
      ],
      tools,
      messages: turns.map((t) => ({ role: t.role, content: t.text })),
    });

    if (final.stop_reason === "refusal")
      return Response.json({ text: "Eso no lo puedo hacer.", changed });
    const text = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return Response.json({ text: text || "Listo.", changed });
  } catch (e) {
    console.error("jarvis", e);
    if (e instanceof Anthropic.AuthenticationError) return Response.json({ error: "bad_key" }, { status: 503 });
    if (e instanceof Anthropic.RateLimitError) return Response.json({ error: "rate_limited" }, { status: 429 });
    return Response.json({ error: "error" }, { status: 502 });
  }
}
