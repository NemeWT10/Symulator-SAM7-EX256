/* ============================================================
 * Symulator SAM7-EX256 — konwerter grafiki na tablicę C (.h)
 * bmpconv.js — wczytanie JPG/PNG, kadrowanie, skalowanie,
 * korekcja barw, kwantyzacja do 12 bpp (opcjonalnie 16 bpp)
 * i wygenerowanie nagłówka dla LCDDrawBmp12().
 *
 * Kolejność składowych: sterownik z laboratorium ustawia
 * MADCTL (0x36) = 0x08, czyli bit BGR — panel czyta pierwszą
 * półbajtówkę jako NIEBIESKI, ostatnią jako CZERWONY. Stąd
 * stałe RED 0x00F / BLUE 0xF00 w PCF8833U8_lcd.h i domyślny
 * układ B-G-R w tym konwerterze.
 * ============================================================ */
(function (g) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LS_PENDING = 'sam7sim_pending_files_v1';
  var LS_CFG = 'sam7sim_bmpconv_cfg_v1';
  var MAXW = 132, MAXH = 132;      // wielkość ekranu GE12
  var SRAM = 64 * 1024;            // AT91SAM7X256 — konfiguracja „ARM RAM Release”

  /* ---------------- stan ---------------- */
  var items = [];        // {id, file, img, name, arr, cfg, crop}
  var cur = -1;
  var nextId = 1;
  var lastCfg = null;
  var raf = 0;

  /* ============================================================
   * ustawienia
   * ============================================================ */
  function defaultCfg() {
    return {
      w: 132, h: 132, preset: '132x132',
      fit: 'cover', smooth: 'smooth', lockAsp: true,
      rot: 0, flipH: false, flipV: false,
      bri: 0, con: 0, sat: 100, gam: 100,
      neg: false, gray: false, dither: 'none', bg: '#000000',
      fmt: 'p12', order: 'bgr', panel: 'bgr',
      perLine: 24, hexCase: 'low',
      guard: true, defs: true, usage: true,
      x0: 0, y0: 0
    };
  }
  function loadCfg() {
    try {
      var raw = localStorage.getItem(LS_CFG);
      if (raw) {
        var c = JSON.parse(raw), d = defaultCfg();
        Object.keys(d).forEach(function (k) { if (c[k] !== undefined) d[k] = c[k]; });
        return d;
      }
    } catch (e) { }
    return defaultCfg();
  }
  /* miedzy sesjami pamietamy tylko ustawienia „techniczne”; jasnosc,
   * kontrast itp. dotycza konkretnego zdjecia, wiec nie wracaja po
   * ponownym otwarciu strony (w obrebie sesji dziedziczy je lastCfg) */
  var VOLATILE = ['bri', 'con', 'sat', 'gam', 'neg', 'gray', 'x0', 'y0'];
  function storeCfg(c) {
    try {
      var d = JSON.parse(JSON.stringify(c)), z = defaultCfg();
      VOLATILE.forEach(function (k) { d[k] = z[k]; });
      localStorage.setItem(LS_CFG, JSON.stringify(d));
    } catch (e) { }
  }

  /* ============================================================
   * narzędzia
   * ============================================================ */
  var PL = { 'ą': 'a', 'ć': 'c', 'ę': 'e', 'ł': 'l', 'ń': 'n', 'ó': 'o', 'ś': 's', 'ź': 'z', 'ż': 'z' };
  function cIdent(s) {
    s = (s || 'bmp').replace(/\.[^.]+$/, '').toLowerCase();
    s = s.replace(/[ąćęłńóśźż]/g, function (c) { return PL[c] || c; });
    s = s.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!s) s = 'bmp';
    if (/^[0-9]/.test(s)) s = 'img_' + s;
    return s;
  }
  function uniqName(base) {
    var n = base, k = 2;
    while (items.some(function (it) { return it.cfg && it.name === n; })) n = base + '_' + (k++);
    return n;
  }
  function grp(n) {                       // 26136 → „26 136” (zwykla spacja)
    return String(n).replace(/(?=(?:...)+$)(?!^)/g, ' ');
  }
  function fmtBytes(n) {
    return grp(n) + ' B' + (n >= 1024 ? ' (' + (n / 1024).toFixed(1) + ' KB)' : '');
  }
  function hex2(v, up) {
    var s = v.toString(16).padStart(2, '0');
    return '0x' + (up ? s.toUpperCase() : s);
  }
  function hex4(v, up) {
    var s = v.toString(16).padStart(4, '0');
    return '0x' + (up ? s.toUpperCase() : s);
  }
  var toastT = 0;
  function toast(msg, bad) {
    var el = $('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
    el.textContent = msg;
    el.className = 'show' + (bad ? ' err' : '');
    clearTimeout(toastT);
    toastT = setTimeout(function () { el.className = bad ? 'err' : ''; }, 2600);
  }
  function download(name, blobOrText, mime) {
    var blob = (blobOrText instanceof Blob) ? blobOrText
      : new Blob([blobOrText], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  /* ============================================================
   * potok graficzny
   * ============================================================ */

  /* zmniejszanie przez połowienie — pojedyncze drawImage przy dużej
   * redukcji gubi detale (przeglądarka próbkuje, nie uśrednia) */
  function resizeTo(src, tw, th, smooth) {
    tw = Math.max(1, Math.round(tw));
    th = Math.max(1, Math.round(th));
    if (!smooth) {
      var cv0 = document.createElement('canvas');
      cv0.width = tw; cv0.height = th;
      var c0 = cv0.getContext('2d');
      c0.imageSmoothingEnabled = false;
      c0.drawImage(src, 0, 0, tw, th);
      return cv0;
    }
    var curCv = src, cw = src.width, ch = src.height;
    while (cw > tw * 2 && ch > th * 2) {
      var nw = Math.max(tw, cw >> 1), nh = Math.max(th, ch >> 1);
      var tmp = document.createElement('canvas');
      tmp.width = nw; tmp.height = nh;
      var tc = tmp.getContext('2d');
      tc.imageSmoothingEnabled = true;
      tc.imageSmoothingQuality = 'high';
      tc.drawImage(curCv, 0, 0, nw, nh);
      curCv = tmp; cw = nw; ch = nh;
    }
    var cv = document.createElement('canvas');
    cv.width = tw; cv.height = th;
    var c = cv.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(curCv, 0, 0, tw, th);
    return cv;
  }

  /* kadr + obrót + odbicia, w rozdzielczości naturalnej */
  function cropAndOrient(it) {
    var cr = it.crop, cfg = it.cfg;
    var cw = Math.max(1, Math.round(cr.w)), ch = Math.max(1, Math.round(cr.h));
    var a = document.createElement('canvas');
    a.width = cw; a.height = ch;
    var ac = a.getContext('2d');
    ac.imageSmoothingEnabled = true;
    ac.drawImage(it.img, Math.round(cr.x), Math.round(cr.y), cw, ch, 0, 0, cw, ch);

    if (!cfg.rot && !cfg.flipH && !cfg.flipV) return a;

    var swap = (cfg.rot === 90 || cfg.rot === 270);
    var b = document.createElement('canvas');
    b.width = swap ? ch : cw;
    b.height = swap ? cw : ch;
    var bc = b.getContext('2d');
    bc.save();
    bc.translate(b.width / 2, b.height / 2);
    bc.rotate(cfg.rot * Math.PI / 180);
    bc.scale(cfg.flipH ? -1 : 1, cfg.flipV ? -1 : 1);
    bc.drawImage(a, -cw / 2, -ch / 2);
    bc.restore();
    return b;
  }

  /* kadr → docelowe W×H wg trybu dopasowania */
  function fitToTarget(src, cfg) {
    var W = cfg.w, H = cfg.h, sw = src.width, sh = src.height;
    var dw, dh, dx, dy;
    if (cfg.fit === 'stretch') {
      dw = W; dh = H; dx = 0; dy = 0;
    } else {
      var s = (cfg.fit === 'contain') ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
      dw = Math.max(1, Math.round(sw * s));
      dh = Math.max(1, Math.round(sh * s));
      dx = Math.round((W - dw) / 2);
      dy = Math.round((H - dh) / 2);
    }
    var scaled = resizeTo(src, dw, dh, cfg.smooth === 'smooth');
    var out = document.createElement('canvas');
    out.width = W; out.height = H;
    var oc = out.getContext('2d');
    oc.fillStyle = cfg.bg;                 // tło pod przezroczystością i przy „contain”
    oc.fillRect(0, 0, W, H);
    oc.imageSmoothingEnabled = false;
    oc.drawImage(scaled, dx, dy);
    return out;
  }

  /* korekcja jasność / kontrast / nasycenie / gamma / negatyw / szarość */
  function adjust(d, cfg) {
    var bri = cfg.bri * 2.55;
    var k = (cfg.con === 0) ? 1 : (259 * (cfg.con + 255)) / (255 * (259 - cfg.con));
    var sat = cfg.sat / 100;
    var gam = cfg.gam / 100;
    var lut = null;
    if (Math.abs(gam - 1) > 0.001) {
      lut = new Uint8Array(256);
      for (var i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, Math.round(255 * Math.pow(i / 255, 1 / gam))));
    }
    for (var p = 0; p < d.length; p += 4) {
      var r = d[p], gg = d[p + 1], b = d[p + 2];
      if (lut) { r = lut[r]; gg = lut[gg]; b = lut[b]; }
      if (bri) { r += bri; gg += bri; b += bri; }
      if (k !== 1) { r = k * (r - 128) + 128; gg = k * (gg - 128) + 128; b = k * (b - 128) + 128; }
      if (cfg.gray || sat !== 1) {
        var lum = 0.299 * r + 0.587 * gg + 0.114 * b;
        var s = cfg.gray ? 0 : sat;
        r = lum + (r - lum) * s; gg = lum + (gg - lum) * s; b = lum + (b - lum) * s;
      }
      if (cfg.neg) { r = 255 - r; gg = 255 - gg; b = 255 - b; }
      d[p] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[p + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg;
      d[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }

  var BAYER8 = (function () {
    var m = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
    var f = new Float32Array(64);
    for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) f[y * 8 + x] = (m[y][x] + 0.5) / 64 - 0.5;
    return f;
  })();

  /* kwantyzacja do zadanej liczby poziomów na składową */
  function quantize(d, W, H, cfg, lv) {
    var n = W * H;
    var q = new Uint8Array(n * 3);
    var stepR = 255 / (lv[0] - 1), stepG = 255 / (lv[1] - 1), stepB = 255 / (lv[2] - 1);
    var st = [stepR, stepG, stepB];
    var i, c, idx;

    if (cfg.dither === 'fs') {
      var buf = new Float32Array(n * 3);
      for (i = 0; i < n; i++) { buf[i * 3] = d[i * 4]; buf[i * 3 + 1] = d[i * 4 + 1]; buf[i * 3 + 2] = d[i * 4 + 2]; }
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          idx = (y * W + x) * 3;
          for (c = 0; c < 3; c++) {
            var v = buf[idx + c];
            var qi = Math.round(v / st[c]);
            if (qi < 0) qi = 0; else if (qi > lv[c] - 1) qi = lv[c] - 1;
            q[idx + c] = qi;
            var err = v - qi * st[c];
            if (x + 1 < W) buf[idx + 3 + c] += err * 7 / 16;
            if (y + 1 < H) {
              var dn = idx + W * 3 + c;
              if (x > 0) buf[dn - 3] += err * 3 / 16;
              buf[dn] += err * 5 / 16;
              if (x + 1 < W) buf[dn + 3] += err * 1 / 16;
            }
          }
        }
      }
      return q;
    }

    var bay = (cfg.dither === 'bayer');
    for (i = 0; i < n; i++) {
      var t = bay ? BAYER8[((i / W | 0) % 8) * 8 + (i % W) % 8] : 0;
      for (c = 0; c < 3; c++) {
        var val = d[i * 4 + c] + (bay ? t * st[c] : 0);
        var qq = Math.round(val / st[c]);
        if (qq < 0) qq = 0; else if (qq > lv[c] - 1) qq = lv[c] - 1;
        q[i * 3 + c] = qq;
      }
    }
    return q;
  }

  function levelsFor(fmt) { return (fmt === 'p16') ? [32, 64, 32] : [16, 16, 16]; }

  /* q (0..lv-1 na składową) → słowa w kolejności zapisu tablicy */
  function encodeWords(q, n, fmt, order) {
    var w = new Uint16Array(n), i;
    if (fmt === 'p16') {
      for (i = 0; i < n; i++) {
        var r5 = q[i * 3], g6 = q[i * 3 + 1], b5 = q[i * 3 + 2];
        w[i] = (order === 'bgr') ? ((b5 << 11) | (g6 << 5) | r5) : ((r5 << 11) | (g6 << 5) | b5);
      }
    } else {
      for (i = 0; i < n; i++) {
        var r = q[i * 3], gg = q[i * 3 + 1], b = q[i * 3 + 2];
        w[i] = (order === 'bgr') ? ((b << 8) | (gg << 4) | r) : ((r << 8) | (gg << 4) | b);
      }
    }
    return w;
  }

  /* słowa → RGBA tak, jak odczyta je panel przy danym ustawieniu MADCTL */
  function decodeToRgba(words, n, fmt, panel) {
    var out = new Uint8ClampedArray(n * 4), i;
    for (i = 0; i < n; i++) {
      var v = words[i], R, G, B;
      if (fmt === 'p16') {
        var f2 = (v >> 11) & 31, f1 = (v >> 5) & 63, f0 = v & 31;
        var c2 = Math.round(f2 * 255 / 31), c1 = Math.round(f1 * 255 / 63), c0 = Math.round(f0 * 255 / 31);
        if (panel === 'bgr') { B = c2; G = c1; R = c0; } else { R = c2; G = c1; B = c0; }
      } else {
        var n2 = (v >> 8) & 15, n1 = (v >> 4) & 15, n0 = v & 15;
        if (panel === 'bgr') { B = n2 * 17; G = n1 * 17; R = n0 * 17; }
        else { R = n2 * 17; G = n1 * 17; B = n0 * 17; }
      }
      out[i * 4] = R; out[i * 4 + 1] = G; out[i * 4 + 2] = B; out[i * 4 + 3] = 255;
    }
    return out;
  }

  /* słowa → bajty tablicy */
  function packBytes(words, n, fmt) {
    var i, out;
    if (fmt === 'w12') return null;                 // tablica słów — bez pakowania
    if (fmt === 'p16') {
      out = new Uint8Array(n * 2);
      for (i = 0; i < n; i++) { out[i * 2] = (words[i] >> 8) & 255; out[i * 2 + 1] = words[i] & 255; }
      return out;
    }
    // 12 bpp: P0[11:4] | P0[3:0]<<4 | P1[11:8] | P1[7:0]
    out = new Uint8Array(Math.ceil(n * 3 / 2));
    var o = 0;
    for (i = 0; i < n; i += 2) {
      var p0 = words[i] & 0xFFF;
      var p1 = (i + 1 < n) ? (words[i + 1] & 0xFFF) : 0;
      out[o++] = (p0 >> 4) & 0xFF;
      out[o++] = ((p0 & 0xF) << 4) | ((p1 >> 8) & 0xF);
      if (i + 1 < n) out[o++] = p1 & 0xFF;          // nieparzysta liczba pikseli → ostatni na 2 bajtach
    }
    return out.subarray(0, o);
  }

  /* pełne przeliczenie jednej grafiki */
  function build(it) {
    var cfg = it.cfg;
    var oriented = cropAndOrient(it);
    var target = fitToTarget(oriented, cfg);
    var tc = target.getContext('2d', { willReadFrequently: true });
    var img = tc.getImageData(0, 0, cfg.w, cfg.h);
    adjust(img.data, cfg);
    var lv = levelsFor(cfg.fmt);
    var n = cfg.w * cfg.h;
    var q = quantize(img.data, cfg.w, cfg.h, cfg, lv);
    var words = encodeWords(q, n, cfg.fmt, cfg.order);
    var rgba = decodeToRgba(words, n, cfg.fmt, cfg.panel);
    var bytes = packBytes(words, n, cfg.fmt);
    it.out = {
      words: words, rgba: rgba, bytes: bytes,
      size: bytes ? bytes.length : n * 2,
      w: cfg.w, h: cfg.h
    };
    return it.out;
  }

  /* ============================================================
   * generowanie kodu
   * ============================================================ */
  function fmtDesc(fmt) {
    if (fmt === 'p16') return '16 bpp RGB565, 2 bajty na piksel';
    if (fmt === 'w12') return '12 bpp, jedno slowo (unsigned short) na piksel';
    return '12 bpp pakowane, 3 bajty na 2 piksele';
  }
  function orderDesc(order, fmt) {
    var f = (fmt === 'p16') ? '5-6-5' : '4-4-4';
    return (order === 'bgr')
      ? 'B-G-R (' + f + ') - zgodne z MADCTL = 0x08 ze sterownika laboratoryjnego'
      : 'R-G-B (' + f + ') - dla MADCTL bez bitu BGR';
  }

  /* limit > 0 → tylko podglad: kilkadziesiat pierwszych i ostatnich wierszy.
   * Pelna tablica (kilkanascie tysiecy liczb) powstaje dopiero przy pobieraniu
   * pliku — inaczej kazdy ruch suwaka trwalby okolo sekundy. */
  function genArray(it, limit) {
    var cfg = it.cfg, o = it.out;
    var up = (cfg.hexCase === 'up');
    var per = Math.max(4, Math.min(64, cfg.perLine | 0));
    var words = (cfg.fmt === 'w12');
    var src = words ? o.words : o.bytes;
    var hx = words ? hex4 : hex2;
    var n = src.length, rows = Math.ceil(n / per);
    var head = 0, tail = 0;
    if (limit && rows > limit) { head = Math.max(1, limit - 12); tail = 10; }

    function row(r) {
      var i = r * per, e = Math.min(i + per, n), line = [];
      for (var k = i; k < e; k++) line.push(hx(src[k], up));
      return '  ' + line.join(', ') + (e < n ? ',' : '') + '\n';
    }
    var s = 'const unsigned ' + (words ? 'short ' : 'char ') + it.name + '[] = {\n', r;
    if (head) {
      for (r = 0; r < head; r++) s += row(r);
      s += '\n  /* ... pominieto ' + grp(rows - head - tail) +
        ' wierszy podgladu - pobrany plik zawiera calosc ... */\n\n';
      for (r = rows - tail; r < rows; r++) s += row(r);
    } else {
      for (r = 0; r < rows; r++) s += row(r);
    }
    return s + '};\n';
  }

  function genHeader(list, fileName, limit) {
    var head = list[0].cfg;
    var GU = cIdent(fileName).toUpperCase() + '_H_INCLUDED';
    // tresc naglowka trzymamy w ASCII — plik trafia zwykle do CrossWorks,
    // gdzie reszta zrodel laboratorium jest w CP1250
    var mixed = list.some(function (it) { return it.cfg.order !== head.order; });
    var s = '/* ' + fileName + ' - wygenerowane konwerterem symulatora SAM7-EX256\n';
    list.forEach(function (it) {
      s += ' *   ' + it.name + ': ' + it.cfg.w + 'x' + it.cfg.h + ' px, ' +
        fmtDesc(it.cfg.fmt) + ', ' + fmtBytes(it.out.size) +
        (mixed ? ', ' + (it.cfg.order === 'bgr' ? 'B-G-R' : 'R-G-B') : '') +
        (it.srcName ? '   (z pliku ' + it.srcName + ')' : '') + '\n';
    });
    s += ' *\n';
    s += mixed
      ? ' * Kolejnosc skladowych podana przy kazdej tablicy.\n'
      : ' * Kolejnosc skladowych: ' + orderDesc(head.order, head.fmt) + '\n';
    if (list.some(function (it) { return it.cfg.fmt === 'p16'; })) {
      s += ' * UWAGA: 16 bpp wymaga COLMOD (0x3A) = 0x05; LCDSettings() z laboratorium\n' +
        ' *        ustawia 0x03 (12 bpp) - zmien to, zanim uzyjesz tej tablicy.\n';
    }
    s += ' */\n';
    if (head.guard) s += '#ifndef ' + GU + '\n#define ' + GU + '\n\n';

    list.forEach(function (it, idx) {
      var N = it.name.toUpperCase();
      if (idx) s += '\n';
      if (it.cfg.defs) {
        s += '#define ' + N + '_W ' + it.cfg.w + '\n';
        s += '#define ' + N + '_H ' + it.cfg.h + '\n\n';
      }
      if (it.cfg.usage) {
        s += '/* jak uzyc:\n *   #include "' + fileName + '"\n';
        if (it.cfg.fmt === 'w12') {
          s += ' *   int x, y;\n' +
            ' *   for (x = 0; x < ' + it.cfg.h + '; x++)\n' +
            ' *     for (y = 0; y < ' + it.cfg.w + '; y++)\n' +
            ' *       LCDSetPixel(' + it.cfg.x0 + ' + x, ' + it.cfg.y0 + ' + y, ' +
            it.name + '[x * ' + it.cfg.w + ' + y]);\n';
        } else {
          s += ' *   LCDDrawBmp12(' + it.name + ', ' +
            (it.cfg.defs ? N + '_W, ' + N + '_H' : it.cfg.w + ', ' + it.cfg.h) +
            ', ' + it.cfg.x0 + ', ' + it.cfg.y0 + ');\n' +
            ' *   // x0 = ' + it.cfg.x0 + ' -> wiersz (PASET, od gory), y0 = ' +
            it.cfg.y0 + ' -> kolumna (CASET, od lewej)\n';
        }
        s += ' */\n';
      }
      s += genArray(it, limit);
    });

    if (head.guard) s += '\n#endif /* ' + GU + ' */\n';
    return s;
  }

  /* ============================================================
   * lista grafik
   * ============================================================ */
  /* Dekodowanie przez createImageBitmap, a nie <img src="blob:…"> — bitmapa
   * jest „czysta”, wiec getImageData dziala takze przy otwarciu strony
   * z dysku (file://), gdzie obrazek z URL-a potrafi skazic canvas.
   * Starsze przegladarki: awaryjnie zwykly Image. */
  function loadImage(file, ok, fail) {
    function viaUrl() {
      var url = URL.createObjectURL(file);
      var im = new Image();
      im.onload = function () { ok(im, im.naturalWidth, im.naturalHeight, url); };
      im.onerror = function () { URL.revokeObjectURL(url); fail(); };
      im.src = url;
    }
    if (typeof createImageBitmap === 'function') {
      createImageBitmap(file).then(
        function (bm) { ok(bm, bm.width, bm.height, null); }, viaUrl);
    } else viaUrl();
  }

  function addFiles(files) {
    var list = Array.from(files || []).filter(function (f) {
      return /^image\//.test(f.type) || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name);
    });
    if (!list.length) { toast('To nie jest plik graficzny.', true); return; }
    var pending = list.length;
    function done() { if (--pending === 0) { cur = items.length - 1; syncAll(); } }
    list.forEach(function (f) {
      loadImage(f, function (img, w, h, url) {
        var it = {
          id: nextId++, img: img, url: url, srcName: f.name,
          srcW: w, srcH: h, name: '', cfg: lastCfg ? JSON.parse(JSON.stringify(lastCfg)) : loadCfg(),
          crop: null
        };
        it.name = uniqName(cIdent(f.name));
        it.cfg.x0 = 0; it.cfg.y0 = 0;
        it.file = it.name + '.h';
        resetCrop(it, true);
        items.push(it);
        done();
      }, function () {
        toast('Nie udało się wczytać pliku ' + f.name, true);
        done();
      });
    });
  }

  function delItem(i) {
    var it = items[i];
    if (it.url) URL.revokeObjectURL(it.url);
    if (it.img && typeof it.img.close === 'function') it.img.close();
    items.splice(i, 1);
    if (cur >= items.length) cur = items.length - 1;
    syncAll();
  }

  function curItem() { return (cur >= 0 && cur < items.length) ? items[cur] : null; }

  function renderList() {
    var ul = $('imgList');
    ul.innerHTML = '';
    items.forEach(function (it, i) {
      var li = document.createElement('li');
      if (i === cur) li.classList.add('active');
      var cv = document.createElement('canvas');
      cv.className = 'thumb';
      cv.width = it.cfg.w; cv.height = it.cfg.h;
      if (it.out) {
        var id = new ImageData(new Uint8ClampedArray(it.out.rgba), it.cfg.w, it.cfg.h);
        cv.getContext('2d').putImageData(id, 0, 0);
      }
      var txt = document.createElement('div');
      txt.className = 'im-txt';
      var nm = document.createElement('div');
      nm.className = 'im-name'; nm.textContent = it.name;
      var sub = document.createElement('div');
      sub.className = 'im-sub';
      sub.textContent = it.cfg.w + '×' + it.cfg.h + (it.out ? ' · ' + (it.out.size / 1024).toFixed(1) + ' KB' : '');
      txt.appendChild(nm); txt.appendChild(sub);
      var del = document.createElement('span');
      del.className = 'im-del'; del.textContent = '🗑'; del.title = 'Usuń z listy';
      li.appendChild(cv); li.appendChild(txt); li.appendChild(del);
      li.addEventListener('click', function (e) {
        if (e.target === del) { delItem(i); return; }
        cur = i; syncAll();
      });
      ul.appendChild(li);
    });
    var total = items.reduce(function (a, it) { return a + (it.out ? it.out.size : 0); }, 0);
    $('imgInfo').textContent = items.length
      ? items.length + ' grafik(i) · razem ' + fmtBytes(total)
      : 'brak grafik';
  }

  /* ============================================================
   * kadrowanie — interaktywny prostokąt na źródle
   * ============================================================ */
  var view = { scale: 1, ox: 0, oy: 0 };   // obraz → canvas
  var drag = null;

  function resetCrop(it, toAspect) {
    var W = it.srcW, H = it.srcH;
    if (toAspect && it.cfg.lockAsp) {
      var ar = it.cfg.w / it.cfg.h;
      var w = W, h = W / ar;
      if (h > H) { h = H; w = H * ar; }
      it.crop = { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h };
    } else {
      it.crop = { x: 0, y: 0, w: W, h: H };
    }
  }
  function cropSquare(it) {
    var s = Math.min(it.srcW, it.srcH);
    it.crop = { x: (it.srcW - s) / 2, y: (it.srcH - s) / 2, w: s, h: s };
  }

  function layoutSrc() {
    var it = curItem();
    if (!it) return;
    var wrap = $('srcWrap'), cv = $('srcCv');
    var availW = Math.max(120, wrap.clientWidth - 18);
    var availH = Math.max(120, wrap.clientHeight - 18);
    var s = Math.min(availW / it.srcW, availH / it.srcH, 4);
    view.scale = s;
    cv.width = Math.max(1, Math.round(it.srcW * s));
    cv.height = Math.max(1, Math.round(it.srcH * s));
  }

  function drawSrc() {
    var it = curItem();
    if (!it) return;
    var cv = $('srcCv'), c = cv.getContext('2d');
    var s = view.scale;
    c.clearRect(0, 0, cv.width, cv.height);
    c.imageSmoothingEnabled = true;
    c.drawImage(it.img, 0, 0, cv.width, cv.height);

    var r = it.crop;
    var rx = r.x * s, ry = r.y * s, rw = r.w * s, rh = r.h * s;
    // przyciemnienie poza kadrem
    c.fillStyle = 'rgba(10,11,14,.62)';
    c.fillRect(0, 0, cv.width, ry);
    c.fillRect(0, ry + rh, cv.width, cv.height - ry - rh);
    c.fillRect(0, ry, rx, rh);
    c.fillRect(rx + rw, ry, cv.width - rx - rw, rh);
    // ramka + trójpodział
    c.strokeStyle = '#4ea1ff'; c.lineWidth = 1;
    c.strokeRect(rx + .5, ry + .5, rw - 1, rh - 1);
    c.strokeStyle = 'rgba(78,161,255,.35)';
    c.beginPath();
    for (var i = 1; i < 3; i++) {
      c.moveTo(rx + rw * i / 3, ry); c.lineTo(rx + rw * i / 3, ry + rh);
      c.moveTo(rx, ry + rh * i / 3); c.lineTo(rx + rw, ry + rh * i / 3);
    }
    c.stroke();
    // uchwyty
    c.fillStyle = '#4ea1ff';
    handlePts(rx, ry, rw, rh).forEach(function (p) { c.fillRect(p[0] - 4, p[1] - 4, 8, 8); });

    $('srcInfo').textContent = it.srcName + ' — ' + it.srcW + '×' + it.srcH +
      ' px  →  kadr ' + Math.round(r.w) + '×' + Math.round(r.h) +
      ' (' + (r.w / r.h).toFixed(2) + ':1)  →  wynik ' + it.cfg.w + '×' + it.cfg.h;
  }

  function handlePts(x, y, w, h) {
    return [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2],
    [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]];
  }

  function hitHandle(mx, my, it) {
    var s = view.scale, r = it.crop;
    var pts = handlePts(r.x * s, r.y * s, r.w * s, r.h * s);
    for (var i = 0; i < pts.length; i++) {
      if (Math.abs(mx - pts[i][0]) <= 7 && Math.abs(my - pts[i][1]) <= 7) return i;
    }
    if (mx >= r.x * s && mx <= (r.x + r.w) * s && my >= r.y * s && my <= (r.y + r.h) * s) return -1; // środek
    return -2;
  }

  function applyAspect(r, it, anchorX, anchorY) {
    if (!it.cfg.lockAsp) return r;
    var ar = it.cfg.w / it.cfg.h;
    var w = r.w, h = r.h;
    if (w / h > ar) w = h * ar; else h = w / ar;
    // zakotwiczenie przy krawędzi, której nie ruszamy
    if (anchorX === 'right') r.x = r.x + r.w - w;
    if (anchorY === 'bottom') r.y = r.y + r.h - h;
    if (anchorX === 'center') r.x = r.x + (r.w - w) / 2;
    if (anchorY === 'center') r.y = r.y + (r.h - h) / 2;
    r.w = w; r.h = h;
    return r;
  }

  function clampCrop(it) {
    var r = it.crop;
    r.w = Math.max(2, Math.min(r.w, it.srcW));
    r.h = Math.max(2, Math.min(r.h, it.srcH));
    r.x = Math.max(0, Math.min(r.x, it.srcW - r.w));
    r.y = Math.max(0, Math.min(r.y, it.srcH - r.h));
  }

  function bindCrop() {
    var cv = $('srcCv');
    function pos(e) {
      var b = cv.getBoundingClientRect();
      return [e.clientX - b.left, e.clientY - b.top];
    }
    cv.addEventListener('mousedown', function (e) {
      var it = curItem(); if (!it) return;
      var p = pos(e), hi = hitHandle(p[0], p[1], it);
      if (hi === -2) {                      // rysowanie nowego kadru od zera
        var ix = p[0] / view.scale, iy = p[1] / view.scale;
        it.crop = { x: ix, y: iy, w: 2, h: 2 };
        drag = { mode: 'new', ox: ix, oy: iy };
      } else if (hi === -1) {
        drag = { mode: 'move', mx: p[0], my: p[1], sx: it.crop.x, sy: it.crop.y };
      } else {
        drag = { mode: 'size', h: hi, start: Object.assign({}, it.crop) };
      }
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var it = curItem(); if (!it) return;
      var p = pos(e), s = view.scale, r = it.crop;
      if (drag.mode === 'move') {
        r.x = drag.sx + (p[0] - drag.mx) / s;
        r.y = drag.sy + (p[1] - drag.my) / s;
      } else if (drag.mode === 'new') {
        var ix = Math.max(0, Math.min(it.srcW, p[0] / s));
        var iy = Math.max(0, Math.min(it.srcH, p[1] / s));
        r.x = Math.min(drag.ox, ix); r.y = Math.min(drag.oy, iy);
        r.w = Math.max(2, Math.abs(ix - drag.ox)); r.h = Math.max(2, Math.abs(iy - drag.oy));
        applyAspect(r, it, ix < drag.ox ? 'right' : 'left', iy < drag.oy ? 'bottom' : 'top');
      } else {
        var st = drag.start, hi = drag.h;
        var mx = p[0] / s, my = p[1] / s;
        var L = st.x, T = st.y, R = st.x + st.w, B = st.y + st.h;
        if (hi === 0 || hi === 6 || hi === 7) L = Math.min(mx, R - 2);
        if (hi === 2 || hi === 3 || hi === 4) R = Math.max(mx, L + 2);
        if (hi === 0 || hi === 1 || hi === 2) T = Math.min(my, B - 2);
        if (hi === 4 || hi === 5 || hi === 6) B = Math.max(my, T + 2);
        r.x = L; r.y = T; r.w = R - L; r.h = B - T;
        var ax = (hi === 0 || hi === 6 || hi === 7) ? 'right' : (hi === 1 || hi === 5) ? 'center' : 'left';
        var ay = (hi === 0 || hi === 1 || hi === 2) ? 'bottom' : (hi === 3 || hi === 7) ? 'center' : 'top';
        applyAspect(r, it, ax, ay);
      }
      clampCrop(it);
      drawSrc();
      scheduleBuild();
    });
    window.addEventListener('mouseup', function () {
      if (drag) { drag = null; scheduleBuild(true); }
    });
    cv.addEventListener('mousemove', function (e) {
      var it = curItem(); if (!it || drag) return;
      var b = cv.getBoundingClientRect();
      var hi = hitHandle(e.clientX - b.left, e.clientY - b.top, it);
      var cur2 = 'crosshair';
      if (hi === -1) cur2 = 'move';
      else if (hi >= 0) cur2 = ['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize',
        'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'][hi];
      cv.style.cursor = cur2;
    });
  }

  /* ============================================================
   * podgląd wyniku
   * ============================================================ */
  function drawOut() {
    var it = curItem();
    if (!it || !it.out) return;
    var cfg = it.cfg, z = parseInt($('selZoom').value, 10) || 2;
    var onLcd = $('chkOnLcd').checked;
    var cv = $('outCv'), c = cv.getContext('2d');

    var src = document.createElement('canvas');
    src.width = cfg.w; src.height = cfg.h;
    src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(it.out.rgba), cfg.w, cfg.h), 0, 0);

    if (onLcd) {
      cv.width = MAXW * z; cv.height = MAXH * z;
      c.imageSmoothingEnabled = false;
      c.fillStyle = '#000';
      c.fillRect(0, 0, cv.width, cv.height);
      // x0 = wiersz (pion), y0 = kolumna (poziom)
      c.drawImage(src, cfg.y0 * z, cfg.x0 * z, cfg.w * z, cfg.h * z);
      c.strokeStyle = 'rgba(78,161,255,.55)';
      c.strokeRect(cfg.y0 * z + .5, cfg.x0 * z + .5, cfg.w * z - 1, cfg.h * z - 1);
    } else {
      cv.width = cfg.w * z; cv.height = cfg.h * z;
      c.imageSmoothingEnabled = false;
      c.drawImage(src, 0, 0, cv.width, cv.height);
    }

    var over = (cfg.w > MAXW || cfg.h > MAXH);
    var fits = (cfg.x0 + cfg.h <= MAXH && cfg.y0 + cfg.w <= MAXW);
    $('outInfo').textContent =
      cfg.w + '×' + cfg.h + ' px · ' + fmtDesc(cfg.fmt) + ' · ' + fmtBytes(it.out.size) +
      ' · ' + (100 * it.out.size / SRAM).toFixed(1) + '% SRAM' +
      (over ? '  ⚠ większe niż ekran 132×132' : (!fits ? '  ⚠ przy x0/y0 wychodzi poza ekran' : ''));
  }

  function updateWarn() {
    var it = curItem(); if (!it) return;
    var cfg = it.cfg;
    var bar = $('swapWarn'), hint = $('orderHint');
    var msgs = [];
    if (cfg.order !== cfg.panel) {
      bar.className = 'warn-bar';
      bar.innerHTML = '⚠ <b>Czerwony i niebieski zamienią się miejscami.</b> Tablica zapisuje ' +
        (cfg.order === 'bgr' ? 'B-G-R' : 'R-G-B') + ', a wyświetlacz czyta ' +
        (cfg.panel === 'bgr' ? 'B-G-R (MADCTL 0x08)' : 'R-G-B (MADCTL 0x00)') +
        '. Podgląd obok pokazuje faktyczny efekt. ' +
        '<button id="btnFixOrder" class="mini-btn">napraw kolejność</button>';
      bar.classList.remove('hidden');
      var b = $('btnFixOrder');
      if (b) b.addEventListener('click', function () {
        it.cfg.order = it.cfg.panel; syncCfgToUi(); scheduleBuild(true);
      });
    } else {
      bar.className = 'warn-bar hidden';
    }
    if (cfg.fmt === 'p16') {
      msgs.push('16 bpp wymaga <code>COLMOD (0x3A) = 0x05</code>. <code>LCDSettings()</code> ' +
        'z laboratorium ustawia 0x03 — bez zmiany w sterowniku obraz się rozjedzie.');
    }
    if (cfg.order === 'bgr' && cfg.panel === 'bgr') {
      msgs.push('Ustawienia domyślne — zgodne ze sterownikiem z laboratorium ' +
        '(<code>MADCTL = 0x08</code>, <code>RED 0x00F</code>, <code>BLUE 0xF00</code>). Kolory wyjdą prawidłowo.');
    }
    var sz = it.out ? it.out.size : 0;
    if (sz > SRAM * 0.35) {
      msgs.push('Tablica zajmuje ' + (100 * sz / SRAM).toFixed(0) + '% z 64 KB SRAM — ' +
        'przy „ARM RAM Release” cały program ląduje w RAM-ie. Rozważ mniejszy obraz.');
    }
    hint.innerHTML = msgs.join('<br><br>') || 'Kolejność zapisu i interpretacja panelu są zgodne.';
    hint.className = 'hintbox' + (cfg.order !== cfg.panel ? ' bad' : '');
  }

  function fullCode(it) {
    if (!it.out) build(it);
    return genHeader([it], it.file);
  }

  function updateCode() {
    var it = curItem(); if (!it || !it.out) return;
    $('codeOut').textContent = genHeader([it], it.file, 90);
    var per = Math.max(4, Math.min(64, it.cfg.perLine | 0));
    var n = (it.cfg.fmt === 'w12') ? it.out.words.length : it.out.bytes.length;
    $('codeInfo').textContent = it.file + ' — tablica ' + fmtBytes(it.out.size) + ', ' +
      n.toLocaleString('pl-PL') + ' liczb w ' + Math.ceil(n / per).toLocaleString('pl-PL') + ' wierszach';
  }

  /* ============================================================
   * synchronizacja UI
   * ============================================================ */
  function syncCfgToUi() {
    var it = curItem(); if (!it) return;
    var c = it.cfg;
    $('selPreset').value = c.preset;
    $('inW').value = c.w; $('inH').value = c.h;
    $('chkLockAsp').checked = c.lockAsp;
    $('selFit').value = c.fit;
    $('selSmooth').value = c.smooth;
    $('selRot').value = String(c.rot);
    $('chkFlipH').checked = c.flipH; $('chkFlipV').checked = c.flipV;
    $('rgBri').value = c.bri; $('vBri').textContent = c.bri;
    $('rgCon').value = c.con; $('vCon').textContent = c.con;
    $('rgSat').value = c.sat; $('vSat').textContent = c.sat;
    $('rgGam').value = c.gam; $('vGam').textContent = (c.gam / 100).toFixed(2);
    $('chkNeg').checked = c.neg; $('chkGray').checked = c.gray;
    $('selDither').value = c.dither;
    $('inBg').value = c.bg; $('inBgHex').value = c.bg;
    $('selFmt').value = c.fmt; $('selOrder').value = c.order; $('selPanel').value = c.panel;
    $('inPerLine').value = c.perLine; $('selCase').value = c.hexCase;
    $('chkGuard').checked = c.guard; $('chkDefs').checked = c.defs; $('chkUsage').checked = c.usage;
    $('inX0').value = c.x0; $('inY0').value = c.y0;
    $('inName').value = it.name; $('inFile').value = it.file;
  }

  function readUiToCfg() {
    var it = curItem(); if (!it) return;
    var c = it.cfg;
    c.preset = $('selPreset').value;
    c.w = Math.max(1, Math.min(512, parseInt($('inW').value, 10) || 1));
    c.h = Math.max(1, Math.min(512, parseInt($('inH').value, 10) || 1));
    c.lockAsp = $('chkLockAsp').checked;
    c.fit = $('selFit').value;
    c.smooth = $('selSmooth').value;
    c.rot = parseInt($('selRot').value, 10) || 0;
    c.flipH = $('chkFlipH').checked; c.flipV = $('chkFlipV').checked;
    c.bri = +$('rgBri').value; c.con = +$('rgCon').value;
    c.sat = +$('rgSat').value; c.gam = +$('rgGam').value;
    c.neg = $('chkNeg').checked; c.gray = $('chkGray').checked;
    c.dither = $('selDither').value;
    c.bg = /^#[0-9a-f]{6}$/i.test($('inBgHex').value.trim()) ? $('inBgHex').value.trim() : $('inBg').value;
    c.fmt = $('selFmt').value; c.order = $('selOrder').value; c.panel = $('selPanel').value;
    c.perLine = Math.max(4, Math.min(64, parseInt($('inPerLine').value, 10) || 24));
    c.hexCase = $('selCase').value;
    c.guard = $('chkGuard').checked; c.defs = $('chkDefs').checked; c.usage = $('chkUsage').checked;
    c.x0 = Math.max(0, Math.min(255, parseInt($('inX0').value, 10) || 0));
    c.y0 = Math.max(0, Math.min(255, parseInt($('inY0').value, 10) || 0));
    var nm = cIdent($('inName').value);
    if (nm !== it.name) { it.name = nm; }
    it.file = ($('inFile').value || (it.name + '.h')).trim();
    lastCfg = JSON.parse(JSON.stringify(c));
    storeCfg(c);
  }

  /* przeliczenie zbiorcze — setTimeout, a nie rAF: w ukrytej karcie
   * rAF zamiera i podglad przestalby nadazac za ustawieniami */
  function scheduleBuild(now) {
    if (raf) clearTimeout(raf);
    raf = 0;
    if (now) { doBuild(); return; }
    raf = setTimeout(function () { raf = 0; doBuild(); }, 16);
  }
  function doBuild() {
    var it = curItem(); if (!it) return;
    build(it);
    drawOut();
    updateWarn();
    updateCode();
    renderList();
  }

  function syncAll() {
    var has = items.length > 0;
    $('workArea').classList.toggle('hidden', !has);
    $('dropZone').classList.toggle('hidden', has);
    renderList();
    if (!has) { $('imgInfo').textContent = 'brak grafik'; return; }
    syncCfgToUi();
    layoutSrc();
    drawSrc();
    doBuild();
  }

  /* ============================================================
   * podgląd istniejącego .h
   * ============================================================ */
  function parseArrays(text) {
    var out = [];
    var re = /([A-Za-z_]\w*)\s*\[\s*[^\]]*\]\s*=\s*\{([\s\S]*?)\}\s*;/g, m;
    while ((m = re.exec(text))) {
      var nums = m[2].match(/0[xX][0-9a-fA-F]+|\b\d+\b/g) || [];
      if (nums.length < 8) continue;
      out.push({ name: m[1], vals: nums.map(function (s) { return parseInt(s, /^0[xX]/.test(s) ? 16 : 10); }) });
    }
    return out;
  }
  function suggestDims(px) {
    var res = [];
    for (var w = 1; w <= 512; w++) {
      if (px % w) continue;
      var h = px / w;
      if (h > 512) continue;
      res.push([w, h]);
    }
    res.sort(function (a, b) { return Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]); });
    return res.slice(0, 6);
  }
  function drawHPrev() {
    var arrs = window.__hArrs || [];
    var sel = $('selHArr').value | 0;
    var a = arrs[sel];
    if (!a) return;
    var W = Math.max(1, parseInt($('inHW').value, 10) || 1);
    var H = Math.max(1, parseInt($('inHH').value, 10) || 1);
    var fmt = $('selHFmt').value;
    var n = W * H;
    var words = new Uint16Array(n), i;
    if (fmt === 'w12') {
      for (i = 0; i < n; i++) words[i] = a.vals[i] | 0;
    } else if (fmt === 'p16') {
      for (i = 0; i < n; i++) words[i] = ((a.vals[i * 2] | 0) << 8) | (a.vals[i * 2 + 1] | 0);
    } else {
      for (i = 0; i < n; i += 2) {
        var o = (i >> 1) * 3;
        var b0 = a.vals[o] | 0, b1 = a.vals[o + 1] | 0, b2 = a.vals[o + 2] | 0;
        words[i] = ((b0 << 4) | (b1 >> 4)) & 0xFFF;
        if (i + 1 < n) words[i + 1] = (((b1 & 0xF) << 8) | b2) & 0xFFF;
      }
    }
    [['hCvB', 'bgr'], ['hCvR', 'rgb']].forEach(function (p) {
      var cv = $(p[0]);
      var z = Math.max(1, Math.min(3, Math.floor(320 / Math.max(W, H))));
      cv.width = W * z; cv.height = H * z;
      var tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      tmp.getContext('2d').putImageData(new ImageData(decodeToRgba(words, n, fmt, p[1]), W, H), 0, 0);
      var c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      c.drawImage(tmp, 0, 0, cv.width, cv.height);
    });
  }
  function refreshHArrays() {
    var arrs = parseArrays($('hText').value);
    window.__hArrs = arrs;
    var sel = $('selHArr');
    sel.innerHTML = '';
    arrs.forEach(function (a, i) {
      var o = document.createElement('option');
      o.value = i; o.textContent = a.name + ' (' + a.vals.length + ')';
      sel.appendChild(o);
    });
    if (!arrs.length) {
      $('hParseInfo').textContent = 'nie znaleziono tablicy';
      $('hSuggest').textContent = '';
      return;
    }
    $('hParseInfo').textContent = 'znaleziono tablic: ' + arrs.length;
    onHArrayPick();
  }
  function onHArrayPick() {
    var arrs = window.__hArrs || [];
    var a = arrs[$('selHArr').value | 0];
    if (!a) return;
    var maxv = a.vals.reduce(function (m, v) { return v > m ? v : m; }, 0);
    var fmt = (maxv > 0xFF) ? 'w12' : 'p12';
    $('selHFmt').value = fmt;
    var px = (fmt === 'w12') ? a.vals.length : Math.floor(a.vals.length * 2 / 3);
    var sug = suggestDims(px);
    $('hSuggest').textContent = px + ' px; pasujące wymiary: ' +
      sug.map(function (s) { return s[0] + '×' + s[1]; }).join(', ');
    if (sug.length) { $('inHW').value = sug[0][0]; $('inHH').value = sug[0][1]; }
    drawHPrev();
  }

  /* ============================================================
   * zdarzenia
   * ============================================================ */
  function pickFiles() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = 'image/png,image/jpeg,image/gif,image/bmp,image/webp,.png,.jpg,.jpeg,.gif,.bmp,.webp';
    inp.addEventListener('change', function () { addFiles(inp.files); });
    inp.click();
  }

  function bindCfg() {
    var geom = ['inW', 'inH', 'selFit', 'selSmooth', 'selRot', 'chkFlipH', 'chkFlipV', 'chkLockAsp'];
    var all = geom.concat(['rgBri', 'rgCon', 'rgSat', 'rgGam', 'chkNeg', 'chkGray', 'selDither',
      'inBg', 'inBgHex', 'selFmt', 'selOrder', 'selPanel', 'inPerLine', 'selCase',
      'chkGuard', 'chkDefs', 'chkUsage', 'inX0', 'inY0', 'inName', 'inFile']);
    all.forEach(function (id) {
      var el = $(id);
      var ev = (el.type === 'range' || el.type === 'text' ||
        el.type === 'number' || el.type === 'color') ? 'input' : 'change';
      el.addEventListener(ev, function () {
        readUiToCfg();
        $('vBri').textContent = $('rgBri').value;
        $('vCon').textContent = $('rgCon').value;
        $('vSat').textContent = $('rgSat').value;
        $('vGam').textContent = (+$('rgGam').value / 100).toFixed(2);
        if (id === 'inBg') $('inBgHex').value = $('inBg').value;
        if (id === 'inBgHex' && /^#[0-9a-f]{6}$/i.test($('inBgHex').value)) $('inBg').value = $('inBgHex').value;
        if (id === 'inName' && curItem() && document.activeElement !== $('inFile'))
          $('inFile').value = curItem().name + '.h';
        if (geom.indexOf(id) >= 0) {
          var it = curItem();
          if (it && it.cfg.lockAsp && (id === 'inW' || id === 'inH' || id === 'chkLockAsp')) {
            resetCrop(it, true);
            drawSrc();
          }
          drawSrc();
        }
        scheduleBuild();
      });
    });

    $('selPreset').addEventListener('change', function () {
      var v = $('selPreset').value;
      if (v !== 'custom') {
        var p = v.split('x');
        $('inW').value = p[0]; $('inH').value = p[1];
      }
      readUiToCfg();
      var it = curItem();
      if (it && it.cfg.lockAsp) resetCrop(it, true);
      drawSrc();
      scheduleBuild(true);
    });
    ['inW', 'inH'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        var v = $('inW').value + 'x' + $('inH').value;
        var opt = Array.from($('selPreset').options).some(function (o) { return o.value === v; });
        $('selPreset').value = opt ? v : 'custom';
      });
    });

    $('btnResetCfg').addEventListener('click', function () {
      var it = curItem(); if (!it) return;
      var d = defaultCfg();
      d.x0 = it.cfg.x0; d.y0 = it.cfg.y0;
      it.cfg = d;
      resetCrop(it, true);
      syncCfgToUi(); drawSrc(); scheduleBuild(true);
      toast('Przywrócono ustawienia domyślne');
    });

    $('btnCropAll').addEventListener('click', function () {
      var it = curItem(); if (!it) return;
      resetCrop(it, false); clampCrop(it); drawSrc(); scheduleBuild(true);
    });
    $('btnCropFit').addEventListener('click', function () {
      var it = curItem(); if (!it) return;
      it.cfg.lockAsp = true; $('chkLockAsp').checked = true;
      resetCrop(it, true); drawSrc(); scheduleBuild(true);
    });
    $('btnCropSq').addEventListener('click', function () {
      var it = curItem(); if (!it) return;
      cropSquare(it); clampCrop(it); drawSrc(); scheduleBuild(true);
    });

    $('selZoom').addEventListener('change', drawOut);
    $('chkOnLcd').addEventListener('change', drawOut);
  }

  function bindOutput() {
    $('btnCopy').addEventListener('click', function () {
      var it = curItem(); if (!it) return;
      navigator.clipboard.writeText(fullCode(it)).then(
        function () { toast('Skopiowano ' + it.file + ' do schowka'); },
        function () { toast('Przeglądarka nie pozwoliła na kopiowanie', true); });
    });
    $('btnDlH').addEventListener('click', function () {
      var it = curItem(); if (!it) return;
      download(it.file, fullCode(it), 'text/x-c');
      toast('Pobrano ' + it.file);
    });
    $('btnDlAll').addEventListener('click', function () {
      if (!items.length) return;
      items.forEach(function (it) { if (!it.out) build(it); });
      var fn = 'bitmapy.h';
      download(fn, genHeader(items, fn), 'text/x-c');
      toast('Pobrano ' + fn + ' (' + items.length + ' tablic)');
    });
    $('btnDlPng').addEventListener('click', function () {
      var it = curItem(); if (!it || !it.out) return;
      var z = 4;
      var src = document.createElement('canvas');
      src.width = it.cfg.w; src.height = it.cfg.h;
      src.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(it.out.rgba), it.cfg.w, it.cfg.h), 0, 0);
      var big = document.createElement('canvas');
      big.width = it.cfg.w * z; big.height = it.cfg.h * z;
      var bc = big.getContext('2d');
      bc.imageSmoothingEnabled = false;
      bc.drawImage(src, 0, 0, big.width, big.height);
      big.toBlob(function (blob) {
        if (!blob) return;
        download(it.name + '_podglad.png', blob);
        toast('Pobrano podgląd PNG');
      }, 'image/png');
    });
    $('btnToSim').addEventListener('click', function () {
      var it = curItem(); if (!it) return;
      try {
        var q = JSON.parse(localStorage.getItem(LS_PENDING) || '[]');
        q = q.filter(function (f) { return f.name !== it.file; });
        q.push({ name: it.file, text: fullCode(it) });
        localStorage.setItem(LS_PENDING, JSON.stringify(q));
        toast('Dodano ' + it.file + ' — otwórz/odśwież symulator');
      } catch (e) {
        toast('Nie udało się zapisać: ' + e.message, true);
      }
    });
  }

  function bindHModal() {
    $('btnLoadH').addEventListener('click', function () { $('hModal').classList.remove('hidden'); });
    $('btnCloseH').addEventListener('click', function () { $('hModal').classList.add('hidden'); });
    $('btnHFile').addEventListener('click', function () {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.h,.c,.txt';
      inp.addEventListener('change', function () {
        var f = inp.files[0]; if (!f) return;
        var rd = new FileReader();
        rd.onload = function () { $('hText').value = rd.result; refreshHArrays(); };
        rd.readAsText(f);
      });
      inp.click();
    });
    $('hText').addEventListener('input', refreshHArrays);
    $('selHArr').addEventListener('change', onHArrayPick);
    ['inHW', 'inHH', 'selHFmt'].forEach(function (id) {
      $(id).addEventListener('input', drawHPrev);
      $(id).addEventListener('change', drawHPrev);
    });
  }

  function bindDrop() {
    var zone = $('viewPane');
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault(); $('dropZone').classList.add('hot');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) {
        e.preventDefault(); $('dropZone').classList.remove('hot');
      });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
  }

  function init() {
    lastCfg = loadCfg();
    $('btnAdd').addEventListener('click', pickFiles);
    $('btnAdd2').addEventListener('click', pickFiles);
    $('dropZone').addEventListener('click', pickFiles);
    $('btnHelpB').addEventListener('click', function () { $('helpModal2').classList.remove('hidden'); });
    $('btnCloseHelp2').addEventListener('click', function () { $('helpModal2').classList.add('hidden'); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        $('helpModal2').classList.add('hidden');
        $('hModal').classList.add('hidden');
      }
    });
    bindCfg(); bindCrop(); bindOutput(); bindHModal(); bindDrop();
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (curItem()) { layoutSrc(); drawSrc(); }
      }).observe($('srcWrap'));
    }
    syncAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window);
