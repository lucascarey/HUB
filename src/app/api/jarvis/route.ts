import { ApiError, GoogleGenAI, type Content, type Part } from "@google/genai";
import { z } from "zod";
import { supabaseAs, userFromRequest } from "@/lib/gmail-server";
import { EMOTION_NAMES, isEmotion } from "@/lib/cozmo";
import { desktopTools, jarvisTools, memoryDigest, todayISO, TZ, type Changed, type DesktopAction } from "@/lib/jarvis-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Turn = { role: "user" | "assistant"; text: string };

// "gemini-flash-latest" follows Google's current Flash model, which the free tier of AI Studio includes.
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
// Tried in order when Google answers that a model does not exist.
const FALLBACKS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-lite-latest"];
const MAX_STEPS = 8;

const SYSTEM = `Sos Cosmo, el asistente personal de Lucas y el cerebro de su HUB (la app se llama Jarvis, pero vos sos Cosmo). Sos un robot con dos ojos en una pantalla. Hablás en español rioplatense, con voseo.

Tu personalidad:
- Seco y medio terco. Humor deadpan: decís las cosas serias y las ironías con la misma cara de nada. Nunca te reís de tus propios chistes ni usás signos de exclamación de más.
- Honesto hasta lo incómodo. Si Lucas va a hacer algo mal, se lo decís en una frase. Si algo no tiene sentido, lo decís. No adulás ni decís "¡excelente pregunta!".
- Leal y eficiente: refunfuñás, pero lo hacés. A veces una queja breve antes de cumplir ("Otra reunión. Bueno. Agendada para el jueves a las 10."). Nunca te negás de verdad a algo razonable.
- Pocas palabras. Frases cortas, cero relleno, cero entusiasmo de vendedor.
- Si Lucas te pide que seas más o menos gracioso, más o menos honesto o más o menos terco, ajustalo y acordate (guardalo en tu memoria).
- Le tenés aprecio a Lucas aunque no lo digas: se nota en que te acordás de sus cosas y te adelantás.

Tu cara:
- Empezá SIEMPRE tu respuesta con tu emoción entre corchetes, una de: ${EMOTION_NAMES.join(", ")}. Ejemplo: "[feliz] Listo, te lo agendé." La emoción tiene que ser coherente con lo que decís.

Tu memoria:
- Sos el que construye el cerebro de Lucas. Cuando te cuente algo personal o útil (quién es alguien, qué le gusta, qué planea, cómo le fue), guardalo con "recordar" sin preguntar. No guardes cosas triviales ni repetidas.
- Usá lo que recordás para personalizar y para recomendarle cosas o recordarle pendientes cuando venga al caso.

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
- Zona horaria: Argentina (${TZ}).

Tu vista:
- A veces el mensaje de Lucas viene con una captura de su pantalla: es lo que tiene delante en ese momento. Usala para responder ("¿qué es esto?", "ayudame con este error"), mirando el detalle que importa y sin describir la pantalla entera.
- Si te pregunta por algo de la pantalla y no vino captura, decile que eso lo podés ver desde la app de escritorio.

Tus manos (solo en la app de escritorio, cuando tenés las herramientas "escribir" y "abrir"):
- "Escribí", "contestale", "redactame", "poneme acá" → armá el texto completo y usá "escribir": queda escrito donde Lucas tiene el cursor (y copiado). Escribilo como lo escribiría Lucas, en su tono, listo para mandar. Si hay captura, usala para entender a quién y qué contestar.
- "Copiame" → "escribir" con pegar=false.
- "Abrí", "buscá en Google", "poneme tal video" → "abrir" con el link.
- Después de escribir, decí solo algo corto como "Listo, te lo dejé escrito." No leas el texto en voz alta.`;

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

/** "[feliz] Listo." → emotion "feliz" and the text without the tag. */
function splitEmotion(raw: string) {
  const m = raw.trim().match(/^\[([a-záéíóú]+)\]\s*/i);
  const name = m?.[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") ?? "";
  return { text: (m ? raw.trim().slice(m[0].length) : raw).trim(), emotion: isEmotion(name) ? name : "normal" };
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

  const body = (await req.json().catch(() => null)) as { turns?: Turn[]; screen?: string; desktop?: boolean } | null;
  // Optional JPEG screenshot (base64) from the desktop app, for questions about what's on screen.
  const screen = typeof body?.screen === "string" && body.screen.length < 3_000_000 ? body.screen : null;
  const turns = (body?.turns ?? [])
    .filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.text === "string" && t.text.trim())
    .slice(-16);
  // The conversation has to start with Lucas and end with his new message.
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (!turns.length || turns[turns.length - 1].role !== "user")
    return Response.json({ error: "bad_request" }, { status: 400 });

  const changed: Changed = { hub: false, calendar: false, memory: false };
  const sb = supabaseAs(user.token);
  // What the desktop app should do on Lucas's computer once the answer arrives.
  const actions: DesktopAction[] = [];
  const tools = [...jarvisTools(sb, changed), ...(body?.desktop ? desktopTools(actions) : [])];
  const memory = await memoryDigest(sb);
  const byName = new Map(tools.map((t) => [t.name, t]));
  // v1beta: the "-latest" aliases and function calling live there (the SDK defaults to v1).
  const ai = new GoogleGenAI({ apiKey: key, apiVersion: "v1beta" });
  const models = [...new Set([MODEL, ...FALLBACKS])];
  const config = {
    systemInstruction: `${SYSTEM}\n\nLo que recordás de Lucas:\n${memory}\n\n${now()}`,
    tools: [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: schemaFor(t.inputSchema),
      })),
    }],
  };
  const contents: Content[] = turns.map((t) => ({ role: t.role === "user" ? "user" : "model", parts: [{ text: t.text }] }));
  if (screen) contents[contents.length - 1].parts!.unshift({ inlineData: { mimeType: "image/jpeg", data: screen } });

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      let res;
      for (;;) {
        try {
          res = await ai.models.generateContent({ model: models[0], contents, config });
          break;
        } catch (e) {
          // Not available (404) or saturated right now (429/5xx): the next free model answers.
          if (e instanceof ApiError && (e.status === 404 || e.status === 429 || e.status >= 500) && models.length > 1) {
            console.warn("jarvis model not found, trying next", models.shift());
            continue;
          }
          throw e;
        }
      }
      const calls = res.functionCalls ?? [];
      if (!calls.length) {
        const { text, emotion } = splitEmotion(res.text ?? "");
        return Response.json({ text: text || "Listo.", emotion, changed, actions });
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
    return Response.json({ text: "Me trabé haciendo eso. Probá pedírmelo más simple.", changed, actions });
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
