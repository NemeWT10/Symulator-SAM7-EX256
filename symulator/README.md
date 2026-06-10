# Symulator SAM7-EX256 — Laboratorium systemów wbudowanych Politechnika Lubelska

Projekt stworzony przy użyciu AI przez Szymon Wójcik
(projekt zawiera również przykłady inspirowane instrukcjami laboratoryjnymi —
przerobione przez AI). **Przykłady są wyłącznie poglądowe**: ilustrują techniki
z instrukcji, ale **nie są kompletnymi rozwiązaniami zadań zaliczeniowych**
(prowadzący wymaga więcej, niż pokazują).

Przeglądarkowy symulator zestawu uruchomieniowego **Olimex SAM7-EX256**
(mikrokontroler AT91SAM7X256, rdzeń ARM7TDMI) do ćwiczeń z instrukcji
*„IIS 5.3 Laboratorium systemów wbudowanych”* (laboratoria 6–10) oraz
instrukcji *LSW6* (timery PIT / Timer Counter) opracowanych przez dr inż. Wojciech Surtel.

Zawiera prosty **IDE**: przeglądarkę plików projektu, edytor C z kolorowaniem
składni i konsolę błędów, oraz **wirtualną płytkę**: wyświetlacz Nokia 6610
(kontroler Philips PCF8833, 132×132, 12 bpp), joystick, przyciski SW1/SW2,
podświetlenie i buzzer.

## Uruchomienie

**Niczego nie trzeba instalować.** Wystarczy otworzyć plik `index.html`
w przeglądarce (Chrome, Edge lub Firefox) — podwójnym kliknięciem.

Alternatywnie (np. gdy przeglądarka blokuje localStorage dla plików lokalnych):

```
cd symulator
python -m http.server 8000
```

i otworzyć `http://localhost:8000`.

## Jak korzystać

1. Z listy **Przykłady** wybierz program (np. *Lab 10 — menu*) albo pisz własny
   kod w `main.c`.
2. Kliknij **▶ Uruchom** (klawisz F5). Błędy kompilacji pojawią się w konsoli —
   kliknięcie błędu otwiera plik i podświetla linię.
3. Steruj płytką:

   | Element płytki | Pin | Klawiatura |
   |---|---|---|
   | joystick — góra | PA9 | ↑ |
   | joystick — dół | PA8 | ↓ |
   | joystick — lewo | PA7 | ← |
   | joystick — prawo | PA14 | → |
   | joystick — wciśnięcie (enter) | PA15 | Enter |
   | przycisk SW1 | PB24 | 1 |
   | przycisk SW2 | PB25 | 2 |
   | podświetlenie LCD | PB20 | — (dioda *BL*) |
   | buzzer (AUDIO_OUT) | PB19 | — (ikona + dźwięk) |

   Klawiatura działa, gdy kursor jest **poza** edytorem (kliknij w obszar płytki).
4. Projekt zapisuje się automatycznie w przeglądarce (localStorage).
   **Eksport ZIP** pobiera pliki — można je przenieść do CrossWorks na zajęciach.
   **Import plików** dodaje pliki `.c`/`.h` z dysku (obsługuje kodowanie CP1250).

## Co jest symulowane

* **PIO A / PIO B** — PER, PDR, OER, ODR, SODR, CODR, ODSR, PDSR, pull-upy
  (PUER/PUDR/PUSR), przerwania zmiany stanu (IER/IMR/ISR).
  Uwaga: tak jak na prawdziwej płytce, **odczyt wejść (PDSR) wymaga włączenia
  zegara portu w PMC** (`PMC_PCER = PMC_PCER_PIOA | PMC_PCER_PIOB;`).
* **PMC** — PCER/PCDR/PCSR.
* **SPI0** + kontroler LCD **Philips PCF8833** (GE12): komendy PASET, CASET,
  RAMWR (12 bpp), SLEEPOUT, DISPON/DISPOFF, INVON/INVOFF, MADCTL, COLMOD…
  Działa dokładnie ten sam sterownik `pcf8833u8_lcd.c`, którego używacie
  w laboratorium — można go modyfikować (lab 9).
* **PIT** — PIT_MR (PIV, PITEN, PITIEN), PIT_SR (PITS), PIT_PIVR (odczyt
  kasuje PICNT i PITS), PIT_PIIR. Częstotliwość zliczania MCK/16.
* **TC0–TC2** — tryb przepełnienia (COVFS) i RC compare (CPCTRG, CPCS),
  preskalery TIMER_CLOCK1–5 (MCK/2…MCK/1024), odczyt SR kasuje flagi.
* **AIC** — AIC_SVRx, AIC_IECR/IDCR/ICCR/ISCR, priorytety; przerwania od
  PIT (linia SYS), TC0–2 i PIO. Handler to zwykła funkcja C, której adres
  wpisuje się do `AIC_SVR1` itd.
* **ADC** (minimalnie) — wartość z suwaka „Potencjometr” we wszystkich kanałach.
* `debug_printf()` / `printf()` / `sprintf()` oraz podstawowe funkcje
  `<string.h>`, `<math.h>`, `<stdlib.h>`.
* Zapisy do USART0/USART1/DBGU (THR) trafiają do konsoli jako „UART⟶”.

Zegar MCK = **48 MHz**. Czas wirtualny płynie zgodnie z wybraną prędkością
(1× = czas rzeczywisty); pętle opóźniające (`Delaya()`, `delay()`) trwają
mniej więcej tyle, co na prawdziwej płytce.

## Czego symulator nie robi

* Nie wykonuje prawdziwego kodu maszynowego ARM — kod C jest kompilowany
  wbudowanym kompilatorem (podzbiór C99). Wstawki `__asm__("nop")` są
  akceptowane, inne wstawki asemblerowe — ignorowane.
* Brak: `goto`, `long long`, pola bitowe w strukturach, wskaźniki do funkcji
  zagnieżdżone w bardzo nietypowych deklaracjach.
* Ethernet, USB, CAN, SD/MMC, SSC, TWI — nieobsługiwane (odczyt rejestrów
  zwraca 0 i ostrzeżenie w konsoli).
* Dokładność czasowa jest przybliżona (model kosztów instrukcji, nie cykli
  rdzenia ARM7).

## Pliki projektu

Nowy projekt zawiera komplet plików używanych na laboratorium:

* `main.c` — kod studenta,
* `pcf8833u8_lcd.c`, `PCF8833U8_lcd.h` — sterownik wyświetlacza (Olimex/J. Lynch),
* `fonts.h` — czcionki 6×8, 8×8, 8×16,
* `bmp.h` — obraz demo Olimex (130×130, używany przez `LCDWrite130x130bmp`),
* `bmp132.h` (`bmp132` — tablica testowa wyświetlacza, `bmp80` — buźka),
  `bmpChoinka.h` (`bmpChoinka`, `bmpMikolaj`) — **grafika własna, generowana
  programowo** przez `tools/build_projfiles.js` (nazwy tablic i wymiary zgodne
  z plikami używanymi na laboratorium, więc programy z zajęć działają bez zmian),
* `defines.h` — definicje BIT0…BIT31.

Nagłówek `<targets/AT91SAM7.h>` (a także `<AT91SAM7X256.h>`) jest wbudowany
w symulator — definiuje rejestry w stylu CrossWorks (`PIOB_SODR`,
`PIOB_SODR_P20`, `PMC_PCER_PIOB`…) oraz w stylu Atmel (`AT91C_BASE_PIOA`,
`AT91PS_PIO`, `AT91C_PIOB_SODR`…), zgodnie z instrukcją laboratorium 7.

## Struktura katalogów

```
symulator/
  index.html          — aplikacja (otwierana)
  css/style.css
  js/
    cc_lex.js         — preprocesor + tokenizer C
    cc_parse.js       — parser C
    cc_gen.js         — generacja kodu (C → JavaScript)
    runtime.js        — pamięć, funkcje wbudowane, silnik wykonania
    periph.js         — PIO, PMC, SPI, PIT, TC, AIC, ADC
    lcd.js            — model kontrolera PCF8833
    board.js          — model płytki (wejścia, czas, buzzer)
    headers.js        — wirtualne nagłówki systemowe
    editor.js, ide.js — edytor i interfejs
    projfiles.js      — wbudowane pliki projektu (generowany!)
  tools/
    build_projfiles.js — generuje projfiles.js (w tym bitmapy rysowane kodem)
    lab_src/           — pliki sterownika LCD z laboratorium (Olimex/Lynch)
    examples/          — źródła przykładów (lab 6, 8, 9, 11, szablon)
    test_run.js        — testy: kompilacja + scenariusze + zrzuty PNG
    test_compat.js     — testy zgodności z oryginalnymi projektami
```

Aby zmienić przykłady lub pliki biblioteki:
edytuj `tools/examples/*.c` i uruchom `node tools/build_projfiles.js`.

Testy (wymagany Node.js): `node tools/test_run.js` oraz
`node tools/test_compat.js` — zrzuty ekranu trafiają do `tools/out/`.

## Licencja i materiały źródłowe

* Kod symulatora — licencja **MIT** (plik `LICENSE` w katalogu głównym).
* Sterownik wyświetlacza, czcionki i obraz demo (`pcf8833u8_lcd.c`, `fonts.h`,
  `bmp.h`) bazują na kodzie edukacyjnym **Jamesa P. Lyncha** („Nokia 6100 LCD
  Display Driver”, 2007) oraz przykładach **Olimex** dla SAM7-EX256 (Slavcho
  Tomov, © Olimex 2006) — nagłówki autorów zachowane w plikach.
* Pozostałe bitmapy (`bmp132.h`, `bmpChoinka.h`) to **grafika własna
  generowana programowo** — bez materiałów osób trzecich.
* Instrukcje laboratoryjne (PDF, autor: dr inż. Wojciech Surtel, Politechnika
  Lubelska) **nie wchodzą w skład repozytorium** — korzystaj z materiałów
  udostępnianych na zajęciach.
* Wbudowane przykłady mają charakter **poglądowy** i nie zastępują
  samodzielnego rozwiązania zadań laboratoryjnych.
* Nazwy Olimex, Atmel/Microchip, Nokia, Philips użyte wyłącznie opisowo
  (oznaczenie zgodności ze sprzętem).
