/* ============================================================
 * LABORATORIUM 9 — wyswietlacz graficzny Nokia 6610 (GE12)
 * PRZYKLAD POGLADOWY — pokazuje technike, nie jest kompletnym
 * rozwiazaniem zadania zaliczeniowego.
 *
 * czesc 1: imie, nazwisko i grupa + zaslanianie tekstu
 * czesc 2: kontrastowe prostokaty + tekst transparentny
 * czesc 3: grafika z pliku bmp*.h + animacja
 * ============================================================ */
#include <targets/AT91SAM7.h>
#include "PCF8833U8_lcd.h"
#include "bmp132.h"
#include "bmpChoinka.h"

#define LCD_BACKLIGHT PIOB_SODR_P20

int main(void)
{
    PMC_PCER = PMC_PCER_PIOB;

    PIOB_PER = LCD_BACKLIGHT;
    PIOB_OER = LCD_BACKLIGHT;

    InitLCD();
    LCDSettings();
    LCDClearScreen();
    PIOB_SODR |= LCD_BACKLIGHT;

    // ---- czesc 1: dane studenta + zaslanianie ----
    int w1 = LCDPutStr2(10, 5, MEDIUM, BLACK, WHITE, "Jan Kowalski");
    int w2 = LCDPutStr2(25, 5, MEDIUM, BLUE,  WHITE, "Grupa: GL07");
    Delaya(25000000);

    LCDClearXY(10, 5, MEDIUM, w1, RED);   // zaslon tekst prostokatem
    LCDClearXY(25, 5, MEDIUM, w2, RED);
    Delaya(15000000);

    // ---- czesc 2: prostokaty + tekst transparentny ----
    LCDSetRect(0, 0,  131, 65,  FILL, BLUE);    // lewa polowa
    LCDSetRect(0, 66, 131, 131, FILL, YELLOW);  // prawa polowa
    LCDSetLine(0, 66, 131, 66, BLACK);          // granica
    LCDPutStr("TEST", 50, 50, LARGE, RED, TRANSPARENT2);
    Delaya(25000000);

    // ---- czesc 3: bitmapy + animacja ----
    while (1)
    {
        LCDClearScreen();
        LCDDrawBmp12(bmpChoinka, 116, 121, 5, 8);
        LCDPutStr("Wesolych Swiat!", 122, 18, SMALL, RED, TRANSPARENT2);
        Delaya(12000000);

        LCDClearScreen();
        LCDDrawBmp12(bmpMikolaj, 120, 120, 6, 6);
        LCDPutStr("Wesolych Swiat!", 122, 18, SMALL, BLUE, TRANSPARENT2);
        Delaya(12000000);

        LCDClearScreen();
        LCDDrawBmp12(bmp132, 132, 132, 0, 0);
        LCDPutStr("bmp 132x132", 4, 30, SMALL, WHITE, TRANSPARENT2);
        Delaya(12000000);
    }
    return 0;
}
