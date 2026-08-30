/**
 * Main Application Orchestrator
 */
import { CONFIG } from './config.js';
import { api } from './api.js';
import { state } from './state.js';
import { wsClient } from './websocket.js';
import { ChartManager } from './charts.js';
import { ModalView } from './views/modalView.js';
import { DashboardView } from './views/dashboardView.js';
import { PlayerView } from './views/playerView.js';
import { progressBar } from './utils.js';

class App {
  constructor() {
    this.chartManager = new ChartManager();
    this.modalView = new ModalView();

    this.dashboardView = new DashboardView(
      (deviceId) => this.showPlayerView(deviceId),
      (deviceId) => this.modalView.showLabelModal(deviceId, 'edit'),
      () => this.modalView.showSessionModal(),
      (sessionId) => this.switchSession(sessionId)
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

    // 6. Show initial dashboard view
    this.showDashboardView();

    // 7. Initialize Lucide icons
    if (window.lucide) {
      window.lucide.createIcons();
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
    } else if (event === 'device_updated') {
      if (!state.currentDeviceId) {
        this.dashboardView.updateDevice(payload.deviceId, payload.device);
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

  async switchSession(sessionId) {
    progressBar.start();
    state.setSelectedSessionId(sessionId);
    progressBar.set(40);

    if (state.currentDeviceId) {
      await this.playerView.open(state.currentDeviceId, sessionId);
    } else {
      try {
        const deviceList = await api.fetchDevices(sessionId);
        progressBar.set(80);
        state.setDevices(deviceList);
        this.dashboardView.render();
      } catch (err) {
        console.error('Failed to load session devices:', err);
      }
    }
    progressBar.complete();
  }

  showDashboardView() {
    this.playerView.hide();
    this.dashboardView.show();
    window.history.replaceState(null, '', window.location.pathname);
  }

  showPlayerView(deviceId) {
    this.dashboardView.hide();
    const sessionId = state.selectedSessionId || state.activeSession?.id;
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
