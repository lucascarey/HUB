import { dayOff } from "./dates";
import { newId, type HubData, type Item, type ItemType } from "./types";

/** Example content shown the first time the HUB opens. */
export function makeSeed(): HubData {
  const ids: Record<string, string> = {};
  const id = (k: string) => (ids[k] ??= newId());
  const N = (k: string, type: ItemType, title: string, parent: string | null, x: number, y: number, extra: Partial<Item> = {}): Item => ({
    id: id(k), type, title, parentId: parent ? id(parent) : null, x, y, date: "", done: false, area: "", ...extra,
  });
  const tomorrow = dayOff(1);
  const items: Item[] = [
    N("p1", "proyecto", "Correr 10k", null, -300, -40, { area: "Deporte" }),
    N("p2", "proyecto", "HUB", null, 280, -150, { area: "Proyectos" }),
    N("p3", "proyecto", "Facultad", null, 30, 230, { area: "Estudio" }),
    N("t1", "tarea", "Mandar CV a la consultora", null, 470, 120, { date: tomorrow, area: "Trabajo" }),
    N("e1", "evento", "Entrevista laboral", null, 560, -40, { date: dayOff(3), area: "Trabajo" }),
    N("m1", "dinero", "Le debo $15.000 a Martín", null, -470, 210),
    N("m2", "dinero", "Cartera Balanz", null, -560, -230, { area: "Inversiones" }),
    N("i1", "idea", "Podcast sobre inversiones", null, -300, -330),
    N("h1", "habito", "Leer 20 min por día", null, 60, -330, { area: "Estudio" }),
    N("c1", "tarea", "Comprar zapatillas", "p1", -230, -150, { date: dayOff(5) }),
    N("c2", "habito", "Correr 3 veces por semana", "p1", 240, -120),
    N("c3", "evento", "Intervalos 6×400 m", "p1", 250, 140, { date: dayOff(2) }),
    N("c4", "idea", "Probar app de ritmo", "p1", -240, 160),
    N("c5", "tarea", "Definir áreas del HUB", "p2", -250, -110, { date: tomorrow }),
    N("c6", "tarea", "Prototipo de la red", "p2", 230, -150, { done: true }),
    N("c7", "idea", "Que Claude ordene la bandeja", "p2", 250, 140),
    N("c8", "tarea", "Crear el repo en GitHub", "p2", -220, 170, { done: true }),
    N("c9", "evento", "Parcial de Estadística", "p3", -220, -140, { date: dayOff(9) }),
    N("c10", "tarea", "Resumen unidad 3", "p3", 240, -100, { date: dayOff(4) }),
    N("c11", "idea", "Armar grupo de estudio", "p3", 40, 200),
  ];
  const pairs = [
    ["t1", "e1"], ["m2", "i1"], ["h1", "p3"], ["p2", "h1"], ["m1", "p1"], ["i1", "p2"], ["e1", "p2"],
    ["c1", "c3"], ["c2", "c3"], ["c4", "c2"], ["c5", "c8"], ["c6", "c7"], ["c9", "c10"], ["c10", "c11"],
  ];
  return { items, links: pairs.map(([a, b]) => ({ id: newId(), a: id(a), b: id(b) })) };
}
