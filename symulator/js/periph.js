/* ============================================================
 * Symulator SAM7-EX256 — peryferia AT91SAM7X256
 * periph.js — PMC, PIO A/B, SPI0, PIT, TC0..2, AIC, ADC (minimalny)
 * Magistrala MMIO: read(addr,size) / write(addr,val,size)
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC || (g.CC = {});

  // identyfikatory peryferiów (PID)
  var PID = {
    FIQ: 0, SYS: 1, PIOA: 2, PIOB: 3, SPI0: 4, SPI1: 5, US0: 6, US1: 7,
    SSC: 8, TWI: 9, PWMC: 10, UDP: 11, TC0: 12, TC1: 13, TC2: 14,
    CAN: 15, EMAC: 16, ADC: 17
  };
  CC.PID = PID;

  /* ---------------- PIO ---------------- */
  function Pio(board, name, pid) {
    this.board = board;
    this.name = name;       // 'A' | 'B'
    this.pid = pid;
    this.reset();
  }
  Pio.prototype.reset = function () {
    this.psr = 0xFFFFFFFF | 0;  // PIO enabled (uproszczenie)
    this.osr = 0;
    this.odsr = 0;
    this.ifsr = 0;
    this.imr = 0;
    this.isr = 0;
    this.mdsr = 0;
    this.pusr = 0;              // 0 = pull-up włączony
    this.absr = 0;
    this.owsr = 0;
    this.pdsrVal = this.livePdsr(); // zatrzask (gdy zegar wyłączony)
  };
  Pio.prototype.clocked = function () {
    return (this.board.pmc.pcsr & (1 << this.pid)) !== 0;
  };
  Pio.prototype.pinLevel = function (i) {
    var bit = (1 << i);
    if ((this.psr & this.osr & bit) !== 0) {
      return (this.odsr & bit) ? 1 : 0;     // wyjście — czytamy to co wystawiamy
    }
    return this.board.extLevel(this.name, i); // wejście — poziom zewnętrzny
  };
  Pio.prototype.livePdsr = function () {
    var v = 0;
    for (var i = 0; i < 32; i++) if (this.pinLevel(i)) v |= (1 << i);
    return v | 0;
  };
  Pio.prototype.pdsr = function () {
    if (this.clocked()) this.pdsrVal = this.livePdsr();
    return this.pdsrVal;
  };
  // zdarzenie zewnętrzne (przycisk) — wykrycie zmiany dla PIO_ISR
  Pio.prototype.extChanged = function (i) {
    if (!this.clocked()) return;
    var old = this.pdsrVal;
    this.pdsrVal = this.livePdsr();
    var diff = (old ^ this.pdsrVal) & this.psr;
    if (diff) this.isr |= diff;
  };
  Pio.prototype.outChanged = function (mask) {
    this.board.onPioOutput(this.name, mask);
    if (this.clocked()) {
      var old = this.pdsrVal;
      this.pdsrVal = this.livePdsr();
      this.isr |= (old ^ this.pdsrVal);
    }
  };
  Pio.prototype.irqLevel = function () {
    return (this.isr & this.imr) !== 0;
  };
  Pio.prototype.read = function (off) {
    switch (off) {
      case 0x08: return this.psr;
      case 0x18: return this.osr;
      case 0x28: return this.ifsr;
      case 0x38: return this.odsr;
      case 0x3C: return this.pdsr();
      case 0x48: return this.imr;
      case 0x4C: { var r = this.isr; this.isr = 0; return r; }
      case 0x58: return this.mdsr;
      case 0x68: return this.pusr;
      case 0x78: return this.absr;
      case 0xA8: return this.owsr;
      // rejestry tylko-do-zapisu czytane → 0 (jak nieokreślone)
      default: return 0;
    }
  };
  Pio.prototype.write = function (off, v) {
    v = v | 0;
    switch (off) {
      case 0x00: this.psr |= v; this.outChanged(v); break;        // PER
      case 0x04: this.psr &= ~v; this.outChanged(v); break;       // PDR
      case 0x10: this.osr |= v; this.outChanged(v); break;        // OER
      case 0x14: this.osr &= ~v; this.outChanged(v); break;       // ODR
      case 0x20: this.ifsr |= v; break;                           // IFER
      case 0x24: this.ifsr &= ~v; break;                          // IFDR
      case 0x30: { var ch = v & ~this.odsr; this.odsr |= v; if (ch) this.outChanged(ch); break; }  // SODR
      case 0x34: { var ch2 = v & this.odsr; this.odsr &= ~v; if (ch2) this.outChanged(ch2); break; } // CODR
      case 0x38: { // ODSR (przez OWSR)
        var nv = (this.odsr & ~this.owsr) | (v & this.owsr);
        var ch3 = nv ^ this.odsr;
        this.odsr = nv;
        if (ch3) this.outChanged(ch3);
        break;
      }
      case 0x40: this.imr |= v; break;                            // IER
      case 0x44: this.imr &= ~v; break;                           // IDR
      case 0x50: this.mdsr |= v; break;                           // MDER
      case 0x54: this.mdsr &= ~v; break;                          // MDDR
      case 0x60: this.pusr |= v; break;                           // PUDR — wyłącz pull-up (PUSR: 1=wyłączony)
      case 0x64: this.pusr &= ~v; break;                          // PUER — włącz pull-up
      case 0x70: this.absr &= ~v; break;                          // ASR
      case 0x74: this.absr |= v; break;                           // BSR
      case 0xA0: this.owsr |= v; break;                           // OWER
      case 0xA4: this.owsr &= ~v; break;                          // OWDR
      default: break;
    }
  };

  /* ---------------- PMC ---------------- */
  function Pmc(board) {
    this.board = board;
    this.reset();
  }
  Pmc.prototype.reset = function () {
    this.pcsr = 0;
    this.scsr = 1; // PCK
    this.mor = 0; this.pllr = 0; this.mckr = 0;
  };
  Pmc.prototype.read = function (off) {
    switch (off) {
      case 0x08: return this.scsr;
      case 0x18: return this.pcsr;
      case 0x20: return this.mor;
      case 0x2C: return this.pllr;
      case 0x30: return this.mckr;
      case 0x68: return 0x0F; // PMC_SR: MOSCS|LOCK|MCKRDY|...
      default: return 0;
    }
  };
  Pmc.prototype.write = function (off, v) {
    switch (off) {
      case 0x00: this.scsr |= v; break;   // SCER
      case 0x04: this.scsr &= ~v; break;  // SCDR
      case 0x10: { // PCER
        var was = this.pcsr;
        this.pcsr |= v;
        this.board.onPmcChange(was, this.pcsr);
        break;
      }
      case 0x14: { // PCDR
        var was2 = this.pcsr;
        this.pcsr &= ~v;
        this.board.onPmcChange(was2, this.pcsr);
        break;
      }
      case 0x20: this.mor = v; break;
      case 0x2C: this.pllr = v; break;
      case 0x30: this.mckr = v; break;
      default: break;
    }
  };

  /* ---------------- SPI0 ---------------- */
  function Spi(board, idx) {
    this.board = board;
    this.idx = idx;
    this.reset();
  }
  Spi.prototype.reset = function () {
    this.mr = 0; this.csr = [0, 0, 0, 0];
    this.enabled = false;
    this.rdr = 0;
  };
  Spi.prototype.read = function (off) {
    switch (off) {
      case 0x04: return this.mr;
      case 0x08: return this.rdr;        // RDR
      case 0x10: // SR
        return (1 << 0) | (1 << 1) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 9) |
          (this.enabled ? (1 << 16) : 0);
      case 0x30: return this.csr[0];
      case 0x34: return this.csr[1];
      case 0x38: return this.csr[2];
      case 0x3C: return this.csr[3];
      default: return 0;
    }
  };
  Spi.prototype.write = function (off, v) {
    switch (off) {
      case 0x00: // CR
        if (v & 1) this.enabled = true;       // SPIEN
        if (v & 2) this.enabled = false;      // SPIDIS
        if (v & 0x80) this.reset();           // SWRST
        break;
      case 0x04: this.mr = v >>> 0; break;
      case 0x0C: // TDR
        if (this.idx === 0) this.board.lcdSpiWord(v & 0x1FF);
        this.rdr = 0;
        break;
      case 0x30: this.csr[0] = v >>> 0; break;
      case 0x34: this.csr[1] = v >>> 0; break;
      case 0x38: this.csr[2] = v >>> 0; break;
      case 0x3C: this.csr[3] = v >>> 0; break;
      default: break;
    }
  };

  /* ---------------- PIT ---------------- */
  function Pit(board) {
    this.board = board;
    this.reset();
  }
  Pit.prototype.reset = function () {
    this.piv = 0xFFFFF;
    this.piten = false;
    this.pitien = false;
    this.startTicks = 0;
    this.consumedWraps = 0;
    this.frozen = { cpiv: 0, picnt: 0 };
  };
  Pit.prototype.ticksNow = function () {
    return Math.floor(this.board.cycles() / 16);
  };
  Pit.prototype.state = function () {
    if (!this.piten) return { cpiv: this.frozen.cpiv, picnt: this.frozen.picnt, wraps: this.consumedWraps + this.frozen.picnt };
    var period = this.piv + 1;
    var el = this.ticksNow() - this.startTicks;
    if (el < 0) el = 0;
    var wraps = Math.floor(el / period);
    return {
      cpiv: el % period,
      picnt: Math.min(wraps - this.consumedWraps, 0xFFF),
      wraps: wraps
    };
  };
  Pit.prototype.pits = function () {
    var s = this.state();
    return s.picnt > 0;
  };
  Pit.prototype.irqLevel = function () {
    return this.pitien && this.pits();
  };
  Pit.prototype.read = function (off) {
    switch (off) {
      case 0x00: return (this.piv | (this.piten ? (1 << 24) : 0) | (this.pitien ? (1 << 25) : 0)) | 0;
      case 0x04: return this.pits() ? 1 : 0; // PIT_SR (PITS)
      case 0x08: { // PIVR — odczyt kasuje PICNT i PITS
        var s = this.state();
        this.consumedWraps = s.wraps;
        return ((s.picnt << 20) | (s.cpiv & 0xFFFFF)) | 0;
      }
      case 0x0C: { // PIIR — bez kasowania
        var s2 = this.state();
        return ((s2.picnt << 20) | (s2.cpiv & 0xFFFFF)) | 0;
      }
      default: return 0;
    }
  };
  Pit.prototype.write = function (off, v) {
    if (off === 0x00) {
      var newPiv = v & 0xFFFFF;
      var newEn = (v & (1 << 24)) !== 0;
      var newIen = (v & (1 << 25)) !== 0;
      if (newEn && !this.piten) {
        this.startTicks = this.ticksNow();
        this.consumedWraps = 0;
      } else if (!newEn && this.piten) {
        var s = this.state();
        this.frozen = { cpiv: s.cpiv, picnt: s.picnt };
      } else if (newEn && newPiv !== this.piv) {
        this.startTicks = this.ticksNow();
        this.consumedWraps = 0;
      }
      this.piv = newPiv;
      this.piten = newEn;
      this.pitien = newIen;
    }
  };

  /* ---------------- Timer Counter (kanał) ---------------- */
  var TC_DIV = [2, 8, 32, 128, 1024];
  function TcChan(board, id) {
    this.board = board;
    this.id = id; // 0..2
    this.reset();
  }
  TcChan.prototype.reset = function () {
    this.cmr = 0;
    this.rc = 0; this.ra = 0; this.rb = 0;
    this.imr = 0;
    this.flags = 0;          // zatrzaśnięte COVFS/CPCS itd.
    this.clken = false;
    this.anchor = 0;         // cykl odpowiadający CV=0
    this.cvFrozen = 0;
    this.warned = false;
  };
  TcChan.prototype.div = function () {
    var sel = this.cmr & 7;
    if (sel < 5) return TC_DIV[sel];
    if (!this.warned) {
      this.warned = true;
      this.board.warn('TC' + this.id + ': wybrano zegar zewnętrzny XC (TCCLKS=' + sel + ') — w symulatorze działa jak MCK/1024');
    }
    return 1024;
  };
  TcChan.prototype.period = function () {
    if ((this.cmr & (1 << 14)) !== 0) { // CPCTRG
      return (this.rc & 0xFFFF) || 0x10000;
    }
    return 0x10000;
  };
  TcChan.prototype.sync = function () {
    // dolicz flagi od ostatniej synchronizacji
    if (!this.clken) return this.cvFrozen;
    var dv = this.div();
    var ticks = Math.floor((this.board.cycles() - this.anchor) / dv);
    if (ticks < 0) ticks = 0;
    var per = this.period();
    var wraps = Math.floor(ticks / per);
    var cv = ticks % per;
    if (wraps > 0) {
      if ((this.cmr & (1 << 14)) !== 0) this.flags |= (1 << 4); // CPCS
      else this.flags |= (1 << 0);                              // COVFS
      // przesuń kotwicę, by nie liczyć tych samych przepełnień dwa razy
      this.anchor += wraps * per * dv;
    }
    return cv;
  };
  TcChan.prototype.irqLevel = function () {
    this.sync();
    return (this.flags & this.imr) !== 0;
  };
  TcChan.prototype.read = function (off) {
    switch (off) {
      case 0x04: return this.cmr;
      case 0x10: { var cv = this.sync(); return cv | 0; }            // CV
      case 0x14: return this.ra; case 0x18: return this.rb; case 0x1C: return this.rc;
      case 0x20: { // SR — odczyt kasuje flagi
        this.sync();
        var r = this.flags | (this.clken ? (1 << 16) : 0);
        this.flags = 0;
        return r | 0;
      }
      case 0x2C: return this.imr;
      default: return 0;
    }
  };
  TcChan.prototype.write = function (off, v) {
    switch (off) {
      case 0x00: { // CCR
        if (v & 2) { // CLKDIS
          this.cvFrozen = this.sync();
          this.clken = false;
        } else if (v & 1) { // CLKEN
          if (!this.clken) {
            this.clken = true;
            this.anchor = this.board.cycles() - this.cvFrozen * this.div();
          }
        }
        if (v & 4) { // SWTRG — reset licznika (i start jeśli CLKEN)
          this.anchor = this.board.cycles();
          this.cvFrozen = 0;
          if (v & 1) this.clken = true;
        }
        break;
      }
      case 0x04: this.cvFrozen = this.sync(); this.cmr = v >>> 0; this.anchor = this.board.cycles() - this.cvFrozen * this.div(); break;
      case 0x14: this.ra = v & 0xFFFF; break;
      case 0x18: this.rb = v & 0xFFFF; break;
      case 0x1C: this.sync(); this.rc = v & 0xFFFF; break;
      case 0x24: this.imr |= v; break;   // IER
      case 0x28: this.imr &= ~v; break;  // IDR
      default: break;
    }
  };

  /* ---------------- AIC ---------------- */
  function Aic(board) {
    this.board = board;
    this.reset();
  }
  Aic.prototype.reset = function () {
    this.smr = new Int32Array(32);
    this.svr = new Int32Array(32);
    this.imr = 0;
    this.softPending = 0;
    this.current = -1;
    this.spu = 0;
  };
  Aic.prototype.levels = function () {
    var b = this.board;
    var v = this.softPending;
    if (b.pit.irqLevel()) v |= (1 << PID.SYS);
    if (b.pioA.irqLevel()) v |= (1 << PID.PIOA);
    if (b.pioB.irqLevel()) v |= (1 << PID.PIOB);
    if (b.tc[0].irqLevel()) v |= (1 << PID.TC0);
    if (b.tc[1].irqLevel()) v |= (1 << PID.TC1);
    if (b.tc[2].irqLevel()) v |= (1 << PID.TC2);
    return v | 0;
  };
  Aic.prototype.highestPending = function () {
    var cand = this.levels() & this.imr & ~1; // FIQ pomijamy
    if (!cand) return -1;
    var best = -1, bestPrio = -1;
    for (var i = 1; i < 32; i++) {
      if (!(cand & (1 << i))) continue;
      var prio = this.smr[i] & 7;
      if (prio > bestPrio) { bestPrio = prio; best = i; }
    }
    return best;
  };
  // dla silnika: pobierz przerwanie do obsługi
  Aic.prototype.acquire = function () {
    if (this.current >= 0) return null; // bez zagnieżdżania
    var id = this.highestPending();
    if (id < 0) return null;
    this.current = id;
    this.softPending &= ~(1 << id); // skasuj „edge”
    return { id: id, vector: this.svr[id] >>> 0 };
  };
  Aic.prototype.eoi = function () { this.current = -1; };
  Aic.prototype.read = function (off) {
    if (off >= 0x000 && off < 0x080) return this.smr[(off >> 2) & 31];
    if (off >= 0x080 && off < 0x100) return this.svr[(off >> 2) & 31];
    switch (off) {
      case 0x100: { // IVR — tryb „ręczny”
        var id = this.highestPending();
        return id < 0 ? this.spu : this.svr[id];
      }
      case 0x108: return this.current < 0 ? 0 : this.current; // ISR
      case 0x10C: return this.levels();                       // IPR
      case 0x110: return this.imr;                            // IMR
      case 0x114: return (this.current >= 0 ? 2 : 0) | (this.highestPending() >= 0 ? 1 : 0); // CISR
      default: return 0;
    }
  };
  Aic.prototype.write = function (off, v) {
    if (off >= 0x000 && off < 0x080) { this.smr[(off >> 2) & 31] = v | 0; return; }
    if (off >= 0x080 && off < 0x100) { this.svr[(off >> 2) & 31] = v | 0; return; }
    switch (off) {
      case 0x120: this.imr |= v; break;          // IECR
      case 0x124: this.imr &= ~v; break;         // IDCR
      case 0x128: this.softPending &= ~v; break; // ICCR
      case 0x12C: this.softPending |= v; break;  // ISCR
      case 0x130: this.eoi(); break;             // EOICR
      case 0x134: this.spu = v | 0; break;       // SPU
      default: break;
    }
  };

  /* ---------------- ADC (minimalny) ---------------- */
  function Adc(board) {
    this.board = board;
    this.reset();
  }
  Adc.prototype.reset = function () {
    this.cher = 0;
    this.mr = 0;
    this.converted = 0;
    this.lastCh = 4;
  };
  Adc.prototype.read = function (off) {
    if (off === 0x1C) { // SR: EOC dla skonwertowanych + DRDY
      return (this.converted & 0xFF) | ((this.converted ? 1 : 0) << 16) | 0x0F000000;
    }
    if (off === 0x20) { // LCDR
      return this.board.adcValue(this.lastCh) & 0x3FF;
    }
    if (off >= 0x30 && off < 0x50) { // CDR0..7
      var ch = (off - 0x30) >> 2;
      return this.board.adcValue(ch) & 0x3FF;
    }
    if (off === 0x10) return this.cher; // CHSR
    if (off === 0x04) return this.mr;
    return 0;
  };
  Adc.prototype.write = function (off, v) {
    switch (off) {
      case 0x00: // CR: START/SWRST
        if (v & 2) {
          this.converted = this.cher;
          for (var i = 7; i >= 0; i--) if (this.cher & (1 << i)) { this.lastCh = i; break; }
        }
        if (v & 1) this.reset();
        break;
      case 0x04: this.mr = v >>> 0; break;
      case 0x08: this.cher |= v; break;  // CHER
      case 0x0C: this.cher &= ~v; break; // CHDR
      default: break;
    }
  };

  /* ---------------- magistrala ---------------- */
  function Bus(board) {
    this.board = board;
    this.warned = new Set();
  }
  Bus.prototype.read = function (addr, size) {
    var b = this.board;
    addr = addr >>> 0;
    if (addr >= 0xFFFFF400 && addr <= 0xFFFFF5FF) return b.pioA.read(addr - 0xFFFFF400);
    if (addr >= 0xFFFFF600 && addr <= 0xFFFFF7FF) return b.pioB.read(addr - 0xFFFFF600);
    if (addr >= 0xFFFFFC00 && addr <= 0xFFFFFCFF) return b.pmc.read(addr - 0xFFFFFC00);
    if (addr >= 0xFFFFFD30 && addr <= 0xFFFFFD3F) return b.pit.read(addr - 0xFFFFFD30);
    if (addr >= 0xFFFFF000 && addr <= 0xFFFFF1FF) return b.aic.read(addr - 0xFFFFF000);
    if (addr >= 0xFFFA0000 && addr <= 0xFFFA003F) return b.tc[0].read(addr - 0xFFFA0000);
    if (addr >= 0xFFFA0040 && addr <= 0xFFFA007F) return b.tc[1].read(addr - 0xFFFA0040);
    if (addr >= 0xFFFA0080 && addr <= 0xFFFA00BF) return b.tc[2].read(addr - 0xFFFA0080);
    if (addr === 0xFFFA00C4) return 0; // TC_BMR
    if (addr >= 0xFFFE0000 && addr <= 0xFFFE3FFF) return b.spi0.read(addr - 0xFFFE0000);
    if (addr >= 0xFFFE4000 && addr <= 0xFFFE7FFF) return b.spi1.read(addr - 0xFFFE4000);
    if (addr >= 0xFFFD8000 && addr <= 0xFFFDBFFF) return b.adc.read(addr - 0xFFFD8000);
    if (addr >= 0xFFFFFD40 && addr <= 0xFFFFFD4F) { // WDT
      return (addr & 0xF) === 8 ? 0 : 0; // WDT_SR=0
    }
    if (addr >= 0xFFFFFD00 && addr <= 0xFFFFFD0F) { // RSTC
      return (addr & 0xF) === 4 ? 0x00010000 : 0;   // RSTC_SR: NRSTL
    }
    if (addr >= 0xFFFFFD20 && addr <= 0xFFFFFD2F) { // RTT
      if ((addr & 0xF) === 8) { // RTT_VR
        var pres = 0x8000;
        return Math.floor(b.cycles() / b.MCK * 32768 / (pres / 0x8000)) | 0;
      }
      return 0;
    }
    if (addr >= 0xFFFC0000 && addr <= 0xFFFC3FFF) { // US0
      if ((addr & 0xFF) === 0x14) return 0x202; // CSR: TXRDY|TXEMPTY
      return 0;
    }
    if (addr >= 0xFFFC4000 && addr <= 0xFFFC7FFF) { // US1
      if ((addr & 0xFF) === 0x14) return 0x202;
      return 0;
    }
    if (addr >= 0xFFFFF200 && addr <= 0xFFFFF3FF) { // DBGU
      if ((addr & 0xFF) === 0x14) return 0x202;
      return 0;
    }
    this.warnOnce(addr, 'odczyt');
    return 0;
  };
  Bus.prototype.write = function (addr, v, size) {
    var b = this.board;
    addr = addr >>> 0;
    if (addr >= 0xFFFFF400 && addr <= 0xFFFFF5FF) { b.pioA.write(addr - 0xFFFFF400, v); return; }
    if (addr >= 0xFFFFF600 && addr <= 0xFFFFF7FF) { b.pioB.write(addr - 0xFFFFF600, v); return; }
    if (addr >= 0xFFFFFC00 && addr <= 0xFFFFFCFF) { b.pmc.write(addr - 0xFFFFFC00, v); return; }
    if (addr >= 0xFFFFFD30 && addr <= 0xFFFFFD3F) { b.pit.write(addr - 0xFFFFFD30, v); return; }
    if (addr >= 0xFFFFF000 && addr <= 0xFFFFF1FF) { b.aic.write(addr - 0xFFFFF000, v); return; }
    if (addr >= 0xFFFA0000 && addr <= 0xFFFA003F) { b.tc[0].write(addr - 0xFFFA0000, v); return; }
    if (addr >= 0xFFFA0040 && addr <= 0xFFFA007F) { b.tc[1].write(addr - 0xFFFA0040, v); return; }
    if (addr >= 0xFFFA0080 && addr <= 0xFFFA00BF) { b.tc[2].write(addr - 0xFFFA0080, v); return; }
    if (addr === 0xFFFA00C0) { // TC_BCR: SYNC
      if (v & 1) for (var i = 0; i < 3; i++) b.tc[i].write(0, 5); // SWTRG+CLKEN
      return;
    }
    if (addr >= 0xFFFE0000 && addr <= 0xFFFE3FFF) { b.spi0.write(addr - 0xFFFE0000, v); return; }
    if (addr >= 0xFFFE4000 && addr <= 0xFFFE7FFF) { b.spi1.write(addr - 0xFFFE4000, v); return; }
    if (addr >= 0xFFFD8000 && addr <= 0xFFFDBFFF) { b.adc.write(addr - 0xFFFD8000, v); return; }
    if (addr >= 0xFFFFFD00 && addr <= 0xFFFFFD0F) { // RSTC_CR
      if ((addr & 0xF) === 0 && ((v >>> 24) & 0xFF) === 0xA5 && (v & 0x0D)) {
        b.onSoftReset();
      }
      return;
    }
    if (addr >= 0xFFFFFD40 && addr <= 0xFFFFFD4F) return; // WDT — ignoruj
    if (addr >= 0xFFFFFD20 && addr <= 0xFFFFFD2F) return; // RTT — ignoruj
    if (addr >= 0xFFFC0000 && addr <= 0xFFFC7FFF) { // US0/US1 THR
      if ((addr & 0xFF) === 0x1C) b.onUartTx(String.fromCharCode(v & 0xFF));
      return;
    }
    if (addr >= 0xFFFFF200 && addr <= 0xFFFFF3FF) { // DBGU THR
      if ((addr & 0xFF) === 0x1C) b.onUartTx(String.fromCharCode(v & 0xFF));
      return;
    }
    if (addr >= 0xFFFFFF00) return; // MC — ignoruj
    this.warnOnce(addr, 'zapis');
  };
  Bus.prototype.warnOnce = function (addr, what) {
    var key = (addr & ~3) >>> 0;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.board.warn('nieobsługiwany rejestr 0x' + key.toString(16).toUpperCase() +
      ' (' + what + ') — symulator zwraca 0 / ignoruje');
  };

  CC.Pio = Pio;
  CC.Pmc = Pmc;
  CC.Spi = Spi;
  CC.Pit = Pit;
  CC.TcChan = TcChan;
  CC.Aic = Aic;
  CC.Adc = Adc;
  CC.Bus = Bus;

})(typeof globalThis !== 'undefined' ? globalThis : this);
