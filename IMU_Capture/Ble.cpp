#include "Ble.h"
#include <ArduinoBLE.h>     
#include "Imu.h"
#include "Battery.h"
#include "Led_rgb.h"
#include "HistoryBuffer.h"
#include "Version.h"

// Cordio link layer entry point, exported by the mbed core but not by ArduinoBLE.
extern "C" void LlSetAdvTxPower(int8_t advTxPwr);

namespace {
constexpr int8_t txPowerDbm = 8;              // maximum supported by the nRF52840

constexpr uint16_t advertisingIntervalUnits = 32;   // 20 ms, fastest allowed: reconnects sooner
constexpr uint16_t minConnectionIntervalUnits = 12; // 15 ms
constexpr uint16_t maxConnectionIntervalUnits = 24; // 30 ms
constexpr uint16_t supervisionTimeoutUnits = 200;   // 2 s: tolerates brief RF fades without delaying reconnects

constexpr char imuServiceUuid[] = "2A6F0001-8A7D-4E8B-9C7D-4B2A0B9C0001";
constexpr char imuDataCharacteristicUuid[] = "2A6F0002-8A7D-4E8B-9C7D-4B2A0B9C0001";
constexpr char batteryDataCharacteristicUuid[] = "2A6F0003-8A7D-4E8B-9C7D-4B2A0B9C0001";
constexpr char timeSyncCharacteristicUuid[] = "2A6F0004-8A7D-4E8B-9C7D-4B2A0B9C0001";
constexpr char imuHistoryCharacteristicUuid[] = "2A6F0005-8A7D-4E8B-9C7D-4B2A0B9C0001";
constexpr char batteryHistoryCharacteristicUuid[] = "2A6F0006-8A7D-4E8B-9C7D-4B2A0B9C0001";
constexpr char syncStatusCharacteristicUuid[] = "2A6F0007-8A7D-4E8B-9C7D-4B2A0B9C0001";

// 10 Hz keeps thirty simultaneous satellites within a practical BLE radio budget.
constexpr unsigned long imuUpdateIntervalMs = 100;
constexpr unsigned long batteryUpdateIntervalMs = 1000;
constexpr unsigned long rssiUpdateIntervalMs = 5000;

// Offline sample storage: sized to fit comfortably in the nRF52840's 256 KB RAM
// alongside the BLE stack. At the cadence above this covers ~200 s of IMU data
// and ~2 min of battery data disconnected; oldest samples are dropped past that.
constexpr uint16_t imuHistoryCapacity = 2000;
constexpr uint16_t batteryHistoryCapacity = 120;
// A connection interval can be as high as 30 ms. Keep replay below that
// minimum link capacity once live telemetry and status notifications are included.
constexpr unsigned long backfillImuIntervalMs = 75;
constexpr unsigned long backfillBatteryIntervalMs = 500;
constexpr unsigned long syncStatusIntervalMs = 500;

// Wire layout shared with the Python central (see ble_central/models.py): a reading
// paired with the satellite's best estimate of the wall-clock time it was taken.
struct __attribute__((packed)) ImuHistorySample {
  uint64_t epochMs;
  ImuData imu;
};

struct __attribute__((packed)) BatteryHistorySample {
  uint64_t epochMs;
  BatteryData battery;
};

struct __attribute__((packed)) SyncStatus {
  uint32_t pendingImu;
  uint32_t pendingBattery;
  uint8_t backfilling;
};

static_assert(sizeof(ImuData) == 32, "ImuData layout must match models.py");
static_assert(sizeof(ImuHistorySample) == 40, "ImuHistorySample layout must match models.py");
static_assert(sizeof(BatteryHistorySample) == 20, "BatteryHistorySample layout must match models.py");
static_assert(sizeof(SyncStatus) == 9, "SyncStatus layout must match models.py");

BLEService imuService(imuServiceUuid);
BLECharacteristic imuDataCharacteristic(
    imuDataCharacteristicUuid, BLERead | BLENotify, sizeof(ImuData));
BLECharacteristic batteryDataCharacteristic(
  batteryDataCharacteristicUuid, BLERead | BLENotify, sizeof(BatteryData));
BLECharacteristic timeSyncCharacteristic(
    timeSyncCharacteristicUuid, BLEWrite, sizeof(uint64_t));
BLECharacteristic imuHistoryCharacteristic(
    imuHistoryCharacteristicUuid, BLERead | BLENotify, sizeof(ImuHistorySample));
BLECharacteristic batteryHistoryCharacteristic(
    batteryHistoryCharacteristicUuid, BLERead | BLENotify, sizeof(BatteryHistorySample));
BLECharacteristic syncStatusCharacteristic(
    syncStatusCharacteristicUuid, BLERead | BLENotify, sizeof(SyncStatus));
BLEService batteryService("180F");
BLEUnsignedCharCharacteristic batteryLevelCharacteristic(
    "2A19", BLERead | BLENotify);

// Lets the central app read the running firmware version and offer a USB update when a newer
// one is available (see BLE_app/ble_central/firmware.py). Standard Device Information Service.
BLEService deviceInfoService("180A");
BLEStringCharacteristic firmwareRevisionCharacteristic("2A26", BLERead, 20);

ImuData imuDataSum{};
ImuAccelData peakAccel{};
float peakAccelMagnitudeSquared = -1.0F;
unsigned int imuSampleCount = 0;
int16_t latestRssi = 0;

// Time sync: the central writes its current epoch (ms) on every connection; the
// satellite derives absolute timestamps from millis() until the next resync.
uint64_t syncEpochMs = 0;
unsigned long syncMillisAtSync = 0;
bool timeSynced = false;

HistoryBuffer<ImuHistorySample, imuHistoryCapacity> imuHistory;
HistoryBuffer<BatteryHistorySample, batteryHistoryCapacity> batteryHistory;
bool backfilling = false;
unsigned long lastBackfillImuMs = 0;
unsigned long lastBackfillBatteryMs = 0;

void notifySyncStatus(bool force);

uint64_t currentEpochMs() {
  return syncEpochMs + static_cast<uint64_t>(millis() - syncMillisAtSync);
}

void resetImuAverage() {
  imuDataSum = {};
  peakAccel = {};
  peakAccelMagnitudeSquared = -1.0F;
  imuSampleCount = 0;
}

void addImuSample(const ImuData& imuData) {
  const float accelMagnitudeSquared =
      imuData.accel.aX * imuData.accel.aX +
      imuData.accel.aY * imuData.accel.aY +
      imuData.accel.aZ * imuData.accel.aZ;
  if (accelMagnitudeSquared > peakAccelMagnitudeSquared) {
    peakAccel = imuData.accel;
    peakAccelMagnitudeSquared = accelMagnitudeSquared;
  }
  imuDataSum.gyro.gX += imuData.gyro.gX;
  imuDataSum.gyro.gY += imuData.gyro.gY;
  imuDataSum.gyro.gZ += imuData.gyro.gZ;
  imuDataSum.temp.temp += imuData.temp.temp;
  ++imuSampleCount;
}

ImuData getImuAverage() {
  const float sampleCount = static_cast<float>(imuSampleCount);
  return {
    peakAccel,
    {imuDataSum.gyro.gX / sampleCount, imuDataSum.gyro.gY / sampleCount,
     imuDataSum.gyro.gZ / sampleCount},
    {imuDataSum.temp.temp / sampleCount},
    latestRssi
  };
}

// The central writes its current epoch (ms since Unix epoch, little-endian) right
// after connecting. This both (re)anchors currentEpochMs() and kicks off replay of
// whatever was buffered while disconnected.
void onTimeSyncWritten(BLEDevice /*central*/, BLECharacteristic characteristic) {
  if (characteristic.valueLength() != sizeof(uint64_t)) {
    return;
  }
  uint64_t epochMs = 0;
  memcpy(&epochMs, characteristic.value(), sizeof(epochMs));
  syncEpochMs = epochMs;
  syncMillisAtSync = millis();
  timeSynced = true;
  backfilling = !imuHistory.empty() || !batteryHistory.empty();
  notifySyncStatus(true);
}

void notifySyncStatus(bool force) {
  static unsigned long lastNotify = 0;
  const unsigned long now = millis();
  if (!force && (now - lastNotify < syncStatusIntervalMs)) {
    return;
  }
  lastNotify = now;
  const SyncStatus status{
    static_cast<uint32_t>(imuHistory.size()),
    static_cast<uint32_t>(batteryHistory.size()),
    static_cast<uint8_t>(backfilling ? 1 : 0)
  };
  syncStatusCharacteristic.writeValue(
      reinterpret_cast<const uint8_t*>(&status), sizeof(status));
}

// Drains the offline buffers over BLE notifications without bursting multiple
// history packets into a single connection event.
void driveBackfill() {
  if (!backfilling) {
    return;
  }
  const unsigned long now = millis();

  ImuHistorySample imuSample;
  if (now - lastBackfillImuMs >= backfillImuIntervalMs && imuHistory.pop(imuSample)) {
    imuHistoryCharacteristic.writeValue(
        reinterpret_cast<const uint8_t*>(&imuSample), sizeof(imuSample));
    lastBackfillImuMs = now;
  } else {
    BatteryHistorySample batterySample;
    if (now - lastBackfillBatteryMs >= backfillBatteryIntervalMs && batteryHistory.pop(batterySample)) {
    batteryHistoryCharacteristic.writeValue(
        reinterpret_cast<const uint8_t*>(&batterySample), sizeof(batterySample));
    lastBackfillBatteryMs = now;
    }
  }

  const bool done = imuHistory.empty() && batteryHistory.empty();
  if (done) {
    backfilling = false;
  }
  notifySyncStatus(done);
}

}

// BLE central device instance
BLEDevice central;

void initBle() {

  if (!BLE.begin()) {
    Serial.println("BLE initialization error");
    return;
  }

  LlSetAdvTxPower(txPowerDbm);

  BLE.setAdvertisingInterval(advertisingIntervalUnits);
  BLE.setConnectionInterval(minConnectionIntervalUnits, maxConnectionIntervalUnits);
  BLE.setSupervisionTimeout(supervisionTimeoutUnits);

  BLE.setLocalName("IMU Satellite");
  BLE.setAdvertisedService(imuService);
  imuService.addCharacteristic(imuDataCharacteristic);
  imuService.addCharacteristic(batteryDataCharacteristic);
  imuService.addCharacteristic(timeSyncCharacteristic);
  imuService.addCharacteristic(imuHistoryCharacteristic);
  imuService.addCharacteristic(batteryHistoryCharacteristic);
  imuService.addCharacteristic(syncStatusCharacteristic);
  timeSyncCharacteristic.setEventHandler(BLEWritten, onTimeSyncWritten);
  BLE.addService(imuService);
  batteryService.addCharacteristic(batteryLevelCharacteristic);
  BLE.addService(batteryService);
  deviceInfoService.addCharacteristic(firmwareRevisionCharacteristic);
  BLE.addService(deviceInfoService);

  const ImuData initialImuData{};
  const BatteryData initialBatteryData{};
  imuDataCharacteristic.writeValue(
    reinterpret_cast<const uint8_t*>(&initialImuData), sizeof(initialImuData));
  batteryDataCharacteristic.writeValue(
    reinterpret_cast<const uint8_t*>(&initialBatteryData), sizeof(initialBatteryData));
  batteryLevelCharacteristic.writeValue(static_cast<uint8_t>(0));
  firmwareRevisionCharacteristic.writeValue(FIRMWARE_VERSION);

  BLE.advertise();

  //Serial.println("BLE advertising started");
}

void resumeBleAdvertising() {
  BLE.advertise();
}

bool waitForCentral( void ) {
  BLE.poll();

  // listen for Bluetooth® Low Energy peripherals to connect:
  central = BLE.central();

  // if a central is connected to peripheral:
  if (central) {
    resetImuAverage();
    //Serial.print("BLE central connected: ");
    //Serial.println(central.address());
    return true;
  }
  return false;
}

bool isCentralConnected() {
  BLE.poll();
  return central && central.connected();
}

bool sendBleData(const ImuData& imuData, const BatteryData& batteryData) {
  static unsigned long lastImuUpdate = 0;
  static unsigned long lastBatteryUpdate = 0;
  static unsigned long lastRssiUpdate = 0;
  bool hasSentMsg = false;

  if (!central || !central.connected()) {
    return false;
  }

  const unsigned long now = millis();
  if (now - lastRssiUpdate >= rssiUpdateIntervalMs) {
    const int rssi = central.rssi();
    if (rssi >= -127 && rssi < 0) {
      latestRssi = static_cast<int16_t>(rssi);
    }
    lastRssiUpdate = now;
  }
  addImuSample(imuData);
  if (now - lastImuUpdate >= imuUpdateIntervalMs) {
    setLedGreenColor(true);
    const ImuData averagedImuData = getImuAverage();
    imuDataCharacteristic.writeValue(
        reinterpret_cast<const uint8_t*>(&averagedImuData), sizeof(averagedImuData));
    lastImuUpdate = now;
    resetImuAverage();
    hasSentMsg = true;
  }

  if (now - lastBatteryUpdate >= batteryUpdateIntervalMs) {
    setLedGreenColor(true);
    batteryDataCharacteristic.writeValue(
        reinterpret_cast<const uint8_t*>(&batteryData), sizeof(batteryData));
    batteryLevelCharacteristic.writeValue(batteryData.percentage);
    lastBatteryUpdate = now;
    hasSentMsg = true;
  }

  setLedGreenColor(false);

  driveBackfill();

  return hasSentMsg;
}

void bufferOfflineSample(const ImuData& imuData, const BatteryData& batteryData) {
  static unsigned long lastImuBuffer = 0;
  static unsigned long lastBatteryBuffer = 0;

  if (!timeSynced) {
    // No reference clock yet (e.g. very first boot, never connected before):
    // samples can't be meaningfully timestamped, so drop them rather than guess.
    return;
  }

  const unsigned long now = millis();
  addImuSample(imuData);
  if (now - lastImuBuffer >= imuUpdateIntervalMs) {
    const ImuHistorySample sample{currentEpochMs(), getImuAverage()};
    imuHistory.push(sample);
    resetImuAverage();
    lastImuBuffer = now;
  }

  if (now - lastBatteryBuffer >= batteryUpdateIntervalMs) {
    const BatteryHistorySample sample{currentEpochMs(), batteryData};
    batteryHistory.push(sample);
    lastBatteryBuffer = now;
  }
}