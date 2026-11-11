import type { SupabaseClient } from "@supabase/supabase-js";
import type { HubData, Item, Link } from "./types";

export type SyncStatus = "local" | "synced" | "saving" | "error";

export interface Store {
  kind: "local" | "cloud";
  load(): Promise<HubData | null>;
  save(data: HubData): void;
}

const LOCAL_KEY = "hub-data-v1";

export function readLocal(): HubData | null {
  try {
    const d = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "null");
    return d && Array.isArray(d.items) && Array.isArray(d.links) ? d : null;
  } catch {
    return null;
  }
}

/** Keeps everything in this browser's localStorage. */
export class LocalStore implements Store {
  kind = "local" as const;
  private timer: ReturnType<typeof setTimeout> | undefined;
  async load() {
    return readLocal();
  }
  save(data: HubData) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
      } catch {
        /* storage full or blocked: nothing else to do */
      }
    }, 250);
  }
}

type ItemRow = {
  id: string; user_id: string; type: Item["type"]; title: string; parent_id: string | null;
  date: string | null; x: number; y: number; done: boolean; area: string;
};
type LinkRow = { id: string; user_id: string; a: string; b: string };

const toItemRow = (i: Item, user_id: string): ItemRow => ({
  id: i.id, user_id, type: i.type, title: i.title, parent_id: i.parentId, date: i.date || null,
  x: Math.round(i.x), y: Math.round(i.y), done: i.done, area: i.area,
});
const fromItemRow = (r: ItemRow): Item => ({
  id: r.id, type: r.type, title: r.title, parentId: r.parent_id, date: r.date ?? "",
  x: r.x, y: r.y, done: r.done, area: r.area ?? "",
});

/**
 * Saves to Supabase. Each save diffs against the last state the server has,
 * then upserts what changed and deletes what is gone.
 */
export class CloudStore implements Store {
  kind = "cloud" as const;
  private last = { items: new Map<string, string>(), links: new Map<string, string>() };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: HubData | null = null;
  private running = false;

  constructor(private sb: SupabaseClient, private userId: string, private onStatus: (s: SyncStatus) => void) {}

  async load(): Promise<HubData | null> {
    const [items, links] = await Promise.all([
      this.sb.from("items").select("*"),
      this.sb.from("links").select("*"),
    ]);
    if (items.error) throw items.error;
    if (links.error) throw links.error;
    const data: HubData = {
      items: (items.data as ItemRow[]).map(fromItemRow),
      links: (links.data as LinkRow[]).map(({ id, a, b }) => ({ id, a, b })),
    };
    this.remember(data);
    return data.items.length ? data : null;
  }

  save(data: HubData) {
    this.pending = data;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 600);
  }

  private remember(d: HubData) {
    this.last.items = new Map(d.items.map((i) => [i.id, JSON.stringify(toItemRow(i, this.userId))]));
    this.last.links = new Map(d.links.map((l) => [l.id, `${l.a}|${l.b}`]));
  }

  private async flush() {
    if (this.running || !this.pending) return;
    this.running = true;
    const data = this.pending;
    this.pending = null;
    this.onStatus("saving");
    try {
      const itemRows = data.items.map((i) => toItemRow(i, this.userId));
      const changedItems = itemRows.filter((r) => this.last.items.get(r.id) !== JSON.stringify(r));
      const goneItems = [...this.last.items.keys()].filter((id) => !data.items.some((i) => i.id === id));
      const changedLinks = data.links.filter((l: Link) => this.last.links.get(l.id) !== `${l.a}|${l.b}`);
      const goneLinks = [...this.last.links.keys()].filter((id) => !data.links.some((l) => l.id === id));

      // Parents first so a child's parent_id always points at an existing row.
      changedItems.sort((a, b) => Number(a.parent_id !== null) - Number(b.parent_id !== null));
      if (goneLinks.length) await this.check(this.sb.from("links").delete().in("id", goneLinks));
      if (changedItems.length) await this.check(this.sb.from("items").upsert(changedItems));
      if (changedLinks.length)
        await this.check(this.sb.from("links").upsert(changedLinks.map((l) => ({ ...l, user_id: this.userId }))));
      if (goneItems.length) await this.check(this.sb.from("items").delete().in("id", goneItems));
      this.remember(data);
      this.onStatus(this.pending ? "saving" : "synced");
    } catch (e) {
      console.error("HUB: no se pudo guardar en la nube", e);
      this.pending ??= data;
      this.onStatus("error");
    } finally {
      this.running = false;
      if (this.pending) this.timer = setTimeout(() => void this.flush(), 2000);
    }
  }

  private async check(q: PromiseLike<{ error: unknown }>) {
    const { error } = await q;
    if (error) throw error;
  }
}
