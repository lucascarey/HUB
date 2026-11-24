import { ApiError, GoogleGenAI } from "@google/genai";
import { userFromRequest } from "@/lib/gmail-server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MODELS = [process.env.GEMINI_MODEL || "gemini-flash-latest", "gemini-2.5-flash"];

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
  if (!audio || audio.length > 2_500_000) return Response.json({ error: "bad_request" }, { status: 400 });

  const ai = new GoogleGenAI({ apiKey: key, apiVersion: "v1beta" });
  for (const model of [...new Set(MODELS)]) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "audio/wav", data: audio } },
            { text: "Transcribí exactamente lo que dice la persona en este audio (español rioplatense). Respondé solo con el texto, sin comillas ni comentarios. Si no se entiende nada o no habla nadie, respondé vacío." },
          ],
        }],
      });
      const text = (res.text ?? "").trim().replace(/^["“]|["”]$/g, "");
      return Response.json({ text });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue;
      console.error("escuchar", e);
      const status = e instanceof ApiError && e.status === 429 ? 429 : 502;
      return Response.json({ error: status === 429 ? "rate_limited" : "error" }, { status });
    }
  }
  return Response.json({ error: "no_model" }, { status: 502 });
}
