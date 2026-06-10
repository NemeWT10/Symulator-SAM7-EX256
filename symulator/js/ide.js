/* ============================================================
 * Symulator SAM7-EX256 — logika IDE
 * ide.js — projekt (localStorage), drzewo plików, taby, konsola,
 * panel płytki, pętla czasu, kompilacja i uruchamianie
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC;
  var LS_KEY = 'sam7sim_project_v1';

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- stan ---------------- */
  var project = null;          // {name, files: {fname: text}}
  var openTabs = [];           // [fname]
  var activeFile = null;
  var tabState = {};           // fname -> {scrollTop, selStart}
  var errByFile = {};          // fname -> [lineNums]
  var board = new CC.Board();
  var editor = null;
  var compiledOk = false;
  var audio = { ctx: null, osc: null, gain: null };
  var conPartial = { out: null, uart: null }; // niedokończone linie

  /* ---------------- projekt ---------------- */
  function defaultProject(exId) {
    var ex = CC.EXAMPLES.find(function (e) { return e.id === (exId || CC.DEFAULT_EXAMPLE); }) || CC.EXAMPLES[0];
    var files = { 'main.c': ex.main };
    Object.keys(CC.PROJ_LIB).forEach(function (n) { files[n] = CC.PROJ_LIB[n]; });
    return { name: ex.title, files: files };
  }

  function saveProject() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(project));
      updateProjInfo();
    } catch (e) {
      conLine('warn', 'Nie udało się zapisać projektu w przeglądarce: ' + e.message);
    }
  }
  var saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProject, 500);
  }

  function loadProject() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.files && Object.keys(p.files).length) return p;
      }
    } catch (e) { }
    return defaultProject();
  }

  function updateProjInfo() {
    var n = Object.keys(project.files).length;
    var sz = 0;
    Object.values(project.files).forEach(function (t) { sz += t.length; });
    $('projInfo').textContent = project.name + ' — plików: ' + n + ', ' + (sz / 1024).toFixed(0) + ' KB (autozapis)';
  }

  /* ---------------- drzewo plików ---------------- */
  function fileOrder(a, b) {
    function rank(f) {
      if (f === 'main.c') return 0;
      if (/\.c$/i.test(f)) return 1;
      if (/lcd\.h$/i.test(f)) return 2;
      if (/\.h$/i.test(f)) return 3;
      return 4;
    }
    return rank(a) - rank(b) || a.localeCompare(b);
  }

  function renderTree() {
    var ul = $('fileTree');
    ul.innerHTML = '';
    Object.keys(project.files).sort(fileOrder).forEach(function (fname) {
      var li = document.createElement('li');
      if (fname === activeFile) li.classList.add('active');
      var isC = /\.c$/i.test(fname);
      li.innerHTML = '<span class="fi-ico ' + (isC ? 'fi-c' : 'fi-h') + '">' + (isC ? 'C' : 'H') + '</span>' +
        '<span class="fi-name"></span>' +
        '<span class="fi-act fi-ren" title="Zmień nazwę">✎</span>' +
        '<span class="fi-act fi-del" title="Usuń plik">🗑</span>';
      li.querySelector('.fi-name').textContent = fname;
      li.addEventListener('click', function (e) {
        if (e.target.classList.contains('fi-del')) { delFile(fname); return; }
        if (e.target.classList.contains('fi-ren')) { renameFile(fname); return; }
        openFile(fname);
      });
      ul.appendChild(li);
    });
  }

  function delFile(fname) {
    if (!confirm('Usunąć plik ' + fname + ' z projektu?')) return;
    delete project.files[fname];
    closeTab(fname);
    renderTree(); saveSoon();
  }
  function renameFile(fname) {
    var nn = prompt('Nowa nazwa pliku:', fname);
    if (!nn || nn === fname) return;
    if (project.files[nn] !== undefined) { alert('Plik o tej nazwie już istnieje.'); return; }
    project.files[nn] = project.files[fname];
    delete project.files[fname];
    var ti = openTabs.indexOf(fname);
    if (ti >= 0) openTabs[ti] = nn;
    if (activeFile === fname) activeFile = nn;
    renderTree(); renderTabs(); saveSoon();
  }
  function newFile() {
    var nn = prompt('Nazwa nowego pliku (np. moje.c lub moje.h):', 'nowy.c');
    if (!nn) return;
    if (project.files[nn] !== undefined) { alert('Plik o tej nazwie już istnieje.'); return; }
    project.files[nn] = '/* ' + nn + ' */\n';
    renderTree(); saveSoon();
    openFile(nn);
  }

  /* ---------------- taby + edytor ---------------- */
  function openFile(fname) {
    if (project.files[fname] === undefined) return;
    if (openTabs.indexOf(fname) < 0) openTabs.push(fname);
    switchTo(fname);
    renderTree();
  }
  function switchTo(fname) {
    if (activeFile === fname) { renderTabs(); return; }
    persistEdState();
    activeFile = fname;
    editor.setValue(project.files[fname]);
    editor.setErrors(errByFile[fname] || []);
    var st = tabState[fname];
    if (st) {
      editor.ta.scrollTop = st.scrollTop || 0;
      editor.ta.dispatchEvent(new Event('scroll'));
    }
    renderTabs();
    renderTree();
  }
  function persistEdState() {
    if (activeFile && editor) {
      tabState[activeFile] = { scrollTop: editor.ta.scrollTop };
    }
  }
  function closeTab(fname) {
    var i = openTabs.indexOf(fname);
    if (i < 0) return;
    openTabs.splice(i, 1);
    if (activeFile === fname) {
      activeFile = null;
      var next = openTabs[Math.max(0, i - 1)];
      if (next) switchTo(next);
      else { editor.setValue(''); renderTabs(); }
    } else renderTabs();
  }
  function renderTabs() {
    var bar = $('tabs');
    bar.innerHTML = '';
    openTabs.forEach(function (fname) {
      var t = document.createElement('div');
      t.className = 'tab' + (fname === activeFile ? ' active' : '');
      var nm = document.createElement('span');
      nm.textContent = fname;
      var x = document.createElement('span');
      x.className = 'tab-x'; x.textContent = '✕'; x.title = 'Zamknij kartę';
      t.appendChild(nm); t.appendChild(x);
      t.addEventListener('click', function (e) {
        if (e.target === x) { closeTab(fname); return; }
        switchTo(fname);
      });
      bar.appendChild(t);
    });
  }

  /* ---------------- konsola ---------------- */
  function conLine(kind, text, file, line) {
    var out = $('consoleOut');
    // częściowe linie dla wyjścia programu
    if (kind === 'out' || kind === 'uart') {
      var parts = String(text).split('\n');
      for (var i = 0; i < parts.length; i++) {
        var isLast = i === parts.length - 1;
        var seg = parts[i];
        var el = conPartial[kind];
        if (!el) {
          el = document.createElement('div');
          el.className = 'con-line con-' + kind;
          el.textContent = (kind === 'uart' ? 'UART⟶ ' : '');
          out.appendChild(el);
          conPartial[kind] = el;
        }
        el.textContent += seg;
        if (!isLast) conPartial[kind] = null;
        else if (seg === '' && parts.length > 1) conPartial[kind] = null;
      }
      trimCon(out);
      out.scrollTop = out.scrollHeight;
      return;
    }
    conPartial.out = null; conPartial.uart = null;
    var div = document.createElement('div');
    div.className = 'con-line con-' + kind;
    var prefix = { error: '✖ ', warn: '⚠ ', info: 'ℹ ', sys: '' }[kind] || '';
    div.textContent = prefix + text + (file ? '   [' + file + (line ? ':' + line : '') + ']' : '');
    if (kind === 'error' && file && !file.startsWith('<')) {
      div.addEventListener('click', function () {
        if (project.files[file] !== undefined) {
          openFile(file);
          if (line) editor.gotoLine(line);
        }
      });
    }
    out.appendChild(div);
    trimCon(out);
    out.scrollTop = out.scrollHeight;
  }
  function trimCon(out) {
    while (out.children.length > 600) out.removeChild(out.firstChild);
  }

  /* ---------------- kompilacja / uruchamianie ---------------- */
  function collectFiles() {
    persistCurrentEdit();
    return Object.keys(project.files).map(function (n) {
      return { name: n, text: project.files[n] };
    });
  }
  function persistCurrentEdit() {
    if (activeFile && editor) project.files[activeFile] = editor.getValue();
  }

  function doRun() {
    persistCurrentEdit();
    saveProject();
    $('consoleOut').innerHTML = '';
    conPartial.out = conPartial.uart = null;
    conLine('sys', 'Kompilowanie projektu…');
    errByFile = {};
    var t0 = performance.now();
    var res = CC.compileProject(collectFiles(), CC.systemHeaders());
    var errs = 0, warns = 0;
    res.diags.forEach(function (d) {
      if (d.sev === 'error') {
        errs++;
        conLine('error', d.msg, d.file, d.line);
        if (!d.file.startsWith('<')) {
          (errByFile[d.file] = errByFile[d.file] || []).push(d.line);
        }
      } else {
        warns++;
        if (warns <= 20) conLine('warn', d.msg + '   [' + d.file + ':' + d.line + ']');
      }
    });
    editor.setErrors(errByFile[activeFile] || []);
    if (errs || !res.result) {
      conLine('sys', 'Kompilacja nieudana: błędów ' + errs + (warns ? ', ostrzeżeń ' + warns : '') + '. Kliknij błąd, aby przejść do linii.');
      compiledOk = false;
      return;
    }
    var ms = Math.round(performance.now() - t0);
    conLine('sys', 'Kompilacja OK (' + ms + ' ms' + (warns ? ', ostrzeżeń: ' + warns : '') + '). Uruchamiam…');
    board.load(res.result);
    compiledOk = true;
    ensureAudio();
    updateStatus();
  }

  function doReset() {
    if (!compiledOk) { conLine('warn', 'Najpierw uruchom program (▶).'); return; }
    board.resetHard();
    conLine('sys', 'Reset płytki — program od początku.');
    updateStatus();
  }
  function doStop() {
    if (board.cpu && board.cpu.status === 'running') {
      board.cpu.status = 'stopped';
      conLine('sys', 'Zatrzymano wykonywanie.');
      updateStatus();
    }
  }

  /* ---------------- panel płytki ---------------- */
  var lcdCtx, lcdImg, lcdRgba;
  function initLcdCanvas() {
    var cv = $('lcd');
    lcdCtx = cv.getContext('2d');
    lcdImg = lcdCtx.createImageData(132, 132);
    lcdRgba = lcdImg.data;
  }
  var lastBL = null;
  function repaintLcd(force) {
    var bl = board.backlightOn();
    if (!force && !board.lcd.dirty && bl === lastBL) return;
    lastBL = bl;
    board.lcd.render(lcdRgba, bl ? 1 : 0);
    lcdCtx.putImageData(lcdImg, 0, 0);
  }

  function bindInputBtn(el) {
    var key = el.dataset.key;
    function down(e) { e.preventDefault(); el.classList.add('pressed'); board.setInput(key, true); }
    function up(e) { el.classList.remove('pressed'); board.setInput(key, false); }
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  var KEYMAP = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Enter: 'ENTER', '1': 'SW1', '2': 'SW2' };
  function isEditableTarget(e) {
    var t = e.target;
    return t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  function bindKeyboard() {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'F5') { e.preventDefault(); doRun(); return; }
      if (e.key === 'F6') { e.preventDefault(); doReset(); return; }
      if (isEditableTarget(e)) return;
      var k = KEYMAP[e.key];
      if (k) {
        e.preventDefault();
        if (!e.repeat) {
          board.setInput(k, true);
          markBtn(k, true);
        }
      }
    });
    document.addEventListener('keyup', function (e) {
      var k = KEYMAP[e.key];
      if (k) { board.setInput(k, false); markBtn(k, false); }
    });
    window.addEventListener('blur', function () {
      Object.keys(board.inputs).forEach(function (k) { board.setInput(k, false); markBtn(k, false); });
    });
  }
  function markBtn(key, on) {
    var el = document.querySelector('[data-key="' + key + '"]');
    if (el) el.classList.toggle('pressed', on);
  }

  /* ---------------- dźwięk buzzera ---------------- */
  function ensureAudio() {
    if (audio.ctx || !(g.AudioContext || g.webkitAudioContext)) return;
    try {
      var Ctx = g.AudioContext || g.webkitAudioContext;
      audio.ctx = new Ctx();
      audio.osc = audio.ctx.createOscillator();
      audio.osc.type = 'square';
      audio.gain = audio.ctx.createGain();
      audio.gain.gain.value = 0;
      audio.osc.connect(audio.gain);
      audio.gain.connect(audio.ctx.destination);
      audio.osc.start();
    } catch (e) { audio.ctx = null; }
  }
  function updateBuzzer() {
    var st = board.buzzerState();
    $('buzzIcon').classList.toggle('on', st.active);
    $('buzzIcon').textContent = st.active ? '🔊' : '🔈';
    if (audio.ctx) {
      var muted = $('chkMute').checked;
      var want = (st.active && !muted && board.running()) ? 0.045 : 0;
      audio.gain.gain.setTargetAtTime(want, audio.ctx.currentTime, 0.02);
      if (st.active && st.freq > 20) {
        var f = Math.min(Math.max(st.freq, 40), 9000);
        audio.osc.frequency.setTargetAtTime(f, audio.ctx.currentTime, 0.03);
      }
    }
  }

  /* ---------------- status ---------------- */
  function updateStatus() {
    var el = $('stState');
    var st = board.cpu ? board.cpu.status : 'idle';
    var map = {
      idle: ['—', 'st-idle'],
      running: ['DZIAŁA', 'st-running'],
      done: ['ZAKOŃCZONY', 'st-done'],
      fault: ['BŁĄD', 'st-fault'],
      stopped: ['ZATRZYMANY', 'st-idle']
    };
    var m = map[st] || map.idle;
    el.textContent = m[0];
    el.className = m[1];
    $('ledPwr').classList.toggle('on', !!board.cpu);
    $('ledBl').classList.toggle('on', board.backlightOn());
  }

  /* ---------------- pętla główna ----------------
   * setInterval zamiast czystego rAF — działa też, gdy karta
   * jest w tle (rAF bywa wstrzymywany). rAF służy do płynnego
   * odmalowywania, gdy jest dostępny. */
  var lastT = 0, statT = 0;
  function pump() {
    var t = performance.now();
    var dt = lastT ? Math.min(t - lastT, 100) : 16;
    lastT = t;
    if (board.cpu && board.cpu.status === 'running') {
      board.tick(dt, 9);
    }
    repaintLcd(false);
    if (t - statT > 150) {
      statT = t;
      $('stTime').textContent = 't = ' + board.timeSec().toFixed(2) + ' s';
      updateStatus();
      updateBuzzer();
    }
  }
  function startLoop() {
    setInterval(pump, 16);
    (function raf() {
      repaintLcd(false);
      requestAnimationFrame(raf);
    })();
  }

  /* ---------------- zrzut ekranu LCD ---------------- */
  function shotLcd() {
    // świeży render w skali 3× (396×396) — czytelny w sprawozdaniu
    var S = 3;
    var src = document.createElement('canvas');
    src.width = 132; src.height = 132;
    var sctx = src.getContext('2d');
    var img = sctx.createImageData(132, 132);
    board.lcd.render(img.data, board.backlightOn() ? 1 : 0);
    board.lcd.dirty = true; // niech główny canvas też się odświeży
    sctx.putImageData(img, 0, 0);
    var big = document.createElement('canvas');
    big.width = 132 * S; big.height = 132 * S;
    var bctx = big.getContext('2d');
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(src, 0, 0, big.width, big.height);
    big.toBlob(function (blob) {
      if (!blob) return;
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lcd_' + board.timeSec().toFixed(2).replace('.', '_') + 's.png';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      conLine('sys', 'Zapisano zrzut LCD: ' + a.download);
    }, 'image/png');
  }

  /* ---------------- import / eksport ---------------- */
  function importFiles() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = '.c,.h,.txt';
    inp.addEventListener('change', function () {
      var files = Array.from(inp.files || []);
      var done = 0;
      files.forEach(function (f) {
        var rd = new FileReader();
        rd.onload = function () {
          var buf = new Uint8Array(rd.result);
          var text;
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
          } catch (e) {
            text = new TextDecoder('windows-1250').decode(buf);
          }
          text = text.replace(/\r\n/g, '\n');
          if (project.files[f.name] !== undefined &&
            !confirm('Plik ' + f.name + ' już istnieje. Nadpisać?')) return finish();
          project.files[f.name] = text;
          finish();
        };
        rd.readAsArrayBuffer(f);
      });
      function finish() {
        if (++done >= files.length) {
          renderTree(); saveSoon();
          conLine('sys', 'Zaimportowano pliki: ' + files.map(function (f) { return f.name; }).join(', '));
        }
      }
    });
    inp.click();
  }

  // ZIP bez kompresji (metoda store)
  function crc32(u8) {
    var tbl = crc32.t;
    if (!tbl) {
      tbl = crc32.t = new Int32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        tbl[n] = c;
      }
    }
    var c2 = ~0;
    for (var i = 0; i < u8.length; i++) c2 = tbl[(c2 ^ u8[i]) & 0xFF] ^ (c2 >>> 8);
    return ~c2 >>> 0;
  }
  function zipStore(files) {
    // files: [{name, text}]
    var enc = new TextEncoder();
    var chunks = [], central = [], offset = 0;
    function w16(v) { return new Uint8Array([v & 255, (v >> 8) & 255]); }
    function w32(v) { return new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]); }
    files.forEach(function (f) {
      var nameB = enc.encode(f.name);
      var data = enc.encode(f.text);
      var crc = crc32(data);
      var hdr = [
        w32(0x04034b50), w16(20), w16(0x0800 /*UTF-8*/), w16(0), w16(0), w16(0),
        w32(crc), w32(data.length), w32(data.length), w16(nameB.length), w16(0)
      ];
      var lo = offset;
      hdr.forEach(function (h) { chunks.push(h); offset += h.length; });
      chunks.push(nameB); offset += nameB.length;
      chunks.push(data); offset += data.length;
      central.push({ nameB: nameB, crc: crc, size: data.length, off: lo });
    });
    var cdStart = offset;
    central.forEach(function (c) {
      [w32(0x02014b50), w16(20), w16(20), w16(0x0800), w16(0), w16(0), w16(0),
      w32(c.crc), w32(c.size), w32(c.size), w16(c.nameB.length), w16(0), w16(0),
      w16(0), w16(0), w32(0), w32(c.off)
      ].forEach(function (h) { chunks.push(h); offset += h.length; });
      chunks.push(c.nameB); offset += c.nameB.length;
    });
    [w32(0x06054b50), w16(0), w16(0), w16(central.length), w16(central.length),
    w32(offset - cdStart), w32(cdStart), w16(0)
    ].forEach(function (h) { chunks.push(h); offset += h.length; });
    return new Blob(chunks, { type: 'application/zip' });
  }

  function exportZip() {
    persistCurrentEdit();
    var files = Object.keys(project.files).sort(fileOrder).map(function (n) {
      return { name: n, text: project.files[n] };
    });
    var blob = zipStore(files);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (project.name || 'projekt').replace(/[^\w\dąćęłńóśźż \-]/gi, '').trim().replace(/\s+/g, '_') + '.zip';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    conLine('sys', 'Wyeksportowano projekt do ZIP.');
  }

  /* ---------------- przykłady / nowy projekt ---------------- */
  function fillExamples() {
    var sel = $('selExample');
    CC.EXAMPLES.forEach(function (ex) {
      var o = document.createElement('option');
      o.value = ex.id;
      o.textContent = ex.title;
      o.title = ex.desc;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () {
      var id = sel.value;
      sel.value = '';
      if (!id) return;
      var ex = CC.EXAMPLES.find(function (e) { return e.id === id; });
      if (!ex) return;
      if (!confirm('Wczytać przykład „' + ex.title + '”?\n\nZastąpi on bieżący projekt (main.c i pliki biblioteki). ' +
        'Jeśli chcesz zachować swój kod — najpierw Eksport ZIP.')) return;
      project = defaultProject(id);
      afterProjectSwap();
      conLine('sys', 'Wczytano przykład: ' + ex.title + ' — naciśnij ▶ Uruchom.');
      conLine('warn', 'Przykłady są poglądowe — pokazują techniki z instrukcji, ale NIE są kompletnymi rozwiązaniami zadań zaliczeniowych.');
    });
  }

  function newProject() {
    if (!confirm('Utworzyć nowy projekt (szablon)? Bieżący projekt zostanie zastąpiony.')) return;
    project = defaultProject('szablon');
    project.name = 'Mój projekt';
    afterProjectSwap();
  }

  function afterProjectSwap() {
    openTabs = [];
    activeFile = null;
    errByFile = {};
    tabState = {};
    saveProject();
    renderTree();
    renderTabs();
    openFile('main.c');
    compiledOk = false;
    if (board.cpu) { board.cpu.status = 'stopped'; }
    updateStatus();
  }

  /* ---------------- start ---------------- */
  function init() {
    editor = new CC.Editor($('editorHost'), { onChange: function () { persistCurrentEdit(); saveSoon(); } });
    project = loadProject();
    initLcdCanvas();
    fillExamples();
    renderTree();
    openFile(project.files['main.c'] !== undefined ? 'main.c' : Object.keys(project.files)[0]);
    updateProjInfo();

    board.onConsole = function (kind, text, file, line) { conLine(kind, text, file, line); };
    board.onStateChange = updateStatus;

    $('btnRun').addEventListener('click', doRun);
    $('btnReset').addEventListener('click', doReset);
    $('btnStop').addEventListener('click', doStop);
    $('btnNewFile').addEventListener('click', newFile);
    $('btnNewProj').addEventListener('click', newProject);
    $('btnImport').addEventListener('click', importFiles);
    $('btnExport').addEventListener('click', exportZip);
    $('btnClearCon').addEventListener('click', function () {
      $('consoleOut').innerHTML = '';
      conPartial.out = conPartial.uart = null;
    });
    $('selSpeed').addEventListener('change', function () {
      board.speed = parseFloat(this.value) || 1;
    });
    $('trimPot').addEventListener('input', function () {
      board.trim = this.value | 0;
      $('trimVal').textContent = this.value;
    });
    $('swRst').addEventListener('click', doReset);
    $('btnShot').addEventListener('click', shotLcd);
    $('btnHelp').addEventListener('click', function () { $('helpModal').classList.remove('hidden'); });
    $('btnCloseHelp').addEventListener('click', function () { $('helpModal').classList.add('hidden'); });
    $('helpModal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });

    document.querySelectorAll('[data-key]').forEach(bindInputBtn);
    bindKeyboard();

    conLine('sys', 'Symulator SAM7-EX256 gotowy. Wybierz przykład albo pisz kod i naciśnij ▶ Uruchom (F5).');
    repaintLcd(true);
    updateStatus();
    startLoop();
  }

  // diagnostyka (konsola przeglądarki / testy)
  g.SAM7 = {
    board: board,
    run: function () { doRun(); },
    press: function (k, on) { board.setInput(k, on); },
    state: function () {
      return {
        status: board.cpu ? board.cpu.status : 'idle',
        t: board.timeSec(),
        inputs: JSON.parse(JSON.stringify(board.inputs)),
        pdsrA: (board.pioA.pdsr() >>> 0).toString(16),
        pdsrB: (board.pioB.pdsr() >>> 0).toString(16),
        pcsr: (board.pmc.pcsr >>> 0).toString(16),
        bl: board.backlightOn()
      };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else init();

})(typeof globalThis !== 'undefined' ? globalThis : this);
