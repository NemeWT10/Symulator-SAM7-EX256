/* Test pracy krokowej + eksportu symboli */
'use strict';
['cc_lex.js', 'cc_parse.js', 'cc_gen.js', 'runtime.js', 'periph.js', 'lcd.js', 'board.js',
  'headers.js', 'projfiles.js'].forEach(f => require('../js/' + f));
const CC = globalThis.CC;

const src = `#include <targets/AT91SAM7.h>
int a = 1;
unsigned int b = 2;
char nazwa[8] = "abc";
float f = 1.5f;
int tab[5] = {10, 20, 30, 40, 50};

int main(void)
{
    int i;
    a = 5;
    b = a + 10;
    f = 2.5f;
    for (i = 0; i < 3; i++)
    {
        a++;
    }
    while (1) { __asm__("nop"); }
    return 0;
}`;

const files = [{ name: 'main.c', text: src }];
for (const [name, text] of Object.entries(CC.PROJ_LIB)) files.push({ name, text });
const { result, diags } = CC.compileProject(files, CC.systemHeaders());
const errs = diags.filter(d => d.sev === 'error');
errs.forEach(d => console.log(`BŁĄD ${d.file}:${d.line}: ${d.msg}`));
if (!result) process.exit(1);

let fails = 0;

// --- symbole ---
const syms = result.symbols;
const byName = {};
syms.forEach(s => byName[s.name] = s);
['a', 'b', 'nazwa', 'f', 'tab'].forEach(n => {
  if (!byName[n]) { console.log('BRAK symbolu', n); fails++; }
});
console.log('symbole main.c:', syms.filter(s => /main\.c$/i.test(s.unit)).map(s =>
  `${s.name}@0x${s.addr.toString(16)} ${JSON.stringify(s.d)}`).join('\n  '));

const b = new CC.Board();
b.onConsole = (k, t) => console.log(`(${k}) ${String(t).trim()}`);
b.load(result);

function rd32(addr) { return b.rt.dv.getInt32(addr - CC.MEM_BASE, true); }
function rdF32(addr) { return b.rt.dv.getFloat32(addr - CC.MEM_BASE, true); }

// --- krokowanie ---
const lines = [];
for (let k = 0; k < 12 && b.cpu.status === 'running'; k++) {
  b.stepLine();
  const li = b.cpu.lnInfo();
  lines.push(li.file.replace(/^.*[\\/]/, '') + ':' + li.line);
}
console.log('kolejne linie kroków:', lines.join(' → '));
console.log('paused:', b.paused, 'status:', b.cpu.status);

// po >=12 krokach: a=5..8, b=15, f=2.5
const av = rd32(byName['a'].addr);
const bv = rd32(byName['b'].addr);
const fv = rdF32(byName['f'].addr);
console.log(`wartości po krokach: a=${av} b=${bv} f=${fv}`);
if (bv !== 15) { console.log('b powinno być 15'); fails++; }
if (fv !== 2.5) { console.log('f powinno być 2.5'); fails++; }
if (!b.paused) { console.log('powinno być w pauzie'); fails++; }
if (!lines.every(l => l.startsWith('main.c:'))) { console.log('kroki poza main.c?'); fails++; }
// linie powinny być rosnąco-różne na początku (10,11,12,13...)
if (lines[0] === lines[1] && lines[1] === lines[2]) { console.log('kroki nie postępują'); fails++; }

// --- wznowienie po pauzie ---
b.resume();
for (let i = 0; i < 50; i++) b.cpu.slice(96000);
const av2 = rd32(byName['a'].addr);
console.log('po wznowieniu: a=' + av2 + ', t=' + b.timeSec().toFixed(3) + 's, status=' + b.cpu.status);
if (av2 !== 8) { console.log('a powinno być 8 (5+3 inkrementacje)'); fails++; }

// --- krok przez Delaya (dług paliwa) ---
const src2 = files.map(f => f.name === 'main.c' ? {
  name: 'main.c', text:
    '#include "PCF8833U8_lcd.h"\nint x=0;\nint main(){ x=1; Delaya(48000000); x=2; while(1){__asm__("nop");} }'
} : f);
const r2 = CC.compileProject(src2, CC.systemHeaders());
if (r2.result) {
  const b2 = new CC.Board();
  b2.onConsole = () => { };
  b2.load(r2.result);
  let steps = 0, xa = r2.result.symbols.find(s => s.name === 'x').addr;
  while (steps < 25 && b2.cpu.status === 'running') {
    b2.stepLine();
    steps++;
    if (b2.rt.dv.getInt32(xa - CC.MEM_BASE, true) === 2) break;
  }
  const xv = b2.rt.dv.getInt32(xa - CC.MEM_BASE, true);
  console.log(`krok przez Delaya: x=${xv} po ${steps} krokach, t=${b2.timeSec().toFixed(2)}s (Delaya(48M)≈4s)`);
  if (xv !== 2) { console.log('nie przeszło przez Delaya'); fails++; }
  if (b2.timeSec() < 0.9) { console.log('czas wirtualny nie uwzględnił opóźnienia'); fails++; }
} else { console.log('kompilacja testu 2 nieudana'); fails++; }

console.log(fails ? `NIEPOWODZENIA: ${fails}` : 'KROKOWANIE I SYMBOLE OK');
process.exit(fails ? 1 : 0);
