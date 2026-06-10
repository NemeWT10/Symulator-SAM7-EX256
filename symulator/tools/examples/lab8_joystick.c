/* ============================================================
 * LABORATORIUM 8 — obsluga klawiatury i joysticka (zad. 8.1)
 * PRZYKLAD POGLADOWY — pokazuje technike, nie jest kompletnym
 * rozwiazaniem zadania zaliczeniowego.
 *
 * Wykrywanie stanu przyciskow SW1/SW2 (port B) i joysticka
 * (port A) przez testowanie bitow rejestru PDSR.
 * Stany wyswietlane na LCD wg makiety z instrukcji (rys. 8.1):
 *
 *            UP
 *     LEFT  ENTER  RIGHT
 *           DOWN
 *     SW1          SW2
 * ============================================================ */
#include <targets/AT91SAM7.h>
#include "PCF8833U8_lcd.h"

#define LCD_BACKLIGHT PIOB_SODR_P20
#define SW_1          PIOB_SODR_P24
#define SW_2          PIOB_SODR_P25

#define JOY_UP    PIOA_SODR_P9   // joystick w gore
#define JOY_ENTER PIOA_SODR_P15  // joystick wcisniety
#define JOY_LEFT  PIOA_SODR_P7   // joystick w lewo
#define JOY_DOWN  PIOA_SODR_P8   // joystick w dol
#define JOY_RIGHT PIOA_SODR_P14  // joystick w prawo

// rysuje etykiete; stan=1 — podswietlona (klawisz wcisniety)
static void label(char *txt, int x, int y, int stan)
{
    if (stan)
        LCDPutStr(txt, x, y, MEDIUM, WHITE, RED);
    else
        LCDPutStr(txt, x, y, MEDIUM, BLACK, WHITE);
}

int main(void)
{
    unsigned int a, b;
    unsigned int pa = 0xFFFFFFFF, pb = 0xFFFFFFFF; // poprzedni stan

    PMC_PCER = PMC_PCER_PIOA | PMC_PCER_PIOB;  // zegary PIOA i PIOB

    // joystick — wejscia na porcie A
    PIOA_PER = JOY_UP | JOY_DOWN | JOY_LEFT | JOY_RIGHT | JOY_ENTER;
    PIOA_ODR = JOY_UP | JOY_DOWN | JOY_LEFT | JOY_RIGHT | JOY_ENTER;

    // przyciski — wejscia, podswietlenie — wyjscie
    PIOB_PER = SW_1 | SW_2 | LCD_BACKLIGHT;
    PIOB_ODR = SW_1 | SW_2;
    PIOB_OER = LCD_BACKLIGHT;

    InitLCD();          // inicjalizacja LCD
    LCDSettings();      // ustawienie LCD
    LCDClearScreen();   // wyczyszczenie ekranu
    PIOB_SODR |= LCD_BACKLIGHT;  // podswietlenie = 1

    LCDPutStr("LAB 8 - klawiatura", 4, 10, SMALL, BLUE, WHITE);

    while (1)
    {
        a = PIOA_PDSR;
        b = PIOB_PDSR;
        if (a == pa && b == pb) continue;  // nic sie nie zmienilo
        pa = a; pb = b;

        // bit = 0 oznacza klawisz wcisniety
        label("  UP  ",   30, 44, (a & JOY_UP) == 0);
        label("LEFT",     60,  6, (a & JOY_LEFT) == 0);
        label("ENTER",    60, 46, (a & JOY_ENTER) == 0);
        label("RIGHT",    60, 88, (a & JOY_RIGHT) == 0);
        label(" DOWN ",   90, 42, (a & JOY_DOWN) == 0);
        label(" SW1 ",   115, 12, (b & SW_1) == 0);
        label(" SW2 ",   115, 86, (b & SW_2) == 0);
    }
    return 0;
}
