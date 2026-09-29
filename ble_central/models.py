"""Data models matching the C structs sent by the IMU_Capture Arduino sketch."""
from __future__ import annotations

import struct
import time
from dataclasses import asdict, dataclass
from math import isfinite

# Legacy firmware sends seven floats (28 bytes). Current firmware appends the
# connection RSSI as an int16 and ARM aligns the record to 32 bytes.
_IMU_LEGACY_STRUCT = struct.Struct("<7f")
_IMU_STRUCT = struct.Struct("<7fh2x")
# Matches: struct { float voltage; uint8_t percentage; uint32_t powerFlags; }, padded to 12 bytes by default ARM alignment.
# powerFlags bit 0 reports USB power and bit 1 reports a battery detected on VBAT.
# Legacy firmware sends 5-byte packed or 8-byte padded values and does not report either state.
_BATTERY_STRUCT = struct.Struct("<fB3xI")
_BATTERY_LEGACY_STRUCT = struct.Struct("<fB3x")
_BATTERY_COMPACT_STRUCT = struct.Struct("<fB")
_MAX_SINGLE_CELL_VOLTAGE = 4.35
# Matches: struct { uint64_t epochMs; ImuData imu; } (packed) sent while replaying offline data
_IMU_HISTORY_LEGACY_STRUCT = struct.Struct("<Q7f")
_IMU_HISTORY_STRUCT = struct.Struct("<Q7fh2x")
# Matches: struct { uint64_t epochMs; BatteryData battery; } (packed, BatteryData is 12 bytes)
_BATTERY_HISTORY_STRUCT = struct.Struct("<QfB3xI")
_BATTERY_HISTORY_LEGACY_STRUCT = struct.Struct("<QfB3x")
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
    rssi: int | None = None

    @classmethod
    def from_bytes(cls, data: bytes) -> "ImuData":
        if len(data) == _IMU_LEGACY_STRUCT.size:
            return cls(*_IMU_LEGACY_STRUCT.unpack(data))
        a_x, a_y, a_z, g_x, g_y, g_z, temp, rssi = _IMU_STRUCT.unpack(data)
        return cls(a_x, a_y, a_z, g_x, g_y, g_z, temp, rssi if -127 <= rssi < 0 else None)

    def to_dict(self) -> dict:
        result = {"type": "imu", "timestamp": time.time(), **asdict(self)}
        if self.rssi is None:
            result.pop("rssi")
        return result


@dataclass
class BatteryData:
    voltage: float
    percentage: int
    charging: bool
    battery_present: bool | None
    raw_len: int
    raw_hex: str

    @classmethod
    def from_bytes(cls, data: bytes) -> "BatteryData":
        if len(data) == _BATTERY_COMPACT_STRUCT.size:
            voltage, percentage = _BATTERY_COMPACT_STRUCT.unpack(data)
            charging = False
            battery_present = None
        elif len(data) == _BATTERY_LEGACY_STRUCT.size:
            voltage, percentage = _BATTERY_LEGACY_STRUCT.unpack(data)
            charging = False
            battery_present = None
        else:
            voltage, percentage, power_flags = _BATTERY_STRUCT.unpack(data)
            charging = bool(power_flags & 1)
            battery_present = bool(power_flags & 2)

        if not isfinite(voltage) or voltage < 0 or voltage > _MAX_SINGLE_CELL_VOLTAGE:
            voltage = 0.0
            percentage = 0

        percentage = max(0, min(100, int(percentage)))
        if percentage == 0:
            voltage = 0.0

        return cls(
            voltage=voltage,
            percentage=percentage,
            charging=charging,
            battery_present=battery_present,
            raw_len=len(data),
            raw_hex=data.hex(),
        )

    def to_dict(self) -> dict:
        return {
            "type": "battery",
            "timestamp": time.time(),
            "voltage": self.voltage,
            "percentage": self.percentage,
            "charging": self.charging,
            "battery_present": self.battery_present,
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
    rssi: int | None = None

    @classmethod
    def from_bytes(cls, data: bytes) -> "ImuHistorySample":
        if len(data) == _IMU_HISTORY_LEGACY_STRUCT.size:
            return cls(*_IMU_HISTORY_LEGACY_STRUCT.unpack(data))
        epoch_ms, aX, aY, aZ, gX, gY, gZ, temp, rssi = _IMU_HISTORY_STRUCT.unpack(data)
        return cls(epoch_ms, aX, aY, aZ, gX, gY, gZ, temp, rssi if -127 <= rssi < 0 else None)

    def to_dict(self) -> dict:
        result = {
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
        if self.rssi is not None:
            result["rssi"] = self.rssi
        return result


@dataclass
class BatteryHistorySample:
    """One battery reading buffered by the satellite while disconnected, replayed on reconnect."""

    epoch_ms: int
    voltage: float
    percentage: int
    charging: bool
    battery_present: bool | None

    @classmethod
    def from_bytes(cls, data: bytes) -> "BatteryHistorySample":
        if len(data) == _BATTERY_HISTORY_LEGACY_STRUCT.size:
            epoch_ms, voltage, percentage = _BATTERY_HISTORY_LEGACY_STRUCT.unpack(data)
            charging = False
            battery_present = None
        else:
            epoch_ms, voltage, percentage, power_flags = _BATTERY_HISTORY_STRUCT.unpack(data)
            charging = bool(power_flags & 1)
            battery_present = bool(power_flags & 2)
        if not isfinite(voltage) or voltage < 0 or voltage > _MAX_SINGLE_CELL_VOLTAGE:
            voltage = 0.0
            percentage = 0
        percentage = max(0, min(100, int(percentage)))
        return cls(epoch_ms, voltage, percentage, charging, battery_present)

    def to_dict(self) -> dict:
        return {
            "type": "battery",
            "historical": True,
            "timestamp": self.epoch_ms / 1000.0,
            "voltage": self.voltage,
            "percentage": self.percentage,
            "charging": self.charging,
            "battery_present": self.battery_present,
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

