/* ============================================================
 * LABORATORIUM 6 — pierwszy program wbudowany (wg instrukcji)
 * PRZYKLAD POGLADOWY — pokazuje technike, nie jest kompletnym
 * rozwiazaniem zadania zaliczeniowego.
 *
 * Sterowanie podswietleniem LCD (PB20) i buzzerem (PB19).
 *
 *   SW1 — wlacza podswietlenie + krotki sygnal buzzera
 *   SW2 — wylacza podswietlenie + dluzszy sygnal buzzera
 *
 * W symulatorze: SW1/SW2 to klawisze 1 i 2.
 * Stan podswietlenia widac na wyswietlaczu i diodzie BL,
 * buzzer slychac (mozna wyciszyc) i widac na wskazniku.
 * ============================================================ */
#include <targets/AT91SAM7.h>

#define LCD_BACKLIGHT PIOB_SODR_P20
#define AUDIO_OUT     PIOB_SODR_P19
#define SW_1          PIOB_SODR_P24
#define SW_2          PIOB_SODR_P25

void delay(int n) __attribute__ ((section(".fast")));
// prototyp procedury opoznienia, uruchamiaj w RAM-ie

void delay(int n)        // procedura opoznienia
{
    volatile int i;
    for (i = 3000 * n; i > 0; i--)
    {
        __asm__("nop");
    }
}

int main(void)
{
    PMC_PCER = PMC_PCER_PIOB;            // wlaczenie urzadzenia we/wy PIOB

    PIOB_OER = LCD_BACKLIGHT | AUDIO_OUT;  // OUTPUT ENABLE
    PIOB_PER = LCD_BACKLIGHT | AUDIO_OUT;  // PIO ENABLE

    while (1)
    {
        if ((PIOB_PDSR & SW_1) == 0)
        {
            PIOB_SODR |= LCD_BACKLIGHT;  // ustawienie 1
            PIOB_SODR |= AUDIO_OUT;
            delay(1);
            PIOB_CODR |= AUDIO_OUT;
            delay(1);
        }
        if ((PIOB_PDSR & SW_2) == 0)
        {
            PIOB_CODR |= LCD_BACKLIGHT;  // ustawienie 0
            PIOB_SODR |= AUDIO_OUT;
            delay(5);
            PIOB_CODR |= AUDIO_OUT;
            delay(5);
        }
    }
    return 0;
}
