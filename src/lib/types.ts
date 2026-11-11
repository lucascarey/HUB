export type ItemType = "proyecto" | "tarea" | "evento" | "idea" | "dinero" | "habito";

export const TYPES: Record<ItemType, string> = {
  proyecto: "Proyecto",
  tarea: "Tarea",
  evento: "Evento",
  idea: "Idea",
  dinero: "Plata",
  habito: "Hábito",
};

export const TYPE_ORDER = Object.keys(TYPES) as ItemType[];

/** Anything that lives in the HUB: a project, a task, an idea, a debt… */
export interface Item {
  id: string;
  type: ItemType;
  title: string;
  /** Project this item lives inside, or null for the main space. */
  parentId: string | null;
  /** YYYY-MM-DD or "" */
  date: string;
  x: number;
  y: number;
  done: boolean;
  area: string;
}

/** An undirected connection between two items. */
export interface Link {
  id: string;
  a: string;
  b: string;
}

export interface HubData {
  items: Item[];
  links: Link[];
}

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
