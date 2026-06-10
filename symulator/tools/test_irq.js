/* Test przerwań: PIT → AIC (linia SYS) → handler w C */
'use strict';
['cc_lex.js', 'cc_parse.js', 'cc_gen.js', 'runtime.js', 'periph.js', 'lcd.js', 'board.js',
  'headers.js', 'projfiles.js'].forEach(f => require('../js/' + f));
const CC = globalThis.CC;

const src = `
#include <targets/AT91SAM7.h>

volatile int licznik_przerwan = 0;

void pit_handler(void)
{
    PIT_PIVR;                       // kasuje PITS i PICNT
    licznik_przerwan++;
    if ((PIOB_PDSR & (1<<20)) != 0) PIOB_CODR = (1<<20);
    else                            PIOB_SODR = (1<<20);
}

int main(void)
{
    PMC_PCER = PMC_PCER_PIOB;
    PIOB_PER = (1<<20);
    PIOB_OER = (1<<20);

    AIC_SVR1 = (unsigned int)pit_handler;   // wektor dla linii SYS
    AIC_IECR = (1<<1);                      // odblokuj przerwanie SYS

    PIT_MR = 299999 | (1<<24) | (1<<25);    // PIV=0,1s + PITEN + PITIEN
    PIT_PIVR;

    while (1) { __asm__("nop"); }
    return 0;
}`;

const files = [{ name: 'main.c', text: src }];
for (const [name, text] of Object.entries(CC.PROJ_LIB)) files.push({ name, text });
const { result, diags } = CC.compileProject(files, CC.systemHeaders());
const errs = diags.filter(d => d.sev === 'error');
errs.forEach(d => console.log(`BŁĄD ${d.file}:${d.line}: ${d.msg}`));
if (!result) process.exit(1);

const b = new CC.Board();
b.onConsole = (k, t) => console.log(`(${k}) ${String(t).trim()}`);
b.load(result);
let toggles = [];
let last = b.backlightOn();
const limit = Date.now() + 30000;
while (b.timeSec() < 1.05 && b.cpu.status === 'running' && Date.now() < limit) {
  b.cpu.slice(96000);
  const cur = b.backlightOn();
  if (cur !== last) { toggles.push(b.timeSec().toFixed(3)); last = cur; }
}
// odczytaj licznik_przerwan z pamięci
const sym = result; // adresu nie znamy wprost — sprawdź przez stan płytki
console.log('status:', b.cpu.status, b.cpu.faultMsg || '');
console.log('przełączenia BL (oczekiwane co ~0,1 s):', toggles.join(', '));
const ok = b.cpu.status === 'running' && toggles.length >= 9 && toggles.length <= 12;
console.log(ok ? 'PRZERWANIA OK' : 'PRZERWANIA ŹLE');
process.exit(ok ? 0 : 1);
