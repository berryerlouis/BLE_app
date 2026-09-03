"""BLE central that discovers and connects to multiple IMU_Capture satellites.

Uses bleak so it runs on Linux (BlueZ, e.g. Raspberry Pi) as well as Windows/macOS.
Every satellite is identified by its BLE address and streamed independently, so several
"IMU Satellite" peripherals can be connected to and monitored at the same time.
"""
from __future__ import annotations

import asyncio
import logging
import time

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice
from bleak.exc import BleakError

from .models import BatteryData, ImuData

log = logging.getLogger("ble_central")


class DeviceManager:
    """Continuously scans for matching satellites and keeps one streaming session per device."""

    def __init__(self, ble_config: dict, on_data: "asyncio.Queue[dict]"):
        self._cfg = ble_config
        self._queue = on_data
        self._stop = asyncio.Event()
        self._sessions: dict[str, asyncio.Task] = {}
        self._scanner: BleakScanner | None = None
        # BlueZ forgets devices that stopped advertising, so a stale BLEDevice makes
        # connect() fail with "device 'dev_XX_..' not found": always reconnect with the latest one.
        self._devices: dict[str, BLEDevice] = {}
        self._seen_events: dict[str, asyncio.Event] = {}
        self._nearby: dict[str, str] = {}
        # Throttle RSSI broadcasts: (last_rssi, last_emit_time) per device address.
        self._last_rssi_emit: dict[str, tuple[int, float]] = {}
        # Last BLE lifecycle state emitted per device: advertising/connecting/connected/subscribed/disconnected.
        self._link_state: dict[str, str] = {}
        # WinRT (Windows) can't reliably resolve GATT services for two devices at once,
        # so only one connect+discovery runs at a time even with multiple satellites.
        self._connect_lock = asyncio.Lock()

    def stop(self) -> None:
        self._stop.set()

    def _advertised_names(self) -> set[str]:
        """Lower-cased BLE names accepted as satellites; accepts a single string or a list."""
        raw = self._cfg.get("advertised_names") or self._cfg.get("advertised_name") or self._cfg["device_name"]
        if isinstance(raw, str):
            raw = [raw]
        return {n.strip().lower() for n in raw if n and n.strip()}

    async def run_forever(self) -> None:
        """Watch BLE advertisements and spawn one connection session per discovered satellite."""
        display_name = self._cfg["device_name"]
        target_names = self._advertised_names()
        service_uuid = self._cfg["imu_service_uuid"].lower()

        def detection_callback(device: BLEDevice, advertisement_data) -> None:
            name = (advertisement_data.local_name or device.name or "").strip()
            self._nearby[device.address] = name or "<no name>"
            # Advertisements often omit the name, so the service UUID is the reliable match.
            uuids = {u.lower() for u in (advertisement_data.service_uuids or [])}
            if name.lower() not in target_names and service_uuid not in uuids:
                return
            self._devices[device.address] = device
            self._seen_events.setdefault(device.address, asyncio.Event()).set()
            self._emit_rssi(device.address, advertisement_data.rssi)
            # Still just advertising as long as no GATT link is up; once connected the
            # satellite normally stops advertising, so this won't fire during a live session.
            if self._link_state.get(device.address) not in ("connecting", "connected", "subscribed"):
                self._emit_status(device.address, display_name, "advertising")
            if device.address in self._sessions:
                return
            log.info("Discovered satellite '%s' (%s), advertised as '%s'", display_name, device.address, name)
            self._sessions[device.address] = asyncio.create_task(self._run_session(device, display_name))

        log.info("Scanning continuously for satellites advertising %s...", sorted(target_names))
        self._scanner = BleakScanner(detection_callback=detection_callback)
        await self._scanner.start()
        heartbeat = asyncio.create_task(self._log_scan_heartbeat())
        try:
            await self._stop.wait()
        finally:
            heartbeat.cancel()
            await self._scanner.stop()
            for task in list(self._sessions.values()):
                task.cancel()
            await asyncio.gather(*self._sessions.values(), heartbeat, return_exceptions=True)

    async def _log_scan_heartbeat(self) -> None:
        """Periodically report what the adapter sees, to diagnose 'no satellite found'."""
        period = self._cfg.get("scan_heartbeat_s", 30)
        while not self._stop.is_set():
            await self._sleep(period)
            if self._stop.is_set():
                return
            if self._sessions:
                continue
            if self._nearby:
                listing = ", ".join(f"{addr} '{n}'" for addr, n in sorted(self._nearby.items())[:10])
                log.warning(
                    "No satellite advertising %s yet. %d BLE device(s) seen: %s",
                    sorted(self._advertised_names()), len(self._nearby), listing,
                )
            else:
                log.warning("No BLE advertisement received at all - check that the adapter is up (hciconfig / bluetoothctl).")

    async def _run_session(self, device: BLEDevice, name: str) -> None:
        """Keep a single satellite connected, retrying on disconnect until stop() is called."""
        delay = self._cfg["reconnect_delay_s"]
        rediscover_timeout = self._cfg.get("rediscover_timeout_s", 30)
        address = device.address
        try:
            while not self._stop.is_set():
                self._seen_events.setdefault(address, asyncio.Event()).clear()
                try:
                    await self._connect_and_stream(self._devices.get(address, device), name)
                except BleakError as exc:
                    log.warning("BLE error for %s (%s): %s", name, address, exc)
                except Exception:
                    log.exception("Session error for %s (%s)", name, address)
                if self._stop.is_set():
                    break
                # Reconnect as soon as the satellite advertises again instead of waiting out
                # the full delay first; only fall back to the fixed delay if it stays silent.
                if await self._wait_for_advertisement(address, rediscover_timeout):
                    log.info("%s (%s) re-advertised, reconnecting", name, address)
                else:
                    log.info("%s (%s) silent for %ss, retrying anyway", name, address, rediscover_timeout)
                    await self._sleep(delay)
        finally:
            self._sessions.pop(address, None)
            self._seen_events.pop(address, None)

    async def _wait_for_advertisement(self, address: str, timeout: float) -> bool:
        """Wait until the satellite advertises again so BlueZ holds a fresh device object."""
        event = self._seen_events.setdefault(address, asyncio.Event())
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def _sleep(self, delay: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass

    def _emit_rssi(self, address: str, rssi: int | None) -> None:
        """Push an rssi update to the UI, throttled to avoid flooding the queue/DB."""
        if rssi is None:
            return
        now = time.time()
        last_rssi, last_time = self._last_rssi_emit.get(address, (None, 0.0))
        if last_rssi is not None and abs(rssi - last_rssi) < 5 and (now - last_time) < 10:
            return
        self._last_rssi_emit[address] = (rssi, now)
        self._queue.put_nowait({"type": "rssi", "device_id": address, "rssi": rssi, "timestamp": now})

    def _emit_status(self, address: str, name: str, state: str) -> None:
        """Push a BLE lifecycle transition (advertising/connecting/connected/subscribed/disconnected)."""
        if self._link_state.get(address) == state:
            return
        self._link_state[address] = state
        connected = state in ("connected", "subscribed")
        self._queue.put_nowait(
            {
                "type": "status",
                "device_id": address,
                "device_name": name,
                "connected": connected,
                "state": state,
                "timestamp": time.time(),
            }
        )

    async def _connect_and_stream(self, device: BLEDevice, name: str) -> None:
        address = device.address
        log.info("Connecting to %s (%s)", name, address)
        self._emit_status(address, name, "connecting")
        client = BleakClient(device, winrt={"use_cached_services": False})
        async with self._connect_lock:
            await client.connect()
        try:
            self._emit_status(address, name, "connected")
            log.info("Connected to %s. Subscribing to notifications...", address)

            def imu_handler(_sender, data: bytearray) -> None:
                item = ImuData.from_bytes(bytes(data)).to_dict()
                item.update(device_id=address, device_name=name)
                self._queue.put_nowait(item)

            def battery_handler(_sender, data: bytearray) -> None:
                item = BatteryData.from_bytes(bytes(data)).to_dict()
                item.update(device_id=address, device_name=name)
                self._queue.put_nowait(item)

            await client.start_notify(self._cfg["imu_data_char_uuid"], imu_handler)
            await client.start_notify(self._cfg["battery_data_char_uuid"], battery_handler)
            self._emit_status(address, name, "subscribed")

            while client.is_connected and not self._stop.is_set():
                await asyncio.sleep(1)
        finally:
            if client.is_connected:
                await client.disconnect()
            self._emit_status(address, name, "disconnected")
            log.info("Disconnected from %s (%s)", name, address)
