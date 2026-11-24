"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import CozmoFace from "./CozmoFace";
import { desktop, useJarvis } from "@/lib/useJarvis";
import { supabase } from "@/lib/supabase";
import type { Emotion } from "@/lib/cozmo";

type Mood = "awake" | "asleep" | "hidden";

const SLEEP_AFTER = 8 * 60_000;
const REMIND_BEFORE = 15 * 60_000;
const SEEN_KEY = "jarvis-reminded";
const GREET_KEY = "jarvis-greeted";
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

async function bearer() {
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

/**
 * Cosmo as a desktop companion: a small boxy head that hovers around the screen watching the mouse, peeks, falls asleep, hides, wakes up with "Cosmo, …", and speaks up on its own for
 * upcoming events and a morning hello. Movement only happens inside the Windows app.
 */
export default function Companion() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!supabase) return setSignedIn(false);
    void supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSignedIn(!!s));
    return () => data.subscription.unsubscribe();
  }, []);

  // The page is see-through so only the head shows over the desktop.
  useEffect(() => {
    document.documentElement.classList.add("compa-root");
    return () => document.documentElement.classList.remove("compa-root");
  }, []);

  if (signedIn === null) return null;
  return signedIn ? <Alive /> : <Login />;
}

function Alive() {
  const jarvis = useJarvis({ signedIn: true, onChanged: () => {} });
  const { wake, toggleWake, phase, say, setEmotion } = jarvis;
  const [mood, setMood] = useState<Mood>("awake");
  const [bubble, setBubble] = useState("");
  const [flash, setFlash] = useState<Emotion | null>(null);
  const lastActive = useRef(Date.now());
  const moodRef = useRef<Mood>("awake");
  const area = useRef<{ x: number; y: number; width: number; height: number; winW: number; winH: number } | null>(null);
  const pos = useRef({ x: 0, y: 0 });
  const d = desktop();

  // Hands-free is the point of the companion: turn it on once.
  useEffect(() => {
    if (!wake) toggleWake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = useCallback((x: number, y: number, ms = 900) => {
    pos.current = { x, y };
    d?.moveTo(Math.round(x), Math.round(y), ms);
  }, [d]);

  /**
   * Where he goes: floating anywhere on the screen ("float", slow), back down to the bottom edge ("show"),
   * peeking (half sunk), asleep (lower) or gone.
   */
  const spot = useCallback((where: "float" | "show" | "peek" | "sleep" | "hide", x?: number, fy?: number) => {
    const a = area.current;
    if (!a) return;
    const nx = x ?? pos.current.x;
    const bottom = a.y + a.height;
    const y = where === "float" ? (fy ?? pos.current.y)
      : where === "show" ? bottom - a.winH
      : where === "peek" ? bottom - a.winH * 0.55
      : where === "sleep" ? bottom - a.winH * 0.42
      : bottom + 4;
    const cx = Math.max(a.x, Math.min(a.x + a.width - a.winW, nx));
    const cy = Math.max(a.y, Math.min(bottom + 4, y));
    const dist = Math.hypot(cx - pos.current.x, cy - pos.current.y);
    const ms = where === "hide" ? 700 : where === "float" ? Math.min(5200, 1400 + dist * 3.2) : 1100;
    go(cx, cy, ms);
  }, [go]);

  // His eyes follow the mouse around the screen (a few times a second, smoothed in the face).
  const gaze = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!d?.gaze) return;
    const t = setInterval(() => {
      if (moodRef.current !== "awake") return void (gaze.current = null);
      void d.gaze!().then((g) => {
        if (!g) return;
        const far = Math.hypot(g.dx, g.dy);
        // Very close (over his own head) or idle far away for long: let him glance on his own.
        gaze.current = far < 40 ? null : { x: g.dx / 500, y: g.dy / 350 };
      }).catch(() => {});
    }, 120);
    return () => clearInterval(t);
  }, [d]);

  const setM = useCallback((m: Mood) => {
    moodRef.current = m;
    setMood(m);
  }, []);

  const wakeUp = useCallback(() => {
    lastActive.current = Date.now();
    if (moodRef.current !== "awake") {
      setM("awake");
      spot("show");
    }
  }, [setM, spot]);

  // Start in the bottom-right corner.
  useEffect(() => {
    if (!d) return;
    void d.workArea().then((a) => {
      area.current = a;
      pos.current = { x: a.x + a.width - a.winW - 24, y: a.y + a.height - a.winH };
      spot("show", pos.current.x);
    });
  }, [d, spot]);

  // Anything Jarvis does counts as activity and brings him out.
  useEffect(() => {
    if (phase !== "idle") wakeUp();
  }, [phase, wakeUp]);

  // Speech bubble: what he hears, then what he says, for a few seconds.
  useEffect(() => {
    if (jarvis.interim) return setBubble(jarvis.interim);
    if (phase === "thinking") return setBubble("…");
    if (phase === "speaking" && jarvis.lastReply) return setBubble(jarvis.lastReply);
    if (phase === "idle") {
      const t = setTimeout(() => setBubble(""), 6000);
      return () => clearTimeout(t);
    }
  }, [jarvis.interim, phase, jarvis.lastReply]);

  // A life of his own: wander, glance, peek, yawn; sleep when nobody talks to him.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      timer = setTimeout(tick, rand(7_000, 20_000));
      if (phase !== "idle" || moodRef.current === "hidden") return;
      const idle = Date.now() - lastActive.current;
      if (moodRef.current === "awake" && idle > SLEEP_AFTER) {
        setM("asleep");
        const a = area.current;
        if (a) spot("sleep", a.x + a.width - a.winW - 24);
        return;
      }
      if (moodRef.current !== "awake") return;
      const a = area.current;
      const act = pick(["float", "float", "float", "glance", "glance", "peek", "yawn", "stay"]);
      if (act === "float" && a) spot("float", rand(a.x, a.x + a.width - a.winW), rand(a.y + 20, a.y + a.height - a.winH));
      else if (act === "peek" && a) {
        spot("peek");
        setTimeout(() => moodRef.current === "awake" && spot("show"), rand(5000, 11000));
      } else if (act === "glance" || act === "yawn") {
        const e: Emotion = act === "yawn" ? "desganado" : pick(["picaro", "sospechoso", "asombrado", "concentrado", "feliz"]);
        setFlash(e);
        setTimeout(() => setFlash(null), rand(1800, 3200));
      }
    };
    timer = setTimeout(tick, rand(8000, 15000));
    return () => clearTimeout(timer);
  }, [phase, setM, spot]);

  // Comes back by himself a while after being sent away.
  useEffect(() => {
    if (mood !== "hidden") return;
    const t = setTimeout(() => {
      setM("asleep");
      spot("sleep");
    }, rand(20, 40) * 60_000);
    return () => clearTimeout(t);
  }, [mood, setM, spot]);

  // Speaks up on his own: upcoming events and a morning hello.
  useEffect(() => {
    const check = async () => {
      const t = await bearer();
      if (!t) return;
      const today = new Date().toLocaleDateString("sv-SE");
      try {
        if (localStorage.getItem(GREET_KEY) !== today && new Date().getHours() >= 6) {
          localStorage.setItem(GREET_KEY, today);
          wakeUp();
          void jarvis.ask("Acabo de prender la compu. Saludame corto y contame en una o dos frases qué tengo hoy.");
          return;
        }
      } catch {}
      const res = await fetch("/api/agenda?days=1", { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
      const json = res ? await res.json().catch(() => null) : null;
      const events: { id: string; title: string; start: string; allDay: boolean }[] = json?.events ?? [];
      let seen: string[] = [];
      try {
        seen = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
      } catch {}
      for (const ev of events) {
        if (ev.allDay || seen.includes(ev.id)) continue;
        const left = new Date(ev.start).getTime() - Date.now();
        if (left > 0 && left <= REMIND_BEFORE) {
          wakeUp();
          const mins = Math.max(1, Math.round(left / 60_000));
          if (say(`En ${mins} ${mins === 1 ? "minuto" : "minutos"} tenés ${ev.title}. Te aviso porque te conozco.`, "sospechoso")) {
            seen = [...seen, ev.id].slice(-50);
            try {
              localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
            } catch {}
          }
          break;
        }
      }
    };
    const first = setTimeout(check, 4000);
    const every = setInterval(check, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const shown: Emotion = mood === "asleep" ? "dormido" : flash ?? jarvis.emotion;

  return (
    <div className={`compa ${mood}`}>
      {bubble && mood === "awake" && <p className="compa-bubble">{bubble}</p>}
      <button
        type="button"
        className="compa-head"
        onMouseEnter={() => d?.setClickable(true)}
        onMouseLeave={() => d?.setClickable(false)}
        onClick={() => {
          wakeUp();
          jarvis.mic();
        }}
        onDoubleClick={() => {
          setM("hidden");
          setEmotion("feliz");
          spot("hide");
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          d?.openHub();
        }}
        title="Clic: hablar · Doble clic: esconderme · Clic derecho: abrir el HUB"
      >
        <CozmoFace emotion={shown} mode={mood === "asleep" ? "idle" : phase} size={170} square gaze={gaze} />
      </button>
      {jarvis.note && <p className="compa-note">{jarvis.note}</p>}
    </div>
  );
}

/**
 * Sign-in for the desktop app: magic links open in the normal browser, so Lucas pastes the link from the
 * email here instead (a 6-digit code also works if the email template ever includes one).
 */
function Login() {
  const [email, setEmail] = useState("");
  const [value, setValue] = useState("");
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState("");
  const d = desktop();

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setMsg("Enviando…");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/compa` },
    });
    if (error) return setMsg("No pude mandar el mail. Revisá la dirección.");
    setSent(true);
    setMsg("Te llegó un mail. No toques el botón: clic derecho → “Copiar dirección del enlace” y pegalo acá.");
  };
  const enter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    const v = value.trim();
    if (/^https:\/\/\S+\/auth\/v1\/verify\?/.test(v)) {
      setMsg("Entrando…");
      window.location.href = v;
      return;
    }
    if (/^\d{6}$/.test(v)) {
      setMsg("Verificando…");
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: v, type: "email" });
      if (error) setMsg("Ese código no sirve. Pedí otro mail.");
      return;
    }
    setMsg("Eso no parece el link del mail. Copiá el enlace del botón del mail.");
  };

  return (
    <div className="compa login" onMouseEnter={() => d?.setClickable(true)}>
      <div className="compa-head static">
        <CozmoFace emotion="dormido" size={110} />
      </div>
      {!sent ? (
        <form onSubmit={send} className="compa-form">
          <input type="email" required placeholder="Tu mail del HUB" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <button type="submit">Despertar</button>
        </form>
      ) : (
        <form onSubmit={enter} className="compa-form">
          <input required placeholder="Pegá el link del mail" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          <button type="submit">Entrar</button>
        </form>
      )}
      {msg && <p className="compa-note">{msg}</p>}
    </div>
  );
}
