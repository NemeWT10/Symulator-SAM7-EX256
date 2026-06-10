/* ============================================================
 * Symulator SAM7-EX256 — kompilator C
 * cc_gen.js — analiza semantyczna + generacja kodu JS
 *
 * Model pamięci:
 *   0x00010000..0x0007FFFF  "adresy" funkcji (poza pamięcią danych)
 *   0x00200000..0x005FFFFF  dane (globale, sterta, stos) — bufor 4 MB
 *   >= 0xF0000000           rejestry peryferiów (MMIO)
 * Wartości int — kanonicznie ze znakiem (|0); wskaźniki — bez znaku (>>>0).
 * Każda funkcja C → function* (generator); yield przy wyczerpaniu paliwa.
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC || (g.CC = {});
  var T = CC.T;

  var MEM_BASE = 0x00200000;
  var MEM_SIZE = 0x00400000; // 4 MB
  var FN_BASE = 0x00010000;
  var STACK_SIZE = 0x40000;  // 256 KB wirtualnego stosu

  CC.MEM_BASE = MEM_BASE;
  CC.MEM_SIZE = MEM_SIZE;
  CC.FN_BASE = FN_BASE;
  CC.STACK_SIZE = STACK_SIZE;

  /* ---------- operacje na typach ---------- */
  function isInt(t) { return t.k === 'int'; }
  function isFlt(t) { return t.k === 'flt'; }
  function isPtr(t) { return t.k === 'ptr'; }
  function isArr(t) { return t.k === 'arr'; }
  function isNum(t) { return t.k === 'int' || t.k === 'flt'; }
  function isScalar(t) { return isNum(t) || isPtr(t); }

  function alignOf(t) {
    switch (t.k) {
      case 'int': return t.size;
      case 'flt': return t.size === 8 ? 8 : 4;
      case 'ptr': return 4;
      case 'arr': return alignOf(t.of);
      case 'su': return t.align || 4;
      default: return 4;
    }
  }
  function alignUp(x, a) { return (x + a - 1) & ~(a - 1); }

  /* ---------- kompilator ---------- */
  function Compiler(project, sysHeaders) {
    // project: {files: [{name, text}]}
    this.project = project;
    this.sysHeaders = sysHeaders; // Map nazwa(znormalizowana) -> tekst
    this.diags = [];
    this.units = [];
    this.globals = new Map();   // name -> sym {kind:'var'|'fn', ...}
    this.fnTable = [];          // [{name, jsName, unit, node}]
    this.strings = new Map();   // treść -> addr
    this.image = [];            // {addr, bytes}
    this.allocPtr = MEM_BASE;
    this.heapBase = 0;
    this.jsParts = [];
    this.fileNames = [];
    this.errLimitHit = false;
    this.tmpCnt = 0;
    this.lblCnt = 0;
  }
  CC.Compiler = Compiler;
  var C = Compiler.prototype;

  C.error = function (msg, loc) {
    this.diags.push({
      sev: 'error', msg: msg,
      file: loc ? (this.fileNames[loc.f] || '?') : '?', line: loc ? loc.l : 0
    });
    if (this.diags.filter(function (d) { return d.sev === 'error'; }).length > 60 && !this.errLimitHit) {
      this.errLimitHit = true;
      throw new CC.CompileError('zbyt wiele błędów — przerwano kompilację', '?', 0);
    }
  };
  C.warn = function (msg, loc) {
    this.diags.push({
      sev: 'warning', msg: msg,
      file: loc ? (this.fileNames[loc.f] || '?') : '?', line: loc ? loc.l : 0
    });
  };

  /* ---------- wirtualny system plików include ---------- */
  function normName(n) {
    return String(n).replace(/\\/g, '/').toLowerCase().replace(/^\.\//, '');
  }
  C.makeFsResolver = function () {
    var files = this.project.files;
    var sys = this.sysHeaders;
    var byName = new Map();
    files.forEach(function (f) {
      byName.set(normName(f.name), f);
      var base = normName(f.name).split('/').pop();
      if (!byName.has(base)) byName.set(base, f);
    });
    return {
      resolve: function (name, fromPath, angled) {
        var nn = normName(name);
        var base = nn.split('/').pop();
        function fromProject() {
          var f = byName.get(nn) || byName.get(base);
          return f ? { path: f.name, text: f.text } : null;
        }
        function fromSys() {
          if (sys.has(nn)) return { path: '<' + nn + '>', text: sys.get(nn) };
          if (sys.has(base)) return { path: '<' + base + '>', text: sys.get(base) };
          return null;
        }
        if (angled) return fromSys() || fromProject();
        return fromProject() || fromSys();
      }
    };
  };

  /* ---------- główne wejście ---------- */
  C.compile = function () {
    var self = this;
    var fsr = this.makeFsResolver();
    var cFiles = this.project.files.filter(function (f) { return /\.c$/i.test(f.name); });
    if (!cFiles.length) {
      this.error('w projekcie nie ma żadnego pliku .c', null);
      return null;
    }

    // --- faza 0: preprocesor + parser dla każdej jednostki ---
    for (var i = 0; i < cFiles.length; i++) {
      var f = cFiles[i];
      var pp = new CC.Preprocessor(fsr);
      pp.define('__CROSSWORKS', '1');
      pp.define('__CROSSWORKS_ARM', '1');
      pp.define('__ARM_ARCH_4T__', '1');
      pp.define('__ARM', '1');
      pp.define('__RAM_BUILD', '1');
      pp.define('NDEBUG', '1');
      pp.define('__SAM7_SIM__', '1');
      var toks;
      try {
        toks = pp.run(f.name, f.text);
      } catch (e) {
        if (e instanceof CC.CompileError) { this.absorb(pp); return null; }
        throw e;
      }
      this.absorb(pp);
      var parser = new CC.Parser(toks, pp);
      var decls;
      try {
        decls = parser.parseUnit();
      } catch (e) {
        if (e instanceof CC.CompileError) { this.absorb(pp); return null; }
        throw e;
      }
      this.absorb(pp); // diagnostyka parsera (dzieli tablicę z pp)
      this.units.push({
        name: f.name, decls: decls, pp: pp,
        statics: new Map(), enums: new Map(), fileBase: this.fileNames.length
      });
      // scal nazwy plików (tok.f jest per-pp; przesuwamy o fileBase)
      for (var k = 0; k < pp.files.length; k++) this.fileNames.push(pp.files[k]);
    }
    if (this.hasErrors()) return null;

    // przesuń lokacje tokenów na globalne indeksy plików
    this.units.forEach(function (u) {
      shiftLocs(u.decls, u.fileBase);
    });

    // --- faza 1: symbole globalne ---
    for (var ui = 0; ui < this.units.length; ui++) {
      this.collectSymbols(this.units[ui]);
    }
    if (this.hasErrors()) return null;

    // --- faza 2: przydział adresów globali ---
    this.layoutGlobals();
    if (this.hasErrors()) return null;

    // --- faza 3: inicjalizatory globali (obraz pamięci) ---
    this.buildImages();
    if (this.hasErrors()) return null;

    // --- faza 4: kod funkcji ---
    for (var fi = 0; fi < this.fnTable.length; fi++) {
      var fn = this.fnTable[fi];
      if (fn.node) this.compileFunction(fn);
      else if (!fn.builtin) {
        this.error('funkcja "' + fn.name + '" jest zadeklarowana, ale nigdzie nie zdefiniowana', fn.loc);
      }
    }
    if (this.hasErrors()) return null;

    var mainSym = this.globals.get('main');
    if (!mainSym || mainSym.kind !== 'fn' || !this.fnTable[mainSym.idx].node) {
      this.error('brak funkcji main() w projekcie', null);
      return null;
    }

    this.heapBase = alignUp(this.allocPtr, 8);

    // --- składanie modułu ---
    var src = this.assembleModule(mainSym.idx);
    return {
      source: src,
      image: this.image,
      heapBase: this.heapBase,
      fileNames: this.fileNames,
      mainIdx: mainSym.idx,
      fnNames: this.fnTable.map(function (f) { return f.name; }),
      symbols: this.exportSymbols(),
      diags: this.diags
    };
  };

  /* ---------- eksport symboli (podgląd zmiennych w IDE) ---------- */
  C.descType = function (t, depth) {
    if (!t) return { k: '?' };
    switch (t.k) {
      case 'int': return { k: 'i', s: t.size, sg: !!t.sg };
      case 'flt': return { k: 'f', s: t.size };
      case 'ptr': return { k: 'p', s: 4 };
      case 'arr': {
        var n = t.n === null ? 0 : t.n;
        if (t.of && t.of.k === 'int' && t.of.size === 1) return { k: 'cs', n: n, s: n };
        if (depth >= 1) return { k: 'aa', n: n };
        if (t.of && (t.of.k === 'int' || t.of.k === 'flt' || t.of.k === 'ptr')) {
          var e = this.descType(t.of, depth + 1);
          return { k: 'a', n: n, e: e, es: this.sizeOf(t.of, null) };
        }
        if (t.of && t.of.k === 'arr') {
          var n2 = t.of.n === null ? 0 : t.of.n;
          return { k: 'aa', n: n, n2: n2 };
        }
        return { k: 'aa', n: n };
      }
      case 'su': {
        if (depth >= 1) return { k: '?', s: t.size || 0 };
        var fields = [];
        var fs = t.fields || [];
        for (var i = 0; i < fs.length && fields.length < 8; i++) {
          var f = fs[i];
          if (f.type.k === 'int' || f.type.k === 'flt' || f.type.k === 'ptr') {
            fields.push({ n: f.name, off: f.off, d: this.descType(f.type, depth + 1) });
          }
        }
        return { k: 's', s: t.size || 0, fields: fields };
      }
    }
    return { k: '?' };
  };

  C.exportSymbols = function () {
    var self = this;
    var out = [];
    function add(name, sym, unitName) {
      if (sym.kind !== 'var' || sym.addr === undefined) return;
      out.push({
        name: name,
        unit: (sym.defUnit && sym.defUnit.name) || unitName || sym.unit || '?',
        addr: sym.addr >>> 0,
        size: sym.size || 0,
        d: self.descType(sym.type, 0)
      });
    }
    this.globals.forEach(function (sym, name) { add(name, sym, null); });
    this.units.forEach(function (u) {
      u.statics.forEach(function (sym, name) { add(name + ' [static]', sym, u.name); });
    });
    out.sort(function (a, b) {
      var am = /main\.c$/i.test(a.unit) ? 0 : 1;
      var bm = /main\.c$/i.test(b.unit) ? 0 : 1;
      return am - bm || a.unit.localeCompare(b.unit) || a.name.localeCompare(b.name);
    });
    return out;
  };

  C.absorb = function (pp) {
    var self = this;
    pp.diags.forEach(function (d) { self.diags.push(d); });
    pp.diags.length = 0;
  };
  C.hasErrors = function () {
    return this.diags.some(function (d) { return d.sev === 'error'; });
  };

  function shiftLocs(node, base) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(function (n) { shiftLocs(n, base); }); return; }
    if (node.loc && typeof node.loc.f === 'number' && !node.loc._sh) {
      node.loc.f += base; node.loc._sh = 1;
    }
    for (var k in node) {
      if (k === 'loc' || k === 'type') continue;
      var v = node[k];
      if (v && typeof v === 'object') shiftLocs(v, base);
    }
  }

  /* ---------- builtins ---------- */
  var BUILTIN_SIGS = null;
  function builtinSigs() {
    if (BUILTIN_SIGS) return BUILTIN_SIGS;
    var d = T.tDouble, i4 = T.tInt, u4 = T.tUInt, v = T.tVoid;
    var pc = T.ptr(T.tChar), pcc = T.ptr(T.tChar), pv = T.ptr(T.tVoid);
    function s(ret, params, varargs) { return { ret: ret, params: params, varargs: !!varargs }; }
    BUILTIN_SIGS = {
      sin: s(d, [d]), cos: s(d, [d]), tan: s(d, [d]), asin: s(d, [d]), acos: s(d, [d]),
      atan: s(d, [d]), atan2: s(d, [d, d]), sqrt: s(d, [d]), pow: s(d, [d, d]),
      exp: s(d, [d]), log: s(d, [d]), log10: s(d, [d]), fabs: s(d, [d]),
      floor: s(d, [d]), ceil: s(d, [d]), fmod: s(d, [d, d]), round: s(d, [d]),
      sinf: s(d, [d]), cosf: s(d, [d]), sqrtf: s(d, [d]), fabsf: s(d, [d]),
      abs: s(i4, [i4]), labs: s(i4, [i4]),
      rand: s(i4, []), srand: s(v, [u4]),
      memset: s(pv, [pv, i4, u4]), memcpy: s(pv, [pv, pv, u4]), memmove: s(pv, [pv, pv, u4]),
      memcmp: s(i4, [pv, pv, u4]),
      strlen: s(u4, [pc]), strcpy: s(pc, [pc, pc]), strncpy: s(pc, [pc, pc, u4]),
      strcat: s(pc, [pc, pc]), strcmp: s(i4, [pc, pc]), strncmp: s(i4, [pc, pc, u4]),
      strchr: s(pc, [pc, i4]), strstr: s(pc, [pc, pc]),
      sprintf: s(i4, [pc, pc], true), snprintf: s(i4, [pc, u4, pc], true),
      printf: s(i4, [pc], true), puts: s(i4, [pc]), putchar: s(i4, [i4]),
      debug_printf: s(i4, [pc], true),
      malloc: s(pv, [u4]), calloc: s(pv, [u4, u4]), free: s(v, [pv]),
      atoi: s(i4, [pc]), atol: s(i4, [pc]),
      libarm_enable_irq: s(v, []), libarm_disable_irq: s(v, []),
      libarm_enable_fiq: s(v, []), libarm_disable_fiq: s(v, [])
    };
    return BUILTIN_SIGS;
  }

  /* ---------- faza 1: zbieranie symboli ---------- */
  C.collectSymbols = function (unit) {
    var self = this;
    for (var i = 0; i < unit.decls.length; i++) {
      var d = unit.decls[i];
      if (d.t === 'enumdef') {
        var val = 0;
        for (var m = 0; m < d.members.length; m++) {
          var mem = d.members[m];
          if (mem.expr) {
            var cv = this.constEval(mem.expr, unit);
            if (cv === null || cv.addr !== undefined) {
              this.error('wartość elementu enum "' + mem.name + '" musi być stałą całkowitą', mem.loc);
              cv = { v: 0 };
            }
            val = cv.v | 0;
          }
          unit.enums.set(mem.name, val);
          val++;
        }
        continue;
      }
      if (d.t === 'func') {
        this.registerFunction(unit, d);
        continue;
      }
      if (d.t === 'decl') {
        for (var j = 0; j < d.items.length; j++) {
          var it = d.items[j];
          if (!it.name) continue;
          if (it.type.k === 'fn') {
            this.registerFnDecl(unit, it);
          } else {
            this.registerGlobalVar(unit, it);
          }
        }
      }
    }
  };

  C.registerFunction = function (unit, d) {
    var tab = d.static ? unit.statics : this.globals;
    var prev = tab.get(d.name);
    if (prev && prev.kind === 'fn' && this.fnTable[prev.idx].node) {
      this.error('powtórna definicja funkcji "' + d.name + '"' +
        (prev.unit !== unit.name ? ' (poprzednia w ' + prev.unit + ')' : ''), d.loc);
      return;
    }
    if (prev && prev.kind === 'fn') {
      // była deklaracja
      var fe = this.fnTable[prev.idx];
      fe.node = d; fe.unit = unit;
      fe.type = d.type;
      prev.type = d.type;
      return;
    }
    if (prev) { this.error('"' + d.name + '" jest już zdefiniowane jako zmienna', d.loc); return; }
    var idx = this.fnTable.length;
    this.fnTable.push({
      name: d.name, jsName: 'F' + idx + '_' + safeId(d.name),
      unit: unit, node: d, type: d.type, loc: d.loc, builtin: false
    });
    tab.set(d.name, { kind: 'fn', idx: idx, type: d.type, unit: unit.name, static: d.static });
  };

  C.registerFnDecl = function (unit, it) {
    var tab = it.static ? unit.statics : this.globals;
    var prev = tab.get(it.name);
    if (prev) return; // już znane (definicja lub deklaracja)
    // builtin?
    var bs = builtinSigs()[it.name];
    var idx = this.fnTable.length;
    this.fnTable.push({
      name: it.name, jsName: 'F' + idx + '_' + safeId(it.name),
      unit: unit, node: null, type: it.type, loc: it.loc, builtin: !!bs
    });
    tab.set(it.name, { kind: 'fn', idx: idx, type: it.type, unit: unit.name, static: !!it.static });
  };

  C.registerGlobalVar = function (unit, it) {
    var tab = it.static ? unit.statics : this.globals;
    var prev = tab.get(it.name);
    if (it.extern && !it.init) {
      if (!prev) tab.set(it.name, { kind: 'var', type: it.type, declOnly: true, unit: unit.name, loc: it.loc });
      else if (prev.kind === 'var' && prev.declOnly && it.type.k === 'arr' && prev.type.k === 'arr') {
        // uzupełnij rozmiar jeśli znany
      }
      return;
    }
    if (prev && prev.kind === 'var') {
      if (prev.declOnly) {
        prev.declOnly = false;
        prev.type = it.type;
        prev.init = it.init || null;
        prev.loc = it.loc;
        prev.defUnit = unit;
        return;
      }
      if (it.init && prev.init) {
        this.error('powtórna definicja zmiennej globalnej "' + it.name + '"' +
          (prev.unit !== unit.name ? ' (poprzednia w ' + prev.unit + ')' : ''), it.loc);
        return;
      }
      if (it.init) { prev.init = it.init; prev.type = it.type; prev.defUnit = unit; }
      return;
    }
    if (prev) { this.error('"' + it.name + '" jest już zdefiniowane jako funkcja', it.loc); return; }
    tab.set(it.name, {
      kind: 'var', type: it.type, init: it.init || null,
      unit: unit.name, defUnit: unit, loc: it.loc, static: !!it.static, declOnly: false
    });
  };

  function safeId(n) { return String(n).replace(/[^A-Za-z0-9_]/g, '_'); }

  /* ---------- typy: dokończenie / sizeof ---------- */
  C.completeType = function (t, unit, loc) {
    if (!t) return t;
    if (t.k === 'arr') {
      this.completeType(t.of, unit, loc);
      if (t.n === null && t.nExpr) {
        var cv = this.constEval(t.nExpr, unit);
        if (cv === null || cv.addr !== undefined || cv.fv !== undefined) {
          this.error('rozmiar tablicy musi być stałą całkowitą', loc);
          t.n = 1;
        } else {
          t.n = cv.v | 0;
          if (t.n < 0) { this.error('ujemny rozmiar tablicy', loc); t.n = 0; }
        }
      }
      return t;
    }
    if (t.k === 'su' && t.size === null && t.fields) {
      var off = 0, maxAlign = 1;
      for (var i = 0; i < t.fields.length; i++) {
        var f = t.fields[i];
        this.completeType(f.type, unit, f.loc);
        var fs = this.sizeOf(f.type, f.loc);
        var fa = alignOf(f.type);
        if (fa > maxAlign) maxAlign = fa;
        if (t.union) { f.off = 0; if (fs > off) off = fs; }
        else { off = alignUp(off, fa); f.off = off; off += fs; }
      }
      t.align = maxAlign;
      t.size = alignUp(off, maxAlign) || (t.fields.length ? alignUp(off, maxAlign) : 0);
      if (t.size === 0) t.size = 1;
      return t;
    }
    return t;
  };

  C.sizeOf = function (t, loc) {
    switch (t.k) {
      case 'void': return 1; // sizeof(void)=1 (GNU)
      case 'int': case 'flt': return t.size;
      case 'ptr': return 4;
      case 'arr': {
        if (t.n === null) { this.error('rozmiar tablicy nieznany (tablica niedokończona)', loc); return 0; }
        return t.n * this.sizeOf(t.of, loc);
      }
      case 'su': {
        if (t.size === null || t.size === undefined) {
          if (t.fields) this.completeType(t, null, loc);
          if (t.size === null || t.size === undefined) {
            this.error('użycie niezdefiniowanej struktury "' + (t.tag || '?') + '"', loc);
            return 0;
          }
        }
        return t.size;
      }
      case 'fn': return 4;
    }
    return 4;
  };

  /* ---------- stałe wyrażenia ----------
   * zwraca {v:int} | {fv:double} | {addr:uint} | null  */
  C.constEval = function (e, unit) {
    var self = this;
    if (!e) return null;
    switch (e.t) {
      case 'num':
        if (e.v.fl) return { fv: e.v.n };
        return { v: e.v.n | 0 };
      case 'str':
        return { addr: this.internString(e.v) };
      case 'id': {
        if (unit && unit.enums.has(e.name)) return { v: unit.enums.get(e.name) | 0 };
        // globalne enums z innych jednostek nie istnieją — enums są per-unit
        var sym = (unit && unit.statics.get(e.name)) || this.globals.get(e.name);
        if (sym && sym.kind === 'fn') return { addr: FN_BASE + sym.idx * 4 };
        if (sym && sym.kind === 'var' && sym.addr !== undefined) {
          var t = sym.type;
          if (t.k === 'arr' || t.k === 'fn') return { addr: sym.addr >>> 0 };
        }
        return null;
      }
      case 'un': {
        if (e.op === '&') {
          var lv = this.constAddr(e.e, unit);
          return lv === null ? null : { addr: lv >>> 0 };
        }
        var a = this.constEval(e.e, unit);
        if (a === null) return null;
        if (a.fv !== undefined) {
          switch (e.op) {
            case '-': return { fv: -a.fv };
            case '+': return a;
            case '!': return { v: a.fv === 0 ? 1 : 0 };
          }
          return null;
        }
        if (a.addr !== undefined) return null;
        switch (e.op) {
          case '-': return { v: (-a.v) | 0 };
          case '+': return a;
          case '~': return { v: (~a.v) | 0 };
          case '!': return { v: a.v === 0 ? 1 : 0 };
        }
        return null;
      }
      case 'bin': {
        var x = this.constEval(e.a, unit);
        var y = this.constEval(e.b, unit);
        if (x === null || y === null) return null;
        // adres ± stała
        if (x.addr !== undefined || y.addr !== undefined) {
          if (e.op === '+' && x.addr !== undefined && y.v !== undefined) return { addr: (x.addr + y.v) >>> 0 };
          if (e.op === '+' && y.addr !== undefined && x.v !== undefined) return { addr: (y.addr + x.v) >>> 0 };
          if (e.op === '-' && x.addr !== undefined && y.v !== undefined) return { addr: (x.addr - y.v) >>> 0 };
          return null;
        }
        if (x.fv !== undefined || y.fv !== undefined) {
          var fa = x.fv !== undefined ? x.fv : x.v;
          var fb = y.fv !== undefined ? y.fv : y.v;
          switch (e.op) {
            case '+': return { fv: fa + fb }; case '-': return { fv: fa - fb };
            case '*': return { fv: fa * fb }; case '/': return { fv: fa / fb };
            case '<': return { v: fa < fb ? 1 : 0 }; case '>': return { v: fa > fb ? 1 : 0 };
            case '<=': return { v: fa <= fb ? 1 : 0 }; case '>=': return { v: fa >= fb ? 1 : 0 };
            case '==': return { v: fa === fb ? 1 : 0 }; case '!=': return { v: fa !== fb ? 1 : 0 };
          }
          return null;
        }
        var a2 = x.v | 0, b2 = y.v | 0;
        switch (e.op) {
          case '+': return { v: (a2 + b2) | 0 }; case '-': return { v: (a2 - b2) | 0 };
          case '*': return { v: Math.imul(a2, b2) };
          case '/': return b2 === 0 ? null : { v: (a2 / b2) | 0 };
          case '%': return b2 === 0 ? null : { v: (a2 % b2) | 0 };
          case '<<': return { v: a2 << (b2 & 31) }; case '>>': return { v: a2 >> (b2 & 31) };
          case '&': return { v: a2 & b2 }; case '|': return { v: a2 | b2 }; case '^': return { v: a2 ^ b2 };
          case '&&': return { v: (a2 !== 0 && b2 !== 0) ? 1 : 0 };
          case '||': return { v: (a2 !== 0 || b2 !== 0) ? 1 : 0 };
          case '==': return { v: a2 === b2 ? 1 : 0 }; case '!=': return { v: a2 !== b2 ? 1 : 0 };
          case '<': return { v: a2 < b2 ? 1 : 0 }; case '>': return { v: a2 > b2 ? 1 : 0 };
          case '<=': return { v: a2 <= b2 ? 1 : 0 }; case '>=': return { v: a2 >= b2 ? 1 : 0 };
        }
        return null;
      }
      case 'cond': {
        var c = this.constEval(e.c, unit);
        if (c === null) return null;
        var cv = c.fv !== undefined ? (c.fv !== 0) : (c.addr !== undefined ? true : c.v !== 0);
        return this.constEval(cv ? e.a : e.b, unit);
      }
      case 'cast': {
        var v = this.constEval(e.e, unit);
        if (v === null) return null;
        var tt = e.type;
        if (tt.k === 'ptr') {
          if (v.addr !== undefined) return v;
          if (v.v !== undefined) return { addr: v.v >>> 0 };
          return null;
        }
        if (tt.k === 'int') {
          var raw = v.addr !== undefined ? v.addr : (v.fv !== undefined ? Math.trunc(v.fv) : v.v);
          var m = raw | 0;
          if (tt.size === 1) m = tt.sg ? (m << 24 >> 24) : (m & 0xFF);
          else if (tt.size === 2) m = tt.sg ? (m << 16 >> 16) : (m & 0xFFFF);
          return { v: m | 0 };
        }
        if (tt.k === 'flt') {
          var fr = v.fv !== undefined ? v.fv : (v.addr !== undefined ? v.addr : (v.v | 0));
          return { fv: tt.size === 4 ? Math.fround(fr) : fr };
        }
        return null;
      }
      case 'sizeof': {
        var ty = e.type;
        if (!ty) ty = this.typeOfExprForSizeof(e.e, unit);
        if (!ty) return null;
        this.completeType(ty, unit, e.loc);
        return { v: this.sizeOf(ty, e.loc) | 0 };
      }
      case 'idx': case 'mem': {
        var ad = this.constAddr(e, unit);
        return null; // wartości spod adresów nie czytamy w czasie kompilacji
      }
    }
    return null;
  };

  // adres stałego lvalue (dla inicjalizatorów globali)
  C.constAddr = function (e, unit) {
    if (e.t === 'id') {
      var sym = (unit && unit.statics.get(e.name)) || this.globals.get(e.name);
      if (sym && sym.kind === 'var' && sym.addr !== undefined) return sym.addr;
      if (sym && sym.kind === 'fn') return FN_BASE + sym.idx * 4;
      return null;
    }
    if (e.t === 'idx') {
      var base = this.constAddr(e.a, unit);
      if (base === null) {
        var pv = this.constEval(e.a, unit);
        if (pv && pv.addr !== undefined) base = pv.addr;
        else return null;
      }
      var iv = this.constEval(e.i, unit);
      if (iv === null || iv.v === undefined) return null;
      var bt = this.typeOfExprForSizeof(e.a, unit);
      var et = bt && (bt.k === 'arr' ? bt.of : (bt.k === 'ptr' ? bt.to : null));
      if (!et) return null;
      return (base + iv.v * this.sizeOf(et, e.loc)) >>> 0;
    }
    if (e.t === 'str') return this.internString(e.v);
    if (e.t === 'un' && e.op === '*') {
      var p = this.constEval(e.e, unit);
      return (p && p.addr !== undefined) ? p.addr : null;
    }
    return null;
  };

  // przybliżony typ wyrażenia dla sizeof w stałych (globalne identyfikatory)
  C.typeOfExprForSizeof = function (e, unit) {
    if (!e) return null;
    switch (e.t) {
      case 'id': {
        var sym = (unit && unit.statics.get(e.name)) || this.globals.get(e.name);
        if (sym && sym.kind === 'var') return sym.type;
        if (sym && sym.kind === 'fn') return sym.type;
        if (unit && unit.enums.has(e.name)) return T.tInt;
        return null;
      }
      case 'str': return T.arr(T.tChar, null), { k: 'arr', of: T.tChar, n: e.v.length + 1, nExpr: null };
      case 'num': return e.v.fl ? T.tDouble : T.tInt;
      case 'idx': {
        var bt = this.typeOfExprForSizeof(e.a, unit);
        if (!bt) return null;
        return bt.k === 'arr' ? bt.of : (bt.k === 'ptr' ? bt.to : null);
      }
      case 'un':
        if (e.op === '*') {
          var pt = this.typeOfExprForSizeof(e.e, unit);
          return pt && pt.k === 'ptr' ? pt.to : null;
        }
        if (e.op === '&') {
          var it = this.typeOfExprForSizeof(e.e, unit);
          return it ? T.ptr(it) : null;
        }
        return this.typeOfExprForSizeof(e.e, unit);
      case 'cast': return e.type;
      case 'mem': {
        var st = this.typeOfExprForSizeof(e.e, unit);
        if (st && st.k === 'ptr') st = st.to;
        if (st && st.k === 'su' && st.fields) {
          for (var i = 0; i < st.fields.length; i++)
            if (st.fields[i].name === e.name) return st.fields[i].type;
        }
        return null;
      }
    }
    return null;
  };

  /* ---------- napisy ---------- */
  C.internString = function (s) {
    if (this.strings.has(s)) return this.strings.get(s);
    var bytes = new Uint8Array(s.length + 1);
    for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xFF;
    bytes[s.length] = 0;
    var addr = this.allocBytes(bytes.length, 1);
    this.image.push({ addr: addr, bytes: bytes });
    this.strings.set(s, addr);
    return addr;
  };

  C.allocBytes = function (size, align) {
    this.allocPtr = alignUp(this.allocPtr, align || 4);
    var a = this.allocPtr;
    this.allocPtr += Math.max(size, 1);
    if (this.allocPtr > MEM_BASE + MEM_SIZE - STACK_SIZE - 0x100000) {
      throw new CC.CompileError('za dużo danych globalnych — przekroczono pamięć symulatora', '?', 0);
    }
    return a;
  };

  /* ---------- faza 2: layout globali ---------- */
  C.layoutGlobals = function () {
    var self = this;
    function place(name, sym, unit) {
      if (sym.kind !== 'var' || sym.addr !== undefined) return;
      if (sym.declOnly) {
        // extern bez definicji — może builtin? nie. Błąd dopiero przy użyciu.
        return;
      }
      var u = sym.defUnit || unit;
      self.completeType(sym.type, u, sym.loc);
      // tablica bez rozmiaru z inicjalizatorem
      if (sym.type.k === 'arr' && sym.type.n === null) {
        if (sym.init && sym.init.t === 'ilist') sym.type.n = sym.init.items.length;
        else if (sym.init && sym.init.t === 'str') sym.type.n = sym.init.v.length + 1;
        else { self.error('tablica "' + name + '" bez rozmiaru i bez inicjalizatora', sym.loc); sym.type.n = 1; }
      }
      var size = self.sizeOf(sym.type, sym.loc);
      sym.addr = self.allocBytes(size, alignOf(sym.type));
      sym.size = size;
    }
    this.globals.forEach(function (sym, name) { place(name, sym, null); });
    this.units.forEach(function (u) {
      u.statics.forEach(function (sym, name) { place(name, sym, u); });
    });
  };

  /* ---------- faza 3: obrazy inicjalizatorów ---------- */
  C.buildImages = function () {
    var self = this;
    function build(sym, unit) {
      if (sym.kind !== 'var' || !sym.init || sym.addr === undefined) return;
      var bytes = new Uint8Array(sym.size);
      var dv = new DataView(bytes.buffer);
      var ok = self.writeInit(dv, 0, sym.type, sym.init, sym.defUnit || unit, sym.loc);
      self.image.push({ addr: sym.addr, bytes: bytes });
    }
    this.globals.forEach(function (sym) { build(sym, null); });
    this.units.forEach(function (u) {
      u.statics.forEach(function (sym) { build(sym, u); });
    });
  };

  // zapis inicjalizatora do obrazu; obsługuje płaskie listy dla tablic wielowymiarowych
  C.writeInit = function (dv, off, type, init, unit, loc) {
    var self = this;
    this.completeType(type, unit, loc);
    if (init && init.t === 'ilist') {
      var cursor = { items: init.items, pos: 0 };
      this.fillAggregate(dv, off, type, cursor, unit, loc);
      if (cursor.pos < cursor.items.length) {
        this.warn('nadmiarowe elementy inicjalizatora', loc);
      }
      return true;
    }
    return this.writeScalarInit(dv, off, type, init, unit, loc);
  };

  C.fillAggregate = function (dv, off, type, cursor, unit, loc) {
    var self = this;
    if (type.k === 'arr') {
      var et = type.of, esz = this.sizeOf(et, loc);
      var n = type.n === null ? cursor.items.length : type.n;
      for (var i = 0; i < n; i++) {
        if (cursor.pos >= cursor.items.length) break;
        var item = cursor.items[cursor.pos];
        if (item && item.t === 'ilist') {
          cursor.pos++;
          var sub = { items: item.items, pos: 0 };
          this.fillAggregate(dv, off + i * esz, et, sub, unit, loc);
        } else if (et.k === 'arr' || (et.k === 'su')) {
          // płaska lista wypełnia zagnieżdżony agregat
          this.fillAggregate(dv, off + i * esz, et, cursor, unit, loc);
        } else {
          this.writeScalarInit(dv, off + i * esz, et, item, unit, loc);
          cursor.pos++;
        }
      }
      return;
    }
    if (type.k === 'su') {
      var fields = type.fields || [];
      for (var fi = 0; fi < fields.length; fi++) {
        if (cursor.pos >= cursor.items.length) break;
        var f = fields[fi];
        var item2 = cursor.items[cursor.pos];
        if (item2 && item2.t === 'ilist') {
          cursor.pos++;
          var sub2 = { items: item2.items, pos: 0 };
          this.fillAggregate(dv, off + f.off, f.type, sub2, unit, loc);
        } else if (f.type.k === 'arr' || f.type.k === 'su') {
          this.fillAggregate(dv, off + f.off, f.type, cursor, unit, loc);
        } else {
          this.writeScalarInit(dv, off + f.off, f.type, item2, unit, loc);
          cursor.pos++;
        }
        if (type.union) break;
      }
      return;
    }
    // skalar w agregacie
    if (cursor.pos < cursor.items.length) {
      this.writeScalarInit(dv, off, type, cursor.items[cursor.pos], unit, loc);
      cursor.pos++;
    }
  };

  C.writeScalarInit = function (dv, off, type, init, unit, loc) {
    var self = this;
    if (!init) return true;
    // char tablica = "napis"
    if (type.k === 'arr' && init.t === 'str') {
      var et = type.of;
      if (et.k === 'int' && et.size === 1) {
        var n = type.n === null ? init.v.length + 1 : type.n;
        for (var i = 0; i < n; i++) {
          var b = i < init.v.length ? (init.v.charCodeAt(i) & 0xFF) : 0;
          if (off + i < dv.byteLength) dv.setUint8(off + i, b);
        }
        return true;
      }
    }
    if (type.k === 'arr' || type.k === 'su') {
      if (init.t === 'ilist') return this.writeInit(dv, off, type, init, unit, loc);
      this.error('niepoprawny inicjalizator agregatu', init.loc || loc);
      return false;
    }
    var cv = this.constEval(init, unit);
    if (cv === null) {
      this.error('inicjalizator zmiennej globalnej musi być stałą', init.loc || loc);
      return false;
    }
    var val;
    if (type.k === 'flt') {
      val = cv.fv !== undefined ? cv.fv : (cv.addr !== undefined ? cv.addr : cv.v);
      if (type.size === 4) dv.setFloat32(off, val, true);
      else dv.setFloat64(off, val, true);
      return true;
    }
    val = cv.addr !== undefined ? cv.addr : (cv.fv !== undefined ? Math.trunc(cv.fv) : cv.v);
    switch (type.size) {
      case 1: dv.setUint8(off, val & 0xFF); break;
      case 2: dv.setUint16(off, val & 0xFFFF, true); break;
      default: dv.setUint32(off, val >>> 0, true); break;
    }
    return true;
  };

  /* ============================================================
   * KOMPILACJA FUNKCJI
   * ============================================================ */
  C.compileFunction = function (fe) {
    var self = this;
    var d = fe.node;
    var unit = fe.unit;
    this.completeType(d.type.ret, unit, d.loc);

    var fc = {
      unit: unit,
      fnEntry: fe,
      lines: [],
      scopes: [new Map()],
      frameSize: 0,
      tmps: [],
      loopStack: [],   // {breakJS, continueJS}
      addrTaken: collectAddrTaken(d.body),
      switchDepth: 0,
      retType: d.type.ret,
      usesFp: false
    };

    // parametry
    var params = d.type.params || [];
    var argNames = [];
    for (var i = 0; i < params.length; i++) {
      var p = params[i];
      var pname = p.name || ('arg' + i);
      this.completeType(p.type, unit, p.loc || d.loc);
      var jsn = 'a' + i + '_' + safeId(pname);
      argNames.push(jsn);
      if (fc.addrTaken.has(pname) || p.type.k === 'su') {
        // parametr w pamięci
        var sz = alignUp(this.sizeOf(p.type, d.loc), 4);
        var off = fc.frameSize; fc.frameSize += sz;
        fc.scopes[0].set(pname, { kind: 'slot', off: off, type: p.type });
        fc.lines.push('/*param→slot*/');
        fc.lines.push(this.storeStmt({ js: 'fp+' + off, t: T.ptr(p.type) }, p.type,
          { js: jsn, t: p.type }) + ';');
      } else {
        fc.scopes[0].set(pname, { kind: 'var', js: jsn, type: p.type });
      }
    }

    // ciało
    var bodyLines = [];
    var saveLines = fc.lines;
    fc.lines = bodyLines;
    this.genStmt(d.body, fc);
    fc.lines = saveLines;

    var head = 'function* ' + fe.jsName + '(' + argNames.join(',') + '){\n';
    var pre = 'if((RT.fuel-=10)<=0)yield 0;\n';
    var frame = '';
    if (fc.frameSize > 0) {
      fc.frameSize = alignUp(fc.frameSize, 8);
      frame = 'var fp=RT.spDown(' + fc.frameSize + ');\n';
    }
    var tmpDecl = fc.tmps.length ? ('var ' + fc.tmps.join(',') + ';\n') : '';
    var paramSlots = fc.lines.length ? fc.lines.join('\n') + '\n' : '';
    var bodyTxt = bodyLines.join('\n');
    var tail = '\nreturn 0;\n';
    var src;
    if (fc.frameSize > 0) {
      src = head + pre + frame + tmpDecl + paramSlots +
        'try{\n' + bodyTxt + tail + '}finally{RT.spUp(' + fc.frameSize + ');}\n}';
    } else {
      src = head + pre + tmpDecl + paramSlots + bodyTxt + tail + '}';
    }
    fe.jsSrc = src;
  };

  function collectAddrTaken(body) {
    var set = new Set();
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.t === 'un' && n.op === '&' && n.e && n.e.t === 'id') set.add(n.e.name);
      for (var k in n) {
        if (k === 'loc' || k === 'type') continue;
        var v = n[k];
        if (v && typeof v === 'object') walk(v);
      }
    })(body);
    return set;
  }

  /* ---------- środowisko funkcji ---------- */
  C.lookup = function (name, fc) {
    for (var i = fc.scopes.length - 1; i >= 0; i--) {
      if (fc.scopes[i].has(name)) return fc.scopes[i].get(name);
    }
    if (fc.unit.enums.has(name)) return { kind: 'enum', v: fc.unit.enums.get(name) };
    var s = fc.unit.statics.get(name) || this.globals.get(name);
    if (s) {
      if (s.kind === 'fn') return { kind: 'fn', idx: s.idx, type: s.type };
      if (s.declOnly && s.addr === undefined) return { kind: 'gvarUndef', type: s.type, sym: s };
      return { kind: 'gvar', addr: s.addr, type: s.type };
    }
    return null;
  };

  C.newTmp = function (fc) {
    var t = 't' + (fc.tmps.length);
    fc.tmps.push(t);
    return t;
  };
  C.newLbl = function (p) { return p + (this.lblCnt++); };

  /* ---------- pomoc: ładowanie/zapis ---------- */
  // load: zwraca wyrażenie JS czytające wartość typu t spod addrJs
  C.loadExpr = function (addrJs, t) {
    if (t.k === 'int') {
      if (t.size === 1) return t.sg ? ('ld8(' + addrJs + ')') : ('ldu8(' + addrJs + ')');
      if (t.size === 2) return t.sg ? ('ld16(' + addrJs + ')') : ('ldu16(' + addrJs + ')');
      return 'ld32(' + addrJs + ')'; // kanonicznie |0 (też dla unsigned)
    }
    if (t.k === 'flt') return t.size === 4 ? ('lf32(' + addrJs + ')') : ('lf64(' + addrJs + ')');
    if (t.k === 'ptr') return '(ld32(' + addrJs + ')>>>0)';
    if (t.k === 'arr' || t.k === 'su') return '(' + addrJs + ')'; // agregat = adres
    if (t.k === 'fn') return '(ld32(' + addrJs + ')>>>0)';
    return 'ld32(' + addrJs + ')';
  };
  // store: instrukcja JS zapisująca val.js pod addr
  C.storeStmt = function (addrV, t, valV) {
    var a = addrV.js;
    var v = valV.js;
    if (t.k === 'int') {
      if (t.size === 1) return 'st8(' + a + ',' + v + ')';
      if (t.size === 2) return 'st16(' + a + ',' + v + ')';
      return 'st32(' + a + ',' + v + ')';
    }
    if (t.k === 'flt') return (t.size === 4 ? 'sf32(' : 'sf64(') + a + ',' + v + ')';
    if (t.k === 'ptr' || t.k === 'fn') return 'st32(' + a + ',' + v + ')';
    if (t.k === 'su') return 'RT.memcpy(' + a + ',' + v + ',' + t.size + ')';
    return 'st32(' + a + ',' + v + ')';
  };

  /* ---------- konwersje ---------- */
  C.convert = function (v, to, loc) {
    var from = v.t;
    if (!to || !from) return v;
    if (from === to) return v;
    if (to.k === 'void') return { js: '(' + v.js + ',0)', t: T.tVoid };
    if (from.k === 'arr') { from = T.ptr(from.of); } // decay już zrobiony w rvalue
    if (to.k === 'int' && from.k === 'int') {
      if (to.size === from.size && to.sg === from.sg) return { js: v.js, t: to };
      if (to.size === 4) return { js: v.js, t: to }; // kanonicznie |0
      if (to.size === 1) return { js: to.sg ? '((' + v.js + ')<<24>>24)' : '((' + v.js + ')&0xFF)', t: to };
      if (to.size === 2) return { js: to.sg ? '((' + v.js + ')<<16>>16)' : '((' + v.js + ')&0xFFFF)', t: to };
    }
    if (to.k === 'flt' && from.k === 'int') {
      var src = from.sg ? v.js : '((' + v.js + ')>>>0)';
      return { js: to.size === 4 ? 'Math.fround(' + src + ')' : '(' + src + ')', t: to };
    }
    if (to.k === 'int' && from.k === 'flt') {
      var jsv = 'RT.f2i(' + v.js + ')';
      if (to.size === 1) jsv = to.sg ? '(' + jsv + '<<24>>24)' : '(' + jsv + '&0xFF)';
      else if (to.size === 2) jsv = to.sg ? '(' + jsv + '<<16>>16)' : '(' + jsv + '&0xFFFF)';
      return { js: jsv, t: to };
    }
    if (to.k === 'flt' && from.k === 'flt') {
      if (to.size === 4) return { js: 'Math.fround(' + v.js + ')', t: to };
      return { js: v.js, t: to };
    }
    if (to.k === 'ptr' && (from.k === 'ptr' || from.k === 'fn')) return { js: v.js, t: to };
    if (to.k === 'ptr' && from.k === 'int') return { js: '((' + v.js + ')>>>0)', t: to };
    if (to.k === 'int' && (from.k === 'ptr' || from.k === 'fn')) {
      var jv = '((' + v.js + ')|0)';
      if (to.size === 1) jv = to.sg ? '(' + jv + '<<24>>24)' : '(' + jv + '&0xFF)';
      else if (to.size === 2) jv = to.sg ? '(' + jv + '<<16>>16)' : '(' + jv + '&0xFFFF)';
      return { js: jv, t: to };
    }
    if (to.k === 'ptr' && from.k === 'flt') {
      this.warn('konwersja float→wskaźnik', loc);
      return { js: '(RT.f2i(' + v.js + ')>>>0)', t: to };
    }
    if (to.k === 'su' && from.k === 'su') return { js: v.js, t: to };
    this.error('niedozwolona konwersja: ' + CC.typeStr(from) + ' → ' + CC.typeStr(to), loc);
    return { js: v.js, t: to };
  };

  /* ---------- rvalue / lvalue ---------- */
  C.rval = function (e, fc) {
    var v = this.genExpr(e, fc);
    return v;
  };

  // genLV: zwraca {addr:{js}, t} lub {jsvar, t}
  C.genLV = function (e, fc) {
    var self = this;
    switch (e.t) {
      case 'id': {
        var s = this.lookup(e.name, fc);
        if (!s) { this.error('nieznana zmienna "' + e.name + '"', e.loc); return { jsvar: '_und', t: T.tInt }; }
        if (s.kind === 'var') return { jsvar: s.js, t: s.type };
        if (s.kind === 'slot') { fc.usesFp = true; return { addr: { js: '(fp+' + s.off + ')' }, t: s.type }; }
        if (s.kind === 'gvar') return { addr: { js: '' + (s.addr >>> 0) }, t: s.type };
        if (s.kind === 'gvarUndef') {
          this.error('zmienna "' + e.name + '" zadeklarowana (extern), ale nigdzie nie zdefiniowana', e.loc);
          return { addr: { js: '0' }, t: s.type };
        }
        if (s.kind === 'fn') return { fnIdx: s.idx, t: s.type };
        if (s.kind === 'enum') { this.error('stała enum nie jest lvalue', e.loc); return { jsvar: '_und', t: T.tInt }; }
        break;
      }
      case 'un':
        if (e.op === '*') {
          var p = this.rval(e.e, fc);
          var t = p.t.k === 'ptr' ? p.t.to : (p.t.k === 'arr' ? p.t.of : null);
          if (!t) {
            if (p.t.k === 'fn' || (p.t.k === 'ptr' && p.t.to.k === 'fn')) return { addr: { js: p.js }, t: p.t };
            this.error('dereferencja nie-wskaźnika (typ ' + CC.typeStr(p.t) + ')', e.loc);
            t = T.tInt;
          }
          this.completeType(t, fc.unit, e.loc);
          return { addr: { js: p.js }, t: t };
        }
        break;
      case 'idx': {
        var a = this.rval(e.a, fc); // decay → ptr
        var i = this.rval(e.i, fc);
        var et = a.t.k === 'ptr' ? a.t.to : null;
        if (!et) { this.error('indeksowanie nie-tablicy (typ ' + CC.typeStr(a.t) + ')', e.loc); et = T.tInt; }
        this.completeType(et, fc.unit, e.loc);
        var sz = this.sizeOf(et, e.loc);
        var idxJs = i.t.k === 'flt' ? 'RT.f2i(' + i.js + ')' : i.js;
        var addr = '((' + a.js + ')+(' + idxJs + ')*' + sz + '>>>0)';
        return { addr: { js: addr }, t: et };
      }
      case 'mem': {
        var st, baseAddr;
        if (e.arrow) {
          var pv = this.rval(e.e, fc);
          if (pv.t.k !== 'ptr' || pv.t.to.k !== 'su') {
            this.error('operator -> zastosowany do nie-wskaźnika-struktury (' + CC.typeStr(pv.t) + ')', e.loc);
            return { addr: { js: '0' }, t: T.tInt };
          }
          st = pv.t.to; baseAddr = pv.js;
        } else {
          var lv = this.genLV(e.e, fc);
          if (lv.t.k !== 'su') {
            this.error('operator . zastosowany do nie-struktury (' + CC.typeStr(lv.t) + ')', e.loc);
            return { addr: { js: '0' }, t: T.tInt };
          }
          st = lv.t;
          baseAddr = lv.addr ? lv.addr.js : '0';
          if (!lv.addr) this.error('struktura bez adresu?', e.loc);
        }
        this.completeType(st, fc.unit, e.loc);
        if (!st.fields) { this.error('użycie niezdefiniowanej struktury "' + (st.tag || '?') + '"', e.loc); return { addr: { js: '0' }, t: T.tInt }; }
        for (var fi = 0; fi < st.fields.length; fi++) {
          if (st.fields[fi].name === e.name) {
            var f = st.fields[fi];
            return { addr: { js: '((' + baseAddr + ')+' + f.off + '>>>0)' }, t: f.type };
          }
        }
        this.error('struktura ' + (st.tag || '<anon>') + ' nie ma pola "' + e.name + '"', e.loc);
        return { addr: { js: '0' }, t: T.tInt };
      }
      case 'str': {
        var sa = this.internString(e.v);
        return { addr: { js: '' + sa }, t: { k: 'arr', of: T.tChar, n: e.v.length + 1, nExpr: null } };
      }
    }
    this.error('wyrażenie nie jest lvalue', e.loc);
    return { jsvar: '_und', t: T.tInt };
  };

  C.lvLoad = function (lv) {
    if (lv.jsvar) return { js: lv.jsvar, t: lv.t };
    if (lv.fnIdx !== undefined) return { js: '' + (FN_BASE + lv.fnIdx * 4), t: T.ptr(lv.t) };
    var t = lv.t;
    if (t.k === 'arr') return { js: lv.addr.js, t: T.ptr(t.of) };  // decay
    if (t.k === 'su') return { js: lv.addr.js, t: t };             // agregat = adres
    return { js: this.loadExpr(lv.addr.js, t), t: t };
  };

  C.lvStore = function (lv, val, fc, loc) {
    // zwraca JS-wyrażenie wykonujące zapis, wartość = val.js (już skonwertowana)
    if (lv.jsvar) {
      var v = this.maskForVar(val.js, lv.t);
      return '(' + lv.jsvar + '=' + v + ')';
    }
    if (lv.t.k === 'su') {
      return '(RT.memcpy(' + lv.addr.js + ',' + val.js + ',' + this.sizeOf(lv.t, loc) + '),' + lv.addr.js + ')';
    }
    return '(' + this.storeStmt(lv.addr, lv.t, val) + ',' + val.js + ')';
  };

  C.maskForVar = function (js, t) {
    if (t.k === 'int') {
      if (t.size === 1) return t.sg ? '((' + js + ')<<24>>24)' : '((' + js + ')&0xFF)';
      if (t.size === 2) return t.sg ? '((' + js + ')<<16>>16)' : '((' + js + ')&0xFFFF)';
      return '((' + js + ')|0)';
    }
    if (t.k === 'ptr') return '((' + js + ')>>>0)';
    if (t.k === 'flt' && t.size === 4) return 'Math.fround(' + js + ')';
    return '(' + js + ')';
  };

  /* ---------- arytmetyka ---------- */
  C.usualArith = function (a, b, loc) {
    // zwraca {a, b, t}
    if (a.t.k === 'flt' || b.t.k === 'flt') {
      var tt = (a.t.k === 'flt' && a.t.size === 8) || (b.t.k === 'flt' && b.t.size === 8) ? T.tDouble :
        ((a.t.k === 'flt' && b.t.k === 'flt') ? T.tFloat : T.tDouble);
      var ca = a.t.k === 'flt' ? a : this.convert(a, tt, loc);
      var cb = b.t.k === 'flt' ? b : this.convert(b, tt, loc);
      return { a: ca, b: cb, t: tt };
    }
    // int: promocja do 32 bitów (kanonicznie już mamy); wynik unsigned gdy któryś unsigned (po promocji)
    var au = (a.t.k === 'int' && !a.t.sg && a.t.size === 4);
    var bu = (b.t.k === 'int' && !b.t.sg && b.t.size === 4);
    var t = (au || bu) ? T.tUInt : T.tInt;
    return { a: a, b: b, t: t };
  };

  C.genBin = function (op, a, b, fc, loc) {
    var self = this;
    // wskaźniki
    var at = a.t, bt = b.t;
    if ((op === '+' || op === '-') && (at.k === 'ptr' || bt.k === 'ptr')) {
      if (at.k === 'ptr' && bt.k === 'ptr') {
        if (op === '-') {
          var sz0 = this.sizeOf(at.to, loc) || 1;
          return { js: '((((' + a.js + ')-(' + b.js + '))|0)/' + sz0 + '|0)', t: T.tInt };
        }
        this.error('niedozwolone dodawanie wskaźników', loc);
        return { js: '0', t: T.tInt };
      }
      var p = at.k === 'ptr' ? a : b;
      var i = at.k === 'ptr' ? b : a;
      if (i.t.k === 'flt') i = this.convert(i, T.tInt, loc);
      var sz = this.sizeOf(p.t.to, loc) || 1;
      var sign = (op === '-') ? '-' : '+';
      if (op === '-' && at.k !== 'ptr') { this.error('odejmowanie wskaźnika od liczby', loc); }
      return { js: '((' + p.js + ')' + sign + '(' + i.js + ')*' + sz + '>>>0)', t: p.t };
    }
    // porównania wskaźników
    if ((at.k === 'ptr' || bt.k === 'ptr') && ['==', '!=', '<', '>', '<=', '>='].indexOf(op) >= 0) {
      var cmp = { '==': '===', '!=': '!==', '<': '<', '>': '>', '<=': '<=', '>=': '>=' }[op];
      return { js: '(((' + a.js + ')>>>0)' + cmp + '((' + b.js + ')>>>0)?1:0)', t: T.tInt };
    }
    if (op === '&&' || op === '||') {
      var ca = this.truthy(a), cb = this.truthy(b);
      var j = op === '&&' ? '(' + ca + '&&' + cb + ')' : '(' + ca + '||' + cb + ')';
      return { js: '(' + j + '?1:0)', t: T.tInt };
    }
    var ua = this.usualArith(a, b, loc);
    a = ua.a; b = ua.b;
    var t = ua.t;
    if (t.k === 'flt') {
      var wrap = (t.size === 4) ? function (x) { return 'Math.fround(' + x + ')'; } : function (x) { return '(' + x + ')'; };
      switch (op) {
        case '+': return { js: wrap('(' + a.js + ')+(' + b.js + ')'), t: t };
        case '-': return { js: wrap('(' + a.js + ')-(' + b.js + ')'), t: t };
        case '*': return { js: wrap('(' + a.js + ')*(' + b.js + ')'), t: t };
        case '/': return { js: wrap('(' + a.js + ')/(' + b.js + ')'), t: t };
        case '==': return { js: '((' + a.js + ')===(' + b.js + ')?1:0)', t: T.tInt };
        case '!=': return { js: '((' + a.js + ')!==(' + b.js + ')?1:0)', t: T.tInt };
        case '<': return { js: '((' + a.js + ')<(' + b.js + ')?1:0)', t: T.tInt };
        case '>': return { js: '((' + a.js + ')>(' + b.js + ')?1:0)', t: T.tInt };
        case '<=': return { js: '((' + a.js + ')<=(' + b.js + ')?1:0)', t: T.tInt };
        case '>=': return { js: '((' + a.js + ')>=(' + b.js + ')?1:0)', t: T.tInt };
        case '%': return { js: wrap('(' + a.js + ')%(' + b.js + ')'), t: t };
        default:
          this.error('operator ' + op + ' niedozwolony dla typów zmiennoprzecinkowych', loc);
          return { js: '0', t: T.tInt };
      }
    }
    var un = (t.k === 'int' && !t.sg);
    var A = '(' + a.js + ')', B = '(' + b.js + ')';
    switch (op) {
      case '+': return { js: '(' + A + '+' + B + '|0)', t: t };
      case '-': return { js: '(' + A + '-' + B + '|0)', t: t };
      case '*': return { js: 'Math.imul(' + A + ',' + B + ')', t: t };
      case '/': return { js: un ? 'RT.udiv(' + A + ',' + B + ')' : 'RT.idiv(' + A + ',' + B + ')', t: t };
      case '%': return { js: un ? 'RT.umod(' + A + ',' + B + ')' : 'RT.imod(' + A + ',' + B + ')', t: t };
      case '&': return { js: '(' + A + '&' + B + ')', t: t };
      case '|': return { js: '(' + A + '|' + B + ')', t: t };
      case '^': return { js: '(' + A + '^' + B + ')', t: t };
      case '<<': return { js: '(' + A + '<<(' + B + '&31))', t: t };
      case '>>': return { js: un ? '(' + A + '>>>(' + B + '&31)|0)' : '(' + A + '>>(' + B + '&31))', t: t };
      case '==': return { js: '(' + A + '===' + B + '?1:0)', t: T.tInt };
      case '!=': return { js: '(' + A + '!==' + B + '?1:0)', t: T.tInt };
      case '<': case '>': case '<=': case '>=': {
        var cmpOp = op;
        if (un) return { js: '((' + A + '>>>0)' + cmpOp + '(' + B + '>>>0)?1:0)', t: T.tInt };
        return { js: '(' + A + cmpOp + B + '?1:0)', t: T.tInt };
      }
    }
    this.error('nieznany operator ' + op, loc);
    return { js: '0', t: T.tInt };
  };

  C.truthy = function (v) {
    if (v.t.k === 'flt') return '((' + v.js + ')!==0)';
    return '((' + v.js + ')!==0)';
  };

  /* ---------- wyrażenia ---------- */
  C.genExpr = function (e, fc) {
    var self = this;
    switch (e.t) {
      case 'num': {
        if (e.v.fl) return { js: numLit(e.v.n), t: T.tDouble };
        var n = e.v.n;
        if (e.v.u || n > 0x7FFFFFFF) return { js: '' + ((n | 0)), t: T.tUInt };
        return { js: '' + (n | 0), t: T.tInt };
      }
      case 'str': {
        var a = this.internString(e.v);
        return { js: '' + a, t: T.ptr(T.tChar) };
      }
      case 'id': {
        var s = this.lookup(e.name, fc);
        if (!s) {
          // może builtin użyty jako wskaźnik?
          var bs = builtinSigs()[e.name];
          if (bs) {
            var bidx = this.ensureBuiltin(e.name);
            return { js: '' + (FN_BASE + bidx * 4), t: T.ptr(this.sigToType(bs)) };
          }
          this.error('nieznany identyfikator "' + e.name + '"', e.loc);
          return { js: '0', t: T.tInt };
        }
        if (s.kind === 'enum') return { js: '' + (s.v | 0), t: T.tInt };
        if (s.kind === 'fn') return { js: '' + (FN_BASE + s.idx * 4), t: T.ptr(s.type) };
        var lv = this.genLV(e, fc);
        return this.lvLoad(lv);
      }
      case 'un': return this.genUnary(e, fc);
      case 'bin': {
        var a2 = this.rval(e.a, fc), b2 = this.rval(e.b, fc);
        return this.genBin(e.op, a2, b2, fc, e.loc);
      }
      case 'assign': return this.genAssign(e, fc);
      case 'cond': {
        var c = this.rval(e.c, fc);
        var x = this.rval(e.a, fc), y = this.rval(e.b, fc);
        var t;
        if (x.t.k === 'ptr') t = x.t;
        else if (y.t.k === 'ptr') t = y.t;
        else if (x.t.k === 'su') t = x.t;
        else { var u = this.usualArith(x, y, e.loc); x = u.a; y = u.b; t = u.t; }
        return { js: '(' + this.truthy(c) + '?(' + x.js + '):(' + y.js + '))', t: t };
      }
      case 'comma': {
        var l = this.rval(e.a, fc), r = this.rval(e.b, fc);
        return { js: '((' + l.js + '),(' + r.js + '))', t: r.t };
      }
      case 'cast': {
        this.completeType(e.type, fc.unit, e.loc);
        var v = this.rval(e.e, fc);
        return this.convert(v, e.type, e.loc);
      }
      case 'sizeof': {
        var ty = e.type;
        if (!ty) {
          ty = this.typeOfExpr(e.e, fc);
        }
        this.completeType(ty, fc.unit, e.loc);
        return { js: '' + this.sizeOf(ty, e.loc), t: T.tUInt };
      }
      case 'idx': case 'mem': {
        var lv2 = this.genLV(e, fc);
        return this.lvLoad(lv2);
      }
      case 'call': return this.genCall(e, fc);
    }
    this.error('nieobsługiwane wyrażenie (' + e.t + ')', e.loc);
    return { js: '0', t: T.tInt };
  };

  function numLit(n) {
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toFixed(1);
    return String(n);
  }

  // typ wyrażenia bez generowania kodu (dla sizeof) — użyj genExpr na sucho
  C.typeOfExpr = function (e, fc) {
    var saveDiags = this.diags.length;
    var saveTmps = fc.tmps.length;
    var v = this.genExpr(e, fc);
    this.diags.length = saveDiags; // wycofaj ewentualne błędy
    fc.tmps.length = saveTmps;
    var t = v.t;
    // sizeof tablicy: genExpr robi decay; spróbuj odzyskać
    if (e.t === 'id') {
      var s = this.lookup(e.name, fc);
      if (s && (s.kind === 'gvar' || s.kind === 'slot' || s.kind === 'var') && s.type) return s.type;
    }
    if (e.t === 'str') return { k: 'arr', of: T.tChar, n: e.v.length + 1, nExpr: null };
    if (e.t === 'un' && e.op === '*') {
      var p = this.typeOfExpr(e.e, fc);
      if (p && p.k === 'ptr') return p.to;
      if (p && p.k === 'arr') return p.of;
    }
    if (e.t === 'idx') {
      var bt = this.typeOfExpr(e.a, fc);
      if (bt && bt.k === 'arr') return bt.of;
      if (bt && bt.k === 'ptr') return bt.to;
    }
    return t;
  };

  C.genUnary = function (e, fc) {
    var self = this;
    switch (e.op) {
      case '&': {
        var lv = this.genLV(e.e, fc);
        if (lv.fnIdx !== undefined) return { js: '' + (FN_BASE + lv.fnIdx * 4), t: T.ptr(lv.t) };
        if (lv.jsvar) {
          this.error('nie można pobrać adresu tej zmiennej (rejestr)', e.loc);
          return { js: '0', t: T.ptr(lv.t) };
        }
        return { js: lv.addr.js, t: T.ptr(lv.t) };
      }
      case '*': {
        var lv2 = this.genLV(e, fc); // genLV obsługuje '*': e jest węzłem 'un' op '*'
        // genLV oczekuje e.t==='un' z op '*': przekaż e bez zmian
        return this.lvLoad(lv2);
      }
      case '+': return this.rval(e.e, fc);
      case '-': {
        var v = this.rval(e.e, fc);
        if (v.t.k === 'flt') return { js: '(-(' + v.js + '))', t: v.t };
        return { js: '(-(' + v.js + ')|0)', t: v.t.k === 'int' ? v.t : T.tInt };
      }
      case '~': {
        var v2 = this.rval(e.e, fc);
        if (v2.t.k === 'flt') v2 = this.convert(v2, T.tInt, e.loc);
        return { js: '(~(' + v2.js + '))', t: v2.t };
      }
      case '!': {
        var v3 = this.rval(e.e, fc);
        return { js: '((' + v3.js + ')===0?1:0)', t: T.tInt };
      }
      case 'preinc': case 'predec': case 'postinc': case 'postdec': {
        var isInc = (e.op === 'preinc' || e.op === 'postinc');
        var isPost = (e.op === 'postinc' || e.op === 'postdec');
        var lv3 = this.genLV(e.e, fc);
        var t = lv3.t;
        var step = '1';
        if (t.k === 'ptr') step = '' + (this.sizeOf(t.to, e.loc) || 1);
        else if (t.k === 'arr') { this.error('++/-- na tablicy', e.loc); return { js: '0', t: T.tInt }; }
        var op = isInc ? '+' : '-';
        if (lv3.jsvar) {
          var nv = this.maskForVar('(' + lv3.jsvar + op + step + ')', t);
          if (isPost) {
            var tmp = this.newTmp(fc);
            return { js: '(' + tmp + '=' + lv3.jsvar + ',' + lv3.jsvar + '=' + nv + ',' + tmp + ')', t: t };
          }
          return { js: '(' + lv3.jsvar + '=' + nv + ')', t: t };
        }
        var ta = this.newTmp(fc), tv = this.newTmp(fc);
        var load = this.loadExpr(ta, t);
        function wrapStep(x) {
          if (t.k === 'flt') return '(' + x + op + step + ')';
          if (t.k === 'ptr') return '((' + x + op + step + ')>>>0)';
          return '((' + x + op + step + ')|0)';
        }
        if (isPost) {
          var store = this.storeStmt({ js: ta }, t, { js: wrapStep(tv), t: t });
          return { js: '(' + ta + '=(' + lv3.addr.js + '),' + tv + '=' + load + ',' + store + ',' + tv + ')', t: t };
        }
        var storePre = this.storeStmt({ js: ta }, t, { js: tv, t: t });
        return { js: '(' + ta + '=(' + lv3.addr.js + '),' + tv + '=' + wrapStep(load) + ',' + storePre + ',' + tv + ')', t: t };
      }
    }
    this.error('nieobsługiwany operator unarny ' + e.op, e.loc);
    return { js: '0', t: T.tInt };
  };

  C.genAssign = function (e, fc) {
    var self = this;
    var lv = this.genLV(e.a, fc);
    var t = lv.t;
    if (t.k === 'arr') { this.error('nie można przypisywać do tablicy', e.loc); return { js: '0', t: T.tInt }; }

    if (e.op === '=') {
      var rhs = this.rval(e.b, fc);
      var conv = this.convert(rhs, t, e.loc);
      return { js: this.lvStore(lv, conv, fc, e.loc), t: t };
    }
    // złożone: load-op-store
    var op = e.op.slice(0, -1);
    var rhs2 = this.rval(e.b, fc);
    if (lv.jsvar) {
      var cur = { js: lv.jsvar, t: t };
      var res = this.genBin(op, cur, rhs2, fc, e.loc);
      var conv2 = this.convert(res, t, e.loc);
      return { js: '(' + lv.jsvar + '=' + this.maskForVar(conv2.js, t) + ')', t: t };
    }
    var ta = this.newTmp(fc);
    var cur2 = { js: this.loadExpr(ta, t), t: t };
    var res2 = this.genBin(op, cur2, rhs2, fc, e.loc);
    var conv3 = this.convert(res2, t, e.loc);
    var tv = this.newTmp(fc);
    var store = this.storeStmt({ js: ta }, t, { js: tv, t: t });
    return { js: '(' + ta + '=(' + lv.addr.js + '),' + tv + '=(' + conv3.js + '),' + store + ',' + tv + ')', t: t };
  };

  /* ---------- wywołania ---------- */
  C.sigToType = function (sig) {
    return T.fn(sig.ret, sig.params.map(function (p) { return { name: null, type: p }; }), sig.varargs);
  };

  C.ensureBuiltin = function (name) {
    // builtin w tablicy funkcji (dla wskaźników / callPtr)
    var sym = this.globals.get(name);
    if (sym && sym.kind === 'fn') return sym.idx;
    var idx = this.fnTable.length;
    this.fnTable.push({
      name: name, jsName: 'B' + idx + '_' + safeId(name),
      unit: null, node: null, type: this.sigToType(builtinSigs()[name]), builtin: true, loc: null
    });
    this.globals.set(name, { kind: 'fn', idx: idx, type: this.fnTable[idx].type, unit: '<builtin>', static: false });
    return idx;
  };

  C.genCall = function (e, fc) {
    var self = this;
    var args = [];
    var fnType = null;
    var calleeJs = null;
    var direct = null; // {idx, builtin}

    if (e.fn.t === 'id') {
      var s = this.lookup(e.fn.name, fc);
      if (!s) {
        var bs = builtinSigs()[e.fn.name];
        if (bs) {
          var bidx = this.ensureBuiltin(e.fn.name);
          direct = { idx: bidx, builtin: true };
          fnType = this.sigToType(bs);
        } else {
          this.error('wywołanie nieznanej funkcji "' + e.fn.name + '()" — brak deklaracji (może brakuje #include?)', e.loc);
          return { js: '0', t: T.tInt };
        }
      } else if (s.kind === 'fn') {
        var fe = this.fnTable[s.idx];
        direct = { idx: s.idx, builtin: fe.builtin && !fe.node };
        fnType = s.type;
      } else {
        // zmienna wskaźnikowa
        var vv = this.genExpr(e.fn, fc);
        if (vv.t.k === 'ptr' && vv.t.to.k === 'fn') { fnType = vv.t.to; calleeJs = vv.js; }
        else if (vv.t.k === 'fn') { fnType = vv.t; calleeJs = vv.js; }
        else {
          this.error('"' + e.fn.name + '" nie jest funkcją (typ: ' + CC.typeStr(vv.t) + ')', e.loc);
          return { js: '0', t: T.tInt };
        }
      }
    } else {
      var fv = this.rval(e.fn, fc);
      if (fv.t.k === 'ptr' && fv.t.to.k === 'fn') { fnType = fv.t.to; calleeJs = fv.js; }
      else if (fv.t.k === 'fn') { fnType = fv.t; calleeJs = fv.js; }
      else {
        this.error('wywołanie wyrażenia, które nie jest funkcją (typ: ' + CC.typeStr(fv.t) + ')', e.loc);
        return { js: '0', t: T.tInt };
      }
    }

    var params = fnType.params || [];
    if (e.args.length < params.length) {
      this.error('za mało argumentów w wywołaniu (oczekiwano ' + params.length + ', jest ' + e.args.length + ')', e.loc);
    } else if (e.args.length > params.length && !fnType.varargs && params.length > 0) {
      this.warn('za dużo argumentów w wywołaniu (oczekiwano ' + params.length + ')', e.loc);
    } else if (e.args.length > params.length && params.length === 0 && !fnType.varargs) {
      // deklaracja () — przyjmij dowolne
    }

    for (var i = 0; i < e.args.length; i++) {
      var av = this.rval(e.args[i], fc);
      if (i < params.length) {
        av = this.convert(av, params[i].type, e.loc);
      } else {
        // vararg: float→double naturalnie; int kanonicznie
        if (av.t.k === 'arr') av = { js: av.js, t: T.ptr(av.t.of) };
      }
      args.push(av.js);
    }

    var ret = fnType.ret || T.tInt;
    var callJs;
    if (direct) {
      var fe2 = this.fnTable[direct.idx];
      if (fe2.builtin && !fe2.node) {
        callJs = 'BI.' + fe2.name + '(' + args.join(',') + ')';
      } else {
        callJs = '(yield* ' + fe2.jsName + '(' + args.join(',') + '))';
      }
    } else {
      callJs = '(yield* RT.callPtr(' + calleeJs + ',[' + args.join(',') + ']))';
    }
    if (ret.k === 'int' && ret.size === 4) callJs = '(' + callJs + '|0)';
    else if (ret.k === 'ptr') callJs = '(' + callJs + '>>>0)';
    return { js: callJs, t: ret };
  };

  /* ---------- instrukcje ---------- */
  C.stmtCost = function (s) {
    // zgrubny koszt cykli
    var cost = 0;
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.t) cost += 1;
      for (var k in n) {
        if (k === 'loc' || k === 'type') continue;
        var v = n[k];
        if (v && typeof v === 'object') walk(v);
      }
    })(s);
    return Math.max(2, Math.min(cost, 60));
  };

  C.lnStmt = function (loc) {
    if (!loc) return '';
    // RT.stepF — tryb pracy krokowej: zatrzymanie po każdej instrukcji
    return 'RT.ln=' + (((loc.f & 0x3FF) * 0x400000) + (loc.l & 0x3FFFFF)) +
      ';if(RT.stepF)yield 0;';
  };

  C.genStmt = function (s, fc) {
    var self = this;
    if (!s) return;
    switch (s.t) {
      case 'compound': {
        fc.scopes.push(new Map());
        for (var i = 0; i < s.items.length; i++) this.genStmt(s.items[i], fc);
        fc.scopes.pop();
        return;
      }
      case 'decl': {
        for (var j = 0; j < s.items.length; j++) this.genLocalDecl(s.items[j], fc);
        return;
      }
      case 'expr': {
        if (!s.e) return;
        fc.lines.push(this.lnStmt(s.loc));
        var v = this.rval(s.e, fc);
        fc.lines.push('(' + v.js + ');');
        return;
      }
      case 'if': {
        fc.lines.push(this.lnStmt(s.loc));
        var c = this.rval(s.c, fc);
        fc.lines.push('if(' + this.truthy(c) + '){');
        this.genStmt(s.a, fc);
        if (s.b) {
          fc.lines.push('}else{');
          this.genStmt(s.b, fc);
        }
        fc.lines.push('}');
        return;
      }
      case 'while': return this.genWhile(s, fc);
      case 'do': return this.genDo(s, fc);
      case 'for': return this.genFor(s, fc);
      case 'switch': return this.genSwitch(s, fc);
      case 'break': {
        var ctx = fc.loopStack.length ? fc.loopStack[fc.loopStack.length - 1] : null;
        if (!ctx) { this.error('break poza pętlą/switch', s.loc); return; }
        fc.lines.push(ctx.breakJS + ';');
        return;
      }
      case 'continue': {
        // znajdź najbliższą pętlę (switch nie łapie continue)
        var lctx = null;
        for (var li = fc.loopStack.length - 1; li >= 0; li--) {
          if (fc.loopStack[li].continueJS) { lctx = fc.loopStack[li]; break; }
        }
        if (!lctx) { this.error('continue poza pętlą', s.loc); return; }
        fc.lines.push(lctx.continueJS + ';');
        return;
      }
      case 'return': {
        fc.lines.push(this.lnStmt(s.loc));
        if (s.e) {
          var rv = this.rval(s.e, fc);
          if (fc.retType && fc.retType.k !== 'void') rv = this.convert(rv, fc.retType, s.loc);
          fc.lines.push('return (' + rv.js + ');');
        } else {
          fc.lines.push('return 0;');
        }
        return;
      }
      case 'asm': {
        // __asm__("nop") — policz cykl
        fc.lines.push('RT.fuel-=1;');
        return;
      }
      case 'empty': return;
      case 'case': case 'default':
        this.error('case/default poza instrukcją switch (lub w zagnieżdżonym bloku — nieobsługiwane)', s.loc);
        return;
    }
    this.error('nieobsługiwana instrukcja (' + s.t + ')', s.loc);
  };

  /* ---------- deklaracje lokalne ---------- */
  C.genLocalDecl = function (it, fc) {
    var self = this;
    if (!it.name) return;
    this.completeType(it.type, fc.unit, it.loc);

    if (it.extern) {
      // odwołanie do globala
      var gs = fc.unit.statics.get(it.name) || this.globals.get(it.name);
      if (!gs) {
        this.error('extern "' + it.name + '" — nie znaleziono definicji globalnej', it.loc);
        return;
      }
      // nic nie deklarujemy — lookup znajdzie globala (o ile nie przesłonięty)
      return;
    }
    if (it.type.k === 'fn') return; // prototyp lokalny

    if (it.static) {
      // static lokalny → pseudo-global
      var key = fc.fnEntry.name + '$' + it.name + '$' + (this.tmpCnt++);
      var sym = {
        kind: 'var', type: it.type, init: it.init || null, unit: fc.unit.name,
        defUnit: fc.unit, loc: it.loc, static: true, declOnly: false
      };
      this.completeType(sym.type, fc.unit, it.loc);
      if (sym.type.k === 'arr' && sym.type.n === null) {
        if (sym.init && sym.init.t === 'ilist') sym.type.n = sym.init.items.length;
        else if (sym.init && sym.init.t === 'str') sym.type.n = sym.init.v.length + 1;
      }
      var size = this.sizeOf(sym.type, it.loc);
      sym.addr = this.allocBytes(size, alignOf(sym.type));
      sym.size = size;
      if (sym.init) {
        var bytes = new Uint8Array(size);
        var dv = new DataView(bytes.buffer);
        this.writeInit(dv, 0, sym.type, sym.init, fc.unit, it.loc);
        this.image.push({ addr: sym.addr, bytes: bytes });
      }
      fc.scopes[fc.scopes.length - 1].set(it.name, { kind: 'gvar', addr: sym.addr, type: sym.type });
      return;
    }

    var needSlot = fc.addrTaken.has(it.name) || it.type.k === 'arr' || it.type.k === 'su';
    if (it.type.k === 'arr' && it.type.n === null) {
      if (it.init && it.init.t === 'ilist') it.type.n = it.init.items.length;
      else if (it.init && it.init.t === 'str') it.type.n = it.init.v.length + 1;
      else { this.error('tablica lokalna bez rozmiaru', it.loc); it.type.n = 1; }
    }

    if (needSlot) {
      var sz = alignUp(this.sizeOf(it.type, it.loc), 4);
      var off = fc.frameSize;
      fc.frameSize += sz;
      fc.scopes[fc.scopes.length - 1].set(it.name, { kind: 'slot', off: off, type: it.type });
      if (it.init) {
        fc.lines.push(this.lnStmt(it.loc));
        this.genLocalInit('(fp+' + off + ')', it.type, it.init, fc, it.loc);
      }
      return;
    }

    // zwykła zmienna JS
    var jsn = 'v' + (fc.tmps.length) + '_' + safeId(it.name);
    fc.tmps.push(jsn + '=0');
    fc.scopes[fc.scopes.length - 1].set(it.name, { kind: 'var', js: jsn, type: it.type });
    if (it.init) {
      fc.lines.push(this.lnStmt(it.loc));
      if (it.init.t === 'ilist') {
        this.error('inicjalizator klamrowy dla zmiennej skalarnej', it.loc);
        return;
      }
      var v = this.rval(it.init, fc);
      var conv = this.convert(v, it.type, it.loc);
      fc.lines.push(jsn + '=' + this.maskForVar(conv.js, it.type) + ';');
    }
  };

  C.genLocalInit = function (baseJs, type, init, fc, loc) {
    var self = this;
    // wyzeruj
    var size = this.sizeOf(type, loc);
    fc.lines.push('RT.memset(' + baseJs + ',0,' + size + ');');
    if (init.t === 'str' && type.k === 'arr') {
      var sa = this.internString(init.v);
      var n = Math.min(init.v.length + 1, type.n === null ? init.v.length + 1 : type.n);
      fc.lines.push('RT.memcpy(' + baseJs + ',' + sa + ',' + n + ');');
      return;
    }
    if (init.t !== 'ilist') {
      // struct x = wyrażenie / skalar
      var v = this.rval(init, fc);
      if (type.k === 'su') {
        fc.lines.push('RT.memcpy(' + baseJs + ',' + v.js + ',' + size + ');');
      } else {
        var conv = this.convert(v, type, loc);
        fc.lines.push(this.storeStmt({ js: baseJs }, type, conv) + ';');
      }
      return;
    }
    // lista — generuj zapisy (płaskie wypełnianie jak w globalach)
    var stmts = [];
    var cursor = { items: init.items, pos: 0 };
    this.emitAggInit(baseJs, 0, type, cursor, fc, loc);
  };

  C.emitAggInit = function (baseJs, off, type, cursor, fc, loc) {
    var self = this;
    this.completeType(type, fc.unit, loc);
    if (type.k === 'arr') {
      var esz = this.sizeOf(type.of, loc);
      var n = type.n === null ? cursor.items.length : type.n;
      for (var i = 0; i < n && cursor.pos < cursor.items.length; i++) {
        var item = cursor.items[cursor.pos];
        if (item && item.t === 'ilist') {
          cursor.pos++;
          this.emitAggInit(baseJs, off + i * esz, type.of, { items: item.items, pos: 0 }, fc, loc);
        } else if (type.of.k === 'arr' || type.of.k === 'su') {
          this.emitAggInit(baseJs, off + i * esz, type.of, cursor, fc, loc);
        } else {
          this.emitScalarInit(baseJs, off + i * esz, type.of, item, fc, loc);
          cursor.pos++;
        }
      }
      return;
    }
    if (type.k === 'su') {
      var fields = type.fields || [];
      for (var fi = 0; fi < fields.length && cursor.pos < cursor.items.length; fi++) {
        var f = fields[fi];
        var item2 = cursor.items[cursor.pos];
        if (item2 && item2.t === 'ilist') {
          cursor.pos++;
          this.emitAggInit(baseJs, off + f.off, f.type, { items: item2.items, pos: 0 }, fc, loc);
        } else if (f.type.k === 'arr' || f.type.k === 'su') {
          this.emitAggInit(baseJs, off + f.off, f.type, cursor, fc, loc);
        } else {
          this.emitScalarInit(baseJs, off + f.off, f.type, item2, fc, loc);
          cursor.pos++;
        }
        if (type.union) break;
      }
      return;
    }
    if (cursor.pos < cursor.items.length) {
      this.emitScalarInit(baseJs, off, type, cursor.items[cursor.pos], fc, loc);
      cursor.pos++;
    }
  };

  C.emitScalarInit = function (baseJs, off, type, item, fc, loc) {
    if (!item) return;
    if (item.t === 'str' && type.k === 'arr') {
      var sa = this.internString(item.v);
      fc.lines.push('RT.memcpy((' + baseJs + ')+' + off + ',' + sa + ',' + (item.v.length + 1) + ');');
      return;
    }
    var v = this.rval(item, fc);
    var conv = this.convert(v, type, loc);
    fc.lines.push(this.storeStmt({ js: '(' + baseJs + ')+' + off }, type, conv) + ';');
  };

  /* ---------- pętle ---------- */

  // wykrywanie pętli opóźniających (fast-forward)
  // 1) while(--a != 0); / while(--a); / while(a--);  — a: lokalna zmienna JS, ciało puste
  // 2) for(i=E; i>0; i--) {tylko nop;}  (oraz i>=1, i!=0, --i, i=i-1)
  C.isEmptyBody = function (s) {
    if (!s) return true;
    if (s.t === 'empty') return true;
    if (s.t === 'asm') return true;
    if (s.t === 'compound') return s.items.every(this.isEmptyBody, this);
    return false;
  };
  C.localVarRef = function (e, fc) {
    if (!e || e.t !== 'id') return null;
    var s = this.lookup(e.name, fc);
    if (s && s.kind === 'var') return s;
    return null;
  };

  C.tryDelayWhile = function (s, fc) {
    // while(COND) {pusta}: COND = (--a != 0) | (--a) | (a--) | (a-- != 0)
    if (!this.isEmptyBody(s.body)) return false;
    var c = s.c;
    var cmpZero = false;
    if (c && c.t === 'bin' && c.op === '!=' && c.b && c.b.t === 'num' && !c.b.v.fl && (c.b.v.n | 0) === 0) {
      c = c.a; cmpZero = true;
    }
    if (!c || c.t !== 'un') return false;
    var isPre = (c.op === 'predec'), isPost = (c.op === 'postdec');
    if (!isPre && !isPost) return false;
    var lv = this.localVarRef(c.e, fc);
    if (!lv || lv.type.k !== 'int') return false;
    var a = lv.js;
    var iters = this.newTmp(fc);
    var C_ITER = 4;
    if (isPre) {
      // while(--a) : iteracje = (a>>>0)||2^32 ; final a=0
      fc.lines.push(this.lnStmt(s.loc));
      fc.lines.push(iters + '=((' + a + '>>>0)||4294967296);');
      fc.lines.push('RT.fuel-=' + iters + '*' + C_ITER + ';');
      fc.lines.push(a + '=0;');
      fc.lines.push('if(RT.fuel<=0)yield 0;');
      return true;
    }
    // while(a--) : iteracje = (a>>>0); final a = -1
    fc.lines.push(this.lnStmt(s.loc));
    fc.lines.push(iters + '=(' + a + '>>>0);');
    fc.lines.push('RT.fuel-=' + iters + '*' + C_ITER + ';');
    fc.lines.push(a + '=-1;');
    fc.lines.push('if(RT.fuel<=0)yield 0;');
    return true;
  };

  C.tryDelayFor = function (s, fc) {
    // for(i=E; i CMP B; i--/--i/i-=1) {puste/nop}
    if (!this.isEmptyBody(s.body)) return false;
    if (!s.c || s.c.t !== 'bin') return false;
    var lv = this.localVarRef(s.c.a, fc);
    if (!lv || lv.type.k !== 'int' || !lv.type.sg) return false;
    var jsv = lv.js;

    var b = s.c.b;
    if (!b || b.t !== 'num' || b.v.fl) return false;
    var bound = b.v.n | 0;
    var op = s.c.op;
    if (!(op === '>' || op === '>=' || op === '!=')) return false;
    if (op === '!=' && bound !== 0) return false;

    // krok: i-- / --i / i-=1 / i=i-1
    var inc = s.inc;
    var stepOk = false;
    if (inc && inc.t === 'un' && (inc.op === 'postdec' || inc.op === 'predec') &&
      this.localVarRef(inc.e, fc) === lv) stepOk = true;
    if (inc && inc.t === 'assign' && inc.op === '-=' && this.localVarRef(inc.a, fc) === lv &&
      inc.b.t === 'num' && (inc.b.v.n | 0) === 1) stepOk = true;
    if (!stepOk) return false;

    // init (może być deklaracją w for — obsłużona wcześniej) lub przypisaniem
    var initJs = null;
    if (s.init) {
      if (s.init.t === 'expr' && s.init.e && s.init.e.t === 'assign' && s.init.e.op === '=' &&
        this.localVarRef(s.init.e.a, fc) === lv) {
        var iv = this.rval(s.init.e.b, fc);
        initJs = this.convert(iv, lv.type, s.loc).js;
      } else {
        // init robi coś innego — wykonaj normalnie, potem fast-forward
        this.genStmt(s.init, fc);
      }
    }
    var itv = this.newTmp(fc);
    var C_ITER = 4;
    fc.lines.push(this.lnStmt(s.loc));
    if (initJs !== null) fc.lines.push(jsv + '=((' + initJs + ')|0);');
    var itersExpr, finalExpr;
    if (op === '>') { itersExpr = '(' + jsv + '>' + bound + '?(' + jsv + '-' + bound + '):0)'; finalExpr = '(' + jsv + '>' + bound + '?' + bound + ':' + jsv + ')'; }
    else if (op === '>=') { itersExpr = '(' + jsv + '>=' + bound + '?(' + jsv + '-' + bound + '+1):0)'; finalExpr = '(' + jsv + '>=' + bound + '?' + (bound - 1) + ':' + jsv + ')'; }
    else { itersExpr = '(' + jsv + '>0?' + jsv + ':0)'; finalExpr = '(' + jsv + '>0?0:' + jsv + ')'; }
    fc.lines.push(itv + '=' + itersExpr + ';');
    fc.lines.push('RT.fuel-=' + itv + '*' + C_ITER + ';');
    fc.lines.push(jsv + '=' + finalExpr + ';');
    fc.lines.push('if(RT.fuel<=0)yield 0;');
    return true;
  };

  C.genWhile = function (s, fc) {
    if (this.tryDelayWhile(s, fc)) return;
    var cost = this.stmtCost(s.body) + 2;
    fc.lines.push(this.lnStmt(s.loc));
    fc.lines.push('for(;;){');
    fc.lines.push('if((RT.fuel-=' + cost + ')<=0)yield 0;');
    fc.lines.push(this.lnStmt(s.loc)); // znacznik iteracji (praca krokowa)
    var c = this.rval(s.c, fc);
    fc.lines.push('if(!' + this.truthy(c) + ')break;');
    fc.loopStack.push({ breakJS: 'break', continueJS: 'continue' });
    this.genStmt(s.body, fc);
    fc.loopStack.pop();
    fc.lines.push('}');
  };

  C.genDo = function (s, fc) {
    var cost = this.stmtCost(s.body) + 2;
    var lbl = this.newLbl('C');
    fc.lines.push(this.lnStmt(s.loc));
    fc.lines.push('for(;;){');
    fc.lines.push('if((RT.fuel-=' + cost + ')<=0)yield 0;');
    fc.lines.push(this.lnStmt(s.loc)); // znacznik iteracji (praca krokowa)
    fc.loopStack.push({ breakJS: 'break', continueJS: 'break ' + lbl });
    fc.lines.push(lbl + ':{');
    this.genStmt(s.body, fc);
    fc.lines.push('}');
    fc.loopStack.pop();
    var c = this.rval(s.c, fc);
    fc.lines.push('if(!' + this.truthy(c) + ')break;');
    fc.lines.push('}');
  };

  C.genFor = function (s, fc) {
    fc.scopes.push(new Map()); // dla deklaracji w init
    if (s.init && s.init.t === 'decl') {
      this.genStmt(s.init, fc);
      // spróbuj delay-for (init już wykonany — przekaż bez init)
      var s2 = { t: 'for', init: null, c: s.c, inc: s.inc, body: s.body, loc: s.loc };
      if (this.tryDelayFor(s2, fc)) { fc.scopes.pop(); return; }
      this.genForCore(s2, fc);
      fc.scopes.pop();
      return;
    }
    if (this.tryDelayFor(s, fc)) { fc.scopes.pop(); return; }
    if (s.init) this.genStmt(s.init.t === 'expr' ? s.init : { t: 'expr', e: s.init.e || null, loc: s.loc }, fc);
    this.genForCore({ t: 'for', init: null, c: s.c, inc: s.inc, body: s.body, loc: s.loc }, fc);
    fc.scopes.pop();
  };

  C.genForCore = function (s, fc) {
    var cost = this.stmtCost(s.body) + 3;
    var lbl = this.newLbl('C');
    fc.lines.push(this.lnStmt(s.loc));
    fc.lines.push('for(;;){');
    fc.lines.push('if((RT.fuel-=' + cost + ')<=0)yield 0;');
    fc.lines.push(this.lnStmt(s.loc)); // znacznik iteracji (praca krokowa)
    if (s.c) {
      var c = this.rval(s.c, fc);
      fc.lines.push('if(!' + this.truthy(c) + ')break;');
    }
    fc.loopStack.push({ breakJS: 'break', continueJS: 'break ' + lbl });
    fc.lines.push(lbl + ':{');
    this.genStmt(s.body, fc);
    fc.lines.push('}');
    fc.loopStack.pop();
    if (s.inc) {
      var iv = this.rval(s.inc, fc);
      fc.lines.push('(' + iv.js + ');');
    }
    fc.lines.push('}');
  };

  C.genSwitch = function (s, fc) {
    var self = this;
    fc.lines.push(this.lnStmt(s.loc));
    var ev = this.rval(s.e, fc);
    var tmp = this.newTmp(fc);
    fc.lines.push(tmp + '=((' + ev.js + ')|0);');
    fc.lines.push('switch(' + tmp + '){');
    fc.loopStack.push({ breakJS: 'break', continueJS: null });
    var body = s.body;
    if (body && body.t === 'compound') {
      fc.scopes.push(new Map());
      for (var i = 0; i < body.items.length; i++) {
        var it = body.items[i];
        if (it.t === 'case') {
          var cv = this.constEval(it.e, fc.unit);
          if (cv === null || cv.v === undefined) {
            // może stała enum lokalna w fc? constEval zna tylko unit.enums — wystarcza
            this.error('etykieta case musi być stałą całkowitą', it.loc);
            cv = { v: 0 };
          }
          fc.lines.push('case ' + (cv.v | 0) + ':');
          continue;
        }
        if (it.t === 'default') { fc.lines.push('default:'); continue; }
        this.genStmt(it, fc);
      }
      fc.scopes.pop();
    } else if (body) {
      this.genStmt(body, fc);
    }
    fc.loopStack.pop();
    fc.lines.push('}');
  };

  /* ---------- składanie modułu ---------- */
  C.assembleModule = function (mainIdx) {
    var parts = [];
    parts.push('"use strict";');
    parts.push('var DV=RT.dv,BI=RT.bi;');
    parts.push('var ld8=RT.ld8,ldu8=RT.ldu8,ld16=RT.ld16,ldu16=RT.ldu16,ld32=RT.ld32,lf32=RT.lf32,lf64=RT.lf64;');
    parts.push('var st8=RT.st8,st16=RT.st16,st32=RT.st32,sf32=RT.sf32,sf64=RT.sf64;');
    parts.push('var _und=0;');
    for (var i = 0; i < this.fnTable.length; i++) {
      var fe = this.fnTable[i];
      if (fe.node && fe.jsSrc) parts.push(fe.jsSrc);
      else if (fe.builtin) {
        // generator-wrapper wokół builtina (dla wywołań przez wskaźnik)
        parts.push('function* ' + fe.jsName + '(){return BI.' + fe.name + '.apply(null,arguments);}');
      } else {
        parts.push('function* ' + fe.jsName + '(){RT.fault("wywołanie niezdefiniowanej funkcji ' + fe.name + '");}');
      }
    }
    parts.push('var TBL=[' + this.fnTable.map(function (f) { return f.jsName; }).join(',') + '];');
    parts.push('return {table:TBL, mainIdx:' + mainIdx + '};');
    return parts.join('\n');
  };

  /* ---------- API wysokiego poziomu ---------- */
  CC.compileProject = function (files, sysHeaders) {
    // files: [{name, text}], sysHeaders: Map
    var comp = new Compiler({ files: files }, sysHeaders);
    var out = null;
    try {
      out = comp.compile();
    } catch (e) {
      if (e instanceof CC.CompileError) {
        comp.diags.push({ sev: 'error', msg: e.message, file: e.file, line: e.line });
      } else {
        comp.diags.push({ sev: 'error', msg: 'wewnętrzny błąd kompilatora: ' + (e && e.message ? e.message : e), file: '?', line: 0 });
        if (g.console && console.error) console.error(e);
      }
    }
    return { result: out, diags: comp.diags };
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
