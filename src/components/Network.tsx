"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as RPointerEvent } from "react";
import { dayOff, fmtDate } from "@/lib/dates";
import { TYPES, TYPE_ORDER, type HubData, type Item, type ItemType } from "@/lib/types";
import AddPanel from "./AddPanel";
import DetailPanel from "./DetailPanel";
import Header from "./Header";
import MailBox from "./MailBox";
import { newId } from "@/lib/types";
import type { Account } from "@/lib/useHub";
import type { SyncStatus } from "@/lib/store";

type View = { x: number; y: number; k: number };
type Drag = {
  sx: number; sy: number; moved: boolean; id: string | null; core: boolean; widget?: boolean;
  ox: number; oy: number; vx: number; vy: number;
};

export interface NetworkProps {
  data: HubData;
  update: (fn: (d: HubData) => HubData) => void;
  account: Account | null;
  status: SyncStatus;
  cloudEnabled: boolean;
  signIn: (email: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  reset: () => void;
}

const cssVar = (t: ItemType) => ({ "--c": `var(--c-${t})` }) as CSSProperties;
const clampK = (k: number) => Math.min(2.2, Math.max(0.25, k));

function curve(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const mx = (a.x + b.x) / 2 - dy * 0.16, my = (a.y + b.y) / 2 + dx * 0.16;
  return `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}`;
}

export default function Network(props: NetworkProps) {
  const { data, update } = props;
  const [space, setSpace] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<ItemType>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [hint, setHint] = useState(true);
  const [enterKey, setEnterKey] = useState(0);
  const [born, setBorn] = useState<string | null>(null);
  const MAIL_KEY = "hub-mailbox-pos";
  const [mailPos, setMailPos] = useState<{ x: number; y: number }>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(MAIL_KEY) ?? "null");
      if (p && typeof p.x === "number") return p;
    } catch {}
    return { x: 0, y: 0 };
  });
  const [mailDragging, setMailDragging] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const views = useRef<Record<string, View>>({});
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const pendingFocus = useRef<string | null>(null);
  const tmIdx = useRef(0);

  const { today, tomorrow } = useMemo(() => ({ today: dayOff(0), tomorrow: dayOff(1) }), []);
  const byId = useMemo(() => new Map(data.items.map((i) => [i.id, i])), [data.items]);
  const isTom = useCallback((i: Item) => i.date === tomorrow && !i.done, [tomorrow]);
  const isDue = useCallback(
    (i: Item) => !!i.date && i.date <= today && !i.done && i.type !== "proyecto" && i.type !== "habito",
    [today],
  );

  // A project that was deleted while we were inside it: go back to the main space.
  useEffect(() => {
    if (space && !byId.has(space)) setSpace(null);
    if (selected && !byId.has(selected)) setSelected(null);
  }, [byId, space, selected]);

  const visible = useMemo(
    () => data.items.filter((i) => i.parentId === space && !hidden.has(i.type)),
    [data.items, space, hidden],
  );

  /* ---------- view (pan / zoom) ---------- */
  const applyView = useCallback(() => {
    const v = view.current;
    if (worldRef.current) worldRef.current.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.k})`;
    if (stageRef.current) {
      stageRef.current.style.backgroundPosition = `${v.x}px ${v.y}px`;
      stageRef.current.style.backgroundSize = `${32 * v.k}px ${32 * v.k}px`;
    }
  }, []);

  const fitView = useCallback(
    (sp: string | null): View => {
      const pts = data.items.filter((i) => i.parentId === sp).map((i) => ({ x: i.x, y: i.y }));
      if (sp || !pts.length) pts.push({ x: 0, y: 0 });
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x0 = Math.min(...xs) - 130, x1 = Math.max(...xs) + 130;
      const y0 = Math.min(...ys) - 70, y1 = Math.max(...ys) + 70;
      const w = window.innerWidth, h = window.innerHeight;
      // On a phone, stay readable and let the person pan instead of shrinking everything.
      const k = clampK(Math.max(w < 640 ? 0.55 : 0, Math.min(1, (w - 40) / (x1 - x0), (h - 170) / (y1 - y0))));
      return { k, x: w / 2 - ((x0 + x1) / 2) * k, y: (h + 20) / 2 - ((y0 + y1) / 2) * k };
    },
    [data.items],
  );

  const centerOn = useCallback(
    (i: Item) => {
      const w = worldRef.current;
      w?.classList.add("glide");
      const v = view.current;
      v.x = window.innerWidth / 2 - i.x * v.k;
      v.y = window.innerHeight / 2 - i.y * v.k + (window.innerWidth < 640 ? -120 : 0);
      applyView();
      setTimeout(() => w?.classList.remove("glide"), 520);
    },
    [applyView],
  );

  useLayoutEffect(() => {
    const key = space ?? "root";
    views.current[key] ??= fitView(space);
    view.current = views.current[key];
    applyView();
    const f = pendingFocus.current;
    if (f) {
      pendingFocus.current = null;
      const i = byId.get(f);
      if (i) {
        centerOn(i);
        setSelected(i.id);
      }
    }
    // Only when the space changes; data edits keep the current view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, enterKey]);

  const go = useCallback((id: string | null, focusId?: string) => {
    pendingFocus.current = focusId ?? null;
    setSelected(null);
    setAddOpen(false);
    setSpace(id);
    setEnterKey((k) => k + 1);
  }, []);

  const focusItem = useCallback(
    (i: Item) => {
      if (i.parentId !== space) go(i.parentId, i.id);
      else {
        centerOn(i);
        setSelected(i.id);
      }
    },
    [space, go, centerOn],
  );

  const zoomAt = useCallback(
    (cx: number, cy: number, k: number) => {
      const v = view.current;
      k = clampK(k);
      const px = (cx - v.x) / v.k, py = (cy - v.y) / v.k;
      v.k = k;
      v.x = cx - px * k;
      v.y = cy - py * k;
      applyView();
    },
    [applyView],
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setHint(false);
      zoomAt(e.clientX, e.clientY, view.current.k * Math.exp(-e.deltaY * 0.0015));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (addOpen) setAddOpen(false);
      else if (selected) setSelected(null);
      else if (space) go(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addOpen, selected, space, go]);

  /* ---------- pointer: pan, drag, pinch, tap ---------- */
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<Drag | null>(null);
  const pinch = useRef<{ d: number; k: number } | null>(null);
  const lastTap = useRef<{ id?: string; t: number }>({ t: 0 });
  const [panning, setPanning] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return;
    const target = e.target as HTMLElement;
    // Links and buttons inside the mail box work as normal controls.
    if (target.closest("[data-widget] a, [data-widget] button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.current.k };
      drag.current = null;
      return;
    }
    if (target.closest("[data-widget]")) {
      drag.current = { sx: e.clientX, sy: e.clientY, moved: false, id: null, core: false, widget: true,
        ox: mailPos.x, oy: mailPos.y, vx: view.current.x, vy: view.current.y };
      return;
    }
    const ne = target.closest<HTMLElement>("[data-id]");
    const id = ne?.dataset.id ?? null;
    const core = ne?.dataset.core === "1";
    const it = id && !core ? byId.get(id) : undefined;
    drag.current = {
      sx: e.clientX, sy: e.clientY, moved: false, id, core,
      ox: it?.x ?? 0, oy: it?.y ?? 0, vx: view.current.x, vy: view.current.y,
    };
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!ptrs.current.has(e.pointerId)) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.current.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.current.d);
      setHint(false);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) > 4) {
      d.moved = true;
      setHint(false);
      if (d.widget) setMailDragging(true);
      else if (d.id && !d.core) setDragging(d.id);
      else setPanning(true);
    }
    if (!d.moved) return;
    if (d.widget) {
      setMailPos({ x: Math.round(d.ox + dx / view.current.k), y: Math.round(d.oy + dy / view.current.k) });
    } else if (d.id && !d.core) {
      const x = Math.round(d.ox + dx / view.current.k), y = Math.round(d.oy + dy / view.current.k);
      const id = d.id;
      update((h) => ({ ...h, items: h.items.map((i) => (i.id === id ? { ...i, x, y } : i)) }));
    } else {
      view.current.x = d.vx + dx;
      view.current.y = d.vy + dy;
      applyView();
    }
  };

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    ptrs.current.delete(e.pointerId);
    if (pinch.current) {
      if (ptrs.current.size < 2) pinch.current = null;
      drag.current = null;
      return;
    }
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    setDragging(null);
    if (d?.widget) {
      setMailDragging(false);
      if (d.moved) setMailPos((p) => {
        try { localStorage.setItem(MAIL_KEY, JSON.stringify(p)); } catch {}
        return p;
      });
      return;
    }
    if (!d || d.moved) return;
    if (!d.id) {
      setSelected(null);
      setAddOpen(false);
      return;
    }
    const now = Date.now();
    const it = byId.get(d.id);
    if (!d.core && it?.type === "proyecto" && lastTap.current.id === d.id && now - lastTap.current.t < 400) {
      lastTap.current = { t: 0 };
      go(d.id);
      return;
    }
    lastTap.current = { id: d.id, t: now };
    setAddOpen(false);
    setSelected(d.id);
  };

  /* ---------- links ---------- */
  const paths = useMemo(() => {
    const vis = new Set(visible.map((i) => i.id));
    const pos = (id: string) => (space && id === space ? { x: 0, y: 0 } : byId.get(id));
    const out: { key: string; d: string; color: ItemType; on: boolean; faint?: boolean }[] = [];
    const hasPeer = (id: string) => data.links.some(({ a, b }) => (a === id && vis.has(b)) || (b === id && vis.has(a)));
    if (space) {
      for (const i of visible) {
        // Every child keeps a tie to the project core; loose ones get a visible synapse.
        out.push({ key: `core-${i.id}`, d: curve({ x: 0, y: 0 }, i), color: "proyecto", on: selected === i.id, faint: hasPeer(i.id) });
      }
    }
    for (const l of data.links) {
      if (!vis.has(l.a) || !vis.has(l.b)) continue;
      const a = pos(l.a)!, b = pos(l.b)!;
      out.push({ key: l.id, d: curve(a, b), color: byId.get(l.a)!.type, on: !!selected && (selected === l.a || selected === l.b) });
    }
    return out;
  }, [visible, data.links, byId, space, selected]);

  const ringR = useMemo(
    () => (space ? Math.max(150, ...visible.map((i) => Math.hypot(i.x, i.y) + 150)) : 0),
    [space, visible],
  );

  /* ---------- actions ---------- */
  const tomorrowItems = data.items.filter(isTom);
  const nextTomorrow = () => {
    if (!tomorrowItems.length) return;
    focusItem(tomorrowItems[tmIdx.current++ % tomorrowItems.length]);
  };

  const onAdded = (i: Item) => {
    setHidden((h) => {
      if (!h.has(i.type)) return h;
      const n = new Set(h);
      n.delete(i.type);
      return n;
    });
    setAddOpen(false);
    setBorn(i.id);
    setTimeout(() => setBorn(null), 700);
    if (i.parentId !== space) go(i.parentId, i.id);
    else setSelected(i.id);
  };

  const project = space ? byId.get(space) : undefined;
  const sel = selected ? byId.get(selected) : undefined;

  const renderNode = (i: Item, core = false) => {
    const kids = i.type === "proyecto" && !core ? data.items.filter((c) => c.parentId === i.id) : [];
    const cls = [
      "node", i.type, core && "core", isTom(i) && "manana", i.done && "done", selected === i.id && "sel",
      kids.some(isTom) && "has-manana", dragging === i.id && "dragging", born === i.id && "born",
    ].filter(Boolean).join(" ");
    return (
      <div
        key={core ? `core-${i.id}` : i.id}
        className={cls}
        data-id={i.id}
        data-core={core ? "1" : undefined}
        style={{ ...cssVar(i.type), left: core ? 0 : i.x, top: core ? 0 : i.y }}
      >
        <div className="k">{TYPES[i.type]}{i.area ? ` · ${i.area}` : ""}</div>
        <div className="t">{i.title || "Sin título"}</div>
        {i.date && <div className="d">{fmtDate(i.date)}</div>}
        {i.type === "proyecto" && !core && (
          <>
            <div className="d">{kids.length} {kids.length === 1 ? "cosa" : "cosas"} adentro</div>
            <div className="enter">Entrar →</div>
          </>
        )}
        {isTom(i) ? <span className="flag">Mañana</span> : isDue(i) ? <span className="flag hoy">Hoy</span> : null}
      </div>
    );
  };

  return (
    <>
      <div
        ref={stageRef}
        id="stage"
        className={panning ? "panning" : undefined}
        aria-label="Espacio del HUB"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div ref={worldRef} id="world" key={enterKey} className="enter">
          <svg id="links" aria-hidden="true">
            {space && <circle className="ring" cx={0} cy={0} r={ringR} style={{ stroke: "var(--c-proyecto)" }} />}
            {paths.map((p) => (
              <g key={p.key}>
                <path className={`ln${p.on ? " on" : ""}`} d={p.d} style={{ stroke: `var(--c-${p.color})`, opacity: p.faint && !p.on ? 0.12 : undefined }} />
                {!p.faint && <path className={`pulse${p.on ? " on" : ""}`} d={p.d} style={{ stroke: `var(--c-${p.color})` }} />}
              </g>
            ))}
          </svg>
          {!space && props.account && (
            <MailBox
              x={mailPos.x}
              y={mailPos.y}
              dragging={mailDragging}
              onToTask={(title) => {
                const a = Math.random() * Math.PI * 2;
                const item: Item = {
                  id: newId(), type: "tarea", title, parentId: null, date: "", done: false, area: "",
                  x: Math.round(mailPos.x + Math.cos(a) * 320), y: Math.round(mailPos.y + Math.sin(a) * 260),
                };
                update((d) => ({ ...d, items: [...d.items, item] }));
                onAdded(item);
              }}
            />
          )}
          {project && renderNode(project, true)}
          {visible.map((i) => renderNode(i))}
        </div>
      </div>

      <Header
        project={project}
        onHome={() => go(null)}
        tomorrowCount={tomorrowItems.length}
        onTomorrow={nextTomorrow}
        account={props.account}
        status={props.status}
        cloudEnabled={props.cloudEnabled}
        signIn={props.signIn}
        signOut={props.signOut}
        onReset={() => {
          views.current = {};
          props.reset();
          go(null);
        }}
      />

      <div id="legend" aria-label="Mostrar u ocultar tipos">
        {TYPE_ORDER.map((t) => (
          <button
            key={t}
            type="button"
            style={cssVar(t)}
            aria-pressed={!hidden.has(t)}
            onClick={() =>
              setHidden((h) => {
                const n = new Set(h);
                if (n.has(t)) n.delete(t);
                else n.add(t);
                return n;
              })
            }
          >
            <i />
            {TYPES[t]}
          </button>
        ))}
      </div>

      <div id="hint" style={{ opacity: hint ? 1 : 0 }}>
        Arrastrá el fondo para moverte · rueda o pellizco para zoom · doble toque en un proyecto para entrar
      </div>

      <button
        id="addBtn"
        type="button"
        aria-label="Agregar algo"
        onClick={() => {
          setSelected(null);
          setAddOpen((o) => !o);
        }}
      >
        +
      </button>

      {addOpen && (
        <AddPanel
          data={data}
          update={update}
          space={space}
          visible={visible}
          view={view.current}
          onClose={() => setAddOpen(false)}
          onAdded={onAdded}
        />
      )}

      {sel && (
        <DetailPanel
          key={sel.id}
          item={sel}
          data={data}
          update={update}
          space={space}
          onClose={() => setSelected(null)}
          onEnter={() => go(sel.id)}
          onJump={focusItem}
          onDeleted={() => setSelected(null)}
        />
      )}
    </>
  );
}
