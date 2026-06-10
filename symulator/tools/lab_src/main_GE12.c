#include <targets\AT91SAM7.h>
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

#define LCD_BACKLIGHT  PIOB_SODR_P20

#define STUDENT_NAME  "Szymon Wojcik"

// MENU
typedef struct menu_struct menu_t;
struct menu_struct {
    const char *name;
    menu_t *next;
    menu_t *prev;
    menu_t *child;                 // poziom niżej (podmenu)
    menu_t *parent;                // poziom wyżej
    void (*menu_function)(void);   // funkcja "programu"
};

// top-level
static menu_t MENU1, MENU2, MENU3;
// submenu MENU1
static menu_t M1_P1, M1_P2;
// submenu MENU2
static menu_t M2_P1, M2_P2;
// submenu MENU3
static menu_t M3_P1, M3_TO_M1;

// wskaznik na pozycje
static menu_t *currentPointer = 0;

// ======================================================
// funkcje pomocniczne do obslugi przyciskow
// ======================================================
static inline unsigned char pressedA(unsigned int mask) { return ((PIOA_PDSR & mask) == 0); }
static inline unsigned char pressedB(unsigned int mask) { return ((PIOB_PDSR & mask) == 0); }

static void wait_release_A(unsigned int mask) { while (pressedA(mask)) { } Delaya(200000); }
static void wait_release_B(unsigned int mask) { while (pressedB(mask)) { } Delaya(200000); }

// ======================================================
// FUNKCJE POMOCNICZE DO RYSOWANIA GUI
// ======================================================
static void draw_frame(void) {
    LCDSetRect(0, 0, 131, 131, FILL, GREEN);
    LCDSetRect(4, 4, 127, 127, NOFILL, BLACK);
    LCDPutStr("LSW", 112, 10, SMALL, BLACK, GREEN);
}

static void draw_button(int x0, int y0, int x1, int y1, const char *txt) {
    LCDSetRect(x0, y0, x1, y1, FILL, YELLOW);
    LCDSetRect(x0, y0, x1, y1, NOFILL, BLACK);
    LCDPutStr((char*)txt, x0 + 6, y0 + 8, SMALL, BLACK, YELLOW);
}

static void draw_marker(int x0, int y0) {
    LCDSetRect(x0, y0, x0 + 16, y0 + 16, FILL, YELLOW);
    LCDSetRect(x0, y0, x0 + 16, y0 + 16, NOFILL, BLACK);
    LCDPutChar('<', x0 + 3, y0 + 6, SMALL, BLACK, YELLOW);
}

// kasowanie markera (tlo jest zielone)
static void erase_marker(int x0, int y0) {
    LCDSetRect(x0, y0, x0 + 16, y0 + 16, FILL, GREEN);
}

// indeks elementu w 2-elementowym submenu (0/1)
static unsigned char submenu_index(menu_t *head, menu_t *cur) {
    if (!head || !cur) return 0;
    if (cur == head) return 0;
    return 1;
}

static unsigned char is_main_level(void) {
    return (currentPointer && currentPointer->parent == 0);
}

// ======================================================
// Rysowanie ekranów (statycznie - bez markera)
// ======================================================
static void render_main_static(void) {
    draw_frame();

    LCDPutStr((char*)STUDENT_NAME, 10, 20, MEDIUM, BLACK, GREEN);

    // 3 pozycje -> MENU 1, MENU 2, MENU 3 (wyżej)
    int bx0 = 35, bx1 = 53;
    int by0 = 10, by1 = 80;

    draw_button(bx0,      by0, bx1,      by1, "MENU 1");
    draw_button(bx0 + 26, by0, bx1 + 26, by1, "MENU 2");
    draw_button(bx0 + 52, by0, bx1 + 52, by1, "MENU 3");
}

static void render_submenu_static(menu_t *top) {
    draw_frame();

    // tytuł submenu (rodzic)
    draw_button(12, 10, 30, 70, top->name);

    // 2 elementy submenu
    menu_t *head = top->child;
    draw_button(35, 10, 53, 80, head->name);
    draw_button(35+26, 10, 52+26, 80, head->next->name);
}

// Marker: pozycje dla MAIN i SUBMENU 
static void marker_pos_main(menu_t *ptr, int *x, int *y) {
    int idx = 0;
    if (ptr == &MENU1) idx = 0;
    else if (ptr == &MENU2) idx = 1;
    else idx = 2;


    const int bx0 = 35;      // x0 pierwszego przycisku
    const int bx1 = 53;      // x1 pierwszego przycisku
    const int step = 26;     // odstęp między przyciskami (w osi X)
    const int markerW = 16;  // szerokość markera (16px)

    // srodkowanie markera
    int btnW = (bx1 - bx0);               
    int centerOffset = (btnW - markerW) / 2;   // zwykle wyjdzie 1

    *x = bx0 + idx * step + centerOffset;
    *y = 84; 
}
static void marker_pos_sub(menu_t *ptr, int *x, int *y) {
    menu_t *top = ptr->parent;
    menu_t *head = top->child;
    unsigned char idx = submenu_index(head, ptr);

    *x = (idx == 0) ? 35 : 35+26;
    *y = 90;
}

// czy dwa wskaźniki są w tym samym "kontekście UI":
// - oba w MAIN, albo
// - oba w tym samym SUBMENU (ten sam parent)
static unsigned char same_ui_context(menu_t *a, menu_t *b) {
    if (!a || !b) return 0;

    unsigned char aMain = (a->parent == 0);
    unsigned char bMain = (b->parent == 0);

    if (aMain != bMain) return 0;
    if (aMain) return 1;
    return (a->parent == b->parent);
}

// ======================================================
// Render: pełny lub tylko marker
// ======================================================
static void ui_render_full(void) {
    if (is_main_level()) {
        render_main_static();
        int x, y;
        marker_pos_main(currentPointer, &x, &y);
        draw_marker(x, y);
    } else {
        menu_t *top = currentPointer->parent;
        render_submenu_static(top);
        int x, y;
        marker_pos_sub(currentPointer, &x, &y);
        draw_marker(x, y);
    }
}

static void ui_update_marker_only(menu_t *oldPtr) {
    // jak zmienił się poziom/rodzic -> pełny render
    if (!same_ui_context(oldPtr, currentPointer)) {
        ui_render_full();
        return;
    }

    int ox, oy, nx, ny;

    if (oldPtr->parent == 0) {
        marker_pos_main(oldPtr, &ox, &oy);
        marker_pos_main(currentPointer, &nx, &ny);
    } else {
        marker_pos_sub(oldPtr, &ox, &oy);
        marker_pos_sub(currentPointer, &nx, &ny);
    }

    if (ox == nx && oy == ny) return;

    erase_marker(ox, oy);
    draw_marker(nx, ny);
}

// ======================================================
// Ekrany programow - wyjście SW1
// ======================================================
static void program_wait_exit_sw1(void) {
    while (!pressedB(SW_1)) { }
    wait_release_B(SW_1);
}

static void program_screen(const char *title, const char *l1, const char *l2) {
    draw_frame();
    draw_button(12, 10, 30, 95, title);

    LCDPutStr((char*)l1, 55, 10, MEDIUM, BLACK, GREEN);
    LCDPutStr((char*)l2, 70, 10, MEDIUM, BLACK, GREEN);

    LCDPutStr("SW1 - wyjscie", 112, 20, SMALL, BLACK, GREEN);
}

static void prog_m1_p1(void) {
    program_screen("MENU1 / P1", "Wybrales PROGRAM 1.", "Demo: okrag + X.");
    LCDSetCircle(70, 70, 18, BLACK);
    LCDSetLine(55, 55, 85, 85, BLACK);
    LCDSetLine(55, 85, 85, 55, BLACK);
    program_wait_exit_sw1();
}

static void prog_m1_p2(void) {
    program_screen("MENU1 / P2", "Wybrales PROGRAM 2.", "Demo: prostokaty.");
    LCDSetRect(50, 35, 100, 115, NOFILL, BLACK);
    LCDSetRect(55, 40, 95, 110, NOFILL, BLACK);
    program_wait_exit_sw1();
}

static void prog_m2_p1(void) {
    program_screen("MENU2 / P1", "Pomiar/Status (przyklad).", "STATUS: OK");
    LCDPutStr("STATUS: OK", 90, 20, LARGE, BLACK, GREEN);
    program_wait_exit_sw1();
}

static void prog_m2_p2(void) {
    program_screen("MENU2 / P2", "Komunikat diagnostyczny.", "UART: READY");
    LCDPutStr("UART: READY", 90, 20, LARGE, BLACK, GREEN);
    program_wait_exit_sw1();
}

static void prog_m3_p1(void) {
    program_screen("MENU3 / P1", "Wybrales PROGRAM 1.", "Demo: linie.");
    LCDSetLine(40, 20, 40, 120, BLACK);
    LCDSetLine(92, 20, 92, 120, BLACK);
    program_wait_exit_sw1();
}

// ======================================================
// Inicjalizacja menu (listy dwukierunkowe + parent/child)
// ======================================================
static void menu_init(void) {
    // MAIN (circular)
    MENU1.name = "MENU 1";
    MENU2.name = "MENU 2";
    MENU3.name = "MENU 3";

    MENU1.next = &MENU2; MENU1.prev = &MENU3;
    MENU2.next = &MENU3; MENU2.prev = &MENU1;
    MENU3.next = &MENU1; MENU3.prev = &MENU2;

    MENU1.parent = 0; MENU2.parent = 0; MENU3.parent = 0;
    MENU1.menu_function = 0; MENU2.menu_function = 0; MENU3.menu_function = 0;

    // MENU1 submenu (2 elementy circular)
    M1_P1.name = "PROGRAM 1";
    M1_P2.name = "PROGRAM 2";

    M1_P1.next = &M1_P2; M1_P1.prev = &M1_P2;
    M1_P2.next = &M1_P1; M1_P2.prev = &M1_P1;

    M1_P1.child = 0; M1_P2.child = 0;
    M1_P1.parent = &MENU1; M1_P2.parent = &MENU1;

    M1_P1.menu_function = prog_m1_p1;
    M1_P2.menu_function = prog_m1_p2;

    // MENU2 submenu
    M2_P1.name = "PROGRAM 1";
    M2_P2.name = "PROGRAM 2";

    M2_P1.next = &M2_P2; M2_P1.prev = &M2_P2;
    M2_P2.next = &M2_P1; M2_P2.prev = &M2_P1;

    M2_P1.child = 0; M2_P2.child = 0;
    M2_P1.parent = &MENU2; M2_P2.parent = &MENU2;

    M2_P1.menu_function = prog_m2_p1;
    M2_P2.menu_function = prog_m2_p2;

    // MENU3 submenu: PROGRAM1 + MENU1 (skrót)
    M3_P1.name = "PROGRAM 1";
    M3_TO_M1.name = "MENU 1";

    M3_P1.next = &M3_TO_M1; M3_P1.prev = &M3_TO_M1;
    M3_TO_M1.next = &M3_P1; M3_TO_M1.prev = &M3_P1;

    M3_P1.parent = &MENU3;
    M3_TO_M1.parent = &MENU3;

    M3_P1.menu_function = prog_m3_p1;
    M3_P1.child = 0;

    // skrót: wejście do submenu MENU1
    M3_TO_M1.menu_function = 0;
    M3_TO_M1.child = &M1_P1;

    // dzieci MAIN
    MENU1.child = &M1_P1;
    MENU2.child = &M2_P1;
    MENU3.child = &M3_P1;

    // start: main menu na MENU1
    currentPointer = &MENU1;
}

// ======================================================
// Inicjalizacja IO
// ======================================================
static void io_init(void) {
    PMC_PCER = PMC_PCER_PIOA | PMC_PCER_PIOB;

    // JOY_UP, JOY_DOWN jako wejścia
    PIOA_PER   = JOY_UP | JOY_DOWN;
    PIOA_ODR   = JOY_UP | JOY_DOWN;

    // SW1, SW2 jako wejścia
    PIOB_PER   = SW_1 | SW_2 | LCD_BACKLIGHT;
    PIOB_ODR   = SW_1 | SW_2;

    // backlight jako wyjście
    PIOB_OER   = LCD_BACKLIGHT;
    PIOB_SODR |= LCD_BACKLIGHT;
}

// ======================================================
// Odczyt zdarzen - polling
// ======================================================
typedef enum {
    EV_NONE = 0,
    EV_JOY_UP,
    EV_JOY_DOWN,
    EV_SW1,
    EV_SW2
} event_t;

static event_t read_event(void) {
    if (pressedA(JOY_UP)) {
        Delaya(150000);
        wait_release_A(JOY_UP);
        return EV_JOY_UP;
    }
    if (pressedA(JOY_DOWN)) {
        Delaya(150000);
        wait_release_A(JOY_DOWN);
        return EV_JOY_DOWN;
    }
    if (pressedB(SW_1)) {
        Delaya(150000);
        wait_release_B(SW_1);
        return EV_SW1;
    }
    if (pressedB(SW_2)) {
        Delaya(150000);
        wait_release_B(SW_2);
        return EV_SW2;
    }
    return EV_NONE;
}

// ======================================================
// Logika sterowania
// ======================================================
static menu_t *mainReturnOverride = 0;
static void handle_sw2(void) {
    if (is_main_level()) {
        // MAIN: SW2 -> schodzimy do child
        if (currentPointer->child)
            currentPointer = currentPointer->child;
    } else {
        // SUBMENU: SW2 -> wraca do MAIN
        // wyjątek: jeśli jesteśmy na skrócie MENU3->MENU1, wróć do MENU1 (a nie do MENU3)
        if (currentPointer == &M3_TO_M1) {
            mainReturnOverride = &MENU1;
        }

        if (mainReturnOverride) {
            currentPointer = mainReturnOverride;  // marker w MAIN będzie na MENU1
            mainReturnOverride = 0;               // skasuj override po użyciu
        } else {
            currentPointer = currentPointer->parent;
        }
    }
}


static void handle_sw1(void) {
    // SW1 w MAIN jest ignorowane
    if (is_main_level()) {
        return;
    }

    // w podmenu SW1 uruchamia program albo wchodzi w child (MENU3->MENU1)
    if (currentPointer->menu_function) {
        currentPointer->menu_function();
    } else if (currentPointer->child) {
        currentPointer = currentPointer->child;
    }
}

// ======================================================
// main
// ======================================================
int main(void) {
    io_init();

    InitLCD();
    LCDClearScreen();

    menu_init();
    ui_render_full();

    while (1) {
        event_t ev = read_event();
        if (ev == EV_NONE) continue;

        menu_t *old = currentPointer;

        // poruszanie sie po aktualnym poziomie TYLOK MARKEREM
        if (ev == EV_JOY_UP) {
            currentPointer = currentPointer->prev;
            ui_update_marker_only(old);
        }
        else if (ev == EV_JOY_DOWN) {
            currentPointer = currentPointer->next;
            ui_update_marker_only(old);
        }
        else if (ev == EV_SW2) {
            handle_sw2();
            ui_render_full();   // zmiana poziomu -> pełny render
        }
        else if (ev == EV_SW1) {
            handle_sw1();

            // po programie UI było nadpisane -> odtwórz pełny ekran
            if (!is_main_level()) {
                ui_render_full();
            }
        }
    }

    return 0;
}
