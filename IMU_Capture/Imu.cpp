#include <LSM6DS3.h>
#include <Wire.h>
#include "Imu.h"

//Create a instance of class LSM6DS3
LSM6DS3 lsm6ds3(I2C_MODE, 0x6A);    //I2C device address 0x6A
float accelerationThreshold = 2.5; // threshold of significant in G's


void initImu(float threshold) {
  accelerationThreshold = threshold;
  if ( lsm6ds3.begin() != 0) {
    //Serial.println("IMU initialization error");
  }
}


ImuData getImuData( void ) {
  ImuData data{};
  data.accel.aX = lsm6ds3.readFloatAccelX();
  data.accel.aY = lsm6ds3.readFloatAccelY();
  data.accel.aZ = lsm6ds3.readFloatAccelZ();
  data.gyro.gX = lsm6ds3.readFloatGyroX();
  data.gyro.gY = lsm6ds3.readFloatGyroY();
  data.gyro.gZ = lsm6ds3.readFloatGyroZ();
  data.temp.temp = lsm6ds3.readTempC();
  return data;
}
