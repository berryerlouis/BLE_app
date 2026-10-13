#include "Battery.h"

static float readBatteryVoltage();
static uint8_t readBatteryPercentage(float voltage);
static bool isUsbPowerPresent();

namespace {
constexpr float adcReferenceVoltage = 3.3f;
constexpr int adcResolution = 12;
constexpr float adcMaximumValue = (1 << adcResolution) - 1;
constexpr float batteryDividerRatio = 3.09f;
constexpr uint8_t batteryAdcSampleCount = 16;
}

void initBattery() {
  pinMode(PIN_VBAT_ENABLE, OUTPUT);
  digitalWrite(PIN_VBAT_ENABLE, LOW);
  analogReadResolution(adcResolution);
}


BatteryData readBatteryData() {
  BatteryData data{};
  data.voltage = readBatteryVoltage();
  data.percentage = readBatteryPercentage(data.voltage);
  data.charging = isUsbPowerPresent();
  return data;
}

static float readBatteryVoltage() {
  uint32_t rawValueSum = 0;
  for (uint8_t sample = 0; sample < batteryAdcSampleCount; ++sample) {
    rawValueSum += analogRead(PIN_VBAT);
  }

  const float rawValue = static_cast<float>(rawValueSum) / batteryAdcSampleCount;
  return rawValue * (adcReferenceVoltage / adcMaximumValue) * batteryDividerRatio;
}

static uint8_t readBatteryPercentage(float voltage) {
  struct BatteryPoint {
    float voltage;
    uint8_t percentage;
  };

  static const BatteryPoint dischargeCurve[] = {
    {4.20f, 100}, {4.10f, 90}, {4.00f, 80}, {3.90f, 60},
    {3.80f, 40}, {3.70f, 20}, {3.60f, 10}, {3.30f, 0},
  };

  if (voltage >= dischargeCurve[0].voltage) {
    return 100;
  }

  constexpr size_t pointCount = sizeof(dischargeCurve) / sizeof(dischargeCurve[0]);
  for (size_t index = 1; index < pointCount; ++index) {
    const BatteryPoint& upperPoint = dischargeCurve[index - 1];
    const BatteryPoint& lowerPoint = dischargeCurve[index];
    if (voltage >= lowerPoint.voltage) {
      const float range = upperPoint.voltage - lowerPoint.voltage;
      const float fraction = (voltage - lowerPoint.voltage) / range;
      return static_cast<uint8_t>(lowerPoint.percentage +
                                  fraction * (upperPoint.percentage - lowerPoint.percentage));
    }
  }

  return 0;
}

static bool isUsbPowerPresent() {
  return (NRF_POWER->USBREGSTATUS & POWER_USBREGSTATUS_VBUSDETECT_Msk) != 0;
}

