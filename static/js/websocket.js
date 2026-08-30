/**
 * WebSocket Live Data Client
 */
import { CONFIG } from './config.js';
import { state } from './state.js';

class WebSocketClient {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.isConnected = false;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error('WebSocket connection error:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.isConnected = true;
      state.setServerConnected(true);
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        state.handleWebSocketMessage(msg);
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err, event.data);
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      state.setServerConnected(false);
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      if (this.ws) this.ws.close();
    };
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, CONFIG.WS_RECONNECT_DELAY_MS);
  }
}

export const wsClient = new WebSocketClient();
