'use strict';
['cc_lex.js', 'cc_parse.js', 'cc_gen.js', 'runtime.js', 'periph.js', 'lcd.js', 'board.js',
  'headers.js', 'projfiles.js'].forEach(f => require('../js/' + f));
const CC = globalThis.CC;
const ex = CC.EXAMPLES.find(e => e.id === (process.argv[2] || 'szablon'));
const files = [{ name: 'main.c', text: ex.main }];
for (const [name, text] of Object.entries(CC.PROJ_LIB)) files.push({ name, text });
const { result, diags } = CC.compileProject(files, CC.systemHeaders());
console.log('result:', result ? 'OK' : 'NULL');
for (const d of diags) console.log(d.sev, d.file + ':' + d.line, d.msg);
if (result) {
  const b = new CC.Board();
  b.onConsole = (k, t, f, l) => console.log('(' + k + ')', t, f ? f + ':' + l : '');
  try {
    b.load(result);
    console.log('załadowano, status:', b.cpu.status);
    for (let i = 0; i < 1000 && b.cpu.status === 'running'; i++) b.cpu.slice(96000);
    console.log('po 1000 slice:', b.cpu.status, 'vcyc=', b.cycles(), 'fault=', b.cpu.faultMsg);
  } catch (e) {
    console.log('WYJĄTEK:', e.message);
    if (e.stack) console.log(e.stack.split('\n').slice(0, 6).join('\n'));
    // zapisz źródło do inspekcji
    require('fs').writeFileSync(__dirname + '/out/gen_src.js', result.source);
    console.log('źródło zapisane: tools/out/gen_src.js');
  }
}
