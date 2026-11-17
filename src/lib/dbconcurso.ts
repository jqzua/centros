import { DataBase, } from "./supabaseClient";
import { smart_title, toTitle } from "./util";
import centro_accesib from '../assets/accesibilidad.json';
import localidades from '../assets/localidades.json';
import { DAT } from "./peticiones";
import type { Tables } from "./database.types";

type AlumnadoEtapa = {
  etapa: string;
  alumnado: number;
};


function get_flag(obj: any, id: number) {
  const a = (obj as {[key: string]: string})[id.toString()];
  return a;
}

// Familias de macro_etapa que identifican ESO/Bachillerato y FP
// ("Secundaría" es la grafía antigua, se mantiene por compatibilidad con BDs ya desplegadas)
const FAMILIA_SECUNDARIA = ["Secundaria", "Secundaría"];
const FAMILIA_FP = ["FP"];
const ALUMNADO_SECUNDARIA = /^(ESO|Bachillerato)$/i;
const ALUMNADO_FP = /^FP\b/i;

export type Ensenanza = "sec" | "fp";

/** Localidad (o distrito en Madrid capital) tal como se codifica en las peticiones */
export type Localidad = {
  readonly id: string;
  readonly txt: string;
  readonly dat: string|null;
};

const LOCALIDAD = localidades.localidad as {[id: string]: {txt: string, dat: string|null}};
const CENTRO_LOCALIDAD = localidades.centro as {[id: string]: string};
const _cache_localidad = new Map<string, Localidad>();

function prettyLocalidad(txt: string) {
  // "ALAMO(EL)" -> "Alamo (El)", "MADRID-USERA" -> "Madrid-Usera"
  txt = txt.replace(/\s*\((EL|LA|LOS|LAS)\)\s*$/i, (_, a) => ` (${toTitle(a)})`);
  return smart_title(txt).replace(/\((el|la|los|las)\)/, (_, a) => `(${toTitle(a)})`);
}

export function getLocalidad(id: string): Localidad | null {
  let l = _cache_localidad.get(id);
  if (l != null) return l;
  const raw = LOCALIDAD[id];
  if (raw == null) return null;
  l = Object.freeze({id: id, txt: prettyLocalidad(raw.txt), dat: raw.dat});
  _cache_localidad.set(id, l);
  return l;
}

function invert(obj: {[k: string|number]: number[]}) {
  const m = new Map<number, string[]>();
  Object.entries(obj).forEach(([k, ids]) => {
    ids.forEach(id => {
      const arr = m.get(id);
      if (arr == null) m.set(id, [k]);
      else arr.push(k);
    });
  });
  return m;
}

function filter(arr: any[], func: Function) {
  const ok: any[] = [];
  const ko: any[] = [];
  arr.forEach((a) => {
    (func(a) ? ok : ko).push(a);
  });
  return {
    ok: ok,
    ko: ko,
  };
}

class DBConcurso extends DataBase {
  async get_concursos() {
    const cpn = ((await this.get('concurso'))).sort((c1, c2)=>{
      if (c1.convocatoria != c2.convocatoria) return -c1.convocatoria.localeCompare(c2.convocatoria);
      if (c1.tipo != c2.tipo) return -c1.tipo.localeCompare(c2.tipo);
      return c1.txt.localeCompare(c2.txt);
    });
    return await Promise.all(cpn.map(c => this.get_concurso(c)));
  }
  async get_concurso(c: string|Tables<"concurso">) {
    if (typeof c == "string") c=await this.get_one("concurso", c);
    const [anx_rs, centros] = await Promise.all([
      this.from("concurso_anexo").select().eq("concurso", c.id),
      this.get_concurso_centros(c.id, false)
    ]);
    const anx = this.get_data(`anexo[concurso=${c.id}]`, anx_rs);
    const id_etapas = Array.from(new Set(centros.flatMap(c=>c.etapas)));
    const etapas = this.get_data(
      `macro_etapa[${c.id}]`,
      (await this.from('macro_etapa').select().in('id', id_etapas).order('txt')),
    );
    return new Concurso(
      c,
      anx,
      etapas,
      centros
    );
  }
  async get_concurso_centros(id: string, with_latlon: boolean = true) {
    id = id.replace(/-/g, "_");
    // Todas las consultas son independientes: se lanzan en paralelo
    const [cetrs, tipos, query, etapas, alumnado, familias] = await Promise.all([
      this._get_concurso_centros(id, with_latlon),
      this.get_dict('tipo'),
      this._get_concurso_query(id),
      this._get_concurso_etapas(id),
      this._get_alumnado(id),
      this._get_familias_etapa(),
    ]);
    // Índices centro -> valores, para no recorrer todas las listas por cada centro
    const queryByCentro = invert(query);
    const etapasByCentro = invert(etapas);
    return cetrs.map(c=>{
      const t = tipos.get(c.tipo)!;
      const q = [...(queryByCentro.get(c.id)??[])];
      const e = (etapasByCentro.get(c.id)??[]).map(Number);
      const a = get_flag(centro_accesib, c.id);
      const al = alumnado[c.id]??[];
      if (['+', '-', 'p',].includes(a)) q.push("githubAccesible="+a);
      const ens = new Set<Ensenanza>();
      e.forEach(i => {
        const f = familias.get(i);
        if (f != null) ens.add(f);
      });
      al.forEach(x => {
        if (ALUMNADO_SECUNDARIA.test(x.etapa)) ens.add("sec");
        if (ALUMNADO_FP.test(x.etapa)) ens.add("fp");
      });
      return new Centro(
        c,
        t,
        q,
        e,
        al,
        ens
      );
    }) as Centro[]
  }

  private async _get_familias_etapa() {
    const m = new Map<number, Ensenanza>();
    this.get_data(
      `macro_etapa[familia=sec|fp]`,
      await this.from('macro_etapa').select('id, familia').in('familia', [...FAMILIA_SECUNDARIA, ...FAMILIA_FP])
    ).forEach(e => {
      if (FAMILIA_SECUNDARIA.includes(e.familia)) m.set(e.id, "sec");
      else if (FAMILIA_FP.includes(e.familia)) m.set(e.id, "fp");
    });
    return m;
  }

  private async _get_concurso_centros(id: string, with_latlon: boolean = true) {
    let prm = this.from(
      'centro', id
    ).select().order('id');
    if (with_latlon) prm = prm.neq('latitud', 0);
    const data = this.get_data(
      `centro[${id}]`,
      await prm,
    );
    return data;
  }
  private async _get_concurso_query(id: string) {
    const obj: {[id:string]: number[]} = {}
    const qrs = [
      "itRegimenNocturno=4",
      "itCentroExcelencia=S",
      "itAulaExcelencia=S",
      "itInTecno=S",
      "checkCentroBilingue=S",
      "checkCentroConvenio=S",
      "checkSeccionesLinguisticasFr=S",
      "checkSeccionesLinguisticasAl=S",
      "itRegimenDual=5",
      "checkIntegraM=S",
      "accesibilidad=0",
      "accesibilidad=1",
      "accesibilidad=2",
    ];
    this.get_data(
      `query_centro[${id}][query=${qrs}]`,
      await this.from(
        'query_centro', id
      ).select('query, centro').in('query', qrs)
    ).forEach(e=>{
      if (obj[e.query]==null) obj[e.query]=[];
      obj[e.query].push(e.centro);
    })
    return Object.freeze(obj);
  }
  private async _get_concurso_etapas(id: string) {
    const obj: {[id:number]: number[]} = {}
    const etapas = this.get_data(
      `macro_etapa_centro[${id}]`,
      await this.from('macro_etapa_centro', id).select('centro, etapa')
    );
    etapas.forEach(e=>{
      if (obj[e.etapa]==null) obj[e.etapa]=[];
      obj[e.etapa].push(e.centro);
    })
    return Object.freeze(obj);
  }
  private async _get_alumnado(id: string) {
    const obj: {[id:number]: AlumnadoEtapa[]} = {}
    const etapas = this.get_data(
      `alumnado[${id}]`,
      await this.from('alumnado', id).select('*')
    );
    etapas.forEach(e=>{
      if (obj[e.centro]==null) obj[e.centro]=[];
      obj[e.centro].push({
        etapa: e.etapa,
        alumnado: e.alumnado
      });
    })
    return Object.freeze(obj);
  }
}

class Concurso {
  private readonly _c: Tables<"concurso">;
  public readonly anexos: readonly Tables<"concurso_anexo">[];
  public readonly centros: readonly Centro[];
  public readonly desubicados: readonly Centro[];
  public readonly tipos: readonly Tables<"tipo">[];
  public readonly nocturos: readonly number[];
  public readonly dificultad: readonly number[];
  public readonly excelencia: readonly number[]
  public readonly innovacion: readonly number[];
  public readonly ingles: readonly number[];
  public readonly frances: readonly number[];
  public readonly aleman: readonly number[];
  public readonly jornadas: readonly string[];
  public readonly secundaria: readonly number[];
  public readonly fp: readonly number[];
  public readonly etapas: readonly Tables<"macro_etapa">[];
  //public readonly accesible: readonly number[];

  constructor(
    concurso: Tables<"concurso">,
    anexos: Tables<'concurso_anexo'>[],
    etapas: Tables<'macro_etapa'>[],
    centros: Centro[]
  ) {
    this._c = concurso;
    this.anexos = Object.freeze(anexos);
    this.etapas = Object.freeze(etapas);
    const {ok, ko} = filter(centros, (c:Centro) => (c.latitud??0)>0);
    this.centros = Object.freeze(ok as Centro[]);
    this.desubicados = Object.freeze(ko as Centro[]);
    this.tipos = Object.freeze((()=>{
      const tipos = new Map<string, Tables<'tipo'>>();
      this.centros.forEach(c=>tipos.set(c.tp.id, c.tp));
      return Array.from(tipos.values()).sort((a, b)=>a.txt.localeCompare(b.txt));
    })());
    const _gids = (fnc: (c:Centro)=>boolean) => Object.freeze(this.centros.filter(fnc).map(c=>c.id));
    this.nocturos = _gids(c=>c.nocturno);
    this.dificultad = _gids(c=>c.dificultad);
    this.excelencia = _gids(c=>c.excelencia);
    this.innovacion = _gids(c=>c.innovacion);
    this.ingles = _gids(c=>c.ingles);
    this.frances = _gids(c=>c.frances);
    this.aleman = _gids(c=>c.aleman);
    this.secundaria = _gids(c=>c.secundaria);
    this.fp = _gids(c=>c.fp);
    //this.accesible = _gids(c=>c.accesible !== null);
    this.jornadas = Object.freeze(Array.from(new Set(this.centros.flatMap(c=>c.jornada.length?c.jornada:[]))).sort());
  }

  get alumnado() {
    const obj: {[id:string]: {mn: number, mx: number}} = {};
    this.centros.forEach(c=>{
      c.alumnado.forEach(a=>{
        const k = a.etapa;
        if (obj[k] == null) obj[k] = {mn: a.alumnado, mx: a.alumnado};
        else {
          obj[k].mn = Math.min(obj[k].mn, a.alumnado);
          obj[k].mx = Math.max(obj[k].mx, a.alumnado);
        }
      })
    })
    return Object.freeze(obj);
  }

  /** Mostrar el filtro ESO/Bachillerato vs FP */
  get showEnsenanza() {
    // Solo tiene sentido para los cuerpos de secundaria y FP
    const cuerpos = (this.cuerpo??"").split(/\s+/);
    if (!["0590", "0511", "0591", "0598"].some(c => cuerpos.includes(c))) return false;
    const n = this.centros.length;
    return this.fp.length > 0 && this.secundaria.length > 0 && (this.fp.length < n || this.secundaria.length < n);
  }

  get showFP() {
    const spl = this.id.split("-");
    const id = spl[spl.length-1];
    return ["fp", "secundaria", "concursillo"].includes(id);
  }

  get id() {
    return this._c.id;
  }

  /** Centros con y sin coordenadas: las peticiones por localidad o DAT incluyen a todos */
  get todos(): readonly Centro[] {
    return [...this.centros, ...this.desubicados];
  }

  /** Localidades/distritos del concurso con su número de centros, agrupables por DAT */
  get localidades() {
    const m = new Map<string, {localidad: Localidad, count: number}>();
    this.todos.forEach(c => {
      const l = c.localidad;
      if (l == null) return;
      const x = m.get(l.id);
      if (x == null) m.set(l.id, {localidad: l, count: 1});
      else x.count++;
    });
    return Array.from(m.values()).sort((a, b) => a.localidad.txt.localeCompare(b.localidad.txt));
  }

  get dats() {
    const m = new Map<string, number>();
    this.todos.forEach(c => {
      if (c.area != null) m.set(c.area, (m.get(c.area) ?? 0) + 1);
    });
    return Object.entries(DAT).flatMap(([id, txt]) => {
      const count = m.get(id);
      if (count == null) return [];
      return {id: id, txt: txt, count: count, localidades: this.localidades.filter(l => l.localidad.dat == txt)};
    });
  }

  get hasAlumnado() {
    return this.centros.some(c => c.alumnos != null);
  }

  get cuerpo() {
    return this._c.cuerpo;
  }

  get txt() {
    return this._c.txt;
  }

  get name() {
    const txt = this._c.convocatoria+' '+this._c.txt;
    if (this._c.tipo != 'concursillo') return txt;
    return txt + ' (concursillo)';
  }

  get tipo() {
    return this._c.tipo;
  }

  get convocatoria() {
    return this._c.convocatoria;
  }

  get descripcion() {
    if (this.tipo == "concurso") return "Concurso de traslados"
    if (this.tipo == "concursillo" ) return "Asignación de destinos provisionales en inicio de curso"
    return null;
  }

  get tipo_convocatoria() {
    return toTitle(this.tipo)+' '+this.convocatoria;
  }

  get url() {
    return this._c.url;
  }

  get isEspecial() {
    return (
      [
        this.nocturos,
        this.dificultad,
        this.innovacion,
        this.excelencia,
        this.ingles,
        this.aleman,
        this.frances,
      ].filter((arr) => arr.length > 0).length > 0
    );
  }
}

class Centro {
  private readonly _c: Tables<"centro">;
  private readonly _t: Tables<"tipo">;
  readonly queries: readonly string[];
  readonly etapas: readonly number[];
  readonly alumnado: readonly AlumnadoEtapa[];
  private readonly _queries: ReadonlySet<string>;
  private readonly _etapas: ReadonlySet<number>;
  private readonly _ensenanzas: ReadonlySet<Ensenanza>;

  constructor(
    centro: Tables<"centro">,
    tipo: Tables<"tipo">,
    queries: string[],
    etapas: number[],
    alumnado: AlumnadoEtapa[],
    ensenanzas: Set<Ensenanza> = new Set()
  ) {
    this._c = centro;
    this._t = tipo;
    this.queries = Object.freeze(queries);
    this.etapas = Object.freeze(etapas);
    this._queries = new Set(queries);
    this._etapas = new Set(etapas);
    this._ensenanzas = ensenanzas;
    this.alumnado = Object.freeze(alumnado.sort((a, b) => b.alumnado - a.alumnado));
  }

  get alumnos() {
    const year = this._c.curso_alumnado;
    if (year == 0) return null;
    const arr: string[] = [];
    let total = 0;
    this.alumnado.forEach(a=>{
      total += a.alumnado;
      arr.push(`${a.alumnado} en ${a.etapa}`);
    })
    return {
      year: year,
      total: total,
      title: `Curso ${year}-${year+1}: ${arr.join(", ")}`
    }
  }

  get alumnado_txt(): string | null {
    const a = this.alumnos;
    if (a == null) return null;
    return `Alumnado ${a.year}-${a.year+1}: ${a.total} (${this.alumnado.map(x => `${x.etapa} ${x.alumnado}`).join(", ")})`;
  }

  get id(): number {
    return this._c.id;
  }

  /** Letra de la Dirección de Área Territorial */
  get area(): string | null {
    return this._c.area;
  }

  get dat(): string | null {
    if (this._c.area == null) return null;
    return DAT[this._c.area] ?? null;
  }

  /** Localidad, o distrito si es Madrid capital, según el anexo oficial de códigos */
  get localidad(): Localidad | null {
    const id = CENTRO_LOCALIDAD[this._c.id.toString()];
    if (id == null) return null;
    return getLocalidad(id);
  }

  hasEtapa(s: number) {
    return this._etapas.has(s);
  }

  get latlon(): readonly [number, number] {
    const ll: readonly [number, number] = [this._c.latitud, this._c.longitud];
    return ll;
  }

  get direccion(): string {
    return [
      this._c.domicilio,
      this._c.cp,
      this._c.municipio,
    ].filter(i=>i!=null).join(" ")
  }

  get web(): string[] {
    if (this._c.web == null) return [];
    if (this._c.web.length==0) return [];
    return this._c.web.split(/\s+/).map(u=>{
      if (u.startsWith("http://") || u.startsWith("https://")) return u;
      return "http://"+u;
    })
  }

  get latitud(): number {
    return this._c.latitud;
  }

  get longitud(): number {
    return this._c.longitud;
  }

  get jornada(): string {
    return this._c.jornada;
  }

  set longitud(l: number) {
    this._c.longitud = l;
  }

  get tipo(): string {
    return this._c.tipo;
  }

  get tp(): Tables<"tipo"> {
    return this._t;
  }

  get dificultad(): boolean {
    return this._c.dificultad == 1;
  }

  isQuery(...qrs:string[]) {
    return qrs.some(q => this._queries.has(q));
  }

  get accesible() {
    if (this.isQuery("githubAccesible=+")) return "TA";
    if (this.isQuery("githubAccesible=p")) return "PA";
    if (this.isQuery("githubAccesible=-")) return "NA";
    // Los hospitales por defecto son accesibles
    if (this.tipo == "036") return "TA";
    // Instalación no accesible para personas con movilidad reducida
    if (this.isQuery("accesibilidad=0")) return "NA";
    // Instalación accesible para personas con movilidad reducida
    if (this.isQuery("accesibilidad=1")) return "TA";
    // Instalación parcialmente accesible para personas con movilidad reducida
    if (this.isQuery("accesibilidad=2")) return "PA";
    // Centro motórico
    if (this.isQuery("checkIntegraM=S")) return "TA";
    // Colegio de educación especial
    if (this.tipo == "020") return "TA";
    // Equipo de orientación educativa y psicopedagógica
    //if (["204", "205", "206"].includes(this.tipo)) return "NA";
    return null;
  }
  get motorico() {
    return this.isQuery("checkIntegraM=S");
  }
  get nocturno() {
    return this.isQuery("itRegimenNocturno=4");
  }
  get excelencia() {
    return this.isQuery("itCentroExcelencia=S", "itAulaExcelencia=S");
  }
  get innovacion() {
    return this.isQuery("itInTecno=S");
  }
  get ingles() {
    return this.isQuery(
      "checkCentroBilingue=S",
      "checkCentroConvenio=S"
    );
  }
  get frances() {
    return this.isQuery("checkSeccionesLinguisticasFr=S");
  }
  get aleman() {
    return this.isQuery("checkSeccionesLinguisticasAl=S");
  }
  get fpdual() {
    return this.isQuery("itRegimenDual=5");
  }
  /** Imparte ESO y/o Bachillerato */
  get secundaria() {
    return this._ensenanzas.has("sec");
  }
  /** Imparte Formación Profesional */
  get fp() {
    return this._ensenanzas.has("fp");
  }
  get ensenanzas(): string[] {
    const arr = [];
    if (this.secundaria) arr.push("ESO/Bachillerato");
    if (this.fp) arr.push("FP");
    return arr;
  }
  get emails() {
    return splitNotEmpty(this._c.email);
  }

  get idiomas(): string[] {
    const arr = [];
    if (this.ingles) arr.push("EN");
    if (this.aleman) arr.push("DE");
    if (this.frances) arr.push("FR");
    return arr;
  }

  get telefonos(): string[] {
    return splitNotEmpty(this._c.telefono);
  }

  get nombre(): string {
    return parseName(this._c, this._t);
  }

  get abr_nombre(): string {
    return `<abbr title="${this.tp.txt}">${this.tp.abr}</abbr> ${this.nombre}`;
  }

  getAttribute<K extends keyof Centro>(attributeName: K): Centro[K] {
    return this[attributeName];
  }
}

function splitNotEmpty(s: string | null | undefined) {
  const t = (s ?? '').trim();
  if (t.length == 0) return [];
  return t.split(/\s+/);
}

function parseName(c: Tables<"centro">, tp: Tables<"tipo">) {
    const abr = tp.abr;
    let nom = c.nombre;
    if (abr == "AH") {
      nom = nom.replace(
        /^(Aula Hospitalaria Hosp\.|Aula Hospitalaria|Hospital) /i,
        ""
      );
    }
    if (abr.startsWith("EOEP")) {
      nom = nom.replace(/^(Equipo General|Equipo Gral\.|Equipo) /i, "");
      nom = nom.replace(
        /^(E\. a\. Temprana|Eq\. Aten\.temprana|Eq\. At\.temp\.|Equipo At\. Temp\.|Eoep de At\.tna|Eq\. Aten\. Temprana|At\. Temp\.|E\.a\.temprana|Atencion Temprana) /i,
        ""
      );
      nom = nom.replace(/^(E.e\.?) /i, "");
    }
    if (abr == "EOEP-AT") {
      nom = nom.replace(/^(Atencíon Temprana) /i, "");
    }
    if (abr == "SIES") {
      nom = nom.replace(/^(Seccion del Ies) /i, "");
    }
    if (abr == "EOI") {
      nom = nom.replace(/^(e\.o\.i\. de) /i, "");
    }
    if (abr == "EXEOI") {
      nom = nom.replace(/^(Extension de la Escuela Oficial de Idiomas de) /i, "");
    }
    if (abr == "ES ARTE") {
      nom = nom.replace(/^(Escuela de Arte de) /i, "");
    }
    if (abr == "ES CANTO") {
      nom = nom.replace(/^(Real )?Escuela Superior de Canto de /i, "");
    }
    if (abr == "CPR DANZA") {
      nom = nom.replace(/^(Real )?Conservatorio Profesional de Danza( de)? /i, "");
    }
    if (abr == "CSU MUS") {
      nom = nom.replace(/^(Real )?Conservatorio Superior de Musica de /i, "");
    }
    if (abr == "CPR MUS") {
      nom = nom.replace(/^(Real )?Conservatorio Profesional de Musica de /i, "");
    }
    if (c.id == 28034428 && abr=="ES ARTE" && nom.toLocaleLowerCase()=="real escuela superior de arte dramatico") {
      nom = "Madrid";
    }
    if (c.id == 28037821 && abr=="ES CRBC" && nom.toLocaleLowerCase()=="escuela superior conservacion y restauracion bienes culturales") {
      nom = "Madrid";
    }
    if (c.id == 28072508 && abr=="ES DISEÑO" && nom.toLocaleLowerCase()=="escuela superior de diseño") {
      nom = "Madrid";
    }
    nom = smart_title(nom);
    nom = nom.replace(/\bS\./gi, "S.");
    nom = nom.replace(/\bS\.mart/i, "S. Mart");
    return nom;
}

export {
  parseName,
  DBConcurso,
  Centro,
  Concurso
};
