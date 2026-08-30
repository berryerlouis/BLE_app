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
