import { CONFIG } from '../config.js';
import { DeyeClient } from './deye-client.js';
import { globalCache } from './cache.js';
import { calculateAutonomy, calculateDischargeRate, calculate24hDischarge } from '../domain/autonomy.js';
import { analyzeMultiDayOutages, calculateOutageStatistics, OutageType } from '../domain/outages.js';
import { buildOutageChart } from '../ui/chart.js';
import { resolveSystemState } from '../domain/system-state.js';
import { nowUtcSec, formatKyivTime, formatKyivDate } from '../domain/time.js';

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
 * @param {Array<Object>} records
 * @param {Array<Object>} seriesList
 * @returns {{ grid: {l1:number,l2:number,l3:number,ts:number}|null, load: {l1:number,l2:number,l3:number,ts:number}|null }}
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
    ? {
        l1: latestByKey.v1.val,
        l2: latestByKey.v2.val,
        l3: latestByKey.v3.val,
        ts: latestGridTs
      }
    : null;

  const load = (latestByKey.lv1 && latestByKey.lv2 && latestByKey.lv3)
    ? {
        l1: latestByKey.lv1.val,
        l2: latestByKey.lv2.val,
        l3: latestByKey.lv3.val,
        ts: latestLoadTs
      }
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
 * Генерує список дат за минулі дні для побудови багатоденного графіка
 */
export function getPastDaysList(currentSec = nowUtcSec(), daysCount = CONFIG.CACHE.HISTORY_DAYS) {
  const days = [];
  const baseSec = (currentSec instanceof Date) ? Math.floor(currentSec.getTime() / 1000) : currentSec;
  for (let i = 1; i <= daysCount; i++) {
    const daySec = baseSec - i * 86400;
    const dateStr = formatKyivDate(daySec);
    const [y, m, day] = dateStr.split('-').map(Number);
    const key = `${y}-${m}-${day}`;
    days.push({ y, m, day, key, offset: i });
  }
  return days;
}

/**
 * Сервіс збору та агрегації телеметрії інвертора
 */
export class TelemetryService {
  constructor(env = {}, cache = globalCache, config = CONFIG) {
    this.env = env;
    this.cache = cache;
    this.config = config;

    const stationId = env.DEYE_STATION_ID || env.STATION_ID;
    const token = env.DEYE_TOKEN || env.TOKEN;
    const apiBase = env.DEYE_API_BASE || env.API_BASE || "https://deye-proxy.vercel.app";

    if (!stationId || !token) {
      throw new Error("Missing required secrets: DEYE_STATION_ID and/or DEYE_TOKEN. Please configure them via wrangler secret or .dev.vars");
    }

    this.stationId = stationId;
    this.deviceId = env.DEYE_DEVICE_ID || (String(stationId) === '62623074' ? '15987482' : null);
    this.client = new DeyeClient(apiBase, token, stationId);
  }

  async getTelemetry() {
    const currentUtcSec = nowUtcSec();
    const nowStr = formatKyivTime(currentUtcSec);
    const todayDateStr = formatKyivDate(currentUtcSec);
    const [yToday, mToday, dToday] = todayDateStr.split('-').map(Number);
    const nowKyiv = new Date(currentUtcSec * 1000 + this.config.TIME.KYIV_OFFSET_SEC * 1000);
    const pastDays = getPastDaysList(currentUtcSec, this.config.CACHE.HISTORY_DAYS);

    try {
      const kv = this.env && this.env.NOTIFY_KV;
      const pastHistoryKvKey = this.deviceId ? 'history_past_days_v2' : 'history_past_days';

      // 1. Паралельний запит: поточна станція + сьогоднішня історія + (за наявності deviceId) фазні напруги
      const dispPromise = this.client.getStationDisplay();
      const histTodayPromise = this.client.getDailyBatteryHistory(yToday, mToday, dToday).catch(err => {
        console.error("Помилка завантаження сьогоднішньої історії (м'який фолбек):", err);
        return null;
      });
      const todayVoltagesPromise = this.deviceId
        ? this.client.getDailyDeviceVoltages(this.deviceId, yToday, mToday, dToday).catch(err => {
            console.error("Помилка завантаження сьогоднішньої напруги пристрою (м'який фолбек):", err);
            return [];
          })
        : Promise.resolve([]);

      // 2. Перевірка кешу минулих днів і довантаження з Cloudflare KV за потреби
      let missingPastDays = pastDays.filter(pd => !this.cache.getDayRecords(pd.key));
      if (missingPastDays.length > 0 && kv) {
        try {
          const kvHistory = await kv.get(pastHistoryKvKey, { type: 'json' });
          if (kvHistory && typeof kvHistory === 'object') {
            for (const pd of missingPastDays) {
              if (Array.isArray(kvHistory[pd.key]) && kvHistory[pd.key].length > 0) {
                this.cache.setDayRecords(pd.key, kvHistory[pd.key]);
              }
            }
            missingPastDays = pastDays.filter(pd => !this.cache.getDayRecords(pd.key));
          }
        } catch (err) {
          console.error(`Failed to read ${pastHistoryKvKey} from KV:`, err);
        }
      }

      // 3. Довантаження відсутніх днів батчами з обмеженням паралельності (<= 6 з'єднань CF)
      const concurrency = this.deviceId ? 1 : (this.config.CACHE?.HISTORY_CONCURRENCY || 3);
      const daysFetched = [];
      let fetchedAnyPastDay = false;

      for (let i = 0; i < missingPastDays.length; i += concurrency) {
        const batch = missingPastDays.slice(i, i + concurrency);
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
            this.cache.setDayRecords(pd.key, compacted);
            fetchedAnyPastDay = true;
          }
        }
      }

      if (fetchedAnyPastDay && kv) {
        try {
          const kvPayload = {};
          for (const pd of pastDays) {
            const recs = this.cache.getDayRecords(pd.key);
            if (Array.isArray(recs) && recs.length > 0) {
              kvPayload[pd.key] = recs;
            }
          }
          await kv.put(pastHistoryKvKey, JSON.stringify(kvPayload));
        } catch (err) {
          console.error(`Failed to save ${pastHistoryKvKey} to KV:`, err);
        }
      }

      const [disp, histToday, todayVoltages] = await Promise.all([dispPromise, histTodayPromise, todayVoltagesPromise]);

      // 3. Формування хронологічного масиву записів
      const pastRecordsChronological = [...pastDays].reverse().flatMap(pd => this.cache.getDayRecords(pd.key) || []);
      const todayRecords = (histToday && histToday.records) || [];
      const latestVoltages = mergeDeviceVoltagesIntoRecords(todayRecords, todayVoltages);
      const multiDayRecords = [...pastRecordsChronological, ...todayRecords];
      const records24h = multiDayRecords.slice(-288); // 24h = 288 точок по 5 хв

      // 3.5. Базові показники інвертора (потрібні для оцінки статусу мережі та батареї)
      const soc = disp.batterySoc ?? 100;
      const voltage = disp.batteryBv ?? 645.0;
      const is_grid_on = (disp.gridRelayStatus === "on" || (disp.wirePower ?? 0) > this.config.THRESHOLDS.GRID_MIN_W);
      const rawBatteryPower = disp.batteryPower ?? 0;

      const is_charging = (disp.batteryStatus === "CHARGE" || rawBatteryPower < -100);
      const charge_power_kw = is_charging ? Math.abs(rawBatteryPower / 1000.0) : 0;
      const discharge_power_kw = !is_charging ? Math.max(0, rawBatteryPower / 1000.0) : 0;

      const use_power_kw = (disp.usePower ?? 2000) / 1000.0;
      const grid_power_kw = (disp.wirePower ?? 12000) / 1000.0;

      // 3.6. Перевірка статусу зв'язку інвертора / даталогера
      const nowSec = Math.floor(Date.now() / 1000);
      const lastRecord = todayRecords.length > 0 ? todayRecords[todayRecords.length - 1] : null;
      const lastRecordSec = lastRecord ? lastRecord.dateTime : null;
      let lastDeviceSec = disp.lastUpdateTime || lastRecordSec;
      if (lastDeviceSec && lastDeviceSec > 1e11) {
        lastDeviceSec = Math.floor(lastDeviceSec / 1000);
      }

      let is_online = true;
      let device_offline_minutes = 0;
      let device_last_seen = nowStr;
      let offline_reason = "";
      let offline_type = "";

      if (lastDeviceSec) {
        device_offline_minutes = Math.max(0, Math.round((nowSec - lastDeviceSec) / 60));
        const lastSeenTime = formatKyivTime(lastDeviceSec);
        const lastSeenDateStr = formatKyivDate(lastDeviceSec);

        device_last_seen = (lastSeenDateStr === todayDateStr) 
          ? `сьогодні о ${lastSeenTime}` 
          : `${lastSeenDateStr} ${lastSeenTime}`;
      }

      const isNetworkAbnormal = Boolean(disp.networkStatus && disp.networkStatus !== "NORMAL");
      const isStale = (device_offline_minutes > this.config.THRESHOLDS.OFFLINE_THRESHOLD_MIN);

      if (isNetworkAbnormal || isStale) {
        is_online = false;
        const durStr = device_offline_minutes >= 60 
          ? `${Math.floor(device_offline_minutes / 60)} год ${device_offline_minutes % 60 ? `${device_offline_minutes % 60} хв` : ''}`.trim()
          : `${device_offline_minutes} хв`;

        if (!is_grid_on && soc <= (this.config.BATTERY.SAFETY_BUFFER_SOC || 10)) {
          offline_type = "BATTERY_DEPLETED";
          offline_reason = `Акумулятор розрядився до мінімального порогу (${soc}%). Резервне живлення будинку вимкнено інвертором. Сигнал відсутній ${durStr ? `понад ${durStr}` : ''} (останній зв'язок: ${device_last_seen}).`;
        } else {
          offline_type = "DEVICE_OFFLINE";
          offline_reason = `Сигнал відсутній ${durStr ? `понад ${durStr}` : ''}. Останній зв'язок був ${device_last_seen}. Можливо, відключено роутер або живлення в щитовій.`;
        }
      }

      // 5. Розрахунок часу до повного заряду
      let time_to_full_formatted = "--";
      let time_to_full_est = "--";
      if (is_charging && charge_power_kw > 0.5) {
        const kwhNeeded = this.config.BATTERY.NOMINAL_CAPACITY_KWH * Math.max(0, 100 - soc) / 100.0;
        const hoursToFull = kwhNeeded / charge_power_kw;
        const h = Math.floor(hoursToFull);
        const m = Math.round((hoursToFull - h) * 60);
        time_to_full_formatted = `${h} год ${m} хв`;

        time_to_full_est = formatKyivTime(currentUtcSec + Math.round(hoursToFull * 3600));
      }

      // 6. Журнал та графіки відключень (передаємо чистий UTC час)
      const outageJournal = analyzeMultiDayOutages(multiDayRecords, currentUtcSec, this.config);

      // 7. Доменна статистика споживання (день / ніч) — виключно по інтервалах BLACKOUT (0 В)
      const { statActiveKw, statNightKw } = calculateOutageStatistics(multiDayRecords, this.config, outageJournal);

      // 8. Доменний розрахунок автономності
      const autonomy = calculateAutonomy(soc, is_grid_on, use_power_kw, statActiveKw, statNightKw, nowKyiv, this.config);
      const { est_hours_formatted, est_time_until, hoursConservative } = autonomy;

      const fullAutonomy = calculateAutonomy(100, true, statActiveKw, statActiveKw, statNightKw, nowKyiv, this.config);
      const full_est_hours_formatted = fullAutonomy.est_hours_formatted;

      const charge_rate_pct = charge_power_kw > 0 
        ? (charge_power_kw / this.config.BATTERY.NOMINAL_CAPACITY_KWH * 100).toFixed(1) 
        : "0";

      const validOutages = outageJournal.validEvents || [];
      // Показувати поточне відключення завжди першим (навіть якщо розряд ще <= 1%),
      // а для минулих відключень формуємо до 3 останніх графіків окремо по кожній категорії (ДТЕК / Напруга) при розряді > 1%.
      const minDrain = this.config.THRESHOLDS.MIN_OUTAGE_CHART_SOC_DRAIN ?? 1;
      const getEventDrain = (e) => (e.socDrain != null ? e.socDrain : Math.max(0, (e.startSoc || 0) - (e.minSoc || 0)));
      const buildChartList = (events, totalBase) => events
        .slice(-3)
        .reverse()
        .map((e, idx) => buildOutageChart(e, multiDayRecords, totalBase - idx, this.config))
        .filter(Boolean)
        .filter(c => c.isOngoing || c.socDrain > minDrain);

      const ongoingEvent = validOutages.find(e => e.isOngoing) || null;
      const ongoing_outage_chart = ongoingEvent
        ? buildOutageChart(ongoingEvent, multiDayRecords, validOutages.length, this.config)
        : null;

      const completedEligible = validOutages.filter(e => !e.isOngoing && getEventDrain(e) > minDrain);
      const completedBlackouts = completedEligible.filter(e => e.eventType === OutageType.BLACKOUT);
      const completedVoltages = completedEligible.filter(e => e.eventType !== OutageType.BLACKOUT);

      const blackout_outages = buildChartList(completedBlackouts, completedBlackouts.length);
      const voltage_outages = buildChartList(completedVoltages, completedVoltages.length);
      const combinedCompleted = buildChartList(completedEligible, completedEligible.length);
      const outageCharts = ongoing_outage_chart
        ? [ongoing_outage_chart, ...combinedCompleted]
        : combinedCompleted;

      // 9. Доменний розрахунок витрати та темпу розряду
      const discharge_24h_kwh = calculate24hDischarge(records24h, this.config);
      const curOngoingChart = ongoing_outage_chart;
      const { ratePct: discharge_rate_pct, subtext: discharge_rate_subtext } = calculateDischargeRate(
        use_power_kw,
        discharge_power_kw,
        curOngoingChart,
        this.config
      );

      const fallbackGridVoltages = (lastRecord && typeof lastRecord.v1 === 'number' && typeof lastRecord.v2 === 'number' && typeof lastRecord.v3 === 'number')
        ? { l1: lastRecord.v1, l2: lastRecord.v2, l3: lastRecord.v3, ts: lastRecord.dateTime }
        : null;
      const fallbackLoadVoltages = (lastRecord && typeof lastRecord.lv1 === 'number' && typeof lastRecord.lv2 === 'number' && typeof lastRecord.lv3 === 'number')
        ? { l1: lastRecord.lv1, l2: lastRecord.lv2, l3: lastRecord.lv3, ts: lastRecord.dateTime }
        : null;

      const rawResult = {
        version: this.config.APP_VERSION,
        is_online,
        device_last_seen,
        device_offline_minutes,
        offline_type,
        offline_reason,
        updated_at: nowStr,
        is_grid_on,
        is_charging: is_online ? is_charging : false,
        battery_status: disp.batteryStatus ?? (is_charging ? "CHARGE" : "DISCHARGE"),
        current_outage: outageJournal.currentOutage,
        battery_soc: soc,
        battery_voltage: voltage,
        grid_voltages: latestVoltages?.grid || fallbackGridVoltages,
        load_voltages: latestVoltages?.load || fallbackLoadVoltages,
        charge_power_kw: is_online ? charge_power_kw : 0,
        discharge_power_kw: is_online ? discharge_power_kw : 0,
        charge_rate_pct: is_online ? charge_rate_pct : "0",
        discharge_rate_pct: is_online ? discharge_rate_pct : "0",
        discharge_rate_subtext: is_online ? discharge_rate_subtext : (offline_reason || "Немає зв'язку"),
        use_power_kw: is_online ? use_power_kw : 0,
        grid_power_kw: is_online ? grid_power_kw : 0,
        discharge_24h_kwh,
        today_discharge_kwh: discharge_24h_kwh,
        nominal_capacity_kwh: this.config.BATTERY.NOMINAL_CAPACITY_KWH,
        time_to_full_formatted: is_online ? time_to_full_formatted : "--",
        time_to_full_est: is_online ? time_to_full_est : "--",
        est_hours_remaining: Math.round(hoursConservative * 10) / 10,
        est_hours_formatted,
        est_time_until,
        full_est_hours_formatted,
        stat_active_kw: statActiveKw.toFixed(1),
        stat_night_kw: statNightKw.toFixed(1),
        journal: outageJournal,
        ongoing_outage_chart,
        blackout_outages,
        voltage_outages,
        outages: outageCharts,
        debug_info: {
          isOnline: is_online,
          dispNetworkStatus: disp.networkStatus || null,
          dispLastUpdateTime: disp.lastUpdateTime || null,
          lastRecordTime: lastRecordSec || null,
          deviceOfflineMinutes: device_offline_minutes,
          daysFetched,
          cachedKeys: this.cache.getCachedDayKeys(),
          cachedCounts: this.cache.getCachedDayCounts(),
          pastRecordsCount: pastRecordsChronological.length,
          todayRecordsCount: todayRecords.length,
          multiDayCount: multiDayRecords.length
        }
      };

      const systemState = resolveSystemState(rawResult, { safetyBufferSoc: this.config.BATTERY.SAFETY_BUFFER_SOC });
      rawResult.system_state = systemState.id;

      const snapshotTs = Date.now();
      this.cache.setRecent(rawResult, snapshotTs);
      if (kv) {
        try {
          let kvMeta = this.cache.getKvSnapshotMeta();
          if (kvMeta === null) {
            const existingSnap = await kv.get('telemetry_snapshot', { type: 'json' });
            this.cache.setKvSnapshotMeta(existingSnap?.timestamp || 0, existingSnap?.data?.system_state || null);
            kvMeta = this.cache.getKvSnapshotMeta();
          }

          const minIntervalMs = this.config.CACHE?.SNAPSHOT_KV_INTERVAL_MS ?? (20 * 60 * 1000);
          const elapsedMs = snapshotTs - (kvMeta?.timestamp || 0);
          const stateChanged = Boolean(kvMeta?.systemState && kvMeta.systemState !== rawResult.system_state);
          const shouldWriteSnapshot = !kvMeta?.timestamp || elapsedMs >= minIntervalMs || stateChanged;

          if (shouldWriteSnapshot) {
            await kv.put('telemetry_snapshot', JSON.stringify({ timestamp: snapshotTs, data: rawResult }));
            this.cache.setKvSnapshotMeta(snapshotTs, rawResult.system_state);
          }
        } catch (err) {
          console.error('Failed to save telemetry_snapshot to KV:', err);
        }
      }

      return rawResult;
    } catch (e) {
      const rawMsg = (e && e.message) ? e.message : 'помилка мережі';
      const cleanErrMsg = rawMsg
        .replace(/The operation was aborted\.?/gi, 'перевищено час очікування')
        .replace(/AbortError:?/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      let recent = this.cache.getRecent();
      if (!recent && this.env && this.env.NOTIFY_KV) {
        try {
          const snap = await this.env.NOTIFY_KV.get('telemetry_snapshot', { type: 'json' });
          if (snap && snap.data) {
            this.cache.setRecent(snap.data, snap.timestamp || Date.now());
            recent = snap.data;
          }
        } catch (err) {
          console.error('Failed to read telemetry_snapshot fallback from KV:', err);
        }
      }

      if (recent) {
        console.error("Deye fetch error, serving previous in-memory telemetry with offline warning:", e);
        return {
          ...recent,
          is_online: false,
          offline_type: "CLOUD_ERROR",
          system_state: "CLOUD_ERROR",
          offline_reason: `Сервер Deye Cloud тимчасово не відповів (${cleanErrMsg || 'перевищено час очікування'}). Відображено збережені дані.`,
          device_offline_minutes: Math.max(recent.device_offline_minutes || 0, Math.round(this.cache.getAgeSec() / 60))
        };
      }
      return {
        version: this.config.APP_VERSION,
        is_online: false,
        offline_type: "CLOUD_UNAVAILABLE",
        system_state: "CLOUD_ERROR",
        offline_reason: `Не вдалося зв'язатися з сервером Deye Cloud (${cleanErrMsg || 'перевищено час очікування'}).`,
        worker_error: cleanErrMsg,
        worker_stack: (e ? e.stack : ""),
        updated_at: nowStr,
        device_last_seen: "--",
        device_offline_minutes: 0,
        is_grid_on: false,
        is_charging: false,
        battery_soc: 100,
        battery_voltage: 645.0,
        charge_power_kw: 0,
        discharge_power_kw: 0,
        charge_rate_pct: "0",
        discharge_rate_pct: "0",
        discharge_rate_subtext: "Помилка зв'язку з Deye Cloud",
        use_power_kw: 0,
        grid_power_kw: 0,
        discharge_24h_kwh: "0.0",
        today_discharge_kwh: "0.0",
        nominal_capacity_kwh: this.config.BATTERY.NOMINAL_CAPACITY_KWH,
        time_to_full_formatted: "--",
        time_to_full_est: "--",
        est_hours_remaining: 0,
        est_hours_formatted: "--",
        est_time_until: "--",
        full_est_hours_formatted: "--",
        stat_active_kw: this.config.THRESHOLDS.DEFAULT_ACTIVE_KW.toFixed(1),
        stat_night_kw: this.config.THRESHOLDS.DEFAULT_NIGHT_KW.toFixed(1),
        journal: { count: 0, totalMin: 0, minSoc: 100, events: [] },
        ongoing_outage_chart: null,
        blackout_outages: [],
        voltage_outages: [],
        outages: []
      };
    }
  }
}
