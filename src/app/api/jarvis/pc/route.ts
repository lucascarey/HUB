import { ApiError, GoogleGenAI } from "@google/genai";
import { userFromRequest } from "@/lib/gmail-server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Each step needs a quick look at the screen: Flash is fast and its free quota is big enough for many steps.
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-pro-latest"];

const PROMPT = `Sos las manos de Cosmo, el compañero de escritorio de Lucas, en su compu con Windows.
Tenés que lograr un objetivo usando el mouse y el teclado, de a un paso por vez. Recibís una captura de la pantalla actual
y la lista de lo que ya hiciste. Devolvé SOLO un JSON con el próximo paso, sin texto alrededor.

Coordenadas: x e y van de 0 a 1000 sobre la captura (0,0 arriba a la izquierda; 1000,1000 abajo a la derecha).
Apuntá al centro del botón, link o campo.

Acciones posibles:
{"type":"click","x":..,"y":..,"nota":"..."}
{"type":"double_click","x":..,"y":..,"nota":"..."}
{"type":"right_click","x":..,"y":..,"nota":"..."}
{"type":"type","text":"...","nota":"..."}            (escribe donde está el foco; hacé click en el campo antes)
{"type":"keys","keys":"ctrl+l","nota":"..."}          (teclas: ctrl, shift, alt, win, enter, tab, esc, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1–f12, letras y números, combinadas con +)
{"type":"scroll","x":..,"y":..,"direction":"down"|"up","amount":3,"nota":"..."}
{"type":"drag","x":..,"y":..,"x2":..,"y2":..,"nota":"..."}
{"type":"wait","seconds":2,"nota":"..."}              (si algo está cargando)
{"type":"open","url":"https://...","nota":"..."}      (abre un link en el navegador)
{"type":"done","texto":"..."}                          (objetivo logrado: contale a Lucas en una frase qué hiciste)
{"type":"ask","texto":"..."}                           (necesitás que Lucas confirme o decida algo)
{"type":"fail","texto":"..."}                          (no se puede: explicá por qué en una frase)

Reglas:
- "nota" es una frase muy corta en castellano rioplatense de lo que estás haciendo ("Abro Spotify…"). Se le muestra a Lucas.
- Para abrir un programa: tecla win, escribí su nombre, enter.
- Antes de algo irreversible o delicado (enviar un mail o mensaje, comprar, pagar, borrar, publicar, aceptar términos, escribir contraseñas), usá "ask" para que Lucas confirme, salvo que ya lo haya pedido explícitamente en el objetivo.
- Nunca escribas contraseñas ni datos de tarjetas.
- Si un paso no funcionó (la pantalla no cambió), probá otra forma en vez de repetirlo igual.
- Cuando el objetivo esté cumplido, "done". No hagas nada de más.`;

type Step = { action: string; ok: boolean };

/** One step of Cosmo using Lucas's computer: screenshot + goal + what he did so far → the next action. */
export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "not_configured" }, { status: 503 });
  const user = await userFromRequest(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const owner = process.env.HUB_OWNER_ID;
  if (owner && user.id !== owner) return Response.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as { goal?: string; steps?: Step[]; screen?: string } | null;
  const goal = String(body?.goal ?? "").slice(0, 2000).trim();
  const screen = typeof body?.screen === "string" && body.screen.length < 3_000_000 ? body.screen : null;
  if (!goal || !screen) return Response.json({ error: "bad_request" }, { status: 400 });
  const steps = (body?.steps ?? []).slice(-25);
  const history = steps.length
    ? steps.map((s, i) => `${i + 1}. ${String(s.action).slice(0, 300)} → ${s.ok ? "hecho" : "FALLÓ"}`).join("\n")
    : "(todavía nada)";

  const ai = new GoogleGenAI({ apiKey: key, apiVersion: "v1beta", httpOptions: { timeout: 12000 } });
  const models = [...MODELS];
  for (;;) {
    try {
      const res = await ai.models.generateContent({
        model: models[0],
        contents: [{
          role: "user",
          parts: [
            { text: `Objetivo de Lucas: ${goal}\n\nLo que ya hiciste:\n${history}\n\nCaptura actual:` },
            { inlineData: { mimeType: "image/jpeg", data: screen } },
          ],
        }],
        config: { systemInstruction: PROMPT, responseMimeType: "application/json" },
      });
      const raw = res.text ?? "";
      const m = raw.match(/\{[\s\S]*\}/);
      const action = m ? JSON.parse(m[0]) : null;
      if (!action || typeof action.type !== "string") return Response.json({ action: { type: "fail", texto: "Me perdí mirando la pantalla." } });
      return Response.json({ action });
    } catch (e) {
      if (((e instanceof ApiError && (e.status === 404 || e.status === 429 || e.status >= 500)) || /abort|timeout/i.test(String(e))) && models.length > 1) {
        console.warn("pc model unavailable, trying next", models.shift(), e instanceof ApiError ? e.status : "timeout");
        continue;
      }
      console.error("pc", e);
      if (e instanceof ApiError && e.status === 429) return Response.json({ error: "rate_limited" }, { status: 429 });
      return Response.json({ error: "error" }, { status: 502 });
    }
  }
}
