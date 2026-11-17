Web para elegir centro en el concurso de traslados.

Obtiene los datos de [centros-db](https://github.com/s-nt-s/centros-db).

Desplegado usando [Vite + Github Pages](https://vitejs.dev/guide/static-deploy#github-pages).

Los códigos de localidad/distrito que se usan en la lista de peticiones
(`src/assets/localidades.json`) se extraen de los anexos oficiales
«Relación de códigos de centros y localidades» con `py/localidades.py`
(requiere `curl` y `poppler-utils`).

El tiempo de viaje desde casa se calcula en el navegador con
[OSRM](https://routing.openstreetmap.de/) (coche, bici y a pie) y la dirección
se localiza con [Nominatim](https://nominatim.openstreetmap.org/). El punto de
partida y los tiempos solo se guardan en el `localStorage` del navegador.

Los tiempos en **transporte público** no se pueden calcular en el navegador. Se
generan con `py/transporte_publico.py` (r5py + horarios GTFS del Consorcio de
Transportes + OpenStreetMap) y se importan desde la pestaña «Tiempo de viaje».
El fichero generado contiene el punto de partida: no debe subirse al repositorio.
