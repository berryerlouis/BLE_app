"""Data models matching the C structs sent by the IMU_Capture Arduino sketch."""
from __future__ import annotations

import struct
import time
from dataclasses import asdict, dataclass

# Matches: struct { float aX,aY,aZ; float gX,gY,gZ; float temp; } (packed, little-endian)
_IMU_STRUCT = struct.Struct("<7f")
# Matches: struct { float voltage; uint8_t percentage; }, padded to 8 bytes by default ARM alignment
_BATTERY_STRUCT = struct.Struct("<fB3x")


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

    @classmethod
    def from_bytes(cls, data: bytes) -> "BatteryData":
        voltage, percentage = _BATTERY_STRUCT.unpack(data)
        return cls(voltage=voltage, percentage=percentage)

    def to_dict(self) -> dict:
        return {"type": "battery", "timestamp": time.time(), "voltage": self.voltage, "percentage": self.percentage}
