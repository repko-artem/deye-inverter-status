import { CONFIG } from '../config.js';

/**
 * Мапа полів напруги пристрою Deye у компактні ключі записів історії.
 */
const DEVICE_VOLTAGE_KEY_MAP = {
  G_V_L1: 'v1',
  G_V_L2: 'v2',
  G_V_L3: 'v3',
  C_V_L1: 'lv1',
  C_V_L2: 'lv2',
  C_V_L3: 'lv3'
};

/**
 * Об'єднує 5-хвилинні серії пофазної напруги (/device-s/device/{id}/stats/day)
 * із записами історії станції (/stats/daily) за 5-хвилинними інтервалами.
 */
export function mergeDeviceVoltagesIntoRecords(records, seriesList) {
  if (!Array.isArray(seriesList) || seriesList.length === 0) {
    return { grid: null, load: null };
  }

  const byBucket = new Map();
  let latestGridTs = 0;
  let latestLoadTs = 0;
  const latestByKey = {};

  for (const series of seriesList) {
    if (!series || !series.storageName) continue;
    const mappedKey = DEVICE_VOLTAGE_KEY_MAP[series.storageName];
    if (!mappedKey || !Array.isArray(series.detailList)) continue;

    for (const pt of series.detailList) {
      if (!pt || pt.collectionTime == null || pt.value == null) continue;
      let ts = Number(pt.collectionTime);
      if (ts > 1e11) ts = Math.floor(ts / 1000);
      const valNum = Number(pt.value);
      if (!Number.isFinite(ts) || !Number.isFinite(valNum)) continue;
      const val = Math.round(valNum * 10) / 10;

      const floorBucket = Math.floor(ts / 300) * 300;
      const roundBucket = Math.round(ts / 300) * 300;

      let entry = byBucket.get(floorBucket);
      if (!entry) {
        entry = {};
        byBucket.set(floorBucket, entry);
      }
      entry[mappedKey] = val;

      if (roundBucket !== floorBucket) {
        let roundEntry = byBucket.get(roundBucket);
        if (!roundEntry) {
          roundEntry = {};
          byBucket.set(roundBucket, roundEntry);
        }
        if (roundEntry[mappedKey] === undefined) {
          roundEntry[mappedKey] = val;
        }
      }

      if (!latestByKey[mappedKey] || ts >= latestByKey[mappedKey].ts) {
        latestByKey[mappedKey] = { val, ts };
      }
      if (mappedKey.startsWith('v') && ts > latestGridTs) latestGridTs = ts;
      if (mappedKey.startsWith('lv') && ts > latestLoadTs) latestLoadTs = ts;
    }
  }

  if (Array.isArray(records)) {
    for (const r of records) {
      if (!r || r.dateTime == null) continue;
      const ts = Number(r.dateTime);
      const bucket = Math.floor(ts / 300) * 300;
      const entry = byBucket.get(bucket) || byBucket.get(Math.round(ts / 300) * 300);
      if (!entry) continue;
      if (entry.v1 !== undefined) r.v1 = entry.v1;
      if (entry.v2 !== undefined) r.v2 = entry.v2;
      if (entry.v3 !== undefined) r.v3 = entry.v3;
      if (entry.lv1 !== undefined) r.lv1 = entry.lv1;
      if (entry.lv2 !== undefined) r.lv2 = entry.lv2;
      if (entry.lv3 !== undefined) r.lv3 = entry.lv3;
    }
  }

  const grid = (latestByKey.v1 && latestByKey.v2 && latestByKey.v3)
    ? { l1: latestByKey.v1.val, l2: latestByKey.v2.val, l3: latestByKey.v3.val, ts: latestGridTs }
    : null;

  const load = (latestByKey.lv1 && latestByKey.lv2 && latestByKey.lv3)
    ? { l1: latestByKey.lv1.val, l2: latestByKey.lv2.val, l3: latestByKey.lv3.val, ts: latestLoadTs }
    : null;

  return { grid, load };
}

/**
 * Скорочує запис добової історії до полів, необхідних доменній логіці та графікам.
 */
export function compactHistoryRecord(r) {
  if (!r || typeof r !== 'object') return r;
  const out = {
    dateTime: r.dateTime,
    wirePower: r.wirePower ?? 0,
    batteryPower: r.batteryPower ?? 0,
    usePower: r.usePower ?? 0,
    batterySoc: r.batterySoc ?? 100
  };
  if (r.dischargePower !== undefined) {
    out.dischargePower = r.dischargePower;
  }
  if (typeof r.v1 === 'number') out.v1 = r.v1;
  if (typeof r.v2 === 'number') out.v2 = r.v2;
  if (typeof r.v3 === 'number') out.v3 = r.v3;
  return out;
}

/**
 * Репозиторій історичної телеметрії та снепшотів (Memory Cache + Cloudflare KV + Deye API).
 * Інкапсулює читання/запис KV-ключів і стратегії батч-завантаження без витоку інфраструктурних деталей у бізнес-логіку.
 */
export class HistoryRepository {
  constructor({ client, cache, kv = null, deviceId = null, config = CONFIG }) {
    this.client = client;
    this.cache = cache;
    this.kv = kv;
    this.deviceId = deviceId;
    this.config = config;
    this.pastHistoryKvKey = deviceId ? 'history_past_days_v2' : 'history_past_days';
    this.archiveKvKey = deviceId ? 'history_archive_30d_v2' : 'history_archive_30d_v1';
  }

  /**
   * Завантажує та об'єднує поточну добу (потужність/SOC + пофазна напруга пристрою).
   */
  async loadTodayWithVoltages(year, month, day) {
    const histPromise = this.client.getDailyBatteryHistory(year, month, day).catch(err => {
      console.error("Помилка завантаження сьогоднішньої історії (м'який фолбек):", err);
      return null;
    });
    const voltPromise = this.deviceId
      ? this.client.getDailyDeviceVoltages(this.deviceId, year, month, day).catch(err => {
          console.error("Помилка завантаження сьогоднішньої напруги пристрою (м'який фолбек):", err);
          return [];
        })
      : Promise.resolve([]);

    const [histToday, todayVoltages] = await Promise.all([histPromise, voltPromise]);
    const todayRecords = (histToday && Array.isArray(histToday.records))
      ? histToday.records.map(r => ({ ...r }))
      : [];
    const latestVoltages = mergeDeviceVoltagesIntoRecords(todayRecords, todayVoltages);
    return { todayRecords, latestVoltages };
  }

  /**
   * Батч-завантаження списку минулих днів із Deye Cloud (+ пофазна напруга пристрою).
   */
  async fetchDaysBatch(daysList, { concurrency = 1, cacheInMemory = false, recordEmptySuccess = false } = {}) {
    const recordsByKey = {};
    const daysFetched = [];

    for (let i = 0; i < daysList.length; i += concurrency) {
      const batch = daysList.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (pd) => {
          try {
            const [json, voltageSeries] = await Promise.all([
              this.client.getDailyBatteryHistory(pd.y, pd.m, pd.day),
              this.deviceId
                ? this.client.getDailyDeviceVoltages(this.deviceId, pd.y, pd.m, pd.day).catch(() => [])
                : Promise.resolve([])
            ]);
            return { pd, json, voltageSeries };
          } catch (err) {
            console.error(`Error fetching history for ${pd.key}:`, err);
            return { pd, json: null, voltageSeries: [] };
          }
        })
      );

      for (const { pd, json, voltageSeries } of batchResults) {
        daysFetched.push(pd.key);
        if (json && Array.isArray(json.records) && json.records.length > 0) {
          if (Array.isArray(voltageSeries) && voltageSeries.length > 0) {
            mergeDeviceVoltagesIntoRecords(json.records, voltageSeries);
          }
          const compacted = json.records.map(compactHistoryRecord);
          recordsByKey[pd.key] = compacted;
          if (cacheInMemory) {
            this.cache.setDayRecords(pd.key, compacted);
          }
        } else if (recordEmptySuccess && json && Array.isArray(json.records)) {
          recordsByKey[pd.key] = [];
        }
      }
    }

    return { recordsByKey, daysFetched };
  }

  /**
   * Завантажує останні 7 минулих днів із багаторівневим кешем (Memory -> KV -> Deye API).
   */
  async loadPastWindow(pastDays) {
    let missingPastDays = pastDays.filter(pd => !this.cache.getDayRecords(pd.key));
    if (missingPastDays.length > 0 && this.kv) {
      try {
        const kvHistory = await this.kv.get(this.pastHistoryKvKey, { type: 'json' });
        if (kvHistory && typeof kvHistory === 'object') {
          for (const pd of missingPastDays) {
            if (Array.isArray(kvHistory[pd.key]) && kvHistory[pd.key].length > 0) {
              this.cache.setDayRecords(pd.key, kvHistory[pd.key]);
            }
          }
          missingPastDays = pastDays.filter(pd => !this.cache.getDayRecords(pd.key));
        }
      } catch (err) {
        console.error(`Failed to read ${this.pastHistoryKvKey} from KV:`, err);
      }
    }

    const concurrency = this.deviceId ? 1 : (this.config.CACHE?.HISTORY_CONCURRENCY || 3);
    const { recordsByKey: fetchedMap, daysFetched } = await this.fetchDaysBatch(missingPastDays, {
      concurrency,
      cacheInMemory: true
    });

    if (Object.keys(fetchedMap).length > 0 && this.kv) {
      try {
        const kvPayload = {};
        for (const pd of pastDays) {
          const recs = this.cache.getDayRecords(pd.key);
          if (Array.isArray(recs) && recs.length > 0) {
            kvPayload[pd.key] = recs;
          }
        }
        await this.kv.put(this.pastHistoryKvKey, JSON.stringify(kvPayload));
      } catch (err) {
        console.error(`Failed to save ${this.pastHistoryKvKey} to KV:`, err);
      }
    }

    return {
      pastRecordsChronological: [...pastDays].reverse().flatMap(pd => this.cache.getDayRecords(pd.key) || []),
      daysFetched
    };
  }

  /**
   * Завантажує та доповнює 30-денну історію архіву безпечними батчами (concurrency=1 щоб не торкатись ліміту 6 з'єднань CF).
   */
  async loadArchive30dWindow(pastDays, maxBatchDays) {
    const validKeys = new Set(pastDays.map(pd => pd.key));
    const archiveDaysMap = {};
    let archiveDirty = false;

    if (this.kv) {
      try {
        const stored = await this.kv.get(this.archiveKvKey, { type: 'json' });
        if (stored && typeof stored === 'object') {
          for (const key of Object.keys(stored)) {
            if (validKeys.has(key) && Array.isArray(stored[key])) {
              archiveDaysMap[key] = stored[key];
            } else {
              archiveDirty = true;
            }
          }
        }
      } catch (err) {
        console.error(`Failed to read ${this.archiveKvKey} from KV:`, err);
      }
    }

    // Досівання з пам'яті або KV останніх 7 днів без виклику Deye API
    for (const pd of pastDays) {
      if (!Array.isArray(archiveDaysMap[pd.key])) {
        const memRecs = this.cache.getDayRecords(pd.key);
        if (Array.isArray(memRecs) && memRecs.length > 0) {
          archiveDaysMap[pd.key] = memRecs;
          archiveDirty = true;
        }
      }
    }

    const recentDaysCount = this.config.CACHE?.HISTORY_DAYS || 7;
    const recentMissing = pastDays.slice(0, recentDaysCount).filter(pd => !Array.isArray(archiveDaysMap[pd.key]));
    if (recentMissing.length > 0 && this.kv) {
      try {
        const kvRecent = await this.kv.get(this.pastHistoryKvKey, { type: 'json' });
        if (kvRecent && typeof kvRecent === 'object') {
          for (const pd of recentMissing) {
            if (Array.isArray(kvRecent[pd.key]) && kvRecent[pd.key].length > 0) {
              archiveDaysMap[pd.key] = kvRecent[pd.key];
              archiveDirty = true;
            }
          }
        }
      } catch (err) {
        console.error(`Failed to read ${this.pastHistoryKvKey} for archive seed:`, err);
      }
    }

    const missingDays = pastDays.filter(pd => !Array.isArray(archiveDaysMap[pd.key]));
    const batchDays = missingDays.slice(0, Math.max(0, maxBatchDays));
    if (batchDays.length > 0) {
      // Строго concurrency=1 під час бекфілу (<= 2 одночасних запити на добу + паралельні today = <= 4 з'єднань < ліміту 6 CF)
      const { recordsByKey } = await this.fetchDaysBatch(batchDays, {
        concurrency: 1,
        cacheInMemory: false,
        recordEmptySuccess: true
      });
      for (const [k, recs] of Object.entries(recordsByKey)) {
        archiveDaysMap[k] = recs;
        archiveDirty = true;
      }
    }

    if (archiveDirty && this.kv) {
      try {
        await this.kv.put(this.archiveKvKey, JSON.stringify(archiveDaysMap));
      } catch (err) {
        console.error(`Failed to save ${this.archiveKvKey} to KV:`, err);
      }
    }

    const pastChronological = [...pastDays].reverse().flatMap(pd => archiveDaysMap[pd.key] || []);
    const daysLoadedPast = pastDays.filter(pd => Array.isArray(archiveDaysMap[pd.key])).length;
    const remainingAfterFetch = Math.max(0, pastDays.length - daysLoadedPast);

    return { pastChronological, daysLoadedPast, remainingAfterFetch };
  }

  /**
   * Читання останнього зрізу телеметрії з KV як фолбек.
   */
  async readSnapshotFallback() {
    if (!this.kv) return null;
    try {
      const snap = await this.kv.get('telemetry_snapshot', { type: 'json' });
      if (snap && snap.data) {
        this.cache.setRecent(snap.data, snap.timestamp || Date.now());
        return snap.data;
      }
    } catch (err) {
      console.error('Failed to read telemetry_snapshot fallback from KV:', err);
    }
    return null;
  }

  /**
   * Тротлінг-запис снепшоту в KV (кожні SNAPSHOT_KV_INTERVAL_MS або при зміні system_state).
   */
  async saveTelemetrySnapshotIfNeeded(data, timestamp = Date.now()) {
    if (!this.kv) return;
    try {
      let kvMeta = this.cache.getKvSnapshotMeta();
      if (kvMeta === null) {
        const existingSnap = await this.kv.get('telemetry_snapshot', { type: 'json' });
        this.cache.setKvSnapshotMeta(existingSnap?.timestamp || 0, existingSnap?.data?.system_state || null);
        kvMeta = this.cache.getKvSnapshotMeta();
      }

      const minIntervalMs = this.config.CACHE?.SNAPSHOT_KV_INTERVAL_MS ?? (20 * 60 * 1000);
      const elapsedMs = timestamp - (kvMeta?.timestamp || 0);
      const stateChanged = Boolean(kvMeta?.systemState && kvMeta.systemState !== data.system_state);
      const shouldWriteSnapshot = !kvMeta?.timestamp || elapsedMs >= minIntervalMs || stateChanged;

      if (shouldWriteSnapshot) {
        await this.kv.put('telemetry_snapshot', JSON.stringify({ timestamp, data }));
        this.cache.setKvSnapshotMeta(timestamp, data.system_state);
      }
    } catch (err) {
      console.error('Failed to save telemetry_snapshot to KV:', err);
    }
  }
}
