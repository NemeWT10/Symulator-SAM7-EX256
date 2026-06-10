/* ============================================================
 * Symulator SAM7-EX256 — kompilator C
 * cc_lex.js — tokenizer + preprocesor C
 * Token: {k, v, f, l}  k: 'id' | 'num' | 'str' | 'ch' | 'p' | 'nl' | 'eof'
 *   num: v = {n:Number, fl:bool, u:bool}
 *   str: v = String (zdekodowana, bajty 0..255)
 *   ch:  v = Number (kod znaku)
 *   p:   v = tekst operatora
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC || (g.CC = {});

  // ---------- pomocnicze ----------
  function CompileError(msg, file, line) {
    this.message = msg; this.file = file; this.line = line;
    this.stack = (new Error()).stack;
  }
  CompileError.prototype = Object.create(Error.prototype);
  CompileError.prototype.name = 'CompileError';
  CC.CompileError = CompileError;

  var PUNCTS = [
    '<<=', '>>=', '...',
    '->', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '##',
    '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=',
    '(', ')', '[', ']', '{', '}', ';', ',', '.', '?', ':', '#', '\\'
  ];
  // mapa: pierwszy znak -> lista punktów (posortowana wg długości malejąco)
  var PUNCT_BY_FIRST = {};
  PUNCTS.forEach(function (p) {
    var c = p[0];
    (PUNCT_BY_FIRST[c] || (PUNCT_BY_FIRST[c] = [])).push(p);
  });
  Object.keys(PUNCT_BY_FIRST).forEach(function (c) {
    PUNCT_BY_FIRST[c].sort(function (a, b) { return b.length - a.length; });
  });

  function isIdStart(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
  }
  function isIdChar(c) {
    return isIdStart(c) || (c >= '0' && c <= '9');
  }
  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isHex(c) {
    return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
  }

  /* ----------------------------------------------------------
   * cleanSource: usuwa komentarze (zamiana na spacje), skleja
   * kontynuacje linii '\'+NL (zamiana na \x01 — licznik linii
   * rośnie, ale dyrektywa się nie kończy). Zachowuje '\n'.
   * -------------------------------------------------------- */
  function cleanSource(src) {
    var out = [];
    var i = 0, n = src.length;
    var st = 0; // 0 normal, 1 str, 2 chr, 3 //, 4 /* */
    while (i < n) {
      var c = src[i];
      var c2 = (i + 1 < n) ? src[i + 1] : '';
      if (st === 0) {
        if (c === '/' && c2 === '/') { st = 3; out.push(' '); i += 2; continue; }
        if (c === '/' && c2 === '*') { st = 4; out.push(' '); i += 2; continue; }
        if (c === '"') { st = 1; out.push(c); i++; continue; }
        if (c === '\'') { st = 2; out.push(c); i++; continue; }
        if (c === '\\' && (c2 === '\n' || (c2 === '\r' && src[i + 2] === '\n'))) {
          out.push('\x01'); i += (c2 === '\r') ? 3 : 2; continue;
        }
        if (c === '\r') { i++; continue; }
        out.push(c); i++; continue;
      }
      if (st === 1 || st === 2) {
        var q = (st === 1) ? '"' : '\'';
        if (c === '\\' && i + 1 < n) { out.push(c, c2); i += 2; continue; }
        if (c === q) { st = 0; out.push(c); i++; continue; }
        if (c === '\n') { st = 0; out.push(c); i++; continue; } // niezamknięty literał — pozwól lexerowi zgłosić
        if (c === '\r') { i++; continue; }
        out.push(c); i++; continue;
      }
      if (st === 3) { // komentarz //
        if (c === '\\' && (c2 === '\n' || (c2 === '\r' && src[i + 2] === '\n'))) {
          // kontynuacja w komentarzu liniowym — komentarz trwa dalej
          out.push('\x01'); i += (c2 === '\r') ? 3 : 2; continue;
        }
        if (c === '\n') { st = 0; out.push('\n'); i++; continue; }
        if (c === '\r') { i++; continue; }
        i++; continue;
      }
      // st === 4: komentarz blokowy
      if (c === '*' && c2 === '/') { st = 0; out.push(' '); i += 2; continue; }
      if (c === '\n') { out.push('\n'); }
      if (c === '\r') { i++; continue; }
      i++;
    }
    return out.join('');
  }

  /* ----------------------------------------------------------
   * Tokenizer pojedynczego (oczyszczonego) źródła.
   * Zwraca tablicę tokenów; '\n' => token 'nl'.
   * -------------------------------------------------------- */
  function tokenize(text, fileIdx, diag) {
    var toks = [];
    var i = 0, n = text.length, line = 1;
    while (i < n) {
      var c = text[i];
      if (c === '\n') { toks.push({ k: 'nl', v: '', f: fileIdx, l: line }); line++; i++; continue; }
      if (c === '\x01') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\f' || c === '\v') { i++; continue; }

      // identyfikator / słowo kluczowe
      if (isIdStart(c)) {
        var j = i + 1;
        while (j < n && isIdChar(text[j])) j++;
        toks.push({ k: 'id', v: text.slice(i, j), f: fileIdx, l: line });
        i = j; continue;
      }

      // liczba (pp-number)
      if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
        var j2 = i, isFl = false, isHexN = false;
        if (c === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
          isHexN = true; j2 = i + 2;
          while (j2 < n && isHex(text[j2])) j2++;
        } else {
          while (j2 < n && isDigit(text[j2])) j2++;
          if (text[j2] === '.') { isFl = true; j2++; while (j2 < n && isDigit(text[j2])) j2++; }
          if (text[j2] === 'e' || text[j2] === 'E') {
            var k2 = j2 + 1;
            if (text[k2] === '+' || text[k2] === '-') k2++;
            if (isDigit(text[k2])) { isFl = true; j2 = k2; while (j2 < n && isDigit(text[j2])) j2++; }
          }
        }
        var numTxt = text.slice(i, j2);
        var un = false, fl = isFl;
        // sufiksy
        while (j2 < n) {
          var sc = text[j2];
          if (sc === 'u' || sc === 'U') { un = true; j2++; continue; }
          if (sc === 'l' || sc === 'L') { j2++; continue; }
          if (!isHexN && (sc === 'f' || sc === 'F')) { fl = true; j2++; continue; }
          break;
        }
        var val;
        if (fl) val = parseFloat(numTxt);
        else if (isHexN) val = parseInt(numTxt, 16);
        else if (numTxt.length > 1 && numTxt[0] === '0') val = parseInt(numTxt, 8);
        else val = parseInt(numTxt, 10);
        if (!fl && (val > 0xFFFFFFFF)) {
          diag.warn('stała ' + numTxt + ' przekracza 32 bity — zostanie obcięta', fileIdx, line);
          val = val >>> 0;
        }
        toks.push({ k: 'num', v: { n: val, fl: fl, u: un }, f: fileIdx, l: line });
        i = j2; continue;
      }

      // łańcuch znaków
      if (c === '"') {
        var res = readQuoted(text, i, '"', fileIdx, line, diag);
        toks.push({ k: 'str', v: res.s, f: fileIdx, l: line });
        i = res.i; continue;
      }
      // znak
      if (c === '\'') {
        var res2 = readQuoted(text, i, '\'', fileIdx, line, diag);
        var code = res2.s.length ? res2.s.charCodeAt(0) : 0;
        if (res2.s.length > 1) {
          // wieloznakowa stała znakowa np. 'ab' — rzadkość; weź pierwszy bajt
          diag.warn('wieloznakowa stała znakowa', fileIdx, line);
        }
        toks.push({ k: 'ch', v: code, f: fileIdx, l: line });
        i = res2.i; continue;
      }

      // operator
      var lst = PUNCT_BY_FIRST[c];
      if (lst) {
        var hit = null;
        for (var pi = 0; pi < lst.length; pi++) {
          var p = lst[pi];
          if (text.substr(i, p.length) === p) { hit = p; break; }
        }
        if (hit) {
          toks.push({ k: 'p', v: hit, f: fileIdx, l: line });
          i += hit.length; continue;
        }
      }
      diag.warn('nieznany znak "' + c + '" (kod ' + text.charCodeAt(i) + ') — pominięto', fileIdx, line);
      i++;
    }
    toks.push({ k: 'nl', v: '', f: fileIdx, l: line });
    return toks;
  }

  function readQuoted(text, i, q, fileIdx, line, diag) {
    // text[i] === q
    var s = [];
    var n = text.length;
    i++;
    while (i < n) {
      var c = text[i];
      if (c === q) { i++; break; }
      if (c === '\n') { diag.error('niezamknięty literał', fileIdx, line); break; }
      if (c === '\\') {
        var e = text[i + 1]; i += 2;
        switch (e) {
          case 'n': s.push('\n'); break;
          case 't': s.push('\t'); break;
          case 'r': s.push('\r'); break;
          case '0': case '1': case '2': case '3':
          case '4': case '5': case '6': case '7': {
            var oct = e, cnt = 1;
            while (cnt < 3 && text[i] >= '0' && text[i] <= '7') { oct += text[i]; i++; cnt++; }
            s.push(String.fromCharCode(parseInt(oct, 8) & 0xFF)); break;
          }
          case 'x': {
            var hx = '';
            while (isHex(text[i])) { hx += text[i]; i++; }
            s.push(String.fromCharCode((parseInt(hx || '0', 16)) & 0xFF)); break;
          }
          case 'a': s.push('\x07'); break;
          case 'b': s.push('\b'); break;
          case 'f': s.push('\f'); break;
          case 'v': s.push('\v'); break;
          case '\\': s.push('\\'); break;
          case '\'': s.push('\''); break;
          case '"': s.push('"'); break;
          case '?': s.push('?'); break;
          default: s.push(e || ''); break;
        }
        continue;
      }
      s.push(c); i++;
    }
    return { s: s.join(''), i: i };
  }

  /* ----------------------------------------------------------
   * Preprocesor
   * fs: { resolve: function(name, fromPath, angled) -> {path, text} | null }
   * -------------------------------------------------------- */
  function Preprocessor(fs) {
    this.fs = fs;
    this.macros = new Map();
    this.out = [];
    this.files = [];        // nazwy plików (indeksowane przez tok.f)
    this.fileIdxByPath = new Map();
    this.diags = [];        // {sev:'error'|'warning', msg, file, line}
    this.includeDepth = 0;
    this.onceSet = new Set();
    this.errCount = 0;
  }
  CC.Preprocessor = Preprocessor;

  Preprocessor.prototype.fileIdx = function (path) {
    if (this.fileIdxByPath.has(path)) return this.fileIdxByPath.get(path);
    var idx = this.files.length;
    this.files.push(path);
    this.fileIdxByPath.set(path, idx);
    return idx;
  };

  Preprocessor.prototype.error = function (msg, f, l) {
    this.errCount++;
    this.diags.push({ sev: 'error', msg: msg, file: this.files[f] || '?', line: l || 0 });
    if (this.errCount > 30) {
      throw new CompileError('zbyt wiele błędów preprocesora — przerwano', this.files[f] || '?', l || 0);
    }
  };
  Preprocessor.prototype.warn = function (msg, f, l) {
    this.diags.push({ sev: 'warning', msg: msg, file: this.files[f] || '?', line: l || 0 });
  };

  Preprocessor.prototype.define = function (name, body) {
    // proste #define z zewnątrz (predefiniowane); body — string
    var toks = tokenize(cleanSource(String(body)), this.fileIdx('<builtin>'), this.mkDiag());
    // usuń końcowe nl
    var bt = toks.filter(function (t) { return t.k !== 'nl'; });
    this.macros.set(name, { params: null, body: bt, variadic: false });
  };

  Preprocessor.prototype.mkDiag = function () {
    var self = this;
    return {
      warn: function (m, f, l) { self.warn(m, f, l); },
      error: function (m, f, l) { self.error(m, f, l); }
    };
  };

  Preprocessor.prototype.run = function (mainPath, mainText) {
    this.processFile(mainPath, mainText);
    this.out.push({ k: 'eof', v: '', f: this.fileIdx(mainPath), l: 0 });
    return this.out;
  };

  Preprocessor.prototype.processFile = function (path, text) {
    var fIdx = this.fileIdx(path);
    var cleaned = cleanSource(text);
    var rawLines = text.split(/\r\n|\n|\r/); // do parsowania #include
    var toks = tokenize(cleaned, fIdx, this.mkDiag());
    this.processTokens(toks, rawLines, path);
  };

  // stos warunków: {active, everTaken, elseSeen, parentActive}
  Preprocessor.prototype.processTokens = function (toks, rawLines, path) {
    var i = 0, n = toks.length;
    var cond = [];
    var self = this;
    function activeNow() {
      for (var ci = 0; ci < cond.length; ci++) if (!cond[ci].active) return false;
      return true;
    }
    var atLineStart = true;
    while (i < n) {
      var t = toks[i];
      if (t.k === 'nl') { atLineStart = true; i++; continue; }
      if (t.k === 'p' && t.v === '#' && atLineStart) {
        // dyrektywa: zbierz tokeny do nl
        var j = i + 1;
        var dir = [];
        while (j < n && toks[j].k !== 'nl') { dir.push(toks[j]); j++; }
        this.handleDirective(dir, t, cond, activeNow, rawLines, path);
        i = j; // wskazuje nl
        continue;
      }
      atLineStart = false;
      if (!activeNow()) { i++; continue; }
      // zwykły tekst: ekspanduj makra aż do następnej dyrektywy
      // (zbierz ciąg tokenów do momentu '#' na początku linii)
      var run = [];
      var k = i;
      var ls = false;
      while (k < n) {
        var tk = toks[k];
        if (tk.k === 'nl') { ls = true; run.push(tk); k++; continue; }
        if (ls && tk.k === 'p' && tk.v === '#') break;
        if (tk.k === 'eof') break;
        ls = false;
        run.push(tk); k++;
      }
      this.expandInto(run, this.out);
      i = k;
      atLineStart = true;
      continue;
    }
    if (cond.length) {
      this.error('brak #endif (otwarte #if/#ifdef)', toks[0] ? toks[0].f : 0, 1);
    }
  };

  Preprocessor.prototype.handleDirective = function (dir, hashTok, cond, activeNow, rawLines, path) {
    var self = this;
    if (!dir.length) return; // pusta dyrektywa '#'
    var d0 = dir[0];
    var name = (d0.k === 'id') ? d0.v : (d0.k === 'p' ? d0.v : '');
    var rest = dir.slice(1);

    function parentActive() {
      for (var ci = 0; ci < cond.length - 1; ci++) if (!cond[ci].active) return false;
      return true;
    }

    switch (name) {
      case 'ifdef': case 'ifndef': {
        if (!activeNow()) { cond.push({ active: false, everTaken: true, elseSeen: false }); return; }
        var id = rest[0];
        var def = id && id.k === 'id' && this.macros.has(id.v);
        var act = (name === 'ifdef') ? def : !def;
        cond.push({ active: act, everTaken: act, elseSeen: false });
        return;
      }
      case 'if': {
        if (!activeNow()) { cond.push({ active: false, everTaken: true, elseSeen: false }); return; }
        var v = this.evalCond(rest, d0);
        cond.push({ active: v !== 0, everTaken: v !== 0, elseSeen: false });
        return;
      }
      case 'elif': {
        if (!cond.length) { this.error('#elif bez #if', d0.f, d0.l); return; }
        var c = cond[cond.length - 1];
        if (c.elseSeen) { this.error('#elif po #else', d0.f, d0.l); return; }
        if (!parentActive()) { c.active = false; return; }
        if (c.everTaken) { c.active = false; return; }
        var v2 = this.evalCond(rest, d0);
        c.active = v2 !== 0;
        if (c.active) c.everTaken = true;
        return;
      }
      case 'else': {
        if (!cond.length) { this.error('#else bez #if', d0.f, d0.l); return; }
        var c2 = cond[cond.length - 1];
        if (c2.elseSeen) { this.error('podwójne #else', d0.f, d0.l); return; }
        c2.elseSeen = true;
        c2.active = parentActive() && !c2.everTaken;
        if (c2.active) c2.everTaken = true;
        return;
      }
      case 'endif': {
        if (!cond.length) { this.error('#endif bez #if', d0.f, d0.l); return; }
        cond.pop();
        return;
      }
    }

    if (!activeNow()) return;

    switch (name) {
      case 'include': {
        this.doInclude(rest, d0, rawLines, path);
        return;
      }
      case 'define': {
        this.doDefine(rest, d0);
        return;
      }
      case 'undef': {
        if (rest[0] && rest[0].k === 'id') this.macros.delete(rest[0].v);
        return;
      }
      case 'pragma': {
        if (rest[0] && rest[0].k === 'id' && rest[0].v === 'once') {
          this.onceSet.add(path.toLowerCase());
        }
        return;
      }
      case 'error': {
        var msg = rest.map(tokSpelling).join(' ');
        this.error('#error: ' + msg, d0.f, d0.l);
        return;
      }
      case 'warning': {
        this.warn('#warning: ' + rest.map(tokSpelling).join(' '), d0.f, d0.l);
        return;
      }
      case 'line': return; // ignoruj
      default:
        this.warn('nieznana dyrektywa #' + name + ' — zignorowano', d0.f, d0.l);
        return;
    }
  };

  Preprocessor.prototype.doInclude = function (rest, d0, rawLines, fromPath) {
    if (this.includeDepth > 40) {
      this.error('zbyt głębokie zagnieżdżenie #include', d0.f, d0.l);
      return;
    }
    var name = null, angled = false;
    // preferuj surową linię (backslash w <targets\AT91SAM7.h>)
    var raw = rawLines[d0.l - 1] || '';
    var m = raw.match(/^\s*#\s*include\s*(<([^>]+)>|"([^"]+)")/);
    if (m) {
      if (m[2] !== undefined) { name = m[2]; angled = true; }
      else { name = m[3]; angled = false; }
    } else if (rest[0] && rest[0].k === 'str') {
      name = rest[0].v; angled = false;
    } else if (rest[0] && rest[0].k === 'p' && rest[0].v === '<') {
      name = rest.slice(1, -1).map(tokSpelling).join('');
      angled = true;
    }
    if (!name) { this.error('niepoprawne #include', d0.f, d0.l); return; }
    var res = this.fs.resolve(name, fromPath, angled);
    if (!res) {
      this.error('nie znaleziono pliku nagłówkowego: ' + name +
        (angled ? '  (szukano wśród nagłówków systemowych i plików projektu)' :
          '  (szukano wśród plików projektu i nagłówków systemowych)'), d0.f, d0.l);
      return;
    }
    if (this.onceSet.has(res.path.toLowerCase())) return;
    this.includeDepth++;
    this.processFile(res.path, res.text);
    this.includeDepth--;
  };

  Preprocessor.prototype.doDefine = function (rest, d0) {
    if (!rest.length || rest[0].k !== 'id') {
      this.error('niepoprawne #define', d0.f, d0.l); return;
    }
    var name = rest[0].v;
    var params = null, variadic = false;
    var bodyStart = 1;
    // funkcyjne tylko gdy '(' bezpośrednio przylega — po tokenizacji tracimy
    // odstęp; przyjmij funkcyjne, jeśli następny token to '(' i da się
    // sparsować listę parametrów zakończoną ')'
    if (rest[1] && rest[1].k === 'p' && rest[1].v === '(') {
      // Sprawdź, czy to lista parametrów (id, przecinki, ')')
      var ps = [], ok = true, i = 2, sawAny = false;
      if (rest[2] && rest[2].k === 'p' && rest[2].v === ')') { i = 3; }
      else {
        for (; ;) {
          var t = rest[i];
          if (!t) { ok = false; break; }
          if (t.k === 'id') { ps.push(t.v); i++; sawAny = true; }
          else if (t.k === 'p' && t.v === '...') { variadic = true; i++; }
          else { ok = false; break; }
          var t2 = rest[i];
          if (t2 && t2.k === 'p' && t2.v === ',') { i++; continue; }
          if (t2 && t2.k === 'p' && t2.v === ')') { i++; break; }
          ok = false; break;
        }
      }
      if (ok) { params = ps; bodyStart = i; }
    }
    var body = rest.slice(bodyStart);
    var prev = this.macros.get(name);
    if (prev) {
      var same = sameTokens(stripParens(prev.body), stripParens(body)) &&
        JSON.stringify(prev.params) === JSON.stringify(params);
      if (!same) this.warn('redefinicja makra ' + name, d0.f, d0.l);
    }
    this.macros.set(name, { params: params, body: body, variadic: variadic });
  };

  function stripParens(toks) {
    // do porównań redefinicji: (0x1) i 0x00000001 traktuj tak samo
    return toks.filter(function (t) {
      return !(t.k === 'p' && (t.v === '(' || t.v === ')'));
    });
  }

  function sameTokens(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].k !== b[i].k) return false;
      var av = a[i].v, bv = b[i].v;
      if (a[i].k === 'num') { if (av.n !== bv.n || av.fl !== bv.fl) return false; }
      else if (av !== bv) return false;
    }
    return true;
  }

  function tokSpelling(t) {
    switch (t.k) {
      case 'id': case 'p': return t.v;
      case 'num': return String(t.v.n) + (t.v.fl && Number.isInteger(t.v.n) ? '.0' : '');
      case 'str': return JSON.stringify(t.v);
      case 'ch': return "'" + String.fromCharCode(t.v) + "'";
      default: return '';
    }
  }
  CC.tokSpelling = tokSpelling;

  /* ---------- ekspansja makr ---------- */

  function Cursor(toks) {
    this.stack = [{ a: toks, i: 0 }];
  }
  Cursor.prototype.next = function () {
    while (this.stack.length) {
      var top = this.stack[this.stack.length - 1];
      if (top.i < top.a.length) return top.a[top.i++];
      this.stack.pop();
    }
    return null;
  };
  Cursor.prototype.pushback = function (arr) {
    if (arr.length) this.stack.push({ a: arr, i: 0 });
  };
  Cursor.prototype.peek = function () {
    for (var s = this.stack.length - 1; s >= 0; s--) {
      var fr = this.stack[s];
      if (fr.i < fr.a.length) return fr.a[fr.i];
    }
    return null;
  };
  Cursor.prototype.peekSkipNl = function () {
    for (var s = this.stack.length - 1; s >= 0; s--) {
      var fr = this.stack[s];
      for (var i = fr.i; i < fr.a.length; i++) {
        if (fr.a[i].k !== 'nl') return fr.a[i];
      }
    }
    return null;
  };

  function cloneTok(t, hs, loc) {
    return { k: t.k, v: t.v, f: loc ? loc.f : t.f, l: loc ? loc.l : t.l, hs: hs };
  }
  function hidden(t, name) {
    var hs = t.hs;
    while (hs) {
      if (hs.n === name) return true;
      hs = hs.p;
    }
    return false;
  }

  Preprocessor.prototype.expandInto = function (toks, out) {
    var cur = new Cursor(toks);
    var t;
    while ((t = cur.next()) !== null) {
      if (t.k === 'nl') continue;
      if (t.k === 'id' && this.macros.has(t.v) && !hidden(t, t.v)) {
        var m = this.macros.get(t.v);
        if (m.params === null) {
          var hs = { n: t.v, p: t.hs || null };
          var body = m.body.map(function (bt) { return cloneTok(bt, hs, t); });
          body = this.pasteAndStringize(body, m, null, t);
          cur.pushback(body);
          continue;
        } else {
          var pk = cur.peekSkipNl();
          if (pk && pk.k === 'p' && pk.v === '(') {
            var args = this.collectArgs(cur, t);
            if (args === null) { out.push(t); continue; }
            if (!m.variadic && args.length !== m.params.length &&
              !(m.params.length === 0 && args.length === 1 && args[0].length === 0)) {
              this.error('makro ' + t.v + ' oczekuje ' + m.params.length +
                ' argumentów, podano ' + args.length, t.f, t.l);
            }
            var hs2 = { n: t.v, p: t.hs || null };
            // pre-ekspanduj argumenty
            var expArgs = [];
            for (var ai = 0; ai < args.length; ai++) {
              var ea = [];
              this.expandInto(args[ai], ea);
              expArgs.push(ea);
            }
            var sub = this.substitute(m, args, expArgs, hs2, t);
            cur.pushback(sub);
            continue;
          }
          out.push(t);
          continue;
        }
      }
      out.push(t);
    }
  };

  // obsługa '##' w treści makra obiektowego (bez parametrów)
  Preprocessor.prototype.pasteAndStringize = function (body, m, args, loc) {
    var out = [];
    for (var i = 0; i < body.length; i++) {
      var t = body[i];
      if (body[i + 1] && body[i + 1].k === 'p' && body[i + 1].v === '##' && body[i + 2]) {
        var pasted = tokSpelling(t) + tokSpelling(body[i + 2]);
        var ptoks = tokenize(pasted + '\n', loc.f, this.mkDiag())
          .filter(function (q) { return q.k !== 'nl'; });
        var hs = t.hs;
        for (var y = 0; y < ptoks.length; y++) out.push(cloneTok(ptoks[y], hs, loc));
        i += 2;
        continue;
      }
      out.push(t);
    }
    return out;
  };

  Preprocessor.prototype.collectArgs = function (cur, nameTok) {
    // zjedz '('
    var t;
    do { t = cur.next(); } while (t && t.k === 'nl');
    if (!t || t.k !== 'p' || t.v !== '(') return null;
    var args = [];
    var curArg = [];
    var depth = 1;
    for (; ;) {
      t = cur.next();
      if (t === null) {
        this.error('niedokończone wywołanie makra ' + nameTok.v, nameTok.f, nameTok.l);
        return null;
      }
      if (t.k === 'nl') continue;
      if (t.k === 'p') {
        if (t.v === '(') depth++;
        else if (t.v === ')') {
          depth--;
          if (depth === 0) { args.push(curArg); return args; }
        } else if (t.v === ',' && depth === 1) {
          args.push(curArg); curArg = [];
          continue;
        }
      }
      curArg.push(t);
    }
  };

  Preprocessor.prototype.substitute = function (m, rawArgs, expArgs, hs, loc) {
    var out = [];
    var body = m.body;
    var pidx = {};
    m.params.forEach(function (p, i) { pidx[p] = i; });
    for (var i = 0; i < body.length; i++) {
      var t = body[i];
      // # param
      if (t.k === 'p' && t.v === '#' && body[i + 1] && body[i + 1].k === 'id' &&
        pidx.hasOwnProperty(body[i + 1].v)) {
        var arg = rawArgs[pidx[body[i + 1].v]] || [];
        out.push({ k: 'str', v: arg.map(tokSpelling).join(' '), f: loc.f, l: loc.l, hs: hs });
        i++;
        continue;
      }
      // token ## token
      if (body[i + 1] && body[i + 1].k === 'p' && body[i + 1].v === '##' && body[i + 2]) {
        var leftToks = this.substOne(t, pidx, rawArgs, hs, loc, true);
        var rightToks = this.substOne(body[i + 2], pidx, rawArgs, hs, loc, true);
        var lt = leftToks.length ? leftToks[leftToks.length - 1] : null;
        var rt = rightToks.length ? rightToks[0] : null;
        // wszystko przed lt
        for (var x = 0; x < leftToks.length - 1; x++) out.push(leftToks[x]);
        var pasted = (lt ? tokSpelling(lt) : '') + (rt ? tokSpelling(rt) : '');
        var ptoks = tokenize(pasted + '\n', loc.f, this.mkDiag())
          .filter(function (q) { return q.k !== 'nl'; })
          .map(function (q) { return cloneTok(q, hs, loc); });
        for (var y = 0; y < ptoks.length; y++) out.push(ptoks[y]);
        for (var z = 1; z < rightToks.length; z++) out.push(rightToks[z]);
        i += 2;
        continue;
      }
      // zwykły parametr → wstaw pre-ekspandowany argument
      if (t.k === 'id' && pidx.hasOwnProperty(t.v)) {
        var ea = expArgs[pidx[t.v]] || [];
        for (var w = 0; w < ea.length; w++) out.push(cloneTok(ea[w], joinHs(ea[w].hs, hs), loc));
        continue;
      }
      out.push(cloneTok(t, hs, loc));
    }
    return out;
  };

  function joinHs(a, b) {
    // suma ukrytych zbiorów (lista powiązana) — wystarczy nadpisać łańcuch
    if (!a) return b;
    if (!b) return a;
    // doklej b na koniec a (kopiując a)
    var items = [];
    var p = a;
    while (p) { items.push(p.n); p = p.p; }
    var res = b;
    for (var i = items.length - 1; i >= 0; i--) res = { n: items[i], p: res };
    return res;
  }

  Preprocessor.prototype.substOne = function (t, pidx, rawArgs, hs, loc, raw) {
    if (t.k === 'id' && pidx.hasOwnProperty(t.v)) {
      var a = rawArgs[pidx[t.v]] || [];
      return a.map(function (q) { return cloneTok(q, hs, loc); });
    }
    return [cloneTok(t, hs, loc)];
  };

  /* ---------- #if — ewaluacja wyrażeń stałych ---------- */
  Preprocessor.prototype.evalCond = function (toks, d0) {
    // zamień defined X / defined(X)
    var t2 = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.k === 'id' && t.v === 'defined') {
        var name = null;
        if (toks[i + 1] && toks[i + 1].k === 'id') { name = toks[i + 1].v; i += 1; }
        else if (toks[i + 1] && toks[i + 1].v === '(' && toks[i + 2] && toks[i + 2].k === 'id' &&
          toks[i + 3] && toks[i + 3].v === ')') { name = toks[i + 2].v; i += 3; }
        if (name === null) { this.error('niepoprawne defined()', t.f, t.l); return 0; }
        t2.push({ k: 'num', v: { n: this.macros.has(name) ? 1 : 0, fl: false, u: false }, f: t.f, l: t.l });
        continue;
      }
      t2.push(t);
    }
    var t3 = [];
    this.expandInto(t2, t3);
    // pozostałe identyfikatory → 0
    var vals = t3.map(function (t) {
      if (t.k === 'id') return { k: 'num', v: { n: 0, fl: false, u: false }, f: t.f, l: t.l };
      return t;
    });
    var self = this;
    var pos = 0;
    function peek() { return vals[pos] || null; }
    function isP(v) { var t = peek(); return t && t.k === 'p' && t.v === v; }
    function expect(v) {
      if (!isP(v)) { self.error('oczekiwano "' + v + '" w wyrażeniu #if', d0.f, d0.l); return; }
      pos++;
    }
    function prim() {
      var t = peek();
      if (!t) { self.error('niedokończone wyrażenie #if', d0.f, d0.l); return 0; }
      if (t.k === 'num') { pos++; return t.v.fl ? Math.trunc(t.v.n) : t.v.n; }
      if (t.k === 'ch') { pos++; return t.v; }
      if (t.k === 'p') {
        if (t.v === '(') { pos++; var v = ternary(); expect(')'); return v; }
        if (t.v === '!') { pos++; return prim() === 0 ? 1 : 0; }
        if (t.v === '-') { pos++; return (-prim()) | 0; }
        if (t.v === '+') { pos++; return prim(); }
        if (t.v === '~') { pos++; return (~prim()) | 0; }
      }
      self.error('błąd składni w #if', d0.f, d0.l);
      pos++;
      return 0;
    }
    var BIN = [
      ['||'], ['&&'], ['|'], ['^'], ['&'],
      ['==', '!='], ['<', '>', '<=', '>='],
      ['<<', '>>'], ['+', '-'], ['*', '/', '%']
    ];
    function binLevel(lv) {
      if (lv >= BIN.length) return prim();
      var ops = BIN[lv];
      var left = binLevel(lv + 1);
      for (; ;) {
        var t = peek();
        if (!t || t.k !== 'p' || ops.indexOf(t.v) < 0) return left;
        pos++;
        var right = binLevel(lv + 1);
        switch (t.v) {
          case '||': left = (left !== 0 || right !== 0) ? 1 : 0; break;
          case '&&': left = (left !== 0 && right !== 0) ? 1 : 0; break;
          case '|': left = (left | right); break;
          case '^': left = (left ^ right); break;
          case '&': left = (left & right); break;
          case '==': left = (left === right) ? 1 : 0; break;
          case '!=': left = (left !== right) ? 1 : 0; break;
          case '<': left = (left < right) ? 1 : 0; break;
          case '>': left = (left > right) ? 1 : 0; break;
          case '<=': left = (left <= right) ? 1 : 0; break;
          case '>=': left = (left >= right) ? 1 : 0; break;
          case '<<': left = (left << right); break;
          case '>>': left = (left >> right); break;
          case '+': left = (left + right) | 0; break;
          case '-': left = (left - right) | 0; break;
          case '*': left = Math.imul(left, right); break;
          case '/': left = right === 0 ? 0 : (left / right) | 0; break;
          case '%': left = right === 0 ? 0 : (left % right) | 0; break;
        }
      }
    }
    function ternary() {
      var c = binLevel(0);
      if (isP('?')) {
        pos++;
        var a = ternary();
        expect(':');
        var b = ternary();
        return c !== 0 ? a : b;
      }
      return c;
    }
    var result = ternary();
    return result;
  };

  CC.cleanSource = cleanSource;
  CC.tokenize = tokenize;

})(typeof globalThis !== 'undefined' ? globalThis : this);
