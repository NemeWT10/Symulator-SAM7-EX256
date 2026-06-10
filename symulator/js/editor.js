/* ============================================================
 * Symulator SAM7-EX256 — lekki edytor kodu C
 * editor.js — textarea + warstwa podświetlania + numeracja linii
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC || (g.CC = {});

  var KEYWORDS = new Set(('auto break case char const continue default do double else enum extern float for goto if ' +
    'inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while ' +
    '_Bool __asm__ __asm asm __attribute__ __inline __inline__').split(' '));
  var TYPEISH = new Set(('uint8_t uint16_t uint32_t int8_t int16_t int32_t size_t bool AT91_REG AT91PS_PIO AT91S_PIO ' +
    'AT91PS_PMC AT91PS_SPI AT91PS_TC AT91PS_AIC AT91PS_PITC menu_t LCD_BMP12').split(' '));

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // podświetlenie jednej linii; stan wejściowy: inComment (blokowy)
  function hlLine(line, state) {
    var out = [];
    var i = 0, n = line.length;
    if (/^\s*#/.test(line) && !state.inComment) {
      // dyrektywa preprocesora (z komentarzem na końcu?)
      var ci = line.indexOf('//');
      var bi = line.indexOf('/*');
      if (ci < 0 && bi < 0) return { html: '<span class="tk-pre">' + esc(line) + '</span>', state: state };
    }
    while (i < n) {
      var ch = line[i];
      if (state.inComment) {
        var end = line.indexOf('*/', i);
        if (end < 0) { out.push('<span class="tk-com">' + esc(line.slice(i)) + '</span>'); i = n; break; }
        out.push('<span class="tk-com">' + esc(line.slice(i, end + 2)) + '</span>');
        i = end + 2; state = { inComment: false };
        continue;
      }
      if (ch === '/' && line[i + 1] === '/') {
        out.push('<span class="tk-com">' + esc(line.slice(i)) + '</span>'); i = n; break;
      }
      if (ch === '/' && line[i + 1] === '*') {
        var e2 = line.indexOf('*/', i + 2);
        if (e2 < 0) { out.push('<span class="tk-com">' + esc(line.slice(i)) + '</span>'); i = n; state = { inComment: true }; break; }
        out.push('<span class="tk-com">' + esc(line.slice(i, e2 + 2)) + '</span>'); i = e2 + 2;
        continue;
      }
      if (ch === '"' || ch === '\'') {
        var q = ch, j = i + 1;
        while (j < n) {
          if (line[j] === '\\') { j += 2; continue; }
          if (line[j] === q) { j++; break; }
          j++;
        }
        out.push('<span class="tk-str">' + esc(line.slice(i, j)) + '</span>'); i = j;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[i + 1] || ''))) {
        var j2 = i + 1;
        while (j2 < n && /[0-9a-fA-FxX.uUlLeE+\-]/.test(line[j2])) {
          if ((line[j2] === '+' || line[j2] === '-') && !/[eE]/.test(line[j2 - 1])) break;
          j2++;
        }
        out.push('<span class="tk-num">' + esc(line.slice(i, j2)) + '</span>'); i = j2;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        var j3 = i + 1;
        while (j3 < n && /[A-Za-z0-9_$]/.test(line[j3])) j3++;
        var w = line.slice(i, j3);
        var cls = null;
        if (KEYWORDS.has(w)) cls = 'tk-kw';
        else if (TYPEISH.has(w)) cls = 'tk-type';
        else if (/^(PIO[AB]|PMC|SPI[01]|PIT|TC[012]|AIC|ADC|WDT|RSTC|RTT|US[01]|DBGU|TC|AT91C)_/.test(w) || /^BIT\d+$/.test(w)) cls = 'tk-reg';
        else if (/^[A-Z][A-Z0-9_]{2,}$/.test(w)) cls = 'tk-const';
        else {
          var k = j3; while (k < n && line[k] === ' ') k++;
          if (line[k] === '(') cls = 'tk-fn';
        }
        out.push(cls ? '<span class="' + cls + '">' + esc(w) + '</span>' : esc(w));
        i = j3;
        continue;
      }
      out.push(esc(ch)); i++;
    }
    return { html: out.join(''), state: state };
  }

  function Editor(host, opts) {
    var self = this;
    this.opts = opts || {};
    this.host = host;
    host.classList.add('ed-wrap');
    host.innerHTML =
      '<div class="ed-gutter"><div class="ed-gutter-in"></div></div>' +
      '<div class="ed-scroller">' +
      '  <div class="ed-hl" aria-hidden="true"></div>' +
      '  <textarea class="ed-ta" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea>' +
      '</div>';
    // przewijany (transform) jest element WEWNĘTRZNY, a przycina zewnętrzny —
    // inaczej overflow:hidden obcina numery spoza pierwszego ekranu
    this.gutter = host.querySelector('.ed-gutter-in');
    this.scroller = host.querySelector('.ed-scroller');
    this.hl = host.querySelector('.ed-hl');
    this.ta = host.querySelector('.ed-ta');
    this.errLines = new Set();
    this.curLine = 0;   // aktualnie wykonywana linia (praca krokowa)
    this.lineCache = [];   // {text, stateIn, html}
    this.lineDivs = [];

    this.ta.addEventListener('input', function () { self.onInput(); });
    this.ta.addEventListener('scroll', function () {
      self.hl.style.transform = 'translate(' + (-self.ta.scrollLeft) + 'px,' + (-self.ta.scrollTop) + 'px)';
      self.gutter.style.transform = 'translateY(' + (-self.ta.scrollTop) + 'px)';
    });
    this.ta.addEventListener('keydown', function (e) { self.onKey(e); });
  }
  CC.Editor = Editor;
  var E = Editor.prototype;

  E.setValue = function (text, readOnly) {
    this.ta.value = text;
    this.ta.readOnly = !!readOnly;
    this.errLines.clear();
    this.curLine = 0;
    this.fullRender();
    this.ta.scrollTop = 0;
    this.ta.scrollLeft = 0;
    this.hl.style.transform = 'translate(0,0)';
    this.gutter.style.transform = 'translateY(0)';
  };
  E.getValue = function () { return this.ta.value; };

  E.onInput = function () {
    this.fullRender();
    if (this.opts.onChange) this.opts.onChange();
  };

  E.fullRender = function () {
    var lines = this.ta.value.split('\n');
    var frag = [];
    var gut = [];
    var huge = lines.length > 4000; // bardzo duże pliki (bmp.h): bez kolorowania
    var state = { inComment: false };
    // ta sama arytmetyka, której używa textarea: top = padding + i × line-height
    var st = getComputedStyle(this.ta);
    var lh = parseFloat(st.lineHeight) || 19;
    var padTop = parseFloat(st.paddingTop) || 6;
    for (var i = 0; i < lines.length; i++) {
      var html;
      if (huge) {
        html = esc(lines[i]);
      } else {
        var r = hlLine(lines[i], state);
        state = r.state;
        html = r.html;
      }
      var top = ' style="top:' + (padTop + i * lh) + 'px"';
      var cls = this.errLines.has(i + 1) ? ' ed-line-err' : '';
      if (this.curLine === i + 1) cls += ' ed-line-cur';
      frag.push('<div class="ed-line' + cls + '"' + top + '>' + (html || '&nbsp;') + '</div>');
      var gcls = (this.errLines.has(i + 1) ? ' ed-ln-err' : '') +
        (this.curLine === i + 1 ? ' ed-ln-cur' : '');
      gut.push('<div class="ed-ln' + gcls + '"' + top + '>' + (i + 1) + '</div>');
    }
    this.hl.innerHTML = frag.join('');
    this.gutter.innerHTML = gut.join('');
  };

  E.setErrors = function (lineNums) {
    this.errLines = new Set(lineNums || []);
    this.fullRender();
  };

  E.gotoLine = function (line) {
    var lines = this.ta.value.split('\n');
    var pos = 0;
    for (var i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
    // przewiń
    var lh = this.lineHeight();
    this.ta.scrollTop = Math.max(0, (line - 6) * lh);
    this.ta.dispatchEvent(new Event('scroll'));
  };

  E.lineHeight = function () {
    var s = getComputedStyle(this.ta);
    return parseFloat(s.lineHeight) || 18;
  };

  // podświetlenie aktualnie wykonywanej linii (null = wyłącz)
  E.setCurrentLine = function (line) {
    var old = this.curLine;
    this.curLine = line || 0;
    if (old === this.curLine) return;
    function tog(parent, idx, cls, on) {
      var el = parent.children[idx - 1];
      if (el) el.classList.toggle(cls, on);
    }
    if (old) { tog(this.hl, old, 'ed-line-cur', false); tog(this.gutter, old, 'ed-ln-cur', false); }
    if (this.curLine) {
      tog(this.hl, this.curLine, 'ed-line-cur', true);
      tog(this.gutter, this.curLine, 'ed-ln-cur', true);
    }
  };

  // przewiń tak, by linia była widoczna (bez zmiany fokusu/zaznaczenia)
  E.revealLine = function (line) {
    var lh = this.lineHeight();
    var top = (line - 1) * lh;
    var ta = this.ta;
    if (top < ta.scrollTop + lh || top > ta.scrollTop + ta.clientHeight - 2 * lh) {
      ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
      ta.dispatchEvent(new Event('scroll'));
    }
  };

  E.onKey = function (e) {
    var ta = this.ta;
    if (ta.readOnly) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      var s = ta.selectionStart, epos = ta.selectionEnd;
      if (s === epos && !e.shiftKey) {
        document.execCommand('insertText', false, '    ');
      } else {
        // wcięcie / cofnięcie wcięcia zaznaczonych linii
        var v = ta.value;
        var ls = v.lastIndexOf('\n', s - 1) + 1;
        var le = v.indexOf('\n', epos); if (le < 0) le = v.length;
        var block = v.slice(ls, le);
        var nl;
        if (e.shiftKey) nl = block.replace(/^ {1,4}/gm, '');
        else nl = block.replace(/^/gm, '    ');
        ta.setSelectionRange(ls, le);
        document.execCommand('insertText', false, nl);
        ta.setSelectionRange(ls, ls + nl.length);
      }
      this.onInput();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      var pos = ta.selectionStart;
      var v2 = ta.value;
      var ls2 = v2.lastIndexOf('\n', pos - 1) + 1;
      var line = v2.slice(ls2, pos);
      var indent = (line.match(/^\s*/) || [''])[0];
      if (/\{\s*$/.test(line)) indent += '    ';
      document.execCommand('insertText', false, '\n' + indent);
      this.onInput();
      return;
    }
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
