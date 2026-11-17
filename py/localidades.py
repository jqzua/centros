"""
Genera src/assets/localidades.json a partir de los PDF oficiales
«Relación de códigos de centros y localidades» de cada concurso.

Para cada centro se obtiene el código de petición de su localidad
(o distrito en Madrid capital) y la DAT a la que pertenece.

Requiere `curl`, `pdftotext` y `pdfinfo` (paquete poppler-utils).

Uso:
    python3 localidades.py [--db ../db/db.sqlite] [pdf_o_url ...]
"""
import argparse
import json
import re
import subprocess
import tempfile
from os.path import isfile

from core.dblite import DBLite

parser = argparse.ArgumentParser(description='Códigos de localidad/distrito de los centros')
parser.add_argument('--db', type=str, default="../db/db.sqlite")
parser.add_argument('--out', type=str, default="../src/assets/localidades.json")
parser.add_argument('pdf', nargs='*', help="PDFs o URLs (por defecto los anexos de la BD)")
ARG = parser.parse_args()

# El PDF está maquetado a dos columnas sobre una página de 612pt de ancho
COLUMNAS = ((0, 305), (305, 307))
re_dat = re.compile(r'D\.A\.T\.\s+(Madrid-\S+)')
re_loc = re.compile(r'^\s*(28\d{7})\s{2,}(\S.*?)\s*$')
re_ctr = re.compile(r'^\s*(28\d{6})\s')


def run(*args: str):
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout


def parse(pdf: str, localidad: dict, centro: dict):
    n = int(re.search(r'Pages:\s+(\d+)', run('pdfinfo', pdf)).group(1))
    dat = loc = None
    for p in range(1, n + 1):
        for x, w in COLUMNAS:
            txt = run('pdftotext', '-layout', '-f', str(p), '-l', str(p),
                      '-x', str(x), '-y', '0', '-W', str(w), '-H', '792', pdf, '-')
            for line in txt.splitlines():
                m = re_dat.search(line)
                if m:
                    dat = m.group(1)
                    continue
                m = re_loc.match(line)
                if m:
                    loc = m.group(1)
                    localidad[loc] = {"txt": m.group(2), "dat": dat}
                    continue
                m = re_ctr.match(line)
                if m and loc:
                    centro[m.group(1)] = loc


def get_sources():
    if ARG.pdf:
        return ARG.pdf
    with DBLite(ARG.db, readonly=True) as db:
        return sorted(set(db.to_tuple('''
            select url from concurso_anexo
            where lower(txt) like '%códigos de centros y localidades%'
        ''')))


def main():
    localidad, centro = {}, {}
    if isfile(ARG.out):
        with open(ARG.out) as f:
            old = json.load(f)
            localidad.update(old.get("localidad", {}))
            centro.update(old.get("centro", {}))
    with tempfile.TemporaryDirectory() as tmp:
        for i, src in enumerate(get_sources()):
            pdf = src
            if not isfile(src):
                pdf = f"{tmp}/{i}.pdf"
                # la sede responde 404 a urllib y a navegadores; con curl funciona
                run('curl', '-sSLf', '-o', pdf, src)
            parse(pdf, localidad, centro)
            print(src, len(localidad), len(centro))
    with open(ARG.out, "w") as f:
        json.dump({
            "localidad": dict(sorted(localidad.items())),
            "centro": dict(sorted(centro.items())),
        }, f, ensure_ascii=False, indent=1)


main()
