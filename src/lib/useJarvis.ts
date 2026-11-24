"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isEmotion, type Emotion } from "./cozmo";
import { supabase } from "./supabase";
import { recordPhrase, stopRecording } from "./recorder";
import { startWakeWord, stopWakeWord } from "./wakeword";
import { LiveChat } from "./live";
import { chirp, hush as hushChirps, moodFor } from "./droid";

/** Goodbyes that end a live chat once he's answered. */
const BYE_RE = /\b(chau|chao|adi[oó]s|nos vemos|hasta luego|eso es todo)\b/i;

export type Turn = { role: "user" | "assistant"; text: string };
export type Phase = "idle" | "listening" | "thinking" | "speaking";

// Minimal typing for the Web Speech API (Chrome ships it as webkitSpeechRecognition).
type SRResult = { isFinal: boolean; 0: { transcript: string } };
type SREvent = { resultIndex: number; results: ArrayLike<SRResult> };
interface SR {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: SREvent) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
/** Bridge the Windows desktop app exposes (desktop/preload.cjs). */
export interface DesktopBridge {
  speak(text: string): Promise<ArrayBuffer | null>;
  moveTo(x: number, y: number, ms?: number): void;
  /** Puts the window there right away (every frame while moving); missing before 0.1.8. */
  place?(x: number, y: number): void;
  workArea(): Promise<{ x: number; y: number; width: number; height: number; winW: number; winH: number }>;
  setClickable(on: boolean): void;
  openHub(path?: string): void;
  hide(): void;
  /** JPEG (base64) of the main screen without Jarvis; missing in installers before 0.1.3. */
  screenshot?(): Promise<string | null>;
  /** Types text where Lucas's cursor is (or only copies it); missing before 0.1.4. */
  write?(text: string, paste: boolean): Promise<boolean>;
  /** Opens a link in the normal browser; missing before 0.1.4. */
  openUrl?(url: string): void;
  /** Mouse position relative to the centre of Cosmo's window (px); missing before 0.1.6. */
  gaze?(): Promise<{ dx: number; dy: number } | null>;
  /** Listens for "Cosmo, …" with Windows' speech recognizer; returns the stop function. Missing before 0.1.5. */
  onCosmo?(cb: (m: CosmoEvent) => void): () => void;
}
export type CosmoEvent =
  | { type: "ready"; culture: string }
  | { type: "heard"; only: boolean; confidence: number; wav: string | null }
  | { type: "error"; reason: string }
  | { type: "debug"; line: string };

/** "Cosmo, poneme una alarma" → "poneme una alarma". */
const stripName = (s: string) => s.replace(/^\s*(hey\s+|che\s+)?(cosmo|kosmo|cosmos|cozmo)\b[\s,.:;!¡?¿-]*/i, "").trim();

/** Questions about what Lucas has in front of him: those go with a screenshot in the desktop app. */
const SCREEN_RE = new RegExp(
  [
    "pantalla",
    "\\b(ves|mir[aá]|mirame|fijate|le[eé]me|le[eé]lo)\\b",
    "\\bqu[eé] (es|dice|significa|onda con) (esto|eso|ac[aá])",
    "\\b(este|esta|ese|esa) (error|p[aá]gina|mail|ventana|c[oó]digo|archivo|foto|imagen|tabla|gr[aá]fico|video|mensaje|programa)\\b",
    "\\b(con|en) esto\\b",
    "lo que (estoy|tengo) (viendo|haciendo|abierto|delante)",
  ].join("|"),
  "i",
);
export const desktop = (): DesktopBridge | null =>
  typeof window === "undefined" ? null : ((window as unknown as { jarvisDesktop?: DesktopBridge }).jarvisDesktop ?? null);

const getSR = (): (new () => SR) | null => {
  if (typeof window === "undefined") return null;
  // Electron has the API but no Google key behind it: record and transcribe with Gemini instead.
  if (desktop()) return null;
  const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const HISTORY_KEY = "hub-jarvis-turns";
const WAKE_KEY = "hub-jarvis-wake";
const WAKE = /\b(jarvis|yarvis|jarbis|yarbis|harvis)\b[,.!]?\s*/i;

const readTurns = (): Turn[] => {
  try {
    const t = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(t) ? t.slice(-16) : [];
  } catch {
    return [];
  }
};

/** Sends a diagnostic line to the HUB server log (desktop app only), so problems on Lucas's PC can be read remotely. */
export function diag(event: string, detail?: unknown) {
  if (!desktop()) return;
  void token().then((t) => {
    if (!t) return;
    return fetch("/api/jarvis/log", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
    body: JSON.stringify({ event, detail }),
    keepalive: true,
  });
  }).catch(() => {});
}

async function token() {
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

function browserSpeak(text: string, onEnd: () => void) {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return onEnd();
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = synth.getVoices();
  u.voice = voices.find((v) => v.lang === "es-AR") ?? voices.find((v) => v.lang.startsWith("es-US"))
    ?? voices.find((v) => v.lang.startsWith("es")) ?? null;
  u.lang = u.voice?.lang ?? "es-AR";
  u.rate = 1.05;
  u.onend = onEnd;
  u.onerror = onEnd;
  synth.speak(u);
}

let playing: HTMLAudioElement | null = null;
// After Gemini's voice hits its free daily limit, use the browser voice until the page reloads.
let humanVoiceOff = false;

let droidTimer: ReturnType<typeof setTimeout> | null = null;

function stopSpeaking() {
  hushChirps();
  if (droidTimer) clearTimeout(droidTimer);
  droidTimer = null;
  playing?.pause();
  playing = null;
  window.speechSynthesis?.cancel();
}

async function play(blob: Blob, onEnd: () => void) {
  const url = URL.createObjectURL(blob);
  const a = new Audio(url);
  playing = a;
  const done = () => {
    URL.revokeObjectURL(url);
    if (playing === a) {
      playing = null;
      onEnd();
    }
  };
  a.onended = done;
  a.onerror = done;
  try {
    await a.play();
    return true;
  } catch {
    playing = null;
    URL.revokeObjectURL(url);
    return false;
  }
}

/** Speaks with the desktop app's voice or Jarvis's human voice, or the browser's voice if that isn't available. */
async function speak(text: string, onEnd: () => void, emotion = "normal") {
  stopSpeaking();
  const d = desktop();
  if (d) {
    // On the desktop Cosmo doesn't talk: he beeps like a droid and the words show in his bubble.
    const secs = chirp(text, moodFor(emotion, text));
    droidTimer = setTimeout(onEnd, Math.max(600, secs * 1000 + 300));
    return;
  }
  const t = humanVoiceOff ? null : await token();
  if (t) {
    try {
      const res = await fetch("/api/voz", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ text }),
      });
      if (res.ok && (await play(await res.blob(), onEnd))) return;
      if (res.status === 429 || res.status === 503) humanVoiceOff = true;
    } catch {
      // Autoplay blocked or no connection: fall back below.
      playing = null;
    }
  }
  browserSpeak(text, onEnd);
}

interface Options {
  signedIn: boolean;
  onChanged: () => void;
}

/** Jarvis's voice and conversation: speech in, Gemini reply, speech out, the face's emotion, hands-free "Jarvis" wake word. */
export function useJarvis({ signedIn, onChanged }: Options) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [interim, setInterim] = useState("");
  const [voice, setVoice] = useState(true);
  const [wake, setWake] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [emotion, setEmotion] = useState<Emotion>("normal");
  const [changes, setChanges] = useState(0);
  const [supported, setSupported] = useState(false);
  const rec = useRef<SR | null>(null);
  const wakeRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  const turnsRef = useRef<Turn[]>([]);
  const awaitingCommand = useRef(false);
  const wakeWordFailed = useRef(false);
  const cosmoFailed = useRef(false);
  const cosmoOff = useRef<(() => void) | null>(null);
  const cosmoDebug = useRef(0);
  const onCosmoRef = useRef<(m: CosmoEvent) => void>(() => {});
  // Speech callbacks outlive renders: they call the latest ask() through this ref.
  const askRef = useRef<(q: string) => Promise<void>>(async () => {});
  const live = useRef<LiveChat | null>(null);
  // When the live chat last failed: it's retried after a couple of minutes instead of never.
  const liveFailedAt = useRef(0);
  const liveDown = () => Date.now() - liveFailedAt.current < 120_000;
  const liveTurn = useRef<{ user: number; assistant: number }>({ user: -1, assistant: -1 });

  const setP = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  useEffect(() => {
    setSupported(!!getSR() || !!navigator.mediaDevices?.getUserMedia);
    const t = readTurns();
    turnsRef.current = t;
    setTurns(t);
    try {
      if (localStorage.getItem(WAKE_KEY) === "1") setWake(true);
    } catch {}
    // Voices load asynchronously in Chrome.
    window.speechSynthesis?.getVoices();
    const d = desktop();
    if (d) diag("start", { bridge: Object.keys(d), ua: navigator.userAgent.slice(-60) });
  }, []);

  // Safety net: if he's been "listening" or "thinking" for over a minute outside a live chat, something
  // got stuck. Go back to idle so "Cosmo" and clicks work again.
  useEffect(() => {
    if (phase === "idle" || phase === "speaking") return;
    const t = setTimeout(() => {
      if (live.current || phaseRef.current === "idle") return;
      diag("stuck", phaseRef.current);
      rec.current?.abort();
      rec.current = null;
      stopRecording();
      setInterim("");
      setP("idle");
      if (wakeRef.current) startListeningRef.current("wake");
    }, 60_000);
    return () => clearTimeout(t);
  }, [phase]);


  const push = (t: Turn) => {
    const next = [...turnsRef.current, t].slice(-16);
    turnsRef.current = next;
    setTurns(next);
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {}
  };

  /** Live chat transcript: grows the current turn in place, then starts a new one. */
  const liveText = (role: "user" | "assistant", text: string, done: boolean) => {
    if (!text) return;
    const at = liveTurn.current[role];
    if (at >= 0 && at < turnsRef.current.length && turnsRef.current[at].role === role) {
      const next = turnsRef.current.map((t, i) => (i === at ? { role, text } : t));
      turnsRef.current = next;
      setTurns(next);
    } else {
      push({ role, text });
      liveTurn.current[role] = turnsRef.current.length - 1;
    }
    if (done) {
      liveTurn.current[role] = -1;
      try {
        sessionStorage.setItem(HISTORY_KEY, JSON.stringify(turnsRef.current));
      } catch {}
    }
    if (role === "user") setInterim(done ? "" : text);
  };

  /** Cosmo's tools during a live chat: this computer's ones here, the rest on the HUB server. */
  const liveTool = async (name: string, args: Record<string, unknown>) => {
    const d = desktop();
    if (name === "escribir") {
      const ok = await d?.write?.(String(args.texto ?? ""), args.pegar !== false).catch(() => false);
      return ok ? "Escrito donde está el cursor (y copiado)." : "No pude escribirlo.";
    }
    if (name === "abrir") {
      if (!d?.openUrl) return "Solo puedo abrir links desde la app de escritorio.";
      d.openUrl(String(args.url ?? ""));
      return "Abierto.";
    }
    if (name === "mirar_pantalla") {
      const shot = await d?.screenshot?.().catch(() => null);
      return shot ? `data:image/jpeg;base64,${shot}` : "No pude ver la pantalla.";
    }
    const t = await token();
    const res = await fetch("/api/jarvis/tool", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
      body: JSON.stringify({ name, args }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => ({})) : {};
    if (json.changed?.hub) onChanged();
    if (json.changed?.hub || json.changed?.memory || json.changed?.calendar) setChanges((c) => c + 1);
    return String(json.output ?? "Error de conexión.");
  };

  /**
   * Opens a live voice chat (Windows app only). Resolves false if Gemini Live can't be reached,
   * so the caller falls back to the one-question-at-a-time flow.
   */
  const startLive = async (firstPhraseWav?: string | null) => {
    if (live.current) return true;
    if (liveDown() || !desktop()?.write) return false;
    const bearer = await token();
    if (!bearer) return false;
    void stopWakeWord();
    setOpen(true);
    setNote(null);
    liveTurn.current = { user: -1, assistant: -1 };
    // Ears mode: Live only hears him; each phrase is answered by Gemini Pro (smarter, more himself).
    let queue = Promise.resolve();
    const reply = async (text: string) => {
      if (live.current !== chat) return;
      liveText("user", text, true);
      chat.hold(true);
      setP("thinking");
      setEmotion("concentrado");
      const { reply: said, mood } = await answer(text);
      if (live.current !== chat) return void chat.hold(false);
      push({ role: "assistant", text: said });
      setEmotion(mood as Emotion);
      setP("speaking");
      const secs = chirp(said, moodFor(mood, said));
      await new Promise((r) => setTimeout(r, Math.max(900, secs * 1000 + 200)));
      chat.hold(false);
      if (live.current !== chat) return;
      if (BYE_RE.test(text)) return chat.stop("bye");
      setP("listening");
    };
    const chat = new LiveChat({
      bearer,
      desktop: true,
      droid: true,
      ears: (text) => {
        queue = queue.then(() => reply(text)).catch((e) => console.error("live reply", e));
      },
      onState: (s) => {
        if (live.current !== chat) return;
        setP(s === "connecting" ? "thinking" : s);
        if (s === "speaking") setEmotion("normal");
        if (s === "thinking") setEmotion("concentrado");
      },
      onTurn: liveText,
      runTool: liveTool,
      onEnd: (reason) => {
        if (live.current !== chat) return;
        diag("live-end", { reason, err: chat.lastError, micChunks: chat.micChunks, micPeak: Math.round(chat.micPeak * 1000) / 1000 });
        live.current = null;
        setInterim("");
        setP("idle");
        if (reason === "error") setNote("Se cortó la charla. Decime “Cosmo” de nuevo.");
        if (reason === "idle") setEmotion("desganado");
        if (wakeRef.current) startListeningRef.current("wake");
      },
    });
    live.current = chat;
    const ok = await chat.start(firstPhraseWav).catch((e) => {
      console.error("live start", e);
      return false;
    });
    diag("live-start", { ok, err: chat.lastError, phrase: !!firstPhraseWav });
    // If the microphone only delivers silence, say so: it's a Windows setting, not something Cosmo can fix.
    if (ok) setTimeout(() => {
      if (live.current !== chat || chat.micPeak > 0.003) return;
      diag("mic-silent", { chunks: chat.micChunks, peak: chat.micPeak });
      setNote("Tu micrófono me llega en silencio. Revisá en Windows: Privacidad > Micrófono > “Permitir que las apps de escritorio accedan”, y que en Sonido > Entrada esté el micrófono correcto.");
    }, 6000);
    if (!ok) {
      live.current = null;
      liveFailedAt.current = Date.now();
      setP("idle");
      setNote("La charla en vivo no está disponible ahora. Te respondo de a una pregunta.");
      return false;
    }
    return true;
  };

  // Hands-free listening restarts itself after every phrase while the mode is on.
  // Without a speech recognizer: record one phrase, transcribe it with Gemini, then ask.
  /** WAV (base64) → text with Gemini; "" when nothing was understood (and a note says why). */
  const transcribe = async (wav: string) => {
    const t = await token();
    const res = await fetch("/api/escuchar", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
      body: JSON.stringify({ audio: wav }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) diag("escuchar", { status: res.status, error: json.error });
    if (!res.ok) setNote(json.error === "busy" ? "Gemini está saturado y no te pude entender. Probá de nuevo en un ratito." : "No te pude entender. Probá de nuevo.");
    return String(json.text ?? "").trim();
  };

  const listenByRecording = async () => {
    if (phaseRef.current === "listening") return;
    setP("listening");
    setInterim("Te escucho…");
    let said = "";
    try {
      const wav = await recordPhrase();
      if (wav) {
        setInterim("…");
        said = stripName(await transcribe(wav));
      }
    } catch (e) {
      console.error("listen", e);
      diag("mic-error", String(e));
      setNote("No pude usar el micrófono.");
    }
    setInterim("");
    if (said) return void askRef.current(said);
    setP("idle");
    if (wakeRef.current) startListeningRef.current("wake");
  };
  const startListeningRef = useRef<(m: "command" | "wake") => void>(() => {});
  const listenRef = useRef(listenByRecording);
  listenRef.current = listenByRecording;

  const startListening = useCallback((mode: "command" | "wake") => {
    // In the Windows app: "Cosmo, …" through Windows' own recognizer, said in one go.
    const d = desktop();
    if (mode === "wake" && d?.onCosmo && !cosmoFailed.current) {
      cosmoOff.current ??= d.onCosmo((m) => onCosmoRef.current(m));
      return;
    }
    // Hands-free with the on-device "Jarvis" detector (works with the tab in the background).
    if (mode === "wake" && !wakeWordFailed.current) {
      startWakeWord(() => {
        if (!wakeRef.current || phaseRef.current !== "idle") return;
        void stopWakeWord();
        setEmotion("sorprendido");
        startListening("command");
      }).then((running) => {
        if (running) return;
        // The browser holds the audio until the first touch; it starts by itself on that touch.
        const msg = "Tocame una vez y empiezo a escucharte.";
        setNote(msg);
        const clear = () => setNote((n) => (n === msg ? null : n));
        window.addEventListener("pointerdown", clear, { once: true, capture: true });
        window.addEventListener("keydown", clear, { once: true, capture: true });
      }).catch((e) => {
        console.error("wake word", e);
        wakeWordFailed.current = true;
        setNote("No pude activar \"Hey Jarvis\". Uso el modo simple.");
        if (wakeRef.current) startListening("wake");
      });
      return;
    }
    if (mode === "command") void stopWakeWord();
    const SRC = getSR();
    if (!SRC) {
      if (mode === "command") void listenRef.current();
      return;
    }
    rec.current?.abort();
    const r = new SRC();
    r.lang = "es-AR";
    r.interimResults = true;
    r.continuous = mode === "wake";
    let finalText = "";
    r.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else live += res[0].transcript;
      }
      if (mode === "command") {
        setInterim((finalText + live).trim());
        return;
      }
      // Wake mode: only react to phrases that call Jarvis (or the phrase right after "Jarvis" alone).
      if (WAKE.test(live) && !awaitingCommand.current) setInterim("…");
      if (!finalText) return;
      const said = finalText.trim();
      finalText = "";
      const m = said.match(WAKE);
      if (m) {
        const command = said.slice((m.index ?? 0) + m[0].length).trim();
        if (command.length > 2) {
          void askRef.current(command);
        } else {
          awaitingCommand.current = true;
          setEmotion("sorprendido");
          setOpen(true);
          setP("listening");
          setInterim("Te escucho…");
        }
      } else if (awaitingCommand.current) {
        awaitingCommand.current = false;
        void askRef.current(said);
      } else {
        setInterim("");
      }
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setNote("El navegador no dio permiso al micrófono.");
        wakeRef.current = false;
        setWake(false);
      }
    };
    r.onend = () => {
      if (rec.current !== r) return;
      rec.current = null;
      if (mode === "command") {
        const said = finalText.trim();
        setInterim("");
        if (said) void askRef.current(said);
        else {
          if (phaseRef.current === "listening") setP("idle");
          if (wakeRef.current) startListening("wake");
        }
        return;
      }
      // Chrome ends continuous recognition after a while; keep going while the app is in view.
      if (wakeRef.current && phaseRef.current !== "thinking" && phaseRef.current !== "speaking" && document.visibilityState === "visible")
        setTimeout(() => wakeRef.current && !rec.current && startListening("wake"), 250);
    };
    rec.current = r;
    try {
      r.start();
      if (mode === "command") setP("listening");
    } catch {
      rec.current = null;
    }
  }, []);
  startListeningRef.current = startListening;

  onCosmoRef.current = (m: CosmoEvent) => {
    if (m.type === "debug") {
      // Recognizer chatter (low-confidence hits, mic level): only the first few, enough to diagnose.
      if (cosmoDebug.current++ < 12) diag("cosmo-debug", m.line);
      // Windows is shy about "Cosmo" with an Argentinian accent: a fairly sure hit on the name still wakes him.
      const low = /^LOW ([\d.,]+) (cosmo|kosmo|cosmos)\b/i.exec(m.line);
      if (low && Number(low[1].replace(",", ".")) >= 0.25) onCosmoRef.current({ type: "heard", only: true, confidence: Number(low[1].replace(",", ".")), wav: null });
      return;
    }
    diag(`cosmo-${m.type}`, m.type === "heard" ? { only: m.only, conf: m.confidence, wav: m.wav?.length ?? 0, phase: phaseRef.current, wake: wakeRef.current } : m);
    if (m.type === "error") {
      console.warn("cosmo", m.reason);
      cosmoFailed.current = true;
      cosmoOff.current?.();
      cosmoOff.current = null;
      setNote("No pude activar “Cosmo” en Windows. Mientras, decime “Hey Jarvis”.");
      if (wakeRef.current && phaseRef.current === "idle") startListening("wake");
      return;
    }
    if (m.type !== "heard" || !wakeRef.current || phaseRef.current !== "idle") return;
    setEmotion("sorprendido");
    // A little "huh?" so Lucas knows he heard his name.
    if (desktop()) chirp("x", "question", 2);
    void startLive(m.wav).then((ok) => {
      if (!ok) oneShot(m);
    });
  };
  const oneShot = (m: Extract<CosmoEvent, { type: "heard" }>) => {
    if (m.only || !m.wav) return startListening("command");
    const wav = m.wav;
    setP("thinking");
    setInterim("…");
    void transcribe(wav).then((text) => {
      setInterim("");
      const said = stripName(text);
      if (said) return askRef.current(said);
      // Only the name came through: listen for what comes next.
      setP("idle");
      startListening("command");
    }, () => {
      setInterim("");
      setP("idle");
    });
  };

  /** Cosmo's answer to the conversation so far (the last turn is Lucas's question), from Gemini Pro on the server. */
  const answer = async (question: string) => {
    let reply = "";
    let mood = "normal";
    try {
      const t = await token();
      const d = desktop();
      const screen = d?.screenshot && SCREEN_RE.test(question) ? await d.screenshot().catch(() => null) : null;
      if (screen) setEmotion("concentrado");
      const res = await fetch("/api/jarvis", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ turns: turnsRef.current, ...(screen ? { screen } : {}), ...(d?.write ? { desktop: true } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      for (const a of Array.isArray(json.actions) ? json.actions : []) {
        if (a?.type === "write" && typeof a.text === "string") await d?.write?.(a.text, a.paste !== false).catch(() => false);
        else if (a?.type === "open" && typeof a.url === "string") d?.openUrl?.(a.url);
      }
      if (json.text) {
        reply = json.text;
        mood = typeof json.emotion === "string" && isEmotion(json.emotion) ? json.emotion : "normal";
        setEmotion(mood as Emotion);
        if (json.changed?.hub) onChanged();
        if (json.changed?.hub || json.changed?.memory || json.changed?.calendar) setChanges((c) => c + 1);
      } else {
        reply =
          json.error === "not_configured" ? "Todavía falta cargar la clave de Gemini en Vercel."
          : json.error === "unauthorized" ? "Iniciá sesión en el HUB para que pueda ayudarte."
          : json.error === "forbidden" ? "Este Jarvis es solo de Lucas."
          : json.error === "bad_key" ? "La clave de Gemini no funciona. Revisala en Vercel."
          : json.error === "rate_limited" ? "Llegué al límite gratis de Gemini por ahora. Probá en un rato."
          : "Algo falló. Probá de nuevo.";
        mood = "triste";
        setEmotion("triste");
      }
    } catch {
      reply = "No tengo conexión ahora.";
      mood = "triste";
        setEmotion("triste");
    }
    return { reply, mood };
  };

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question) return;
    rec.current?.abort();
    rec.current = null;
    void stopWakeWord();
    setInterim("");
    setOpen(true);
    setNote(null);
    push({ role: "user", text: question });
    setP("thinking");
    const { reply, mood } = await answer(question);
    push({ role: "assistant", text: reply });
    const resume = () => {
      setP("idle");
      if (wakeRef.current) startListening("wake");
    };
    if (voice) {
      setP("speaking");
      void speak(reply, resume, mood);
    } else resume();
  };

  askRef.current = ask;

  /** Jarvis speaks on his own (a reminder, a greeting), without a question from Lucas. */
  const say = (text: string, mood: Emotion = "normal") => {
    if (phaseRef.current !== "idle") return false;
    void stopWakeWord();
    setEmotion(mood);
    push({ role: "assistant", text });
    const resume = () => {
      setP("idle");
      if (wakeRef.current) startListening("wake");
    };
    if (voice) {
      setP("speaking");
      void speak(text, resume, mood);
    } else resume();
    return true;
  };

  const toggleWake = () => {
    const on = !wake;
    setWake(on);
    try {
      localStorage.setItem(WAKE_KEY, on ? "1" : "0");
    } catch {}
  };

  // Hands-free mode. The browser recognizer only runs with the app in view; the Porcupine detector keeps listening in the background.
  useEffect(() => {
    wakeRef.current = wake && signedIn;
    if (!wakeRef.current) {
      if (rec.current?.continuous) rec.current.abort();
      void stopWakeWord();
      cosmoOff.current?.();
      cosmoOff.current = null;
      return;
    }
    if (!rec.current && phaseRef.current === "idle") startListening("wake");
    const onVis = () => {
      if (document.visibilityState === "visible") {
        if (wakeRef.current && !rec.current && phaseRef.current === "idle") startListening("wake");
      } else rec.current?.abort();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [wake, signedIn, startListening]);

  const mic = () => {
    diag("click", { phase: phaseRef.current, live: !!live.current, liveDown: liveDown() });
    // In a live chat a click hangs up; on the desktop, a click opens one.
    if (live.current) return live.current.stop("stopped");
    // Stuck waiting for an answer: a click cancels it and starts over.
    if (phaseRef.current === "thinking" && desktop()) {
      setInterim("");
      setP("idle");
    }
    if (phaseRef.current === "idle" && desktop()?.write && !liveDown()) {
      void startLive().then((ok) => {
        if (!ok) startListening("command");
      });
      return;
    }
    if (phaseRef.current === "speaking") {
      stopSpeaking();
      setP("idle");
      if (wakeRef.current) startListening("wake");
      return;
    }
    if (phaseRef.current === "listening") {
      rec.current?.stop();
      stopRecording();
      return;
    }
    if (phaseRef.current === "thinking") return;
    setOpen(true);
    startListening("command");
  };

  const clear = () => {
    turnsRef.current = [];
    setTurns([]);
    try {
      sessionStorage.removeItem(HISTORY_KEY);
    } catch {}
  };

  const lastReply = [...turns].reverse().find((t) => t.role === "assistant")?.text ?? "";

  return {
    open, setOpen, turns, phase, interim, voice, setVoice, wake, toggleWake, note, supported,
    emotion, setEmotion, changes, lastReply, ask, say, mic, clear,
  };
}
