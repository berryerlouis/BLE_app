"""Data models matching the C structs sent by the IMU_Capture Arduino sketch."""
from __future__ import annotations

import struct
import time
from dataclasses import asdict, dataclass
from math import isfinite

# Matches: struct { float aX,aY,aZ; float gX,gY,gZ; float temp; } (packed, little-endian)
_IMU_STRUCT = struct.Struct("<7f")
# Matches: struct { float voltage; uint8_t percentage; }, padded to 8 bytes by default ARM alignment
_BATTERY_STRUCT = struct.Struct("<fB3x")
_BATTERY_COMPACT_STRUCT = struct.Struct("<fB")
_MAX_SINGLE_CELL_VOLTAGE = 4.35
# Matches: struct { uint64_t epochMs; ImuData imu; } (packed) sent while replaying offline data
_IMU_HISTORY_STRUCT = struct.Struct("<Q7f")
# Matches: struct { uint64_t epochMs; BatteryData battery; } (packed, BatteryData still padded to 8 bytes)
_BATTERY_HISTORY_STRUCT = struct.Struct("<QfB3x")
# Matches: struct { uint32_t pendingImu; uint32_t pendingBattery; uint8_t backfilling; } (packed)
_SYNC_STATUS_STRUCT = struct.Struct("<IIB")


@dataclass
class ImuData:
    aX: float
    aY: float
    aZ: float
    gX: float
    gY: float
    gZ: float
    temp: float

    @classmethod
    def from_bytes(cls, data: bytes) -> "ImuData":
        return cls(*_IMU_STRUCT.unpack(data))

    def to_dict(self) -> dict:
        return {"type": "imu", "timestamp": time.time(), **asdict(self)}


@dataclass
class BatteryData:
    voltage: float
    percentage: int
    raw_len: int
    raw_hex: str

    @classmethod
    def from_bytes(cls, data: bytes) -> "BatteryData":
        if len(data) == _BATTERY_COMPACT_STRUCT.size:
            voltage, percentage = _BATTERY_COMPACT_STRUCT.unpack(data)
        else:
            voltage, percentage = _BATTERY_STRUCT.unpack(data)

        if not isfinite(voltage) or voltage < 0 or voltage > _MAX_SINGLE_CELL_VOLTAGE:
            voltage = 0.0
            percentage = 0

        percentage = max(0, min(100, int(percentage)))
        if percentage == 0:
            voltage = 0.0

        return cls(voltage=voltage, percentage=percentage, raw_len=len(data), raw_hex=data.hex())

    def to_dict(self) -> dict:
        return {
            "type": "battery",
            "timestamp": time.time(),
            "voltage": self.voltage,
            "percentage": self.percentage,
            "raw_len": self.raw_len,
            "raw_hex": self.raw_hex,
        }


@dataclass
class ImuHistorySample:
    """One IMU reading buffered by the satellite while disconnected, replayed on reconnect."""

    epoch_ms: int
    aX: float
    aY: float
    aZ: float
    gX: float
    gY: float
    gZ: float
    temp: float

    @classmethod
    def from_bytes(cls, data: bytes) -> "ImuHistorySample":
        epoch_ms, aX, aY, aZ, gX, gY, gZ, temp = _IMU_HISTORY_STRUCT.unpack(data)
        return cls(epoch_ms, aX, aY, aZ, gX, gY, gZ, temp)

    def to_dict(self) -> dict:
        return {
            "type": "imu",
            "historical": True,
            "timestamp": self.epoch_ms / 1000.0,
            "aX": self.aX,
            "aY": self.aY,
            "aZ": self.aZ,
            "gX": self.gX,
            "gY": self.gY,
            "gZ": self.gZ,
            "temp": self.temp,
        }


@dataclass
class BatteryHistorySample:
    """One battery reading buffered by the satellite while disconnected, replayed on reconnect."""

    epoch_ms: int
    voltage: float
    percentage: int

    @classmethod
    def from_bytes(cls, data: bytes) -> "BatteryHistorySample":
        epoch_ms, voltage, percentage = _BATTERY_HISTORY_STRUCT.unpack(data)
        if not isfinite(voltage) or voltage < 0 or voltage > _MAX_SINGLE_CELL_VOLTAGE:
            voltage = 0.0
            percentage = 0
        percentage = max(0, min(100, int(percentage)))
        return cls(epoch_ms, voltage, percentage)

    def to_dict(self) -> dict:
        return {
            "type": "battery",
            "historical": True,
            "timestamp": self.epoch_ms / 1000.0,
            "voltage": self.voltage,
            "percentage": self.percentage,
        }


@dataclass
class SyncStatus:
    """Reports the satellite's offline-buffer replay progress after a reconnect."""

    pending_imu: int
    pending_battery: int
    backfilling: bool

    @classmethod
    def from_bytes(cls, data: bytes) -> "SyncStatus":
        pending_imu, pending_battery, backfilling = _SYNC_STATUS_STRUCT.unpack(data)
        return cls(pending_imu, pending_battery, bool(backfilling))

