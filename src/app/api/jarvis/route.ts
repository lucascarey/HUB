import { ApiError, GoogleGenAI, type Content, type Part } from "@google/genai";
import { supabaseAs, userFromRequest } from "@/lib/gmail-server";
import { isEmotion } from "@/lib/cozmo";
import { now, schemaFor, SYSTEM } from "@/lib/jarvis-brain";
import { z } from "zod";
import { desktopTools, jarvisTools, memoryDigest, type Changed, type DesktopAction, type JarvisTool } from "@/lib/jarvis-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Turn = { role: "user" | "assistant"; text: string };

// Cosmo answers with Flash (fast) and hands the hard thinking to Gemini Pro through the "pensar" tool.
// Pro's free quota is small, so when Google says it's used up, "pensar" uses Flash for a while.
const PRO = ["gemini-pro-latest", "gemini-2.5-pro"];
const PRO_REST_MS = 10 * 60_000;
let proTiredAt = 0;
// "gemini-flash-latest" follows Google's current Flash model, which the free tier of AI Studio includes.
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
// Tried in order when Google answers that a model does not exist.
const FALLBACKS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-lite-latest"];
const MAX_STEPS = 8;

/** "[feliz] Listo." → emotion "feliz" and the text without the tag. */
function splitEmotion(raw: string) {
  const m = raw.trim().match(/^\[([a-záéíóú]+)\]\s*/i);
  const name = m?.[1].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") ?? "";
  return { text: (m ? raw.trim().slice(m[0].length) : raw).trim(), emotion: isEmotion(name) ? name : "normal" };
}

const THINKER = `Sos la parte pensante de Cosmo, el compañero de Lucas (Argentina). Te pasan un problema, una pregunta difícil
o un pedido de ideas. Pensalo a fondo y devolvé la respuesta lista para usar: concreta, con criterio propio, ideas originales o
pasos claros, en castellano rioplatense. Sin introducciones ni relleno; máximo unas 180 palabras salvo que haga falta más.`;

/** "pensar": Gemini Pro (with its thinking) for problems, ideas, plans and decisions; Flash if Pro is out of quota. */
function pensar(key: string): JarvisTool {
  const inputSchema = z.object({
    pregunta: z.string().min(3).max(4000).describe("Lo que hay que pensar, completo y concreto"),
    contexto: z.string().max(6000).optional().describe("Datos útiles: lo que recordás de Lucas, del HUB, de la charla"),
  });
  return {
    name: "pensar",
    description:
      "Pensá a fondo con el modelo más inteligente (Gemini Pro). Usalo para lo que pide pensamiento de verdad: resolver un problema, " +
      "dar ideas, planear, decidir entre opciones, analizar, explicar algo complejo, escribir algo largo y cuidado. " +
      "No lo uses para charla, datos simples, ni para usar las otras herramientas.",
    inputSchema,
    run: (async (q: z.infer<typeof inputSchema>) => {
      const ai = new GoogleGenAI({ apiKey: key, apiVersion: "v1beta" });
      const proOk = Date.now() - proTiredAt > PRO_REST_MS;
      const models = [...(proOk ? PRO : []), MODEL];
      const text = `${q.pregunta}${q.contexto ? `\n\nContexto:\n${q.contexto}` : ""}\n\n${now()}`;
      for (;;) {
        try {
          const res = await ai.models.generateContent({ model: models[0], contents: text, config: { systemInstruction: THINKER } });
          return res.text?.trim() || "No llegué a ninguna conclusión.";
        } catch (e) {
          if (e instanceof ApiError && (e.status === 404 || e.status === 429 || e.status === 403 || e.status >= 500) && models.length > 1) {
            const failed = models.shift()!;
            if (PRO.includes(failed) && e.status === 429) proTiredAt = Date.now();
            console.warn("pensar model unavailable, trying next", failed, e.status);
            continue;
          }
          throw e;
        }
      }
    }) as JarvisTool["run"],
  };
}

/** The last message came from the open microphone, which also picks up people talking nearby, the TV, etc. */
const OPEN_MIC = `

Micrófono abierto: el último mensaje lo transcribió el micrófono, que también capta a otras personas, la tele o ruido.
Si no parece dirigido a vos (una charla con otra persona, frases sueltas sin sentido, algo de fondo), respondé exactamente: [ignorar]
y nada más. Ante la duda, si es una pregunta o un pedido que vos podrías resolver, respondé normalmente.`;

/** Jarvis: Gemini with tools over the signed-in person's HUB, Gmail and Google Calendar. */
export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "not_configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  // Only the HUB owner may spend the API key.
  const owner = process.env.HUB_OWNER_ID;
  if (owner && user.id !== owner) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { turns?: Turn[]; screen?: string; desktop?: boolean; openMic?: boolean } | null;
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
  const tools = [...jarvisTools(sb, changed), ...(body?.desktop ? desktopTools(actions) : []), pensar(key)];
  const memory = await memoryDigest(sb);
  const byName = new Map(tools.map((t) => [t.name, t]));
  // v1beta: the "-latest" aliases and function calling live there (the SDK defaults to v1).
  const ai = new GoogleGenAI({ apiKey: key, apiVersion: "v1beta" });
  const models = [...new Set([MODEL, ...FALLBACKS])];
  const config = {
    systemInstruction: `${SYSTEM}${body?.openMic ? OPEN_MIC : ""}\n\nLo que recordás de Lucas:\n${memory}\n\n${now()}`,
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
          if (e instanceof ApiError && (e.status === 404 || e.status === 429 || e.status === 403 || e.status >= 500) && models.length > 1) {
            const failed = models.shift()!;
            if (PRO.includes(failed) && e.status === 429) proTiredAt = Date.now();
            console.warn("jarvis model unavailable, trying next", failed, e.status);
            continue;
          }
          throw e;
        }
      }
      const calls = res.functionCalls ?? [];
      if (!calls.length) {
        if (body?.openMic && /^\s*\[?ignorar\]?\.?\s*$/i.test(res.text ?? "")) return Response.json({ text: "[ignorar]", emotion: "normal", changed, actions });
        const { text, emotion } = splitEmotion(res.text ?? "");
        return Response.json({ text: text || "Listo.", emotion, changed, actions, model: models[0] });
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
