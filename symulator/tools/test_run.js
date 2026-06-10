/* Harness testowy: kompiluje przykłady i uruchamia je na modelu płytki.
 * Użycie: node tools/test_run.js [id_przykladu ...]
 * Zrzuty LCD → tools/out/<id>_<t>.png  */
'use strict';
const fs = require('fs');
const path = require('path');
const { encodePNG } = require('./png.js');

// załaduj moduły symulatora (współdzielony globalThis.CC)
['cc_lex.js', 'cc_parse.js', 'cc_gen.js', 'runtime.js', 'periph.js', 'lcd.js', 'board.js',
  'headers.js', 'projfiles.js'].forEach(f => require('../js/' + f));
const CC = globalThis.CC;

const OUTDIR = path.join(__dirname, 'out');
fs.mkdirSync(OUTDIR, { recursive: true });

function projectFiles(mainText) {
  const files = [{ name: 'main.c', text: mainText }];
  for (const [name, text] of Object.entries(CC.PROJ_LIB)) files.push({ name, text });
  return files;
}

function compileExample(ex) {
  const t0 = Date.now();
  const { result, diags } = CC.compileProject(projectFiles(ex.main), CC.systemHeaders());
  const dt = Date.now() - t0;
  const errs = diags.filter(d => d.sev === 'error');
  const warns = diags.filter(d => d.sev === 'warning');
  console.log(`[${ex.id}] kompilacja: ${dt} ms, błędy: ${errs.length}, ostrzeżenia: ${warns.length}`);
  for (const d of errs.slice(0, 15)) console.log(`   BŁĄD ${d.file}:${d.line}: ${d.msg}`);
  if (process.env.SHOWWARN) for (const d of warns.slice(0, 15)) console.log(`   uwaga ${d.file}:${d.line}: ${d.msg}`);
  return errs.length ? null : result;
}

function makeBoard(compiled) {
  const b = new CC.Board();
  b.onConsole = (kind, text, file, line) => {
    const loc = file ? ` [${file}:${line}]` : '';
    console.log(`   (${kind}) ${String(text).trim()}${loc}`);
  };
  b.load(compiled);
  return b;
}

// przewiń czas wirtualny o `sec` sekund (bez pacingu realnego)
function runVirtual(b, sec) {
  const target = b.cycles() + sec * b.MCK;
  const wallLimit = Date.now() + 60000;
  while (b.cycles() < target) {
    if (!b.cpu || b.cpu.status !== 'running') break;
    b.cpu.slice(96000);
    if (b.pendingReset) { b.resetHard(); }
    if (Date.now() > wallLimit) { console.log('   !! przekroczono limit czasu rzeczywistego'); break; }
  }
}

function snap(b, name) {
  const rgba = new Uint8ClampedArray(132 * 132 * 4);
  b.lcd.render(rgba, b.backlightOn() ? 1 : 0);
  // skala 2x
  const S = 2, W = 132 * S, H = 132 * S;
  const big = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const so = (((y / S) | 0) * 132 + ((x / S) | 0)) * 4, to = (y * W + x) * 4;
      big[to] = rgba[so]; big[to + 1] = rgba[so + 1]; big[to + 2] = rgba[so + 2]; big[to + 3] = 255;
    }
  fs.writeFileSync(path.join(OUTDIR, name + '.png'), encodePNG(big, W, H));
  console.log(`   zrzut: tools/out/${name}.png  (t=${b.timeSec().toFixed(2)}s, status=${b.cpu.status}, BL=${b.backlightOn() ? 'ON' : 'off'})`);
}

function press(b, key, sec) {
  b.setInput(key, true);
  runVirtual(b, sec || 0.08);
  b.setInput(key, false);
  runVirtual(b, 0.15);
}

const SCEN = {
  szablon(b) {
    runVirtual(b, 0.4); snap(b, 'szablon_start');
    press(b, 'SW1'); snap(b, 'szablon_sw1');
    press(b, 'SW2'); snap(b, 'szablon_sw2');
  },
  lab6(b) {
    runVirtual(b, 0.2);
    console.log('   BL przed:', b.backlightOn());
    b.setInput('SW1', true); runVirtual(b, 0.3); b.setInput('SW1', false);
    console.log('   BL po SW1:', b.backlightOn(), 'buzzer toggles:', b.buzzToggles.length);
    runVirtual(b, 0.2);
    b.setInput('SW2', true); runVirtual(b, 0.4); b.setInput('SW2', false);
    console.log('   BL po SW2:', b.backlightOn(), 'buzzer toggles:', b.buzzToggles.length);
    snap(b, 'lab6');
  },
  lab8(b) {
    runVirtual(b, 0.4); snap(b, 'lab8_start');
    b.setInput('UP', true); runVirtual(b, 0.2); snap(b, 'lab8_up');
    b.setInput('UP', false); b.setInput('LEFT', true); b.setInput('SW2', true);
    runVirtual(b, 0.2); snap(b, 'lab8_left_sw2');
    b.setInput('LEFT', false); b.setInput('SW2', false);
    runVirtual(b, 0.2); snap(b, 'lab8_released');
  },
  lab9(b) {
    runVirtual(b, 0.3); snap(b, 'lab9_dane');
    runVirtual(b, 2.2); snap(b, 'lab9_zaslon');
    runVirtual(b, 1.6); snap(b, 'lab9_prostokaty');
    runVirtual(b, 2.5); snap(b, 'lab9_choinka');
    runVirtual(b, 1.0); snap(b, 'lab9_mikolaj');
    runVirtual(b, 1.0); snap(b, 'lab9_bmp132');
  },
  lab10(b) {
    runVirtual(b, 0.6); snap(b, 'lab10_menu');
    press(b, 'DOWN'); snap(b, 'lab10_down');
    press(b, 'SW2'); snap(b, 'lab10_submenu');
    press(b, 'SW1'); snap(b, 'lab10_program');
    press(b, 'SW1'); snap(b, 'lab10_powrot');
  },
  lab11(b) {
    let last = b.backlightOn(), changes = [];
    const t0 = b.timeSec();
    const limit = Date.now() + 60000;
    while (b.timeSec() - t0 < 5.5 && changes.length < 6 && Date.now() < limit) {
      runVirtual(b, 0.05);
      const cur = b.backlightOn();
      if (cur !== last) { changes.push(b.timeSec().toFixed(3)); last = cur; }
      if (b.cpu.status !== 'running') break;
    }
    console.log('   zmiany BL w chwilach [s]:', changes.join(', '), '(oczekiwane co ~1s)');
    snap(b, 'lab11');
  }
};

const ids = process.argv.slice(2);
const list = CC.EXAMPLES.filter(e => !ids.length || ids.includes(e.id));
let failed = 0;
for (const ex of list) {
  const compiled = compileExample(ex);
  if (!compiled) { failed++; continue; }
  const b = makeBoard(compiled);
  try {
    (SCEN[ex.id] || ((bb) => { runVirtual(bb, 1); snap(bb, ex.id); }))(b);
    if (b.cpu.status === 'fault') failed++;
  } catch (e) {
    failed++;
    console.log('   !! wyjątek scenariusza:', e.message, e.stack);
  }
}
console.log(failed ? `\nNIEPOWODZENIA: ${failed}` : '\nWszystkie scenariusze OK');
process.exit(failed ? 1 : 0);
