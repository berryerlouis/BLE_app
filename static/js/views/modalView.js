/**
 * Modals & Dialogs Management
 */
import { CONFIG } from '../config.js';
import { api } from '../api.js';
import { state } from '../state.js?v=20260929-mobile-status';
import { escapeHtml, formatDuration } from '../utils.js';

export class ModalView {
  constructor() {
    this.labelModal = document.getElementById('label-modal');
    this.labelModalTitle = document.getElementById('label-modal-title');
    this.labelDeviceIdSpan = document.getElementById('label-device-id');
    this.labelNameInput = document.getElementById('label-name-input');
    this.labelNumberInput = document.getElementById('label-number-input');
    this.labelError = document.getElementById('label-error');
    this.labelSaveBtn = document.getElementById('label-save-btn');
    this.labelLaterBtn = document.getElementById('label-later-btn');

    this.updateModal = document.getElementById('update-modal');
    this.updateConfirmBtn = document.getElementById('update-confirm-btn');
    this.updateCancelBtn = document.getElementById('update-cancel-btn');
    this.currentVersionSpan = document.getElementById('current-version');
    this.latestVersionSpan = document.getElementById('latest-version');
    this.updateProgressContainer = document.getElementById('update-progress-container');
    this.updateProgressBar = document.getElementById('update-progress-bar');
    this.updateProgressText = document.getElementById('update-progress-text');
    this.updateMessage = document.getElementById('update-message');
    this.versionInfo = document.getElementById('version-info');
    this.updateStatus = document.getElementById('update-status');

    // New Match / Session Modal elements
    this.sessionModal = document.getElementById('session-modal');
    this.sessionNameInput = document.getElementById('session-name-input');
    this.sessionNotesInput = document.getElementById('session-notes-input');
    this.sessionSaveBtn = document.getElementById('session-save-btn');
    this.sessionCancelBtn = document.getElementById('session-cancel-btn');
    this.sessionError = document.getElementById('session-error');

    // End Match / Terminate Session Modal elements
    this.endSessionModal = document.getElementById('end-session-modal');
    this.endSessionName = document.getElementById('end-session-name');
    this.endSessionDuration = document.getElementById('end-session-duration');
    this.endSessionConfirmBtn = document.getElementById('end-session-confirm-btn');
    this.endSessionCancelBtn = document.getElementById('end-session-cancel-btn');
    this.endSessionError = document.getElementById('end-session-error');
    this.endSessionDurationInterval = null;

    // Satellite Firmware (USB) Modal elements
    this.firmwareBtn = document.getElementById('firmware-btn');
    this.firmwareModal = document.getElementById('firmware-modal');
    this.firmwareCloseBtn = document.getElementById('firmware-close-btn');
    this.firmwareFlashBtn = document.getElementById('firmware-flash-btn');
    this.firmwareFlashAllBtn = document.getElementById('firmware-flash-all-btn');
    this.firmwareUploadInput = document.getElementById('firmware-upload-input');
    this.firmwareList = document.getElementById('firmware-list');
    this.firmwareListEmpty = document.getElementById('firmware-list-empty');
    this.firmwareRefreshPortsBtn = document.getElementById('firmware-refresh-ports-btn');
    this.firmwarePortSelect = document.getElementById('firmware-port-select');
    this.firmwareProgressContainer = document.getElementById('firmware-progress-container');
    this.firmwareProgressBar = document.getElementById('firmware-progress-bar');
    this.firmwareProgressText = document.getElementById('firmware-progress-text');
    this.firmwareBatchProgress = document.getElementById('firmware-batch-progress');
    this.firmwareError = document.getElementById('firmware-error');
    this.selectedFirmwareFilename = null;
    this.isFlashing = false;
    this.serialPorts = [];
    this.batchFlashPorts = new Map();

    this.labelQueue = [];
    this.labelSnoozedUntil = new Map();
    this.activeLabelDeviceId = null;
    this.labelModalMode = 'create'; // 'create' | 'edit'

    this.initEvents();
  }

  initEvents() {
    this.labelLaterBtn?.addEventListener('click', () => {
      if (this.labelModalMode === 'create' && this.activeLabelDeviceId) {
        this.labelSnoozedUntil.set(this.activeLabelDeviceId, Date.now() + CONFIG.LABEL_SNOOZE_MS);
      }
      this.hideLabelModal();
      this.processLabelQueue();
    });

    this.labelSaveBtn?.addEventListener('click', () => this.handleSaveLabel());

    this.sessionCancelBtn?.addEventListener('click', () => {
      this.hideSessionModal();
    });

    this.sessionSaveBtn?.addEventListener('click', () => this.handleSaveSession());

    this.endSessionCancelBtn?.addEventListener('click', () => {
      this.hideEndSessionModal();
    });

    this.endSessionConfirmBtn?.addEventListener('click', () => this.handleConfirmEndSession());

    this.updateCancelBtn?.addEventListener('click', () => {
      this.hideUpdateModal();
      if (this.updateStatus) this.updateStatus.textContent = '';
    });

    this.updateConfirmBtn?.addEventListener('click', () => this.handleApplyUpdate());

    this.firmwareBtn?.addEventListener('click', () => this.showFirmwareModal());
    this.firmwareCloseBtn?.addEventListener('click', () => this.hideFirmwareModal());
    this.firmwareRefreshPortsBtn?.addEventListener('click', () => this.loadSerialPorts());
    this.firmwareUploadInput?.addEventListener('change', () => this.handleUploadFirmware());
    this.firmwareFlashBtn?.addEventListener('click', () => this.handleFlashFirmware());
    this.firmwareFlashAllBtn?.addEventListener('click', () => this.handleFlashAllFirmware());
    this.firmwarePortSelect?.addEventListener('change', () => this.updateFlashButtonState());
  }

  needsLabel(device) {
    return !(device.label_name && Number.isInteger(device.label_number));
  }

  queueLabelPrompt(deviceId) {
    const d = state.devices.get(deviceId);
    if (!d || !this.needsLabel(d)) return;
    if (this.activeLabelDeviceId === deviceId || this.labelQueue.includes(deviceId)) return;
    const snoozeUntil = this.labelSnoozedUntil.get(deviceId);
    if (snoozeUntil && Date.now() < snoozeUntil) return;
    this.labelQueue.push(deviceId);
    this.processLabelQueue();
  }

  processLabelQueue() {
    if (this.activeLabelDeviceId || this.labelQueue.length === 0) return;
    const deviceId = this.labelQueue.shift();
    const d = state.devices.get(deviceId);
    if (!d || !this.needsLabel(d)) {
      this.processLabelQueue();
      return;
    }
    this.showLabelModal(deviceId, 'create');
  }

  showLabelModal(deviceId, mode = 'create') {
    const d = state.devices.get(deviceId) || {};
    this.labelModalMode = mode;
    this.activeLabelDeviceId = deviceId;
    
    if (this.labelModalTitle) {
      this.labelModalTitle.textContent = mode === 'edit' ? 'Modifier le joueur' : 'Nouveau satellite découvert';
    }
    if (this.labelDeviceIdSpan) {
      this.labelDeviceIdSpan.textContent = deviceId;
    }
    if (this.labelNameInput) {
      this.labelNameInput.value = d.label_name || '';
      this.labelNameInput.focus();
    }
    if (this.labelNumberInput) {
      this.labelNumberInput.value = Number.isInteger(d.label_number) ? d.label_number : '';
    }
    this.labelError?.classList.add('hidden');
    this.labelModal?.classList.remove('hidden');
  }

  hideLabelModal() {
    this.labelModal?.classList.add('hidden');
    this.activeLabelDeviceId = null;
  }

  async handleSaveLabel() {
    const name = this.labelNameInput.value.trim();
    const number = Number(this.labelNumberInput.value);

    if (!name) {
      this.showLabelError('Le nom du joueur est requis.');
      return;
    }
    if (!Number.isInteger(number) || number < 0 || number > 1000) {
      this.showLabelError('Le numéro doit être un nombre entier entre 0 et 1000.');
      return;
    }

    const deviceId = this.activeLabelDeviceId;
    this.labelSaveBtn.disabled = true;

    try {
      const updated = await api.updateDeviceLabel(deviceId, name, number);
      const existing = state.devices.get(deviceId) || { device_id: deviceId };
      state.devices.set(deviceId, {
        ...existing,
        label_name: updated.label_name,
        label_number: updated.label_number,
      });
      state.notify('devices_updated', { devices: state.devices });
      this.hideLabelModal();
      this.processLabelQueue();
    } catch (err) {
      this.showLabelError(err.message);
    } finally {
      this.labelSaveBtn.disabled = false;
    }
  }

  showLabelError(msg) {
    if (this.labelError) {
      this.labelError.textContent = msg;
      this.labelError.classList.remove('hidden');
    }
  }

  // --- Match Session Modal ---

  showSessionModal() {
    if (this.sessionNameInput) {
      const d = new Date();
      const dateStr = d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.sessionNameInput.value = `Match du ${dateStr} à ${timeStr}`;
    }
    if (this.sessionNotesInput) {
      this.sessionNotesInput.value = '';
    }
    this.sessionError?.classList.add('hidden');
    this.sessionModal?.classList.remove('hidden');
    this.sessionNameInput?.focus();
  }

  hideSessionModal() {
    this.sessionModal?.classList.add('hidden');
  }

  async handleSaveSession() {
    const name = this.sessionNameInput?.value.trim();
    const notes = this.sessionNotesInput?.value.trim() || '';

    if (!name) {
      if (this.sessionError) {
        this.sessionError.textContent = 'Le titre du match est requis.';
        this.sessionError.classList.remove('hidden');
      }
      return;
    }

    if (this.sessionSaveBtn) this.sessionSaveBtn.disabled = true;

    try {
      const newSession = await api.createSession(name, notes);
      state.activeSession = newSession;
      state.sessions = [newSession, ...state.sessions.map((s) => ({ ...s, is_active: false }))];
      state.setSelectedSessionId(newSession.id);
      state.clearSessionMaxG();
      this.hideSessionModal();
    } catch (err) {
      if (this.sessionError) {
        this.sessionError.textContent = err.message;
        this.sessionError.classList.remove('hidden');
      }
    } finally {
      if (this.sessionSaveBtn) this.sessionSaveBtn.disabled = false;
    }
  }

  // --- End Match / Terminate Session Modal ---

  showEndSessionModal() {
    const activeSession = state.activeSession;
    if (!activeSession?.is_active) return;

    if (this.endSessionName) this.endSessionName.textContent = activeSession.name;
    this.endSessionError?.classList.add('hidden');
    if (this.endSessionConfirmBtn) this.endSessionConfirmBtn.disabled = false;

    const updateDuration = () => {
      if (this.endSessionDuration && activeSession.start_time) {
        this.endSessionDuration.textContent = formatDuration(Date.now() / 1000 - activeSession.start_time);
      }
    };
    updateDuration();
    clearInterval(this.endSessionDurationInterval);
    this.endSessionDurationInterval = setInterval(updateDuration, 1000);

    this.endSessionModal?.classList.remove('hidden');
  }

  hideEndSessionModal() {
    clearInterval(this.endSessionDurationInterval);
    this.endSessionModal?.classList.add('hidden');
  }

  async handleConfirmEndSession() {
    const activeSession = state.activeSession;
    if (!activeSession?.is_active) {
      this.hideEndSessionModal();
      return;
    }

    if (this.endSessionConfirmBtn) this.endSessionConfirmBtn.disabled = true;

    try {
      const endedSession = await api.endSession(activeSession.id);
      state.handleWebSocketMessage({ type: 'session_ended', session: endedSession });
      this.hideEndSessionModal();
    } catch (err) {
      if (this.endSessionError) {
        this.endSessionError.textContent = `Impossible de terminer le match : ${err.message}`;
        this.endSessionError.classList.remove('hidden');
      }
    } finally {
      if (this.endSessionConfirmBtn) this.endSessionConfirmBtn.disabled = false;
    }
  }

  showUpdateModal(currentVersion, latestVersion) {
    if (this.currentVersionSpan) this.currentVersionSpan.textContent = currentVersion;
    if (this.latestVersionSpan) this.latestVersionSpan.textContent = latestVersion;
    this.updateModal?.classList.remove('hidden');
  }

  hideUpdateModal() {
    this.updateModal?.classList.add('hidden');
  }

  async handleApplyUpdate() {
    this.updateConfirmBtn.disabled = true;
    this.updateCancelBtn.disabled = true;
    this.showUpdateProgress();

    let progress = 0;
    const progressInterval = setInterval(() => {
      progress += Math.random() * 20;
      if (progress > 90) progress = 90;
      this.setUpdateProgress(progress, 'Mise à jour en cours...');
    }, 500);

    try {
      await api.applyUpdate();
      clearInterval(progressInterval);
      this.setUpdateProgress(100, 'Installation terminée, redémarrage...');
      if (this.updateStatus) this.updateStatus.textContent = 'Mise à jour appliquée, redémarrage...';
      setTimeout(() => window.location.reload(), 8000);
    } catch (err) {
      clearInterval(progressInterval);
      this.setUpdateProgress(0, 'Échec de la mise à jour');
      if (this.updateStatus) this.updateStatus.textContent = 'Échec de la mise à jour.';
      this.updateConfirmBtn.disabled = false;
      this.updateCancelBtn.disabled = false;
      console.error('Update failed:', err);
    }
  }

  showUpdateProgress() {
    this.updateMessage?.classList.add('hidden');
    this.versionInfo?.classList.add('hidden');
    this.updateProgressContainer?.classList.remove('hidden');
    this.setUpdateProgress(0, 'Téléchargement...');
  }

  setUpdateProgress(percent, text) {
    if (this.updateProgressBar) this.updateProgressBar.style.width = `${percent}%`;
    if (this.updateProgressText && text) this.updateProgressText.textContent = text;
  }

  // --- Satellite Firmware Modal (USB flashing) ---

  showFirmwareModal(preferredVersion = null) {
    this.firmwareError?.classList.add('hidden');
    this.firmwareProgressContainer?.classList.add('hidden');
    this.firmwareBatchProgress?.classList.add('hidden');
    this.batchFlashPorts.clear();
    this.firmwareModal?.classList.remove('hidden');
    this.pendingPreferredFirmwareVersion = preferredVersion;
    this.loadFirmwareList();
    this.loadSerialPorts();
  }

  hideFirmwareModal() {
    if (this.isFlashing) return; // don't let the user lose track of an in-progress flash
    this.firmwareModal?.classList.add('hidden');
  }

  async loadFirmwareList() {
    try {
      const list = await api.fetchFirmwareList();
      this.renderFirmwareList(list);
    } catch (err) {
      this.showFirmwareError(err.message);
    }
  }

  renderFirmwareList(list) {
    if (!this.firmwareList) return;
    if (!list.length) {
      this.selectedFirmwareFilename = null;
      this.firmwareList.innerHTML = '<p class="text-muted" id="firmware-list-empty">Aucun firmware importé.</p>';
      this.updateFlashButtonState();
      return;
    }
    const preferred = list.find((f) => f.version === this.pendingPreferredFirmwareVersion);
    if (preferred) {
      this.selectedFirmwareFilename = preferred.filename;
    } else if (!list.some((f) => f.filename === this.selectedFirmwareFilename)) {
      const newest = [...list].sort((a, b) => (b.version || '').localeCompare(a.version || '', undefined, { numeric: true }))[0];
      this.selectedFirmwareFilename = newest.filename;
    }
    this.pendingPreferredFirmwareVersion = null;
    this.firmwareList.innerHTML = list.map((f) => {
      const sizeKb = (f.size / 1024).toFixed(0);
      const selected = f.filename === this.selectedFirmwareFilename;
      return `
        <div class="firmware-list-item ${selected ? 'selected' : ''}" data-filename="${f.filename}">
          <span class="firmware-name">${f.filename}</span>
          <span class="firmware-meta">${sizeKb} Ko</span>
        </div>
      `;
    }).join('');
    this.firmwareList.querySelectorAll('.firmware-list-item').forEach((el) => {
      el.addEventListener('click', () => {
        this.selectedFirmwareFilename = el.dataset.filename;
        this.renderFirmwareList(list);
      });
    });
    this.updateFlashButtonState();
  }

  async handleUploadFirmware() {
    const file = this.firmwareUploadInput?.files?.[0];
    if (!file) return;
    this.firmwareError?.classList.add('hidden');
    try {
      const result = await api.uploadFirmware(file);
      this.selectedFirmwareFilename = result.filename;
      await this.loadFirmwareList();
    } catch (err) {
      this.showFirmwareError(err.message);
    } finally {
      this.firmwareUploadInput.value = '';
    }
  }

  async loadSerialPorts() {
    if (!this.firmwarePortSelect) return;
    try {
      const ports = await api.fetchSerialPorts();
      this.serialPorts = ports;
      const previousValue = this.firmwarePortSelect.value;
      if (!ports.length) {
        this.firmwarePortSelect.innerHTML = '<option value="">Aucun port détecté</option>';
      } else {
        this.firmwarePortSelect.innerHTML = ports.map((p) => {
          const label = `${p.device}${p.likely_satellite ? ' — Satellite détecté' : ''}${p.description ? ` (${p.description})` : ''}`;
          return `<option value="${p.device}">${label}</option>`;
        }).join('');
        const stillPresent = ports.some((p) => p.device === previousValue);
        const preferred = stillPresent ? previousValue : (ports.find((p) => p.likely_satellite) || ports[0]).device;
        this.firmwarePortSelect.value = preferred;
      }
    } catch (err) {
      this.showFirmwareError(err.message);
    }
    this.updateFlashButtonState();
  }

  updateFlashButtonState() {
    const hasFirmware = Boolean(this.selectedFirmwareFilename);
    const hasPort = Boolean(this.firmwarePortSelect?.value);
    const hasSatellite = this.serialPorts.some((port) => port.likely_satellite);
    if (this.firmwareFlashBtn) {
      this.firmwareFlashBtn.disabled = this.isFlashing || !hasFirmware || !hasPort;
    }
    if (this.firmwareFlashAllBtn) {
      this.firmwareFlashAllBtn.disabled = this.isFlashing || !hasFirmware || !hasSatellite;
    }
  }

  async handleFlashFirmware() {
    const port = this.firmwarePortSelect?.value;
    const filename = this.selectedFirmwareFilename;
    if (!port || !filename) return;

    this.firmwareError?.classList.add('hidden');
    this.isFlashing = true;
    this.updateFlashButtonState();
    this.firmwareCloseBtn?.setAttribute('disabled', 'true');
    this.firmwareProgressContainer?.classList.remove('hidden');
    this.setFirmwareProgress(0, 'Démarrage...');

    try {
      await api.flashFirmware(port, filename);
    } catch (err) {
      this.isFlashing = false;
      this.firmwareCloseBtn?.removeAttribute('disabled');
      this.updateFlashButtonState();
      this.showFirmwareError(err.message);
    }
  }

  async handleFlashAllFirmware() {
    const filename = this.selectedFirmwareFilename;
    const ports = this.serialPorts.filter((port) => port.likely_satellite).map((port) => port.device);
    if (!filename || ports.length === 0) return;

    this.firmwareError?.classList.add('hidden');
    this.isFlashing = true;
    this.batchFlashPorts = new Map(ports.map((port) => [port, {
      stage: 'waiting', percent: 0, message: 'En attente...',
    }]));
    this.firmwareProgressContainer?.classList.add('hidden');
    this.firmwareBatchProgress?.classList.remove('hidden');
    this.renderBatchFlashProgress();
    this.updateFlashButtonState();
    this.firmwareCloseBtn?.setAttribute('disabled', 'true');

    try {
      await api.flashAllFirmware(filename);
    } catch (err) {
      this.isFlashing = false;
      this.batchFlashPorts.clear();
      this.firmwareBatchProgress?.classList.add('hidden');
      this.firmwareCloseBtn?.removeAttribute('disabled');
      this.updateFlashButtonState();
      this.showFirmwareError(err.message);
    }
  }

  renderBatchFlashProgress() {
    if (!this.firmwareBatchProgress) return;
    this.firmwareBatchProgress.innerHTML = Array.from(this.batchFlashPorts.entries()).map(([port, status]) => {
      const isDone = status.stage === 'done';
      const isError = status.stage === 'error';
      const percent = Math.max(0, Math.min(100, Number(status.percent) || 0));
      return `
        <div class="firmware-batch-item ${isDone ? 'is-done' : ''} ${isError ? 'is-error' : ''}">
          <span class="firmware-batch-port">${escapeHtml(port)}</span>
          <span class="firmware-batch-status">${escapeHtml(status.message)}</span>
          <div class="progress-bar-wrapper"><div class="progress-bar" style="width:${percent}%"></div></div>
        </div>
      `;
    }).join('');
  }

  /** Called by the app for every 'firmware_flash' WebSocket progress message. */
  handleFirmwareProgress(msg) {
    if (msg.batch) {
      this.handleBatchFirmwareProgress(msg);
      return;
    }

    if (msg.stage === 'error') {
      this.isFlashing = false;
      this.firmwareCloseBtn?.removeAttribute('disabled');
      this.updateFlashButtonState();
      this.showFirmwareError(msg.message);
      return;
    }

    this.setFirmwareProgress(msg.percent ?? 0, msg.message);

    if (msg.stage === 'done') {
      this.isFlashing = false;
      this.firmwareCloseBtn?.removeAttribute('disabled');
      this.updateFlashButtonState();
    }
  }

  handleBatchFirmwareProgress(msg) {
    const status = this.batchFlashPorts.get(msg.port);
    if (!status) return;

    status.stage = msg.stage;
    status.percent = msg.percent ?? status.percent;
    status.message = msg.message || status.message;
    this.renderBatchFlashProgress();

    const complete = Array.from(this.batchFlashPorts.values()).every(
      (entry) => entry.stage === 'done' || entry.stage === 'error',
    );
    if (complete) {
      this.isFlashing = false;
      this.firmwareCloseBtn?.removeAttribute('disabled');
      this.updateFlashButtonState();
      this.loadSerialPorts();
    }
  }

  setFirmwareProgress(percent, text) {
    if (this.firmwareProgressBar) this.firmwareProgressBar.style.width = `${percent}%`;
    if (this.firmwareProgressText && text) this.firmwareProgressText.textContent = text;
  }

  showFirmwareError(msg) {
    if (this.firmwareError) {
      this.firmwareError.textContent = msg;
      this.firmwareError.classList.remove('hidden');
    }
  }
}
