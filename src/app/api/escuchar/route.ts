import { ApiError, GoogleGenAI } from "@google/genai";
import { userFromRequest } from "@/lib/gmail-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Free Gemini models get saturated at times: if one is busy or slow, the next one answers.
const MODELS = [process.env.GEMINI_MODEL || "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-lite-latest"];
const PER_TRY_MS = 8000;
const BUDGET_MS = 25_000;
const PROMPT =
  "Transcribí exactamente lo que dice la persona en este audio (español rioplatense). Puede empezar llamando al asistente por su nombre, \"Cosmo\". Respondé solo con el texto, sin comillas ni comentarios. Si no se entiende nada o no habla nadie, respondé vacío.";

/**
 * Speech to text with Gemini, for places without the browser's recognizer (the desktop app).
 * Body: { audio: base64 WAV }. Returns { text } ("" when nothing was said).
 */
export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "not_configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const owner = process.env.HUB_OWNER_ID;
  if (owner && user.id !== owner) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { audio?: string } | null;
  const audio = body?.audio;
  if (!audio || audio.length > 4_000_000) return Response.json({ error: "bad_request" }, { status: 400 });

  const ai = new GoogleGenAI({ apiKey: key, apiVersion: "v1beta" });
  const start = Date.now();
  let busy = false;
  for (const model of [...new Set(MODELS)]) {
    const left = BUDGET_MS - (Date.now() - start);
    if (left < 2000) break;
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: audio } }, { text: PROMPT }] }],
        config: { abortSignal: AbortSignal.timeout(Math.min(PER_TRY_MS, left)) },
      });
      const text = (res.text ?? "").trim().replace(/^["“]|["”]$/g, "");
      return Response.json({ text });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      // 404: model not available; 429/5xx/timeout: busy right now. Either way, try the next one.
      if (status === 404 || status === 429 || status >= 500 || status === 0) {
        busy ||= status !== 404;
        console.warn("escuchar", model, status || String(e).slice(0, 120));
        continue;
      }
      console.error("escuchar", e);
      return Response.json({ error: "error" }, { status: 502 });
    }
  }
  return Response.json({ error: busy ? "busy" : "no_model" }, { status: 503 });
}
