/**
 * Formatting & Math Utility Functions
 */
import { CONFIG } from './config.js';

export function fmt(num, digits = 2) {
  if (num === null || num === undefined || Number.isNaN(Number(num))) {
    return '--';
  }
  return Number(num).toFixed(digits);
}

export function calcAccelMagnitude(ax, ay, az) {
  if (ax === undefined || ay === undefined || az === undefined) return 0;
  return Math.sqrt(Number(ax) ** 2 + Number(ay) ** 2 + Number(az) ** 2);
}

export function getDeviceDisplayName(device) {
  if (!device) return 'Inconnu';
  if (device.label_name && Number.isInteger(device.label_number)) {
    return `${device.label_name} #${device.label_number}`;
  }
  return device.device_name || device.device_id || 'Satellite inconnu';
}

export function getDevicePlayerNumber(device) {
  if (device && Number.isInteger(device.label_number)) {
    return `#${device.label_number}`;
  }
  return '';
}

export function getDeviceThreshold(device) {
  return typeof device?.impact_threshold === 'number'
    ? device.impact_threshold
    : CONFIG.DEFAULT_IMPACT_THRESHOLD;
}

export function formatTimestamp(timestampSec) {
  if (!timestampSec) return '--';
  const d = new Date(timestampSec * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(timestampSec) {
  if (!timestampSec) return '--';
  const d = new Date(timestampSec * 1000);
  return d.toLocaleString([], {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Formats a duration in seconds as "MM:SS" or "HH:MM:SS" once it reaches an hour. */
export function formatDuration(totalSeconds) {
  const secs = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function getBatteryStatus(percentage) {
  if (percentage === undefined || percentage === null) {
    return { level: 'unknown', icon: 'battery-medium', text: '--' };
  }
  const pct = Math.max(0, Math.min(100, Math.round(percentage)));
  if (pct > 75) return { level: 'full', icon: 'battery-full', text: `${pct}%`, color: 'var(--color-success)' };
  if (pct > 35) return { level: 'medium', icon: 'battery-medium', text: `${pct}%`, color: 'var(--color-accent)' };
  if (pct > 15) return { level: 'low', icon: 'battery-low', text: `${pct}%`, color: 'var(--color-warning)' };
  return { level: 'critical', icon: 'battery-warning', text: `${pct}%`, color: 'var(--color-danger)' };
}

export function getRssiStatus(rssi) {
  if (rssi === undefined || rssi === null) {
    return { level: 'unknown', icon: 'signal-zero', text: '--', label: '--', color: 'var(--color-muted, #888)' };
  }
  const val = Number(rssi);
  if (val >= -60) return { level: 'good', icon: 'signal-high', text: `${val} dBm`, label: 'Bon', color: 'var(--color-success)' };
  if (val >= -75) return { level: 'medium', icon: 'signal-medium', text: `${val} dBm`, label: 'Moyen', color: 'var(--color-accent)' };
  return { level: 'bad', icon: 'signal-low', text: `${val} dBm`, label: 'Faible', color: 'var(--color-danger)' };
}

/**
 * Maps the raw BLE lifecycle state (advertising/connecting/connected/subscribed/disconnected)
 * to a user-facing label, icon and dot/text style so the UI never just says a flat "Connected".
 */
export function getDeviceLinkState(device) {
  const state = device?.state || (device?.connected ? 'connected' : 'disconnected');
  switch (state) {
    case 'advertising':
      return { state, label: 'Détecté (annonce BLE)', dotClass: 'dot-advertising', textClass: 'text-warning', icon: 'radio', spin: false };
    case 'connecting':
      return { state, label: 'Connexion en cours...', dotClass: 'dot-connecting', textClass: 'text-accent', icon: 'loader', spin: true };
    case 'connected':
      return { state, label: 'Connecté (abonnement...)', dotClass: 'dot-connecting', textClass: 'text-accent', icon: 'link', spin: false };
    case 'subscribed':
      return { state, label: 'En direct (données live)', dotClass: 'dot-online', textClass: 'text-online', icon: 'activity', spin: false };
    default:
      return { state: 'disconnected', label: 'Hors ligne', dotClass: 'dot-offline', textClass: 'text-offline', icon: 'wifi-off', spin: false };
  }
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Top Progress Bar Controller
 */
export const progressBar = {
  bar: null,
  fill: null,
  init() {
    this.bar = document.getElementById('global-progress-bar');
    this.fill = document.getElementById('global-progress-bar-fill');
  },
  start() {
    if (!this.bar || !this.fill) this.init();
    if (!this.bar || !this.fill) return;
    this.bar.classList.remove('hidden');
    this.fill.style.transition = 'width 0.2s ease, opacity 0.3s ease';
    this.fill.style.opacity = '1';
    this.fill.style.width = '25%';
  },
  set(percent) {
    if (!this.bar || !this.fill) this.init();
    if (!this.fill) return;
    this.fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  },
  complete() {
    if (!this.bar || !this.fill) this.init();
    if (!this.fill) return;
    this.fill.style.width = '100%';
    setTimeout(() => {
      if (this.fill) this.fill.style.opacity = '0';
      setTimeout(() => {
        if (this.bar) this.bar.classList.add('hidden');
        if (this.fill) {
          this.fill.style.width = '0%';
          this.fill.style.opacity = '1';
        }
      }, 300);
    }, 250);
  },
};

/**
 * Session Loading Toast Controller
 * Gives the user a clear, explicit readout of what session is loading and how far along it is,
 * on top of the subtle global progress bar.
 */
export const sessionLoader = {
  toast: null,
  textEl: null,
  fillEl: null,
  percentEl: null,
  hideTimeout: null,
  init() {
    this.toast = document.getElementById('session-loading-toast');
    this.textEl = document.getElementById('session-loading-text');
    this.fillEl = document.getElementById('session-loading-bar-fill');
    this.percentEl = document.getElementById('session-loading-percent');
  },
  show(label = 'Chargement de la session...') {
    if (!this.toast) this.init();
    if (!this.toast) return;
    clearTimeout(this.hideTimeout);
    this.toast.classList.remove('hidden');
    if (this.textEl) this.textEl.textContent = label;
    this.update(5);
  },
  update(percent, label) {
    if (!this.toast) this.init();
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    if (this.fillEl) this.fillEl.style.width = `${clamped}%`;
    if (this.percentEl) this.percentEl.textContent = `${clamped}%`;
    if (label && this.textEl) this.textEl.textContent = label;
  },
  hide() {
    if (!this.toast) this.init();
    if (!this.toast) return;
    this.update(100);
    clearTimeout(this.hideTimeout);
    this.hideTimeout = setTimeout(() => {
      this.toast?.classList.add('hidden');
    }, 300);
  },
};
