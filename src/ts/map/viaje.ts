import * as L from "leaflet";
import {
  Viaje,
  Destino,
  Modo,
  MODOS,
  Origen,
  geocodificar,
  formatMinutos,
} from "../../lib/viaje";

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
      ? "Aún no has elegido el punto de partida."
      : `🏠 <b>${esc(o.txt)}</b><br/><small>${o.lat.toFixed(5)}, ${o.lon.toFixed(5)} · arrastra la casa del mapa para ajustarlo</small>`;
  };

  const renderEstado = () => {
    const destinos = getDestinos();
    const total = destinos.length;
    const pend = V.pendientes(destinos).length;
    const hechos = total - pend;
    const enCurso = ctrl != null;
    btnCalcular.disabled = enCurso || V.origen == null || pend == 0 || total == 0;
    btnCalcular.textContent = pend > 0 && hechos > 0 ? `Calcular los ${pend} que faltan` : "Calcular tiempos";
    if (btnCancelar) btnCancelar.hidden = !enCurso;
    if (progreso && !enCurso) progreso.hidden = true;
    if (btnBorrar) btnBorrar.disabled = enCurso || (V.origen == null && V.count() == 0);
    if (modo) modo.disabled = enCurso;
    const partes: string[] = [];
    if (mensaje) partes.push(mensaje);
    if (V.origen == null) partes.push("Elige primero el punto de partida.");
    else if (total > 0) {
      const sinRuta = destinos.filter((d) => V.isCalculado(d.id) && V.getCentro(d.id) == null).length;
      let t = `${MODOS[V.modo].ico} Calculados ${hechos} de ${total} centros`;
      if (V.fecha) t += ` (${new Date(V.fecha).toLocaleDateString("es-ES")})`;
      if (sinRuta) t += `, ${sinRuta} sin ruta`;
      partes.push(t + ".");
      const mins = destinos.flatMap((d) => V.getCentro(d.id)?.minutos ?? []);
      if (mins.length) partes.push(`Entre ${formatMinutos(Math.min(...mins))} y ${formatMinutos(Math.max(...mins))}.`);
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
      icon: L.divIcon({ className: "casa-icon", html: "🏠", iconSize: [28, 28], iconAnchor: [14, 14] }),
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
    resultados.innerHTML = "<p>Buscando…</p>";
    try {
      const arr = await geocodificar(txt);
      if (arr.length == 0) {
        resultados.innerHTML = "<p>No se ha encontrado esa dirección en la Comunidad de Madrid. Prueba a añadir el municipio o elige el punto en el mapa.</p>";
        return;
      }
      resultados.innerHTML = "<p>Elige el resultado correcto:</p><ul class='viaje_res'>" + arr.map((o, i) =>
        `<li><a href="#" target="_self" data-i="${i}">${esc(o.txt)}</a></li>`).join("") + "</ul>";
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
      resultados.innerHTML = "<p>No se ha podido buscar la dirección. Inténtalo de nuevo en un momento o elige el punto en el mapa.</p>";
    }
  });

  // Elegir en el mapa (un solo clic)
  btnMapa?.addEventListener("click", () => {
    const cont = window.MAP.getContainer();
    cont.style.cursor = "crosshair";
    btnMapa.disabled = true;
    btnMapa.textContent = "Pincha en el mapa…";
    window.MAP.once("click", (e: L.LeafletMouseEvent) => {
      cont.style.cursor = "";
      btnMapa.disabled = false;
      btnMapa.textContent = "Elegir en el mapa";
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
    modo.addEventListener("change", () => V.setModo(modo.value as Modo));
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
