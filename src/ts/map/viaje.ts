import * as L from "leaflet";
import {
  Viaje,
  Destino,
  Modo,
  MODOS,
  Origen,
  geocodificar,
  formatMinutos,
  FicheroViaje,
} from "../../lib/viaje";
import { icon } from "../../lib/icons";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function abrirPestana(id: string) {
  try {
    window.MAP.sidebar.t.open(id);
  } catch (e) {
    console.warn(e);
  }
}

/**
 * Pestaña "Tiempo de viaje".
 * @param getDestinos centros del concurso actual (con coordenadas)
 * @param onUpdate se llama cada vez que cambian los tiempos, para refrescar filtros y listas
 */
export function initViaje(getDestinos: () => readonly Destino[], onUpdate: () => void) {
  const V = Viaje.get();
  const q = $<HTMLInputElement>("viaje_q");
  const form = $<HTMLFormElement>("viaje_form");
  const resultados = $<HTMLDivElement>("viaje_resultados");
  const btnMapa = $<HTMLButtonElement>("viaje_mapa");
  const btnGps = $<HTMLButtonElement>("viaje_gps");
  const txtOrigen = $<HTMLParagraphElement>("viaje_origen");
  const modo = $<HTMLSelectElement>("viaje_modo");
  const btnCalcular = $<HTMLButtonElement>("viaje_calcular");
  const btnCancelar = $<HTMLButtonElement>("viaje_cancelar");
  const btnBorrar = $<HTMLButtonElement>("viaje_borrar");
  const progreso = $<HTMLProgressElement>("viaje_progreso");
  const estado = $<HTMLParagraphElement>("viaje_estado");
  const fichero = $<HTMLInputElement>("viaje_fichero");
  if (txtOrigen == null || btnCalcular == null || estado == null) return;

  let ctrl: AbortController | null = null;
  let mensaje: string | null = null;

  const setOrigen = (o: Origen) => {
    if (ctrl != null) ctrl.abort();
    V.setOrigen(o);
    if (resultados) resultados.innerHTML = "";
  };

  const renderOrigen = () => {
    const o = V.origen;
    txtOrigen.innerHTML = o == null
      ? `<span class="text-slate-500">Aún no has elegido el punto de partida.</span>`
      : `<span class="flex items-start gap-2"><span class="casa-icon h-6 w-6 shrink-0">${icon("casa", "h-3.5 w-3.5")}</span><span><b>${esc(o.txt)}</b><br/><span class="muted">${o.lat.toFixed(5)}, ${o.lon.toFixed(5)} · arrastra la casa del mapa para ajustarlo (se borrarán los tiempos)</span></span></span>`;
  };

  const renderEstado = () => {
    const destinos = getDestinos();
    const total = destinos.length;
    const pend = V.pendientes(destinos).length;
    const hechos = total - pend;
    const enCurso = ctrl != null;
    btnCalcular.hidden = !V.calculable;
    btnCalcular.disabled = enCurso || V.origen == null || pend == 0 || total == 0;
    btnCalcular.textContent = pend > 0 && hechos > 0 ? `Calcular los ${pend} que faltan` : "Calcular tiempos";
    if (btnCancelar) btnCancelar.hidden = !enCurso;
    if (progreso && !enCurso) progreso.hidden = true;
    if (btnBorrar) btnBorrar.disabled = enCurso || (V.origen == null && V.count() == 0);
    if (modo) modo.disabled = enCurso;
    const partes: string[] = [];
    if (mensaje) partes.push(mensaje);
    if (!V.calculable && V.count() == 0) partes.push(`${MODOS[V.modo].ico} Aún no has importado tiempos en transporte público.`);
    else if (V.origen == null) partes.push("Elige primero el punto de partida.");
    else if (total > 0) {
      const sinRuta = destinos.filter((d) => V.isCalculado(d.id) && V.getCentro(d.id) == null).length;
      let t = `${MODOS[V.modo].ico} ${V.calculable ? "Calculados" : "Con tiempo importado"} ${hechos} de ${total} centros`;
      if (V.fecha) t += ` (${new Date(V.fecha).toLocaleDateString("es-ES")})`;
      if (sinRuta) t += `, ${sinRuta} sin ruta o demasiado lejos`;
      partes.push(t + ".");
      const mins = destinos.flatMap((d) => V.getCentro(d.id)?.minutos ?? []);
      if (mins.length) partes.push(`Entre ${formatMinutos(Math.min(...mins))} y ${formatMinutos(Math.max(...mins))}.`);
      if (V.info) partes.push(`<span class="muted">${esc(V.info)}</span>`);
    }
    estado.innerHTML = partes.join("<br/>");
    const info = $<HTMLParagraphElement>("viaje_max_info");
    if (info) info.hidden = hechos > 0;
  };

  const drawCasa = () => {
    window.MAP.removeLayerById("casa");
    const o = V.origen;
    if (o == null) return;
    const m = L.marker([o.lat, o.lon], {
      draggable: true,
      zIndexOffset: 1000,
      title: "Punto de partida (arrástralo para moverlo)",
      icon: L.divIcon({ className: "casa-icon", html: icon("casa"), iconSize: [30, 30], iconAnchor: [15, 15] }),
    });
    m.on("dragend", () => {
      const ll = m.getLatLng();
      setOrigen({ lat: ll.lat, lon: ll.lng, txt: "Punto marcado en el mapa" });
    });
    m.bindTooltip("Punto de partida");
    window.MAP.addIdLayer("casa", m);
  };

  const refresh = () => {
    renderOrigen();
    renderEstado();
  };

  V.onChange(() => {
    refresh();
    drawCasa();
    onUpdate();
  });

  // Buscar dirección
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const txt = q?.value.trim() ?? "";
    if (txt.length < 3 || resultados == null) return;
    resultados.innerHTML = `<p class="muted flex items-center gap-2"><span class="spinner h-4 w-4 border-2"></span>Buscando…</p>`;
    try {
      const arr = await geocodificar(txt);
      if (arr.length == 0) {
        resultados.innerHTML = `<p class="note">No se ha encontrado esa dirección en la Comunidad de Madrid. Prueba a añadir el municipio o elige el punto en el mapa.</p>`;
        return;
      }
      resultados.innerHTML = `<p class="muted mb-1">Elige el resultado correcto:</p><ul class="space-y-1">` + arr.map((o, i) =>
        `<li><a href="#" target="_self" data-i="${i}" class="flex items-start gap-2 rounded-lg border border-slate-200 p-2 text-slate-700 no-underline hover:border-brand-300 hover:bg-brand-50 hover:no-underline">${icon("pin", "mt-0.5 h-4 w-4 text-brand-600")}<span>${esc(o.txt)}</span></a></li>`).join("") + "</ul>";
      resultados.querySelectorAll("a[data-i]").forEach((a) =>
        a.addEventListener("click", (ev) => {
          ev.preventDefault();
          const o = arr[Number(a.getAttribute("data-i"))];
          setOrigen(o);
          window.MAP.setView([o.lat, o.lon], 13);
        })
      );
    } catch (err) {
      console.error(err);
      resultados.innerHTML = `<p class="note">No se ha podido buscar la dirección. Inténtalo de nuevo en un momento o elige el punto en el mapa.</p>`;
    }
  });

  // Elegir en el mapa (un solo clic)
  btnMapa?.addEventListener("click", () => {
    const cont = window.MAP.getContainer();
    cont.style.cursor = "crosshair";
    btnMapa.disabled = true;
    btnMapa.innerHTML = `${icon("pin", "h-3.5 w-3.5")} Pincha en el mapa…`;
    window.MAP.once("click", (e: L.LeafletMouseEvent) => {
      cont.style.cursor = "";
      btnMapa.disabled = false;
      btnMapa.innerHTML = `${icon("pin", "h-3.5 w-3.5")} Elegir en el mapa`;
      setOrigen({ lat: e.latlng.lat, lon: e.latlng.lng, txt: "Punto marcado en el mapa" });
      abrirPestana("viaje");
    });
    // En pantallas pequeñas el panel tapa el mapa
    if (window.innerWidth < 768) window.MAP.sidebar.t.close();
  });

  // Geolocalización
  btnGps?.addEventListener("click", () => {
    if (!navigator.geolocation) {
      mensaje = "Tu navegador no permite obtener la ubicación.";
      renderEstado();
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        mensaje = null;
        setOrigen({ lat: pos.coords.latitude, lon: pos.coords.longitude, txt: "Mi ubicación" });
        window.MAP.setView([pos.coords.latitude, pos.coords.longitude], 13);
      },
      () => {
        mensaje = "No se ha podido obtener tu ubicación.";
        renderEstado();
      }
    );
  });

  if (modo) {
    modo.value = V.modo;
    modo.addEventListener("change", () => {
      mensaje = null;
      V.setModo(modo.value as Modo);
    });
  }

  // Cálculo en segundo plano
  btnCalcular.addEventListener("click", async () => {
    if (ctrl != null) return;
    ctrl = new AbortController();
    mensaje = null;
    if (progreso) {
      progreso.hidden = false;
      progreso.value = 0;
    }
    renderEstado();
    try {
      await V.calcular(getDestinos(), (hechos, total) => {
        if (progreso) progreso.value = total == 0 ? 1 : hechos / total;
      }, ctrl.signal);
      mensaje = "✔ Cálculo terminado.";
    } catch (err) {
      if ((err as Error).name == "AbortError") mensaje = "Cálculo interrumpido; lo ya calculado se ha guardado.";
      else {
        console.error(err);
        mensaje = "⚠️ El servidor de rutas no ha respondido. Lo ya calculado se ha guardado; vuelve a intentarlo en unos minutos.";
      }
    } finally {
      ctrl = null;
      renderEstado();
    }
  });

  btnCancelar?.addEventListener("click", () => ctrl?.abort());

  // Importar un fichero de tiempos (p.e. transporte público)
  fichero?.addEventListener("change", async () => {
    const f = fichero.files?.[0];
    fichero.value = "";
    if (f == null) return;
    try {
      const data = JSON.parse(await f.text()) as FicheroViaje;
      if (V.cambiariaOrigen(data) &&
          !confirm(`Este fichero se calculó desde «${data.origen.txt}». Se usará ese punto de partida y se borrarán los tiempos calculados desde el actual. ¿Continuar?`)) {
        return;
      }
      ctrl?.abort();
      const r = V.importar(data);
      if (modo) modo.value = V.modo;
      mensaje = `✔ Importados los tiempos de ${r.centros} centros.`;
      renderEstado();
    } catch (err) {
      console.error(err);
      mensaje = "⚠️ No se ha podido leer el fichero: no es un fichero de tiempos válido.";
      renderEstado();
    }
  });

  btnBorrar?.addEventListener("click", () => {
    if (!confirm("¿Borrar el punto de partida y los tiempos guardados en este navegador?")) return;
    ctrl?.abort();
    mensaje = null;
    V.borrar();
  });

  // Enlaces a la pestaña desde otros sitios (p.e. el filtro)
  document.querySelectorAll("a[href='#viaje'][target='_self']").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      abrirPestana("viaje");
    })
  );

  refresh();
  drawCasa();
  return { refresh: renderEstado };
}
