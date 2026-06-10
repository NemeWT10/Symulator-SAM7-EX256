/* ============================================================
 * Symulator SAM7-EX256 — kompilator C
 * cc_parse.js — parser C (podzbiór C99) → AST
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC || (g.CC = {});
  var CompileError = CC.CompileError;

  /* ---------- typy (współdzielone z codegen) ---------- */
  var T = {};
  T.tVoid = { k: 'void', size: 0, align: 1 };
  T.tChar = { k: 'int', size: 1, sg: true };
  T.tUChar = { k: 'int', size: 1, sg: false };
  T.tShort = { k: 'int', size: 2, sg: true };
  T.tUShort = { k: 'int', size: 2, sg: false };
  T.tInt = { k: 'int', size: 4, sg: true };
  T.tUInt = { k: 'int', size: 4, sg: false };
  T.tFloat = { k: 'flt', size: 4 };
  T.tDouble = { k: 'flt', size: 8 };
  T.ptr = function (to) { return { k: 'ptr', to: to, size: 4 }; };
  T.arr = function (of, nExpr) { return { k: 'arr', of: of, nExpr: nExpr, n: null }; };
  T.fn = function (ret, params, varargs) { return { k: 'fn', ret: ret, params: params, varargs: !!varargs }; };
  CC.T = T;

  function typeStr(t) {
    if (!t) return '?';
    switch (t.k) {
      case 'void': return 'void';
      case 'int': return (t.sg ? '' : 'unsigned ') + ({ 1: 'char', 2: 'short', 4: 'int' })[t.size];
      case 'flt': return t.size === 4 ? 'float' : 'double';
      case 'ptr': return typeStr(t.to) + '*';
      case 'arr': return typeStr(t.of) + '[' + (t.n === null ? '' : t.n) + ']';
      case 'su': return (t.union ? 'union ' : 'struct ') + (t.tag || '<anon>');
      case 'fn': return typeStr(t.ret) + '(' +
        t.params.map(function (p) { return typeStr(p.type); }).join(',') + (t.varargs ? ',...' : '') + ')';
    }
    return '?';
  }
  CC.typeStr = typeStr;

  /* ---------- parser ---------- */
  function Parser(toks, pp) {
    this.toks = toks.filter(function (t) { return t.k !== 'nl'; });
    this.pos = 0;
    this.pp = pp;             // dla nazw plików + diagnostyki
    this.diags = pp.diags;
    this.scopes = [{ typedefs: new Map(), tags: new Map() }];
    this.decls = [];
    this.errCount = 0;
  }
  CC.Parser = Parser;

  var P = Parser.prototype;

  P.peek = function (o) { return this.toks[this.pos + (o || 0)] || { k: 'eof', v: '' }; };
  P.next = function () { var t = this.toks[this.pos]; if (t && t.k !== 'eof') this.pos++; return t || { k: 'eof', v: '' }; };
  P.isP = function (v, o) { var t = this.peek(o); return t.k === 'p' && t.v === v; };
  P.isId = function (v, o) { var t = this.peek(o); return t.k === 'id' && (v === undefined || t.v === v); };
  P.eatP = function (v) { if (this.isP(v)) { this.pos++; return true; } return false; };
  P.eatId = function (v) { if (this.isId(v)) { this.pos++; return true; } return false; };
  P.loc = function (t) { t = t || this.peek(); return { f: t.f, l: t.l }; };
  P.fname = function (t) { return this.pp.files[t.f] || '?'; };

  P.err = function (msg, t) {
    t = t || this.peek();
    this.errCount++;
    this.diags.push({ sev: 'error', msg: msg, file: this.fname(t), line: t.l || 0 });
    if (this.errCount > 25) {
      throw new CompileError('zbyt wiele błędów składni — przerwano', this.fname(t), t.l || 0);
    }
  };
  P.expectP = function (v, what) {
    if (this.eatP(v)) return true;
    var t = this.peek();
    this.err('oczekiwano "' + v + '"' + (what ? ' ' + what : '') + ', a jest: ' + dispTok(t), t);
    return false;
  };

  function dispTok(t) {
    if (t.k === 'eof') return 'koniec pliku';
    if (t.k === 'str') return 'łańcuch "' + t.v.slice(0, 20) + '"';
    if (t.k === 'num') return 'liczba ' + t.v.n;
    return '"' + (t.k === 'ch' ? String.fromCharCode(t.v) : t.v) + '"';
  }

  /* --- zakresy nazw typów --- */
  P.pushScope = function () { this.scopes.push({ typedefs: new Map(), tags: new Map() }); };
  P.popScope = function () { this.scopes.pop(); };
  P.findTypedef = function (name) {
    for (var i = this.scopes.length - 1; i >= 0; i--) {
      var m = this.scopes[i].typedefs;
      if (m.has(name)) return m.get(name);
    }
    return null;
  };
  P.addTypedef = function (name, type) {
    this.scopes[this.scopes.length - 1].typedefs.set(name, type);
  };
  P.findTag = function (name) {
    for (var i = this.scopes.length - 1; i >= 0; i--) {
      var m = this.scopes[i].tags;
      if (m.has(name)) return m.get(name);
    }
    return null;
  };
  P.findTagHere = function (name) {
    var m = this.scopes[this.scopes.length - 1].tags;
    return m.has(name) ? m.get(name) : null;
  };
  P.addTag = function (name, type) {
    this.scopes[this.scopes.length - 1].tags.set(name, type);
  };

  var STORAGE = { 'typedef': 1, 'extern': 1, 'static': 1, 'auto': 1, 'register': 1, 'inline': 1, '__inline': 1, '__inline__': 1 };
  var QUAL = { 'const': 1, 'volatile': 1, 'restrict': 1, '__restrict': 1, '__const': 1 };
  var TYPEWORD = {
    'void': 1, 'char': 1, 'short': 1, 'int': 1, 'long': 1, 'float': 1,
    'double': 1, 'signed': 1, 'unsigned': 1, '_Bool': 1
  };

  P.skipAttributes = function () {
    for (; ;) {
      if (this.isId('__attribute__') || this.isId('__attribute')) {
        this.next();
        if (this.isP('(')) this.skipParens();
        continue;
      }
      if (this.isId('__declspec')) { this.next(); if (this.isP('(')) this.skipParens(); continue; }
      break;
    }
  };
  P.skipParens = function () {
    // zakłada, że peek()==='('
    var depth = 0;
    for (; ;) {
      var t = this.next();
      if (t.k === 'eof') return;
      if (t.k === 'p' && t.v === '(') depth++;
      else if (t.k === 'p' && t.v === ')') { depth--; if (depth === 0) return; }
    }
  };

  // czy od bieżącej pozycji zaczyna się deklaracja?
  P.startsDecl = function () {
    var t = this.peek();
    if (t.k !== 'id') return false;
    if (STORAGE[t.v] || QUAL[t.v] || TYPEWORD[t.v]) return true;
    if (t.v === 'struct' || t.v === 'union' || t.v === 'enum') return true;
    if (t.v === '__attribute__' || t.v === '__attribute') return true;
    if (this.findTypedef(t.v)) {
      // "typedefName x" / "typedefName *x" / "typedefName)" — ale nie "typedefName = ..."
      var t2 = this.peek(1);
      if (t2.k === 'id') return true;
      if (t2.k === 'p' && (t2.v === '*' || t2.v === ';' || t2.v === '(')) {
        // uwaga: "nazwa (" może być wywołaniem funkcji o nazwie typu — w C niemożliwe (typedef przesłania), traktuj jako deklarację
        return true;
      }
      return false;
    }
    return false;
  };

  /* --- specyfikatory deklaracji --- */
  P.parseDeclSpecs = function (required) {
    var startTok = this.peek();
    var st = { typedef: false, extern: false, static: false, inline: false };
    var base = null;
    var sign = null;   // true=signed, false=unsigned
    var longCnt = 0, shortCnt = 0;
    var sawTypeWord = false;
    var self = this;

    for (; ;) {
      this.skipAttributes();
      var t = this.peek();
      if (t.k !== 'id') break;
      var v = t.v;
      if (STORAGE[v]) {
        if (v === 'typedef') st.typedef = true;
        else if (v === 'extern') st.extern = true;
        else if (v === 'static') st.static = true;
        else if (v.indexOf('inline') >= 0) st.inline = true;
        this.next(); continue;
      }
      if (QUAL[v]) { this.next(); continue; }
      if (v === 'struct' || v === 'union') {
        if (base || sawTypeWord) break;
        base = this.parseStructSpec(v === 'union');
        continue;
      }
      if (v === 'enum') {
        if (base || sawTypeWord) break;
        base = this.parseEnumSpec();
        continue;
      }
      if (TYPEWORD[v]) {
        sawTypeWord = true;
        this.next();
        switch (v) {
          case 'void': base = T.tVoid; break;
          case 'char': base = { k: 'int', size: 1, sg: true, isChar: true }; break;
          case 'short': shortCnt++; break;
          case 'long': longCnt++; break;
          case 'int': if (!base) base = null; break; // int = domyślne
          case 'float': base = T.tFloat; break;
          case 'double': base = T.tDouble; break;
          case 'signed': sign = true; break;
          case 'unsigned': sign = false; break;
          case '_Bool': base = { k: 'int', size: 1, sg: false }; break;
        }
        continue;
      }
      // typedef-name (tylko jeśli nic jeszcze nie ustalono)
      if (!base && !sawTypeWord && sign === null && !longCnt && !shortCnt) {
        var td = this.findTypedef(v);
        if (td) { base = td; this.next(); sawTypeWord = true; continue; }
      }
      break;
    }

    var any = (base !== null) || sawTypeWord || sign !== null || longCnt || shortCnt ||
      st.typedef || st.extern || st.static || st.inline;
    if (!any) {
      if (required) this.err('oczekiwano deklaracji', startTok);
      return null;
    }

    var type = base;
    if (type === null || (type.k === 'int' && !type.isChar && type.size === 4)) {
      // zbuduj z int/short/long/signed/unsigned
      if (longCnt >= 2) {
        this.err('typ "long long" nie jest obsługiwany w symulatorze (użyj int/long 32-bit)', startTok);
      }
      var size = shortCnt ? 2 : 4;
      type = { k: 'int', size: size, sg: sign === null ? true : sign };
    } else if (type.k === 'int' && type.isChar) {
      type = { k: 'int', size: 1, sg: sign === null ? true : sign, isChar: true };
    } else if (sign !== null && type.k === 'int') {
      type = { k: 'int', size: type.size, sg: sign };
    }
    if (longCnt && base && base.k === 'flt' && base.size === 8) type = T.tDouble; // long double≈double

    return { storage: st, type: type, loc: this.loc(startTok) };
  };

  P.parseStructSpec = function (isUnion) {
    this.next(); // struct/union
    this.skipAttributes();
    var tag = null;
    if (this.isId()) { tag = this.next().v; }
    var type = null;
    if (tag) {
      var found = this.findTag((isUnion ? 'u:' : 's:') + tag);
      if (found) type = found;
    }
    if (this.isP('{')) {
      // definicja
      if (tag) {
        var here = this.findTagHere((isUnion ? 'u:' : 's:') + tag);
        if (here && here.fields) this.err('ponowna definicja struktury ' + tag);
        if (here) type = here;
      }
      if (!type) {
        type = { k: 'su', union: isUnion, tag: tag, fields: null, size: null, align: null };
        if (tag) this.addTag((isUnion ? 'u:' : 's:') + tag, type);
      } else if (this.findTagHere((isUnion ? 'u:' : 's:') + tag) !== type) {
        // tag z zewnętrznego zakresu — nowa definicja lokalna
        type = { k: 'su', union: isUnion, tag: tag, fields: null, size: null, align: null };
        if (tag) this.addTag((isUnion ? 'u:' : 's:') + tag, type);
      }
      this.next(); // {
      var fields = [];
      while (!this.isP('}') && this.peek().k !== 'eof') {
        var specs = this.parseDeclSpecs(true);
        if (!specs) { this.next(); continue; }
        if (this.isP(';')) { this.next(); continue; } // anonimowa struct — pomijamy zawartość? (rzadkie)
        for (; ;) {
          var d = this.parseDeclarator(specs.type, false);
          if (this.isP(':')) { // pole bitowe
            this.next();
            this.parseAssign(); // szerokość — ignorowana
            this.err('pola bitowe nie są obsługiwane w symulatorze');
          }
          if (d.name) fields.push({ name: d.name, type: d.type, loc: d.loc });
          this.skipAttributes();
          if (this.eatP(',')) continue;
          break;
        }
        this.expectP(';', 'po polu struktury');
      }
      this.expectP('}', 'na końcu struktury');
      this.skipAttributes();
      type.fields = fields;
      return type;
    }
    if (!type) {
      type = { k: 'su', union: isUnion, tag: tag, fields: null, size: null, align: null };
      if (tag) this.addTag((isUnion ? 'u:' : 's:') + tag, type);
    }
    return type;
  };

  P.parseEnumSpec = function () {
    this.next(); // enum
    this.skipAttributes();
    var tag = null;
    if (this.isId()) tag = this.next().v;
    if (this.isP('{')) {
      this.next();
      var members = [];
      while (!this.isP('}') && this.peek().k !== 'eof') {
        if (!this.isId()) { this.err('oczekiwano nazwy elementu enum'); this.next(); continue; }
        var nm = this.next().v;
        var ex = null;
        if (this.eatP('=')) ex = this.parseAssign();
        members.push({ name: nm, expr: ex, loc: this.loc() });
        if (this.eatP(',')) continue;
        break;
      }
      this.expectP('}', 'na końcu enum');
      this.decls.push({ t: 'enumdef', members: members, loc: this.loc() });
    }
    return { k: 'int', size: 4, sg: true };
  };

  /* --- deklaratory --- */
  // zwraca {name, type, loc, params?}
  P.parseDeclarator = function (base, abstract) {
    var quals = 0;
    var ty = base;
    while (this.isP('*')) {
      this.next();
      while (this.isId('const') || this.isId('volatile') || this.isId('restrict') || this.isId('__restrict')) this.next();
      this.skipAttributes();
      ty = T.ptr(ty);
    }
    return this.parseDirectDeclarator(ty, abstract);
  };

  P.parseDirectDeclarator = function (ty, abstract) {
    this.skipAttributes();
    var name = null, loc = this.loc();
    var inner = null;
    if (this.isP('(') && this.isInnerDeclarator()) {
      this.next();
      inner = this.parseDeclarator(T.tVoid /*placeholder*/, abstract); // typ uzupełnimy
      this.expectP(')', 'w deklaratorze');
    } else if (this.isId() && !abstract) {
      var t = this.peek();
      // nie zjadaj słów kluczowych
      if (!TYPEWORD[t.v] && !STORAGE[t.v] && !QUAL[t.v] && t.v !== 'struct' && t.v !== 'union' && t.v !== 'enum') {
        name = this.next().v;
        loc = this.loc(t);
      }
    } else if (this.isId() && abstract) {
      // abstract: nazwa opcjonalna (parametry mogą mieć nazwy)
      var t2 = this.peek();
      if (!TYPEWORD[t2.v] && !STORAGE[t2.v] && !QUAL[t2.v] && t2.v !== 'struct' && t2.v !== 'union' && t2.v !== 'enum' && !this.findTypedef(t2.v)) {
        name = this.next().v;
        loc = this.loc(t2);
      }
    }

    // sufiksy
    var suffixes = [];
    for (; ;) {
      if (this.isP('[')) {
        this.next();
        var nExpr = null;
        if (!this.isP(']')) nExpr = this.parseAssign();
        this.expectP(']', 'w deklaracji tablicy');
        suffixes.push({ kind: 'arr', nExpr: nExpr });
        continue;
      }
      if (this.isP('(')) {
        this.next();
        var params = [], varargs = false;
        if (this.isP(')')) { /* () — bez prototypu: traktuj jak (void) */ }
        else if (this.isId('void') && this.isP(')', 1)) { this.next(); }
        else {
          for (; ;) {
            if (this.isP('...')) { this.next(); varargs = true; break; }
            var sp = this.parseDeclSpecs(true);
            if (!sp) { this.err('oczekiwano typu parametru'); break; }
            var pd = this.parseDeclarator(sp.type, true);
            var pt = pd.type;
            if (pt.k === 'arr') pt = T.ptr(pt.of);
            if (pt.k === 'fn') pt = T.ptr(pt);
            params.push({ name: pd.name, type: pt, loc: pd.loc });
            if (this.eatP(',')) continue;
            break;
          }
        }
        this.expectP(')', 'po liście parametrów');
        suffixes.push({ kind: 'fn', params: params, varargs: varargs });
        continue;
      }
      break;
    }
    this.skipAttributes();

    // zbuduj typ od wewnątrz: sufiksy stosują się do "name"
    var built = ty;
    for (var i = suffixes.length - 1; i >= 0; i--) {
      var s = suffixes[i];
      if (s.kind === 'arr') built = T.arr(built, s.nExpr);
      else built = T.fn(built, s.params, s.varargs);
    }
    if (inner) {
      // inner parsowano z placeholderem; podmień najgłębszy "void" na built
      var res = substDeclType(inner.type, built);
      return { name: inner.name, type: res, loc: inner.loc, _suffixParams: lastFnParams(res) };
    }
    return { name: name, type: built, loc: loc, _suffixParams: (suffixes.length && suffixes[0].kind === 'fn') ? suffixes[0].params : null };
  };

  function lastFnParams(t) {
    // znajdź parametry najbardziej zewnętrznej funkcji — dla definicji funkcji przez wskaźnik (nieużywane)
    return null;
  }

  function substDeclType(t, repl) {
    // podmień placeholder (void będący "rdzeniem") na repl
    if (t === T.tVoid) return repl;
    if (t.k === 'ptr') return { k: 'ptr', to: substDeclType(t.to, repl), size: 4 };
    if (t.k === 'arr') { var a = T.arr(substDeclType(t.of, repl), t.nExpr); a.n = t.n; return a; }
    if (t.k === 'fn') return T.fn(substDeclType(t.ret, repl), t.params, t.varargs);
    return t;
  }

  // czy '(' rozpoczyna zagnieżdżony deklarator (a nie listę parametrów)?
  P.isInnerDeclarator = function () {
    var t = this.peek(1);
    if (t.k === 'p' && t.v === '*') return true;
    if (t.k === 'p' && t.v === '(') return true;
    if (t.k === 'id' && !TYPEWORD[t.v] && !QUAL[t.v] && !STORAGE[t.v] &&
      t.v !== 'struct' && t.v !== 'union' && t.v !== 'enum' && !this.findTypedef(t.v)) {
      // (name) — może być deklaratorem (np. int (x)); może też być param o nazwie... przyjmij deklarator
      var t2 = this.peek(2);
      if (t2.k === 'p' && (t2.v === ')' || t2.v === '[' || t2.v === '(')) return true;
    }
    return false;
  };

  /* --- inicjalizatory --- */
  P.parseInitializer = function () {
    if (this.isP('{')) {
      var lt = this.next();
      var items = [];
      while (!this.isP('}') && this.peek().k !== 'eof') {
        if (this.isP('.') || this.isP('[')) {
          this.err('inicjalizatory desygnowane (.pole=, [i]=) nie są obsługiwane');
          // pomiń do '=' i czytaj wartość
          while (!this.isP('=') && !this.isP('}') && this.peek().k !== 'eof') this.next();
          this.eatP('=');
        }
        items.push(this.parseInitializer());
        if (this.eatP(',')) continue;
        break;
      }
      this.expectP('}', 'na końcu inicjalizatora');
      return { t: 'ilist', items: items, loc: this.loc(lt) };
    }
    return this.parseAssign();
  };

  /* --- deklaracja (zewnętrzna lub lokalna) --- */
  // zwraca node {t:'decl', items:[...]} lub {t:'func',...} lub null
  P.parseDeclaration = function (topLevel) {
    var specs = this.parseDeclSpecs(true);
    if (!specs) { this.next(); return null; }
    if (this.isP(';')) { this.next(); return { t: 'decl', items: [], loc: specs.loc }; } // sama struct/enum def

    var items = [];
    var first = true;
    for (; ;) {
      var d = this.parseDeclarator(specs.type, false);
      this.skipAttributes();
      if (!d.name) {
        this.err('brak nazwy w deklaracji');
      }
      if (specs.storage.typedef) {
        if (d.name) this.addTypedef(d.name, d.type);
        if (this.eatP(',')) { first = false; continue; }
        this.expectP(';', 'po typedef');
        return { t: 'decl', items: [], loc: specs.loc };
      }
      // definicja funkcji?
      if (first && topLevel && d.type.k === 'fn' && this.isP('{')) {
        this.pushScope();
        var body = this.parseCompound(); // parseCompound robi własny scope — ok (podwójny nie szkodzi typedefom)
        this.popScope();
        return {
          t: 'func', name: d.name, type: d.type, body: body,
          static: specs.storage.static, inline: specs.storage.inline, loc: d.loc
        };
      }
      var init = null;
      if (this.eatP('=')) init = this.parseInitializer();
      items.push({
        name: d.name, type: d.type, init: init,
        static: specs.storage.static, extern: specs.storage.extern, loc: d.loc
      });
      first = false;
      if (this.eatP(',')) continue;
      break;
    }
    this.expectP(';', 'po deklaracji');
    return { t: 'decl', items: items, loc: specs.loc };
  };

  /* --- instrukcje --- */
  P.parseCompound = function () {
    var lt = this.peek();
    this.expectP('{', 'na początku bloku');
    this.pushScope();
    var items = [];
    while (!this.isP('}') && this.peek().k !== 'eof') {
      var s = this.parseBlockItem();
      if (s) items.push(s);
    }
    this.expectP('}', 'na końcu bloku');
    this.popScope();
    return { t: 'compound', items: items, loc: this.loc(lt) };
  };

  P.parseBlockItem = function () {
    if (this.startsDecl()) {
      return this.parseDeclaration(false);
    }
    return this.parseStmt();
  };

  P.parseStmt = function () {
    var t = this.peek();
    if (t.k === 'p') {
      switch (t.v) {
        case '{': return this.parseCompound();
        case ';': this.next(); return { t: 'empty', loc: this.loc(t) };
      }
    }
    if (t.k === 'id') {
      switch (t.v) {
        case 'if': {
          this.next(); this.expectP('(', 'po if');
          var c = this.parseExpr(); this.expectP(')', 'po warunku if');
          var a = this.parseStmt();
          var b = null;
          if (this.eatId('else')) b = this.parseStmt();
          return { t: 'if', c: c, a: a, b: b, loc: this.loc(t) };
        }
        case 'while': {
          this.next(); this.expectP('(', 'po while');
          var c2 = this.parseExpr(); this.expectP(')', 'po warunku while');
          var body = this.parseStmt();
          return { t: 'while', c: c2, body: body, loc: this.loc(t) };
        }
        case 'do': {
          this.next();
          var body2 = this.parseStmt();
          if (!this.eatId('while')) this.err('oczekiwano "while" po "do"');
          this.expectP('(', 'po do..while');
          var c3 = this.parseExpr(); this.expectP(')');
          this.expectP(';', 'po do..while');
          return { t: 'do', body: body2, c: c3, loc: this.loc(t) };
        }
        case 'for': {
          this.next(); this.expectP('(', 'po for');
          var init = null;
          if (this.isP(';')) this.next();
          else if (this.startsDecl()) init = this.parseDeclaration(false);
          else { init = { t: 'expr', e: this.parseExpr(), loc: this.loc() }; this.expectP(';', 'w for'); }
          var cond = null;
          if (!this.isP(';')) cond = this.parseExpr();
          this.expectP(';', 'w for');
          var inc = null;
          if (!this.isP(')')) inc = this.parseExpr();
          this.expectP(')', 'po for');
          var body3 = this.parseStmt();
          return { t: 'for', init: init, c: cond, inc: inc, body: body3, loc: this.loc(t) };
        }
        case 'switch': {
          this.next(); this.expectP('(', 'po switch');
          var e = this.parseExpr(); this.expectP(')');
          var sbody = this.parseStmt();
          return { t: 'switch', e: e, body: sbody, loc: this.loc(t) };
        }
        case 'case': {
          this.next();
          var ce = this.parseTernary();
          this.expectP(':', 'po case');
          return { t: 'case', e: ce, loc: this.loc(t) };
        }
        case 'default': {
          this.next(); this.expectP(':', 'po default');
          return { t: 'default', loc: this.loc(t) };
        }
        case 'break': this.next(); this.expectP(';'); return { t: 'break', loc: this.loc(t) };
        case 'continue': this.next(); this.expectP(';'); return { t: 'continue', loc: this.loc(t) };
        case 'return': {
          this.next();
          var re = null;
          if (!this.isP(';')) re = this.parseExpr();
          this.expectP(';', 'po return');
          return { t: 'return', e: re, loc: this.loc(t) };
        }
        case 'goto': {
          this.next();
          var lbl = this.isId() ? this.next().v : '?';
          this.expectP(';');
          this.err('instrukcja "goto" nie jest obsługiwana w symulatorze', t);
          return { t: 'empty', loc: this.loc(t) };
        }
        case 'asm': case '__asm': case '__asm__': {
          this.next();
          while (this.isId('volatile') || this.isId('__volatile__')) this.next();
          var txt = '';
          if (this.isP('(')) {
            var depth = 0;
            for (; ;) {
              var tt = this.next();
              if (tt.k === 'eof') break;
              if (tt.k === 'str') txt += tt.v;
              if (tt.k === 'p' && tt.v === '(') depth++;
              else if (tt.k === 'p' && tt.v === ')') { depth--; if (!depth) break; }
            }
          }
          this.eatP(';');
          return { t: 'asm', text: txt, loc: this.loc(t) };
        }
      }
      // etykieta?
      if (this.peek(1).k === 'p' && this.peek(1).v === ':' && !this.isId('default')) {
        // label: stmt — etykiety ignorujemy (goto nieobsługiwane)
        var lt2 = this.next();
        this.next(); // ':'
        this.diags.push({
          sev: 'warning', msg: 'etykieta "' + lt2.v + '" zignorowana (goto nieobsługiwane)',
          file: this.fname(lt2), line: lt2.l
        });
        return this.parseStmt();
      }
    }
    // wyrażenie
    var e2 = this.parseExpr();
    this.expectP(';', 'po wyrażeniu');
    return { t: 'expr', e: e2, loc: e2 ? e2.loc : this.loc(t) };
  };

  /* --- wyrażenia --- */
  P.parseExpr = function () {
    var e = this.parseAssign();
    while (this.isP(',')) {
      var t = this.next();
      var b = this.parseAssign();
      e = { t: 'comma', a: e, b: b, loc: this.loc(t) };
    }
    return e;
  };

  var ASSIGN_OPS = { '=': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '<<=': 1, '>>=': 1, '&=': 1, '^=': 1, '|=': 1 };

  P.parseAssign = function () {
    var lhs = this.parseTernary();
    var t = this.peek();
    if (t.k === 'p' && ASSIGN_OPS[t.v]) {
      this.next();
      var rhs = this.parseAssign();
      return { t: 'assign', op: t.v, a: lhs, b: rhs, loc: this.loc(t) };
    }
    return lhs;
  };

  P.parseTernary = function () {
    var c = this.parseBinary(0);
    if (this.isP('?')) {
      var t = this.next();
      var a = this.parseExpr();
      this.expectP(':', 'w wyrażeniu ?:');
      var b = this.parseTernary();
      return { t: 'cond', c: c, a: a, b: b, loc: this.loc(t) };
    }
    return c;
  };

  var BINLEVELS = [
    ['||'], ['&&'], ['|'], ['^'], ['&'],
    ['==', '!='], ['<', '>', '<=', '>='],
    ['<<', '>>'], ['+', '-'], ['*', '/', '%']
  ];

  P.parseBinary = function (lv) {
    if (lv >= BINLEVELS.length) return this.parseCast();
    var ops = BINLEVELS[lv];
    var e = this.parseBinary(lv + 1);
    for (; ;) {
      var t = this.peek();
      if (t.k !== 'p' || ops.indexOf(t.v) < 0) return e;
      this.next();
      var b = this.parseBinary(lv + 1);
      e = { t: 'bin', op: t.v, a: e, b: b, loc: this.loc(t) };
    }
  };

  P.isTypeStart = function (o) {
    var t = this.peek(o || 0);
    if (t.k !== 'id') return false;
    if (TYPEWORD[t.v] || QUAL[t.v]) return true;
    if (t.v === 'struct' || t.v === 'union' || t.v === 'enum') return true;
    return !!this.findTypedef(t.v);
  };

  P.parseCast = function () {
    if (this.isP('(') && this.isTypeStart(1)) {
      var t = this.next(); // (
      var ty = this.parseTypeName();
      this.expectP(')', 'po nazwie typu w rzutowaniu');
      // (type){...} — compound literal: nieobsługiwane
      if (this.isP('{')) {
        this.err('literały złożone (compound literals) nie są obsługiwane');
        var il = this.parseInitializer();
        return { t: 'num', v: { n: 0, fl: false, u: false }, loc: this.loc(t) };
      }
      var e = this.parseCast();
      return { t: 'cast', type: ty, e: e, loc: this.loc(t) };
    }
    return this.parseUnary();
  };

  P.parseTypeName = function () {
    var specs = this.parseDeclSpecs(true);
    if (!specs) return T.tInt;
    var d = this.parseDeclarator(specs.type, true);
    return d.type;
  };

  P.parseUnary = function () {
    var t = this.peek();
    if (t.k === 'p') {
      switch (t.v) {
        case '++': case '--': {
          this.next();
          var e = this.parseUnary();
          return { t: 'un', op: t.v === '++' ? 'preinc' : 'predec', e: e, loc: this.loc(t) };
        }
        case '&': case '*': case '+': case '-': case '~': case '!': {
          this.next();
          var e2 = this.parseCast();
          return { t: 'un', op: t.v, e: e2, loc: this.loc(t) };
        }
      }
    }
    if (t.k === 'id' && t.v === 'sizeof') {
      this.next();
      if (this.isP('(') && this.isTypeStart(1)) {
        this.next();
        var ty = this.parseTypeName();
        this.expectP(')', 'po sizeof(typ)');
        return { t: 'sizeof', type: ty, e: null, loc: this.loc(t) };
      }
      var e3 = this.parseUnary();
      return { t: 'sizeof', type: null, e: e3, loc: this.loc(t) };
    }
    return this.parsePostfix();
  };

  P.parsePostfix = function () {
    var e = this.parsePrimary();
    for (; ;) {
      var t = this.peek();
      if (t.k !== 'p') return e;
      switch (t.v) {
        case '[': {
          this.next();
          var i = this.parseExpr();
          this.expectP(']', 'po indeksie tablicy');
          e = { t: 'idx', a: e, i: i, loc: this.loc(t) };
          continue;
        }
        case '(': {
          this.next();
          var args = [];
          if (!this.isP(')')) {
            for (; ;) {
              args.push(this.parseAssign());
              if (this.eatP(',')) continue;
              break;
            }
          }
          this.expectP(')', 'po argumentach wywołania');
          e = { t: 'call', fn: e, args: args, loc: this.loc(t) };
          continue;
        }
        case '.': {
          this.next();
          var nm = this.isId() ? this.next().v : '?';
          e = { t: 'mem', e: e, name: nm, arrow: false, loc: this.loc(t) };
          continue;
        }
        case '->': {
          this.next();
          var nm2 = this.isId() ? this.next().v : '?';
          e = { t: 'mem', e: e, name: nm2, arrow: true, loc: this.loc(t) };
          continue;
        }
        case '++': this.next(); e = { t: 'un', op: 'postinc', e: e, loc: this.loc(t) }; continue;
        case '--': this.next(); e = { t: 'un', op: 'postdec', e: e, loc: this.loc(t) }; continue;
        default: return e;
      }
    }
  };

  P.parsePrimary = function () {
    var t = this.peek();
    if (t.k === 'num') { this.next(); return { t: 'num', v: t.v, loc: this.loc(t) }; }
    if (t.k === 'ch') { this.next(); return { t: 'num', v: { n: t.v, fl: false, u: false }, loc: this.loc(t) }; }
    if (t.k === 'str') {
      this.next();
      var s = t.v;
      while (this.peek().k === 'str') s += this.next().v; // konkatenacja
      return { t: 'str', v: s, loc: this.loc(t) };
    }
    if (t.k === 'id') {
      this.next();
      return { t: 'id', name: t.v, loc: this.loc(t) };
    }
    if (t.k === 'p' && t.v === '(') {
      this.next();
      var e = this.parseExpr();
      this.expectP(')', 'po wyrażeniu w nawiasach');
      return e;
    }
    this.err('nieoczekiwany element: ' + dispTok(t), t);
    this.next();
    return { t: 'num', v: { n: 0, fl: false, u: false }, loc: this.loc(t) };
  };

  /* --- przebieg główny --- */
  P.parseUnit = function () {
    while (this.peek().k !== 'eof') {
      // pomiń zbędne średniki
      if (this.eatP(';')) continue;
      if (this.startsDecl()) {
        var d = this.parseDeclaration(true);
        if (d) this.decls.push(d);
        continue;
      }
      var t = this.peek();
      // stara składnia K&R "main() {...}" — int domyślny
      if (t.k === 'id' && this.peek(1).k === 'p' && this.peek(1).v === '(') {
        var save = this.pos;
        var d2 = this.parseDeclarator(T.tInt, false);
        if (d2.type.k === 'fn' && this.isP('{')) {
          this.pushScope();
          var body = this.parseCompound();
          this.popScope();
          this.decls.push({ t: 'func', name: d2.name, type: d2.type, body: body, static: false, loc: d2.loc });
          continue;
        }
        this.pos = save;
      }
      this.err('nieoczekiwany element na poziomie pliku: ' + dispTok(t), t);
      this.next();
    }
    return this.decls;
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
