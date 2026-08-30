/**
 * Modals & Dialogs Management
 */
import { CONFIG } from '../config.js';
import { api } from '../api.js';
import { state } from '../state.js';
import { formatDuration } from '../utils.js';

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
}
