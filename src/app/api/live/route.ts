import { GoogleGenAI, EndSensitivity, Modality } from "@google/genai";
import { z } from "zod";
import { supabaseAs, userFromRequest } from "@/lib/gmail-server";
import { liveSystem, schemaFor } from "@/lib/jarvis-brain";
import { desktopTools, jarvisTools, memoryDigest, type Changed } from "@/lib/jarvis-tools";

export const dynamic = "force-dynamic";

/** Live (speech in, speech out) models, newest first; the client asks for the next one if a model fails. */
const LIVE_MODELS = [process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live", "gemini-3.1-flash-live-preview", "gemini-live-2.5-flash-preview"];
const VOICE = process.env.GEMINI_LIVE_VOICE || "Algenib";

/** Tools that only exist in the live chat; the app runs them itself. */
const LIVE_ONLY = [
  { name: "mirar_pantalla", description: "Mira la pantalla de Lucas ahora (solo en la app de escritorio). La imagen llega después.", inputSchema: z.object({}) },
  { name: "terminar_charla", description: "Termina la charla de voz cuando Lucas se despide o dice que es todo.", inputSchema: z.object({}) },
];

/**
 * A short-lived token for one live voice chat with Cosmo, with his personality, memory and tools locked in,
 * so the app talks to Gemini directly (low latency) without ever seeing the API key.
 * Body: { model?: number, desktop?: boolean }. Returns { token, model, voice }.
 */
export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "not_configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const owner = process.env.HUB_OWNER_ID;
  if (owner && user.id !== owner) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { model?: number; desktop?: boolean } | null;
  const models = [...new Set(LIVE_MODELS)];
  const idx = Math.max(0, Math.min(models.length - 1, Number(body?.model) || 0));
  const model = models[idx];

  const sb = supabaseAs(user.token);
  const changed: Changed = { hub: false, calendar: false, memory: false };
  const tools = [...jarvisTools(sb, changed), ...(body?.desktop ? [...desktopTools([]), ...LIVE_ONLY] : LIVE_ONLY.slice(1))];
  const memory = await memoryDigest(sb);

  try {
    const ai = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1beta" } });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(),
        liveConnectConstraints: {
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: liveSystem(memory),
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
            inputAudioTranscription: {},
            // Lucas can pause to think mid-sentence without being cut off.
            realtimeInputConfig: {
              automaticActivityDetection: { endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW, silenceDurationMs: 900, prefixPaddingMs: 300 },
            },
            outputAudioTranscription: {},
            tools: [{
              functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: schemaFor(t.inputSchema) })),
            }],
          },
        },
      },
    });
    return Response.json({ token: token.name, model, next: idx + 1 < models.length ? idx + 1 : null });
  } catch (e) {
    console.error("live token", e);
    return Response.json({ error: "error", next: idx + 1 < models.length ? idx + 1 : null }, { status: 502 });
  }
}
