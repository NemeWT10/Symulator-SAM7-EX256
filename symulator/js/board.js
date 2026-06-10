/* ============================================================
 * Symulator SAM7-EX256 — model płytki Olimex
 * board.js — spina CPU, peryferia, LCD, wejścia użytkownika
 *
 * Mapowanie wejść (zgodnie z instrukcją laboratorium):
 *   SW1  = PB24,  SW2 = PB25  (wciśnięty → 0)
 *   JOY_UP=PA9, JOY_DOWN=PA8, JOY_LEFT=PA7, JOY_RIGHT=PA14, JOY_ENTER=PA15
 *   LCD_BACKLIGHT = PB20,  BUZZER (AUDIO_OUT) = PB19
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC || (g.CC = {});

  var SLICE = 96000; // 2 ms wirtualne przy 48 MHz

  function Board() {
    var self = this;
    this.MCK = 48000000;
    this.inputs = { SW1: false, SW2: false, UP: false, DOWN: false, LEFT: false, RIGHT: false, ENTER: false };
    this.trim = 512; // potencjometr 0..1023
    this.rt = new CC.Runtime();
    this.pmc = new CC.Pmc(this);
    this.pioA = new CC.Pio(this, 'A', CC.PID.PIOA);
    this.pioB = new CC.Pio(this, 'B', CC.PID.PIOB);
    this.spi0 = new CC.Spi(this, 0);
    this.spi1 = new CC.Spi(this, 1);
    this.pit = new CC.Pit(this);
    this.tc = [new CC.TcChan(this, 0), new CC.TcChan(this, 1), new CC.TcChan(this, 2)];
    this.aic = new CC.Aic(this);
    this.adc = new CC.Adc(this);
    this.bus = new CC.Bus(this);
    this.lcd = new CC.Pcf8833();
    this.lcd.onWarn = function (s) { self.warn(s); };
    this.rt.mmio = this.bus;
    this.cpu = null;

    this.backlog = 0;
    this.speed = 1;
    this.pendingReset = false;
    this.paused = false;

    // buzzer: znaczniki czasowe przełączeń PB19
    this.buzzToggles = [];
    this.lastBuzzLevel = 0;
    this.lastResetLevel = 1; // PA2 (reset LCD)

    // zdarzenia dla UI
    this.onConsole = function (kind, text, file, line) { };
    this.onStateChange = function () { };

    this.rt.onConsole = function (s) { self.onConsole('out', s); };
  }
  CC.Board = Board;
  var B = Board.prototype;

  B.cycles = function () {
    return this.cpu ? this.cpu.vcycles() : 0;
  };
  B.timeSec = function () { return this.cycles() / this.MCK; };

  B.warn = function (msg) {
    this.onConsole('warn', msg);
  };

  /* ---------- wejścia ---------- */
  var INPUT_MAP = {
    SW1: { port: 'B', bit: 24 }, SW2: { port: 'B', bit: 25 },
    UP: { port: 'A', bit: 9 }, DOWN: { port: 'A', bit: 8 },
    LEFT: { port: 'A', bit: 7 }, RIGHT: { port: 'A', bit: 14 },
    ENTER: { port: 'A', bit: 15 }
  };
  CC.INPUT_MAP = INPUT_MAP;

  B.setInput = function (name, down) {
    if (!(name in this.inputs)) return;
    if (this.inputs[name] === !!down) return;
    this.inputs[name] = !!down;
    var m = INPUT_MAP[name];
    var pio = m.port === 'A' ? this.pioA : this.pioB;
    pio.extChanged(m.bit);
  };

  // poziom zewnętrzny pinu skonfigurowanego jako wejście
  B.extLevel = function (port, i) {
    for (var k in INPUT_MAP) {
      var m = INPUT_MAP[k];
      if (m.port === port && m.bit === i) {
        return this.inputs[k] ? 0 : 1; // wciśnięty zwiera do masy
      }
    }
    return 1; // pull-up / niepodłączone
  };

  B.adcValue = function (ch) {
    return this.trim & 0x3FF;
  };

  /* ---------- skutki zmian wyjść PIO ---------- */
  B.effOut = function (pio, bit) {
    // poziom faktycznie wystawiany przez pin skonfigurowany jako wyjście PIO
    var b = (1 << bit);
    if ((pio.psr & pio.osr & b) === 0) return -1; // nie jest wyjściem
    return (pio.odsr & b) ? 1 : 0;
  };

  B.onPioOutput = function (port, mask) {
    if (port === 'B') {
      // buzzer PB19
      if (mask & (1 << 19)) {
        var lv = this.effOut(this.pioB, 19);
        var cur = lv === 1 ? 1 : 0;
        if (cur !== this.lastBuzzLevel) {
          this.lastBuzzLevel = cur;
          this.buzzToggles.push(this.cycles());
          if (this.buzzToggles.length > 128) this.buzzToggles.splice(0, 64);
        }
      }
    }
    if (port === 'A') {
      // reset LCD na PA2 (aktywny niski)
      if (mask & (1 << 2)) {
        var rl = this.effOut(this.pioA, 2);
        var lvl = rl === 0 ? 0 : 1;
        if (lvl === 0 && this.lastResetLevel === 1) {
          this.lcd.hardReset();
        }
        this.lastResetLevel = lvl;
      }
    }
  };

  B.onPmcChange = function (oldPcsr, newPcsr) {
    // włączenie zegara PIO → odśwież zatrzask PDSR
    var a = (1 << CC.PID.PIOA), b = (1 << CC.PID.PIOB);
    if (!(oldPcsr & a) && (newPcsr & a)) this.pioA.pdsrVal = this.pioA.livePdsr();
    if (!(oldPcsr & b) && (newPcsr & b)) this.pioB.pdsrVal = this.pioB.livePdsr();
  };

  B.lcdSpiWord = function (w) {
    this.lcd.spiWord(w);
  };

  B.onUartTx = function (ch) {
    this.onConsole('uart', ch);
  };

  B.onSoftReset = function () {
    this.pendingReset = true;
    this.rt.fuel = -1e15; // wymuś natychmiastowe oddanie sterowania
  };

  B.backlightOn = function () {
    return this.effOut(this.pioB, 20) === 1;
  };

  B.buzzerState = function () {
    // częstotliwość z przełączeń w ostatnich 60 ms czasu wirtualnego
    var now = this.cycles();
    var windowCyc = 0.06 * this.MCK;
    var t = this.buzzToggles;
    var n = 0;
    for (var i = t.length - 1; i >= 0; i--) {
      if (now - t[i] <= windowCyc) n++;
      else break;
    }
    var active = t.length > 0 && (now - t[t.length - 1]) < 0.05 * this.MCK && n >= 2;
    var freq = active ? (n / 2) / 0.06 : 0;
    return { active: active, freq: freq };
  };

  /* ---------- program ---------- */
  B.load = function (compiled) {
    var self = this;
    this.cpu = new CC.Cpu(this.rt, compiled);
    this.cpu.aic = this.aic;
    this.cpu.onFault = function (msg, file, line) {
      self.onConsole('error', 'Błąd wykonania: ' + msg, file, line);
      self.onStateChange();
    };
    this.cpu.onExit = function (code) {
      self.onConsole('info', 'Program zakończył się (return ' + code + ' z main). Płytka zatrzymana.');
      self.onStateChange();
    };
    this.resetHard();
  };

  B.resetHard = function () {
    this.pmc.reset();
    this.pioA.reset();
    this.pioB.reset();
    this.spi0.reset();
    this.spi1.reset();
    this.pit.reset();
    this.tc[0].reset(); this.tc[1].reset(); this.tc[2].reset();
    this.aic.reset();
    this.adc.reset();
    this.lcd.hardReset();
    this.backlog = 0;
    this.buzzToggles.length = 0;
    this.lastBuzzLevel = 0;
    this.lastResetLevel = 1;
    this.pendingReset = false;
    this.paused = false;
    if (this.cpu) this.cpu.reset();
    this.pioA.pdsrVal = this.pioA.livePdsr();
    this.pioB.pdsrVal = this.pioB.livePdsr();
    this.onStateChange();
  };

  B.running = function () {
    return this.cpu && this.cpu.status === 'running';
  };

  /* ---------- pauza i praca krokowa ---------- */
  B.pause = function () {
    if (!this.running()) return;
    this.paused = true;
    this.onStateChange();
  };
  B.resume = function () {
    this.paused = false;
    this.rt.stepF = false;
    this.onStateChange();
  };
  // wykonaj program do następnej linii źródła; zostaje w pauzie
  B.stepLine = function () {
    if (!this.running()) return false;
    this.paused = true;
    var rt = this.rt;
    rt.stepF = true;
    var start = rt.ln;
    var n = 0;
    var wall = nowMs() + 200;
    do {
      // spłać ewentualny "dług" paliwa (np. po Delaya) — czas wirtualny
      // pozostaje ciągły, bo granted rośnie o tę samą wartość
      if (rt.fuel <= 0) {
        var need = 1 - rt.fuel;
        this.cpu.granted += need;
        rt.fuel += need;
      }
      this.cpu.slice(120);
      n++;
      if (this.pendingReset) { this.warn('RSTC: programowy reset płytki'); this.resetHard(); break; }
    } while (this.cpu.status === 'running' && rt.ln === start && n < 2000 && nowMs() < wall);
    rt.stepF = false;
    this.onStateChange();
    return true;
  };

  /* główna pętla czasu: dtMs — ile czasu rzeczywistego minęło,
   * budgetMs — ile czasu CPU przeglądarki wolno zużyć */
  B.tick = function (dtMs, budgetMs) {
    if (!this.cpu) return;
    if (this.cpu.status !== 'running') { this.backlog = 0; return; }
    var add = dtMs / 1000 * this.MCK * this.speed;
    this.backlog = Math.min(this.backlog + add, this.MCK * 0.5 * Math.max(this.speed, 1));
    var deadline = nowMs() + (budgetMs || 10);
    var guard = 0;
    while (this.backlog >= 1 && this.cpu.status === 'running') {
      var chunk = this.backlog > SLICE ? SLICE : this.backlog;
      this.cpu.slice(chunk);
      this.backlog -= chunk;
      if (this.pendingReset) {
        this.warn('RSTC: programowy reset płytki');
        this.resetHard();
        return;
      }
      if ((++guard & 7) === 0 && nowMs() >= deadline) break;
    }
  };

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
