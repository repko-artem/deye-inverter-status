/**
 * Клієнт для взаємодії з Deye Cloud API (через захищений проксі).
 * Відповідає виключно за HTTP-запити, авторизацію та санітизацію відповідей.
 */

export class DeyeClient {
  constructor(apiBase, token, stationId) {
    this.apiBase = apiBase || "https://deye-proxy.vercel.app";
    this.token = token;
    this.stationId = stationId;
  }

  getHeaders() {
    return {
      "Authorization": `Bearer ${this.token}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*"
    };
  }

  async fetchJson(url, timeoutMs = 15000, options = {}) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const headers = {
        ...this.getHeaders(),
        ...(options.headers || {})
      };
      if (options.body) {
        headers["Content-Type"] = "application/json";
      }

      const res = await fetch(url, { 
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller ? controller.signal : undefined
      });
      const text = await res.text();
      const trimmed = text.trim();

      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        const plain = trimmed
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        throw new Error(`Deye API HTTP ${res.status}: ${plain.substring(0, 400)}`);
      }

      return JSON.parse(text);
    } catch (err) {
      if (err && (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('abort')))) {
        throw new Error(`перевищено час очікування відповіді (${Math.round(timeoutMs / 1000)} сек)`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Отримання миттєвого зрізу телеметрії станції
   */
  async getStationDisplay() {
    const url = `${this.apiBase}/maintain-s/station/display/?stationId=${this.stationId}`;
    return this.fetchJson(url);
  }

  /**
   * Отримання добової 5-хвилинної історії потужностей та заряду батареї
   */
  async getDailyBatteryHistory(year, month, day) {
    const url = `${this.apiBase}/maintain-s/history/batteryPower/${this.stationId}/stats/daily?year=${year}&month=${month}&day=${day}`;
    return this.fetchJson(url);
  }

  /**
   * Отримання списку інверторів станції з розширеною телеметрією (напруги фаз, струми, featureData)
   */
  async getDeviceList() {
    const url = `${this.apiBase}/maintain-s/power/deye/device/${this.stationId}/device-list?deviceType=INVERTER`;
    return this.fetchJson(url);
  }

  /**
   * Отримання 5-хвилинної історії трифазної напруги мережі та навантаження з телеметрії пристрою
   * @param {string|number} deviceId
   * @param {number} year
   * @param {number} month
   * @param {number} day
   */
  async getDailyDeviceVoltages(deviceId, year, month, day) {
    if (!deviceId) return [];
    const pad = (n) => String(n).padStart(2, '0');
    const dayStr = `${year}/${pad(month)}/${pad(day)}`;
    const fields = 'G_V_L1,G_V_L2,G_V_L3,C_V_L1,C_V_L2,C_V_L3';
    const url = `${this.apiBase}/device-s/device/${deviceId}/stats/day?day=${dayStr}&lan=2&fields=${fields}`;
    const data = await this.fetchJson(url);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    return [];
  }
}
