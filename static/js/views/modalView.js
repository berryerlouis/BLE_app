/**
 * Modals & Dialogs Management
 */
import { CONFIG } from '../config.js?v=20261021-wahoo-modals';
import { api } from '../api.js?v=20261020-rotation-toggle';
import { state } from '../state.js?v=20261020-rotation-toggle';
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
    this.labelDeleteBtn = document.getElementById('label-delete-btn');

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
    this.firmwareFlashAllBtn = document.getElementById('firmware-flash-all-btn');
    this.firmwareUploadInput = document.getElementById('firmware-upload-input');
    this.firmwareList = document.getElementById('firmware-list');
    this.firmwareListEmpty = document.getElementById('firmware-list-empty');
    this.firmwareRefreshPortsBtn = document.getElementById('firmware-refresh-ports-btn');
    this.firmwarePortsSummary = document.getElementById('firmware-ports-summary');
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
    this.labelWarning = document.getElementById('label-warning');
    this.duplicateAckKey = null;

    this.confirmModal = document.getElementById('confirm-modal');
    this.confirmTitle = document.getElementById('confirm-title');
    this.confirmMessage = document.getElementById('confirm-message');
    this.confirmOkBtn = document.getElementById('confirm-ok-btn');
    this.confirmCancelBtn = document.getElementById('confirm-cancel-btn');
    this.confirmResolver = null;

    this.firmwareBusyHint = document.getElementById('firmware-busy-hint');
    this.firmwareItems = [];
    this.firmwareStallTimer = null;

    this.updateRestartTimer = null;

    this.initEvents();
  }

  toggleModal(el, visible) {
    el?.classList.toggle('hidden', !visible);
  }

  initEvents() {
    this.labelNameInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.handleSaveLabel();
    });
    this.labelNumberInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.handleSaveLabel();
    });
    this.labelNameInput?.addEventListener('input', () => this.resetDuplicateAck());
    this.labelNumberInput?.addEventListener('input', () => this.resetDuplicateAck());

    this.confirmOkBtn?.addEventListener('click', () => this.closeConfirm(true));
    this.confirmCancelBtn?.addEventListener('click', () => this.closeConfirm(false));

    this.sessionModal?.addEventListener('click', (event) => {
      if (event.target === this.sessionModal) this.hideSessionModal();
    });
    this.endSessionModal?.addEventListener('click', (event) => {
      if (event.target === this.endSessionModal) this.hideEndSessionModal();
    });
    this.firmwareModal?.addEventListener('click', (event) => {
      if (event.target === this.firmwareModal) this.hideFirmwareModal();
    });
    document.addEventListener('keydown', (event) => this.handleGlobalEscape(event));

    // Event delegation: one listener serves every firmware row, even after re-rendering.
    this.firmwareList?.addEventListener('click', (event) => {
      const item = event.target.closest('.firmware-list-item');
      if (!item) return;
      this.selectedFirmwareFilename = item.dataset.filename;
      this.renderFirmwareList(this.firmwareItems);
    });

    this.labelLaterBtn?.addEventListener('click', () => {
      if (this.labelModalMode === 'create' && this.activeLabelDeviceId) {
        this.labelSnoozedUntil.set(this.activeLabelDeviceId, Date.now() + CONFIG.LABEL_SNOOZE_MS);
      }
      this.hideLabelModal();
      this.processLabelQueue();
    });

    this.labelSaveBtn?.addEventListener('click', () => this.handleSaveLabel());
    this.labelDeleteBtn?.addEventListener('click', () => this.handleDeleteDevice());

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
    this.firmwareFlashAllBtn?.addEventListener('click', () => this.handleFlashAllFirmware());
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
    this.resetDuplicateAck();
    this.labelDeleteBtn?.classList.toggle('hidden', mode !== 'edit');
    this.labelModal?.classList.remove('hidden');
  }

  hideLabelModal() {
    this.labelModal?.classList.add('hidden');
    this.activeLabelDeviceId = null;
  }

  async handleDeleteDevice() {
    const deviceId = this.activeLabelDeviceId;
    if (!deviceId) return;

    const device = state.devices.get(deviceId) || {};
    const name = device.label_name || device.device_name || deviceId;
    const confirmed = await this.confirm({
      eyebrow: 'Retrait',
      title: 'Retirer ce satellite ?',
      message: `« ${name} » sera retiré de la liste actuelle. Ses données dans les matchs archivés seront conservées.`,
      okLabel: 'Retirer',
      danger: true,
    });
    if (!confirmed) return;

    if (this.labelDeleteBtn) this.labelDeleteBtn.disabled = true;
    try {
      await api.deleteDevice(deviceId);
      state.handleWebSocketMessage({ type: 'device_deleted', device_id: deviceId });
      this.hideLabelModal();
      this.processLabelQueue();
    } catch (err) {
      this.showLabelError(err.message);
    } finally {
      if (this.labelDeleteBtn) this.labelDeleteBtn.disabled = false;
    }
  }

  /** Promise-based in-app replacement for window.confirm. */
  confirm({ eyebrow = 'Confirmation', title, message, okLabel = 'Confirmer', danger = false }) {
    if (!this.confirmModal) return Promise.resolve(window.confirm(message));
    // A new request cancels any pending one so its promise is not left hanging.
    if (this.confirmResolver) this.closeConfirm(false);

    this.confirmModal.querySelector('.modal-eyebrow').textContent = eyebrow;
    this.confirmTitle.textContent = title;
    this.confirmMessage.textContent = message;
    this.confirmOkBtn.textContent = okLabel;
    this.confirmOkBtn.classList.toggle('btn-danger', danger);
    this.toggleModal(this.confirmModal, true);
    this.confirmOkBtn.focus();

    return new Promise((resolve) => {
      this.confirmResolver = resolve;
    });
  }

  closeConfirm(result) {
    this.toggleModal(this.confirmModal, false);
    const resolve = this.confirmResolver;
    this.confirmResolver = null;
    resolve?.(result);
  }

  /** Escape closes the topmost dismissable modal. The label modal is excluded: closing it means "later". */
  handleGlobalEscape(event) {
    if (event.key !== 'Escape') return;
    if (this.confirmResolver) {
      this.closeConfirm(false);
    } else if (this.endSessionModal && !this.endSessionModal.classList.contains('hidden')) {
      this.hideEndSessionModal();
    } else if (this.sessionModal && !this.sessionModal.classList.contains('hidden')) {
      this.hideSessionModal();
    } else if (this.firmwareModal && !this.firmwareModal.classList.contains('hidden')) {
      this.hideFirmwareModal();
    }
  }

  findDuplicateNumber(number, deviceId) {
    for (const [id, device] of state.devices) {
      if (id !== deviceId && device.label_number === number) return device;
    }
    return null;
  }

  resetDuplicateAck() {
    this.duplicateAckKey = null;
    this.toggleModal(this.labelWarning, false);
  }

  async handleSaveLabel() {
    const name = this.labelNameInput?.value.trim() || '';
    const number = Number(this.labelNumberInput?.value);

    if (!name) {
      this.showLabelError('Le nom du joueur est requis.');
      return;
    }
    if (!Number.isInteger(number) || number < 0 || number > 1000) {
      this.showLabelError('Le numéro doit être un nombre entier entre 0 et 1000.');
      return;
    }

    const deviceId = this.activeLabelDeviceId;
    if (!deviceId) return;

    // Warn once about a duplicate number; a second click on the same choice saves anyway.
    const duplicate = this.findDuplicateNumber(number, deviceId);
    const ackKey = `${deviceId}:${number}`;
    if (duplicate && this.duplicateAckKey !== ackKey) {
      this.duplicateAckKey = ackKey;
      if (this.labelWarning) {
        this.labelWarning.textContent = `Le numéro ${number} est déjà utilisé par « ${duplicate.label_name || duplicate.device_id} ». Cliquez à nouveau pour l'attribuer quand même.`;
      }
      this.toggleModal(this.labelWarning, true);
      return;
    }

    if (this.labelSaveBtn) this.labelSaveBtn.disabled = true;

    try {
      const updated = await api.updateDeviceLabel(deviceId, name, number);
      const existing = state.devices.get(deviceId) || { device_id: deviceId };
      state.devices.set(deviceId, {
        ...existing,
        label_name: updated.label_name,
        label_number: updated.label_number,
      });
      state.notify('devices_updated', { devices: state.devices });
      this.resetDuplicateAck();
      this.hideLabelModal();
      this.processLabelQueue();
    } catch (err) {
      this.showLabelError(err.message);
    } finally {
      if (this.labelSaveBtn) this.labelSaveBtn.disabled = false;
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
    if (this.updateConfirmBtn) this.updateConfirmBtn.disabled = true;
    if (this.updateCancelBtn) this.updateCancelBtn.disabled = true;
    this.showUpdateProgress();

    try {
      await api.applyUpdate();
    } catch (err) {
      this.setUpdateProgress(0, 'Échec de la mise à jour');
      if (this.updateStatus) this.updateStatus.textContent = 'Échec de la mise à jour.';
      if (this.updateConfirmBtn) this.updateConfirmBtn.disabled = false;
      if (this.updateCancelBtn) this.updateCancelBtn.disabled = false;
      console.error('Update failed:', err);
      return;
    }

    // The server restarts after applying the update, so there is no progress to read from it.
    this.setUpdateProgress(100, 'Installation terminée, redémarrage du serveur...');
    if (this.updateStatus) this.updateStatus.textContent = 'Mise à jour appliquée, redémarrage...';
    this.waitForServerThenReload();
  }

  /** Polls until the server answers again, then reloads the page. */
  waitForServerThenReload() {
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        await api.checkUpdate();
        window.location.reload();
        return;
      } catch {
        // Server is still restarting.
      }
      if (attempts >= CONFIG.UPDATE_RESTART_MAX_POLLS) {
        this.setUpdateProgress(100, 'Le serveur ne répond pas. Rechargez la page manuellement.');
        if (this.updateStatus) this.updateStatus.textContent = 'Redémarrage trop long.';
        return;
      }
      this.updateRestartTimer = setTimeout(poll, CONFIG.UPDATE_RESTART_POLL_MS);
    };
    this.updateRestartTimer = setTimeout(poll, CONFIG.UPDATE_RESTART_DELAY_MS);
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
    this.firmwareBatchProgress?.classList.add('hidden');
    this.batchFlashPorts.clear();
    this.firmwareModal?.classList.remove('hidden');
    this.pendingPreferredFirmwareVersion = preferredVersion;
    this.loadFirmwareList();
    this.loadSerialPorts();
  }

  hideFirmwareModal() {
    if (this.isFlashing) {
      // Explain why the close was refused instead of ignoring the click.
      this.toggleModal(this.firmwareBusyHint, true);
      return;
    }
    this.toggleModal(this.firmwareBusyHint, false);
    this.toggleModal(this.firmwareModal, false);
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
    this.firmwareItems = list;
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
        <div class="firmware-list-item ${selected ? 'selected' : ''}" data-filename="${escapeHtml(f.filename)}">
          <span class="firmware-name">${escapeHtml(f.filename)}</span>
          <span class="firmware-meta">${escapeHtml(sizeKb)} Ko</span>
        </div>
      `;
    }).join('');
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
    try {
      const ports = await api.fetchSerialPorts();
      this.serialPorts = ports;
      const satellites = ports.filter((port) => port.likely_satellite);
      if (this.firmwarePortsSummary) {
        this.firmwarePortsSummary.textContent = satellites.length
          ? `${satellites.length} carte${satellites.length > 1 ? 's' : ''} détectée${satellites.length > 1 ? 's' : ''} : ${satellites.map((port) => port.device).join(', ')}`
          : 'Aucune carte satellite détectée.';
      }
    } catch (err) {
      this.showFirmwareError(err.message);
    }
    this.updateFlashButtonState();
  }

  updateFlashButtonState() {
    const hasFirmware = Boolean(this.selectedFirmwareFilename);
    const hasSatellite = this.serialPorts.some((port) => port.likely_satellite);
    if (this.firmwareFlashAllBtn) {
      this.firmwareFlashAllBtn.disabled = this.isFlashing || !hasFirmware || !hasSatellite;
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
    this.firmwareBatchProgress?.classList.remove('hidden');
    this.renderBatchFlashProgress();
    this.updateFlashButtonState();
    this.firmwareCloseBtn?.setAttribute('disabled', 'true');
    this.armFlashWatchdog();

    try {
      await api.flashAllFirmware(filename);
    } catch (err) {
      this.endFlash();
      this.firmwareBatchProgress?.classList.add('hidden');
      this.showFirmwareError(err.message);
    }
  }

  /** Restarts the no-message timer. If the batch goes silent, the UI is unlocked instead of staying stuck. */
  armFlashWatchdog() {
    clearTimeout(this.firmwareStallTimer);
    this.firmwareStallTimer = setTimeout(() => {
      if (!this.isFlashing) return;
      this.endFlash();
      this.showFirmwareError('Aucune réponse de la carte depuis plus de 2 minutes. Vérifiez les connexions puis relancez le flash.');
      this.loadSerialPorts();
    }, CONFIG.FLASH_STALL_MS);
  }

  endFlash() {
    clearTimeout(this.firmwareStallTimer);
    this.firmwareStallTimer = null;
    this.isFlashing = false;
    this.batchFlashPorts.clear();
    this.firmwareCloseBtn?.removeAttribute('disabled');
    this.toggleModal(this.firmwareBusyHint, false);
    this.updateFlashButtonState();
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
          <span class="firmware-batch-percent">${percent}%</span>
          <span class="firmware-batch-status">${escapeHtml(status.message)}</span>
          <div class="progress-bar-wrapper"><div class="progress-bar" style="width:${percent}%"></div></div>
        </div>
      `;
    }).join('');
  }

  /** Called by the app for every 'firmware_flash' WebSocket progress message. */
  handleFirmwareProgress(msg) {
    if (msg.batch) this.handleBatchFirmwareProgress(msg);
  }

  handleBatchFirmwareProgress(msg) {
    const status = this.batchFlashPorts.get(msg.port);
    if (!status) return;

    status.stage = msg.stage;
    status.percent = msg.percent ?? status.percent;
    status.message = msg.message || status.message;
    this.renderBatchFlashProgress();
    this.armFlashWatchdog();

    const complete = Array.from(this.batchFlashPorts.values()).every(
      (entry) => entry.stage === 'done' || entry.stage === 'error',
    );
    if (complete) {
      this.endFlash();
      this.loadSerialPorts();
    }
  }

  showFirmwareError(msg) {
    if (this.firmwareError) {
      this.firmwareError.textContent = msg;
      this.firmwareError.classList.remove('hidden');
    }
  }
}
