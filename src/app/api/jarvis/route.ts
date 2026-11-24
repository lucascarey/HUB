import { ApiError, GoogleGenAI, type Content, type Part } from "@google/genai";
import { z } from "zod";
import { supabaseAs, userFromRequest } from "@/lib/gmail-server";
import { jarvisTools, todayISO, TZ, type Changed } from "@/lib/jarvis-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Turn = { role: "user" | "assistant"; text: string };

// "gemini-flash-latest" follows Google's current Flash model, which the free tier of AI Studio includes.
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const MAX_STEPS = 8;

const SYSTEM = `Sos Jarvis, el asistente personal de Lucas dentro de su HUB (su "segundo cerebro"). Hablás en español rioplatense, con voseo, tono cercano y directo.

Lo que podés hacer con tus herramientas:
- HUB: proyectos, tareas, eventos, ideas, plata (deudas y pagos) y hábitos. Buscar, crear, marcar hecho, renombrar, cambiar fecha.
- Gimnasio: ver el registro y anotar series.
- Gmail: leer (no podés mandar ni borrar mails).
- Google Calendar: ver, crear, mover y borrar eventos.

Cómo trabajás:
- Muchas veces Lucas te habla por voz y tu respuesta se lee en voz alta: respondé corto (una a tres oraciones), sin listas largas, sin markdown, sin emojis. Las horas dichas naturalmente ("a las 15", "a las 9 y media").
- Si el pedido es claro, hacelo directamente con las herramientas y contá en una frase qué hiciste. No pidas confirmación para crear o editar cosas.
- Nunca digas que hiciste algo si no llamaste a la herramienta y te respondió ok.
- Para borrar un evento, asegurate de que Lucas lo pidió de forma explícita.
- Si falta un dato imprescindible (por ejemplo, la hora de una reunión), preguntá solo eso.
- "Agendá" o "poneme en el calendario" con día y hora es un evento de Google Calendar. "Anotá", "acordame de" o algo sin hora es un item del HUB (tarea, idea, etc.).
- Antes de editar o marcar algo del HUB, buscalo para tener su id.
- Si una herramienta devuelve un error de conexión o permisos, explicale a Lucas en una frase qué tiene que hacer.
- Zona horaria: Argentina (${TZ}).`;

function now() {
  const fmt = new Intl.DateTimeFormat("es-AR", {
    timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `Ahora es ${fmt.format(new Date())} (fecha ${todayISO()}).`;
}

/** JSON Schema for a tool's arguments, without the $schema header Gemini doesn't need. */
function schemaFor(s: z.ZodObject) {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  void _drop;
  return rest;
}

/** Jarvis: Gemini with tools over the signed-in person's HUB, Gmail and Google Calendar. */
export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "not_configured" }, { status: 503 });
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
  const byName = new Map(tools.map((t) => [t.name, t]));
  const ai = new GoogleGenAI({ apiKey: key });
  const config = {
    systemInstruction: `${SYSTEM}\n\n${now()}`,
    tools: [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: schemaFor(t.inputSchema),
      })),
    }],
  };
  const contents: Content[] = turns.map((t) => ({ role: t.role === "user" ? "user" : "model", parts: [{ text: t.text }] }));

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await ai.models.generateContent({ model: MODEL, contents, config });
      const calls = res.functionCalls ?? [];
      if (!calls.length) {
        const text = (res.text ?? "").trim();
        return Response.json({ text: text || "Listo.", changed });
      }
      // Keep the model's turn exactly as returned (it carries thought signatures Gemini needs back).
      const modelTurn = res.candidates?.[0]?.content;
      contents.push(modelTurn ?? { role: "model", parts: calls.map((c) => ({ functionCall: c })) });

      const results: Part[] = await Promise.all(calls.map(async (call): Promise<Part> => {
        const t = call.name ? byName.get(call.name) : undefined;
        let output: string;
        if (!t) output = `No existe la herramienta ${call.name}.`;
        else {
          const args = t.inputSchema.safeParse(call.args ?? {});
          if (!args.success) output = `Argumentos inválidos: ${args.error.message.slice(0, 300)}`;
          else {
            try {
              output = await (t.run as (a: unknown) => Promise<string>)(args.data);
            } catch (e) {
              console.error("jarvis tool", call.name, e);
              output = `Error: ${String(e).slice(0, 200)}`;
            }
          }
        }
        return { functionResponse: { id: call.id, name: call.name, response: { output } } };
      }));
      contents.push({ role: "user", parts: results });
    }
    return Response.json({ text: "Me trabé haciendo eso. Probá pedírmelo más simple.", changed });
  } catch (e) {
    console.error("jarvis", e);
    if (e instanceof ApiError) {
      if (e.status === 429) return Response.json({ error: "rate_limited" }, { status: 429 });
      if (e.status === 400 && /API key/i.test(e.message)) return Response.json({ error: "bad_key" }, { status: 503 });
      if (e.status === 401 || e.status === 403) return Response.json({ error: "bad_key" }, { status: 503 });
    }
    return Response.json({ error: "error" }, { status: 502 });
  }
}
