/* Test zgodności: oryginalne pliki studenckie + składnia z instrukcji lab7 */
'use strict';
const fs = require('fs');
const path = require('path');
['cc_lex.js', 'cc_parse.js', 'cc_gen.js', 'runtime.js', 'periph.js', 'lcd.js', 'board.js',
  'headers.js', 'projfiles.js'].forEach(f => require('../js/' + f));
const CC = globalThis.CC;
const LABROOT = path.join(__dirname, '..', '..', 'projekty_ktore_maja_dzialac');

function rd(p) { return fs.readFileSync(p, 'latin1').replace(/\r\n/g, '\n'); }

function compileWithLib(mainText, label) {
  const files = [{ name: 'main.c', text: mainText }];
  for (const [name, text] of Object.entries(CC.PROJ_LIB)) files.push({ name, text });
  const t0 = Date.now();
  const { result, diags } = CC.compileProject(files, CC.systemHeaders());
  const errs = diags.filter(d => d.sev === 'error');
  console.log(`[${label}] ${Date.now() - t0} ms, błędy: ${errs.length}`);
  errs.slice(0, 10).forEach(d => console.log(`   BŁĄD ${d.file}:${d.line}: ${d.msg}`));
  return errs.length ? null : result;
}

function runFor(result, sec, label) {
  const b = new CC.Board();
  b.onConsole = (k, t, f, l) => console.log(`   (${k}) ${String(t).trim()}${f ? ' [' + f + ':' + l + ']' : ''}`);
  b.load(result);
  const limit = Date.now() + 30000;
  while (b.timeSec() < sec && b.cpu.status === 'running' && Date.now() < limit) b.cpu.slice(96000);
  console.log(`   ${label}: status=${b.cpu.status}${b.cpu.faultMsg ? ' (' + b.cpu.faultMsg + ')' : ''}, t=${b.timeSec().toFixed(2)}s`);
  return b;
}

let fails = 0;

// 1–3. oryginalne pliki studenckie — tylko jeśli katalog materiałów istnieje
// (nie jest częścią repozytorium)
if (fs.existsSync(LABROOT)) {
  const m9 = rd(path.join(LABROOT, 'Projekt_lab9', 'main_GE12.c'));
  const r9 = compileWithLib(m9, 'oryginalny lab9');
  if (r9) runFor(r9, 1.0, 'lab9'); else fails++;

  const m10 = rd(path.join(LABROOT, 'Projekt_lab10_zaliczone', 'main_GE12.c'));
  const r10 = compileWithLib(m10, 'oryginalny lab10');
  if (r10) runFor(r10, 1.0, 'lab10'); else fails++;

  const m11 = rd(path.join(LABROOT, 'Projekt_lab11', 'main_GE12.c'));
  const r11 = compileWithLib(m11, 'oryginalny lab11');
  if (r11) runFor(r11, 1.0, 'lab11'); else fails++;
} else {
  console.log('(pominięto testy oryginalnych plików — brak katalogu projekty_ktore_maja_dzialac)');
}

// 4. style adresowania z lab7 (wskaźniki bezpośrednie + adres bazowy)
const lab7 = `
#include <targets/AT91SAM7.h>
#include <stdint.h>
int main(void) {
  // adresowanie bezposrednie
  uint32_t *pPioSodrRegister;
  pPioSodrRegister = (uint32_t*) 0xFFFFF630;
  *pPioSodrRegister = (1<<23);
  // wskaznik typu AT91_REG*
  *AT91C_PIOB_SODR = (1<<23);
  // adres bazowy
  AT91PS_PIO pPio;
  pPio = AT91C_BASE_PIOA;
  pPio->PIO_SODR = 0xFF;
  pPio = AT91C_BASE_PIOB;
  pPio->PIO_SODR = 0xFF;
  pPio->PIO_ODR = 0xffffffff;
  if((pPio->PIO_PDSR | (~0x03000000)) != 0xFFFFFFFF) {
    debug_printf("SW wcisniety\\n");
  }
  debug_printf("lab7 OK: ODSR_B=0x%X\\n", *(volatile unsigned int*)0xFFFFF638);
  return 0;
}`;
const r7 = compileWithLib(lab7, 'lab7 — wskaźniki');
if (r7) {
  const b = runFor(r7, 0.1, 'lab7');
  const odsr = b.pioB.odsr >>> 0;
  const ok = (odsr & 0x8000FF) === 0x8000FF;
  console.log(`   ODSR portu B = 0x${odsr.toString(16).toUpperCase()} ${ok ? 'OK' : 'ŹLE'}`);
  if (!ok) fails++;
} else fails++;

// 5. przykład z instrukcji lab9 — LCDPutStr na surowo + sprintf
const t5 = `
#include <targets/AT91SAM7.h>
#include "PCF8833U8_lcd.h"
#include <stdio.h>
int main() {
  char buf[32];
  int x = 42;
  InitLCD(); LCDSettings(); LCDClearScreen();
  sprintf(buf, "x=%d hex=%04X", x, 0xBEEF);
  LCDPutStr(buf, 20, 5, MEDIUM, WHITE, BLACK);
  debug_printf("%s\\n", buf);
  while(1) { __asm__("nop"); }
  return 0;
}`;
const r5 = compileWithLib(t5, 'sprintf + pętla nop');
if (r5) runFor(r5, 0.3, 'sprintf'); else fails++;

console.log(fails ? `\nNIEPOWODZENIA: ${fails}` : '\nTesty zgodności OK');
process.exit(fails ? 1 : 0);
