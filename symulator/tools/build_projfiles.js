/* Budowanie js/projfiles.js — osadzenie plików projektu i przykładów.
 * Uruchomienie:  node tools/build_projfiles.js   (z katalogu symulator/)
 *
 * Pliki biblioteki laboratorium czytane są z tools/lab_src/.
 * Nagłówki bmp132.h i bmpChoinka.h są GENEROWANE programowo (grafika
 * własna — bez clipartów o nieznanym pochodzeniu); nazwy tablic i wymiary
 * zachowane (bmp132 132×132, bmp80 80×80, bmpChoinka 116×121,
 * bmpMikolaj 120×120), więc oryginalne programy z labów kompilują się
 * bez zmian. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LAB = path.join(__dirname, 'lab_src');
const EX = path.join(__dirname, 'examples');
const OUT = path.join(ROOT, 'js', 'projfiles.js');

// pliki laboratoryjne: CP1250 → Unicode (tylko polskie znaki, reszta = latin1)
const CP1250 = {
  0xB9: 'ą', 0xE6: 'ć', 0xEA: 'ę', 0xB3: 'ł', 0xF1: 'ń', 0xF3: 'ó',
  0x9C: 'ś', 0x9F: 'ź', 0xBF: 'ż', 0xA5: 'Ą', 0xC6: 'Ć', 0xCA: 'Ę',
  0xA3: 'Ł', 0xD1: 'Ń', 0xD3: 'Ó', 0x8C: 'Ś', 0x8F: 'Ź', 0xAF: 'Ż',
  0x97: '—', 0x96: '–', 0x84: '„', 0x94: '”'
};
function rd(p) {
  const buf = fs.readFileSync(p);
  let t = '';
  for (const b of buf) t += CP1250[b] || String.fromCharCode(b);
  return t.replace(/\r\n/g, '\n');
}
// moje przykłady są w UTF-8
function rdU(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

/* ============================================================
 * Generator bitmap 12 bpp (grafika własna, rysowana kodem)
 * Wartość piksela: (B<<8)|(G<<4)|R — ta sama konwencja co stałe
 * kolorów w PCF8833U8_lcd.h (RED=0x00F itd., MADCTL z bitem BGR).
 * ============================================================ */
function col(r, g, b) { return ((b & 15) << 8) | ((g & 15) << 4) | (r & 15); }
const C = {
  WHITE: col(15, 15, 15), BLACK: col(0, 0, 0),
  RED: col(14, 1, 1), DARKRED: col(10, 0, 0),
  GREEN: col(1, 9, 2), GREEN2: col(2, 12, 3),
  BLUE: col(2, 4, 15), YELLOW: col(15, 13, 0),
  BROWN: col(8, 4, 1), SKIN: col(15, 11, 8),
  SKY: col(11, 13, 15), PINK: col(15, 8, 9),
  GRAY: col(8, 8, 8)
};

function makeImg(w, h, bg) {
  return { w, h, px: new Uint16Array(w * h).fill(bg) };
}
function put(img, x, y, c) {
  x |= 0; y |= 0;
  if (x >= 0 && x < img.w && y >= 0 && y < img.h) img.px[y * img.w + x] = c;
}
function rect(img, x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(img, x, y, c);
}
function frame(img, x0, y0, x1, y1, c) {
  for (let x = x0; x <= x1; x++) { put(img, x, y0, c); put(img, x, y1, c); }
  for (let y = y0; y <= y1; y++) { put(img, x0, y, c); put(img, x1, y, c); }
}
function disc(img, cx, cy, r, c) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++)
    if (x * x + y * y <= r * r) put(img, cx + x, cy + y, c);
}
function ringArc(img, cx, cy, r, th, c, yMin, yMax) {
  const r2o = r * r, r2i = (r - th) * (r - th);
  for (let y = -r; y <= r; y++) {
    if (cy + y < yMin || cy + y > yMax) continue;
    for (let x = -r; x <= r; x++) {
      const d = x * x + y * y;
      if (d <= r2o && d >= r2i) put(img, cx + x, cy + y, c);
    }
  }
}
function tri(img, ax, ay, bx, by, cx2, cy2, c) {
  const minX = Math.min(ax, bx, cx2), maxX = Math.max(ax, bx, cx2);
  const minY = Math.min(ay, by, cy2), maxY = Math.max(ay, by, cy2);
  const d = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2);
  if (d === 0) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const w1 = ((by - cy2) * (x - cx2) + (cx2 - bx) * (y - cy2)) / d;
    const w2 = ((cy2 - ay) * (x - cx2) + (ax - cx2) * (y - cy2)) / d;
    const w3 = 1 - w1 - w2;
    if (w1 >= 0 && w2 >= 0 && w3 >= 0) put(img, x, y, c);
  }
}

function pack12(img) {
  const px = img.px, n = px.length;
  const bytes = [];
  for (let i = 0; i < n; i += 2) {
    const p0 = px[i] & 0xFFF;
    const p1 = (i + 1 < n) ? (px[i + 1] & 0xFFF) : 0;
    bytes.push((p0 >> 4) & 0xFF, ((p0 & 0xF) << 4) | ((p1 >> 8) & 0xF), p1 & 0xFF);
    if (i + 1 >= n) bytes.pop(); // nieparzysta liczba pikseli: ostatni = 2 bajty
  }
  return bytes;
}
function toCArray(name, img, comment) {
  const bytes = pack12(img);
  let s = '// ' + comment + ' (' + img.w + 'x' + img.h + ', 12bpp, grafika wygenerowana\n' +
    '// programowo na potrzeby symulatora — rysunek wlasny, bez praw osob trzecich)\n' +
    'const unsigned char ' + name + '[] = {\n';
  for (let i = 0; i < bytes.length; i += 24) {
    s += '  ' + bytes.slice(i, i + 24).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ') +
      (i + 24 < bytes.length ? ',' : '') + '\n';
  }
  s += '};\n';
  return s;
}

/* --- bmp132: tablica testowa wyświetlacza 132×132 --- */
function genBmp132() {
  const im = makeImg(132, 132, C.WHITE);
  // pasy kolorów (jak na karcie testowej)
  const bars = [col(15, 15, 15), col(15, 15, 0), col(0, 15, 15), col(0, 15, 0),
  col(15, 0, 15), col(15, 0, 0), col(0, 0, 15), col(0, 0, 0)];
  for (let i = 0; i < 8; i++) {
    rect(im, 2 + Math.round(i * 16), 2, 2 + Math.round((i + 1) * 16) - 1, 58, bars[i]);
  }
  // gradient szarości
  for (let x = 2; x <= 129; x++) {
    const lv = Math.round((x - 2) / 127 * 15);
    for (let y = 62; y <= 76; y++) put(im, x, y, col(lv, lv, lv));
  }
  // gradienty R / G / B
  for (let x = 2; x <= 129; x++) {
    const lv = Math.round((x - 2) / 127 * 15);
    for (let y = 80; y <= 90; y++) put(im, x, y, col(lv, 0, 0));
    for (let y = 92; y <= 102; y++) put(im, x, y, col(0, lv, 0));
    for (let y = 104; y <= 114; y++) put(im, x, y, col(0, 0, lv));
  }
  // szachownica do oceny ostrości pikseli
  for (let x = 2; x <= 129; x++) for (let y = 118; y <= 129; y++) {
    put(im, x, y, ((x >> 2) + (y >> 2)) & 1 ? C.BLACK : C.WHITE);
  }
  frame(im, 0, 0, 131, 131, C.BLACK);
  frame(im, 1, 1, 130, 130, C.BLACK);
  return im;
}

/* --- bmp80: uśmiechnięta buźka 80×80 --- */
function genBmp80() {
  const im = makeImg(80, 80, C.SKY);
  disc(im, 40, 40, 34, C.BLACK);          // kontur
  disc(im, 40, 40, 32, C.YELLOW);         // twarz
  disc(im, 28, 31, 5, C.BLACK);           // oczy
  disc(im, 52, 31, 5, C.BLACK);
  disc(im, 28, 30, 1, C.WHITE);
  disc(im, 52, 30, 1, C.WHITE);
  ringArc(im, 40, 38, 20, 4, C.BLACK, 48, 62);   // uśmiech (dolny łuk)
  disc(im, 19, 45, 4, C.PINK);            // rumieńce
  disc(im, 61, 45, 4, C.PINK);
  frame(im, 0, 0, 79, 79, C.BLACK);
  return im;
}

/* --- bmpChoinka: choinka 116×121 (rysunek własny) --- */
function genChoinka() {
  const im = makeImg(116, 121, C.SKY);
  // śnieg na dole
  rect(im, 0, 108, 115, 120, C.WHITE);
  // pień
  rect(im, 52, 96, 64, 112, C.BROWN);
  // trzy poziomy gałęzi
  tri(im, 58, 38, 14, 104, 102, 104, C.GREEN);
  tri(im, 58, 22, 22, 76, 94, 76, C.GREEN2);
  tri(im, 58, 8, 32, 52, 84, 52, C.GREEN);
  // gwiazda (romb + promienie)
  disc(im, 58, 8, 4, C.YELLOW);
  for (let d = -7; d <= 7; d++) { put(im, 58 + d, 8, C.YELLOW); put(im, 58, 8 + d, C.YELLOW); }
  // bombki
  [[44, 66, C.RED], [72, 70, C.BLUE], [58, 88, C.YELLOW],
  [34, 96, C.BLUE], [82, 94, C.RED], [50, 46, C.BLUE], [68, 44, C.RED]
  ].forEach(([x, y, c]) => { disc(im, x, y, 4, c); put(im, x - 1, y - 1, C.WHITE); });
  // padający śnieg
  [[10, 14], [28, 30], [98, 20], [108, 56], [8, 70], [104, 86], [20, 56], [90, 8],
  [12, 94], [106, 36], [36, 12], [84, 30]
  ].forEach(([x, y]) => disc(im, x, y, 1, C.WHITE));
  return im;
}

/* --- bmpMikolaj: Mikołaj 120×120 (rysunek własny) --- */
function genMikolaj() {
  const im = makeImg(120, 120, C.SKY);
  rect(im, 0, 110, 119, 119, C.WHITE);            // śnieg
  // tułów
  rect(im, 32, 86, 88, 112, C.RED);
  rect(im, 30, 98, 90, 104, C.BLACK);             // pas
  rect(im, 54, 96, 66, 106, C.YELLOW);            // klamra
  rect(im, 57, 99, 63, 103, C.BLACK);
  // broda
  disc(im, 60, 74, 24, C.WHITE);
  // twarz
  disc(im, 60, 56, 19, C.SKIN);
  // czapka
  tri(im, 36, 46, 84, 46, 60, 12, C.RED);
  rect(im, 34, 42, 86, 50, C.WHITE);              // otok
  disc(im, 60, 11, 6, C.WHITE);                   // pompon
  // oczy, nos, usta
  disc(im, 52, 54, 2, C.BLACK);
  disc(im, 68, 54, 2, C.BLACK);
  disc(im, 60, 62, 4, col(15, 6, 6));             // nos
  ringArc(im, 60, 66, 9, 3, col(12, 4, 4), 70, 78); // usta
  // ręce
  rect(im, 22, 88, 32, 96, C.RED);
  rect(im, 88, 88, 98, 96, C.RED);
  disc(im, 22, 92, 4, C.WHITE);
  disc(im, 98, 92, 4, C.WHITE);
  return im;
}

function genBmp132Header() {
  return '/* bmp132.h — obrazy testowe symulatora (grafika wlasna, generowana\n' +
    '   programowo przez tools/build_projfiles.js). Nazwy tablic zgodne\n' +
    '   z plikami uzywanymi na laboratorium. */\n\n' +
    toCArray('bmp132', genBmp132(), 'tablica testowa wyswietlacza') + '\n' +
    toCArray('bmp80', genBmp80(), 'usmiechnieta buzka');
}
function genChoinkaHeader() {
  return '/* bmpChoinka.h — obrazy do animacji (grafika wlasna, generowana\n' +
    '   programowo przez tools/build_projfiles.js). */\n\n' +
    toCArray('bmpChoinka', genChoinka(), 'choinka') + '\n' +
    toCArray('bmpMikolaj', genMikolaj(), 'Mikolaj');
}

/* ============================================================ */

// pliki biblioteki (wspólne dla wszystkich projektów)
const libFiles = {};
['pcf8833u8_lcd.c', 'PCF8833U8_lcd.h', 'fonts.h', 'defines.h', 'bmp.h']
  .forEach(n => { libFiles[n] = rd(path.join(LAB, n)); });
libFiles['bmp132.h'] = genBmp132Header();
libFiles['bmpChoinka.h'] = genChoinkaHeader();

// main z lab10 (zaliczony projekt menu) — anonimizacja nazwiska
let lab10 = rd(path.join(LAB, 'main_GE12.c'));
lab10 = lab10.replace('Szymon Wojcik', 'Jan Kowalski');
lab10 = '/* LABORATORIUM 10 — menu aplikacji uzytkownika (przyklad POGLADOWY,\n' +
  ' * nie stanowi kompletnego rozwiazania zadania zaliczeniowego).\n' +
  ' * Sterowanie: joystick GORA/DOL — ruch markera; SW2 — wejscie do\n' +
  ' * podmenu / powrot; SW1 — uruchomienie wybranego programu.\n' +
  ' * W symulatorze: strzalki, klawisze 1 (SW1) i 2 (SW2). */\n' + lab10;

const examples = [];
function addExample(id, title, desc, mainText, extra) {
  examples.push({ id, title, desc, main: mainText, extra: extra || null });
}

addExample('szablon', 'Szablon projektu',
  'Minimalny program: LCD, przyciski, podswietlenie.',
  rdU(path.join(EX, 'main_szablon.c')));
addExample('lab6', 'Lab 6 — podswietlenie i buzzer',
  'Pierwszy program wg instrukcji: SW1/SW2 steruja PB20 i PB19.',
  rdU(path.join(EX, 'lab6_podswietlenie.c')));
addExample('lab8', 'Lab 8 — klawiatura i joystick',
  'Stany joysticka i przyciskow na LCD (zad. 8.1).',
  rdU(path.join(EX, 'lab8_joystick.c')));
addExample('lab9', 'Lab 9 — wyswietlacz graficzny',
  'Teksty, prostokaty, tekst transparentny, bitmapy, animacja.',
  rdU(path.join(EX, 'lab9_wyswietlacz.c')));
addExample('lab10', 'Lab 10 — menu (przyklad)',
  'Menu na listach dwukierunkowych, marker, podmenu, programy.',
  lab10);
addExample('lab11', 'Lab 11 / LSW6 — timery PIT i TC0',
  'Odmierzanie czasu timerami, miganie podswietleniem co 1 s.',
  rdU(path.join(EX, 'lab11_timery.c')));

let out = '/* Plik generowany przez tools/build_projfiles.js — nie edytowac recznie */\n';
out += '(function(g){\n"use strict";\nvar CC = g.CC || (g.CC = {});\n';
out += 'CC.PROJ_LIB = ' + JSON.stringify(libFiles) + ';\n';
out += 'CC.EXAMPLES = ' + JSON.stringify(examples) + ';\n';
out += 'CC.DEFAULT_EXAMPLE = "szablon";\n';
out += '})(typeof globalThis!=="undefined"?globalThis:this);\n';

fs.writeFileSync(OUT, out, 'utf8');
const sz = fs.statSync(OUT).size;
console.log('OK: ' + OUT + ' (' + (sz / 1024).toFixed(0) + ' KB, ' +
  Object.keys(libFiles).length + ' plikow biblioteki, ' + examples.length + ' przykladow)');
