/**
 * Tiempos de viaje desde un punto de partida (casa) hasta cada centro.
 *
 * - Geocodificación: Nominatim (OpenStreetMap), limitada a la Comunidad de Madrid.
 * - Rutas: servicio "table" de OSRM (FOSSGIS / routing.openstreetmap.de), un origen
 *   contra muchos destinos por petición, en lotes para no saturar el servidor.
 * - Los datos se guardan SOLO en el navegador (localStorage): el punto de partida es
 *   un dato personal y no debe acabar en la base de datos pública ni en la URL.
 */

export type Modo = "car" | "bike" | "foot";

export const MODOS: Readonly<{ [m in Modo]: { txt: string; ico: string } }> = Object.freeze({
  car: { txt: "En coche (sin tráfico)", ico: "🚗" },
  bike: { txt: "En bicicleta", ico: "🚲" },
  foot: { txt: "A pie", ico: "🚶" },
});

export type Origen = {
  readonly lat: number;
  readonly lon: number;
  readonly txt: string;
};

/** [segundos, metros]; null si no hay ruta */
type Tiempo = [number | null, number | null];

type Store = {
  v: 1;
  origen: Origen | null;
  modo: Modo;
  fecha: { [m in Modo]?: string };
  tiempos: { [m in Modo]?: { [id: string]: Tiempo } };
};

export type ViajeCentro = {
  readonly segundos: number;
  readonly metros: number | null;
  readonly minutos: number;
};

export type Destino = { id: number; latitud: number; longitud: number };

const KEY = "centros.viaje.v1";
const LOTE = 100;
const PAUSA_MS = 1000;
const OSRM: { [m in Modo]: string[] } = {
  car: [
    "https://routing.openstreetmap.de/routed-car/table/v1/driving/",
    "https://router.project-osrm.org/table/v1/driving/",
  ],
  bike: ["https://routing.openstreetmap.de/routed-bike/table/v1/driving/"],
  foot: ["https://routing.openstreetmap.de/routed-foot/table/v1/driving/"],
};
// Caja que engloba la Comunidad de Madrid (lon,lat)
const VIEWBOX = "-4.6,41.2,-3.0,39.8";

function emptyStore(): Store {
  return { v: 1, origen: null, modo: "car", fecha: {}, tiempos: {} };
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return emptyStore();
    const s = JSON.parse(raw) as Store;
    if (s == null || s.v !== 1) return emptyStore();
    if (!(s.modo in MODOS)) s.modo = "car";
    s.fecha = s.fecha ?? {};
    s.tiempos = s.tiempos ?? {};
    return s;
  } catch {
    return emptyStore();
  }
}

function writeStore(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    console.warn("No se pudieron guardar los tiempos de viaje", e);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Cancelado", "AbortError"));
    });
  });

export function formatMinutos(min: number) {
  if (min < 1) return "< 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m == 0 ? `${h} h` : `${h} h ${m} min`;
}

export function formatKm(metros: number | null) {
  if (metros == null) return "";
  return (Math.round(metros / 100) / 10).toString().replace(".", ",") + " km";
}

export class Viaje {
  private static __instance: Viaje | null = null;
  private store: Store;
  private readonly listeners: (() => void)[] = [];

  private constructor() {
    this.store = readStore();
  }

  static get(): Viaje {
    if (Viaje.__instance == null) Viaje.__instance = new Viaje();
    return Viaje.__instance;
  }

  onChange(f: () => void) {
    this.listeners.push(f);
  }

  private changed() {
    writeStore(this.store);
    this.listeners.forEach((f) => f());
  }

  get origen() {
    return this.store.origen;
  }

  get modo() {
    return this.store.modo;
  }

  get fecha(): string | null {
    return this.store.fecha[this.store.modo] ?? null;
  }

  /** Cambiar el punto de partida invalida los tiempos calculados */
  setOrigen(o: Origen | null) {
    const old = this.store.origen;
    if (old != null && o != null && old.lat == o.lat && old.lon == o.lon) {
      if (old.txt != o.txt) {
        this.store.origen = o;
        this.changed();
      }
      return;
    }
    this.store.origen = o;
    this.store.tiempos = {};
    this.store.fecha = {};
    this.changed();
  }

  setModo(m: Modo) {
    if (this.store.modo == m || !(m in MODOS)) return;
    this.store.modo = m;
    this.changed();
  }

  borrar() {
    this.store = { ...emptyStore(), modo: this.store.modo };
    this.changed();
  }

  private get tabla() {
    return this.store.tiempos[this.store.modo] ?? {};
  }

  /** Tiempo hasta un centro con el modo actual (null si no se ha calculado o no hay ruta) */
  getCentro(id: number): ViajeCentro | null {
    const t = this.tabla[id.toString()];
    if (t == null || t[0] == null) return null;
    return { segundos: t[0], metros: t[1], minutos: Math.round(t[0] / 60) };
  }

  /** ¿Se ha intentado calcular este centro (aunque no tenga ruta)? */
  isCalculado(id: number) {
    return this.tabla[id.toString()] != null;
  }

  count() {
    return Object.keys(this.tabla).length;
  }

  pendientes(destinos: readonly Destino[]) {
    return destinos.filter((d) => !this.isCalculado(d.id) && d.latitud != 0);
  }

  /**
   * Calcula los tiempos de los centros que falten, en lotes.
   * Guarda tras cada lote, de modo que lo ya calculado no se pierde si se cancela o falla.
   */
  async calcular(
    destinos: readonly Destino[],
    onProgress: (hechos: number, total: number) => void,
    signal?: AbortSignal
  ) {
    const origen = this.store.origen;
    if (origen == null) throw new Error("Falta el punto de partida");
    const modo = this.store.modo;
    const pend = this.pendientes(destinos);
    onProgress(0, pend.length);
    for (let i = 0; i < pend.length; i += LOTE) {
      if (signal?.aborted) throw new DOMException("Cancelado", "AbortError");
      const lote = pend.slice(i, i + LOTE);
      const res = await this.tabla_osrm(modo, origen, lote, signal);
      // Si mientras tanto ha cambiado el origen o el modo, se descarta el resultado
      const now = this.store.origen;
      if (now == null || now.lat != origen.lat || now.lon != origen.lon || this.store.modo !== modo) {
        throw new DOMException("Cancelado", "AbortError");
      }
      const tabla = (this.store.tiempos[modo] = this.store.tiempos[modo] ?? {});
      lote.forEach((d, j) => (tabla[d.id.toString()] = res[j]));
      this.store.fecha[modo] = new Date().toISOString();
      this.changed();
      onProgress(Math.min(i + LOTE, pend.length), pend.length);
      if (i + LOTE < pend.length) await sleep(PAUSA_MS, signal);
    }
  }

  private async tabla_osrm(modo: Modo, o: Origen, lote: Destino[], signal?: AbortSignal): Promise<Tiempo[]> {
    const coords = [[o.lon, o.lat], ...lote.map((d) => [d.longitud, d.latitud])]
      .map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`)
      .join(";");
    let error: unknown = null;
    for (const base of OSRM[modo]) {
      try {
        const r = await fetch(`${base}${coords}?sources=0&annotations=duration,distance`, { signal });
        if (!r.ok) throw new Error(`${base}: HTTP ${r.status}`);
        const j = await r.json();
        if (j.code != "Ok") throw new Error(`${base}: ${j.code} ${j.message ?? ""}`);
        const dur: (number | null)[] = j.durations[0].slice(1);
        const dis: (number | null)[] = (j.distances?.[0] ?? []).slice(1);
        return lote.map((_, k) => [
          dur[k] == null ? null : Math.round(dur[k]!),
          dis[k] == null ? null : Math.round(dis[k]!),
        ]);
      } catch (e) {
        if ((e as Error).name == "AbortError") throw e;
        console.warn(e);
        error = e;
      }
    }
    throw error;
  }
}

/** Busca una dirección dentro de la Comunidad de Madrid */
export async function geocodificar(q: string): Promise<Origen[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "es");
  url.searchParams.set("viewbox", VIEWBOX);
  url.searchParams.set("bounded", "1");
  url.searchParams.set("accept-language", "es");
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`Nominatim: HTTP ${r.status}`);
  const arr = (await r.json()) as { lat: string; lon: string; display_name: string }[];
  return arr.map((x) => ({
    lat: Number(x.lat),
    lon: Number(x.lon),
    // Quita "Comunidad de Madrid, España" del final
    txt: x.display_name.replace(/,\s*Comunidad de Madrid.*$/, ""),
  }));
}
