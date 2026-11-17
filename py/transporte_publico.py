"""
Tiempos de viaje en TRANSPORTE PÚBLICO desde un punto de partida hasta los centros.

La web no puede calcularlos (no hay un servicio gratuito que lo haga para cientos
de destinos), así que se generan con este script y se importan en la web desde la
pestaña «Tiempo de viaje» → «Importar fichero de tiempos».

Usa r5py (motor R5 de Conveyal) con:
  - Los horarios oficiales (GTFS) del Consorcio Regional de Transportes de Madrid:
    Metro, Metro Ligero, Cercanías, EMT, autobuses interurbanos y urbanos.
  - El mapa de calles de OpenStreetMap de la Comunidad de Madrid (para andar).

Calcula la MEDIANA del tiempo puerta a puerta saliendo en cada minuto de una franja
(por defecto 60 minutos), así que incluye las esperas.

Requisitos: Java 21 y `pip install r5py` (y unos 8 GB de RAM libres).

Uso:
    python3 transporte_publico.py descargar
    python3 transporte_publico.py calcular --lat 40.41 --lon -3.70 --txt "Casa" \
        --fecha 2026-11-24 --hora 07:30 --out ~/tiempos_transporte.json

¡OJO! El fichero de salida contiene tu punto de partida: guárdalo fuera del
repositorio y no lo subas a ningún sitio público.
"""
import argparse
import csv
import datetime
import io
import json
import os
import sqlite3
import subprocess
import sys
import zipfile
from pathlib import Path

DIR = Path(os.environ.get("CENTROS_TP_DIR", Path.home() / ".cache" / "centros-transporte"))
GTFS_DIR = DIR / "gtfs"
OSM = DIR / "madrid.osm.pbf"

# Fuentes: catálogo de MobilityData / Transitous. Los ficheros del CRTM se publican en ArcGIS.
FUENTES = {
    "metro": "https://crtm.maps.arcgis.com/sharing/rest/content/items/5c7f2951962540d69ffe8f640d94c246/data",
    "ligero": "https://www.arcgis.com/sharing/rest/content/items/aaed26cc0ff64b0c947ac0bc3e033196/data",
    "cercanias": "https://www.arcgis.com/sharing/rest/content/items/1a25440bf66f499bae2657ec7fb40144/data",
    "interurbanos": "http://crtm.maps.arcgis.com/sharing/rest/content/items/885399f83408473c8d815e40c5e702b7/data",
    "urbanos": "https://www.arcgis.com/sharing/rest/content/items/357e63c2904f43aeb5d8a267a64346d8/data",
    # EMT: copia de MobilityData (el servidor de la EMT usa el puerto 8443, a menudo bloqueado)
    "emt": "https://storage.googleapis.com/storage/v1/b/mdb-latest/o/es-madrid-empresa-municipal-de-transportes-de-madrid-emt-madrid-gtfs-793.zip?alt=media",
}
OSM_URLS = [
    "https://download.geofabrik.de/europe/spain/madrid-latest.osm.pbf",
    "https://download.openstreetmap.fr/extracts/europe/spain/comunidad_de_madrid-latest.osm.pbf",
]


def curl(url: str, out: Path):
    subprocess.run(["curl", "-sSLf", "-m", "1200", "-o", str(out), url], check=True)


def normalizar(src: Path, dst: Path, extender_hasta: str | None = None):
    """
    Deja el GTFS como lo espera R5: ficheros en la raíz del zip, sin feed_info (los del
    CRTM traen varias filas) y sin tablas vacías. Si `extender_hasta`, alarga la vigencia
    del calendario (Metro publica a veces su horario ya caducado).
    """
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as out:
        for n in zin.namelist():
            if n.endswith("/"):
                continue
            base = os.path.basename(n)
            data = zin.read(n)
            if base == "feed_info.txt":
                continue
            txt = data.decode("utf-8-sig", "replace")
            if len([ln for ln in txt.splitlines() if ln.strip()]) <= 1:
                continue
            if extender_hasta and base == "calendar.txt":
                rows = list(csv.reader(io.StringIO(txt)))
                h = rows[0]
                i0, i1 = h.index("start_date"), h.index("end_date")
                for r in rows[1:]:
                    if r:
                        r[i1] = max(r[i1], extender_hasta)
                        r[i0] = min(r[i0], extender_hasta[:4] + "0101")
                buf = io.StringIO()
                csv.writer(buf, lineterminator="\n").writerows(rows)
                data = buf.getvalue().encode()
            out.writestr(base, data)


def vigencia(z: Path):
    """(primera, última) fecha de servicio del GTFS, según calendar y calendar_dates."""
    fechas = []
    with zipfile.ZipFile(z) as zf:
        names = set(zf.namelist())
        if "calendar.txt" in names:
            for r in csv.DictReader(io.StringIO(zf.read("calendar.txt").decode("utf-8-sig"))):
                fechas += [r["start_date"], r["end_date"]]
        if "calendar_dates.txt" in names:
            for r in csv.DictReader(io.StringIO(zf.read("calendar_dates.txt").decode("utf-8-sig"))):
                if r.get("exception_type") == "1":
                    fechas.append(r["date"])
    return (min(fechas), max(fechas)) if fechas else (None, None)


def descargar(args):
    raw = DIR / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    GTFS_DIR.mkdir(parents=True, exist_ok=True)
    hasta = (datetime.date.today() + datetime.timedelta(days=400)).strftime("%Y%m%d")
    for nombre, url in FUENTES.items():
        print(f"GTFS {nombre}…", flush=True)
        curl(url, raw / f"{nombre}.zip")
        normalizar(raw / f"{nombre}.zip", GTFS_DIR / f"{nombre}.zip")
        ini, fin = vigencia(GTFS_DIR / f"{nombre}.zip")
        if fin is not None and fin < datetime.date.today().strftime("%Y%m%d"):
            print(f"  ¡horario caducado ({ini}-{fin})! se alarga su vigencia", flush=True)
            normalizar(raw / f"{nombre}.zip", GTFS_DIR / f"{nombre}.zip", extender_hasta=hasta)
        print(f"  vigencia {vigencia(GTFS_DIR / f'{nombre}.zip')}")
    for url in OSM_URLS:
        try:
            print(f"OSM {url}…", flush=True)
            curl(url, OSM)
            break
        except subprocess.CalledProcessError as e:
            print(f"  falló: {e}")
    else:
        sys.exit("No se ha podido descargar el mapa de OpenStreetMap")


def calcular(args):
    sys.argv += ["--max-memory", args.memoria]  # r5py lee sus opciones de sys.argv
    import geopandas as gpd
    import r5py
    from shapely.geometry import Point

    gtfs = sorted(str(p) for p in GTFS_DIR.glob("*.zip"))
    if not gtfs or not OSM.exists():
        sys.exit("Faltan datos: ejecuta primero `descargar`")
    dia = args.fecha.replace("-", "")
    for g in gtfs:
        ini, fin = vigencia(Path(g))
        if ini and not (ini <= dia <= fin):
            print(f"AVISO: {Path(g).name} no tiene servicio el {args.fecha} ({ini}-{fin})")

    con = sqlite3.connect(args.db)
    rows = con.execute("""
        select id, latitud, longitud from centro
        where latitud != 0 and longitud != 0
          and id in (select centro from concurso_anexo_centro)
    """).fetchall()
    dest = gpd.GeoDataFrame({"id": [r[0] for r in rows]},
                            geometry=[Point(r[2], r[1]) for r in rows], crs="EPSG:4326")
    orig = gpd.GeoDataFrame({"id": [0]}, geometry=[Point(args.lon, args.lat)], crs="EPSG:4326")

    network = r5py.TransportNetwork(OSM, gtfs)
    salida = datetime.datetime.fromisoformat(f"{args.fecha}T{args.hora}")
    ttm = r5py.TravelTimeMatrix(
        network,
        origins=orig,
        destinations=dest,
        departure=salida,
        departure_time_window=datetime.timedelta(minutes=args.ventana),
        transport_modes=[r5py.TransportMode.TRANSIT, r5py.TransportMode.WALK],
        max_time=datetime.timedelta(minutes=args.max),
        percentiles=[50],
    )
    col = [c for c in ttm.columns if c.startswith("travel_time")][0]
    tiempos = {}
    for _, r in ttm.iterrows():
        v = r[col]
        tiempos[str(int(r["to_id"]))] = [None if v != v else int(v) * 60, None]

    fin = salida + datetime.timedelta(minutes=args.ventana)
    dias = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
    Path(args.out).expanduser().write_text(json.dumps({
        "v": 1,
        "tipo": "centros-viaje",
        "modo": "transit",
        "origen": {"lat": args.lat, "lon": args.lon, "txt": args.txt},
        "salida": f"Saliendo un {dias[salida.weekday()]} ({salida:%d/%m/%Y}) entre las {salida:%H:%M} y las {fin:%H:%M}; mediana del tiempo puerta a puerta con esperas",
        "fecha": datetime.datetime.now().isoformat(timespec="seconds"),
        "fuentes": "CRTM (Metro, Metro Ligero, Cercanías, EMT, interurbanos y urbanos) y OpenStreetMap",
        "tiempos": tiempos,
    }, ensure_ascii=False))
    ok = sorted(v[0] for v in tiempos.values() if v[0] is not None)
    print(f"{len(tiempos)} centros, {len(ok)} con ruta en menos de {args.max} min")
    if ok:
        print(f"mín {ok[0] // 60} · mediana {ok[len(ok) // 2] // 60} · máx {ok[-1] // 60} minutos")


ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
sub = ap.add_subparsers(dest="cmd", required=True)
sub.add_parser("descargar", help="descarga y prepara los horarios y el mapa")
c = sub.add_parser("calcular", help="calcula los tiempos desde un punto")
c.add_argument("--lat", type=float, required=True)
c.add_argument("--lon", type=float, required=True)
c.add_argument("--txt", default="Punto de partida", help="nombre que se mostrará en la web")
c.add_argument("--fecha", default=None, help="AAAA-MM-DD, un día laborable (por defecto el próximo martes)")
c.add_argument("--hora", default="07:30")
c.add_argument("--ventana", type=int, default=60, help="minutos de la franja de salida")
c.add_argument("--max", type=int, default=180, help="tiempo máximo en minutos")
c.add_argument("--db", default="../db/db.sqlite", help="BD SQLite de la web (db/get_db.sh o /db.sqlite)")
c.add_argument("--memoria", default="8G")
c.add_argument("--out", required=True)
ARG, _ = ap.parse_known_args()
if ARG.cmd == "calcular" and ARG.fecha is None:
    hoy = datetime.date.today()
    ARG.fecha = (hoy + datetime.timedelta(days=(1 - hoy.weekday()) % 7 or 7)).isoformat()
{"descargar": descargar, "calcular": calcular}[ARG.cmd](ARG)
