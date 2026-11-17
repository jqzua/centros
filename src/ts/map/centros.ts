import * as L from "leaflet";
import { SBMap } from "../../mapsidebar/leaflet-sidebar";
import { DBConcurso, Centro } from "../../lib/dbconcurso";
import { set_transpo_layer } from "./transporte"
import { set_area_layer } from './areas'
import { State } from "../../lib/state";
import {
  Peticion,
  PUESTOS,
  DAT,
  MAX_PETICIONES,
  incluyePuestos,
} from "../../lib/peticiones";
import { getLocalidad } from "../../lib/dbconcurso";
import { Viaje, MODOS, formatMinutos, formatKm } from "../../lib/viaje";
import { initViaje } from "./viaje";
import { icon, pinUrl, PIN_COLOR } from "../../lib/icons";

const VIAJE = Viaje.get();
let viajeUI: { refresh: () => void } | undefined;

/** "25 min" para un centro, o null si no hay tiempo calculado */
function viajeTxt(c: Centro, conKm = false) {
  const t = VIAJE.getCentro(c.id);
  if (t == null) return null;
  const km = conKm && t.metros != null ? ` · ${formatKm(t.metros)}` : "";
  return `${MODOS[VIAJE.modo].ico} ${formatMinutos(t.minutos)}${km}`;
}

/** Rango de tiempos de un grupo de centros, p.e. "🚗 20 min – 45 min" */
function viajeRango(centros: Centro[]) {
  const mins = centros.flatMap((c) => VIAJE.getCentro(c.id)?.minutos ?? []);
  if (mins.length == 0) return null;
  const mn = Math.min(...mins), mx = Math.max(...mins);
  const r = mn == mx ? formatMinutos(mn) : `${formatMinutos(mn)} – ${formatMinutos(mx)}`;
  return `${MODOS[VIAJE.modo].ico} ${r}`;
}

import {
  getVal,
  Mail,
  dateToString,
  dedent,
  get_distance,
} from "../../lib/util";

const DONAR = import.meta.env.VITE_DONAR;
const id_concurso = (() => {
  const href = window.location.pathname.replace(/\/(index\.html)?$/, "");
  const path = href.split("/");
  const conc = path[path.length - 1];
  return conc;
})()!;

const myweb = (() => {
  let href = window.location.origin + window.location.pathname;
  //href = href.substring(document.location.protocol.length + 2);
  if (href.endsWith("/")) href = href.substring(0, href.length - 1);
  return href;
})();

const _get = (s: string) => Array.from(document.querySelectorAll(s));

const DB = new DBConcurso();
// centro -> distancia (redondeada) a la estación más cercana. null = aún no descargado
let DST: Map<number, number> | null = null;

const MSG_MAIL = Object.freeze({
  subject: "Consulta en relación al concurso de traslados",
  body: dedent(`
  Buenas tardes
  
  Soy ... y quería preguntarles ...
  
  Muchas gracias.
  `),
});

class CentroManager {
  private _c: { [id: number]: Centro } = {};
  private _ok: number[] = [];
  private _ko: number[] = [];
  private _okSet = new Set<number>();
  private _koSet = new Set<number>();
  get all() {
    return Object.values(this._c);
  }
  get ok() {
    return this._ok;
  }
  get ko() {
    return this._ko;
  }
  get_distancias() {
    const cursorMarker = window.MAP.idlayer.get("marker");
    if (!(cursorMarker instanceof L.CircleMarker)) return null;
    const ll = cursorMarker.getLatLng();
    const distance = Object.fromEntries(
      this.all.map((c) => {
        const d = get_distance(c.latitud, c.longitud, ll.lat, ll.lng);
        return [c.id, d];
      })
    ) as {[id:number]: number};
    return {
      latitud: ll.lat,
      longitud: ll.lng,
      centro: distance,
    };
  }
  get_ok() {
    return this._ok.map((id) => this.get(id));
  }
  get_ko() {
    return this._ko.map((id) => this.get(id));
  }
  filter() {
    const fnc = mk_filter();
    this._ok = [];
    this._ko = [];
    this.all.forEach((c) => (fnc(c) ? this._ok : this._ko).push(c.id));
    this._okSet = new Set(this._ok);
    this._koSet = new Set(this._ko);
  }
  get(id: number) {
    const c = this._c[id];
    if (c == null) throw id + " not fund";
    return c;
  }
  find(id: number): Centro | undefined {
    return this._c[id];
  }
  set(centros: Centro[]) {
    const latlon = new Set();
    this._c = Object.fromEntries(
      centros.map((c) => {
        const ll = c.latlon;
        while (latlon.has(c.latlon.toString())) {
          c.longitud = c.longitud + 0.0001;
        }
        if (ll[1] != c.longitud)
          console.log(c.id, `latlon ${ll} -> ${c.latlon}`);
        latlon.add(c.latlon.toString());
        return [c.id, c];
      })
    );
  }

  get_estadistica() {
    let seleccionados: Centro[] = [];
    let descartados: Centro[] = [];
    let hidden: Centro[] = [];
    let shown: Centro[] = [];

    this.all.forEach((c) => {
      const marca = State.getState().getMarca(c.id);
      if (marca == State.SELECCIONADO) {
        seleccionados.push(c);
        return;
      }
      if (marca == State.DESCARTADO) {
        descartados.push(c);
        return;
      }
      if (this._okSet.has(c.id)) {
        shown.push(c);
        return;
      }
      if (this._koSet.has(c.id)) {
        hidden.push(c);
        return;
      }
    });

    const orden = new Map<number, number>();
    State.getState().getPeticiones().forEach((p, i) => {
      if (p.t == "c" && !orden.has(Number(p.id))) orden.set(Number(p.id), i);
    });
    seleccionados = seleccionados.sort((a, b) => (orden.get(a.id) ?? 0) - (orden.get(b.id) ?? 0));

    const dist = this.get_distancias();
    if (dist != null) {
      const d = dist.centro;
      const cmp = (c1: Centro, c2: Centro) => d[c1.id] - d[c2.id];
      descartados = descartados.sort(cmp);
      hidden = hidden.sort(cmp);
      shown = shown.sort(cmp);
    } else if (VIAJE.count() > 0) {
      const t = (c: Centro) => VIAJE.getCentro(c.id)?.segundos ?? Infinity;
      const cmp = (c1: Centro, c2: Centro) => t(c1) - t(c2);
      descartados = descartados.sort(cmp);
      hidden = hidden.sort(cmp);
      shown = shown.sort(cmp);
    }

    return {
      seleccionados: seleccionados,
      descartados: descartados,
      hidden: hidden,
      shown: shown,
      distancias: dist,
    };
  }
}

let CNT = new CentroManager();

const PIN_CACHE = new Map<string, string>();

function get_icon(c: Centro) {
  const color = (() => {
    if (c.dificultad) return "red";
    if (c.nocturno) return "blue";
    return "green";
  })();
  const especial = [
    c.aleman,
    c.ingles,
    c.frances,
    c.innovacion,
    c.excelencia,
  ].includes(true);
  const seleccionado = State.getState().getMarca(c.id) == State.SELECCIONADO;
  const key = `${color}|${especial}|${seleccionado}`;
  let url = PIN_CACHE.get(key);
  if (url == null) {
    url = pinUrl(color, especial, seleccionado);
    PIN_CACHE.set(key, url);
  }
  return {
    color: color,
    especial: especial,
    url: url,
  };
}

export function dwnConcurso() {
  // Aquí y no en DOMContentLoaded: necesita que window.MAP ya exista
  viajeUI = initViaje(() => CNT.all, () => updateCentros(false));
  DB.get_concurso_centros(id_concurso).then((centros) => {
    CNT.set(centros);
    updateCentros(true);
    viajeUI?.refresh();
    return centros;
  });
  const st = State.getState();
  const cMarker = st.getCircleMarker();
  if (cMarker != null) setMark(cMarker);
  window.MAP.on("click", function (this: SBMap, e) {
    if (!e || !e.originalEvent || !e.originalEvent.ctrlKey) return;
    setMark.apply(this, [e]);
  }).on("contextmenu", function (this: SBMap, e) {
    setMark.apply(this, [e]);
  });
}

function updateCentros(centrar: boolean|undefined) {
  if (DST == null) {
    const km = getVal("#kms");
    if (typeof km == "string" && !isNaN(parseFloat(km))) {
      fetch(myweb+"/distancias.json").then(r => r.json()).then((data:{[km:string]:number[]})=>{
        const dst = new Map<number, number>();
        Object.entries(data).forEach(([k, ids])=>ids.forEach(id=>dst.set(id, Number(k))));
        DST = dst;
      }).catch((e) => {
        console.error("distancias.json", e);
        DST = new Map();
      }).finally(() => updateCentros(centrar));
      return;
    }
  }
  CNT.filter();
  document.getElementById("count")!.textContent = CNT.ok.length.toString();
  addMailLink();
  addCentrosLayer();
  updateList();
  if (centrar === true && !window.MAP.center()) {
    window.MAP.setView([40.4165, -3.70256], 12);
  }
  const l = document.getElementById('loading-overlay');
  if (l != null) l.remove();
}

function addMailLink() {
  const a = document.getElementById("maillink") as HTMLAnchorElement;
  const mails = [...new Set(CNT.get_ok().flatMap((c) => c.emails))].sort();
  if (mails.length == 0) {
    a.href = "#";
    a.setAttribute("onclick", "return false");
    a.setAttribute("disabled", "disabled");
    a.title = "No se visualiza ningún centro con correo electrónico";
    return;
  }
  a.removeAttribute("disabled");
  a.removeAttribute("onclick");
  a.href = Mail.mail_tobcc(mails, MSG_MAIL.subject, MSG_MAIL.body);
}



function dwnTxtCentros(this: HTMLAnchorElement) {
  const estadistica = CNT.get_estadistica();
  let date = dateToString(new Date());
  this.download = date + "_centros.txt";
  let txt = "Fecha: " + date + "\n";
  if (VIAJE.origen != null && VIAJE.count() > 0) {
    txt = txt + `Tiempos de viaje: ${MODOS[VIAJE.modo].txt.toLowerCase()} desde ${VIAJE.origen.txt}\n`;
  }
  if (estadistica.distancias != null) {
    txt =
      txt +
      `Punto de refrencia: ${estadistica.distancias.latitud},${estadistica.distancias.longitud}\n`;
  }

  const st = State.getState();
  const filtro = (()=>{
    const filtro = [];
    const tipos = st.tipo.getOkInputs().map(i=>i.title);
    if (tipos.length == 0) return "Ocultar todos";
    const kms = st.kms.get();
    if (kms != null) {
      filtro.push(`* Distancia máxima a una parada de transporte: ${kms} metros`);
    }
    _get("#settings select").forEach(s=>{
      if (!(s instanceof HTMLSelectElement) || s.value.trim().length == 0) return [];
      const label = s.getAttribute("data-label")||"";
      const opt = s.selectedOptions[0];
      filtro.push("* " +label+opt.textContent);
    });
    [st.alumnosMin, st.alumnosMax, st.viajeMax].forEach(i => {
      const v = i.get();
      if (v != null) filtro.push("* " + (i.node?.getAttribute("data-label")??"") + v);
    });
    filtro.push("* Tipos de centro:");
    tipos.forEach(t=>{
      filtro.push("    * " + t);
    })
    let excepto = true;
    _get("fieldset.uncheck_to_hide").forEach(f=>{
      const inputs = Array.from(f.querySelectorAll("input:not(.check_to_hide)")).flatMap(i=>{
        if (!(i instanceof HTMLInputElement)) return [];
        let isChecked = i.checked;
        if (isChecked) return [];
        return (i.getAttribute("data-label")||i.title||i.textContent?.trim())??"";
      })
      if (inputs.length == 0) return;
      if (excepto) {
        excepto = false;
        filtro.push("\nExcepto aquellos centros que cumplan:");
      }
      //const legend = f.querySelector("legend")!.textContent!.trim()??"";
      //filtro.push("* "+legend);
      inputs.forEach(i=>{
        filtro.push("* "+i);
      })
    })
    return "\n"+filtro.join("\n").trim();
  })();

  if (st.invertir.get() === true) {
      txt = txt + "\nFiltro (**OJO**, esta invertido): ";
  } else {
      txt = txt + "\nFiltro: ";
  }
    txt = txt + filtro + "\n";
  const pets = State.getState().getPeticiones();
  if (pets.length) {
    txt = txt + "\nTus peticiones (en orden de preferencia):\n";
    pets.forEach((p, i) => {
      const info = peticionInfo(p);
      txt = txt + `\n${i+1}. ${info.tipo} ${info.codigo??""} ${info.nombre}`.replace(/ +/g, " ");
      txt = txt + ` [puestos ${p.puestos.join(" ")||"-"}]`;
      if (p.t != "c") txt = txt + ` (${info.centros.length} centros)`;
    });
    txt = txt + "\n";
  }
  let cols = [
    ["Centros seleccionados por el filtro", estadistica.shown],
    ["Centros descartados por el filtro", estadistica.hidden],
    ["Centros descartados por mi", estadistica.descartados],
  ];
  const datos = Array.from(document.querySelectorAll("#dwn_datos input[id]:enabled:checked")).map(i=>i.id.substring(4));
  cols.forEach((item) => {
    let col = item[1] as Centro[];
    if (col.length == 0) return;
    txt = txt + "\n" + item[0] + ":\n";
    col.forEach((c) => {
      txt = txt + `\n* ${c.id} ${c.tp.abr} ${c.nombre}`;
      if (estadistica.distancias != null) {
        const dis = (() => {
          const dis_to_mrk = estadistica.distancias.centro[c.id];
          if (dis_to_mrk <= 1) return Math.round(dis_to_mrk * 1000) + "m";
          const d = Math.round(dis_to_mrk * 100) / 100 + "km";
          return d.replace(".", ",");
        })();
        txt = txt + ` (${dis})`;
      }
      datos.forEach(d=>{
        if (d == "viaje") {
          const t = VIAJE.getCentro(c.id);
          if (t != null) txt = txt + `\n  ${MODOS[VIAJE.modo].txt}: ${formatMinutos(t.minutos)}${t.metros == null ? "" : " (" + formatKm(t.metros) + ")"}`;
          return;
        }
        let v = c.getAttribute(d as keyof Centro);
        if (Array.isArray(v) && v.length>0) v = v.join(" ");
        if (typeof v != "string" || v.length==0) return;
        txt = txt + `\n  ${v}`;
      })
    });
    txt = txt + "\n";
  });
  txt = txt.replace(/<.*?>/g, "");
  txt = txt + "\n---\n" + document.location.href;
  txt = txt + "\n¿Te hay sido útil?. Considera donar para mantener este proyecto\n"+DONAR;
  txt = txt.trim();
  txt = txt.replace(/\n/g, "\r\n");
  this.href = "data:text/plain;charset=utf-8," + encodeURIComponent(txt);
}

function getPopUp(c: Centro) {
  const row = (ico: string, html: string) => `<div class="pop-row">${icon(ico)}<div class="min-w-0 flex-1">${html}</div></div>`;
  const ficha = import.meta.env.VITE_FICHA + c.id;

  // Cabecera
  let html = `
  <div class="pop-head">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="chip chip-brand" title="${c.tp.txt}">${c.tp.abr}</span>
      <span class="ctr-code">${c.id}</span>
    </div>
    <h3><a href="${ficha}" title="Ver la ficha oficial del centro">${c.nombre}</a></h3>
  </div>`;

  // Datos
  const datos: string[] = [];
  datos.push(row("pin", `<a href="geo:${c.latitud},${c.longitud}" title="Coordenadas: ${c.latitud}, ${c.longitud}">${c.direccion}</a>`));
  {
    const t = VIAJE.getCentro(c.id);
    if (t != null) {
      const km = t.metros == null ? "" : ` · ${formatKm(t.metros)}`;
      datos.push(row("reloj", `<b>${formatMinutos(t.minutos)}</b> ${MODOS[VIAJE.modo].txt.toLowerCase()}${km}`));
    }
  }
  if (c.alumnos != null) {
    const a = c.alumnos;
    const det = c.alumnado.map(x => `${x.etapa} ${x.alumnado}`).join(" · ");
    datos.push(row("alumnos", `<b>${a.total} alumnos</b> <span class="muted">(${a.year}-${a.year+1})</span><div class="muted">${det}</div>`));
  }
  html += `<div class="pop-sec">${datos.join("")}</div>`;

  // Características
  const chips: string[] = [];
  const chip = (cls: string, ico: string | null, txt: string, title = "") =>
    chips.push(`<span class="chip ${cls}"${title ? ` title="${title}"` : ""}>${ico ? icon(ico, "h-3 w-3") : ""}${txt}</span>`);
  if (c.secundaria) chip("chip-indigo", "eso", "ESO/Bach.");
  if (c.fp) chip("chip-violet", "fp", c.fpdual ? "FP · Dual" : "FP");
  else if (c.fpdual) chip("chip-violet", "fp", "FP Dual");
  if (c.dificultad) chip("chip-red", "dificultad", "Especial dificultad", "Centro de especial dificultad");
  if (c.nocturno) chip("chip-blue", "nocturno", "Nocturno", "Turno nocturno");
  if (c.excelencia) chip("chip-amber", "excelencia", "Excelencia");
  if (c.innovacion) chip("chip-amber", "tecnologia", "Tecnológico");
  c.idiomas.forEach((i) => {
    const n = document.querySelector("#otros input[name=idioma][id=" + i + "]");
    chip("chip-green", "idioma", i, n?.getAttribute("title")?.trim() ?? "");
  });
  if (c.jornada.length) {
    const o = document.querySelector("#jornada option[value='" + c.jornada + "']");
    if (o != null) chip("", "reloj", o.textContent?.trim() ?? "");
  }
  const acc = ({ TA: ["chip-green", "Accesible"], PA: ["chip-amber", "Parcialmente accesible"], NA: ["chip-red", "No accesible"] } as Record<string, string[]>)[c.accesible ?? ""];
  if (acc != null) {
    chips.push(`<a class="chip ${acc[0]} no-underline" href="https://github.com/s-nt-s/centros/wiki/Accesibilidad" title="¡OJO! Función experimental, puede inducir a error">${icon("accesible", "h-3 w-3")}${acc[1]}</a>`);
  }
  if (chips.length) html += `<div class="pop-sec"><div class="chips">${chips.join("")}</div></div>`;

  // Contacto
  const links = c.web.map(lk => `<a class="btn btn-sm" href="${lk}">${icon("web", "h-3.5 w-3.5")} ${lk.match(/www\.madrid\.es/) ? "madrid.es" : "Web"}</a>`);
  if (c.emails.length) {
    const mailto = Mail.mail_tobcc(c.emails, MSG_MAIL.subject, MSG_MAIL.body);
    links.push(`<a class="btn btn-sm" href='${mailto}' title="${c.emails.join(" ")}">${icon("mail", "h-3.5 w-3.5")} Correo</a>`);
  }
  c.telefonos.forEach((t) => {
    if (t.length == 9) {
      if (t.startsWith("91")) t = t.replace(/(..)(...)(..)(..)/, "$1 $2 $3 $4");
      else t = t.replace(/(...)(...)(...)/, "$1 $2 $3");
    }
    links.push(`<a class="btn btn-sm" href="tel:${t.replace(/ /g, "")}" title="Teléfono: ${t}">${icon("telefono", "h-3.5 w-3.5")} ${t}</a>`);
  });
  if (links.length) html += `<div class="pop-sec"><div class="pop-links">${links.join("")}</div></div>`;

  // Peticiones y marca
  html += popupPeticiones(c);
  const marca = State.getState().getMarca(c.id);
  const radio = (val: string, id: string, txt: string, ico: string, cls: string, checked: boolean) =>
    `<label for="${id}${c.id}" class="${cls}"><input value="${val}" class="marcar" type="radio" name="marca${c.id}" id="${id}${c.id}"${checked ? " checked" : ""}/>${icon(ico, "h-3.5 w-3.5")}${txt}</label>`;
  html += `
  <div class="pop-sec">
    <div class="seg" role="radiogroup" aria-label="Marcar centro">
      ${radio(String(State.SELECCIONADO), "sel", "Seleccionar", "estrella", "sel", marca == State.SELECCIONADO)}
      ${radio(String(State.DESCARTADO), "des", "Descartar", "ko", "", marca == State.DESCARTADO)}
      ${radio("", "no", "Ninguna", "nada", "", marca != State.SELECCIONADO && marca != State.DESCARTADO)}
    </div>
  </div>`;

  const div = document.createElement("div");
  div.innerHTML = html.trim();
  div.querySelectorAll("button[data-add]").forEach((b) =>
    b.addEventListener("click", function (this: HTMLButtonElement) {
      const [t, id] = this.getAttribute("data-add")!.split(":");
      State.getState().addPeticion({t: t as Peticion["t"], id: id, puestos: ["01"]});
      this.disabled = true;
      this.insertAdjacentHTML("afterbegin", icon("ok", "h-3.5 w-3.5"));
    })
  );
  div.querySelectorAll("input[type=radio]").forEach((e) =>
    e.addEventListener("change", function (this: HTMLInputElement) {
      if (!this.checked) return;
      const marca = parseInt(this.value);
      if (isNaN(marca)) State.getState().setMarca(c.id, null);
      else State.getState().setMarca(c.id, marca);
      setCentroMarker(c, true);
      updateList();
    })
  );
  return div;
}

function setCentroMarker(centro:Centro, refresh: boolean = false) {
  const layer_id = "centro_"+centro.id;
  const layer_old = window.MAP.idlayer.get(layer_id);
  if (layer_old!=null) {
    if (!refresh) return layer_old;
    window.MAP.removeLayer(layer_old);
    window.MAP.idlayer.delete(layer_id);
  }
  const icon = get_icon(centro);
  const latlng: L.LatLng = new L.LatLng(centro.latitud, centro.longitud);
  const marker = (()=>{
    if (State.getState().getMarca(centro.id) === State.DESCARTADO) {
      const options: L.CircleOptions = {
        radius: 5,
        fill: true,
        fillColor: PIN_COLOR[icon.color] ?? icon.color,
        fillOpacity: 0.8,
        color: "black",
        opacity: 1,
        weight: 1
      };
      return L.circleMarker(latlng, options);
    }
    const conf = {
      icon: L.icon({
        iconUrl: icon.url,
        iconSize: [28, 36],
        iconAnchor: [14, 35],
        popupAnchor: [0, -32],
        tooltipAnchor: [12, -20],
      }),
    };
    return L.marker(latlng, conf);
  })();
  marker.bindPopup(() => getPopUp(centro), { maxWidth: 320, minWidth: 300 });
  marker.bindTooltip(centro.tp.abr + " " + centro.nombre);
  window.MAP.addIdLayer(layer_id, marker);
}

function addCentrosLayer() {
  CNT.get_ok().forEach((c) => {
    setCentroMarker(c);
  });
  CNT.ko.forEach((id) => {
    window.MAP.removeLayerById("centro_"+id)
  });
}

function mk_filter() {
  const st = State.getState();
  const ok_tipo = st.tipo.get();
  const ko_idio = st.idioma.getKo();
  const jornada = st.jornada.get();
  const etapa = st.etapa.get();
  const fpdual = st.fpdual.get();
  const transporte = st.kms.get();
  const invertir = st.invertir.get();
  const accesibilidad = st.accesibilidad.getSplit(",");
  const ensenanza = st.ensenanza.get();
  const aluMin = st.alumnosMin.get();
  const aluMax = st.alumnosMax.get();
  const viajeMax = st.viajeMax.get();
  const isEnsenanzaOk = (c: Centro) => {
    switch (ensenanza) {
      case null: return true;
      case "sec": return c.secundaria;
      case "fp": return c.fp;
      case "ambas": return c.secundaria && c.fp;
      case "solo-sec": return c.secundaria && !c.fp;
      case "solo-fp": return c.fp && !c.secundaria;
      case "alguna": return c.secundaria || c.fp;
      case "ninguna": return !c.secundaria && !c.fp;
    }
    return true;
  };
  const _isOk = (c: Centro) => {
    let i;
    if (!ok_tipo.includes(c.tp.id)) return false;
    for (i = 0; i < ko_idio.length; i++) {
      if (c.idiomas.includes(ko_idio[i])) return false;
    }
    if (st.excelencia.get() === false && c.excelencia) return false;
    if (st.nocturno.get() === false && c.nocturno) return false;
    if (accesibilidad.length) {
      if (!accesibilidad.includes(c.accesible??"NULL")) return false;
    }
    if (st.innovacion.get() === false && c.innovacion) return false;
    if (st.dificultad.get() === false &&c.dificultad) return false;
    if (jornada != null && c.jornada!=jornada) return false;
    if (etapa != null && !c.hasEtapa(etapa)) return false;
    if (!isEnsenanzaOk(c)) return false;
    if (viajeMax != null) {
      const t = VIAJE.getCentro(c.id);
      if (t == null || t.segundos > viajeMax * 60) return false;
    }
    if (aluMin != null || aluMax != null) {
      const total = c.alumnos?.total;
      if (total == null) return false;
      if (aluMin != null && total < aluMin) return false;
      if (aluMax != null && total > aluMax) return false;
    }
    if (fpdual != null){
      if (fpdual == "con" && c.fpdual == false) return false;
      if (fpdual == "sin" && c.fpdual == true) return false;
    }
    if (transporte != null && DST != null) {
      const d = DST.get(c.id);
      if (d != null && d > transporte) return false;
    }
    return true;
  };
  const isOk = (c: Centro) => {
    if (State.getState().getMarca(c.id) === State.SELECCIONADO) return true;
    let b = _isOk(c);
    if (invertir) b = !b;
    //if (!b) console.log(c.id, "descartado");
    return b;
  };
  return isOk;
}

function setMark(e: L.LeafletMouseEvent | [number, number] | null) {
  const latlng = (() => {
    if (e == null) return null;
    if (Array.isArray(e)) return new L.LatLng(e[0], e[1]);
    return e.latlng
  })();
  window.MAP.removeLayerById("marker");
  if (latlng == null) {
    State.getState().setCircleMarker(null, null);
  } else {
    const options: L.CircleOptions = {
      radius: 10,
      fillColor: "yellow",
      color: "black",
      weight: 1,
      opacity: 1,
      fillOpacity: 0.8
    };
    State.getState().setCircleMarker(latlng.lat, latlng.lng);
    console.log(latlng.lat + "," + latlng.lng);
    const cursorMarker = L.circleMarker(latlng, options);
    window.MAP.addIdLayer("marker", cursorMarker);
  }
  updateList();
}

function updateList() {
  const estadistica = CNT.get_estadistica();
  const set_html = (id: string, html:string) =>
    (document.getElementById(id)!.innerHTML = html);
  renderPeticiones();
  set_html(
    "cShw",
    list_centros(
      "Tu filtro oculta todos los centros",
      estadistica.shown,
      estadistica.distancias?.centro
    )
  );
  set_html(
    "cHdn",
    list_centros(
      "Tu filtro muestra todos los centros",
      estadistica.hidden,
      estadistica.distancias?.centro
    )
  );
  set_html(
    "cDsc",
    list_centros(
      "Aún no has descartado ningún centro",
      estadistica.descartados,
      estadistica.distancias?.centro
    )
  );
  document.querySelectorAll("#peticiones, #cShw, #cHdn, #cDsc").forEach(h=>{
    const count = h.id == "peticiones" ? State.getState().getPeticiones().length : h.querySelectorAll("li").length;
    const h2 = h.id == "peticiones" ? document.getElementById("h_peticiones") : h.previousElementSibling;
    if (h2==null || h2.tagName!="H2") return;
    const small = h2.querySelector("small");
    if (small!=null) small.textContent=`${count}`;
    else h2.insertAdjacentHTML("beforeend", ` <small>${count}</small>`);
  })
  /*
  set_html("#cSel,#cShw,#cHdn,#cDsc").each(function () {
    let t = $(this);
    let count = t.find("li").length;
    let h2 = t.prev("h2");
    if (count == 0) {
      h2.find("small").remove();
    } else {
      let small = h2.find("small");
      if (small.length) small.text("(" + count + ")");
      else h2.append(" <small>(" + count + ")</small>");
    }
  });
  */
}

function list_centros(
  msg: string,
  centros: Centro[],
  distancia: { [id: number]: number } | undefined
) {
  if (centros.length == 0) {
    return `<p class="rounded-lg border border-dashed border-slate-200 p-3 text-center text-xs text-slate-500">${msg}</p>`;
  }
  const mails: Set<string> = new Set();
  let html = "<ul class='listCentros'>";
  let lis: string[] = [];
  centros.forEach(function (c) {
    c.emails.forEach((m) => mails.add(m));
    let distance = "";
    let d = 0;
    if (distancia != undefined) {
      let title = "";
      d = distancia[c.id];
      if (d > 1) {
        distance = Math.round(d) + "km";
        title = Math.round(d * 100) / 100 + "km";
        title = title.replace(".", ",");
        title = " title='" + title + "'";
      } else if (d <= 1) {
        distance = Math.round(d * 1000) + "m";
      }
      distance = ` <small class="dist"${title}>${distance}</small>`;
    }
    const ico = get_icon(c);
    const v = viajeTxt(c);
    if (v != null) distance = distance + ` <small class="viaje">${v}</small>`;
    lis.push(`
      <li><img alt="" title="Ver en el mapa" src="${ico.url}" onclick="window.MAP.flyTo([${c.latitud}, ${c.longitud}], 15);"/><span>${c.abr_nombre} <span class="ctr-code">${c.id}</span>${distance}</span></li>
    `);
  });
  html = html + lis.join("");
  html = html + "</ul>";
  if (mails.size) {
    const arr = [...mails].sort();
    const mailto = Mail.mail_tobcc(arr, MSG_MAIL.subject, MSG_MAIL.body);
    html =
      html +
      `
    <p class="mt-2"><a class="btn btn-sm" href="${mailto}">${icon("mail", "h-3.5 w-3.5")} Escribir a los centros de esta lista</a></p>
    `;
  }
  return html;
}


/* ===================== Peticiones ===================== */

type PeticionInfo = {
  tipo: string;
  codigo: string | null;
  nombre: string;
  centros: Centro[];
};

function cubre(p: Peticion, c: Centro) {
  if (p.t == "c") return p.id == c.id.toString();
  if (p.t == "l") return c.localidad?.id == p.id;
  return c.area == p.id;
}

function peticionInfo(p: Peticion): PeticionInfo {
  const centros = CNT.all.filter((c) => cubre(p, c));
  if (p.t == "c") {
    const c = CNT.find(Number(p.id));
    return {
      tipo: "Centro",
      codigo: p.id,
      nombre: c == null ? "(no está en este concurso)" : c.abr_nombre,
      centros: centros,
    };
  }
  if (p.t == "l") {
    const l = getLocalidad(p.id);
    const distrito = l != null && l.dat == DAT.C && /^Madrid-/i.test(l.txt);
    return {
      tipo: distrito ? "Distrito" : "Localidad",
      codigo: p.id,
      nombre: l?.txt ?? "",
      centros: centros,
    };
  }
  return {
    tipo: "DAT",
    codigo: null,
    nombre: DAT[p.id] ?? p.id,
    centros: centros,
  };
}

/** Avisos sobre una petición teniendo en cuenta las anteriores */
function avisosPeticion(pets: readonly Peticion[], i: number, info: PeticionInfo) {
  const p = pets[i];
  const avisos: string[] = [];
  if (p.puestos.length == 0) avisos.push("Marca al menos un tipo de puesto.");
  if (p.t != "c" && p.puestos.includes("06"))
    avisos.push("El tipo 06 solo se adjudica pidiendo el centro concreto, no por localidad, distrito o DAT.");
  if (p.t != "c" && info.centros.length == 0)
    avisos.push("No hay centros de este concurso en el mapa para esta petición.");
  // ¿Todo lo que pide esta petición ya estaba en una anterior?
  if (p.puestos.length && info.centros.length) {
    for (let j = 0; j < i; j++) {
      const q = pets[j];
      if (!incluyePuestos(q, p)) continue;
      if (info.centros.every((c) => cubre(q, c))) {
        avisos.push(`Ya está incluida en la petición nº ${j + 1} con los mismos tipos de puesto: no añade nada.`);
        break;
      }
    }
  }
  return avisos;
}

function renderPeticiones() {
  const div = document.getElementById("peticiones");
  if (div == null) return;
  const st = State.getState();
  const pets = st.getPeticiones();
  if (pets.length == 0) {
    div.innerHTML = `<p class="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">${icon("lista", "mx-auto mb-1 h-6 w-6 text-slate-300")}<br/>Aún no tienes peticiones. Selecciona centros en el mapa o añade abajo una localidad, distrito o DAT.</p>`;
    syncAddButtons();
    return;
  }
  const lis = pets.map((p, i) => {
    const info = peticionInfo(p);
    const avisos = avisosPeticion(pets, i, info);
    const puestos = Object.entries(PUESTOS).map(([k, v]) => {
      const chk = p.puestos.includes(k) ? " checked" : "";
      return `<label title="${v}"><input type="checkbox" data-puesto="${k}"${chk}/>${k}</label>`;
    }).join(" ");
    const fly = (() => {
      if (p.t != "c") return "";
      const c = CNT.find(Number(p.id));
      if (c == null) return "";
      return `<img class="fly" alt="" src="${get_icon(c).url}" data-fly="${c.latitud},${c.longitud}" title="Ver en el mapa"/>`;
    })();
    const rango = viajeRango(info.centros);
    const incluye = (p.t == "c" ? "" : ` <small class="chip">${info.centros.length} centro${info.centros.length == 1 ? "" : "s"}</small>`)
      + (rango == null ? "" : ` <small class="viaje">${rango}</small>`);
    const codigo = info.codigo == null ? "" : `<span class="ctr-code">${info.codigo}</span> `;
    const tipoCls = p.t == "c" ? "chip-brand" : p.t == "l" ? "chip-blue" : "chip-violet";
    return `
      <li draggable="true" data-i="${i}" class="pet_${p.t}${avisos.length ? " aviso" : ""}">
        <span class="pnum"><input type="number" class="pos" min="1" max="${pets.length}" value="${i + 1}" title="Número de orden"/></span>
        <span class="pbody">
          <span class="mb-0.5 flex flex-wrap items-center gap-1"><span class="chip ${tipoCls}">${info.tipo}</span>${codigo}</span>
          ${fly}<span class="font-medium text-slate-900">${info.nombre}</span>${incluye}
          <span class="puestos">Puestos: ${puestos}</span>
          ${avisos.map((a) => `<small class="avisotxt">⚠️ ${a}</small>`).join("")}
        </span>
        <span class="pbtn">
          <button type="button" data-act="up" title="Subir"${i == 0 ? " disabled" : ""}>${icon("arriba")}</button>
          <button type="button" data-act="down" title="Bajar"${i == pets.length - 1 ? " disabled" : ""}>${icon("abajo")}</button>
          <button type="button" data-act="dup" title="Repetir esta petición debajo con otros tipos de puesto">${icon("copiar", "h-3.5 w-3.5")}</button>
          <button type="button" data-act="del" title="Quitar">${icon("x")}</button>
        </span>
      </li>`;
  });
  let html = "";
  if (pets.length > MAX_PETICIONES) {
    html += `<p class="note mb-2">${icon("aviso", "h-4 w-4 shrink-0")}<span>Tienes ${pets.length} peticiones y la solicitud admite como máximo ${MAX_PETICIONES}.</span></p>`;
  }
  html += `<ol class="listPeticiones">${lis.join("")}</ol>`;
  div.innerHTML = html;
  syncAddButtons();
}

function syncAddButtons() {
  const st = State.getState();
  ([["addLocalidad", "btnAddLocalidad", "l"], ["addDat", "btnAddDat", "d"]] as const).forEach(([slc, btn, t]) => {
    const s = document.getElementById(slc) as HTMLSelectElement | null;
    const b = document.getElementById(btn) as HTMLButtonElement | null;
    if (s == null || b == null) return;
    s.querySelectorAll("option[value]").forEach((o) => {
      const v = (o as HTMLOptionElement).value;
      (o as HTMLOptionElement).disabled = v.length > 0 && st.hasPeticion({t: t, id: v});
    });
    b.disabled = s.value.length == 0 || st.hasPeticion({t: t, id: s.value});
  });
}

function removePeticion(i: number) {
  const st = State.getState();
  const p = st.getPeticiones()[i];
  if (p == null) return;
  st.removePeticion(i);
  if (p.t == "c") {
    const c = CNT.find(Number(p.id));
    if (c != null) setCentroMarker(c, true);
    updateCentros(false);
  }
}

function initPeticiones() {
  const div = document.getElementById("peticiones");
  if (div == null) return;
  const st = State.getState();
  const liIndex = (e: Event) => {
    const li = (e.target as HTMLElement).closest("li[data-i]");
    return li == null ? null : Number(li.getAttribute("data-i"));
  };
  div.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const fly = t.getAttribute("data-fly");
    if (fly != null) {
      const [lat, lon] = fly.split(",").map(Number);
      window.MAP.flyTo([lat, lon], 15);
      return;
    }
    const act = t.closest("button[data-act]")?.getAttribute("data-act");
    const i = liIndex(e);
    if (act == null || i == null) return;
    if (act == "up") st.movePeticion(i, i - 1);
    if (act == "down") st.movePeticion(i, i + 1);
    if (act == "dup") st.duplicatePeticion(i);
    if (act == "del") removePeticion(i);
  });
  div.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    const i = liIndex(e);
    if (i == null) return;
    if (t.classList.contains("pos")) {
      const to = parseInt(t.value);
      if (!isNaN(to)) st.movePeticion(i, to - 1);
      else renderPeticiones();
      return;
    }
    if (t.hasAttribute("data-puesto")) {
      const li = t.closest("li")!;
      const puestos = Array.from(li.querySelectorAll("input[data-puesto]:checked")).map((x) => x.getAttribute("data-puesto")!);
      st.setPuestos(i, puestos);
    }
  });
  // Arrastrar y soltar
  let dragFrom: number | null = null;
  div.addEventListener("dragstart", (e) => {
    dragFrom = liIndex(e);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  div.addEventListener("dragover", (e) => {
    if (dragFrom == null) return;
    e.preventDefault();
    div.querySelectorAll("li.dragover").forEach((li) => li.classList.remove("dragover"));
    (e.target as HTMLElement).closest("li[data-i]")?.classList.add("dragover");
  });
  div.addEventListener("drop", (e) => {
    e.preventDefault();
    const to = liIndex(e);
    if (dragFrom != null && to != null) st.movePeticion(dragFrom, to);
    dragFrom = null;
  });
  div.addEventListener("dragend", () => {
    dragFrom = null;
    div.querySelectorAll("li.dragover").forEach((li) => li.classList.remove("dragover"));
  });
  // Añadir localidad / DAT
  ([["addLocalidad", "btnAddLocalidad", "l"], ["addDat", "btnAddDat", "d"]] as const).forEach(([slc, btn, t]) => {
    const s = document.getElementById(slc) as HTMLSelectElement | null;
    const b = document.getElementById(btn);
    if (s == null || b == null) return;
    s.addEventListener("change", syncAddButtons);
    b.addEventListener("click", () => {
      if (s.value.length == 0) return;
      st.addPeticion({t: t, id: s.value, puestos: ["01"]});
      s.value = "";
      syncAddButtons();
    });
  });
  st.onPeticiones(updateList);
}

/** Bloque del popup: en qué peticiones está el centro y botones para añadir su localidad/DAT */
function popupPeticiones(c: Centro) {
  const st = State.getState();
  const pets = st.getPeticiones();
  const en = pets.flatMap((p, i) => {
    if (!cubre(p, c)) return [];
    const tipo = p.t == "c" ? "" : p.t == "d" ? " (DAT)" : ` (${peticionInfo(p).tipo.toLowerCase()})`;
    return [`<b>nº ${i + 1}</b>${tipo}`];
  });
  const parts: string[] = [];
  if (en.length) parts.push(`<div class="pop-row">${icon("lista")}<div>En tus peticiones ${en.join(", ")}</div></div>`);
  const btns: string[] = [];
  const l = c.localidad;
  if (l != null) {
    const info = peticionInfo({t: "l", id: l.id, puestos: []});
    const dis = st.hasPeticion({t: "l", id: l.id}) ? " disabled" : "";
    btns.push(`<button type="button" class="btn btn-sm" data-add="l:${l.id}"${dis} title="Código ${l.id}: ${info.centros.length} centros">${icon("mas", "h-3.5 w-3.5")}${info.tipo} ${l.txt}</button>`);
  }
  if (c.area != null && DAT[c.area] != null) {
    const dis = st.hasPeticion({t: "d", id: c.area}) ? " disabled" : "";
    btns.push(`<button type="button" class="btn btn-sm" data-add="d:${c.area}"${dis}>${icon("mas", "h-3.5 w-3.5")}DAT ${DAT[c.area]}</button>`);
  }
  if (btns.length) parts.push(`<div class="muted">Añadir a tus peticiones:</div><div class="pop-links">${btns.join("")}</div>`);
  if (parts.length == 0) return "";
  return `<div class="pop-sec">${parts.join("")}</div>`;
}

function dwnCsvPeticiones(this: HTMLAnchorElement) {
  const pets = State.getState().getPeticiones();
  const esc = (v: string | number | null) => {
    const s = (v ?? "").toString().replace(/<.*?>/g, "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: (string | number | null)[][] = [
    ["Orden", "Tipo", "Código", "Nombre", "DAT", "Tipos de puesto", "Centros incluidos", "Tiempo de viaje (min)", "Avisos"],
  ];
  const datOrden: string[] = [];
  pets.forEach((p, i) => {
    const info = peticionInfo(p);
    const dat = (() => {
      if (p.t == "d") return DAT[p.id];
      if (p.t == "l") return getLocalidad(p.id)?.dat ?? null;
      return CNT.find(Number(p.id))?.dat ?? null;
    })();
    if (dat != null && !datOrden.includes(dat)) datOrden.push(dat);
    rows.push([
      i + 1,
      info.tipo,
      info.codigo,
      p.t == "d" ? "DAT " + info.nombre : info.nombre,
      dat,
      p.puestos.join(" "),
      info.centros.length,
      (() => {
        const mins = info.centros.flatMap((c) => VIAJE.getCentro(c.id)?.minutos ?? []);
        if (mins.length == 0) return null;
        const mn = Math.min(...mins), mx = Math.max(...mins);
        return mn == mx ? mn : `${mn}-${mx}`;
      })(),
      avisosPeticion(pets, i, info).join(" "),
    ]);
  });
  Object.values(DAT).forEach((d) => {
    if (!datOrden.includes(d)) datOrden.push(d);
  });
  rows.push([]);
  rows.push(["Orden de DAT sugerido (paso 6.1 de la solicitud, según el orden de tus peticiones)"]);
  datOrden.forEach((d, i) => rows.push([i + 1, "DAT", null, d]));
  rows.push([]);
  rows.push([document.location.href]);
  const csv = "﻿" + rows.map((r) => r.map(esc).join(";")).join("\r\n");
  this.download = dateToString(new Date()) + "_peticiones.csv";
  this.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
}

document.addEventListener("DOMContentLoaded", function () {
  document.getElementById("download")!.addEventListener("click", dwnTxtCentros);
  document.getElementById("downloadPeticiones")?.addEventListener("click", dwnCsvPeticiones);
  initPeticiones();
  const st = State.getState();
  st.onFiltro(()=>updateCentros(false));
  st.onTransporte(set_transpo_layer);
  st.onAreas(set_area_layer);
});
