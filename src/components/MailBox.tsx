"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Mail = { id: string; threadId: string; from: string; subject: string; snippet: string; date: number };
type State =
  | { status: "loading" }
  | { status: "not_configured" | "not_connected" | "unauthorized" | "error" }
  | { status: "ok"; total: number; mails: Mail[] };

const REFRESH_MS = 5 * 60_000;

function ago(ts: number) {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "recién";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return new Date(ts).toLocaleDateString("es-AR", { day: "numeric", month: "short" });
}

async function token() {
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  return data.session?.access_token ?? null;
}

interface Props {
  x: number;
  y: number;
  dragging: boolean;
  onToTask: (title: string) => void;
}

/** The big box with important unread Gmail, floating in the main space. */
export default function MailBox({ x, y, dragging, onToTask }: Props) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const t = await token();
    if (!t) return setState({ status: "unauthorized" });
    try {
      const res = await fetch("/api/mail", { headers: { authorization: `Bearer ${t}` }, cache: "no-store" });
      setState(await res.json());
    } catch {
      setState({ status: "error" });
    }
  }, []);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const g = p.get("gmail");
    if (g) {
      setNotice(g === "ok" ? "Gmail conectado." : g === "denied" ? "No diste permiso a Gmail." : "No se pudo conectar Gmail. Probá de nuevo.");
      window.history.replaceState(null, "", window.location.pathname);
    }
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const connect = async () => {
    setConnecting(true);
    const t = await token();
    const res = await fetch("/api/gmail/start", { method: "POST", headers: { authorization: `Bearer ${t}` } });
    const json = await res.json().catch(() => ({}));
    if (json.url) window.location.href = json.url;
    else {
      setConnecting(false);
      setNotice(json.error === "not_configured" ? "Falta terminar la configuración de Google." : "No se pudo empezar la conexión.");
    }
  };

  const disconnect = async () => {
    await supabase?.rpc("hub_gmail_disconnect");
    void load();
  };

  const count = state.status === "ok" ? state.total : null;

  return (
    <section
      className={`mailbox${dragging ? " dragging" : ""}`}
      data-widget="mail"
      style={{ left: x, top: y }}
      aria-label="Mails importantes sin leer"
    >
      <header className="mb-head">
        <div>
          <div className="k">Gmail · importantes sin leer</div>
          <h2>
            Bandeja
            {count !== null && <span className="mb-count">{count}</span>}
          </h2>
        </div>
        <div className="mb-actions">
          {state.status === "ok" && (
            <button type="button" className="mb-icon" onClick={() => void load()} aria-label="Actualizar">↻</button>
          )}
        </div>
      </header>

      {notice && <p className="mb-note">{notice}</p>}

      {state.status === "loading" && <p className="mb-empty">Mirando tu bandeja…</p>}

      {state.status === "not_configured" && (
        <p className="mb-empty">Falta crear el permiso de Google para leer tu Gmail. Te pasé los pasos en el chat.</p>
      )}

      {state.status === "not_connected" && (
        <div className="mb-cta">
          <p className="mb-empty">Conectá tu Gmail para ver acá los mails importantes que todavía no leíste. Solo lectura: el HUB no puede mandar ni borrar nada.</p>
          <button type="button" className="btn main" disabled={connecting} onClick={() => void connect()}>
            {connecting ? "Abriendo Google…" : "Conectar Gmail"}
          </button>
        </div>
      )}

      {state.status === "unauthorized" && <p className="mb-empty">Iniciá sesión desde Cuenta para ver tus mails.</p>}
      {state.status === "error" && (
        <div className="mb-cta">
          <p className="mb-empty">No pude leer Gmail ahora.</p>
          <button type="button" className="btn" onClick={() => void load()}>Reintentar</button>
        </div>
      )}

      {state.status === "ok" && state.mails.length === 0 && <p className="mb-empty">Nada importante sin leer. Bien ahí.</p>}

      {state.status === "ok" && state.mails.length > 0 && (
        <ul className="mb-list">
          {state.mails.map((m) => (
            <li key={m.id}>
              <a href={`https://mail.google.com/mail/u/0/#inbox/${m.threadId}`} target="_blank" rel="noreferrer">
                <span className="mb-from">{m.from}</span>
                <span className="mb-time">{ago(m.date)}</span>
                <span className="mb-subj">{m.subject}</span>
                <span className="mb-snip">{m.snippet}</span>
              </a>
              <button type="button" className="mb-task" onClick={() => onToTask(m.subject)} title="Convertir en tarea">
                + tarea
              </button>
            </li>
          ))}
        </ul>
      )}

      {state.status === "ok" && (
        <footer className="mb-foot">
          <button type="button" className="mb-link" onClick={() => void disconnect()}>Desconectar Gmail</button>
        </footer>
      )}
    </section>
  );
}
