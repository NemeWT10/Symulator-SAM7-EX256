/* ============================================================
 * Symulator SAM7-EX256 — wyświetlacz Nokia 6610 (GE12)
 * lcd.js — model kontrolera Philips PCF8833, 132×132, 12 bpp
 *
 * Wejście: 9-bitowe słowa SPI (bit8: 0=komenda, 1=dane).
 * PASET (0x2B) ustawia okno wierszy, CASET (0x2A) okno kolumn,
 * RAMWR (0x2C) pisze piksele: kolumna rośnie pierwsza, po
 * przekroczeniu okna przejście do następnego wiersza; po
 * zapełnieniu okna dalsze dane są ignorowane (jak w sterowniku
 * używanym na laboratorium — "2nd pixel will be ignored").
 * ============================================================ */
(function (g) {
  'use strict';
  var CC = g.CC || (g.CC = {});

  // komendy
  var CMD = {
    NOP: 0x00, SWRESET: 0x01, SLPIN: 0x10, SLPOUT: 0x11,
    PTLON: 0x12, NORON: 0x13, INVOFF: 0x20, INVON: 0x21,
    APOFF: 0x22, APON: 0x23, SETCON: 0x25, DISPOFF: 0x28, DISPON: 0x29,
    CASET: 0x2A, PASET: 0x2B, RAMWR: 0x2C, RGBSET: 0x2D,
    PTLAR: 0x30, VSCRDEF: 0x33, MADCTL: 0x36, VSCSAD: 0x37,
    IDMOFF: 0x38, IDMON: 0x39, COLMOD: 0x3A,
    SETCON2: 0xBE, BSTRON: 0x03, BSTROFF: 0x02
  };

  function Pcf8833() {
    this.gram = new Uint16Array(132 * 132);
    this.reset();
  }
  CC.Pcf8833 = Pcf8833;
  var P = Pcf8833.prototype;

  P.reset = function () {
    this.sleep = true;
    this.dispOn = false;
    this.inverted = false;
    this.madctl = 0;
    this.colmod = 3;          // 12bpp
    this.contrast = 0x40;
    this.cmd = -1;
    this.args = [];
    // okno
    this.cx0 = 0; this.cx1 = 131;  // CASET (kolumny)
    this.py0 = 0; this.py1 = 131;  // PASET (wiersze)
    this.col = 0; this.row = 0;
    this.ramActive = false;
    this.ramStopped = false;
    this.bitAcc = 0;   // akumulator bitów strumienia RAMWR
    this.bitCnt = 0;   // (kontroler zatrzaskuje piksel co 12/16 bitów)
    this.dirty = true;
    this.warn16bpp = false;
    this.onWarn = this.onWarn || function (s) { };
    // gram zostaje (jak w prawdziwym module — losowa/stara zawartość)
  };

  P.hardReset = function () {
    this.reset();
  };

  /* słowo SPI 9-bit */
  P.spiWord = function (w) {
    if (w & 0x100) this.data(w & 0xFF);
    else this.command(w & 0xFF);
  };

  P.command = function (c) {
    this.cmd = c;
    this.args.length = 0;
    this.bitAcc = 0;
    this.bitCnt = 0;
    this.ramActive = false;
    switch (c) {
      case CMD.NOP: break;
      case CMD.SWRESET: { var ow = this.onWarn; this.reset(); this.onWarn = ow; break; }
      case CMD.SLPIN: this.sleep = true; this.dirty = true; break;
      case CMD.SLPOUT: this.sleep = false; this.dirty = true; break;
      case CMD.INVOFF: this.inverted = false; this.dirty = true; break;
      case CMD.INVON: this.inverted = true; this.dirty = true; break;
      case CMD.DISPOFF: this.dispOn = false; this.dirty = true; break;
      case CMD.DISPON: this.dispOn = true; this.dirty = true; break;
      case CMD.RAMWR:
        this.ramActive = true;
        this.ramStopped = false;
        this.col = this.cx0;
        this.row = this.py0;
        break;
      default: break; // pozostałe: czekamy na argumenty / ignorujemy
    }
  };

  P.data = function (b) {
    switch (this.cmd) {
      case CMD.CASET:
        this.args.push(b & 0xFF);
        if (this.args.length === 2) {
          this.cx0 = this.args[0]; this.cx1 = this.args[1];
          if (this.cx1 < this.cx0) { var t = this.cx0; this.cx0 = this.cx1; this.cx1 = t; }
          this.col = this.cx0;
        }
        break;
      case CMD.PASET:
        this.args.push(b & 0xFF);
        if (this.args.length === 2) {
          this.py0 = this.args[0]; this.py1 = this.args[1];
          if (this.py1 < this.py0) { var t2 = this.py0; this.py0 = this.py1; this.py1 = t2; }
          this.row = this.py0;
        }
        break;
      case CMD.MADCTL:
        this.madctl = b & 0xFF;
        this.dirty = true;
        break;
      case CMD.COLMOD:
        this.colmod = b & 7;
        if (this.colmod === 5 && !this.warn16bpp) {
          this.warn16bpp = true;
          this.onWarn('LCD: ustawiono format 16bpp — sterownik laboratorium używa 12bpp (0x03)');
        }
        break;
      case CMD.SETCON:
        this.contrast = b & 0xFF;
        break;
      case CMD.RAMWR:
        if (this.ramActive && !this.ramStopped) {
          // strumień bitowy: piksel zatrzaskiwany co 12 (lub 16) bitów —
          // dzięki temu nieparzysta liczba pikseli (2 bajty na ostatni)
          // też trafia do pamięci, jak w prawdziwym kontrolerze
          this.bitAcc = ((this.bitAcc << 8) | (b & 0xFF)) >>> 0;
          this.bitCnt += 8;
          var pxBits = (this.colmod === 5) ? 16 : 12;
          while (this.bitCnt >= pxBits) {
            var v = (this.bitAcc >>> (this.bitCnt - pxBits));
            this.bitCnt -= pxBits;
            this.bitAcc &= (1 << this.bitCnt) - 1;
            if (pxBits === 12) {
              this.putPixel(v & 0xFFF);
            } else { // RGB565 → 12 bitów; kolejność pól zostaje bez zmian,
              // bo o zamianie R↔B decyduje bit BGR w MADCTL — tak samo jak przy 12 bpp
              var f2 = (v >> 12) & 0xF, f1 = (v >> 7) & 0xF, f0 = (v >> 1) & 0xF;
              this.putPixel(((f2 << 8) | (f1 << 4) | f0) & 0xFFF);
            }
          }
        }
        break;
      default:
        break; // dane do nieznanej komendy — ignoruj
    }
  };

  P.putPixel = function (v12) {
    if (this.ramStopped) return;
    var col = this.col, row = this.row;
    // transformacja MADCTL (MY=0x80, MX=0x40, MV=0x20)
    var c = col, r = row;
    if (this.madctl & 0x20) { var t = c; c = r; r = t; }
    if (this.madctl & 0x40) c = 131 - c;
    if (this.madctl & 0x80) r = 131 - r;
    if (c >= 0 && c < 132 && r >= 0 && r < 132) {
      this.gram[r * 132 + c] = v12;
      this.dirty = true;
    }
    // przesuń kursor w oknie
    this.col++;
    if (this.col > this.cx1) {
      this.col = this.cx0;
      this.row++;
      if (this.row > this.py1) {
        this.ramStopped = true; // okno pełne — dalsze piksele ignorowane
      }
    }
  };

  /* render do bufora RGBA (Uint8ClampedArray dł. 132*132*4)
   * backlight: 0..1 */
  P.render = function (rgba, backlight) {
    var bgr = (this.madctl & 0x08) !== 0;
    var inv = this.inverted;
    var on = this.dispOn && !this.sleep;
    var bl = backlight;
    // wyłączony wyświetlacz: jednolita ciemna szarość (panel TFT bez obrazu)
    var i, o = 0;
    for (i = 0; i < 132 * 132; i++) {
      var v = this.gram[i];
      var R, G, B;
      if (!on) {
        // panel bez obrazu: ciemny, a z podświetleniem — mlecznie rozświetlony
        R = G = B = Math.round(30 + 145 * bl);
        rgba[o] = R; rgba[o + 1] = G; rgba[o + 2] = B + 6; rgba[o + 3] = 255;
        o += 4;
        continue;
      } else {
        if (inv) v = (~v) & 0xFFF;
        var n2 = (v >> 8) & 0xF, n1 = (v >> 4) & 0xF, n0 = v & 0xF;
        if (bgr) { B = n2 * 17; G = n1 * 17; R = n0 * 17; }
        else { R = n2 * 17; G = n1 * 17; B = n0 * 17; }
      }
      // podświetlenie: bez podświetlenia obraz ledwo widoczny
      var k = 0.13 + 0.87 * bl;
      rgba[o] = (R * k) | 0;
      rgba[o + 1] = (G * k) | 0;
      rgba[o + 2] = (B * k) | 0;
      rgba[o + 3] = 255;
      o += 4;
    }
    this.dirty = false;
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
