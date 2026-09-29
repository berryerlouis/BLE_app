/**
 * Main Application Orchestrator
 */
import { CONFIG } from './config.js?v=20260929-mobile-chart';
import { api } from './api.js';
import { state } from './state.js?v=20260929-mobile-status';
import { wsClient } from './websocket.js?v=20260929-mobile-status';
import { ChartManager } from './charts.js?v=20260929-graph-history';
import { ModalView } from './views/modalView.js?v=20260929-mobile-status';
import { DashboardView } from './views/dashboardView.js?v=20260929-mobile-status';
import { PlayerView } from './views/playerView.js?v=20260929-graph-history';
import { progressBar, sessionLoader } from './utils.js';

class App {
  constructor() {
    this.chartManager = new ChartManager();
    this.modalView = new ModalView();
    this.pendingDashboardUpdates = new Map();
    this.dashboardUpdateTimer = null;

    this.dashboardView = new DashboardView(
      (deviceId) => this.showPlayerView(deviceId),
      (deviceId) => this.modalView.showLabelModal(deviceId, 'edit'),
      () => this.modalView.showSessionModal(),
      () => this.modalView.showEndSessionModal(),
      (sessionId) => this.switchSession(sessionId),
      () => this.renameSelectedSession(),
      () => this.deleteSelectedSession(),
      (version) => this.modalView.showFirmwareModal(version)
    );

    this.playerView = new PlayerView(
      this.chartManager,
      () => this.showDashboardView(),
      (deviceId) => this.modalView.showLabelModal(deviceId, 'edit'),
      (sessionId) => this.switchSession(sessionId)
    );

    // Global elements
    this.serverDot = document.getElementById('conn-dot');
    this.serverText = document.getElementById('conn-text');
    this.usbSatelliteStatus = document.getElementById('usb-satellite-status');
    this.footerVersion = document.getElementById('footer-version');
    this.footerAuthor = document.getElementById('footer-author');
    this.updateStatus = document.getElementById('update-status');

    this.init();
  }

  async init() {
    // 1. Initialize charts with DOM canvas elements
    const accelCanvas = document.getElementById('accelChart');
    const gyroCanvas = document.getElementById('gyroChart');
    const tempCanvas = document.getElementById('tempChart');
    if (accelCanvas && gyroCanvas && tempCanvas) {
      this.chartManager.initCharts(accelCanvas, gyroCanvas, tempCanvas);
    }

    // 2. Subscribe to state changes
    state.subscribe((event, payload) => this.handleStateEvent(event, payload));

    // 3. Load initial data
    await this.loadInitialData();
    await this.loadVersionInfo();

    // 4. Start WebSocket connection
    wsClient.connect();

    // 5. Periodic update check
    this.checkForUpdates();
    setInterval(() => this.checkForUpdates(), CONFIG.UPDATE_CHECK_INTERVAL_MS);

    // 5b. Live match duration ticker (updates the header status card every second)
    setInterval(() => this.dashboardView.tickMatchTimer(), 1000);

    // USB-connected satellites do not advertise their serial presence over the WebSocket.
    await this.refreshUsbSatelliteStatus();
    setInterval(() => this.refreshUsbSatelliteStatus(), 5000);

    // 6. Show initial dashboard view
    this.showDashboardView();

    // 7. Initialize Lucide icons
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }

  async refreshUsbSatelliteStatus() {
    if (!this.usbSatelliteStatus) return;

    try {
      const ports = await api.fetchSerialPorts();
      const satellites = ports.filter((port) => port.likely_satellite);
      const count = satellites.length;
      const portNames = satellites.map((port) => port.device).join(', ');

      this.usbSatelliteStatus.classList.toggle('hidden', count === 0);
      this.usbSatelliteStatus.title = count
        ? `${count} satellite${count > 1 ? 's' : ''} connecté${count > 1 ? 's' : ''} en USB : ${portNames}`
        : '';
      this.usbSatelliteStatus.innerHTML = count
        ? `<i data-lucide="usb"></i><span>${count} satellite${count > 1 ? 's' : ''} USB</span>`
        : '';
      if (count && window.lucide) window.lucide.createIcons({ root: this.usbSatelliteStatus });
    } catch (err) {
      console.warn('Failed to refresh USB satellite status:', err);
      this.usbSatelliteStatus.classList.add('hidden');
    }
  }

  handleStateEvent(event, payload) {
    if (event === 'server_status_changed') {
      const isOnline = payload.connected;
      if (this.serverDot) {
        this.serverDot.className = `status-dot ${isOnline ? 'dot-online' : 'dot-offline'}`;
      }
      if (this.serverText) {
        this.serverText.textContent = isOnline ? 'Serveur connecté' : 'Serveur déconnecté';
      }
    } else if (event === 'sessions_updated') {
      this.dashboardView.renderSessionSelector();
      if (state.currentDeviceId) {
        this.playerView.renderSessionOptions();
        this.playerView.updateHistoricalSessionBanner();
      }
    } else if (event === 'selected_session_changed') {
      this.dashboardView.renderSessionSelector();
      if (state.currentDeviceId) {
        this.playerView.open(state.currentDeviceId, payload.selectedSessionId);
      }
    } else if (event === 'devices_updated') {
      if (!state.currentDeviceId) {
        this.dashboardView.render();
      }
    } else if (event === 'firmware_flash') {
      this.modalView.handleFirmwareProgress(payload);
    } else if (event === 'device_sync_completed') {
      if (state.currentDeviceId === payload.deviceId && !state.isViewingHistorical()) {
        this.playerView.rebuildAll();
      }
    } else if (event === 'device_updated') {
      if (!state.currentDeviceId) {
        this.queueDashboardUpdate(payload.deviceId, payload.device);
      }
      // Check if newly discovered satellite needs label prompt
      if (payload.deviceId) {
        this.modalView.queueLabelPrompt(payload.deviceId);
      }
      // If currently viewing this player, feed live message
      if (state.currentDeviceId === payload.deviceId) {
        this.playerView.handleLiveMessage(payload.message);
      }
    }
  }

  queueDashboardUpdate(deviceId, device) {
    this.pendingDashboardUpdates.set(deviceId, device);
    if (this.dashboardUpdateTimer) return;

    this.dashboardUpdateTimer = setTimeout(() => {
      this.dashboardUpdateTimer = null;
      const updates = this.pendingDashboardUpdates;
      this.pendingDashboardUpdates = new Map();
      for (const [updatedDeviceId, updatedDevice] of updates) {
        this.dashboardView.updateDevice(updatedDeviceId, updatedDevice);
      }
    }, CONFIG.DASHBOARD_REFRESH_INTERVAL_MS);
  }

  async switchSession(sessionId) {
    const session = state.sessions.find((s) => s.id === sessionId);
    const isLive = sessionId === null;
    const label = isLive
      ? 'Retour au temps réel...'
      : session ? `Chargement de « ${session.name} »...` : 'Chargement de la session...';

    progressBar.start();
    progressBar.set(30);

    if (isLive) {
      sessionLoader.show(label);
      sessionLoader.update(50, `${label} Récupération des satellites...`);
      try {
        const deviceList = await api.fetchDevices();
        state.setDevices(deviceList);
        state.setSelectedSessionId(null);
        this.dashboardView.render();
      } catch (err) {
        console.error('Failed to load live devices:', err);
      }
      sessionLoader.hide();
    } else if (state.currentDeviceId) {
      // state.setSelectedSessionId below triggers 'selected_session_changed', which reopens the
      // player view for us — avoid fetching the device log twice.
      state.setSelectedSessionId(sessionId);
    } else {
      sessionLoader.show(label);
      sessionLoader.update(25);
      state.setSelectedSessionId(sessionId);
      // Do not leave the current live snapshot visible while the archived match loads.
      state.setDevices([]);
      try {
        sessionLoader.update(50, `${label} Récupération des satellites...`);
        const deviceList = await api.fetchDevices(sessionId);
        if (state.selectedSessionId !== sessionId) return;
        progressBar.set(80);
        sessionLoader.update(85, `${label} Affichage...`);
        state.setDevices(deviceList);
        this.dashboardView.render();
      } catch (err) {
        console.error('Failed to load session devices:', err);
      }
      sessionLoader.hide();
    }
    progressBar.complete();
  }

  async renameSelectedSession() {
    const session = state.getSelectedSession();
    if (!session || !state.isViewingHistorical()) return;

    const name = window.prompt('Nouveau nom du match :', session.name);
    if (name === null) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      window.alert('Le nom du match est requis.');
      return;
    }

    try {
      const updatedSession = await api.updateSession(session.id, { name: trimmedName });
      state.sessions = state.sessions.map((item) => (item.id === updatedSession.id ? { ...item, ...updatedSession } : item));
      state.notify('sessions_updated', { sessions: state.sessions, activeSession: state.activeSession });
    } catch (err) {
      console.error('Failed to rename session:', err);
      window.alert(`Impossible de renommer le match : ${err.message}`);
    }
  }

  async deleteSelectedSession() {
    const session = state.getSelectedSession();
    if (!session || !state.isViewingHistorical()) return;

    const confirmed = window.confirm(
      `Supprimer définitivement « ${session.name} » et toutes ses données ? Cette action est irréversible.`
    );
    if (!confirmed) return;

    try {
      const result = await api.deleteSession(session.id);
      state.handleWebSocketMessage({
        type: 'session_deleted',
        session_id: session.id,
        active_session: result.active_session,
      });
      await this.switchSession(null);
    } catch (err) {
      console.error('Failed to delete session:', err);
      window.alert(`Impossible de supprimer le match : ${err.message}`);
    }
  }

  showDashboardView() {
    this.playerView.hide();
    this.dashboardView.show();
    window.history.replaceState(null, '', window.location.pathname);
  }

  showPlayerView(deviceId) {
    this.dashboardView.hide();
    const sessionId = state.selectedSessionId;
    this.playerView.open(deviceId, sessionId);
    window.history.replaceState(null, '', `?player=${encodeURIComponent(deviceId)}`);
  }

  async loadInitialData() {
    try {
      const [sessions, activeSession, deviceList] = await Promise.all([
        api.fetchSessions().catch(() => []),
        api.fetchActiveSession().catch(() => null),
        api.fetchDevices().catch(() => []),
      ]);
      state.setSessions(sessions, activeSession);
      if (activeSession?.is_active) {
        state.setSelectedSessionId(activeSession.id);
      }
      state.setDevices(deviceList);
      this.dashboardView.render();

      // Check URL params for direct link to player
      const params = new URLSearchParams(window.location.search);
      const playerParam = params.get('player');
      if (playerParam && state.devices.has(playerParam)) {
        this.showPlayerView(playerParam);
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  }

  async loadVersionInfo() {
    try {
      const info = await api.fetchVersion();
      if (this.footerVersion) this.footerVersion.textContent = info.version || '--';
      if (this.footerAuthor) this.footerAuthor.textContent = info.author || '--';
    } catch (err) {
      console.error('Failed to load version:', err);
    }
  }

  async checkForUpdates() {
    try {
      const info = await api.checkUpdate();
      if (info.update_available) {
        this.modalView.showUpdateModal(info.current_version, info.latest_version);
        if (this.updateStatus) {
          this.updateStatus.innerHTML = `
            <span class="update-badge">
              <i data-lucide="sparkles"></i> v${info.latest_version} disponible
            </span>
          `;
          if (window.lucide) window.lucide.createIcons();
        }
      } else {
        if (this.updateStatus) this.updateStatus.textContent = info.error ? info.error : '';
      }
    } catch (err) {
      console.error('Failed to check for updates:', err);
    }
  }
}

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
