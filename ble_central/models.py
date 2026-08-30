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
