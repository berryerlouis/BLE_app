const MAX_CHART_POINTS = 100;
const DEFAULT_VISIBLE_POINTS = 30; // default zoom window, leaves room to pan sideways into older data
const MAX_LOG_LINES = 2000;
const DEFAULT_IMPACT_THRESHOLD = 8; // g, kept in sync with the server default

const devices = new Map(); // device_id -> summary row data
let currentDeviceId = null; // device_id shown in detail view, or null when on the table view
let currentDeviceLog = []; // messages for the open device, oldest first
let realTimeEnabled = true; // when false, live updates are buffered but not rendered
let logSortOrder = "asc"; // "asc" (plus ancien d'abord) or "desc" (plus r\u00e9cent d'abord)
let charts = null; // lazily-created Chart.js instances for the detail view

const devicesTbody = document.getElementById("devices-tbody");
const noDevicesRow = document.getElementById("no-devices-row");
const detailView = document.getElementById("detail-view");
const devicesView = document.getElementById("devices-view");
const detailTitle = document.getElementById("detail-title");
const logPanel = document.getElementById("log-panel");

function fmt(n, digits = 2) {
  return typeof n === "number" ? n.toFixed(digits) : "--";
}

function displayName(d) {
  if (d.label_name && Number.isInteger(d.label_number)) return `${d.label_name} (#${d.label_number})`;
  return d.device_name ?? d.device_id ?? "?";
}

function thresholdOf(d) {
  return typeof d?.impact_threshold === "number" ? d.impact_threshold : DEFAULT_IMPACT_THRESHOLD;
}

function accelMagnitude(msg) {
  return Math.sqrt(msg.aX ** 2 + msg.aY ** 2 + msg.aZ ** 2);
}

function deviceRowHtml(d) {
  return `
    <td><span class="dot ${d.connected ? "online" : "offline"}"></span></td>
    <td>${displayName(d)}</td>
    <td class="mono">${d.device_id}</td>
    <td>${fmt(d.aX)}, ${fmt(d.aY)}, ${fmt(d.aZ)}</td>
    <td>${fmt(d.gX)}, ${fmt(d.gY)}, ${fmt(d.gZ)}</td>
    <td>${fmt(d.temp, 1)}</td>
    <td>${d.battery_percentage ?? "--"}% (${fmt(d.battery_voltage)} V)</td>
    <td><input type="number" class="threshold-input row-threshold" min="0.1" max="200" step="0.1" value="${thresholdOf(d)}" /></td>
    <td>${d.last_update ? new Date(d.last_update * 1000).toLocaleString() : "--"}</td>
  `;
}

function renderDevicesTable() {
  noDevicesRow.classList.toggle("hidden", devices.size > 0);
  for (const [id, d] of sortedDeviceEntries()) {
    let row = document.getElementById(`row-${id}`);
    if (!row) {
      row = document.createElement("tr");
      row.id = `row-${id}`;
      row.className = "device-row";
      row.addEventListener("click", (event) => {
        if (event.target.closest(".row-threshold")) return; // editing the threshold, not opening the device
        openDetail(id);
      });
    }
    if (row.contains(document.activeElement)) continue; // don't clobber a threshold being typed
    row.classList.toggle("impact", Boolean(d.impact_alert));
    row.innerHTML = deviceRowHtml(d);
    devicesTbody.appendChild(row); // (re)appending moves the row to its sorted position
    maybeQueueLabelPrompt(id);
  }
}

// Threshold edited straight from the list (delegated: rows are re-rendered on every message).
devicesTbody.addEventListener("change", async (event) => {
  const input = event.target;
  if (!input.classList.contains("row-threshold")) return;
  const deviceId = input.closest("tr").id.slice("row-".length);
  const threshold = Number(input.value);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 200) {
    input.value = thresholdOf(devices.get(deviceId));
    return;
  }
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/threshold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threshold }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Erreur inconnue");
  } catch (err) {
    console.error("Failed to save threshold", err);
    input.value = thresholdOf(devices.get(deviceId));
  }
});

// --- Devices table sorting (by last update date/time) ---

let deviceSortDir = "desc"; // "asc" (plus ancien) or "desc" (plus récent)
const lastUpdateHeader = document.getElementById("col-last-update");
const lastUpdateArrow = document.getElementById("last-update-arrow");

function sortedDeviceEntries() {
  return [...devices.entries()].sort((a, b) => {
    const av = a[1].last_update ?? 0;
    const bv = b[1].last_update ?? 0;
    return deviceSortDir === "asc" ? av - bv : bv - av;
  });
}

lastUpdateHeader.addEventListener("click", () => {
  deviceSortDir = deviceSortDir === "desc" ? "asc" : "desc";
  lastUpdateArrow.textContent = deviceSortDir === "desc" ? "▼" : "▲";
  renderDevicesTable();
});

// --- Satellite labeling (name + number chosen by the user) ---

const labelModal = document.getElementById("label-modal");
const labelModalTitle = document.getElementById("label-modal-title");
const labelDeviceIdSpan = document.getElementById("label-device-id");
const labelNameInput = document.getElementById("label-name-input");
const labelNumberInput = document.getElementById("label-number-input");
const labelError = document.getElementById("label-error");
const labelSaveBtn = document.getElementById("label-save-btn");
const labelLaterBtn = document.getElementById("label-later-btn");

const LABEL_SNOOZE_MS = 60 * 1000;
const labelQueue = []; // device_ids waiting to be prompted
const labelSnoozedUntil = new Map(); // device_id -> timestamp until which we skip prompting
let labelModalDeviceId = null; // device_id currently shown in the modal, or null
let labelModalMode = "create";

function needsLabel(d) {
  return !(d.label_name && Number.isInteger(d.label_number));
}

function maybeQueueLabelPrompt(deviceId) {
  const d = devices.get(deviceId);
  if (!d || !needsLabel(d)) return;
  if (labelModalDeviceId === deviceId || labelQueue.includes(deviceId)) return;
  const snoozeUntil = labelSnoozedUntil.get(deviceId);
  if (snoozeUntil && Date.now() < snoozeUntil) return;
  labelQueue.push(deviceId);
  processLabelQueue();
}

function processLabelQueue() {
  if (labelModalDeviceId || labelQueue.length === 0) return;
  const deviceId = labelQueue.shift();
  const d = devices.get(deviceId);
  if (!d || !needsLabel(d)) {
    processLabelQueue();
    return;
  }
  showLabelModal(deviceId, "create");
}

function showLabelModal(deviceId, mode) {
  const d = devices.get(deviceId) ?? {};
  labelModalMode = mode;
  labelModalDeviceId = deviceId;
  labelModalTitle.textContent = mode === "edit" ? "Modifier le satellite" : "Nouveau satellite découvert";
  labelDeviceIdSpan.textContent = deviceId;
  labelNameInput.value = d.label_name ?? "";
  labelNumberInput.value = Number.isInteger(d.label_number) ? d.label_number : "";
  labelError.classList.add("hidden");
  labelModal.classList.remove("hidden");
}

function hideLabelModal() {
  labelModal.classList.add("hidden");
  labelModalDeviceId = null;
}

labelLaterBtn.addEventListener("click", () => {
  if (labelModalMode === "create") {
    labelSnoozedUntil.set(labelModalDeviceId, Date.now() + LABEL_SNOOZE_MS);
  }
  hideLabelModal();
  processLabelQueue();
});

labelSaveBtn.addEventListener("click", async () => {
  const name = labelNameInput.value.trim();
  const number = Number(labelNumberInput.value);
  if (!name) {
    labelError.textContent = "Le nom est requis.";
    labelError.classList.remove("hidden");
    return;
  }
  if (!Number.isInteger(number) || number < 0 || number > 1000) {
    labelError.textContent = "Le numéro doit être un entier entre 0 et 1000.";
    labelError.classList.remove("hidden");
    return;
  }

  const deviceId = labelModalDeviceId;
  labelSaveBtn.disabled = true;
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/label`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, number }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Erreur inconnue");

    devices.set(deviceId, { ...devices.get(deviceId), label_name: result.label_name, label_number: result.label_number });
    renderDevicesTable();
    if (currentDeviceId === deviceId) updateDetailTitle(deviceId);
    hideLabelModal();
    processLabelQueue();
  } catch (err) {
    labelError.textContent = err.message;
    labelError.classList.remove("hidden");
  } finally {
    labelSaveBtn.disabled = false;
  }
});

function makeChart(ctx, labels, colors) {
  return new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: labels.map((label, i) => ({
        label,
        data: [],
        hidden: ["aX", "aY", "aZ"].includes(label),
        borderColor: colors[i],
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2,
      })),
    },    options: {
      animation: false,
      responsive: true,
      scales: {
        x: {
          display: true,
          ticks: { color: "#8b949e", maxRotation: 0, autoSkip: true },
          grid: { color: "#2a333c" },
        },
        y: { grid: { color: "#2a333c" }, ticks: { color: "#8b949e" } },
      },
      plugins: {
        legend: { labels: { color: "#e6edf3" } },
        zoom: {
          pan: {
            enabled: true,
            mode: "x",
            onPanStart: ({ chart }) => (chart.$userNavigated = true),
          },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: "x",
            onZoomStart: ({ chart }) => (chart.$userNavigated = true),
          },
        },
      },
    },
  });
}

function ensureCharts() {
  if (charts) return charts;
  charts = {
    accel: makeChart(
      document.getElementById("accelChart"),
      ["aX", "aY", "aZ", "|a|", "Seuil de commotion"],
      ["#4cc9f0", "#f72585", "#7bd88f", "#e6edf3", "#f85149"]
    ),
    gyro: makeChart(document.getElementById("gyroChart"), ["gX", "gY", "gZ"], ["#4cc9f0", "#f72585", "#7bd88f"]),
    temp: makeChart(document.getElementById("tempChart"), ["Température"], ["#f9c74f"]),
  };
  const thresholdDataset = charts.accel.data.datasets[4];
  thresholdDataset.borderDash = [6, 4];
  thresholdDataset.borderWidth = 1.5;
  return charts;
}

function accelValues(msg) {
  return [msg.aX, msg.aY, msg.aZ, accelMagnitude(msg), currentThreshold()];
}

function clearCharts() {
  if (!charts) return;
  for (const chart of Object.values(charts)) {
    chart.resetZoom();
    chart.$userNavigated = false;
    chart.data.labels = [];
    chart.data.datasets.forEach((d) => (d.data = []));
    chart.update("none");
  }
}

function applyDefaultWindow(chart) {
  const labels = chart.data.labels;
  const x = chart.options.scales.x;
  if (labels.length <= DEFAULT_VISIBLE_POINTS) {
    delete x.min;
    delete x.max;
    return;
  }
  x.min = labels[labels.length - DEFAULT_VISIBLE_POINTS];
  x.max = labels[labels.length - 1];
}

function pushChartPoint(chart, timeLabel, values) {
  chart.data.labels.push(timeLabel);
  values.forEach((v, i) => chart.data.datasets[i].data.push(v));
  if (chart.data.labels.length > MAX_CHART_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets.forEach((d) => d.data.shift());
  }
  if (!chart.$userNavigated) applyDefaultWindow(chart); // keep following live data until the user pans/zooms manually
  chart.update("none");
}

function logLine(msg) {
  const t = new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toLocaleString();
  switch (msg.type) {
    case "imu":
      return `[${t}] IMU  aX=${fmt(msg.aX)} aY=${fmt(msg.aY)} aZ=${fmt(msg.aZ)}  gX=${fmt(msg.gX)} gY=${fmt(msg.gY)} gZ=${fmt(msg.gZ)}  temp=${fmt(msg.temp, 1)}°C`;
    case "battery_voltage":
      return `[${t}] BATTERY voltage=${fmt(msg.voltage)} V`;
    case "battery_level":
      return `[${t}] BATTERY level=${msg.percentage}%`;
    case "status":
      return `[${t}] STATUS ${msg.connected ? "connecté" : "déconnecté"}`;
    case "label":
      return `[${t}] LABEL ${msg.label_name} (#${msg.label_number})`;
    case "threshold":
      return `[${t}] SEUIL commotion = ${fmt(msg.impact_threshold)} g`;
    case "impact":
      return `[${t}] COMMOTION |a|=${fmt(msg.impact_value)} g >= seuil ${fmt(msg.impact_threshold)} g`;
    case "impact_reset":
      return `[${t}] COMMOTION acquittée`;
    default:
      return `[${t}] ${JSON.stringify(msg)}`;
  }
}

function appendLog(msg) {
  const line = document.createElement("div");
  line.className = `log-line log-${msg.type}`;
  line.textContent = logLine(msg);
  if (logSortOrder === "desc") {
    logPanel.insertBefore(line, logPanel.firstChild);
    while (logPanel.childElementCount > MAX_LOG_LINES) logPanel.removeChild(logPanel.lastChild);
    logPanel.scrollTop = 0;
  } else {
    logPanel.appendChild(line);
    while (logPanel.childElementCount > MAX_LOG_LINES) logPanel.removeChild(logPanel.firstChild);
    logPanel.scrollTop = logPanel.scrollHeight;
  }
}

function renderLogPanel() {
  logPanel.innerHTML = "";
  const trimmed = currentDeviceLog.slice(-MAX_LOG_LINES);
  const ordered = logSortOrder === "desc" ? [...trimmed].reverse() : trimmed;
  for (const msg of ordered) {
    const line = document.createElement("div");
    line.className = `log-line log-${msg.type}`;
    line.textContent = logLine(msg);
    logPanel.appendChild(line);
  }
  logPanel.scrollTop = logSortOrder === "desc" ? 0 : logPanel.scrollHeight;
}

function rebuildCharts() {
  clearCharts();
  const c = ensureCharts();
  for (const msg of currentDeviceLog) {
    if (msg.type !== "imu") continue;
    const t = new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toLocaleTimeString();
    pushChartPoint(c.accel, t, accelValues(msg));
    pushChartPoint(c.gyro, t, [msg.gX, msg.gY, msg.gZ]);
    pushChartPoint(c.temp, t, [msg.temp]);
  }
}

function rebuildDetailView() {
  renderLogPanel();
  rebuildCharts();
}

function feedDetailFromMessage(msg) {
  if (msg.device_id !== currentDeviceId) return;
  currentDeviceLog.push(msg);
  if (currentDeviceLog.length > MAX_LOG_LINES) currentDeviceLog.shift();
  if (!realTimeEnabled) return;
  appendLog(msg);
  if (msg.type === "imu") {
    const c = ensureCharts();
    const t = new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toLocaleTimeString();
    pushChartPoint(c.accel, t, accelValues(msg));
    pushChartPoint(c.gyro, t, [msg.gX, msg.gY, msg.gZ]);
    pushChartPoint(c.temp, t, [msg.temp]);
  }
}

function updateDetailTitle(deviceId) {
  const d = devices.get(deviceId) ?? { device_id: deviceId };
  detailTitle.textContent = `${displayName(d)} (${deviceId})`;
}

async function openDetail(deviceId) {
  currentDeviceId = deviceId;
  updateDetailTitle(deviceId);
  currentDeviceLog = [];
  realTimeEnabled = true;
  realtimeToggle.checked = true;
  logPanel.innerHTML = "";
  ensureCharts();
  clearCharts();
  thresholdError.classList.add("hidden");
  renderThresholdValue();
  renderImpactBanner();

  devicesView.classList.add("hidden");
  detailView.classList.remove("hidden");

  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/log`);
    const history = await res.json();
    currentDeviceLog = history.slice(-MAX_LOG_LINES);
    rebuildDetailView();
  } catch (err) {
    console.error("Failed to load device log", err);
  }
}

function closeDetail() {
  currentDeviceId = null;
  currentDeviceLog = [];
  detailView.classList.add("hidden");
  devicesView.classList.remove("hidden");
}

document.getElementById("back-btn").addEventListener("click", closeDetail);
document.getElementById("edit-label-btn").addEventListener("click", () => {
  if (currentDeviceId) showLabelModal(currentDeviceId, "edit");
});

const realtimeToggle = document.getElementById("realtime-toggle");
const logSortSelect = document.getElementById("log-sort-select");

realtimeToggle.addEventListener("change", () => {
  realTimeEnabled = realtimeToggle.checked;
  if (realTimeEnabled) rebuildDetailView(); // catch up on everything received while paused
});

document.getElementById("reset-zoom-btn").addEventListener("click", () => {
  if (!charts) return;
  for (const chart of Object.values(charts)) {
    chart.resetZoom();
    chart.$userNavigated = false;
  }
});

const gyroChartCard = document.getElementById("gyro-chart-card");
const tempChartCard = document.getElementById("temp-chart-card");

document.getElementById("gyro-chart-toggle").addEventListener("change", (e) => {
  gyroChartCard.classList.toggle("hidden", !e.target.checked);
  if (e.target.checked && charts) charts.gyro.resize();
});

document.getElementById("temp-chart-toggle").addEventListener("change", (e) => {
  tempChartCard.classList.toggle("hidden", !e.target.checked);
  if (e.target.checked && charts) charts.temp.resize();
});

// --- Concussion threshold on the accelerometer magnitude ---

const thresholdError = document.getElementById("threshold-error");
const thresholdValue = document.getElementById("threshold-value");
const impactResetBtn = document.getElementById("impact-reset-btn");
const impactBanner = document.getElementById("impact-banner");
const impactBannerValue = document.getElementById("impact-banner-value");

function currentThreshold() {
  return thresholdOf(devices.get(currentDeviceId));
}

function renderThresholdValue() {
  thresholdValue.textContent = fmt(currentThreshold(), 1);
}

function renderImpactBanner() {
  const d = devices.get(currentDeviceId);
  const alert = Boolean(d?.impact_alert);
  impactBanner.classList.toggle("hidden", !alert);
  if (alert) impactBannerValue.textContent = fmt(d.impact_value);
}

function applyThresholdToChart() {
  if (!charts) return;
  const dataset = charts.accel.data.datasets[4];
  dataset.data = dataset.data.map(() => currentThreshold());
  charts.accel.update("none");
}

impactResetBtn.addEventListener("click", async () => {
  impactResetBtn.disabled = true;
  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(currentDeviceId)}/impact/reset`, { method: "POST" });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Erreur inconnue");
    thresholdError.classList.add("hidden");
  } catch (err) {
    thresholdError.textContent = err.message;
    thresholdError.classList.remove("hidden");
  } finally {
    impactResetBtn.disabled = false;
  }
});

function setServerConnected(connected) {
  const dot = document.getElementById("conn-dot");
  const text = document.getElementById("conn-text");
  dot.className = "dot " + (connected ? "online" : "offline");
  text.textContent = connected ? "Serveur connecté" : "Serveur déconnecté";
}

async function loadInitialDevices() {
  try {
    const res = await fetch("/api/devices");
    const list = await res.json();
    for (const d of list) devices.set(d.device_id, d);
    renderDevicesTable();
  } catch (err) {
    console.error("Failed to load devices", err);
  }
}

function handleMessage(msg) {
  const id = msg.device_id;
  if (!id) return;

  const existing = devices.get(id) || { device_id: id };
  const updated = { ...existing, device_name: msg.device_name ?? existing.device_name, last_update: msg.timestamp };
  if (msg.type === "status") updated.connected = msg.connected;
  else if (msg.type === "imu") Object.assign(updated, { aX: msg.aX, aY: msg.aY, aZ: msg.aZ, gX: msg.gX, gY: msg.gY, gZ: msg.gZ, temp: msg.temp });
  else if (msg.type === "battery_voltage") updated.battery_voltage = msg.voltage;
  else if (msg.type === "battery_level") updated.battery_percentage = msg.percentage;
  else if (msg.type === "label") Object.assign(updated, { label_name: msg.label_name, label_number: msg.label_number });
  else if (msg.type === "threshold") updated.impact_threshold = msg.impact_threshold;
  else if (msg.type === "impact") Object.assign(updated, { impact_alert: true, impact_value: msg.impact_value, impact_threshold: msg.impact_threshold });
  else if (msg.type === "impact_reset") Object.assign(updated, { impact_alert: false, impact_value: undefined });
  devices.set(id, updated);

  renderDevicesTable();
  feedDetailFromMessage(msg);
  if (currentDeviceId !== id) return;
  if (msg.type === "label") updateDetailTitle(id);
  if (msg.type === "threshold") {
    renderThresholdValue();
    applyThresholdToChart();
  }
  if (msg.type === "impact" || msg.type === "impact_reset") renderImpactBanner();
}

function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => setServerConnected(true);
  ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
  ws.onclose = () => {
    setServerConnected(false);
    setTimeout(connectWebSocket, 2000);
  };
  ws.onerror = () => ws.close();
}

loadInitialDevices();
connectWebSocket();
lucide.createIcons();

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const footerVersion = document.getElementById("footer-version");
const footerAuthor = document.getElementById("footer-author");
const updateStatus = document.getElementById("update-status");

async function loadVersion() {
  try {
    const res = await fetch("/api/version");
    const info = await res.json();
    footerVersion.textContent = info.version;
    footerAuthor.textContent = info.author;
  } catch (err) {
    console.error("Failed to load version", err);
  }
}

const updateModal = document.getElementById("update-modal");
const updateConfirmBtn = document.getElementById("update-confirm-btn");
const updateCancelBtn = document.getElementById("update-cancel-btn");
const currentVersionSpan = document.getElementById("current-version");
const latestVersionSpan = document.getElementById("latest-version");

function showUpdateModal(currentVersion, latestVersion) {
  currentVersionSpan.textContent = currentVersion;
  latestVersionSpan.textContent = latestVersion;
  updateModal.classList.remove("hidden");
}

function hideUpdateModal() {
  updateModal.classList.add("hidden");
}

async function checkForUpdate() {
  try {
    const res = await fetch("/api/update/check");
    const info = await res.json();
    if (info.update_available) {
      showUpdateModal(info.current_version, info.latest_version);
      updateStatus.textContent = `Nouvelle version disponible : v${info.latest_version}`;
    } else {
      hideUpdateModal();
      updateStatus.textContent = info.error ? info.error : "";
    }
  } catch (err) {
    console.error("Failed to check for update", err);
  }
}

const updateProgressContainer = document.getElementById("update-progress-container");
const updateProgressBar = document.getElementById("update-progress-bar");
const updateProgressText = document.getElementById("update-progress-text");
const updateMessage = document.getElementById("update-message");
const versionInfo = document.getElementById("version-info");

function setUpdateProgress(percent, text) {
  updateProgressBar.style.width = percent + "%";
  if (text) updateProgressText.textContent = text;
}

function showUpdateProgress() {
  updateMessage.classList.add("hidden");
  versionInfo.classList.add("hidden");
  updateProgressContainer.classList.remove("hidden");
  updateProgressBar.style.width = "0%";
  setUpdateProgress(0, "Téléchargement...");
}

function hideUpdateProgress() {
  updateMessage.classList.remove("hidden");
  versionInfo.classList.remove("hidden");
  updateProgressContainer.classList.add("hidden");
}

updateConfirmBtn.addEventListener("click", async () => {
  updateConfirmBtn.disabled = true;
  updateCancelBtn.disabled = true;
  showUpdateProgress();
  
  // Simulate progress
  let progress = 0;
  const progressInterval = setInterval(() => {
    progress += Math.random() * 20;
    if (progress > 90) progress = 90;
    setUpdateProgress(progress, "Mise à jour en cours...");
  }, 500);
  
  try {
    const res = await fetch("/api/update/apply", { method: "POST" });
    clearInterval(progressInterval);
    if (!res.ok) throw new Error(await res.text());
    
    setUpdateProgress(100, "Installation terminée, redémarrage...");
    updateStatus.textContent = "Mise à jour appliquée, redémarrage du service...";
    setTimeout(() => location.reload(), 8000);
  } catch (err) {
    clearInterval(progressInterval);
    setUpdateProgress(0, "Échec de la mise à jour");
    updateStatus.textContent = "Échec de la mise à jour.";
    updateConfirmBtn.disabled = false;
    updateCancelBtn.disabled = false;
    console.error("Update failed", err);
  }
});

updateCancelBtn.addEventListener("click", () => {
  hideUpdateModal();
  updateStatus.textContent = "";
});

loadVersion();
checkForUpdate(); // Check immediately on page load
setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS); // Then check every 5 minutes


