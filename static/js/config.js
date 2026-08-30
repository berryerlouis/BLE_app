/**
 * Application Configuration & Constants
 */
export const CONFIG = {
  MAX_LIVE_CHART_POINTS: 3000,    // Keep up to 3,000 live streaming points in browser memory
  MAX_SESSION_CHART_POINTS: 50000, // Show entire session history up to 50,000 points
  MAX_SESSION_RENDER_POINTS: 4000, // Decimate a full-session chart above this size so it stays fast to draw
  DEFAULT_VISIBLE_POINTS: 50,     // Live sliding follow window
  MAX_LOG_LINES: 5000,
  MAX_DOM_LOG_LINES: 300,         // Keep DOM log panel performant
  DEFAULT_IMPACT_THRESHOLD: 8.0,  // in g
  MAX_IMPACT_THRESHOLD: 200.0,
  LABEL_SNOOZE_MS: 60 * 1000,
  WS_RECONNECT_DELAY_MS: 2000,
  UPDATE_CHECK_INTERVAL_MS: 5 * 60 * 1000,
  
  // Theme Colors
  COLORS: {
    accent: '#38bdf8',       // Sky blue
    accentHover: '#0ea5e9',
    success: '#10b981',      // Emerald green
    warning: '#f59e0b',      // Amber
    danger: '#ef4444',       // Crimson red
    dangerGlow: 'rgba(239, 68, 68, 0.35)',
    purple: '#a855f7',
    textMain: '#f1f5f9',
    textMuted: '#94a3b8',
    chartAx: '#38bdf8',
    chartAy: '#ec4899',
    chartAz: '#10b981',
    chartMag: '#f1f5f9',
    chartThreshold: '#ef4444',
    chartGyroX: '#38bdf8',
    chartGyroY: '#ec4899',
    chartGyroZ: '#10b981',
    chartTemp: '#f59e0b',
  }
};
