import { InputBoolean, InputGroupBoolean, SelectNumber, InputNumber, SelectString, FormField } from "./form";
import { decodeArray, encodeArray } from "./query_number";
import { Peticion, PUESTOS_DEFECTO, decodePeticiones, encodePeticiones, samePeticion } from "./peticiones";

const DELTA=28000000;


export class State {
    public static readonly SELECCIONADO = 1;
    public static readonly DESCARTADO = 2;
    private readonly __centros = new Map<number, number>();
    private static __instance: State | null = null;
    public readonly tipo = new InputGroupBoolean("#tipos input", [], "", "t");
    public readonly kms = new InputNumber("#kms", null, "km");
    public readonly jornada = new SelectString("#jornada", null, 'j');
    public readonly accesibilidad = new SelectString("#accesibilidad", null, 'acc');
    public readonly etapa = new SelectNumber("#etapa", null, 'e');
    public readonly fpdual = new SelectString("#fpdual", null, 'fp');
    public readonly ensenanza = new SelectString("#ensenanza", null, 'en');
    public readonly alumnosMin = new InputNumber("#alu_min", null, 'amin');
    public readonly alumnosMax = new InputNumber("#alu_max", null, 'amax');
    public readonly nocturno = new InputBoolean("#nocturno", true, 'noc');
    public readonly dificultad = new InputBoolean("#dificultad", true, 'dif');
    public readonly excelencia = new InputBoolean("#excelencia", true, 'exc');
    public readonly innovacion = new InputBoolean("#innovacion", true, 'inn');
    public readonly idioma = new InputGroupBoolean("input[name='idioma']", [], "");
    public readonly invertir = new InputBoolean("#invertir", false, "inv");
    public readonly areas = new InputBoolean("#areas", false, "are");
    public readonly estaciones = new InputBoolean("#estaciones", false, "e");
    public readonly transporte = new InputGroupBoolean(".metro input, .cercanias input, .metro_ligero input", [], "t");
    private __circleMarker: null|[number, number] = null;
    private readonly __onchange: EventListener[] = [];
    private __peticiones: Peticion[] = [];
    private readonly __onpeticiones: (() => void)[] = [];

    static getState() {
        if (State.__instance == null) {
            State.__instance = new State();
            State.__instance.__init();
        }
        return State.__instance;
    }

    public getCircleMarker() {
        return this.__circleMarker;
    }

    public setCircleMarker(lat: number| null, lng: number | null) {
        if (lat == null || lng == null) {
            if (this.__circleMarker == null) return;
            this.__circleMarker = null;
        } else {
            if (this.__circleMarker!=null && this.__circleMarker[0] == lat && this.__circleMarker[1] == lng) return false;
            this.__circleMarker = [lat, lng];
        }
        this.toQuerty();
        return true;
    }

    public setMarca(id: number, val:number|null) {
        if (val === null) {
            if (!this.__centros.has(id)) return false;
            this.__centros.delete(id)
        } else {
            if (this.__centros.get(id) === val) return false;
            this.__centros.set(id, val)
        }
        // Un centro seleccionado es una petición de centro, y viceversa
        if (val === State.SELECCIONADO) {
            this.__addPeticion({t: "c", id: id.toString(), puestos: PUESTOS_DEFECTO});
        } else {
            this.__peticiones = this.__peticiones.filter(p => !(p.t == "c" && p.id == id.toString()));
        }
        this.toQuerty();
        this.__firePeticiones();
        return true;
    }

    /* ---------- Peticiones ordenadas ---------- */

    public getPeticiones(): readonly Peticion[] {
        return this.__peticiones;
    }

    public onPeticiones(fnc: () => void) {
        this.__onpeticiones.push(fnc);
    }

    private __firePeticiones() {
        this.__onpeticiones.forEach(f => f());
    }

    private __addPeticion(p: Peticion) {
        if (this.__peticiones.some(x => samePeticion(x, p))) return false;
        this.__peticiones.push(p);
        return true;
    }

    /** Añade al final una petición de localidad/distrito o DAT (los centros se añaden con setMarca) */
    public addPeticion(p: Peticion) {
        if (p.t == "c") return this.setMarca(Number(p.id), State.SELECCIONADO);
        if (!this.__addPeticion(p)) return false;
        this.toQuerty();
        this.__firePeticiones();
        return true;
    }

    public hasPeticion(p: Omit<Peticion, "puestos">) {
        return this.__peticiones.some(x => x.t == p.t && x.id == p.id);
    }

    public removePeticion(i: number) {
        const p = this.__peticiones[i];
        if (p == null) return false;
        this.__peticiones.splice(i, 1);
        // Si era la última petición de ese centro, deja de estar seleccionado
        if (p.t == "c" && !this.__peticiones.some(x => samePeticion(x, p))) {
            this.__centros.delete(Number(p.id));
        }
        this.toQuerty();
        this.__firePeticiones();
        return true;
    }

    /** Duplica una petición justo debajo (para pedir el mismo destino con otros tipos de puesto) */
    public duplicatePeticion(i: number) {
        const p = this.__peticiones[i];
        if (p == null) return false;
        this.__peticiones.splice(i + 1, 0, {...p, puestos: []});
        this.toQuerty();
        this.__firePeticiones();
        return true;
    }

    public movePeticion(from: number, to: number) {
        const n = this.__peticiones.length;
        to = Math.max(0, Math.min(n - 1, to));
        if (from == to || from < 0 || from >= n) return false;
        const [p] = this.__peticiones.splice(from, 1);
        this.__peticiones.splice(to, 0, p);
        this.toQuerty();
        this.__firePeticiones();
        return true;
    }

    public setPuestos(i: number, puestos: string[]) {
        const p = this.__peticiones[i];
        if (p == null) return false;
        this.__peticiones[i] = {...p, puestos: Array.from(new Set(puestos)).sort()};
        this.toQuerty();
        this.__firePeticiones();
        return true;
    }

    public getMarca(id: number) {
        return this.__centros.get(id)
    }

    private __getImputs() {
        const arr: FormField<any, any>[] = [];
        for (const [k, v] of Object.entries(this)) {
            if (v instanceof FormField) {
                arr.push(v)
            }
        }
        return arr;
    }

    private __init() {
        this.__addEventListener(
            () => {this.toQuerty()},
            ...this.__getImputs().flatMap(i=>i.node),
        );
        window.addEventListener(
            "popstate",
            () => {this.toForm()}
        );
        this.toForm()
    }

    toForm() {
        this.__getImputs().forEach(i=>i.reset());
        this.__centros.clear()
        this.__peticiones = [];
        const old = this.getQuerty()
        const qr = new URLSearchParams((new URL(document.location.href)).search);
        const gt = (k:string) => (qr.get(k)??"").split(',').flatMap((i) => {return (i=i.trim()).length?i:[]});
        [
            this.accesibilidad,
            this.jornada,
            this.etapa,
            this.kms,
            this.fpdual,
            this.ensenanza,
            this.alumnosMin,
            this.alumnosMax
        ].forEach((i) => {
            const v = qr.get(i.qr);
            if(v!=null) return i.set(v);
        });
        const qr_trans = gt(this.transporte.qr).flatMap((i) => {
            if (i == 'e') {
                this.estaciones.set(true);
                return [];
            }
            if (i.match(/^\d+$/)) return `metro_${i}`;
            if (i.match(/^C\d+$/)) return `cercanias_${i}`; 
            if (i.match(/^ML\d+$/)) return `metro_ligero_${i}`; 
            return [];
        });
        if (qr_trans.length) {
            this.transporte.set(qr_trans);
        }
        const center_filter = (marca: number) => {
            return (i: string) => {
                const m = i.match(/^ctr(.+)$/);
                if (m == null) return true;
                decodeArray(m[1]).forEach(c=>this.__centros.set(c+DELTA, marca));
                return false;
            }
        }
        const ko = gt('ko').filter(center_filter(State.DESCARTADO));
        const ok = gt('ok').filter(center_filter(State.SELECCIONADO));
        decodePeticiones(qr.get('p')).forEach(p => {
            // permite repetir destino con distintos tipos de puesto
            this.__peticiones.push(p);
            if (p.t == "c") this.__centros.set(Number(p.id), State.SELECCIONADO);
        });
        // URLs antiguas: centros seleccionados sin petición -> al final de la lista
        this.__centros.forEach((v, k) => {
            if (v === State.SELECCIONADO) this.__addPeticion({t: "c", id: k.toString(), puestos: PUESTOS_DEFECTO});
        });
        [
            this.nocturno,
            this.dificultad,
            this.excelencia,
            this.innovacion,
            this.invertir,
            this.areas,
        ].forEach((i) => {
            if (ko.includes(i.qr)) i.set(false);
            if (ok.includes(i.qr)) i.set(true);
        })
        this.tipo.set(this.tipo.getOptions().filter(i=>!ko.includes(i)));
        this.idioma.set(this.idioma.getOptions().filter(i=>!ko.includes(i)));
        const ll = gt("ll").flatMap(i=>{
            const x = parseFloat(i);
            return isNaN(x)?[]:x;
        });
        this.__circleMarker = ll.length==2?[ll[0],ll[1]]:null;
        const nw = this.getQuerty()
        this.__firePeticiones();
        if (old == nw) return;
        this.__onchange.forEach(f=>f(new Event("change")));
        
    }
    getQuerty() {
        const qr: string[] = [];
        const ok: string[] = [];
        const ko: string[] = [];
        [
            this.accesibilidad,
            this.jornada,
            this.etapa,
            this.kms,
            this.fpdual,
            this.ensenanza,
            this.alumnosMin,
            this.alumnosMax
        ].forEach((i) => {
            const v = i.get()
            if(v!=null) return qr.push(`${i.qr}=${v}`);
        });
        let qr_trans = this.transporte.get().map(x=>x.replace(/.*_/, "")).join(',');
        if (qr_trans.length) {
            if (this.estaciones.get() === true) qr_trans = `${this.estaciones.qr},${qr_trans}`;
            qr.push(`${this.transporte.qr}=${qr_trans}`);
        }
        [
            ...this.tipo.getKo(),
            ...this.idioma.getKo()
        ].forEach(t=>{
            ko.push(t);
        });
        [
            this.nocturno,
            this.dificultad,
            this.excelencia,
            this.innovacion
        ].forEach((i) => {
            if(i.get() === false) ko.push(i.qr);
        });
        [
            this.invertir,
            this.areas,
        ].forEach((i) => {
            if(i.get() === true) ok.push(i.qr);
        })
        const ko_centro: number[] = [];
        // Los seleccionados ya van, ordenados, en las peticiones (p=...)
        this.__centros.forEach((v, k) => {
            if (v === State.DESCARTADO) ko_centro.push(k-DELTA);
        });
        if (ko_centro.length) ko.push("ctr"+encodeArray(ko_centro));
        if (ok.length) qr.push("ok="+ok.join(','));
        if (ko.length) qr.push("ko="+ko.join(','));
        if (this.__peticiones.length) qr.push("p="+encodePeticiones(this.__peticiones));
        if (this.__circleMarker) qr.push(`ll=${this.__circleMarker[0]},${this.__circleMarker[1]}`);
        const query = qr.length==0?"":("?"+qr.join("&"));
        return query;
    }
    toQuerty() {
        const query = this.getQuerty();
        if (document.location.search == query) return;
        const url = document.location.href.replace(/\?.*$/, "");
        history.pushState({}, "", url + query);
    }

    getInputsFiltro() {
        return  [
            ...this.tipo.node,
            this.kms.node,
            this.jornada.node,
            this.etapa.node,
            this.nocturno.node,
            this.dificultad.node,
            this.excelencia.node,
            this.innovacion.node,
            ...this.idioma.node,
            this.accesibilidad.node,
            this.invertir.node,
            this.fpdual.node,
            this.ensenanza.node,
            this.alumnosMin.node,
            this.alumnosMax.node
        ]
    }
    getInputsTransporte() {
        return [
            ...this.transporte.node,
            this.estaciones.node,
        ]
    }

    onFiltro(fnc: EventListener) {
        this.__addEventListener(
            fnc,
            ...this.getInputsFiltro()
        );
    }

    onTransporte(fnc: EventListener) {
        this.__addEventListener(
            fnc,
            ...this.getInputsTransporte()
        )
    }

    onAreas(fnc: EventListener) {
        this.__addEventListener(
            fnc,
            this.areas.node,
        );
    }

    private __addEventListener(fnc: EventListener, ...nodes: (HTMLElement|null)[]) {
        const done = nodes.flatMap((i) => {
            if (i === null) return [];
            const e = i.getAttribute("type") == "checkbox" ? "click" : "change";
            i.addEventListener(e, fnc);
            return i;
        });
        if (done.length) this.__onchange.push(fnc);
    }
}