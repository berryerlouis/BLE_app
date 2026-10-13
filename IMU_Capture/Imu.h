#pragma once

#include <ArduinoBLE.h>


typedef struct {
  float aX, aY, aZ;
} ImuAccelData;

typedef struct {
  float gX, gY, gZ;
} ImuGyroData;

typedef struct {
  float temp;
} ImuTempData;

typedef struct {
  ImuAccelData accel;
  ImuGyroData gyro;
  ImuTempData temp;
  int16_t rssi;
} ImuData;

void initImu(float threshold);
ImuData getImuData( void );