#pragma once
#include <Arduino.h>
#include <ArduinoBLE.h>

typedef struct {
  float voltage;
  uint8_t percentage;
  uint32_t charging;
} BatteryData;

void initBattery();
BatteryData readBatteryData();

