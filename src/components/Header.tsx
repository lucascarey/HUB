"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { SyncStatus } from "@/lib/store";
import type { Item } from "@/lib/types";
import type { Account } from "@/lib/useHub";

interface Props {
  project?: Item;
  onHome: () => void;
  tomorrowCount: number;
  onTomorrow: () => void;
  account: Account | null;
  status: SyncStatus;
  cloudEnabled: boolean;
  signIn: (email: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  onReset: () => void;
}

const STATUS_TEXT: Record<SyncStatus, string> = {
  local: "Solo en este dispositivo",
  synced: "Sincronizado",
  saving: "Guardando…",
  error: "Sin conexión, reintentando",
};

export default function Header(p: Props) {
  const [menu, setMenu] = useState(false);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [resetArmed, setResetArmed] = useState(false);

  useEffect(() => {
    if (!resetArmed) return;
    const t = setTimeout(() => setResetArmed(false), 3500);
    return () => clearTimeout(t);
  }, [resetArmed]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setMsg("Enviando…");
    const err = await p.signIn(email.trim());
    setMsg(err ?? `Listo. Abrí el link que te llegó a ${email.trim()} desde este dispositivo.`);
  };

  return (
    <header className="bar">
      <nav id="crumbs" aria-label="Ubicación">
        <button type="button" className={p.project ? "" : "cur"} onClick={p.onHome}>HUB</button>
        {p.project && (
          <>
            <span className="sep">/</span>
            <button type="button" className="cur" style={{ color: "var(--c-proyecto)" }}>{p.project.title}</button>
          </>
        )}
      </nav>
      <span className="spacer" />
      <button className="pill" type="button" disabled={!p.tomorrowCount} onClick={p.onTomorrow}>
        <span className="dot" />
        {p.tomorrowCount ? `Mañana: ${p.tomorrowCount} ${p.tomorrowCount === 1 ? "cosa" : "cosas"}` : "Nada para mañana"}
      </button>
      <div className="menuWrap">
        <button className="pill" type="button" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <span className={`sync ${p.status}`} />
          {p.account ? p.account.email.split("@")[0] : "Cuenta"}
        </button>
        {menu && (
          <div className="menu panel">
            <p className="note"><b>{STATUS_TEXT[p.status]}</b></p>
            {p.account ? (
              <>
                <p className="note">Conectado como {p.account.email}. Lo que cambiás se guarda en la nube y lo ves en todos tus dispositivos.</p>
                <button className="btn" type="button" onClick={() => void p.signOut()}>Cerrar sesión</button>
              </>
            ) : p.cloudEnabled ? (
              <form onSubmit={send} className="col">
                <p className="note">Entrá con tu mail para ver el HUB igual en la compu y en el celu. Te mandamos un link, sin contraseña.</p>
                <input type="email" id="loginEmail" required placeholder="tu@mail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <button className="btn main" type="submit">Mandarme el link</button>
                {msg && <p className="note">{msg}</p>}
              </form>
            ) : (
              <p className="note">Por ahora todo se guarda en este navegador. Cuando conectemos Supabase vas a poder sincronizar tus dispositivos.</p>
            )}
            <button
              className="btn warn"
              type="button"
              onClick={() => {
                if (!resetArmed) return setResetArmed(true);
                setResetArmed(false);
                setMenu(false);
                p.onReset();
              }}
            >
              {resetArmed ? "¿Borrar todo y volver al ejemplo? Tocá de nuevo" : "Volver a los datos de ejemplo"}
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
