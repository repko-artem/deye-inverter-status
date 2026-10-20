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

  async fetchJson(url) {
    const res = await fetch(url, { headers: this.getHeaders() });
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
}
