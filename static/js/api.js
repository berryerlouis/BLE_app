/**
 * REST API Client
 */
export const api = {
  async fetchDevices(sessionId = null) {
    const url = sessionId ? `/api/devices?session_id=${encodeURIComponent(sessionId)}` : '/api/devices';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Erreur récupération satellites (${res.status})`);
    return await res.json();
  },

  async fetchDeviceLog(deviceId, sessionId = null) {
    const url = sessionId
      ? `/api/sessions/${encodeURIComponent(sessionId)}/devices/${encodeURIComponent(deviceId)}/log`
      : `/api/devices/${encodeURIComponent(deviceId)}/log`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Erreur récupération journal (${res.status})`);
    return await res.json();
  },

  async updateDeviceLabel(deviceId, name, number) {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/label`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, number }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lors de la mise à jour du joueur');
    return data;
  },

  async updateDeviceThreshold(deviceId, threshold) {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/threshold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lors de la mise à jour du seuil');
    return data;
  },

  async resetDeviceImpact(deviceId) {
    const res = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/impact/reset`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur lors de la réinitialisation');
    return data;
  },

  // --- Match Sessions API ---

  async fetchSessions() {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`Erreur récupération des sessions (${res.status})`);
    return await res.json();
  },

  async fetchActiveSession() {
    const res = await fetch('/api/sessions/active');
    if (!res.ok) throw new Error(`Erreur récupération de la session active (${res.status})`);
    return await res.json();
  },

  async createSession(name, notes = '') {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, notes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur création de la session');
    return data;
  },

  async activateSession(sessionId) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/activate`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur activation de la session');
    return data;
  },

  async endSession(sessionId) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur clôture de la session');
    return data;
  },

  async deleteSession(sessionId) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur suppression de la session');
    return data;
  },

  async fetchSessionSummary(sessionId) {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/summary`);
    if (!res.ok) throw new Error(`Erreur récupération résumé de match (${res.status})`);
    return await res.json();
  },

  // --- Version & System Updates ---

  async fetchVersion() {
    const res = await fetch('/api/version');
    if (!res.ok) throw new Error('Erreur version');
    return await res.json();
  },

  async checkUpdate() {
    const res = await fetch('/api/update/check');
    if (!res.ok) throw new Error('Erreur vérification mise à jour');
    return await res.json();
  },

  async applyUpdate() {
    const res = await fetch('/api/update/apply', { method: 'POST' });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(errText || 'Erreur application mise à jour');
    }
    return await res.json();
  },
};
