import { ApiError, GoogleGenAI } from "@google/genai";
import { userFromRequest } from "@/lib/gmail-server";
import { edgeSpeak } from "@/lib/edge-voice";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Gemini's speech models (free tier of AI Studio, with a smaller daily limit than chat).
const MODELS = [process.env.GEMINI_TTS_MODEL, "gemini-2.5-flash-preview-tts", "gemini-2.5-flash-tts"].filter(Boolean) as string[];
const VOICE = process.env.GEMINI_TTS_VOICE || "Charon";
const RATE = 24000;

/** Raw 16-bit mono PCM → a WAV file the browser can play. */
function wav(pcm: Buffer) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Jarvis's human voice: Microsoft's Tomás (es-AR), then Gemini text-to-speech. The app falls back to the browser voice on any error. */
export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "not_configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const owner = process.env.HUB_OWNER_ID;
  if (owner && user.id !== owner) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { text?: string } | null;
  const text = body?.text?.trim().slice(0, 900);
  if (!text) return Response.json({ error: "bad_request" }, { status: 400 });

  // First choice: Tomás, Microsoft's Argentine neural voice (free, no daily limit).
  try {
    const mp3 = await edgeSpeak(text);
    if (mp3.length > 1000)
      return new Response(new Uint8Array(mp3), { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (e) {
    console.warn("voz edge", String(e).slice(0, 200));
  }

  const ai = new GoogleGenAI({ apiKey: key, apiVersion: "v1beta" });
  const prompt = `Decilo en español rioplatense de Buenos Aires, con voz cálida, natural y un poco canchera, a ritmo de charla:\n${text}`;
  for (const model of MODELS) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        },
      });
      const data = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
      if (!data) return Response.json({ error: "empty" }, { status: 502 });
      return new Response(new Uint8Array(wav(Buffer.from(data, "base64"))), {
        headers: { "content-type": "audio/wav", "cache-control": "no-store" },
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) continue;
      console.error("voz", e);
      const status = e instanceof ApiError && e.status === 429 ? 429 : 502;
      return Response.json({ error: status === 429 ? "rate_limited" : "error" }, { status });
    }
  }
  return Response.json({ error: "no_model" }, { status: 502 });
}
