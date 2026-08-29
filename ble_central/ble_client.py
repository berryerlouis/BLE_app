"""BLE central that discovers and connects to multiple IMU_Capture satellites.

Uses bleak so it runs on Linux (BlueZ, e.g. Raspberry Pi) as well as Windows/macOS.
Every satellite is identified by its BLE address and streamed independently, so several
"IMU Capture" peripherals can be connected to and monitored at the same time.
"""
from __future__ import annotations

import asyncio
import logging
import time

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice

from .models import BatteryLevel, BatteryVoltage, ImuData

log = logging.getLogger("ble_central")


class DeviceManager:
    """Continuously scans for matching satellites and keeps one streaming session per device."""

    def __init__(self, ble_config: dict, on_data: "asyncio.Queue[dict]"):
        self._cfg = ble_config
        self._queue = on_data
        self._stop = asyncio.Event()
        self._sessions: dict[str, asyncio.Task] = {}
        self._scanner: BleakScanner | None = None

    def stop(self) -> None:
        self._stop.set()

    async def run_forever(self) -> None:
        """Watch BLE advertisements and spawn one connection session per discovered satellite."""
        target_name = self._cfg["device_name"]

        def detection_callback(device: BLEDevice, advertisement_data) -> None:
            name = advertisement_data.local_name or device.name
            if name != target_name or device.address in self._sessions:
                return
            log.info("Discovered satellite '%s' (%s)", name, device.address)
            self._sessions[device.address] = asyncio.create_task(self._run_session(device, name))

        log.info("Scanning continuously for satellites named '%s'...", target_name)
        self._scanner = BleakScanner(detection_callback=detection_callback)
        await self._scanner.start()
        try:
            await self._stop.wait()
        finally:
            await self._scanner.stop()
            for task in list(self._sessions.values()):
                task.cancel()
            await asyncio.gather(*self._sessions.values(), return_exceptions=True)

    async def _run_session(self, device: BLEDevice, name: str) -> None:
        """Keep a single satellite connected, retrying on disconnect until stop() is called."""
        delay = self._cfg["reconnect_delay_s"]
        try:
            while not self._stop.is_set():
                try:
                    await self._connect_and_stream(device, name)
                except Exception:
                    log.exception("Session error for %s (%s)", name, device.address)
                if self._stop.is_set():
                    break
                await self._sleep(delay)
        finally:
            self._sessions.pop(device.address, None)

    async def _sleep(self, delay: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass

    async def _connect_and_stream(self, device: BLEDevice, name: str) -> None:
        address = device.address
        log.info("Connecting to %s (%s)", name, address)
        async with BleakClient(device) as client:
            await self._queue.put(
                {"type": "status", "device_id": address, "device_name": name, "connected": True, "timestamp": time.time()}
            )
            log.info("Connected to %s. Subscribing to notifications...", address)

            def imu_handler(_sender, data: bytearray) -> None:
                item = ImuData.from_bytes(bytes(data)).to_dict()
                item.update(device_id=address, device_name=name)
                self._queue.put_nowait(item)

            def battery_voltage_handler(_sender, data: bytearray) -> None:
                item = BatteryVoltage.from_bytes(bytes(data)).to_dict()
                item.update(device_id=address, device_name=name)
                self._queue.put_nowait(item)

            def battery_level_handler(_sender, data: bytearray) -> None:
                item = BatteryLevel.from_bytes(bytes(data)).to_dict()
                item.update(device_id=address, device_name=name)
                self._queue.put_nowait(item)

            await client.start_notify(self._cfg["imu_data_char_uuid"], imu_handler)
            await client.start_notify(self._cfg["battery_voltage_char_uuid"], battery_voltage_handler)
            await client.start_notify(self._cfg["battery_level_char_uuid"], battery_level_handler)

            try:
                while client.is_connected and not self._stop.is_set():
                    await asyncio.sleep(1)
            finally:
                await self._queue.put(
                    {"type": "status", "device_id": address, "device_name": name, "connected": False, "timestamp": time.time()}
                )
                log.info("Disconnected from %s (%s)", name, address)
