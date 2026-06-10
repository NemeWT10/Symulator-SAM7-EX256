/* ============================================================
 * Symulator SAM7-EX256 — środowisko wykonawcze
 * runtime.js — pamięć, funkcje wbudowane, CPU (silnik wykonania)
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC || (g.CC = {});

  var MEM_BASE = CC.MEM_BASE || 0x00200000;
  var MEM_SIZE = CC.MEM_SIZE || 0x00400000;
  var FN_BASE = CC.FN_BASE || 0x00010000;
  var STACK_SIZE = CC.STACK_SIZE || 0x40000;

  function RTFault(msg) {
    this.message = msg;
    this.isRTFault = true;
  }
  RTFault.prototype = Object.create(Error.prototype);
  CC.RTFault = RTFault;

  function Runtime() {
    var self = this;
    this.buf = new ArrayBuffer(MEM_SIZE);
    this.dv = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.fuel = 0;
    this.ln = 0;
    this.stepF = false;   // tryb krokowy: yield po każdej instrukcji
    this.sp = MEM_BASE + MEM_SIZE;
    this.stackLimit = MEM_BASE + MEM_SIZE - STACK_SIZE;
    this.heapPtr = 0;
    this.heapEnd = 0;
    this.mmio = null;        // {read(addr,size), write(addr,val,size)}
    this.table = null;       // tablica generatorów
    this.irqEnabled = true;
    this.onConsole = function (s) { };
    this.randSeed = 12345;

    var dv = this.dv;
    var base = MEM_BASE, size = MEM_SIZE;

    function off(a, n, wr) {
      a = a >>> 0;
      var o = a - base;
      if (o >>> 0 <= size - n) return o;
      if (a >= 0xF0000000) return -1; // MMIO
      self.badAccess(a, n, wr);
      return -2;
    }
    this.ld8 = function (a) { var o = off(a, 1, 0); if (o >= 0) return dv.getInt8(o); if (o === -1) return (self.mmio.read(a, 1) << 24) >> 24; return 0; };
    this.ldu8 = function (a) { var o = off(a, 1, 0); if (o >= 0) return dv.getUint8(o); if (o === -1) return self.mmio.read(a, 1) & 0xFF; return 0; };
    this.ld16 = function (a) { var o = off(a, 2, 0); if (o >= 0) return dv.getInt16(o, true); if (o === -1) return (self.mmio.read(a, 2) << 16) >> 16; return 0; };
    this.ldu16 = function (a) { var o = off(a, 2, 0); if (o >= 0) return dv.getUint16(o, true); if (o === -1) return self.mmio.read(a, 2) & 0xFFFF; return 0; };
    this.ld32 = function (a) { var o = off(a, 4, 0); if (o >= 0) return dv.getInt32(o, true); if (o === -1) return self.mmio.read(a, 4) | 0; return 0; };
    this.lf32 = function (a) { var o = off(a, 4, 0); if (o >= 0) return dv.getFloat32(o, true); return 0; };
    this.lf64 = function (a) { var o = off(a, 8, 0); if (o >= 0) return dv.getFloat64(o, true); return 0; };
    this.st8 = function (a, v) { var o = off(a, 1, 1); if (o >= 0) { dv.setInt8(o, v); return; } if (o === -1) self.mmio.write(a, v & 0xFF, 1); };
    this.st16 = function (a, v) { var o = off(a, 2, 1); if (o >= 0) { dv.setInt16(o, v, true); return; } if (o === -1) self.mmio.write(a, v & 0xFFFF, 2); };
    this.st32 = function (a, v) { var o = off(a, 4, 1); if (o >= 0) { dv.setInt32(o, v, true); return; } if (o === -1) self.mmio.write(a, v >>> 0, 4); };
    this.sf32 = function (a, v) { var o = off(a, 4, 1); if (o >= 0) dv.setFloat32(o, v, true); };
    this.sf64 = function (a, v) { var o = off(a, 8, 1); if (o >= 0) dv.setFloat64(o, v, true); };

    this.bi = makeBuiltins(this);
  }
  CC.Runtime = Runtime;
  var R = Runtime.prototype;

  R.badAccess = function (a, n, wr) {
    a = a >>> 0;
    var what = wr ? 'zapis pod adres' : 'odczyt spod adresu';
    if (a < 0x100) {
      this.fault(what + ' 0x' + a.toString(16).toUpperCase() +
        ' — prawdopodobnie użyto wskaźnika NULL (niezainicjalizowanego)');
    } else if (a >= FN_BASE && a < FN_BASE + 0x10000) {
      this.fault(what + ' 0x' + a.toString(16).toUpperCase() +
        ' — to adres funkcji, nie danych');
    } else {
      this.fault(what + ' 0x' + a.toString(16).toUpperCase() +
        ' — poza pamięcią RAM symulatora (błędny wskaźnik?)');
    }
  };

  R.fault = function (msg) { throw new RTFault(msg); };

  R.f2i = function (x) {
    if (!isFinite(x)) return 0;
    x = Math.trunc(x);
    return (x % 4294967296) | 0;
  };
  R.idiv = function (a, b) { if (b === 0) this.fault('dzielenie przez zero'); return (a / b) | 0; };
  R.imod = function (a, b) { if (b === 0) this.fault('reszta z dzielenia przez zero'); return (a % b) | 0; };
  R.udiv = function (a, b) {
    b = b >>> 0; if (b === 0) this.fault('dzielenie przez zero');
    return (((a >>> 0) / b) >>> 0) | 0;
  };
  R.umod = function (a, b) {
    b = b >>> 0; if (b === 0) this.fault('reszta z dzielenia przez zero');
    return (((a >>> 0) % b) >>> 0) | 0;
  };

  R.spDown = function (n) {
    this.sp -= n;
    if (this.sp < this.stackLimit) {
      this.sp += n;
      this.fault('przepełnienie stosu (za głęboka rekurencja lub za duże tablice lokalne)');
    }
    return this.sp;
  };
  R.spUp = function (n) { this.sp += n; };

  R.memTr = function (a, n, wr) {
    a = a >>> 0;
    var o = a - MEM_BASE;
    if (o >>> 0 <= MEM_SIZE - n) return o;
    this.badAccess(a, n, wr);
    return 0;
  };
  R.memcpy = function (dst, src, n) {
    n = n >>> 0;
    if (n === 0) return dst;
    var d = this.memTr(dst, n, 1), s = this.memTr(src, n, 0);
    this.u8.copyWithin(d, s, s + n);
    return dst;
  };
  R.memset = function (dst, v, n) {
    n = n >>> 0;
    if (n === 0) return dst;
    var d = this.memTr(dst, n, 1);
    this.u8.fill(v & 0xFF, d, d + n);
    return dst;
  };

  R.callPtr = function* (addr, args) {
    addr = addr >>> 0;
    if (addr >= FN_BASE && addr < FN_BASE + 0x40000 && ((addr - FN_BASE) & 3) === 0) {
      var idx = (addr - FN_BASE) >> 2;
      var fn = this.table[idx];
      if (fn) return yield* fn.apply(null, args);
    }
    if (addr === 0) this.fault('wywołanie funkcji przez wskaźnik NULL (menu_function==0? sprawdź inicjalizację)');
    this.fault('wywołanie funkcji przez błędny wskaźnik 0x' + addr.toString(16).toUpperCase());
  };

  R.cstr = function (addr, maxLen) {
    addr = addr >>> 0;
    var out = [];
    var max = maxLen || 4096;
    for (var i = 0; i < max; i++) {
      var o = addr + i - MEM_BASE;
      if (o >>> 0 >= MEM_SIZE) break;
      var b = this.u8[o];
      if (b === 0) break;
      out.push(String.fromCharCode(b));
    }
    return out.join('');
  };
  R.putBytes = function (addr, str, nulTerm) {
    for (var i = 0; i < str.length; i++) this.st8(addr + i, str.charCodeAt(i) & 0xFF);
    if (nulTerm) this.st8(addr + str.length, 0);
  };

  /* ---------- formatowanie printf ---------- */
  function formatC(rt, fmt, args) {
    var out = [];
    var ai = 0;
    function nextArg() { return ai < args.length ? args[ai++] : 0; }
    var i = 0, n = fmt.length;
    while (i < n) {
      var c = fmt[i];
      if (c !== '%') { out.push(c); i++; continue; }
      i++;
      if (fmt[i] === '%') { out.push('%'); i++; continue; }
      // flagi
      var flags = { minus: false, zero: false, plus: false, space: false, hash: false };
      for (; ;) {
        var f = fmt[i];
        if (f === '-') { flags.minus = true; i++; continue; }
        if (f === '0') { flags.zero = true; i++; continue; }
        if (f === '+') { flags.plus = true; i++; continue; }
        if (f === ' ') { flags.space = true; i++; continue; }
        if (f === '#') { flags.hash = true; i++; continue; }
        break;
      }
      var width = 0;
      if (fmt[i] === '*') { width = nextArg() | 0; i++; }
      else while (fmt[i] >= '0' && fmt[i] <= '9') { width = width * 10 + (fmt.charCodeAt(i) - 48); i++; }
      var prec = -1;
      if (fmt[i] === '.') {
        i++; prec = 0;
        if (fmt[i] === '*') { prec = nextArg() | 0; i++; }
        else while (fmt[i] >= '0' && fmt[i] <= '9') { prec = prec * 10 + (fmt.charCodeAt(i) - 48); i++; }
      }
      while ('hlLqjzt'.indexOf(fmt[i]) >= 0) i++;
      var conv = fmt[i] || ''; i++;
      var s = '';
      var numPrefix = '';
      switch (conv) {
        case 'd': case 'i': {
          var v = nextArg() | 0;
          s = Math.abs(v).toString();
          if (v < 0) numPrefix = '-';
          else if (flags.plus) numPrefix = '+';
          else if (flags.space) numPrefix = ' ';
          break;
        }
        case 'u': { s = (nextArg() >>> 0).toString(); break; }
        case 'x': { s = (nextArg() >>> 0).toString(16); if (flags.hash && s !== '0') numPrefix = '0x'; break; }
        case 'X': { s = (nextArg() >>> 0).toString(16).toUpperCase(); if (flags.hash && s !== '0') numPrefix = '0X'; break; }
        case 'o': { s = (nextArg() >>> 0).toString(8); break; }
        case 'b': { s = (nextArg() >>> 0).toString(2); break; }
        case 'c': { s = String.fromCharCode(nextArg() & 0xFF); break; }
        case 's': {
          var p = nextArg() >>> 0;
          s = p === 0 ? '(null)' : rt.cstr(p);
          if (prec >= 0) s = s.slice(0, prec);
          break;
        }
        case 'p': { s = '0x' + (nextArg() >>> 0).toString(16).toUpperCase(); break; }
        case 'f': case 'F': {
          var fv = +nextArg();
          s = Math.abs(fv).toFixed(prec < 0 ? 6 : prec);
          if (fv < 0) numPrefix = '-'; else if (flags.plus) numPrefix = '+';
          break;
        }
        case 'e': case 'E': {
          var ev = +nextArg();
          s = Math.abs(ev).toExponential(prec < 0 ? 6 : prec);
          if (conv === 'E') s = s.toUpperCase();
          if (ev < 0) numPrefix = '-'; else if (flags.plus) numPrefix = '+';
          break;
        }
        case 'g': case 'G': {
          var gv = +nextArg();
          var pg = prec < 0 ? 6 : (prec || 1);
          s = Math.abs(gv).toPrecision(pg);
          if (s.indexOf('.') >= 0 && s.indexOf('e') < 0) s = s.replace(/\.?0+$/, '');
          if (conv === 'G') s = s.toUpperCase();
          if (gv < 0) numPrefix = '-'; else if (flags.plus) numPrefix = '+';
          break;
        }
        default: s = conv; break;
      }
      // dopełnianie zerami dla liczb
      if ('diuxXobfFeEgG'.indexOf(conv) >= 0 && prec >= 0 && 'fFeEgG'.indexOf(conv) < 0) {
        while (s.length < prec) s = '0' + s;
      }
      var body = numPrefix + s;
      if (body.length < width) {
        var pad = width - body.length;
        if (flags.minus) body = body + ' '.repeat(pad);
        else if (flags.zero && 'diuxXobfFeE'.indexOf(conv) >= 0)
          body = numPrefix + '0'.repeat(pad) + s;
        else body = ' '.repeat(pad) + body;
      }
      out.push(body);
    }
    return out.join('');
  }
  CC.formatC = formatC;

  /* ---------- funkcje wbudowane ---------- */
  function makeBuiltins(rt) {
    var M = Math;
    function f(x) { return +x; }
    var bi = {
      sin: M.sin, cos: M.cos, tan: M.tan, asin: M.asin, acos: M.acos, atan: M.atan,
      atan2: M.atan2, sqrt: M.sqrt, pow: M.pow, exp: M.exp, log: M.log,
      log10: function (x) { return M.log(x) / M.LN10; },
      fabs: M.abs, floor: M.floor, ceil: M.ceil, round: M.round,
      fmod: function (a, b) { return a % b; },
      sinf: M.sin, cosf: M.cos, sqrtf: function (x) { return M.fround(M.sqrt(x)); },
      fabsf: M.abs,
      abs: function (x) { return M.abs(x | 0) | 0; },
      labs: function (x) { return M.abs(x | 0) | 0; },
      rand: function () {
        rt.randSeed = (Math.imul(rt.randSeed, 1103515245) + 12345) & 0x7FFFFFFF;
        return rt.randSeed & 0x7FFF;
      },
      srand: function (s) { rt.randSeed = s >>> 0; return 0; },
      memset: function (p, v, n) { return rt.memset(p, v, n); },
      memcpy: function (d, s, n) { return rt.memcpy(d, s, n); },
      memmove: function (d, s, n) { return rt.memcpy(d, s, n); },
      memcmp: function (a, b, n) {
        n = n >>> 0;
        for (var i = 0; i < n; i++) {
          var x = rt.ldu8(a + i), y = rt.ldu8(b + i);
          if (x !== y) return x < y ? -1 : 1;
        }
        return 0;
      },
      strlen: function (p) { return rt.cstr(p).length; },
      strcpy: function (d, s) { rt.putBytes(d, rt.cstr(s), true); return d; },
      strncpy: function (d, s, n) {
        var str = rt.cstr(s).slice(0, n);
        rt.putBytes(d, str, false);
        for (var i = str.length; i < n; i++) rt.st8(d + i, 0);
        return d;
      },
      strcat: function (d, s) {
        var cur = rt.cstr(d);
        rt.putBytes(d + cur.length, rt.cstr(s), true);
        return d;
      },
      strcmp: function (a, b) {
        var x = rt.cstr(a), y = rt.cstr(b);
        return x < y ? -1 : (x > y ? 1 : 0);
      },
      strncmp: function (a, b, n) {
        var x = rt.cstr(a).slice(0, n), y = rt.cstr(b).slice(0, n);
        return x < y ? -1 : (x > y ? 1 : 0);
      },
      strchr: function (p, c) {
        var s = rt.cstr(p);
        var i = s.indexOf(String.fromCharCode(c & 0xFF));
        return i < 0 ? 0 : (p + i) >>> 0;
      },
      strstr: function (h, nd) {
        var s = rt.cstr(h), t = rt.cstr(nd);
        var i = s.indexOf(t);
        return i < 0 ? 0 : (h + i) >>> 0;
      },
      sprintf: function (dst, fmt) {
        var args = Array.prototype.slice.call(arguments, 2);
        var s = formatC(rt, rt.cstr(fmt), args);
        rt.putBytes(dst, s, true);
        return s.length;
      },
      snprintf: function (dst, n, fmt) {
        var args = Array.prototype.slice.call(arguments, 3);
        var s = formatC(rt, rt.cstr(fmt), args);
        var w = s.slice(0, Math.max(0, n - 1));
        rt.putBytes(dst, w, true);
        return s.length;
      },
      printf: function (fmt) {
        var args = Array.prototype.slice.call(arguments, 1);
        rt.onConsole(formatC(rt, rt.cstr(fmt), args));
        return 0;
      },
      debug_printf: function (fmt) {
        var args = Array.prototype.slice.call(arguments, 1);
        rt.onConsole(formatC(rt, rt.cstr(fmt), args));
        return 0;
      },
      puts: function (p) { rt.onConsole(rt.cstr(p) + '\n'); return 0; },
      putchar: function (c) { rt.onConsole(String.fromCharCode(c & 0xFF)); return c; },
      malloc: function (n) {
        n = (n >>> 0) || 1;
        var a = (rt.heapPtr + 7) & ~7;
        if (a + n > rt.heapEnd) { rt.fault('brak pamięci na stercie (malloc)'); }
        rt.heapPtr = a + n;
        return a >>> 0;
      },
      calloc: function (c, s) {
        var n = (c >>> 0) * (s >>> 0);
        var a = bi.malloc(n);
        rt.memset(a, 0, n);
        return a;
      },
      free: function (p) { return 0; },
      atoi: function (p) { return (parseInt(rt.cstr(p), 10) || 0) | 0; },
      atol: function (p) { return (parseInt(rt.cstr(p), 10) || 0) | 0; },
      libarm_enable_irq: function () { rt.irqEnabled = true; return 0; },
      libarm_disable_irq: function () { rt.irqEnabled = false; return 0; },
      libarm_enable_fiq: function () { return 0; },
      libarm_disable_fiq: function () { return 0; }
    };
    return bi;
  }

  /* ============================================================
   * CPU — silnik wykonania skompilowanego programu
   * ============================================================ */
  function Cpu(rt, compiled) {
    this.rt = rt;
    this.compiled = compiled;     // {source, image, heapBase, fileNames, mainIdx}
    this.module = null;
    this.mainGen = null;
    this.irqGen = null;
    this.irqId = -1;
    this.granted = 0;
    this.status = 'idle';         // idle | running | done | fault
    this.faultMsg = null;
    this.exitCode = 0;
    this.aic = null;              // ustawiane przez board
    this.onFault = function (msg, file, line) { };
    this.onExit = function (code) { };
    this.irqStorm = 0;
  }
  CC.Cpu = Cpu;
  var Q = Cpu.prototype;

  Q.reset = function () {
    var rt = this.rt;
    rt.u8.fill(0);
    var img = this.compiled.image;
    for (var i = 0; i < img.length; i++) {
      var ch = img[i];
      var off = (ch.addr - MEM_BASE) >>> 0;
      rt.u8.set(ch.bytes, off);
    }
    rt.sp = MEM_BASE + MEM_SIZE;
    rt.heapPtr = this.compiled.heapBase;
    rt.heapEnd = Math.min(this.compiled.heapBase + 0x100000, rt.stackLimit);
    rt.fuel = 0;
    rt.ln = 0;
    rt.stepF = false;
    rt.irqEnabled = true;
    this.granted = 0;
    this.irqGen = null;
    this.irqId = -1;
    this.faultMsg = null;
    this.irqStorm = 0;

    if (!this.module) {
      var factory = new Function('RT', this.compiled.source);
      this.module = factory(rt);
    }
    rt.table = this.module.table;
    var mainFn = this.module.table[this.compiled.mainIdx];
    this.mainGen = mainFn();
    this.status = 'running';
  };

  Q.lnInfo = function () {
    var ln = this.rt.ln;
    var fi = (ln / 0x400000) | 0;
    var line = ln & 0x3FFFFF;
    var file = this.compiled.fileNames[fi] || '?';
    return { file: file, line: line };
  };

  Q.vcycles = function () {
    return this.granted - Math.min(this.rt.fuel, 0);
  };

  // jeden kwant: dolicz chunk cykli, wykonuj ile się da
  Q.slice = function (chunk) {
    var rt = this.rt;
    this.granted += chunk;
    rt.fuel += chunk;
    if (rt.fuel > chunk * 2) rt.fuel = chunk * 2; // nie kumuluj nadmiaru
    if (this.status !== 'running') { rt.fuel = 0; return; }
    if (rt.fuel <= 0) return; // spłacanie "długu" po fast-forward opóźnień

    // dyspozycja przerwań
    if (!this.irqGen && rt.irqEnabled && this.aic) {
      var irq = this.aic.acquire(); // {id, vector} | null
      if (irq) {
        if (irq.vector === 0) {
          this.doFault('przerwanie #' + irq.id + ' bez ustawionego wektora (AIC_SVR' + irq.id + '==0)');
          return;
        }
        var addr = irq.vector >>> 0;
        var idx = (addr - FN_BASE) >> 2;
        var fn = (addr >= FN_BASE && ((addr - FN_BASE) & 3) === 0) ? rt.table[idx] : null;
        if (!fn) {
          this.doFault('wektor przerwania #' + irq.id + ' (0x' + addr.toString(16) +
            ') nie wskazuje na funkcję');
          return;
        }
        this.irqGen = fn();
        this.irqId = irq.id;
        this.irqStorm++;
        if (this.irqStorm > 20000) {
          this.doFault('lawina przerwań — handler nie kasuje flagi źródła (np. brak odczytu PIT_PIVR / TC0_SR)');
          return;
        }
      } else {
        this.irqStorm = 0;
      }
    }

    var gen = this.irqGen || this.mainGen;
    var r;
    try {
      r = gen.next();
    } catch (e) {
      if (e && e.isRTFault) { this.doFault(e.message); return; }
      if (e instanceof RangeError) {
        this.doFault('przepełnienie stosu (nieskończona rekurencja?)');
        return;
      }
      this.doFault('wewnętrzny błąd wykonania: ' + (e && e.message ? e.message : e));
      if (g.console && console.error) console.error(e);
      return;
    }
    if (r.done) {
      if (this.irqGen === gen) {
        this.irqGen = null;
        if (this.aic) this.aic.eoi();
      } else {
        this.status = 'done';
        this.exitCode = r.value | 0;
        rt.fuel = 0;
        this.onExit(this.exitCode);
      }
    }
  };

  Q.doFault = function (msg) {
    this.status = 'fault';
    this.faultMsg = msg;
    this.rt.fuel = 0;
    var li = this.lnInfo();
    this.onFault(msg, li.file, li.line);
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
