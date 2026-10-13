
#include <ArduinoBLE.h>

#include "Led_rgb.h"
#include "Ble.h"
#include "Imu.h"
#include "Battery.h"



ImuData imuData;
BatteryData batteryData;

void setup() {

  // Serial init
  //Serial.begin(9600);
   
  // LED init
  initLed();
  setLedRedColor(true);

  //Imu init
  initImu(2.5);

  // Battery init
  initBattery();

  // BLE init
  initBle();
  setLedRedColor(false);
}

void loop() {
  setLedBlueColor(false);
  // Wait for a central device to connect
  if (!waitForCentral()) {
    // No link right now: keep sampling and buffer the readings so they can be
    // replayed, correctly timestamped, once a central reconnects.
    imuData = getImuData();
    batteryData = readBatteryData();
    bufferOfflineSample(imuData, batteryData);
    return;
  }
  setLedBlueColor(true);

  while (isCentralConnected())
  {
    // Read IMU and battery data and send via BLE
    imuData = getImuData();
    batteryData = readBatteryData();
    sendBleData(imuData, batteryData);
  }
  resumeBleAdvertising();
  //Serial.println("BLE central disconnected");
}
