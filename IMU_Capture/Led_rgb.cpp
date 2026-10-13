#include "Led_rgb.h"

// LED pin configuration
const int ledPinRed = LEDR; // pin to use for the LED
const int ledPinBlue = LEDB ; // pin to use for the LED
const int ledPinGreen = LEDG; // pin to use for the LED

void initLed() {
    pinMode(ledPinRed, OUTPUT);
    pinMode(ledPinBlue, OUTPUT);
    pinMode(ledPinGreen, OUTPUT);
    setLedColor(false, false, false); // turn off all LEDs initially
}
    
void setLedColor(bool red, bool blue, bool green) {
    digitalWrite(ledPinRed, red ? LOW : HIGH);
    digitalWrite(ledPinBlue, blue ? LOW : HIGH);
    digitalWrite(ledPinGreen, green ? LOW : HIGH);
}

void setLedRedColor(bool red) {
    digitalWrite(ledPinRed, red ? LOW : HIGH);
}

void setLedBlueColor(bool blue) {
    digitalWrite(ledPinBlue, blue ? LOW : HIGH);
}

void setLedGreenColor(bool green) {
    digitalWrite(ledPinGreen, green ? LOW : HIGH);
}

void toggleLedColor(bool red, bool blue, bool green) {
    digitalWrite(ledPinRed, red ? !digitalRead(ledPinRed) : digitalRead(ledPinRed));
    digitalWrite(ledPinBlue, blue ? !digitalRead(ledPinBlue) : digitalRead(ledPinBlue));
    digitalWrite(ledPinGreen, green ? !digitalRead(ledPinGreen) : digitalRead(ledPinGreen));
}

void toggleLedRedColor(void) {
    digitalWrite(ledPinRed, !digitalRead(ledPinRed));
}

void toggleLedBlueColor(void) {
    digitalWrite(ledPinBlue, !digitalRead(ledPinBlue));
}

void toggleLedGreenColor(void) {
    digitalWrite(ledPinGreen, !digitalRead(ledPinGreen));
}