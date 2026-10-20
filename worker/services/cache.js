import { CONFIG } from '../config.js';

/**
 * Сервіс кешування даних у пам'яті Worker-екземпляра.
 * Запобігає перевищенню лімітів Deye Cloud API та захищає від stampede-ефекту (лавинних запитів).
 */

export class TelemetryCache {
  constructor(ttlMs = CONFIG.CACHE.TTL_MS) {
    this.ttlMs = ttlMs;
    this.inMemoryData = null;
    this.inMemoryTimestamp = 0;
    this.ongoingFetchPromise = null;
    this.cachedDayRecords = {};
  }

  isFresh(now = Date.now()) {
    return Boolean(this.inMemoryData && (now - this.inMemoryTimestamp < this.ttlMs));
  }

  getRecent() {
    return this.inMemoryData;
  }

  getAgeSec(now = Date.now()) {
    return Math.round((now - this.inMemoryTimestamp) / 1000);
  }

  setRecent(data, timestamp = Date.now()) {
    this.inMemoryData = data;
    this.inMemoryTimestamp = timestamp;
  }

  getDayRecords(key) {
    return this.cachedDayRecords[key];
  }

  setDayRecords(key, records) {
    if (records && records.length > 0) {
      this.cachedDayRecords[key] = records;
    }
  }

  getCachedDayKeys() {
    return Object.keys(this.cachedDayRecords);
  }

  getCachedDayCounts() {
    return Object.entries(this.cachedDayRecords).map(([key, v]) => ({
      key,
      count: v ? v.length : 0
    }));
  }

  /**
   * Виконання запиту з блокуванням дублікатів (Single-flight / Promise deduplication)
   */
  async getOrFetch(fetcher) {
    if (this.isFresh()) {
      return this.inMemoryData;
    }

    if (this.ongoingFetchPromise) {
      return this.ongoingFetchPromise;
    }

    this.ongoingFetchPromise = (async () => {
      try {
        const fresh = await fetcher();
        this.setRecent(fresh);
        return fresh;
      } finally {
        this.ongoingFetchPromise = null;
      }
    })();

    return this.ongoingFetchPromise;
  }
}

// Загальний синглтон-кеш для інстансу воркера
export const globalCache = new TelemetryCache();
