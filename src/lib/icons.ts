/**
 * Iconos SVG (Lucide) como texto, para usarlos tanto en las plantillas
 * (se renderizan en tiempo de build) como en el HTML generado desde TS.
 * Solo se importan los iconos usados, para no inflar el bundle.
 */
import {
  Info, SlidersHorizontal, TrainFront, House, Mail, ListOrdered, Download, CircleHelp,
  ArrowLeft, ChevronLeft, Copy, X, MapPin, Search, Users, Flame, Moon, Star, Plus,
  LocateFixed, Heart, Clock, ExternalLink, Phone, Globe, TriangleAlert, FileDown,
  Layers, Building2, Route, Languages, Sparkles, Cpu, GraduationCap, Briefcase,
  Accessibility, ArrowRight, Map as MapIcon, CircleCheck, CircleX, Circle, ChevronUp,
  ChevronDown, Trash2, Scale, BookOpen, Lightbulb, Send, Database,
} from "lucide";

type IconNode = [string, Record<string, string | number>][];

const ICONS: Record<string, IconNode> = {
  info: Info, filtros: SlidersHorizontal, tren: TrainFront, casa: House, mail: Mail,
  lista: ListOrdered, descarga: Download, ayuda: CircleHelp, atras: ArrowLeft,
  cerrar: ChevronLeft, copiar: Copy, x: X, pin: MapPin, buscar: Search, alumnos: Users,
  dificultad: Flame, nocturno: Moon, estrella: Star, mas: Plus, gps: LocateFixed,
  corazon: Heart, reloj: Clock, externo: ExternalLink, telefono: Phone, web: Globe,
  aviso: TriangleAlert, csv: FileDown, capas: Layers, centro: Building2, ruta: Route,
  idioma: Languages, excelencia: Sparkles, tecnologia: Cpu, eso: GraduationCap,
  fp: Briefcase, accesible: Accessibility, flecha: ArrowRight, mapa: MapIcon,
  ok: CircleCheck, ko: CircleX, nada: Circle, arriba: ChevronUp, abajo: ChevronDown,
  borrar: Trash2, licencia: Scale, libro: BookOpen, idea: Lightbulb, enviar: Send,
  bd: Database,
} as unknown as Record<string, IconNode>;

// Marca de GitHub (Lucide ya no incluye logotipos de marcas)
const GITHUB =
  '<path fill="currentColor" stroke="none" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/>';

function attrs(a: Record<string, string | number>) {
  return Object.entries(a).map(([k, v]) => `${k}="${v}"`).join(" ");
}

export function icon(name: string, cls = "h-4 w-4") {
  const body = name == "github"
    ? GITHUB
    : (ICONS[name] ?? []).map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join("");
  if (body.length == 0) console.warn(`icono desconocido: ${name}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="lucide ${cls}">${body}</svg>`;
}

/* ---------------- Marcadores del mapa ---------------- */

export const PIN_COLOR: Readonly<Record<string, string>> = Object.freeze({
  green: "#059669",
  red: "#dc2626",
  blue: "#4f46e5",
});

/**
 * Chincheta SVG como data URL.
 * - especial: punto oscuro en el centro (bilingüe, excelencia, innovación…)
 * - seleccionado: estrella blanca y borde del color de la marca
 */
export function pinUrl(color: string, especial: boolean, seleccionado: boolean) {
  const fill = PIN_COLOR[color] ?? color;
  const stroke = seleccionado ? "#c8102e" : "#ffffff";
  const inner = seleccionado
    ? '<path d="M14 7.2l1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="#fff"/>'
    : especial
      ? '<circle cx="14" cy="13.5" r="5.5" fill="#fff"/><circle cx="14" cy="13.5" r="2.6" fill="#0f172a"/>'
      : '<circle cx="14" cy="13.5" r="4.5" fill="#fff"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36"><path d="M14 1C7 1 1.5 6.4 1.5 13.3 1.5 22.6 14 35 14 35s12.5-12.4 12.5-21.7C26.5 6.4 21 1 14 1z" fill="${fill}" stroke="${stroke}" stroke-width="${seleccionado ? 2.5 : 2}"/>${inner}</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
