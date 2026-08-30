/**
 * Dashboard Overview View (First Page)
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

export class DashboardView {
  constructor(onOpenPlayer, onEditLabel, onNewSession, onEndSession, onSelectSession) {
    this.onOpenPlayer = onOpenPlayer;
    this.onEditLabel = onEditLabel;
    this.onNewSession = onNewSession;
    this.onEndSession = onEndSession;
    this.onSelectSession = onSelectSession;

    this.container = document.getElementById('devices-view');
    this.tbody = document.getElementById('devices-tbody');
    this.noDevicesRow = document.getElementById('no-devices-row');
    
    // Global Header Session elements
    this.globalSessionSelect = document.getElementById('global-session-select');
    this.newSessionBtn = document.getElementById('new-session-btn');
    this.endSessionBtn = document.getElementById('end-session-btn');

    // Historical Dashboard Banner elements
    this.dashHistoryBanner = document.getElementById('dashboard-history-banner');
    this.dashHistorySessionName = document.getElementById('dash-history-session-name');
    this.dashHistorySessionDate = document.getElementById('dash-history-session-date');
    this.dashReturnLiveBtn = document.getElementById('dash-return-live-btn');

    // KPI elements
    this.kpiTotal = document.getElementById('kpi-total-devices');
    this.kpiConnected = document.getElementById('kpi-connected-devices');
    this.kpiAlerts = document.getElementById('kpi-active-alerts');
    this.kpiPeakG = document.getElementById('kpi-peak-g');

    // Controls
    this.searchInput = document.getElementById('devices-search-input');
    this.filterButtons = document.querySelectorAll('.filter-btn');
    this.sortSelect = document.getElementById('devices-sort-select');

    this.initEvents();
  }

  initEvents() {
    // Session change & creation
    this.globalSessionSelect?.addEventListener('change', (e) => {
      const sessId = Number(e.target.value);
      if (sessId && this.onSelectSession) {
        this.onSelectSession(sessId);
      }
    });

    this.dashReturnLiveBtn?.addEventListener('click', () => {
      if (state.activeSession && this.onSelectSession) {
        this.onSelectSession(state.activeSession.id);
      }
    });

    this.newSessionBtn?.addEventListener('click', () => {
      if (this.onNewSession) this.onNewSession();
    });

    this.endSessionBtn?.addEventListener('click', () => {
      if (this.onEndSession) this.onEndSession();
    });

    // Search input
    this.searchInput?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      this.render();
    });

    // Filter buttons
    this.filterButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        this.filterButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.filterStatus = btn.dataset.filter || 'all';
        this.render();
      });
    });

    // Sort select
    this.sortSelect?.addEventListener('change', (e) => {
      const [field, order] = e.target.value.split('-');
      state.sortField = field || 'last_update';
      state.sortOrder = order || 'desc';
      this.render();
    });

    // Table click delegation (open player or edit label)
    const onTableClick = (e) => {
      const editBtn = e.target.closest('.edit-player-btn');
      if (editBtn) {
        e.stopPropagation();
        e.preventDefault();
        const deviceId = editBtn.dataset.deviceId;
        if (deviceId && this.onEditLabel) this.onEditLabel(deviceId);
        return;
      }

      if (e.target.closest('.row-threshold-input')) {
        return; // don't open player when editing threshold
      }

      const row = e.target.closest('tr.device-row');
      if (row) {
        const deviceId = row.dataset.deviceId;
        if (deviceId && this.onOpenPlayer) {
          this.onOpenPlayer(deviceId);
        }
      }
    };

    this.tbody?.addEventListener('click', onTableClick);

    // Inline threshold change
    this.tbody?.addEventListener('change', async (e) => {
      const input = e.target.closest('.row-threshold-input');
      if (!input) return;

      const deviceId = input.dataset.deviceId;
      const threshold = Number(input.value);

      if (!Number.isFinite(threshold) || threshold <= 0 || threshold > CONFIG.MAX_IMPACT_THRESHOLD) {
        const currentDev = state.devices.get(deviceId);
        input.value = getDeviceThreshold(currentDev);
        return;
      }

      input.disabled = true;
      try {
        await api.updateDeviceThreshold(deviceId, threshold);
        const currentDev = state.devices.get(deviceId);
        if (currentDev) currentDev.impact_threshold = threshold;
      } catch (err) {
        console.error('Failed to update threshold:', err);
        const currentDev = state.devices.get(deviceId);
        input.value = getDeviceThreshold(currentDev);
      } finally {
        input.disabled = false;
      }
    });
  }

  renderSessionSelector() {
    if (!this.globalSessionSelect) return;
    const sessions = state.sessions || [];
      if (this.endSessionBtn) this.endSessionBtn.disabled = !state.activeSession?.is_active;
    if (sessions.length === 0) {
      this.globalSessionSelect.innerHTML = '<option value="">Aucune session</option>';
      return;
    }

    const currentSelected = state.selectedSessionId || state.activeSession?.id;
    this.globalSessionSelect.innerHTML = sessions.map((s) => {
      const isLive = Boolean(s.is_active);
      const isSelected = s.id === currentSelected;
      const dateLabel = formatDateTime(s.start_time);
      const prefix = isLive ? '🔴 DIRECT :' : '📅 MATCH :';
      return `
        <option value="${s.id}" ${isSelected ? 'selected' : ''}>
          ${prefix} ${escapeHtml(s.name)} (${dateLabel})
        </option>
      `;
    }).join('');

    // Historical banner state
    const isHistorical = state.isViewingHistorical();
    const currentSession = state.getSelectedSession();

    if (this.dashHistoryBanner) {
      this.dashHistoryBanner.classList.toggle('hidden', !isHistorical);
      if (isHistorical && currentSession) {
        if (this.dashHistorySessionName) this.dashHistorySessionName.textContent = currentSession.name;
        if (this.dashHistorySessionDate) this.dashHistorySessionDate.textContent = formatDateTime(currentSession.start_time);
      }
    }
  }

  updateKpiSummary() {
    const all = Array.from(state.devices.values());
    const total = all.length;
    const connected = all.filter((d) => d.connected).length;
    const alerts = all.filter((d) => d.impact_alert).length;

    let peakG = 0;
    all.forEach((d) => {
      const maxG = state.getMaxG(d.device_id);
      if (maxG > peakG) peakG = maxG;
      if (d.aX !== undefined) {
        const currentMag = calcAccelMagnitude(d.aX, d.aY, d.aZ);
        if (currentMag > peakG) peakG = currentMag;
      }
    });

    if (this.kpiTotal) this.kpiTotal.textContent = total;
    if (this.kpiConnected) this.kpiConnected.textContent = connected;
    if (this.kpiAlerts) {
      this.kpiAlerts.textContent = alerts;
      this.kpiAlerts.closest('.kpi-card')?.classList.toggle('kpi-card-danger', alerts > 0);
    }
    if (this.kpiPeakG) this.kpiPeakG.textContent = `${fmt(peakG, 1)} g`;
  }

  getGValueBadgeHtml(mag, threshold, hasAlert) {
    let statusClass = 'badge-g-normal';
    let label = 'Normal';

    if (hasAlert || (threshold && mag !== null && mag >= threshold)) {
      statusClass = 'badge-g-alert pulse-danger';
      label = 'Choc !';
    } else if (threshold && mag !== null && mag >= threshold * 0.7) {
      statusClass = 'badge-g-warning';
      label = 'Élevé';
    }

    const valText = mag !== null ? fmt(mag, 2) : '--';

    return `
      <div class="g-value-container">
        <span class="g-value-number ${statusClass}">
          <span class="g-num-val">${valText}</span> <small>g</small>
        </span>
        <span class="g-status-pill ${statusClass}">${label}</span>
      </div>
    `;
  }

  createDeviceRowHtml(d) {
    const isConnected = Boolean(d.connected);
    const hasAlert = Boolean(d.impact_alert);
    const threshold = getDeviceThreshold(d);
    const mag = d.aX !== undefined ? calcAccelMagnitude(d.aX, d.aY, d.aZ) : null;
    const temp = d.temp;
    const battery = getBatteryStatus(d.battery_percentage);
    const displayName = getDeviceDisplayName(d);
    const mac = d.device_id;
    const lastSeen = formatDateTime(d.last_update);

    return `
      <tr class="device-row ${hasAlert ? 'impact-row' : ''} ${!isConnected ? 'disconnected-row' : ''}" data-device-id="${escapeHtml(mac)}">
        <!-- Status -->
        <td class="col-status" data-label="Statut">
          <div class="status-indicator-wrapper" title="${isConnected ? 'Connecté' : 'Déconnecté'}">
            <span class="status-dot ${isConnected ? 'dot-online' : 'dot-offline'}"></span>
            <span class="status-text ${isConnected ? 'text-online' : 'text-offline'}">
              ${isConnected ? 'Connecté' : 'Hors ligne'}
            </span>
          </div>
        </td>

        <!-- Player info -->
        <td class="col-player" data-label="Joueur">
          <div class="player-cell-content">
            <div class="player-avatar ${hasAlert ? 'avatar-alert' : ''}">
              <i data-lucide="${hasAlert ? 'alert-triangle' : 'activity'}"></i>
            </div>
            <div class="player-meta">
              <div class="player-name-row">
                <span class="player-name">${escapeHtml(displayName)}</span>
                <button type="button" class="edit-player-btn icon-subtle-btn" data-device-id="${escapeHtml(mac)}" title="Renommer le joueur" aria-label="Renommer">
                  <i data-lucide="edit-3"></i>
                </button>
              </div>
              <span class="player-mac">${escapeHtml(mac)}</span>
            </div>
          </div>
        </td>

        <!-- Absolute G magnitude in real-time -->
        <td class="col-g" data-label="|a| (G)">
          ${this.getGValueBadgeHtml(mag, threshold, hasAlert)}
        </td>

        <!-- Temperature -->
        <td class="col-temp" data-label="Température">
          <div class="temp-badge" title="Température du capteur">
            <i data-lucide="thermometer"></i>
            <span class="temp-val">${temp !== undefined ? `${fmt(temp, 1)}°C` : '--'}</span>
          </div>
        </td>

        <!-- Concussion threshold for this player -->
        <td class="col-threshold" data-label="Seuil commotion">
          <div class="threshold-input-wrapper">
            <input 
              type="number" 
              class="row-threshold-input form-input-sm" 
              data-device-id="${escapeHtml(mac)}" 
              value="${threshold}" 
              min="0.1" 
              max="${CONFIG.MAX_IMPACT_THRESHOLD}" 
              step="0.1" 
              title="Seuil de commotion personnalisé"
            />
            <span class="threshold-unit">g</span>
          </div>
        </td>

        <!-- Battery -->
        <td class="col-battery" data-label="Batterie">
          <div class="battery-cell" title="${d.battery_voltage !== undefined ? `${fmt(d.battery_voltage, 2)} V` : ''}">
            <i data-lucide="${battery.icon}" class="battery-icon" style="color: ${battery.color}"></i>
            <span class="battery-text">${battery.text}</span>
          </div>
        </td>

        <!-- Last update -->
        <td class="col-lastseen text-muted font-mono" data-label="Dernière donnée">${lastSeen}</td>

        <!-- Action / Open -->
        <td class="col-actions" data-label="">
          <button type="button" class="btn btn-primary-soft btn-sm view-player-btn" data-device-id="${escapeHtml(mac)}" title="Voir les graphiques et le joueur">
            <span>Détails</span>
            <i data-lucide="chevron-right"></i>
          </button>
        </td>
      </tr>
    `;
  }

  updateRow(row, d) {
    const isConnected = Boolean(d.connected);
    const hasAlert = Boolean(d.impact_alert);
    const threshold = getDeviceThreshold(d);
    const mag = d.aX !== undefined ? calcAccelMagnitude(d.aX, d.aY, d.aZ) : null;
    const temp = d.temp;
    const battery = getBatteryStatus(d.battery_percentage);
    const displayName = getDeviceDisplayName(d);
    const lastSeen = formatDateTime(d.last_update);

    // Row classes
    row.classList.toggle('impact-row', hasAlert);
    row.classList.toggle('disconnected-row', !isConnected);

    // Status
    const dot = row.querySelector('.status-dot');
    if (dot) dot.className = `status-dot ${isConnected ? 'dot-online' : 'dot-offline'}`;

    const statusText = row.querySelector('.status-text');
    if (statusText) {
      statusText.className = `status-text ${isConnected ? 'text-online' : 'text-offline'}`;
      statusText.textContent = isConnected ? 'Connecté' : 'Hors ligne';
    }

    // Player Avatar & Name
    const avatar = row.querySelector('.player-avatar');
    if (avatar) avatar.classList.toggle('avatar-alert', hasAlert);

    const nameEl = row.querySelector('.player-name');
    if (nameEl && nameEl.textContent !== displayName) {
      nameEl.textContent = displayName;
    }

    // G Magnitude & Pill (Mutate text nodes only, NEVER rebuild innerHTML during live streaming)
    const gNumVal = row.querySelector('.g-num-val');
    const gNumBox = row.querySelector('.g-value-number');
    const gPill = row.querySelector('.g-status-pill');

    if (gNumVal && gNumBox && gPill) {
      let statusClass = 'badge-g-normal';
      let label = 'Normal';
      if (hasAlert || (threshold && mag !== null && mag >= threshold)) {
        statusClass = 'badge-g-alert pulse-danger';
        label = 'Choc !';
      } else if (threshold && mag !== null && mag >= threshold * 0.7) {
        statusClass = 'badge-g-warning';
        label = 'Élevé';
      }

      gNumVal.textContent = mag !== null ? fmt(mag, 2) : '--';
      if (gNumBox.className !== `g-value-number ${statusClass}`) {
        gNumBox.className = `g-value-number ${statusClass}`;
      }
      if (gPill.className !== `g-status-pill ${statusClass}`) {
        gPill.className = `g-status-pill ${statusClass}`;
      }
      if (gPill.textContent !== label) {
        gPill.textContent = label;
      }
    }

    // Temperature
    const tempVal = row.querySelector('.temp-val');
    if (tempVal) {
      const formattedTemp = temp !== undefined ? `${fmt(temp, 1)}°C` : '--';
      if (tempVal.textContent !== formattedTemp) {
        tempVal.textContent = formattedTemp;
      }
    }

    // Threshold input (do not clobber if user is actively typing)
    const thresholdInput = row.querySelector('.row-threshold-input');
    if (thresholdInput && document.activeElement !== thresholdInput) {
      if (Number(thresholdInput.value) !== threshold) {
        thresholdInput.value = threshold;
      }
    }

    // Battery
    const batteryText = row.querySelector('.col-battery .battery-text');
    if (batteryText && batteryText.textContent !== battery.text) {
      batteryText.textContent = battery.text;
    }
    const batteryIcon = row.querySelector('.col-battery .battery-icon');
    if (batteryIcon && batteryIcon.style.color !== battery.color) {
      batteryIcon.style.color = battery.color;
    }
    const batteryCell = row.querySelector('.col-battery .battery-cell');
    if (batteryCell) {
      batteryCell.title = d.battery_voltage !== undefined ? `${fmt(d.battery_voltage, 2)} V` : '';
    }

    // Last seen
    const lastSeenEl = row.querySelector('.col-lastseen');
    if (lastSeenEl && lastSeenEl.textContent !== lastSeen) {
      lastSeenEl.textContent = lastSeen;
    }
  }

  updateDevice(deviceId, device) {
    this.updateKpiSummary();

    const row = this.tbody?.querySelector(`tr.device-row[data-device-id="${CSS.escape(deviceId)}"]`);
    if (row) {
      this.updateRow(row, device);
    } else {
      // New device or row not yet inserted
      this.render();
    }
  }

  render() {
    this.renderSessionSelector();
    this.updateKpiSummary();

    const devices = state.getFilteredAndSortedDevices();
    const hasDevices = devices.length > 0;

    if (this.noDevicesRow) {
      this.noDevicesRow.classList.toggle('hidden', hasDevices);
    }

    if (!this.tbody) return;

    // Track existing rows in DOM
    const validIds = new Set(devices.map((d) => d.device_id));

    // Remove rows that no longer belong to the filtered set
    const existingRows = this.tbody.querySelectorAll('tr.device-row');
    existingRows.forEach((r) => {
      const id = r.dataset.deviceId;
      if (!validIds.has(id)) {
        r.remove();
      }
    });

    // For each device in sorted order, update or insert row
    devices.forEach((d) => {
      let row = this.tbody.querySelector(`tr.device-row[data-device-id="${CSS.escape(d.device_id)}"]`);
      if (!row) {
        const temp = document.createElement('tbody');
        temp.innerHTML = this.createDeviceRowHtml(d);
        row = temp.firstElementChild;
        if (window.lucide) {
          window.lucide.createIcons({ root: row });
        }
      } else {
        this.updateRow(row, d);
      }
      this.tbody.appendChild(row); // Moves existing element in DOM order without destroying it
    });
  }

  show() {
    this.container?.classList.remove('hidden');
    this.render();
  }

  hide() {
    this.container?.classList.add('hidden');
  }
}
