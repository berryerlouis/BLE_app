#pragma once

#include <ArduinoBLE.h>

void initLed();
void setLedColor(bool red, bool blue, bool green);
void setLedRedColor(bool red);
void setLedBlueColor(bool blue);
void setLedGreenColor(bool green);
void toggleLedColor(bool red, bool blue, bool green);
void toggleLedRedColor(void);
void toggleLedBlueColor(void);
void toggleLedGreenColor(void);