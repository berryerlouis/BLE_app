/**
 * Chart.js Integration & Visualizations
 * High-performance RAF rendering & Full Session Zoom/Pan
 */
import { CONFIG } from './config.js';
import { calcAccelMagnitude } from './utils.js';

export class ChartManager {
  constructor() {
    this.charts = null;
    this.userNavigated = false;
    this.isSessionMode = false; // true = viewing entire match session, false = live streaming
    this.dirty = false;
    this.rafId = null;

    this.startRafLoop();
  }

  startRafLoop() {
    const renderLoop = () => {
      if (this.dirty && this.charts) {
        this.flushChartUpdates();
        this.dirty = false;
      }
      this.rafId = requestAnimationFrame(renderLoop);
    };
    this.rafId = requestAnimationFrame(renderLoop);
  }

  createChart(ctx, datasetsConfig, yAxisLabel = '') {
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: datasetsConfig.map((cfg) => ({
          label: cfg.label,
          data: [],
          hidden: Boolean(cfg.hidden),
          borderColor: cfg.color,
          backgroundColor: cfg.bgColor || 'transparent',
          borderWidth: cfg.borderWidth || 2,
          borderDash: cfg.borderDash || [],
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.1,
          spanGaps: true,
        })),
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        scales: {
          x: {
            display: true,
            ticks: {
              color: CONFIG.COLORS.textMuted,
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 12,
              font: { family: '-apple-system, system-ui, sans-serif', size: 11 },
            },
            grid: { color: 'rgba(255, 255, 255, 0.06)' },
          },
          y: {
            display: true,
            title: yAxisLabel ? { display: true, text: yAxisLabel, color: CONFIG.COLORS.textMuted } : { display: false },
            ticks: {
              color: CONFIG.COLORS.textMuted,
              font: { family: '-apple-system, system-ui, sans-serif', size: 11 },
            },
            grid: { color: 'rgba(255, 255, 255, 0.06)' },
          },
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: {
              color: CONFIG.COLORS.textMain,
              boxWidth: 12,
              usePointStyle: true,
              pointStyle: 'circle',
              font: { family: '-apple-system, system-ui, sans-serif', size: 12 },
            },
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.92)',
            titleColor: '#f8fafc',
            bodyColor: '#cbd5e1',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            padding: 8,
            cornerRadius: 8,
          },
          zoom: {
            pan: {
              enabled: true,
              mode: 'x',
              onPanStart: () => {
                this.userNavigated = true;
                this.onUserNavigatedCallback?.(true);
              },
            },
            zoom: {
              wheel: { enabled: true },
              pinch: { enabled: true },
              mode: 'x',
              onZoomStart: () => {
                this.userNavigated = true;
                this.onUserNavigatedCallback?.(true);
              },
            },
          },
        },
      },
    });
  }

  initCharts(accelCanvas, gyroCanvas, tempCanvas) {
    if (this.charts) return this.charts;

    const accelDatasets = [
      { label: '|a| (Magnitude)', color: '#ffffff', borderWidth: 2.2 },
      { label: 'aX', color: CONFIG.COLORS.chartAx, hidden: true, borderWidth: 1.5 },
      { label: 'aY', color: CONFIG.COLORS.chartAy, hidden: true, borderWidth: 1.5 },
      { label: 'aZ', color: CONFIG.COLORS.chartAz, hidden: true, borderWidth: 1.5 },
      { label: 'Seuil commotion', color: CONFIG.COLORS.chartThreshold, borderWidth: 1.8, borderDash: [6, 4] },
    ];

    const gyroDatasets = [
      { label: 'gX', color: CONFIG.COLORS.chartGyroX, borderWidth: 1.8 },
      { label: 'gY', color: CONFIG.COLORS.chartGyroY, borderWidth: 1.8 },
      { label: 'gZ', color: CONFIG.COLORS.chartGyroZ, borderWidth: 1.8 },
    ];

    const tempDatasets = [
      { label: 'Température (°C)', color: CONFIG.COLORS.chartTemp, borderWidth: 1.8, bgColor: 'rgba(245, 158, 11, 0.08)' },
    ];

    this.charts = {
      accel: this.createChart(accelCanvas, accelDatasets, 'Accélération (g)'),
      gyro: this.createChart(gyroCanvas, gyroDatasets, 'Vitesse angulaire (dps)'),
      temp: this.createChart(tempCanvas, tempDatasets, 'Température (°C)'),
    };

    return this.charts;
  }

  setOnUserNavigated(cb) {
    this.onUserNavigatedCallback = cb;
  }

  /**
   * Loads a full match session into the charts in a single high-speed pass.
   * Resets scales to show the entire session timeline from start to finish.
   */
  loadFullSession(logs, currentThreshold, isHistorical = true) {
    if (!this.charts) return;

    this.isSessionMode = isHistorical;
    this.userNavigated = false;
    this.onUserNavigatedCallback?.(false);

    const labels = [];
    const accelData = { mag: [], ax: [], ay: [], az: [], threshold: [] };
    const gyroData = { gx: [], gy: [], gz: [] };
    const tempData = [];

    const threshold = currentThreshold ?? CONFIG.DEFAULT_IMPACT_THRESHOLD;

    // Decimate very large sessions so charts stay fast to draw: keep every Nth point
    // rather than dumping tens of thousands of points into Chart.js.
    const imuLogs = logs.filter((msg) => msg.type === 'imu');
    const step = Math.max(1, Math.ceil(imuLogs.length / CONFIG.MAX_SESSION_RENDER_POINTS));

    for (let i = 0; i < imuLogs.length; i += step) {
      const msg = imuLogs[i];
      const t = new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const mag = calcAccelMagnitude(msg.aX, msg.aY, msg.aZ);

      labels.push(t);
      accelData.mag.push(mag);
      accelData.ax.push(msg.aX);
      accelData.ay.push(msg.aY);
      accelData.az.push(msg.aZ);
      accelData.threshold.push(threshold);

      gyroData.gx.push(msg.gX);
      gyroData.gy.push(msg.gY);
      gyroData.gz.push(msg.gZ);

      tempData.push(msg.temp);
    }

    // Populate Accel Chart
    const cAccel = this.charts.accel;
    cAccel.data.labels = labels;
    cAccel.data.datasets[0].data = accelData.mag;
    cAccel.data.datasets[1].data = accelData.ax;
    cAccel.data.datasets[2].data = accelData.ay;
    cAccel.data.datasets[3].data = accelData.az;
    cAccel.data.datasets[4].data = accelData.threshold;

    // Populate Gyro Chart
    const cGyro = this.charts.gyro;
    cGyro.data.labels = [...labels];
    cGyro.data.datasets[0].data = gyroData.gx;
    cGyro.data.datasets[1].data = gyroData.gy;
    cGyro.data.datasets[2].data = gyroData.gz;

    // Populate Temp Chart
    const cTemp = this.charts.temp;
    cTemp.data.labels = [...labels];
    cTemp.data.datasets[0].data = tempData;

    // Show entire match timeline without cropping
    for (const chart of Object.values(this.charts)) {
      if (chart.resetZoom) chart.resetZoom();
      delete chart.options.scales.x.min;
      delete chart.options.scales.x.max;
      chart.update('none');
    }
  }

  applyLiveWindow(chart) {
    const labels = chart.data.labels;
    const x = chart.options.scales.x;
    if (labels.length <= CONFIG.DEFAULT_VISIBLE_POINTS) {
      delete x.min;
      delete x.max;
      return;
    }
    x.min = labels[labels.length - CONFIG.DEFAULT_VISIBLE_POINTS];
    x.max = labels[labels.length - 1];
  }

  pushPoint(chart, timeLabel, values) {
    if (!chart) return;
    chart.data.labels.push(timeLabel);
    values.forEach((v, idx) => {
      if (chart.data.datasets[idx]) {
        chart.data.datasets[idx].data.push(v);
      }
    });

    const maxLimit = this.isSessionMode ? CONFIG.MAX_SESSION_CHART_POINTS : CONFIG.MAX_LIVE_CHART_POINTS;
    if (chart.data.labels.length > maxLimit) {
      chart.data.labels.shift();
      chart.data.datasets.forEach((d) => d.data.shift());
    }

    if (!this.userNavigated && !this.isSessionMode) {
      this.applyLiveWindow(chart);
    }
  }

  feedImuData(msg, currentThreshold) {
    if (!this.charts || msg.type !== 'imu') return;
    const t = new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const mag = calcAccelMagnitude(msg.aX, msg.aY, msg.aZ);
    const threshold = currentThreshold ?? CONFIG.DEFAULT_IMPACT_THRESHOLD;

    this.pushPoint(this.charts.accel, t, [mag, msg.aX, msg.aY, msg.aZ, threshold]);
    this.pushPoint(this.charts.gyro, t, [msg.gX, msg.gY, msg.gZ]);
    this.pushPoint(this.charts.temp, t, [msg.temp]);

    this.dirty = true;
  }

  flushChartUpdates() {
    if (!this.charts) return;
    for (const chart of Object.values(this.charts)) {
      if (chart.canvas && chart.canvas.offsetParent !== null) {
        chart.update('none');
      }
    }
  }

  updateThreshold(threshold) {
    if (!this.charts?.accel) return;
    const thresholdDataset = this.charts.accel.data.datasets[4];
    if (thresholdDataset) {
      thresholdDataset.data = thresholdDataset.data.map(() => threshold);
      this.charts.accel.update('none');
    }
  }

  showEntireSession() {
    if (!this.charts) return;
    this.userNavigated = true;
    for (const chart of Object.values(this.charts)) {
      if (chart.resetZoom) chart.resetZoom();
      delete chart.options.scales.x.min;
      delete chart.options.scales.x.max;
      chart.update('none');
    }
    this.onUserNavigatedCallback?.(true);
  }

  followLive() {
    if (!this.charts) return;
    this.userNavigated = false;
    for (const chart of Object.values(this.charts)) {
      if (chart.resetZoom) chart.resetZoom();
      this.applyLiveWindow(chart);
      chart.update('none');
    }
    this.onUserNavigatedCallback?.(false);
  }

  resetZoom() {
    if (!this.charts) return;
    for (const chart of Object.values(this.charts)) {
      if (chart.resetZoom) chart.resetZoom();
      if (!this.isSessionMode && !this.userNavigated) {
        this.applyLiveWindow(chart);
      } else {
        delete chart.options.scales.x.min;
        delete chart.options.scales.x.max;
      }
      chart.update('none');
    }
    this.userNavigated = false;
    this.onUserNavigatedCallback?.(false);
  }

  clear() {
    if (!this.charts) return;
    this.userNavigated = false;
    this.dirty = false;
    for (const chart of Object.values(this.charts)) {
      if (chart.resetZoom) chart.resetZoom();
      chart.data.labels = [];
      chart.data.datasets.forEach((d) => (d.data = []));
      delete chart.options.scales.x.min;
      delete chart.options.scales.x.max;
      chart.update('none');
    }
    this.onUserNavigatedCallback?.(false);
  }

  resize() {
    if (!this.charts) return;
    for (const chart of Object.values(this.charts)) {
      chart.resize();
    }
  }
}
