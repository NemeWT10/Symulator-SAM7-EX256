/* ============================================================
 * Symulator SAM7-EX256 — wirtualne nagłówki systemowe
 * headers.js — generuje targets/AT91SAM7.h (styl CrossWorks),
 * AT91SAM7X256.h (styl Atmel) i nagłówki standardu C
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC || (g.CC = {});

  function reg(name, addr) {
    return '#define ' + name + ' (*(volatile unsigned int *)0x' +
      (addr >>> 0).toString(16).toUpperCase() + ')\n';
  }
  function def(name, val) {
    return '#define ' + name + ' (0x' + (val >>> 0).toString(16).toUpperCase() + ')\n';
  }

  function genAT91SAM7() {
    var s = [];
    s.push('#ifndef __AT91SAM7_SIM_H__\n#define __AT91SAM7_SIM_H__\n');
    s.push('/* Wygenerowany nagłówek symulatora — rejestry AT91SAM7X256 (podzbiór) */\n');

    // BITy
    for (var i = 0; i < 32; i++) s.push(def('BIT' + i, (1 << i) >>> 0));
    var ATMEL_INSERT_AT = s.length; // typedefy Atmel muszą być PRZED makrami rejestrów

    // ---------------- PIO ----------------
    var pioRegs = [
      ['PER', 0x00], ['PDR', 0x04], ['PSR', 0x08],
      ['OER', 0x10], ['ODR', 0x14], ['OSR', 0x18],
      ['IFER', 0x20], ['IFDR', 0x24], ['IFSR', 0x28],
      ['SODR', 0x30], ['CODR', 0x34], ['ODSR', 0x38], ['PDSR', 0x3C],
      ['IER', 0x40], ['IDR', 0x44], ['IMR', 0x48], ['ISR', 0x4C],
      ['MDER', 0x50], ['MDDR', 0x54], ['MDSR', 0x58],
      ['PUDR', 0x60], ['PUER', 0x64], ['PUSR', 0x68],
      ['ASR', 0x70], ['BSR', 0x74], ['ABSR', 0x78],
      ['OWER', 0xA0], ['OWDR', 0xA4], ['OWSR', 0xA8]
    ];
    var pioBases = { A: 0xFFFFF400, B: 0xFFFFF600 };
    Object.keys(pioBases).forEach(function (p) {
      var base = pioBases[p];
      pioRegs.forEach(function (r) {
        var rn = 'PIO' + p + '_' + r[0];
        s.push(reg(rn, base + r[1]));
        for (var b = 0; b < 32; b++) s.push(def(rn + '_P' + b, (1 << b) >>> 0));
      });
    });

    // ---------------- PMC ----------------
    var pmcBase = 0xFFFFFC00;
    [['SCER', 0x00], ['SCDR', 0x04], ['SCSR', 0x08], ['PCER', 0x10], ['PCDR', 0x14],
    ['PCSR', 0x18], ['MOR', 0x20], ['MCFR', 0x24], ['PLLR', 0x2C], ['MCKR', 0x30],
    ['PCK0', 0x40], ['PCK1', 0x44], ['PCK2', 0x48], ['PCK3', 0x4C],
    ['IER', 0x60], ['IDR', 0x64], ['SR', 0x68], ['IMR', 0x6C]
    ].forEach(function (r) { s.push(reg('PMC_' + r[0], pmcBase + r[1])); });
    var pids = {
      FIQ: 0, SYS: 1, SYSIRQ: 1, PIOA: 2, PIOB: 3, SPI0: 4, SPI1: 5, US0: 6, US1: 7,
      SSC: 8, TWI: 9, PWMC: 10, UDP: 11, TC0: 12, TC1: 13, TC2: 14, CAN: 15,
      EMAC: 16, ADC: 17
    };
    ['PCER', 'PCDR', 'PCSR'].forEach(function (rn) {
      Object.keys(pids).forEach(function (k) {
        s.push(def('PMC_' + rn + '_' + k, (1 << pids[k]) >>> 0));
      });
    });
    Object.keys(pids).forEach(function (k) { s.push(def('AT91C_ID_' + k, pids[k])); });

    // ---------------- SPI0/SPI1 ----------------
    [['SPI0', 0xFFFE0000], ['SPI1', 0xFFFE4000]].forEach(function (sp) {
      var nm = sp[0], base = sp[1];
      [['CR', 0x00], ['MR', 0x04], ['RDR', 0x08], ['TDR', 0x0C], ['SR', 0x10],
      ['IER', 0x14], ['IDR', 0x18], ['IMR', 0x1C],
      ['CSR0', 0x30], ['CSR1', 0x34], ['CSR2', 0x38], ['CSR3', 0x3C]
      ].forEach(function (r) { s.push(reg(nm + '_' + r[0], base + r[1])); });
      var srBits = {
        RDRF: 1 << 0, TDRE: 1 << 1, MODF: 1 << 2, OVRES: 1 << 3, ENDRX: 1 << 4,
        ENDTX: 1 << 5, RXBUFF: 1 << 6, TXBUFE: 1 << 7, NSSR: 1 << 8,
        TXEMPTY: 1 << 9, SPIENS: 1 << 16
      };
      Object.keys(srBits).forEach(function (k) { s.push(def(nm + '_SR_' + k, srBits[k] >>> 0)); });
      s.push(def(nm + '_CR_SPIEN', 1)); s.push(def(nm + '_CR_SPIDIS', 2));
      s.push(def(nm + '_CR_SWRST', 0x80));
      s.push(def(nm + '_MR_MSTR', 1)); s.push(def(nm + '_MR_PS', 2));
      s.push(def(nm + '_MR_PCSDEC', 4)); s.push(def(nm + '_MR_MODFDIS', 0x10));
    });

    // ---------------- PIT ----------------
    var pitBase = 0xFFFFFD30;
    s.push(reg('PIT_MR', pitBase + 0x0));
    s.push(reg('PIT_SR', pitBase + 0x4));
    s.push(reg('PIT_PIVR', pitBase + 0x8));
    s.push(reg('PIT_PIIR', pitBase + 0xC));
    s.push(def('PIT_MR_PITEN', (1 << 24) >>> 0));
    s.push(def('PIT_MR_PITIEN', (1 << 25) >>> 0));
    s.push(def('PIT_SR_PITS', 1));

    // ---------------- TC ----------------
    var tcBases = [0xFFFA0000, 0xFFFA0040, 0xFFFA0080];
    for (var ch = 0; ch < 3; ch++) {
      var base2 = tcBases[ch], nm2 = 'TC' + ch;
      [['CCR', 0x00], ['CMR', 0x04], ['CV', 0x10], ['RA', 0x14], ['RB', 0x18],
      ['RC', 0x1C], ['SR', 0x20], ['IER', 0x24], ['IDR', 0x28], ['IMR', 0x2C]
      ].forEach(function (r) { s.push(reg(nm2 + '_' + r[0], base2 + r[1])); });
      s.push(def(nm2 + '_CCR_CLKEN', 1));
      s.push(def(nm2 + '_CCR_CLKDIS', 2));
      s.push(def(nm2 + '_CCR_SWTRG', 4));
      s.push(def(nm2 + '_CMR_CPCTRG', (1 << 14) >>> 0));
      s.push(def(nm2 + '_CMR_WAVE', (1 << 15) >>> 0));
      for (var d = 1; d <= 5; d++) s.push(def(nm2 + '_CMR_TCCLKS_TIMER_CLOCK' + d, d - 1));
      var tcsr = {
        COVFS: 1, LOVRS: 2, CPAS: 4, CPBS: 8, CPCS: 0x10,
        LDRAS: 0x20, LDRBS: 0x40, ETRGS: 0x80, CLKSTA: 0x10000
      };
      Object.keys(tcsr).forEach(function (k) { s.push(def(nm2 + '_SR_' + k, tcsr[k] >>> 0)); });
      var ieBits = { COVFS: 1, CPAS: 4, CPBS: 8, CPCS: 0x10, ETRGS: 0x80 };
      Object.keys(ieBits).forEach(function (k) {
        s.push(def(nm2 + '_IER_' + k, ieBits[k] >>> 0));
        s.push(def(nm2 + '_IDR_' + k, ieBits[k] >>> 0));
        s.push(def(nm2 + '_IMR_' + k, ieBits[k] >>> 0));
      });
    }
    s.push(reg('TC_BCR', 0xFFFA00C0));
    s.push(reg('TC_BMR', 0xFFFA00C4));
    s.push(def('TC_BCR_SYNC', 1));
    for (var d2 = 1; d2 <= 5; d2++) s.push(def('TIMER_CLOCK' + d2, d2 - 1));

    // ---------------- AIC ----------------
    var aicBase = 0xFFFFF000;
    for (var v = 0; v < 32; v++) {
      s.push(reg('AIC_SMR' + v, aicBase + v * 4));
      s.push(reg('AIC_SVR' + v, aicBase + 0x80 + v * 4));
    }
    [['IVR', 0x100], ['FVR', 0x104], ['ISR', 0x108], ['IPR', 0x10C], ['IMR', 0x110],
    ['CISR', 0x114], ['IECR', 0x120], ['IDCR', 0x124], ['ICCR', 0x128],
    ['ISCR', 0x12C], ['EOICR', 0x130], ['SPU', 0x134], ['DCR', 0x138]
    ].forEach(function (r) { s.push(reg('AIC_' + r[0], aicBase + r[1])); });
    s.push(def('AIC_SMR_SRCTYPE_INT_LEVEL_SENSITIVE', 0x00));
    s.push(def('AIC_SMR_SRCTYPE_INT_EDGE_TRIGGERED', 0x20));
    s.push(def('AIC_SMR_SRCTYPE_EXT_LOW_LEVEL', 0x00));
    s.push(def('AIC_SMR_SRCTYPE_EXT_NEGATIVE_EDGE', 0x20));
    s.push(def('AIC_SMR_SRCTYPE_EXT_HIGH_LEVEL', 0x40));
    s.push(def('AIC_SMR_SRCTYPE_EXT_POSITIVE_EDGE', 0x60));

    // ---------------- WDT / RSTC / RTT ----------------
    s.push(reg('WDT_CR', 0xFFFFFD40));
    s.push(reg('WDT_MR', 0xFFFFFD44));
    s.push(reg('WDT_SR', 0xFFFFFD48));
    s.push(def('WDT_MR_WDDIS', (1 << 15) >>> 0));
    s.push(reg('RSTC_CR', 0xFFFFFD00));
    s.push(reg('RSTC_SR', 0xFFFFFD04));
    s.push(reg('RSTC_MR', 0xFFFFFD08));
    s.push(def('RSTC_CR_PROCRST', 1));
    s.push(def('RSTC_CR_PERRST', 4));
    s.push(def('RSTC_CR_EXTRST', 8));
    s.push(reg('RTT_MR', 0xFFFFFD20));
    s.push(reg('RTT_AR', 0xFFFFFD24));
    s.push(reg('RTT_VR', 0xFFFFFD28));
    s.push(reg('RTT_SR', 0xFFFFFD2C));

    // ---------------- ADC ----------------
    var adcBase = 0xFFFD8000;
    [['CR', 0x00], ['MR', 0x04], ['CHER', 0x10], ['CHDR', 0x14], ['CHSR', 0x18],
    ['SR', 0x1C], ['LCDR', 0x20], ['IER', 0x24], ['IDR', 0x28], ['IMR', 0x2C]
    ].forEach(function (r) { s.push(reg('ADC_' + r[0], adcBase + r[1])); });
    for (var c2 = 0; c2 < 8; c2++) {
      s.push(reg('ADC_CDR' + c2, adcBase + 0x30 + c2 * 4));
      s.push(def('ADC_SR_EOC' + c2, (1 << c2) >>> 0));
      s.push(def('ADC_CHER_CH' + c2, (1 << c2) >>> 0));
    }
    s.push(def('ADC_CR_SWRST', 1));
    s.push(def('ADC_CR_START', 2));
    s.push(def('ADC_SR_DRDY', (1 << 16) >>> 0));

    // ---------------- USART / DBGU ----------------
    [['US0', 0xFFFC0000], ['US1', 0xFFFC4000]].forEach(function (us) {
      var nm3 = us[0], b3 = us[1];
      [['CR', 0x00], ['MR', 0x04], ['IER', 0x08], ['IDR', 0x0C], ['IMR', 0x10],
      ['CSR', 0x14], ['RHR', 0x18], ['THR', 0x1C], ['BRGR', 0x20], ['RTOR', 0x24],
      ['TTGR', 0x28]
      ].forEach(function (r) { s.push(reg(nm3 + '_' + r[0], b3 + r[1])); });
      s.push(def(nm3 + '_CSR_RXRDY', 1));
      s.push(def(nm3 + '_CSR_TXRDY', 2));
      s.push(def(nm3 + '_CSR_TXEMPTY', (1 << 9) >>> 0));
      s.push(def(nm3 + '_CR_RXEN', 0x10));
      s.push(def(nm3 + '_CR_TXEN', 0x40));
    });
    [['CR', 0x00], ['MR', 0x04], ['IER', 0x08], ['IDR', 0x0C], ['IMR', 0x10],
    ['SR', 0x14], ['RHR', 0x18], ['THR', 0x1C], ['BRGR', 0x20]
    ].forEach(function (r) { s.push(reg('DBGU_' + r[0], 0xFFFFF200 + r[1])); });

    // ---------------- styl Atmel (AT91C_*) ----------------
    var sTail = s;       // dalsze definicje (AT91C_PIO* itd.) zostają na końcu
    s = [];              // typedefy zbieramy osobno i wstawimy przed makra
    s.push('\ntypedef volatile unsigned int AT91_REG;\n');
    s.push('typedef struct _AT91S_PIO {\n' +
      ' AT91_REG PIO_PER; AT91_REG PIO_PDR; AT91_REG PIO_PSR; AT91_REG Reserved0[1];\n' +
      ' AT91_REG PIO_OER; AT91_REG PIO_ODR; AT91_REG PIO_OSR; AT91_REG Reserved1[1];\n' +
      ' AT91_REG PIO_IFER; AT91_REG PIO_IFDR; AT91_REG PIO_IFSR; AT91_REG Reserved2[1];\n' +
      ' AT91_REG PIO_SODR; AT91_REG PIO_CODR; AT91_REG PIO_ODSR; AT91_REG PIO_PDSR;\n' +
      ' AT91_REG PIO_IER; AT91_REG PIO_IDR; AT91_REG PIO_IMR; AT91_REG PIO_ISR;\n' +
      ' AT91_REG PIO_MDER; AT91_REG PIO_MDDR; AT91_REG PIO_MDSR; AT91_REG Reserved3[1];\n' +
      ' AT91_REG PIO_PPUDR; AT91_REG PIO_PPUER; AT91_REG PIO_PPUSR; AT91_REG Reserved4[1];\n' +
      ' AT91_REG PIO_ASR; AT91_REG PIO_BSR; AT91_REG PIO_ABSR; AT91_REG Reserved5[9];\n' +
      ' AT91_REG PIO_OWER; AT91_REG PIO_OWDR; AT91_REG PIO_OWSR;\n' +
      '} AT91S_PIO, *AT91PS_PIO;\n');
    s.push('typedef struct _AT91S_PMC {\n' +
      ' AT91_REG PMC_SCER; AT91_REG PMC_SCDR; AT91_REG PMC_SCSR; AT91_REG Reserved0[1];\n' +
      ' AT91_REG PMC_PCER; AT91_REG PMC_PCDR; AT91_REG PMC_PCSR; AT91_REG Reserved1[1];\n' +
      ' AT91_REG PMC_MOR; AT91_REG PMC_MCFR; AT91_REG Reserved2[1]; AT91_REG PMC_PLLR;\n' +
      ' AT91_REG PMC_MCKR; AT91_REG Reserved3[3]; AT91_REG PMC_PCKR[4]; AT91_REG Reserved4[4];\n' +
      ' AT91_REG PMC_IER; AT91_REG PMC_IDR; AT91_REG PMC_SR; AT91_REG PMC_IMR;\n' +
      '} AT91S_PMC, *AT91PS_PMC;\n');
    s.push('typedef struct _AT91S_SPI {\n' +
      ' AT91_REG SPI_CR; AT91_REG SPI_MR; AT91_REG SPI_RDR; AT91_REG SPI_TDR;\n' +
      ' AT91_REG SPI_SR; AT91_REG SPI_IER; AT91_REG SPI_IDR; AT91_REG SPI_IMR;\n' +
      ' AT91_REG Reserved0[4]; AT91_REG SPI_CSR[4];\n' +
      '} AT91S_SPI, *AT91PS_SPI;\n');
    s.push('typedef struct _AT91S_PITC {\n' +
      ' AT91_REG PITC_PIMR; AT91_REG PITC_PISR; AT91_REG PITC_PIVR; AT91_REG PITC_PIIR;\n' +
      '} AT91S_PITC, *AT91PS_PITC;\n');
    s.push('typedef struct _AT91S_TC {\n' +
      ' AT91_REG TC_CCR; AT91_REG TC_CMR; AT91_REG Reserved0[2];\n' +
      ' AT91_REG TC_CV; AT91_REG TC_RA; AT91_REG TC_RB; AT91_REG TC_RC;\n' +
      ' AT91_REG TC_SR; AT91_REG TC_IER; AT91_REG TC_IDR; AT91_REG TC_IMR;\n' +
      '} AT91S_TC, *AT91PS_TC;\n');
    s.push('typedef struct _AT91S_AIC {\n' +
      ' AT91_REG AIC_SMR[32]; AT91_REG AIC_SVR[32];\n' +
      ' AT91_REG AIC_IVR; AT91_REG AIC_FVR; AT91_REG AIC_ISR; AT91_REG AIC_IPR;\n' +
      ' AT91_REG AIC_IMR; AT91_REG AIC_CISR; AT91_REG Reserved0[2];\n' +
      ' AT91_REG AIC_IECR; AT91_REG AIC_IDCR; AT91_REG AIC_ICCR; AT91_REG AIC_ISCR;\n' +
      ' AT91_REG AIC_EOICR; AT91_REG AIC_SPU; AT91_REG AIC_DCR;\n' +
      '} AT91S_AIC, *AT91PS_AIC;\n');
    s.push('#define AT91C_BASE_PIOA ((AT91PS_PIO)0xFFFFF400)\n');
    s.push('#define AT91C_BASE_PIOB ((AT91PS_PIO)0xFFFFF600)\n');
    s.push('#define AT91C_BASE_PMC ((AT91PS_PMC)0xFFFFFC00)\n');
    s.push('#define AT91C_BASE_SPI0 ((AT91PS_SPI)0xFFFE0000)\n');
    s.push('#define AT91C_BASE_SPI1 ((AT91PS_SPI)0xFFFE4000)\n');
    s.push('#define AT91C_BASE_PITC ((AT91PS_PITC)0xFFFFFD30)\n');
    s.push('#define AT91C_BASE_TC0 ((AT91PS_TC)0xFFFA0000)\n');
    s.push('#define AT91C_BASE_TC1 ((AT91PS_TC)0xFFFA0040)\n');
    s.push('#define AT91C_BASE_TC2 ((AT91PS_TC)0xFFFA0080)\n');
    s.push('#define AT91C_BASE_AIC ((AT91PS_AIC)0xFFFFF000)\n');
    // wstaw typedefy przed makra rejestrów i wróć do głównej listy
    var atmelTypes = s.join('');
    s = sTail;
    s.splice(ATMEL_INSERT_AT, 0, atmelTypes);
    // wskaźnikowe makra rejestrów PIO (styl AT91C_PIOB_SODR)
    Object.keys(pioBases).forEach(function (p) {
      var base = pioBases[p];
      var at91names = {
        PER: 0x00, PDR: 0x04, PSR: 0x08, OER: 0x10, ODR: 0x14, OSR: 0x18,
        IFER: 0x20, IFDR: 0x24, IFSR: 0x28, SODR: 0x30, CODR: 0x34, ODSR: 0x38,
        PDSR: 0x3C, IER: 0x40, IDR: 0x44, IMR: 0x48, ISR: 0x4C,
        MDER: 0x50, MDDR: 0x54, MDSR: 0x58, PPUDR: 0x60, PPUER: 0x64, PPUSR: 0x68,
        ASR: 0x70, BSR: 0x74, ABSR: 0x78, OWER: 0xA0, OWDR: 0xA4, OWSR: 0xA8
      };
      Object.keys(at91names).forEach(function (rn) {
        s.push('#define AT91C_PIO' + p + '_' + rn + ' ((AT91_REG *)0x' +
          ((base + at91names[rn]) >>> 0).toString(16).toUpperCase() + ')\n');
      });
      for (var b2 = 0; b2 < 31; b2++) {
        s.push(def('AT91C_PIO_P' + p + b2, (1 << b2) >>> 0));
      }
    });
    s.push('#define AT91C_PMC_PCER ((AT91_REG *)0xFFFFFC10)\n');
    s.push('#define AT91C_PMC_PCDR ((AT91_REG *)0xFFFFFC14)\n');
    s.push('#define AT91C_PMC_PCSR ((AT91_REG *)0xFFFFFC18)\n');
    s.push(def('AT91C_SPI_RDRF', 1));
    s.push(def('AT91C_SPI_TDRE', 2));
    s.push(def('AT91C_SPI_TXEMPTY', (1 << 9) >>> 0));
    s.push(def('AT91C_SPI_SPIEN', 1));
    s.push(def('AT91C_SPI_SPIDIS', 2));
    s.push(def('AT91C_SPI_SWRST', 0x80));
    s.push(def('AT91C_PITC_PITEN', (1 << 24) >>> 0));
    s.push(def('AT91C_PITC_PITIEN', (1 << 25) >>> 0));
    s.push(def('AT91C_PITC_PITS', 1));
    s.push(def('AT91C_TC_CLKEN', 1));
    s.push(def('AT91C_TC_CLKDIS', 2));
    s.push(def('AT91C_TC_SWTRG', 4));
    s.push(def('AT91C_TC_CPCTRG', (1 << 14) >>> 0));
    s.push(def('AT91C_TC_COVFS', 1));
    s.push(def('AT91C_TC_CPCS', 0x10));

    s.push('\n#endif /* __AT91SAM7_SIM_H__ */\n');
    return s.join('');
  }

  function genStdHeaders(map) {
    map.set('stddef.h',
      '#ifndef __STDDEF_H__\n#define __STDDEF_H__\n' +
      '#define NULL ((void*)0)\n' +
      'typedef unsigned int size_t;\n' +
      'typedef int ptrdiff_t;\n' +
      'typedef int wchar_t;\n' +
      '#define offsetof(t,m) ((size_t)&(((t*)0)->m))\n' +
      '#endif\n');
    map.set('stdint.h',
      '#ifndef __STDINT_H__\n#define __STDINT_H__\n' +
      'typedef signed char int8_t;\ntypedef unsigned char uint8_t;\n' +
      'typedef short int16_t;\ntypedef unsigned short uint16_t;\n' +
      'typedef int int32_t;\ntypedef unsigned int uint32_t;\n' +
      'typedef int intptr_t;\ntypedef unsigned int uintptr_t;\n' +
      'typedef int int_fast8_t;\ntypedef unsigned int uint_fast8_t;\n' +
      'typedef int int_fast16_t;\ntypedef unsigned int uint_fast16_t;\n' +
      'typedef int int_fast32_t;\ntypedef unsigned int uint_fast32_t;\n' +
      '#define INT8_MIN (-128)\n#define INT8_MAX 127\n#define UINT8_MAX 255\n' +
      '#define INT16_MIN (-32768)\n#define INT16_MAX 32767\n#define UINT16_MAX 65535\n' +
      '#define INT32_MIN (-2147483647-1)\n#define INT32_MAX 2147483647\n' +
      '#define UINT32_MAX 4294967295u\n' +
      '#endif\n');
    map.set('stdbool.h',
      '#ifndef __STDBOOL_H__\n#define __STDBOOL_H__\n' +
      '#define bool _Bool\n#define true 1\n#define false 0\n' +
      '#define __bool_true_false_are_defined 1\n#endif\n');
    map.set('limits.h',
      '#ifndef __LIMITS_H__\n#define __LIMITS_H__\n' +
      '#define CHAR_BIT 8\n#define SCHAR_MIN (-128)\n#define SCHAR_MAX 127\n' +
      '#define UCHAR_MAX 255\n#define CHAR_MIN (-128)\n#define CHAR_MAX 127\n' +
      '#define SHRT_MIN (-32768)\n#define SHRT_MAX 32767\n#define USHRT_MAX 65535\n' +
      '#define INT_MIN (-2147483647-1)\n#define INT_MAX 2147483647\n' +
      '#define UINT_MAX 4294967295u\n#define LONG_MIN INT_MIN\n#define LONG_MAX INT_MAX\n' +
      '#define ULONG_MAX UINT_MAX\n#endif\n');
    map.set('math.h',
      '#ifndef __MATH_H__\n#define __MATH_H__\n' +
      '#define M_PI 3.14159265358979323846\n' +
      '#define M_PI_2 1.57079632679489661923\n' +
      '#define M_E 2.7182818284590452354\n' +
      'double sin(double x);\ndouble cos(double x);\ndouble tan(double x);\n' +
      'double asin(double x);\ndouble acos(double x);\ndouble atan(double x);\n' +
      'double atan2(double y, double x);\ndouble sqrt(double x);\n' +
      'double pow(double x, double y);\ndouble exp(double x);\ndouble log(double x);\n' +
      'double log10(double x);\ndouble fabs(double x);\ndouble floor(double x);\n' +
      'double ceil(double x);\ndouble fmod(double x, double y);\ndouble round(double x);\n' +
      'float sinf(float x);\nfloat cosf(float x);\nfloat sqrtf(float x);\nfloat fabsf(float x);\n' +
      '#endif\n');
    map.set('string.h',
      '#ifndef __STRING_H__\n#define __STRING_H__\n' +
      '#include <stddef.h>\n' +
      'void *memset(void *s, int c, size_t n);\n' +
      'void *memcpy(void *d, const void *s, size_t n);\n' +
      'void *memmove(void *d, const void *s, size_t n);\n' +
      'int memcmp(const void *a, const void *b, size_t n);\n' +
      'size_t strlen(const char *s);\n' +
      'char *strcpy(char *d, const char *s);\n' +
      'char *strncpy(char *d, const char *s, size_t n);\n' +
      'char *strcat(char *d, const char *s);\n' +
      'int strcmp(const char *a, const char *b);\n' +
      'int strncmp(const char *a, const char *b, size_t n);\n' +
      'char *strchr(const char *s, int c);\n' +
      'char *strstr(const char *h, const char *n);\n' +
      '#endif\n');
    map.set('stdio.h',
      '#ifndef __STDIO_H__\n#define __STDIO_H__\n' +
      '#include <stddef.h>\n' +
      'int sprintf(char *str, const char *format, ...);\n' +
      'int snprintf(char *str, size_t size, const char *format, ...);\n' +
      'int printf(const char *format, ...);\n' +
      'int puts(const char *s);\n' +
      'int putchar(int c);\n' +
      '#endif\n');
    map.set('stdlib.h',
      '#ifndef __STDLIB_H__\n#define __STDLIB_H__\n' +
      '#include <stddef.h>\n' +
      '#define RAND_MAX 32767\n' +
      'void *malloc(size_t size);\nvoid *calloc(size_t n, size_t size);\n' +
      'void free(void *ptr);\n' +
      'int rand(void);\nvoid srand(unsigned int seed);\n' +
      'int abs(int x);\nlong labs(long x);\n' +
      'int atoi(const char *s);\nlong atol(const char *s);\n' +
      '#endif\n');
    map.set('cross_studio_io.h',
      '#ifndef __CROSS_STUDIO_IO_H__\n#define __CROSS_STUDIO_IO_H__\n' +
      'int debug_printf(const char *format, ...);\n' +
      '#endif\n');
    map.set('targets/libarm.h',
      '#ifndef __LIBARM_H__\n#define __LIBARM_H__\n' +
      'void libarm_enable_irq(void);\nvoid libarm_disable_irq(void);\n' +
      'void libarm_enable_fiq(void);\nvoid libarm_disable_fiq(void);\n' +
      '#endif\n');
    map.set('libarm.h', map.get('targets/libarm.h'));
  }

  CC.systemHeaders = function () {
    var map = new Map();
    var at91 = genAT91SAM7();
    map.set('targets/at91sam7.h', at91);
    map.set('at91sam7.h', at91);
    map.set('targets/at91sam7x256.h', at91);
    map.set('at91sam7x256.h', at91);
    map.set('targets/at91sam7xc256.h', at91);
    map.set('at91sam7xc256.h', at91);
    genStdHeaders(map);
    return map;
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
