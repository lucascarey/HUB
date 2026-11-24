"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { supabase } from "@/lib/supabase";

type Turn = { role: "user" | "assistant"; text: string };
type Phase = "idle" | "listening" | "thinking" | "speaking";

// Minimal typing for the Web Speech API (Chrome ships it as webkitSpeechRecognition).
type SRResult = { isFinal: boolean; 0: { transcript: string } };
type SREvent = { resultIndex: number; results: ArrayLike<SRResult> };
interface SR {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: SREvent) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
const getSR = (): (new () => SR) | null => {
  if (typeof window === "undefined") return null;
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

async function token() {
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

function speak(text: string, onEnd: () => void) {
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

interface Props {
  signedIn: boolean;
  onChanged: () => void;
}

/** Jarvis: talk or type to the HUB's assistant. Optional hands-free mode wakes on "Jarvis". */
export default function Jarvis({ signedIn, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [interim, setInterim] = useState("");
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(true);
  const [wake, setWake] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  const rec = useRef<SR | null>(null);
  const wakeRef = useRef(false);
  const phaseRef = useRef<Phase>("idle");
  const turnsRef = useRef<Turn[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const awaitingCommand = useRef(false);
  // Speech callbacks outlive renders: they call the latest ask() through this ref.
  const askRef = useRef<(q: string) => Promise<void>>(async () => {});

  const setP = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  useEffect(() => {
    setSupported(!!getSR());
    const t = readTurns();
    turnsRef.current = t;
    setTurns(t);
    try {
      if (localStorage.getItem(WAKE_KEY) === "1") setWake(true);
    } catch {}
    // Voices load asynchronously in Chrome.
    window.speechSynthesis?.getVoices();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, interim, phase]);

  const push = (t: Turn) => {
    const next = [...turnsRef.current, t].slice(-16);
    turnsRef.current = next;
    setTurns(next);
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {}
  };

  // Hands-free listening restarts itself after every phrase while the mode is on.
  const startListening = useCallback((mode: "command" | "wake") => {
    const SRC = getSR();
    if (!SRC) return;
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
        else if (phaseRef.current === "listening") setP("idle");
        else if (wakeRef.current) startListening("wake");
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

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question) return;
    rec.current?.abort();
    rec.current = null;
    setInterim("");
    setOpen(true);
    setNote(null);
    push({ role: "user", text: question });
    setP("thinking");
    let reply = "";
    try {
      const t = await token();
      const res = await fetch("/api/jarvis", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${t}` },
        body: JSON.stringify({ turns: turnsRef.current }),
      });
      const json = await res.json().catch(() => ({}));
      if (json.text) {
        reply = json.text;
        if (json.changed?.hub) onChanged();
      } else {
        reply =
          json.error === "not_configured" ? "Todavía falta cargar la clave de Gemini en Vercel."
          : json.error === "unauthorized" ? "Iniciá sesión en el HUB para que pueda ayudarte."
          : json.error === "forbidden" ? "Este Jarvis es solo de Lucas."
          : json.error === "bad_key" ? "La clave de Gemini no funciona. Revisala en Vercel."
          : json.error === "rate_limited" ? "Llegué al límite gratis de Gemini por ahora. Probá en un rato."
          : "Algo falló. Probá de nuevo.";
      }
    } catch {
      reply = "No tengo conexión ahora.";
    }
    push({ role: "assistant", text: reply });
    const resume = () => {
      setP("idle");
      if (wakeRef.current) startListening("wake");
    };
    if (voice) {
      setP("speaking");
      speak(reply, resume);
    } else resume();
  };

  askRef.current = ask;

  const toggleWake = () => {
    const on = !wake;
    setWake(on);
    try {
      localStorage.setItem(WAKE_KEY, on ? "1" : "0");
    } catch {}
  };

  // Hands-free mode only runs while the app is open and in view (a web app can't listen in the background).
  useEffect(() => {
    wakeRef.current = wake && signedIn;
    if (!wakeRef.current) {
      if (rec.current?.continuous) rec.current.abort();
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
    if (phase === "speaking") {
      window.speechSynthesis?.cancel();
      setP("idle");
      return;
    }
    if (phase === "listening") {
      rec.current?.stop();
      return;
    }
    if (phase === "thinking") return;
    setOpen(true);
    startListening("command");
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text;
    setText("");
    void ask(q);
  };

  const clear = () => {
    turnsRef.current = [];
    setTurns([]);
    try {
      sessionStorage.removeItem(HISTORY_KEY);
    } catch {}
  };

  const status =
    phase === "listening" ? "Escuchando…"
    : phase === "thinking" ? "Pensando…"
    : phase === "speaking" ? "Hablando · tocá para cortar"
    : wake ? "Decí “Jarvis” y lo que necesites"
    : "Tocá el micrófono o escribí";

  return (
    <>
      <button
        type="button"
        id="jarvisOrb"
        className={`jv-${phase}${wake ? " jv-wake" : ""}`}
        aria-label={open ? "Cerrar Jarvis" : "Abrir Jarvis"}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="jv-core" />
      </button>

      {open && (
        <section className="panel" id="jarvis" aria-label="Jarvis">
          <button type="button" className="x" onClick={() => setOpen(false)} aria-label="Cerrar">×</button>
          <header className="jv-head">
            <div className="k">Asistente</div>
            <h2>Jarvis</h2>
          </header>

          {!signedIn ? (
            <p className="note">Iniciá sesión desde Cuenta para usar Jarvis: trabaja con tus datos guardados en la nube.</p>
          ) : (
            <>
              <div className="jv-list" ref={listRef}>
                {turns.length === 0 && (
                  <p className="note">
                    Probá: “¿qué tengo mañana?”, “agendá dentista el jueves a las 10”, “anotá llamar a Juan en Gato Negro”, “anotá press banca 60 kilos 8 reps”.
                  </p>
                )}
                {turns.map((t, i) => (
                  <p key={i} className={`jv-msg jv-${t.role}`}>{t.text}</p>
                ))}
                {interim && <p className="jv-msg jv-user jv-interim">{interim}</p>}
                {phase === "thinking" && <p className="jv-msg jv-assistant jv-dots"><span /><span /><span /></p>}
              </div>

              {note && <p className="note">{note}</p>}

              <form className="jv-input" onSubmit={submit}>
                <input
                  type="text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Escribile a Jarvis…"
                  aria-label="Mensaje para Jarvis"
                  disabled={phase === "thinking"}
                />
                {supported && (
                  <button type="button" className={`jv-mic jv-${phase}`} onClick={mic} aria-label="Hablar">
                    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                      <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />
                    </svg>
                  </button>
                )}
              </form>

              <footer className="jv-foot">
                <span className="jv-status">{status}</span>
                <span className="jv-opts">
                  <label><input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Voz</label>
                  {supported && (
                    <label title="Mientras el HUB está abierto en pantalla">
                      <input type="checkbox" checked={wake} onChange={toggleWake} /> Manos libres
                    </label>
                  )}
                  {turns.length > 0 && <button type="button" className="mb-link" onClick={clear}>Borrar charla</button>}
                </span>
              </footer>
            </>
          )}
        </section>
      )}
    </>
  );
}
