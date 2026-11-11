"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { TYPES, newId, type HubData, type Item } from "@/lib/types";

interface Props {
  item: Item;
  data: HubData;
  update: (fn: (d: HubData) => HubData) => void;
  space: string | null;
  onClose: () => void;
  onEnter: () => void;
  onJump: (i: Item) => void;
  onDeleted: () => void;
}

/** Everything about one item, editable in place. */
export default function DetailPanel({ item, data, update, space, onClose, onEnter, onJump, onDeleted }: Props) {
  const [armed, setArmed] = useState(false);
  const patch = (p: Partial<Item>) =>
    update((d) => ({ ...d, items: d.items.map((i) => (i.id === item.id ? { ...i, ...p } : i)) }));

  const mine = data.links.filter((l) => l.a === item.id || l.b === item.id);
  const linkedIds = new Set(mine.map((l) => (l.a === item.id ? l.b : l.a)));
  const candidates = data.items.filter(
    (o) =>
      o.id !== item.id && !linkedIds.has(o.id) &&
      (o.parentId === item.parentId || o.id === item.parentId || o.parentId === null),
  );

  const remove = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    const gone = new Set([item.id, ...data.items.filter((c) => c.parentId === item.id).map((c) => c.id)]);
    update((d) => ({
      items: d.items.filter((i) => !gone.has(i.id)),
      links: d.links.filter((l) => !gone.has(l.a) && !gone.has(l.b)),
    }));
    onDeleted();
  };

  const canFinish = item.type === "tarea" || item.type === "evento" || item.type === "dinero";

  return (
    <aside id="detail" className="panel" style={{ "--c": `var(--c-${item.type})` } as CSSProperties}>
      <button className="x" type="button" aria-label="Cerrar" onClick={onClose}>×</button>
      <div className="k">{TYPES[item.type]}{item.area ? ` · ${item.area}` : ""}</div>
      <input
        className="titleIn"
        type="text"
        id="dTitle"
        aria-label="Título"
        value={item.title}
        onChange={(e) => patch({ title: e.target.value })}
      />
      <div className="row">
        <label className="f" style={{ flex: 1 }}>
          Fecha
          <input type="date" id="dDate" value={item.date} onChange={(e) => patch({ date: e.target.value })} />
        </label>
        <label className="f" style={{ flex: 1 }}>
          Área
          <input type="text" id="dArea" placeholder="Deporte, Trabajo…" value={item.area} onChange={(e) => patch({ area: e.target.value })} />
        </label>
      </div>
      <div className="f">
        Conectado con
        <div className="conns">
          {!mine.length && <span className="empty">Sin conexiones todavía</span>}
          {mine.map((l) => {
            const o = data.items.find((i) => i.id === (l.a === item.id ? l.b : l.a));
            if (!o) return null;
            return (
              <span key={l.id} className="conn" style={{ borderColor: `var(--c-${o.type})` }}>
                <button type="button" onClick={() => onJump(o)}>{o.title}</button>
                <button
                  type="button"
                  aria-label={`Quitar conexión con ${o.title}`}
                  onClick={() => update((d) => ({ ...d, links: d.links.filter((k) => k.id !== l.id) }))}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      </div>
      <label className="f">
        Conectar con algo más
        <select
          id="dLink"
          value=""
          onChange={(e) => {
            const b = e.target.value;
            if (b) update((d) => ({ ...d, links: [...d.links, { id: newId(), a: item.id, b }] }));
          }}
        >
          <option value="">Elegí…</option>
          {candidates.map((o) => (
            <option key={o.id} value={o.id}>{TYPES[o.type]} · {o.title}</option>
          ))}
        </select>
      </label>
      <div className="row">
        {item.type === "proyecto" && space !== item.id && (
          <button className="btn main" type="button" onClick={onEnter}>Entrar al proyecto</button>
        )}
        {canFinish && (
          <button className="btn" type="button" onClick={() => patch({ done: !item.done })}>
            {item.done ? "Volver a pendiente" : item.type === "dinero" ? "Marcar saldada" : "Marcar hecha"}
          </button>
        )}
        <button className="btn warn" type="button" onClick={remove}>
          {!armed ? "Eliminar" : item.type === "proyecto" ? "¿Seguro? Borra todo lo de adentro" : "¿Seguro? Tocá de nuevo"}
        </button>
      </div>
    </aside>
  );
}
