const MAX_CHART_POINTS = 100;
const MAX_LOG_LINES = 2000;

const devices = new Map(); // device_id -> summary row data
let currentDeviceId = null; // device_id shown in detail view, or null when on the table view
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

function deviceRowHtml(d) {
  return `
    <td><span class="dot ${d.connected ? "online" : "offline"}"></span></td>
    <td>${d.device_name ?? d.device_id}</td>
    <td class="mono">${d.device_id}</td>
    <td>${fmt(d.aX)}, ${fmt(d.aY)}, ${fmt(d.aZ)}</td>
    <td>${fmt(d.gX)}, ${fmt(d.gY)}, ${fmt(d.gZ)}</td>
    <td>${fmt(d.temp, 1)}</td>
    <td>${d.battery_percentage ?? "--"}% (${fmt(d.battery_voltage)} V)</td>
    <td>${d.last_update ? new Date(d.last_update * 1000).toLocaleTimeString() : "--"}</td>
  `;
}

function renderDevicesTable() {
  noDevicesRow.classList.toggle("hidden", devices.size > 0);
  for (const [id, d] of devices) {
    let row = document.getElementById(`row-${id}`);
    if (!row) {
      row = document.createElement("tr");
      row.id = `row-${id}`;
      row.className = "device-row";
      row.addEventListener("click", () => openDetail(id));
      devicesTbody.appendChild(row);
    }
    row.innerHTML = deviceRowHtml(d);
  }
}

function makeChart(ctx, labels, colors) {
  return new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: labels.map((label, i) => ({
        label,
        data: [],
        borderColor: colors[i],
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.2,
      })),
    },
    options: {
      animation: false,
      responsive: true,
      scales: {
        x: { display: false },
        y: { grid: { color: "#2a333c" }, ticks: { color: "#8b949e" } },
      },
      plugins: { legend: { labels: { color: "#e6edf3" } } },
    },
  });
}

function ensureCharts() {
  if (charts) return charts;
  charts = {
    accel: makeChart(document.getElementById("accelChart"), ["aX", "aY", "aZ"], ["#4cc9f0", "#f72585", "#7bd88f"]),
    gyro: makeChart(document.getElementById("gyroChart"), ["gX", "gY", "gZ"], ["#4cc9f0", "#f72585", "#7bd88f"]),
    temp: makeChart(document.getElementById("tempChart"), ["Température"], ["#f9c74f"]),
  };
  return charts;
}

function clearCharts() {
  if (!charts) return;
  for (const chart of Object.values(charts)) {
    chart.data.labels = [];
    chart.data.datasets.forEach((d) => (d.data = []));
    chart.update("none");
  }
}

function pushChartPoint(chart, timeLabel, values) {
  chart.data.labels.push(timeLabel);
  values.forEach((v, i) => chart.data.datasets[i].data.push(v));
  if (chart.data.labels.length > MAX_CHART_POINTS) {
    chart.data.labels.shift();
    chart.data.datasets.forEach((d) => d.data.shift());
  }
  chart.update("none");
}

function logLine(msg) {
  const t = new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toLocaleTimeString();
  switch (msg.type) {
    case "imu":
      return `[${t}] IMU  aX=${fmt(msg.aX)} aY=${fmt(msg.aY)} aZ=${fmt(msg.aZ)}  gX=${fmt(msg.gX)} gY=${fmt(msg.gY)} gZ=${fmt(msg.gZ)}  temp=${fmt(msg.temp, 1)}°C`;
    case "battery_voltage":
      return `[${t}] BATTERY voltage=${fmt(msg.voltage)} V`;
    case "battery_level":
      return `[${t}] BATTERY level=${msg.percentage}%`;
    case "status":
      return `[${t}] STATUS ${msg.connected ? "connecté" : "déconnecté"}`;
    default:
      return `[${t}] ${JSON.stringify(msg)}`;
  }
}

function appendLog(msg) {
  const line = document.createElement("div");
  line.className = `log-line log-${msg.type}`;
  line.textContent = logLine(msg);
  logPanel.appendChild(line);
  while (logPanel.childElementCount > MAX_LOG_LINES) {
    logPanel.removeChild(logPanel.firstChild);
  }
  logPanel.scrollTop = logPanel.scrollHeight;
}

function feedDetailFromMessage(msg) {
  if (msg.device_id !== currentDeviceId) return;
  appendLog(msg);
  if (msg.type === "imu") {
    const c = ensureCharts();
    const t = new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toLocaleTimeString();
    pushChartPoint(c.accel, t, [msg.aX, msg.aY, msg.aZ]);
    pushChartPoint(c.gyro, t, [msg.gX, msg.gY, msg.gZ]);
    pushChartPoint(c.temp, t, [msg.temp]);
  }
}

async function openDetail(deviceId) {
  currentDeviceId = deviceId;
  const d = devices.get(deviceId);
  detailTitle.textContent = `${d?.device_name ?? deviceId} (${deviceId})`;
  logPanel.innerHTML = "";
  ensureCharts();
  clearCharts();

  devicesView.classList.add("hidden");
  detailView.classList.remove("hidden");

  try {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/log`);
    const history = await res.json();
    for (const msg of history) {
      appendLog(msg);
      if (msg.type === "imu") {
        const c = ensureCharts();
        const t = new Date((msg.timestamp ?? Date.now() / 1000) * 1000).toLocaleTimeString();
        pushChartPoint(c.accel, t, [msg.aX, msg.aY, msg.aZ]);
        pushChartPoint(c.gyro, t, [msg.gX, msg.gY, msg.gZ]);
        pushChartPoint(c.temp, t, [msg.temp]);
      }
    }
  } catch (err) {
    console.error("Failed to load device log", err);
  }
}

function closeDetail() {
  currentDeviceId = null;
  detailView.classList.add("hidden");
  devicesView.classList.remove("hidden");
}

document.getElementById("back-btn").addEventListener("click", closeDetail);

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
  devices.set(id, updated);

  renderDevicesTable();
  feedDetailFromMessage(msg);
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

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const footerVersion = document.getElementById("footer-version");
const footerAuthor = document.getElementById("footer-author");
const updateBtn = document.getElementById("update-btn");
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

async function checkForUpdate() {
  try {
    const res = await fetch("/api/update/check");
    const info = await res.json();
    if (info.update_available) {
      updateBtn.classList.remove("hidden");
      updateStatus.textContent = `Nouvelle version disponible : v${info.latest_version}`;
    } else {
      updateBtn.classList.add("hidden");
      updateStatus.textContent = info.error ? info.error : "";
    }
  } catch (err) {
    console.error("Failed to check for update", err);
  }
}

updateBtn.addEventListener("click", async () => {
  updateBtn.disabled = true;
  updateStatus.textContent = "Mise à jour en cours...";
  try {
    const res = await fetch("/api/update/apply", { method: "POST" });
    if (!res.ok) throw new Error(await res.text());
    updateStatus.textContent = "Mise à jour appliquée, redémarrage du service...";
    setTimeout(() => location.reload(), 8000);
  } catch (err) {
    updateStatus.textContent = "Échec de la mise à jour.";
    updateBtn.disabled = false;
    console.error("Update failed", err);
  }
});

loadVersion();
checkForUpdate();
setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);


