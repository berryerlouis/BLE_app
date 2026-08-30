/**
 * Player Detail View (Second Page)
 */
import { CONFIG } from '../config.js';
import { api } from '../api.js';
import { state } from '../state.js';
import {
  fmt,
  calcAccelMagnitude,
  getDeviceDisplayName,
  getDeviceThreshold,
  formatDateTime,
  getBatteryStatus,
  escapeHtml,
  progressBar,
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
    this.logSortSelect = document.getElementById('log-sort-select');
    this.logFilterSelect = document.getElementById('log-filter-select');
    this.logSearchInput = document.getElementById('log-search-input');
    this.logClearBtn = document.getElementById('log-clear-btn');
    this.logPanel = document.getElementById('log-panel');

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
        state.setSelectedSessionId(sessId);
        if (state.currentDeviceId) {
          this.open(state.currentDeviceId, sessId);
        }
      }
    });

    this.returnLiveBtn?.addEventListener('click', () => {
      if (state.activeSession) {
        state.setSelectedSessionId(state.activeSession.id);
        if (state.currentDeviceId) {
          this.open(state.currentDeviceId, state.activeSession.id);
        }
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

    this.logSortSelect?.addEventListener('change', (e) => {
      state.logSortOrder = e.target.value;
      this.renderLogs();
    });

    this.logFilterSelect?.addEventListener('change', (e) => {
      state.logFilterType = e.target.value;
      this.renderLogs();
    });

    this.logSearchInput?.addEventListener('input', () => {
      this.renderLogs();
    });

    this.logClearBtn?.addEventListener('click', () => {
      state.currentDeviceLog = [];
      this.renderLogs();
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

    if (this.logPanel) {
      this.logPanel.innerHTML = '<div class="log-loading"><i data-lucide="loader" class="animate-spin"></i> Chargement de la télémétrie du match...</div>';
      if (window.lucide) window.lucide.createIcons({ root: this.logPanel });
    }

    this.container?.classList.remove('hidden');
    progressBar.set(35);

    try {
      const history = await api.fetchDeviceLog(deviceId, currentSessionId);
      progressBar.set(70);
      state.currentDeviceLog = Array.isArray(history) ? history : [];
      this.rebuildAll();
      progressBar.complete();
    } catch (err) {
      console.error('Failed to load player history for session:', err);
      progressBar.complete();
      if (this.logPanel) {
        this.logPanel.innerHTML = '<div class="log-empty text-danger">Impossible de charger l\'historique de cette session</div>';
      }
    }
  }

  rebuildAll() {
    this.renderHeader();
    this.renderKpis();
    this.renderImpactState();
    this.renderLogs();
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
    const isConnected = Boolean(dev.connected) && !state.isViewingHistorical();

    if (this.playerTitle) this.playerTitle.textContent = displayName;
    if (this.playerMac) this.playerMac.textContent = dev.device_id;

    if (this.playerStatusDot) {
      this.playerStatusDot.className = `status-dot ${isConnected ? 'dot-online' : 'dot-offline'}`;
    }
    if (this.playerStatusText) {
      this.playerStatusText.textContent = isConnected ? 'Connecté' : (state.isViewingHistorical() ? 'Archivé' : 'Hors ligne');
      this.playerStatusText.className = `status-text ${isConnected ? 'text-online' : 'text-offline'}`;
    }

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

  formatLogMessage(msg) {
    const t = formatDateTime(msg.timestamp);
    let typeBadge = '';
    let details = '';

    switch (msg.type) {
      case 'imu': {
        const mag = calcAccelMagnitude(msg.aX, msg.aY, msg.aZ);
        typeBadge = '<span class="log-badge badge-imu">IMU</span>';
        details = `|a|=<strong>${fmt(mag, 2)}g</strong> &middot; aX=${fmt(msg.aX)} aY=${fmt(msg.aY)} aZ=${fmt(msg.aZ)} &middot; gX=${fmt(msg.gX)} gY=${fmt(msg.gY)} gZ=${fmt(msg.gZ)} &middot; ${fmt(msg.temp, 1)}°C`;
        break;
      }
      case 'battery':
        typeBadge = '<span class="log-badge badge-battery">BATTERIE</span>';
        details = `Niveau: <strong>${msg.percentage}%</strong> &middot; Tension: ${fmt(msg.voltage, 2)}V`;
        break;
      case 'status':
        typeBadge = `<span class="log-badge ${msg.connected ? 'badge-online' : 'badge-offline'}">STATUT</span>`;
        details = `Satellite <strong>${msg.connected ? 'connecté' : 'déconnecté'}</strong>`;
        break;
      case 'label':
        typeBadge = '<span class="log-badge badge-label">JOUEUR</span>';
        details = `Nom: <strong>${escapeHtml(msg.label_name)} (#${msg.label_number})</strong>`;
        break;
      case 'threshold':
        typeBadge = '<span class="log-badge badge-threshold">SEUIL</span>';
        details = `Nouveau seuil de commotion: <strong>${fmt(msg.impact_threshold, 1)}g</strong>`;
        break;
      case 'impact':
        typeBadge = '<span class="log-badge badge-impact pulse-danger">COMMOTION</span>';
        details = `ALERTE CHOC : |a|=<strong>${fmt(msg.impact_value, 2)}g</strong> (seuil ${fmt(msg.impact_threshold, 1)}g)`;
        break;
      case 'impact_reset':
        typeBadge = '<span class="log-badge badge-reset">ACQUITTEMENT</span>';
        details = `Alerte commotion réinitialisée / acquittée`;
        break;
      default:
        typeBadge = '<span class="log-badge">INFO</span>';
        details = escapeHtml(JSON.stringify(msg));
    }

    return `
      <div class="log-item log-type-${msg.type}">
        <span class="log-time">${t}</span>
        ${typeBadge}
        <span class="log-content">${details}</span>
      </div>
    `;
  }

  renderLogs() {
    if (!this.logPanel) return;

    let logs = [...state.currentDeviceLog];
    const filterType = state.logFilterType;
    const query = (this.logSearchInput?.value || '').toLowerCase().trim();

    // Filter by type
    if (filterType !== 'all') {
      logs = logs.filter((m) => m.type === filterType);
    }

    // Filter by search text
    if (query) {
      logs = logs.filter((m) => JSON.stringify(m).toLowerCase().includes(query));
    }

    // Sort
    if (state.logSortOrder === 'desc') {
      logs.reverse();
    }

    if (logs.length === 0) {
      this.logPanel.innerHTML = '<div class="log-empty">Aucun événement enregistré pour ce filtre</div>';
      return;
    }

    // Render bounded slice for high performance
    const renderSlice = logs.slice(0, CONFIG.MAX_DOM_LOG_LINES);
    this.logPanel.innerHTML = renderSlice.map((m) => this.formatLogMessage(m)).join('');
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

    // Append log line with DOM node count limit
    if (this.logPanel) {
      if (state.logFilterType === 'all' || state.logFilterType === msg.type) {
        const itemHtml = this.formatLogMessage(msg);
        const temp = document.createElement('div');
        temp.innerHTML = itemHtml;
        const line = temp.firstElementChild;
        
        if (state.logSortOrder === 'desc') {
          const emptyPlaceholder = this.logPanel.querySelector('.log-empty');
          if (emptyPlaceholder) emptyPlaceholder.remove();
          this.logPanel.insertBefore(line, this.logPanel.firstChild);
          while (this.logPanel.childElementCount > CONFIG.MAX_DOM_LOG_LINES) {
            this.logPanel.removeChild(this.logPanel.lastChild);
          }
        } else {
          this.logPanel.appendChild(line);
          while (this.logPanel.childElementCount > CONFIG.MAX_DOM_LOG_LINES) {
            this.logPanel.removeChild(this.logPanel.firstChild);
          }
          this.logPanel.scrollTop = this.logPanel.scrollHeight;
        }
      }
    }
  }

  hide() {
    this.container?.classList.add('hidden');
    state.currentDeviceId = null;
    this.chartManager.clear();
  }
}
