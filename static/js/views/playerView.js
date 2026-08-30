/**
 * Player Detail View (Second Page)
 */
import { api } from '../api.js';
import { state } from '../state.js';
import {
  fmt,
  calcAccelMagnitude,
  getDeviceDisplayName,
  getDeviceThreshold,
  formatDateTime,
  getBatteryStatus,
  getRssiStatus,
  getDeviceLinkState,
  escapeHtml,
  progressBar,
  sessionLoader,
} from '../utils.js';

export class PlayerView {
  constructor(chartManager, onBack, onEditLabel, onSelectSession) {
    this.chartManager = chartManager;
    this.onBack = onBack;
    this.onEditLabel = onEditLabel;
    this.onSelectSession = onSelectSession;

    this.container = document.getElementById('detail-view');
    
    // Header & Player elements
    this.backBtn = document.getElementById('back-btn');
    this.playerTitle = document.getElementById('detail-player-name');
    this.playerMac = document.getElementById('detail-player-mac');
    this.playerStatusDot = document.getElementById('detail-status-dot');
    this.playerStatusText = document.getElementById('detail-status-text');
    this.rssiIcon = document.getElementById('detail-rssi-icon');
    this.rssiLabel = document.getElementById('detail-rssi-label');
    this.rssiBadge = document.getElementById('detail-rssi-badge');
    this.editLabelBtn = document.getElementById('edit-label-btn');

    // Session Switcher & Historical Replay
    this.playerSessionSelect = document.getElementById('player-session-select');
    this.historyBanner = document.getElementById('player-history-banner');
    this.historySessionName = document.getElementById('history-session-name');
    this.historySessionDate = document.getElementById('history-session-date');
    this.returnLiveBtn = document.getElementById('return-live-btn');

    // Threshold & Impact elements
    this.thresholdValue = document.getElementById('threshold-value');
    this.impactResetBtn = document.getElementById('impact-reset-btn');
    this.impactBanner = document.getElementById('impact-banner');
    this.impactBannerValue = document.getElementById('impact-banner-value');
    this.thresholdError = document.getElementById('threshold-error');

    // KPI Cards
    this.kpiLiveG = document.getElementById('player-kpi-live-g');
    this.kpiMaxG = document.getElementById('player-kpi-max-g');
    this.kpiTemp = document.getElementById('player-kpi-temp');
    this.kpiBattery = document.getElementById('player-kpi-battery');

    // Toolbars & Zoom Controls
    this.realtimeToggle = document.getElementById('realtime-toggle');
    this.showAllBtn = document.getElementById('show-all-btn');
    this.followLiveBtn = document.getElementById('follow-live-btn');
    this.resetZoomBtn = document.getElementById('reset-zoom-btn');
    this.gyroToggle = document.getElementById('gyro-chart-toggle');
    this.tempToggle = document.getElementById('temp-chart-toggle');
    this.gyroChartCard = document.getElementById('gyro-chart-card');
    this.tempChartCard = document.getElementById('temp-chart-card');

    this.chartManager.setOnUserNavigated((userNavigated) => {
      if (!state.isViewingHistorical() && state.realtimeEnabled) {
        this.followLiveBtn?.classList.toggle('hidden', !userNavigated);
      }
    });

    this.initEvents();
  }

  initEvents() {
    this.backBtn?.addEventListener('click', () => {
      if (this.onBack) this.onBack();
    });

    this.editLabelBtn?.addEventListener('click', () => {
      if (state.currentDeviceId && this.onEditLabel) {
        this.onEditLabel(state.currentDeviceId);
      }
    });

    this.playerSessionSelect?.addEventListener('change', (e) => {
      const sessId = Number(e.target.value);
      if (sessId) {
        // Triggers 'selected_session_changed', which reopens this view via app.js — don't fetch twice.
        state.setSelectedSessionId(sessId);
      }
    });

    this.returnLiveBtn?.addEventListener('click', () => {
      if (state.activeSession) {
        state.setSelectedSessionId(state.activeSession.id);
      }
    });

    this.realtimeToggle?.addEventListener('change', (e) => {
      state.realtimeEnabled = e.target.checked;
      if (state.realtimeEnabled) {
        this.rebuildAll();
      }
    });

    this.showAllBtn?.addEventListener('click', () => {
      this.chartManager.showEntireSession();
      if (!state.isViewingHistorical()) {
        this.followLiveBtn?.classList.remove('hidden');
      }
    });

    this.followLiveBtn?.addEventListener('click', () => {
      this.chartManager.followLive();
      this.followLiveBtn?.classList.add('hidden');
    });

    this.resetZoomBtn?.addEventListener('click', () => {
      this.chartManager.resetZoom();
      this.followLiveBtn?.classList.add('hidden');
    });

    this.gyroToggle?.addEventListener('change', (e) => {
      this.gyroChartCard?.classList.toggle('hidden', !e.target.checked);
      if (e.target.checked) this.chartManager.resize();
    });

    this.tempToggle?.addEventListener('change', (e) => {
      this.tempChartCard?.classList.toggle('hidden', !e.target.checked);
      if (e.target.checked) this.chartManager.resize();
    });

    this.impactResetBtn?.addEventListener('click', () => this.handleResetImpact());
  }

  async handleResetImpact() {
    if (!state.currentDeviceId) return;
    this.impactResetBtn.disabled = true;

    try {
      await api.resetDeviceImpact(state.currentDeviceId);
      const dev = state.getCurrentDevice();
      if (dev) {
        dev.impact_alert = false;
        dev.impact_value = undefined;
      }
      this.thresholdError?.classList.add('hidden');
      this.renderImpactState();
    } catch (err) {
      if (this.thresholdError) {
        this.thresholdError.textContent = err.message;
        this.thresholdError.classList.remove('hidden');
      }
    } finally {
      this.impactResetBtn.disabled = false;
    }
  }

  renderSessionOptions() {
    if (!this.playerSessionSelect) return;
    const sessions = state.sessions || [];
    const currentId = state.selectedSessionId || state.activeSession?.id;

    this.playerSessionSelect.innerHTML = sessions.map((s) => {
      const isLive = Boolean(s.is_active);
      const isSelected = s.id === currentId;
      const dateLabel = formatDateTime(s.start_time);
      const badge = isLive ? '🔴 En direct' : '📅 Passé';
      return `
        <option value="${s.id}" ${isSelected ? 'selected' : ''}>
          ${badge} : ${escapeHtml(s.name)} (${dateLabel})
        </option>
      `;
    }).join('');
  }

  async open(deviceId, sessionId = null) {
    progressBar.start();

    if (sessionId) {
      state.setSelectedSessionId(sessionId);
    }
    const currentSessionId = state.selectedSessionId || state.activeSession?.id;
    const isHistorical = state.isViewingHistorical();
    const currentSession = state.getSelectedSession();
    const playerName = getDeviceDisplayName(state.devices.get(deviceId));
    const loadLabel = currentSession
      ? `Chargement de « ${currentSession.name} » — ${playerName}...`
      : `Chargement des données de ${playerName}...`;

    sessionLoader.show(loadLabel);
    sessionLoader.update(15);

    state.setCurrentDevice(deviceId, []);
    this.chartManager.clear();
    
    this.renderSessionOptions();
    this.renderHeader();
    
    // Show/hide historical session banner
    if (this.historyBanner) {
      this.historyBanner.classList.toggle('hidden', !isHistorical);
      if (isHistorical && currentSession) {
        if (this.historySessionName) this.historySessionName.textContent = currentSession.name;
        if (this.historySessionDate) this.historySessionDate.textContent = formatDateTime(currentSession.start_time);
      }
    }
    
    if (this.realtimeToggle) {
      this.realtimeToggle.checked = !isHistorical;
      this.realtimeToggle.disabled = isHistorical;
      state.realtimeEnabled = !isHistorical;
    }

    this.container?.classList.remove('hidden');
    progressBar.set(35);
    sessionLoader.update(35, `${loadLabel} Récupération du journal...`);

    try {
      const history = await api.fetchDeviceLog(deviceId, currentSessionId);
      progressBar.set(70);
      sessionLoader.update(70, `${loadLabel} Construction des graphiques...`);
      state.currentDeviceLog = Array.isArray(history) ? history : [];
      this.rebuildAll();
      progressBar.complete();
      sessionLoader.hide();
    } catch (err) {
      console.error('Failed to load player history for session:', err);
      progressBar.complete();
      sessionLoader.hide();
    }
  }

  rebuildAll() {
    this.renderHeader();
    this.renderKpis();
    this.renderImpactState();
    this.rebuildCharts();
  }

  rebuildCharts() {
    const dev = state.getCurrentDevice();
    const threshold = getDeviceThreshold(dev);
    const isHistorical = state.isViewingHistorical();
    this.chartManager.loadFullSession(state.currentDeviceLog, threshold, isHistorical);
  }

  renderHeader() {
    const dev = state.getCurrentDevice();
    if (!dev) return;

    const displayName = getDeviceDisplayName(dev);
    const isHistorical = state.isViewingHistorical();
    const link = getDeviceLinkState(dev);

    if (this.playerTitle) this.playerTitle.textContent = displayName;
    if (this.playerMac) this.playerMac.textContent = dev.device_id;

    if (this.playerStatusDot) {
      this.playerStatusDot.className = `status-dot ${isHistorical ? 'dot-offline' : link.dotClass}`;
    }
    if (this.playerStatusText) {
      const label = isHistorical ? 'Archivé' : link.label;
      this.playerStatusText.innerHTML = isHistorical
        ? label
        : `<i data-lucide="${link.icon}" class="${link.spin ? 'icon-spin' : ''}" style="width:14px;height:14px;"></i> ${label}`;
      this.playerStatusText.className = `status-text ${isHistorical ? 'text-offline' : link.textClass}`;
      if (window.lucide) window.lucide.createIcons();
    }

    const rssi = getRssiStatus(dev.rssi);
    if (this.rssiBadge) {
      this.rssiBadge.className = `rssi-badge rssi-${rssi.level}`;
      this.rssiBadge.title = `Signal BLE : ${rssi.text}`;
    }
    if (this.rssiIcon) this.rssiIcon.style.color = rssi.color;
    if (this.rssiLabel) this.rssiLabel.textContent = rssi.label;

    if (this.thresholdValue) {
      this.thresholdValue.textContent = `${fmt(getDeviceThreshold(dev), 1)}`;
    }
  }

  renderKpis() {
    const dev = state.getCurrentDevice();
    if (!dev) return;

    const isHistorical = state.isViewingHistorical();
    const logs = state.currentDeviceLog;
    const threshold = getDeviceThreshold(dev);

    let mag = 0;
    let maxG = 0;
    let temp = dev.temp;
    let batteryPct = dev.battery_percentage;
    let batteryV = dev.battery_voltage;

    if (isHistorical && logs.length > 0) {
      // Calculate metrics from this specific historical session's data
      for (const item of logs) {
        if (item.type === 'imu') {
          const m = calcAccelMagnitude(item.aX, item.aY, item.aZ);
          if (m > maxG) maxG = m;
          mag = m;
          if (item.temp !== undefined) temp = item.temp;
        } else if (item.type === 'impact') {
          const impVal = Number(item.impact_value) || 0;
          if (impVal > maxG) maxG = impVal;
        } else if (item.type === 'battery') {
          if (item.percentage !== undefined) batteryPct = item.percentage;
          if (item.voltage !== undefined) batteryV = item.voltage;
        }
      }
    } else {
      // Live session values
      mag = dev.aX !== undefined ? calcAccelMagnitude(dev.aX, dev.aY, dev.aZ) : 0;
      maxG = Math.max(state.getMaxG(dev.device_id), mag);
    }

    const battery = getBatteryStatus(batteryPct);

    if (this.kpiLiveG) {
      const gLabel = isHistorical ? 'Dernière Accel' : 'Accélération |a|';
      const labelEl = this.kpiLiveG.closest('.kpi-content')?.querySelector('.kpi-label');
      if (labelEl) labelEl.textContent = gLabel;

      this.kpiLiveG.textContent = mag > 0 ? `${fmt(mag, 2)} g` : '-- g';
      this.kpiLiveG.className = `kpi-value font-mono ${mag >= threshold ? 'text-danger pulse-danger' : mag >= threshold * 0.7 ? 'text-warning' : 'text-accent'}`;
    }

    if (this.kpiMaxG) {
      this.kpiMaxG.textContent = `${fmt(maxG, 2)} g`;
    }

    if (this.kpiTemp) {
      this.kpiTemp.textContent = temp !== undefined ? `${fmt(temp, 1)} °C` : '-- °C';
    }

    if (this.kpiBattery) {
      this.kpiBattery.innerHTML = `
        <span style="color: ${battery.color}">${battery.text}</span>
        ${batteryV !== undefined ? `<small class="kpi-subval">(${fmt(batteryV, 2)}V)</small>` : ''}
      `;
    }
  }

  renderImpactState() {
    const dev = state.getCurrentDevice();
    const isHistorical = state.isViewingHistorical();
    const logs = state.currentDeviceLog;
    const threshold = getDeviceThreshold(dev);

    let hasAlert = Boolean(dev?.impact_alert);
    let peakImpact = dev?.impact_value || 0;

    if (isHistorical) {
      hasAlert = false;
      peakImpact = 0;
      for (const item of logs) {
        if (item.type === 'impact') {
          hasAlert = true;
          const v = Number(item.impact_value) || 0;
          if (v > peakImpact) peakImpact = v;
        } else if (item.type === 'imu') {
          const m = calcAccelMagnitude(item.aX, item.aY, item.aZ);
          if (m >= threshold) {
            hasAlert = true;
            if (m > peakImpact) peakImpact = m;
          }
        }
      }
    }

    if (this.impactBanner) {
      this.impactBanner.classList.toggle('hidden', !hasAlert);
      if (hasAlert && this.impactBannerValue) {
        this.impactBannerValue.textContent = fmt(peakImpact, 2);
      }
    }
  }

  handleLiveMessage(msg) {
    if (msg.device_id !== state.currentDeviceId) return;

    this.renderHeader();
    this.renderKpis();
    this.renderImpactState();

    if (!state.realtimeEnabled) return;

    // Stream to charts via high-performance RAF buffer
    if (msg.type === 'imu') {
      const dev = state.getCurrentDevice();
      this.chartManager.feedImuData(msg, getDeviceThreshold(dev));
    } else if (msg.type === 'threshold') {
      this.chartManager.updateThreshold(msg.impact_threshold);
    }
  }

  hide() {
    this.container?.classList.add('hidden');
    state.currentDeviceId = null;
    this.chartManager.clear();
  }
}
