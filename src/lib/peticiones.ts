/**
 * Peticiones de la solicitud de destinos, tal como las admite la Comunidad de Madrid:
 *  - c: un centro concreto (código de centro)
 *  - l: una localidad, o un distrito en Madrid capital (comprende todos sus centros)
 *  - d: una Dirección de Área Territorial (comprende todos sus centros)
 * Cada petición lleva los tipos de puesto que se solicitan en ella.
 */
export type PeticionTipo = "c" | "l" | "d";

export interface Peticion {
  readonly t: PeticionTipo;
  /** código de centro, código de localidad/distrito o letra de la DAT */
  readonly id: string;
  readonly puestos: readonly string[];
}

export const MAX_PETICIONES = 200;

export const PUESTOS: Readonly<{ [k: string]: string }> = Object.freeze({
  "01": "Jornada completa en la especialidad",
  "02": "Jornada completa compartiendo con especialidad afín",
  "03": "Jornada completa compartiendo centros",
  "04": "Jornada parcial (voluntario)",
  "05": "Itinerante (voluntario)",
  "06": "Protección de menores, penitenciarias, UFIL y ACE (voluntario, solo por centro)",
  "07": "Aulas hospitalarias, SAED y centros terapéuticos (voluntario)",
});

export const PUESTOS_DEFECTO: readonly string[] = Object.freeze(["01"]);

export const DAT: Readonly<{ [k: string]: string }> = Object.freeze({
  C: "Madrid-Capital",
  N: "Madrid-Norte",
  S: "Madrid-Sur",
  E: "Madrid-Este",
  O: "Madrid-Oeste",
});

const DELTA = 28000000;

export function samePeticion(a: Peticion, b: Peticion) {
  return a.t == b.t && a.id == b.id;
}

/** true si todos los puestos de `b` están en `a` */
export function incluyePuestos(a: Peticion, b: Peticion) {
  return b.puestos.every((p) => a.puestos.includes(p));
}

function encodeOne(p: Peticion) {
  const id = (() => {
    if (p.t == "c") return (Number(p.id) - DELTA).toString(36);
    if (p.t == "l") return Number(p.id).toString(36);
    return p.id;
  })();
  // "01" -> "1", ..., "07" -> "7"
  const puestos = p.puestos.map((x) => Number(x).toString()).join("");
  return `${p.t}${id}.${puestos}`;
}

function decodeOne(s: string): Peticion | null {
  const m = s.match(/^([cld])([0-9a-z]+)\.([1-7]*)$/i);
  if (m == null) return null;
  const t = m[1].toLowerCase() as PeticionTipo;
  let id: string;
  if (t == "c") id = (parseInt(m[2], 36) + DELTA).toString();
  else if (t == "l") id = parseInt(m[2], 36).toString();
  else id = m[2].toUpperCase();
  if (t == "d" && DAT[id] == null) return null;
  if (t != "d" && isNaN(Number(id))) return null;
  const puestos = Array.from(new Set(m[3].split(""))).sort().map((x) => "0" + x);
  return { t, id, puestos };
}

export function encodePeticiones(arr: readonly Peticion[]) {
  return arr.map(encodeOne).join(",");
}

export function decodePeticiones(s: string | null): Peticion[] {
  if (s == null) return [];
  return s.split(",").flatMap((x) => {
    const p = decodeOne(x.trim());
    return p == null ? [] : [p];
  });
}
