"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { dayOff, fmtDate } from "@/lib/dates";
import { supabase } from "@/lib/supabase";
import type { SyncStatus } from "@/lib/store";
import type { HubData } from "@/lib/types";
import type { Account } from "@/lib/useHub";
import { useJarvis } from "@/lib/useJarvis";
import CozmoFace from "./CozmoFace";
import GymPanel from "./GymPanel";
import Header from "./Header";

type Memory = { id: string; kind: string; content: string; created_at: string };
type Mail = { id: string; threadId: string; from: string; subject: string };
type Event = { id: string; title: string; start: string; allDay: boolean; link: string | null };
type Remote<T> = { status: "loading" | "ok" | "not_connected" | "no_calendar" | "unauthorized" | "not_configured" | "error"; list: T[]; total?: number };

type Entry = { id: string; label: string; meta?: string; href?: string; done?: boolean; toggle?: () => void; remove?: () => void };
type LobeKey = "agenda" | "pendientes" | "proyectos" | "memoria" | "bandeja" | "gym";
type Lobe = { key: LobeKey; title: string; color: string; entries: Entry[]; empty: string; action?: { label: string; run: () => void } };

const LEFT: LobeKey[] = ["agenda", "pendientes", "proyectos"];

const KIND_LABEL: Record<string, string> = {
  dato: "Dato", persona: "Persona", preferencia: "Le gusta", plan: "Plan", recuerdo: "Recuerdo", idea: "Idea",
};

async function token() {
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

async function getJSON(path: string) {
  const t = await token();
  if (!t) return { status: "unauthorized" };
  const res = await fetch(path, { headers: { authorization: `Bearer ${t}` }, cache: "no-store" });
  return res.json().catch(() => ({ status: "error" }));
}

const timeOf = (e: Event) => {
  if (e.allDay) return fmtDate(e.start.slice(0, 10));
  const d = new Date(e.start);
  const day = e.start.slice(0, 10);
  const when = day === dayOff(0) ? "Hoy" : day === dayOff(1) ? "Mañana" : fmtDate(day);
  return `${when} ${d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}`;
};

interface Props {
  data: HubData;
  update: (fn: (d: HubData) => HubData) => void;
  reload: () => Promise<void>;
  account: Account | null;
  status: SyncStatus;
  cloudEnabled: boolean;
  signIn: (email: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  reset: () => void;
}

/** The HUB's home: Jarvis's face in the middle and the "lobes" of Lucas's life around it, filling up as it learns. */
export default function Brain(p: Props) {
  const { data, update } = p;
  const signedIn = !!p.account;
  const jarvis = useJarvis({ signedIn, onChanged: () => void p.reload() });
  const [memories, setMemories] = useState<Remote<Memory>>({ status: "loading", list: [] });
  const [mail, setMail] = useState<Remote<Mail>>({ status: "loading", list: [] });
  const [agenda, setAgenda] = useState<Remote<Event>>({ status: "loading", list: [] });
  const [openLobe, setOpenLobe] = useState<LobeKey | null>(null);
  const [gymOpen, setGymOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [text, setText] = useState("");
  const [connecting, setConnecting] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLButtonElement>(null);
  const lobeRefs = useRef(new Map<LobeKey, HTMLElement>());
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [anchors, setAnchors] = useState<{ c: { x: number; y: number }; to: Partial<Record<LobeKey, { x: number; y: number }>> } | null>(null);

  // Synapses run from the face to the inner edge of each lobe, measured after layout.
  const measure = useCallback(() => {
    const el = stage.current, face = faceRef.current;
    if (!el || !face) return;
    const base = el.getBoundingClientRect();
    const f = face.getBoundingClientRect();
    const c = { x: f.left + f.width / 2 - base.left, y: f.top + f.height / 2 - base.top };
    const to: Partial<Record<LobeKey, { x: number; y: number }>> = {};
    for (const [k, node] of lobeRefs.current) {
      const r = node.getBoundingClientRect();
      to[k] = { x: (LEFT.includes(k) ? r.right : r.left) - base.left, y: r.top + Math.min(r.height / 2, 28) - base.top };
    }
    setSize({ w: base.width, h: base.height });
    setAnchors({ c, to });
  }, []);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    for (const n of lobeRefs.current.values()) ro.observe(n);
    return () => ro.disconnect();
  }, [measure]);

  const loadMemories = useCallback(async () => {
    if (!supabase || !signedIn) return setMemories({ status: "unauthorized", list: [] });
    const { data: rows, error } = await supabase.from("memories").select("id,kind,content,created_at").order("created_at", { ascending: false }).limit(60);
    setMemories(error ? { status: "error", list: [] } : { status: "ok", list: rows as Memory[] });
  }, [signedIn]);

  const loadGoogle = useCallback(async () => {
    const [m, a] = await Promise.all([getJSON("/api/mail"), getJSON("/api/agenda")]);
    setMail({ status: m.status, list: m.mails ?? [], total: m.total });
    setAgenda({ status: a.status, list: a.events ?? [] });
  }, []);

  useEffect(() => {
    void loadMemories();
    void loadGoogle();
    const id = setInterval(() => void loadGoogle(), 5 * 60_000);
    return () => clearInterval(id);
  }, [loadMemories, loadGoogle, signedIn]);

  // Whenever Jarvis changed something, refresh what it could have touched.
  useEffect(() => {
    if (!jarvis.changes) return;
    void loadMemories();
    void loadGoogle();
  }, [jarvis.changes, loadMemories, loadGoogle]);

  const connectGoogle = useCallback(async () => {
    setConnecting(true);
    const t = await token();
    const res = await fetch("/api/gmail/start", { method: "POST", headers: { authorization: `Bearer ${t}` } });
    const json = await res.json().catch(() => ({}));
    if (json.url) window.location.href = json.url;
    else setConnecting(false);
  }, []);

  const toggleItem = useCallback(
    (id: string) => update((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? { ...i, done: !i.done } : i)) })),
    [update],
  );

  const lobes: Lobe[] = useMemo(() => {
    const today = dayOff(0);
    const soon = dayOff(7);
    const byId = new Map(data.items.map((i) => [i.id, i]));
    const pending = data.items
      .filter((i) => !i.done && (i.type === "tarea" || i.type === "dinero" || i.type === "evento") && (!i.date || i.date <= soon))
      .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
    const projects = data.items.filter((i) => i.type === "proyecto");
    const ideas = data.items.filter((i) => i.type === "idea" && !i.done);
    const google = (s: string) =>
      s === "not_connected" ? "Conectá Google para que lo vea." : s === "no_calendar" ? "Reconectá Google sumando Calendar." : s === "unauthorized" ? "Iniciá sesión desde Cuenta." : s === "error" ? "No pude leerlo ahora." : s === "loading" ? "Mirando…" : "Nada por ahora.";
    const needsGoogle = (s: string) => s === "not_connected" || s === "no_calendar";

    // Gym: best weight per exercise, most recently trained first.
    const best = new Map<string, { kg: number; reps: number; date: string }>();
    for (const g of [...data.gym].sort((a, b) => b.date.localeCompare(a.date))) {
      const b = best.get(g.exercise);
      if (!b) best.set(g.exercise, { kg: g.kg, reps: g.reps, date: g.date });
      else if (g.kg > b.kg) best.set(g.exercise, { ...b, kg: g.kg, reps: g.reps });
    }

    return [
      {
        key: "agenda", title: "Agenda", color: "var(--c-evento)",
        entries: agenda.list.map((e) => ({ id: e.id, label: e.title, meta: timeOf(e), href: e.link ?? undefined })),
        empty: google(agenda.status),
        action: needsGoogle(agenda.status) ? { label: connecting ? "Abriendo Google…" : "Conectar Google", run: () => void connectGoogle() } : undefined,
      },
      {
        key: "pendientes", title: "Pendientes", color: "var(--c-tarea)",
        entries: pending.map((i) => ({
          id: i.id,
          label: i.title,
          meta: [i.date ? (i.date < today ? "Vencido" : i.date === today ? "Hoy" : fmtDate(i.date)) : "", i.parentId ? byId.get(i.parentId)?.title : "", i.type === "dinero" ? "Plata" : ""].filter(Boolean).join(" · "),
          done: i.done,
          toggle: () => toggleItem(i.id),
        })),
        empty: "Nada pendiente. Decile a Jarvis “anotá…”.",
      },
      {
        key: "proyectos", title: "Proyectos", color: "var(--c-proyecto)",
        entries: projects.map((pr) => {
          const open = data.items.filter((i) => i.parentId === pr.id && !i.done).length;
          return { id: pr.id, label: pr.title, meta: open ? `${open} pendiente${open > 1 ? "s" : ""}` : "al día", href: "/red" };
        }),
        empty: "Todavía no hay proyectos.",
      },
      {
        key: "memoria", title: "Memoria", color: "var(--c-idea)",
        entries: [
          ...memories.list.map((m) => ({
            id: m.id, label: m.content, meta: KIND_LABEL[m.kind] ?? m.kind,
            remove: () => void supabase?.from("memories").delete().eq("id", m.id).then(() => loadMemories()),
          })),
          ...ideas.map((i) => ({ id: i.id, label: i.title, meta: "Idea" })),
        ],
        empty: signedIn ? "Vacía. Contale a Jarvis de vos y la va llenando." : "Iniciá sesión para que Jarvis recuerde.",
      },
      {
        key: "bandeja", title: "Bandeja", color: "var(--c-mail)",
        entries: mail.list.map((m) => ({ id: m.id, label: m.subject, meta: m.from, href: `https://mail.google.com/mail/u/0/#inbox/${m.threadId}` })),
        empty: mail.status === "ok" ? "Nada importante sin leer." : google(mail.status),
        action: needsGoogle(mail.status) ? { label: connecting ? "Abriendo Google…" : "Conectar Google", run: () => void connectGoogle() } : undefined,
      },
      {
        key: "gym", title: "Gym", color: "var(--c-gym)",
        entries: [...best].map(([name, b]) => ({ id: name, label: name, meta: `${b.kg} kg × ${b.reps} · ${fmtDate(b.date)}` })),
        empty: "Sin registros. Decile “anotá press banca 60 kilos 8 reps”.",
        action: { label: "Abrir Gym", run: () => setGymOpen(true) },
      },
    ];
  }, [data, agenda, mail, memories, signedIn, connecting, connectGoogle, toggleItem, loadMemories]);

  const wide = size.w >= 900;
  useLayoutEffect(() => measure(), [lobes, wide, measure]);
  const firing = jarvis.phase === "thinking";

  const subtitle =
    jarvis.interim ||
    (jarvis.phase === "thinking" ? "Pensando…" : "") ||
    jarvis.lastReply ||
    (signedIn ? (jarvis.wake ? "Decí “Hey Jarvis” y lo que necesites." : "Hola, Lucas. Tocá el micrófono o escribime.") : "Iniciá sesión desde Cuenta para despertarme.");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = text;
    setText("");
    void jarvis.ask(q);
  };

  const tomorrowCount = data.items.filter((i) => i.date === dayOff(1) && !i.done).length;
  const panel = openLobe ? lobes.find((l) => l.key === openLobe) : undefined;

  return (
    <div className="brain">
      <Header
        onHome={() => setOpenLobe(null)}
        tomorrowCount={tomorrowCount}
        onTomorrow={() => setOpenLobe("pendientes")}
        onGym={() => setGymOpen((o) => !o)}
        account={p.account}
        status={p.status}
        cloudEnabled={p.cloudEnabled}
        signIn={p.signIn}
        signOut={p.signOut}
        onReset={p.reset}
      />

      <div className={`br-stage${wide ? " wide" : ""}${firing ? " firing" : ""}`} ref={stage}>
        {wide && anchors && (
          <svg className="br-synapses" width={size.w} height={size.h} aria-hidden="true">
            {lobes.map((l) => {
              const t = anchors.to[l.key];
              if (!t) return null;
              const center = anchors.c;
              const mx = (center.x + t.x) / 2, my = (center.y + t.y) / 2;
              const strength = Math.min(1, 0.25 + l.entries.length / 12);
              return (
                <path
                  key={l.key}
                  d={`M${center.x},${center.y} C${mx},${center.y} ${mx},${my + (t.y - my)} ${t.x},${t.y}`}
                  style={{ "--c": l.color, opacity: strength } as CSSProperties}
                />
              );
            })}
          </svg>
        )}

        <div className="br-core">
          <button type="button" className="br-face" ref={faceRef} onClick={jarvis.mic} aria-label="Hablar con Jarvis">
            <CozmoFace emotion={jarvis.emotion} mode={jarvis.phase} size={wide ? 300 : 220} />
          </button>
          <p className={`br-sub${jarvis.interim ? " live" : ""}`} aria-live="polite">{subtitle}</p>
        </div>

        {(["left", "right"] as const).map((side) => (
          <div key={side} className={`br-col ${side}`}>
            {lobes.filter((l) => LEFT.includes(l.key) === (side === "left")).map((l) => (
              <section
                key={l.key}
                ref={(n) => {
                  if (n) lobeRefs.current.set(l.key, n);
                  else lobeRefs.current.delete(l.key);
                }}
                className={`lobe${l.entries.length ? "" : " empty"}`}
                style={{ "--c": l.color } as CSSProperties}
              >
                <button type="button" className="lobe-head" onClick={() => setOpenLobe(l.key)}>
                  <span className="lobe-dot" />
                  <span className="lobe-title">{l.title}</span>
                  {l.entries.length > 0 && <span className="lobe-n">{l.entries.length}</span>}
                </button>
                {l.entries.length === 0 ? (
                  <p className="lobe-empty">{l.empty}</p>
                ) : (
                  <ul className="lobe-list">
                    {l.entries.slice(0, 3).map((e) => (
                      <li key={e.id}>
                        <span className="lobe-label">{e.label}</span>
                        {e.meta && <span className="lobe-meta">{e.meta}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {l.entries.length > 3 && (
                  <button type="button" className="lobe-more" onClick={() => setOpenLobe(l.key)}>+{l.entries.length - 3} más</button>
                )}
                {l.action && l.entries.length === 0 && (
                  <button type="button" className="btn lobe-act" onClick={l.action.run}>{l.action.label}</button>
                )}
              </section>
            ))}
          </div>
        ))}
      </div>

      <form className="br-input" onSubmit={submit}>
        <button type="button" className={`br-chat${chatOpen ? " on" : ""}`} onClick={() => setChatOpen((o) => !o)} aria-label="Ver la charla" title="Charla">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 4h16v12H7l-3 3V4Zm2 2v8.2L6.2 14H18V6H6Z" /></svg>
        </button>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={signedIn ? "Escribile a Jarvis…" : "Iniciá sesión para hablar con Jarvis"}
          aria-label="Mensaje para Jarvis"
          disabled={!signedIn || jarvis.phase === "thinking"}
        />
        {jarvis.supported && (
          <button type="button" className={`br-mic ${jarvis.phase}`} onClick={jarvis.mic} disabled={!signedIn} aria-label="Hablar">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />
            </svg>
          </button>
        )}
      </form>

      <div className="br-opts">
        <label><input type="checkbox" checked={jarvis.voice} onChange={(e) => jarvis.setVoice(e.target.checked)} /> Voz</label>
        {jarvis.supported && (
          <label title="Decí “Hey Jarvis” y te escucha, aunque el HUB esté minimizado"><input type="checkbox" checked={jarvis.wake} onChange={jarvis.toggleWake} /> Manos libres</label>
        )}
        <Link href="/red">Vista red</Link>
      </div>
      {jarvis.note && <p className="br-note">{jarvis.note}</p>}

      {chatOpen && (
        <section className="panel br-chatlog" aria-label="Charla con Jarvis">
          <button type="button" className="x" onClick={() => setChatOpen(false)} aria-label="Cerrar">×</button>
          <h2 className="br-h">Charla</h2>
          <div className="jv-list">
            {jarvis.turns.length === 0 && <p className="note">Todavía no hablaron.</p>}
            {jarvis.turns.map((t, i) => <p key={i} className={`jv-msg jv-${t.role}`}>{t.text}</p>)}
          </div>
          {jarvis.turns.length > 0 && <button type="button" className="mb-link" onClick={jarvis.clear}>Borrar charla</button>}
        </section>
      )}

      {panel && (
        <section className="panel br-panel" style={{ "--c": panel.color } as CSSProperties} aria-label={panel.title}>
          <button type="button" className="x" onClick={() => setOpenLobe(null)} aria-label="Cerrar">×</button>
          <h2 className="br-h"><span className="lobe-dot" /> {panel.title}</h2>
          {panel.entries.length === 0 && <p className="note">{panel.empty}</p>}
          <ul className="br-rows">
            {panel.entries.map((e) => (
              <li key={e.id} className={e.done ? "done" : ""}>
                {e.toggle && <input type="checkbox" checked={!!e.done} onChange={e.toggle} aria-label={`Marcar ${e.label}`} />}
                <div className="br-row-main">
                  {e.href ? (
                    e.href.startsWith("/") ? <Link href={e.href}>{e.label}</Link> : <a href={e.href} target="_blank" rel="noreferrer">{e.label}</a>
                  ) : <span>{e.label}</span>}
                  {e.meta && <small>{e.meta}</small>}
                </div>
                {e.remove && <button type="button" className="mb-link" onClick={e.remove} aria-label="Olvidar">Olvidar</button>}
              </li>
            ))}
          </ul>
          {panel.action && <button type="button" className="btn" onClick={panel.action.run}>{panel.action.label}</button>}
        </section>
      )}

      {gymOpen && <GymPanel gym={data.gym} update={update} onClose={() => setGymOpen(false)} />}
    </div>
  );
}
