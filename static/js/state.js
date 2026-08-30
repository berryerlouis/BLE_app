/**
 * Application State Store
 */
import { CONFIG } from './config.js';

class StateStore {
  constructor() {
    this.devices = new Map(); // device_id -> device object
    this.currentDeviceId = null;
    this.currentDeviceLog = [];
    this.serverConnected = false;
    
    // Sessions (Matches)
    this.sessions = [];
    this.activeSession = null;
    this.selectedSessionId = null; // null => live active session, number => historical past session

    // UI state
    this.searchQuery = '';
    this.filterStatus = 'all'; // 'all' | 'connected' | 'alert'
    this.sortField = 'last_update'; // 'last_update' | 'name' | 'mag' | 'temp' | 'threshold'
    this.sortOrder = 'desc'; // 'asc' | 'desc'
    this.realtimeEnabled = true;
    this.logSortOrder = 'desc'; // 'desc' (recent first) | 'asc'
    this.logFilterType = 'all'; // 'all' | 'imu' | 'impact' | 'battery' | 'status'

    // Max recorded G value per device for this session
    this.maxGSession = new Map(); // device_id -> max |a|

    // Event listeners
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(event, payload) {
    for (const listener of this.listeners) {
      try {
        listener(event, payload);
      } catch (err) {
        console.error('State listener error:', err);
      }
    }
  }

  setServerConnected(connected) {
    this.serverConnected = connected;
    this.notify('server_status_changed', { connected });
  }

  setSessions(sessionsList, activeSession = null) {
    this.sessions = sessionsList || [];
    if (activeSession) {
      this.activeSession = activeSession;
    } else {
      this.activeSession = this.sessions.find((s) => s.is_active) || this.sessions[0] || null;
    }
    if (!this.selectedSessionId && this.activeSession) {
      this.selectedSessionId = this.activeSession.id;
    }
    this.notify('sessions_updated', {
      sessions: this.sessions,
      activeSession: this.activeSession,
      selectedSessionId: this.selectedSessionId,
    });
  }

  setSelectedSessionId(sessionId) {
    // No-op guard: prevents redundant reloads and re-entrant notify loops when a view both
    // reacts to 'selected_session_changed' and calls this setter directly with the same id.
    if (this.selectedSessionId === sessionId) return;
    this.selectedSessionId = sessionId;
    this.notify('selected_session_changed', {
      selectedSessionId: this.selectedSessionId,
      session: this.getSelectedSession(),
      isHistorical: this.isViewingHistorical(),
    });
  }

  getSelectedSession() {
    return this.sessions.find((s) => s.id === this.selectedSessionId) || this.activeSession;
  }

  isViewingHistorical() {
    if (!this.selectedSessionId || !this.activeSession) return false;
    return this.selectedSessionId !== this.activeSession.id;
  }

  setDevices(deviceList) {
    this.devices.clear();
    for (const d of deviceList) {
      this.devices.set(d.device_id, d);
      // init session max G if IMU data is present
      if (d.aX !== undefined) {
        const mag = Math.sqrt(d.aX ** 2 + d.aY ** 2 + d.aZ ** 2);
        this.updateMaxG(d.device_id, mag);
      }
    }
    this.notify('devices_updated', { devices: this.devices });
  }

  updateMaxG(deviceId, currentG) {
    const prev = this.maxGSession.get(deviceId) || 0;
    if (currentG > prev) {
      this.maxGSession.set(deviceId, currentG);
    }
  }

  getMaxG(deviceId) {
    return this.maxGSession.get(deviceId) || 0;
  }

  clearSessionMaxG() {
    this.maxGSession.clear();
  }

  handleWebSocketMessage(msg) {
    // Handle session lifecycle events
    if (msg.type === 'session_created') {
      this.activeSession = msg.session;
      this.sessions = [msg.session, ...this.sessions.map((s) => ({ ...s, is_active: false }))];
      this.selectedSessionId = msg.session.id;
      this.clearSessionMaxG();
      this.notify('sessions_updated', {
        sessions: this.sessions,
        activeSession: this.activeSession,
        selectedSessionId: this.selectedSessionId,
      });
      return;
    } else if (msg.type === 'session_activated') {
      this.activeSession = msg.session;
      this.sessions = this.sessions.map((s) => ({ ...s, is_active: s.id === msg.session.id }));
      this.selectedSessionId = msg.session.id;
      this.notify('sessions_updated', {
        sessions: this.sessions,
        activeSession: this.activeSession,
        selectedSessionId: this.selectedSessionId,
      });
      return;
    } else if (msg.type === 'session_ended') {
      this.sessions = this.sessions.map((s) => (s.id === msg.session.id ? msg.session : s));
      if (this.activeSession?.id === msg.session.id) {
        this.activeSession = null;
      }
      this.selectedSessionId = msg.session.id;
      this.notify('sessions_updated', {
        sessions: this.sessions,
        activeSession: this.activeSession,
        selectedSessionId: this.selectedSessionId,
      });
      return;
    } else if (msg.type === 'session_deleted') {
      this.sessions = this.sessions.filter((s) => s.id !== msg.session_id);
      if (msg.active_session) this.activeSession = msg.active_session;
      if (this.selectedSessionId === msg.session_id) {
        this.selectedSessionId = this.activeSession ? this.activeSession.id : null;
      }
      this.notify('sessions_updated', {
        sessions: this.sessions,
        activeSession: this.activeSession,
        selectedSessionId: this.selectedSessionId,
      });
      return;
    }

    const id = msg.device_id;
    if (!id) return;

    const existing = this.devices.get(id) || {
      device_id: id,
      device_name: id,
      connected: false,
      state: 'disconnected',
      impact_threshold: CONFIG.DEFAULT_IMPACT_THRESHOLD,
    };

    const updated = {
      ...existing,
      device_name: msg.device_name ?? existing.device_name,
      last_update: msg.timestamp ?? Date.now() / 1000,
    };

    if (msg.type === 'status') {
      updated.connected = msg.connected;
      updated.state = msg.state || (msg.connected ? 'connected' : 'disconnected');
    } else if (msg.type === 'imu') {
      Object.assign(updated, {
        aX: msg.aX,
        aY: msg.aY,
        aZ: msg.aZ,
        gX: msg.gX,
        gY: msg.gY,
        gZ: msg.gZ,
        temp: msg.temp,
      });
      const mag = Math.sqrt(msg.aX ** 2 + msg.aY ** 2 + msg.aZ ** 2);
      this.updateMaxG(id, mag);
    } else if (msg.type === 'battery') {
      updated.battery_voltage = msg.voltage;
      updated.battery_percentage = msg.percentage;
    } else if (msg.type === 'rssi') {
      updated.rssi = msg.rssi;
    } else if (msg.type === 'label') {
      updated.label_name = msg.label_name;
      updated.label_number = msg.label_number;
    } else if (msg.type === 'threshold') {
      updated.impact_threshold = msg.impact_threshold;
    } else if (msg.type === 'impact') {
      updated.impact_alert = true;
      updated.impact_value = msg.impact_value;
      updated.impact_threshold = msg.impact_threshold;
      if (msg.impact_value) this.updateMaxG(id, msg.impact_value);
    } else if (msg.type === 'impact_reset') {
      updated.impact_alert = false;
      updated.impact_value = undefined;
    }

    this.devices.set(id, updated);
    this.notify('device_updated', { deviceId: id, device: updated, message: msg });

    // If currently viewing this device in LIVE mode, update log
    if (this.currentDeviceId === id && !this.isViewingHistorical()) {
      this.currentDeviceLog.push(msg);
      if (this.currentDeviceLog.length > CONFIG.MAX_LOG_LINES) {
        this.currentDeviceLog.shift();
      }
      this.notify('current_device_log_appended', { message: msg });
    }
  }

  setCurrentDevice(deviceId, initialLog = []) {
    this.currentDeviceId = deviceId;
    this.currentDeviceLog = initialLog.slice(-CONFIG.MAX_LOG_LINES);
    this.notify('current_device_changed', {
      deviceId,
      device: deviceId ? this.devices.get(deviceId) : null,
      logs: this.currentDeviceLog,
      sessionId: this.selectedSessionId,
    });
  }

  getCurrentDevice() {
    return this.currentDeviceId ? this.devices.get(this.currentDeviceId) : null;
  }

  getFilteredAndSortedDevices() {
    const list = Array.from(this.devices.values());
    
    // Filter
    const filtered = list.filter((d) => {
      // Status filter
      if (this.filterStatus === 'connected' && !d.connected) return false;
      if (this.filterStatus === 'alert' && !d.impact_alert) return false;
      
      // Search filter
      if (this.searchQuery.trim()) {
        const query = this.searchQuery.toLowerCase();
        const name = (d.label_name || '').toLowerCase();
        const num = d.label_number !== undefined ? String(d.label_number) : '';
        const id = (d.device_id || '').toLowerCase();
        const dName = (d.device_name || '').toLowerCase();
        if (!name.includes(query) && !num.includes(query) && !id.includes(query) && !dName.includes(query)) {
          return false;
        }
      }
      return true;
    });

    // Sort
    filtered.sort((a, b) => {
      let valA = 0;
      let valB = 0;
      if (this.sortField === 'last_update') {
        valA = a.last_update || 0;
        valB = b.last_update || 0;
      } else if (this.sortField === 'name') {
        const nameA = (a.label_name || a.device_name || a.device_id || '').toLowerCase();
        const nameB = (b.label_name || b.device_name || b.device_id || '').toLowerCase();
        return this.sortOrder === 'asc' ? nameA.localeCompare(nameB) : nameB.localeCompare(nameA);
      } else if (this.sortField === 'mag') {
        valA = a.aX !== undefined ? Math.sqrt(a.aX ** 2 + a.aY ** 2 + a.aZ ** 2) : -1;
        valB = b.aX !== undefined ? Math.sqrt(b.aX ** 2 + b.aY ** 2 + b.aZ ** 2) : -1;
      } else if (this.sortField === 'temp') {
        valA = a.temp !== undefined ? a.temp : -999;
        valB = b.temp !== undefined ? b.temp : -999;
      } else if (this.sortField === 'threshold') {
        valA = a.impact_threshold ?? CONFIG.DEFAULT_IMPACT_THRESHOLD;
        valB = b.impact_threshold ?? CONFIG.DEFAULT_IMPACT_THRESHOLD;
      }

      return this.sortOrder === 'asc' ? valA - valB : valB - valA;
    });

    return filtered;
  }
}

export const state = new StateStore();

