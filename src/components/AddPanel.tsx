"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { guessType } from "@/lib/dates";
import { TYPES, TYPE_ORDER, newId, type HubData, type Item, type ItemType } from "@/lib/types";

interface Props {
  data: HubData;
  update: (fn: (d: HubData) => HubData) => void;
  space: string | null;
  visible: Item[];
  view: { x: number; y: number; k: number };
  onClose: () => void;
  onAdded: (i: Item) => void;
}

/** The "+" capture: write anything, it guesses the type, optionally link it to something. */
export default function AddPanel({ data, update, space, visible, view, onClose, onAdded }: Props) {
  const [text, setText] = useState("");
  const [type, setType] = useState<ItemType>("tarea");
  const [touched, setTouched] = useState(false);
  const [date, setDate] = useState("");
  const [linkTo, setLinkTo] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  const project = space ? data.items.find((i) => i.id === space) : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const title = text.trim();
    if (!title) return;
    const a = Math.random() * Math.PI * 2;
    const target = linkTo ? data.items.find((i) => i.id === linkTo) : undefined;
    let x: number, y: number;
    if (target) {
      x = target.x + Math.cos(a) * 190;
      y = target.y + Math.sin(a) * 130;
    } else {
      x = (window.innerWidth / 2 - view.x) / view.k + Math.cos(a) * 80;
      y = (window.innerHeight / 2 - view.y) / view.k + Math.sin(a) * 60;
    }
    // Projects always live in the main space.
    let parentId = space;
    if (type === "proyecto" && space) {
      parentId = null;
      x = Math.random() * 400 - 200;
      y = Math.random() * 300 - 150;
    }
    const item: Item = { id: newId(), type, title, parentId, date, x: Math.round(x), y: Math.round(y), done: false, area: "" };
    update((d) => ({
      items: [...d.items, item],
      links: target && parentId === space ? [...d.links, { id: newId(), a: item.id, b: target.id }] : d.links,
    }));
    onAdded(item);
  };

  return (
    <form id="addForm" className="panel" autoComplete="off" onSubmit={submit}>
      <button className="x" type="button" aria-label="Cerrar" onClick={onClose}>×</button>
      <h3>¿Qué tenés en la cabeza?</h3>
      <textarea
        ref={ref}
        id="addText"
        required
        placeholder="Ej: le debo $8.000 a Juli, entrevista el jueves, idea para el 10k…"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (!touched) setType(guessType(e.target.value));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <div className="types" role="radiogroup" aria-label="Tipo">
        {TYPE_ORDER.map((t) => (
          <label key={t} style={{ "--c": `var(--c-${t})` } as CSSProperties}>
            <input
              type="radio"
              name="addType"
              id={`at-${t}`}
              checked={type === t}
              onChange={() => {
                setType(t);
                setTouched(true);
              }}
            />
            <span>{TYPES[t]}</span>
          </label>
        ))}
      </div>
      <div className="row">
        <label className="f" style={{ flex: 1, minWidth: 130 }}>
          Fecha
          <input type="date" id="addDate" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="f" style={{ flex: 1.4, minWidth: 150 }}>
          Conectar con
          <select id="addLink" value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
            <option value="">Nada por ahora</option>
            {visible.map((i) => (
              <option key={i.id} value={i.id}>{TYPES[i.type]} · {i.title}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="note">
        {project
          ? `Se guarda adentro de «${project.title}».`
          : "Se guarda en el espacio principal. Si lo conectás a algo, aparece al lado."}
      </p>
      <button className="btn main" type="submit">Agregar al HUB</button>
    </form>
  );
}
