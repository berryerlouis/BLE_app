"""Data models matching the C structs sent by the IMU_Capture Arduino sketch."""
from __future__ import annotations

import struct
import time
from dataclasses import asdict, dataclass

# Matches: struct { float aX,aY,aZ; float gX,gY,gZ; float temp; } (packed, little-endian)
_IMU_STRUCT = struct.Struct("<7f")
_BATTERY_VOLTAGE_STRUCT = struct.Struct("<f")


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
class BatteryVoltage:
    voltage: float

    @classmethod
    def from_bytes(cls, data: bytes) -> "BatteryVoltage":
        return cls(*_BATTERY_VOLTAGE_STRUCT.unpack(data))

    def to_dict(self) -> dict:
        return {"type": "battery_voltage", "timestamp": time.time(), "voltage": self.voltage}


@dataclass
class BatteryLevel:
    percentage: int

    @classmethod
    def from_bytes(cls, data: bytes) -> "BatteryLevel":
        return cls(percentage=data[0])

    def to_dict(self) -> dict:
        return {"type": "battery_level", "timestamp": time.time(), "percentage": self.percentage}
