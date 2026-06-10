/* ============================================================
 * LABORATORIUM — timery: PIT oraz Timer Counter 0 (TC0)
 * (instrukcja LSW6 / projekt lab11)
 * PRZYKLAD POGLADOWY — pokazuje technike, nie jest kompletnym
 * rozwiazaniem zadania zaliczeniowego.
 *
 * Wybierz wariant zmieniajac ponizsze #define:
 *   WARIANT 1 — PIT:  miganie podswietleniem co ~1 s
 *               (PIV=299999 -> 0,1 s; 10 przepelnien = 1 s)
 *   WARIANT 2 — TC0:  RC compare, MCK/128, RC=37499 -> 0,1 s;
 *               zmiana stanu PB20 co 10 okresow (~1 s)
 * ============================================================ */
#include <targets/AT91SAM7.h>
#include "PCF8833U8_lcd.h"

#define WARIANT 2

#define LCD_BACKLIGHT PIOB_SODR_P20

int main(void)
{
    InitLCD();
    LCDClearScreen();
    LCDPutStr("Timery: PIT / TC0", 10, 10, SMALL, BLACK, WHITE);
    LCDPutStr("miganie BL co 1s", 25, 10, SMALL, BLUE, WHITE);

#if WARIANT == 1
    /* ---------------- PIT ---------------- */
    PMC_PCER = PMC_PCER_PIOB;          // zegar PIOB
    PIOB_PER = LCD_BACKLIGHT;
    PIOB_OER = LCD_BACKLIGHT;

    PIT_MR = 299999 | (1 << 24);       // PIV oraz bit PITEN
    PIT_PIVR;                          // pusty odczyt — zerowanie licznikow

    while (1)
    {
        if ((PIT_SR & (1 << 0)) != 0)  // flaga PITS ustawiona?
        {
            int liczniki = PIT_PIIR;   // odczyt bez kasowania
            int picnt = liczniki >> 20;  // liczba przepelnien CPIV
            if (picnt >= 10)           // 10 x 0,1 s = 1 s
            {
                if ((PIOB_PDSR & (1 << 20)) != 0)
                    PIOB_CODR = (1 << 20);
                else
                    PIOB_SODR = (1 << 20);
                PIT_PIVR;              // kasuje PICNT i flage PITS
            }
        }
    }
#else
    /* ---------------- TC0 ---------------- */
    PMC_PCER = PMC_PCER_PIOB | (1 << 12);  // zegar PIOB oraz TC0 (PID=12)
    PIOB_PER = LCD_BACKLIGHT;
    PIOB_OER = LCD_BACKLIGHT;

    int licznik = 0;

    TC0_CCR = (1 << 1);                // CLKDIS — wylacz licznik na czas konfiguracji
    TC0_SR;                            // pusty odczyt — reset flag
    TC0_CMR = (1 << 14) | 3;           // CPCTRG (bit14) + preskaler MCK/128 (TCCLKS=3)
    TC0_RC  = 37499;                   // 48 MHz / 128 * 0,1 s = 37500 -> RC=37499
    TC0_CCR = (1 << 2) | (1 << 0);     // SWTRG + CLKEN — start

    while (1)
    {
        if ((TC0_SR & (1 << 4)) != 0)  // flaga CPCS (odczyt SR ja kasuje)
        {
            licznik++;
            if (licznik >= 10)         // 10 x 0,1 s = 1 s
            {
                if ((PIOB_PDSR & (1 << 20)) != 0)
                    PIOB_CODR = (1 << 20);
                else
                    PIOB_SODR = (1 << 20);
                licznik = 0;
            }
        }
    }
#endif
    return 0;
}
