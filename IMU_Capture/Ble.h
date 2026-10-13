#pragma once

#include <ArduinoBLE.h>
#include "Battery.h"
#include "Imu.h"

void initBle();
void resumeBleAdvertising();
bool waitForCentral( void );
bool isCentralConnected();
bool sendBleData(const ImuData& imuData, const BatteryData& batteryData);
// Called instead of sendBleData() while no central is connected: keeps sampling and
// stores timestamped readings so they can be replayed once the link is re-established.
void bufferOfflineSample(const ImuData& imuData, const BatteryData& batteryData);