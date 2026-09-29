"""BLE central that discovers and connects to multiple IMU_Capture satellites.

Uses bleak so it runs on Linux (BlueZ, e.g. Raspberry Pi) as well as Windows/macOS.
Every satellite is identified by its BLE address and streamed independently, so several
"IMU Satellite" peripherals can be connected to and monitored at the same time.
"""
from __future__ import annotations

import asyncio
import logging
import struct
import sys
import time

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice
from bleak.exc import BleakError

from .models import BatteryData, BatteryHistorySample, ImuData, ImuHistorySample, SyncStatus

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
        self._dropped_messages = 0
        self._last_drop_log_time = 0.0

    def stop(self) -> None:
        self._stop.set()

    def _advertised_names(self) -> set[str]:
        """Lower-cased BLE names accepted as satellites; accepts a single string or a list."""
        raw = self._cfg.get("advertised_names") or self._cfg.get("advertised_name") or self._cfg["device_name"]
        if isinstance(raw, str):
            raw = [raw]
        return {n.strip().lower() for n in raw if n and n.strip()}

    def _owns_device(self, address: str) -> bool:
        """Assign a satellite to exactly one configured adapter across restarts."""
        adapter_count = self._cfg.get("adapter_count", 1)
        if adapter_count <= 1:
            return True
        address_value = int("".join(character for character in address if character.isalnum()), 16)
        return address_value % adapter_count == self._cfg.get("adapter_index", 0)

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
            if not self._owns_device(device.address):
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
        adapters = [self._cfg.get("adapter")]
        fallback_adapter = self._cfg.get("fallback_adapter")
        if fallback_adapter and fallback_adapter not in adapters:
            adapters.append(fallback_adapter)

        while not self._stop.is_set():
            last_error: BleakError | None = None
            active_adapter = None
            for adapter in adapters:
                scanner_options = {
                    "detection_callback": detection_callback,
                    # IMU Satellite exposes its local name in the active scan response.
                    "scanning_mode": "active",
                }
                if adapter and sys.platform == "linux":
                    scanner_options["bluez"] = {"adapter": adapter}
                self._scanner = BleakScanner(**scanner_options)
                try:
                    await self._scanner.start()
                    active_adapter = adapter
                    break
                except BleakError as exc:
                    last_error = exc
                    self._scanner = None

            if self._scanner is None:
                retry_delay = self._cfg.get("adapter_retry_delay_s", 10)
                log.warning("Unable to start BLE scan: %s. Retrying in %ss", last_error, retry_delay)
                await self._sleep(retry_delay)
                continue

            log.info("Using Bluetooth adapter %s", active_adapter or "default")

            heartbeat = asyncio.create_task(self._log_scan_heartbeat())
            try:
                await self._stop.wait()
            finally:
                heartbeat.cancel()
                await self._scanner.stop()
                await asyncio.gather(heartbeat, return_exceptions=True)

        for task in list(self._sessions.values()):
            task.cancel()
        await asyncio.gather(*self._sessions.values(), return_exceptions=True)

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
                connection_failed = False
                try:
                    await self._connect_and_stream(self._devices.get(address, device), name)
                except asyncio.TimeoutError:
                    connection_failed = True
                    log.warning("Connection to %s (%s) timed out", name, address)
                except BleakError as exc:
                    connection_failed = True
                    log.warning("BLE error for %s (%s): %s", name, address, exc)
                except Exception:
                    connection_failed = True
                    log.exception("Session error for %s (%s)", name, address)
                if self._stop.is_set():
                    break
                if connection_failed:
                    # Ignore advertisements received during the failed attempt and let
                    # BlueZ release its pending connection before trying again.
                    self._seen_events.setdefault(address, asyncio.Event()).clear()
                    await self._sleep(delay)
                    if self._stop.is_set():
                        break
                # BlueZ removes silent devices from its cache, so reconnect only after a new
                # advertisement has supplied a valid BLEDevice instance.
                while not self._stop.is_set():
                    if await self._wait_for_advertisement(address, rediscover_timeout):
                        log.info("%s (%s) re-advertised, reconnecting", name, address)
                        break
                    log.info("%s (%s) silent for %ss; waiting for advertisement", name, address, rediscover_timeout)
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

    def _enqueue(self, item: dict) -> None:
        """Keep telemetry bounded; retain lifecycle messages when the app falls behind."""
        try:
            self._queue.put_nowait(item)
            return
        except asyncio.QueueFull:
            pass

        if item.get("type") == "imu":
            self._dropped_messages += 1
            now = time.monotonic()
            if now - self._last_drop_log_time >= 10:
                log.warning("Telemetry queue full; dropped %d IMU message(s)", self._dropped_messages)
                self._dropped_messages = 0
                self._last_drop_log_time = now
            return

        try:
            self._queue.get_nowait()
            self._queue.put_nowait(item)
        except asyncio.QueueEmpty:
            return

    def _emit_rssi(self, address: str, rssi: int | None) -> None:
        """Push an rssi update to the UI, throttled to avoid flooding the queue/DB."""
        if rssi is None:
            return
        now = time.time()
        last_rssi, last_time = self._last_rssi_emit.get(address, (None, 0.0))
        if last_rssi is not None and abs(rssi - last_rssi) < 5 and (now - last_time) < 10:
            return
        self._last_rssi_emit[address] = (rssi, now)
        self._enqueue({"type": "rssi", "device_id": address, "rssi": rssi, "timestamp": now})

    def _emit_status(self, address: str, name: str, state: str) -> None:
        """Push a BLE lifecycle transition (advertising/connecting/connected/subscribed/disconnected)."""
        if self._link_state.get(address) == state:
            return
        self._link_state[address] = state
        connected = state in ("connected", "subscribed")
        self._enqueue(
            {
                "type": "status",
                "device_id": address,
                "device_name": name,
                "connected": connected,
                "state": state,
                "timestamp": time.time(),
            }
        )

    async def _sync_time(self, client: BleakClient, address: str, name: str) -> None:
        """Push our clock to the satellite so it can timestamp/replay its offline buffer."""
        epoch_ms = int(time.time() * 1000)
        await asyncio.wait_for(
            client.write_gatt_char(self._cfg["time_sync_char_uuid"], struct.pack("<Q", epoch_ms), response=True),
            timeout=self._cfg.get("gatt_setup_timeout_s", 3),
        )
        log.debug("Synced clock with %s (%s): epoch_ms=%d", name, address, epoch_ms)

    async def _start_notify(self, client: BleakClient, char_uuid: str, handler) -> None:
        """Start a notification subscription without allowing a stalled GATT request to block reconnection."""
        await asyncio.wait_for(
            client.start_notify(char_uuid, handler),
            timeout=self._cfg.get("gatt_setup_timeout_s", 3),
        )

    async def _read_firmware_version(self, client: BleakClient, address: str, name: str) -> None:
        """Reads the satellite's firmware version once per connection (Device Information Service),
        so the dashboard can show it and flag when a newer USB-flashable firmware is available.
        Older firmwares without this service just keep working without a reported version.
        """
        try:
            payload = await client.read_gatt_char(self._cfg["firmware_version_char_uuid"])
            version = bytes(payload).decode("utf-8", errors="replace").strip()
        except (BleakError, KeyError) as exc:
            log.info("Firmware version characteristic unavailable for %s (%s): %s", name, address, exc)
            return
        if not version:
            return
        self._enqueue(
            {
                "type": "firmware_version",
                "device_id": address,
                "device_name": name,
                "version": version,
                "timestamp": time.time(),
            }
        )

    async def _connect_and_stream(self, device: BLEDevice, name: str) -> None:
        address = device.address
        log.info("Connecting to %s (%s)", name, address)
        self._emit_status(address, name, "connecting")
        client_options = {}
        if sys.platform == "win32":
            client_options["winrt"] = {
                "use_cached_services": self._cfg.get("winrt_use_cached_services", False),
            }
        disconnected = asyncio.Event()

        def on_disconnect(_client: BleakClient) -> None:
            disconnected.set()

        client = BleakClient(device, disconnected_callback=on_disconnect, **client_options)
        if sys.platform == "win32":
            async with self._connect_lock:
                await client.connect(timeout=self._cfg.get("connect_timeout_s", 10))
        else:
            await client.connect(timeout=self._cfg.get("connect_timeout_s", 10))
        try:
            self._emit_status(address, name, "connected")
            log.info("Connected to %s. Subscribing to notifications...", address)

            def imu_handler(_sender, data: bytearray) -> None:
                item = ImuData.from_bytes(bytes(data)).to_dict()
                item.update(device_id=address, device_name=name)
                self._enqueue(item)

            battery_notification_logged = False

            def battery_handler(_sender, data: bytearray) -> None:
                nonlocal battery_notification_logged
                payload = bytes(data)
                try:
                    battery = BatteryData.from_bytes(payload)
                except Exception as exc:
                    log.warning("Invalid battery data from %s (%s): %d bytes (%s)", name, address, len(payload), exc)
                    return
                if not battery_notification_logged:
                    log.info(
                        "Battery data from %s (%s): %.2f V, %d%% (%d bytes)",
                        name, address, battery.voltage, battery.percentage, battery.raw_len,
                    )
                    battery_notification_logged = True
                item = battery.to_dict()
                item.update(device_id=address, device_name=name)
                self._enqueue(item)

            def battery_level_handler(_sender, data: bytearray) -> None:
                payload = bytes(data)
                if len(payload) != 1:
                    log.warning("Invalid standard battery data from %s (%s): %d bytes", name, address, len(payload))
                    return
                self._enqueue(
                    {
                        "type": "battery",
                        "timestamp": time.time(),
                        "percentage": min(100, payload[0]),
                        "device_id": address,
                        "device_name": name,
                    }
                )

            def rssi_handler(_sender, data: bytearray) -> None:
                payload = bytes(data)
                if len(payload) != 2:
                    log.warning("Invalid RSSI data from %s (%s): %d bytes", name, address, len(payload))
                    return
                rssi = struct.unpack("<h", payload)[0]
                if not -127 <= rssi < 0:
                    log.debug("Ignoring invalid RSSI from %s (%s): %d dBm", name, address, rssi)
                    return
                self._enqueue(
                    {
                        "type": "rssi",
                        "rssi": rssi,
                        "device_id": address,
                        "device_name": name,
                        "timestamp": time.time(),
                    }
                )

            def imu_history_handler(_sender, data: bytearray) -> None:
                try:
                    item = ImuHistorySample.from_bytes(bytes(data)).to_dict()
                except Exception as exc:
                    log.warning("Invalid IMU history sample from %s (%s): %s", name, address, exc)
                    return
                item.update(device_id=address, device_name=name)
                self._enqueue(item)

            def battery_history_handler(_sender, data: bytearray) -> None:
                try:
                    item = BatteryHistorySample.from_bytes(bytes(data)).to_dict()
                except Exception as exc:
                    log.warning("Invalid battery history sample from %s (%s): %s", name, address, exc)
                    return
                item.update(device_id=address, device_name=name)
                self._enqueue(item)

            def sync_status_handler(_sender, data: bytearray) -> None:
                try:
                    status = SyncStatus.from_bytes(bytes(data))
                except Exception as exc:
                    log.warning("Invalid sync status from %s (%s): %s", name, address, exc)
                    return
                self._enqueue(
                    {
                        "type": "sync_status",
                        "device_id": address,
                        "device_name": name,
                        "pending_imu": status.pending_imu,
                        "pending_battery": status.pending_battery,
                        "backfilling": status.backfilling,
                        "timestamp": time.time(),
                    }
                )

            await self._start_notify(client, self._cfg["imu_data_char_uuid"], imu_handler)
            await self._start_notify(client, self._cfg["battery_data_char_uuid"], battery_handler)
            try:
                await self._start_notify(client, self._cfg["battery_level_char_uuid"], battery_level_handler)
            except (asyncio.TimeoutError, BleakError):
                log.info("Standard battery characteristic is unavailable for %s (%s)", name, address)

            if self._cfg.get("rssi_enabled", False):
                try:
                    await self._start_notify(client, self._cfg["rssi_char_uuid"], rssi_handler)
                except (asyncio.TimeoutError, BleakError):
                    log.info("Live RSSI characteristic is unavailable for %s (%s)", name, address)

            # Offline-buffering (older firmwares won't expose these): subscribe to the replay
            # channel, then push our clock so the satellite can timestamp/flush its backlog.
            try:
                await self._start_notify(client, self._cfg["imu_history_char_uuid"], imu_history_handler)
                await self._start_notify(client, self._cfg["battery_history_char_uuid"], battery_history_handler)
                await self._start_notify(client, self._cfg["sync_status_char_uuid"], sync_status_handler)
                await self._sync_time(client, address, name)
            except (asyncio.TimeoutError, BleakError) as exc:
                log.info("Offline-buffering is unavailable for %s (%s): %s", name, address, exc)

            await self._read_firmware_version(client, address, name)

            self._emit_status(address, name, "subscribed")

            firmware_refresh_interval = self._cfg.get("firmware_version_refresh_s", 10)
            next_firmware_refresh = time.monotonic() + firmware_refresh_interval
            while client.is_connected and not self._stop.is_set():
                wait_time = min(1.0, max(0, next_firmware_refresh - time.monotonic()))
                try:
                    await asyncio.wait_for(disconnected.wait(), timeout=wait_time)
                    break
                except asyncio.TimeoutError:
                    pass
                if time.monotonic() >= next_firmware_refresh:
                    await self._read_firmware_version(client, address, name)
                    next_firmware_refresh = time.monotonic() + firmware_refresh_interval
        finally:
            if client.is_connected:
                await client.disconnect()
            self._emit_status(address, name, "disconnected")
            log.info("Disconnected from %s (%s)", name, address)
