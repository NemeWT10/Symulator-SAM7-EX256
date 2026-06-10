/* ============================================================
 * Szablon projektu — symulator zestawu Olimex SAM7-EX256
 * Laboratorium systemow wbudowanych
 *
 * Sterowanie w symulatorze:
 *   - joystick: strzalki na klawiaturze (Enter = wcisniecie)
 *   - SW1 / SW2: klawisze 1 i 2 (albo mysza)
 * ============================================================ */
#include <targets/AT91SAM7.h>
#include "PCF8833U8_lcd.h"

// przyciski
#define SW_1       PIOB_SODR_P24
#define SW_2       PIOB_SODR_P25
// joystick
#define JOY_UP     PIOA_SODR_P9
#define JOY_ENTER  PIOA_SODR_P15
#define JOY_LEFT   PIOA_SODR_P7
#define JOY_DOWN   PIOA_SODR_P8
#define JOY_RIGHT  PIOA_SODR_P14
// inne
#define LCD_BACKLIGHT  PIOB_SODR_P20
#define AUDIO_OUT      PIOB_SODR_P19

int main(void)
{
    // wlaczenie zegarow kontrolerow PIO
    PMC_PCER = PMC_PCER_PIOA | PMC_PCER_PIOB;

    // joystick i przyciski jako wejscia
    PIOA_PER = JOY_UP | JOY_DOWN | JOY_LEFT | JOY_RIGHT | JOY_ENTER;
    PIOA_ODR = JOY_UP | JOY_DOWN | JOY_LEFT | JOY_RIGHT | JOY_ENTER;
    PIOB_PER = SW_1 | SW_2 | LCD_BACKLIGHT;
    PIOB_ODR = SW_1 | SW_2;

    // podswietlenie jako wyjscie, wlaczone
    PIOB_OER  = LCD_BACKLIGHT;
    PIOB_SODR = LCD_BACKLIGHT;

    // wyswietlacz
    InitLCD();
    LCDSettings();
    LCDClearScreen();

    LCDPutStr("Symulator", 20, 30, LARGE, BLACK, WHITE);
    LCDPutStr("SAM7-EX256", 40, 28, LARGE, BLUE, WHITE);
    LCDPutStr("Nacisnij SW1...", 70, 20, SMALL, BLACK, WHITE);

    while (1)
    {
        if ((PIOB_PDSR & SW_1) == 0)   // SW1 wcisniety (stan niski)
        {
            LCDSetRect(90, 20, 110, 110, FILL, GREEN);
            LCDPutStr("SW1 OK!", 96, 40, MEDIUM, BLACK, GREEN);
        }
        if ((PIOB_PDSR & SW_2) == 0)   // SW2 kasuje
        {
            LCDSetRect(90, 20, 110, 110, FILL, WHITE);
        }
    }
    return 0;
}
