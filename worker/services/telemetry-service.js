import { CONFIG } from '../config.js';
import { DeyeClient } from './deye-client.js';
import { globalCache } from './cache.js';
import { HistoryRepository, compactHistoryRecord, mergeDeviceVoltagesIntoRecords } from './history-repository.js';
import { calculateAutonomy, calculateDischargeRate, calculate24hDischarge } from '../domain/autonomy.js';
import { analyzeMultiDayOutages, calculateOutageStatistics, buildArchiveResponse, formatDurationUk, OutageType } from '../domain/outages.js';
import { buildOutageChart } from '../ui/chart.js';
import { resolveSystemState } from '../domain/system-state.js';
import { nowUtcSec, formatKyivTime, formatKyivDate } from '../domain/time.js';

export { compactHistoryRecord, mergeDeviceVoltagesIntoRecords };

/**
 * Генерує список дат за минулі дні для побудови багатоденного графіка.
 */
export function getPastDaysList(currentSec = nowUtcSec(), daysCount = CONFIG.CACHE.HISTORY_DAYS) {
  const days = [];
  const baseSec = (currentSec instanceof Date) ? Math.floor(currentSec.getTime() / 1000) : currentSec;
  for (let i = 1; i <= daysCount; i++) {
    const daySec = baseSec - i * 86400;
    const dateStr = formatKyivDate(daySec);
    const [y, m, day] = dateStr.split('-').map(Number);
    days.push({ y, m, day, key: `${y}-${m}-${day}`, offset: i });
  }
  return days;
}

/**
 * Сервіс оркестрації телеметрії та журналу подій інвертора (Application Layer).
 * Дотримується SRP та DIP: зберігання й батч-завантаження делеговані HistoryRepository.
 */
export class TelemetryService {
  constructor(env = {}, cache = globalCache, config = CONFIG, deps = {}) {
    this.env = env;
    this.cache = cache;
    this.config = config;

    const stationId = env.DEYE_STATION_ID || env.STATION_ID;
    const token = env.DEYE_TOKEN || env.TOKEN;
    const apiBase = env.DEYE_API_BASE || env.API_BASE || "https://deye-proxy.vercel.app";

    if (!deps.client && (!stationId || !token)) {
      throw new Error("Missing required secrets: DEYE_STATION_ID and/or DEYE_TOKEN. Please configure them via wrangler secret or .dev.vars");
    }

    this.stationId = stationId;
    this.deviceId = env.DEYE_DEVICE_ID || (String(stationId) === '62623074' ? '15987482' : null);
    this.client = deps.client || new DeyeClient(apiBase, token, stationId);
    this.repository = deps.repository || new HistoryRepository({
      client: this.client,
      cache: this.cache,
      kv: (env && env.NOTIFY_KV) || null,
      deviceId: this.deviceId,
      config: this.config
    });
  }

  /**
   * Оцінка стану зв'язку даталогера / інвертора.
   */
  evaluateDeviceHealth(disp, todayRecords, soc, isGridOn, todayDateStr, nowStr) {
    const nowSec = Math.floor(Date.now() / 1000);
    const lastRecord = todayRecords.length > 0 ? todayRecords[todayRecords.length - 1] : null;
    const lastRecordSec = lastRecord ? lastRecord.dateTime : null;
    let lastDeviceSec = disp.lastUpdateTime || lastRecordSec;
    if (lastDeviceSec && lastDeviceSec > 1e11) {
      lastDeviceSec = Math.floor(lastDeviceSec / 1000);
    }

    let isOnline = true;
    let deviceOfflineMinutes = 0;
    let deviceLastSeen = nowStr;
    let offlineReason = "";
    let offlineType = "";

    if (lastDeviceSec) {
      deviceOfflineMinutes = Math.max(0, Math.round((nowSec - lastDeviceSec) / 60));
      const lastSeenTime = formatKyivTime(lastDeviceSec);
      const lastSeenDateStr = formatKyivDate(lastDeviceSec);
      deviceLastSeen = (lastSeenDateStr === todayDateStr)
        ? `сьогодні о ${lastSeenTime}`
        : `${lastSeenDateStr} ${lastSeenTime}`;
    }

    const isNetworkAbnormal = Boolean(disp.networkStatus && disp.networkStatus !== "NORMAL");
    const isStale = (deviceOfflineMinutes > this.config.THRESHOLDS.OFFLINE_THRESHOLD_MIN);

    if (isNetworkAbnormal || isStale) {
      isOnline = false;
      const durStr = deviceOfflineMinutes > 0 ? formatDurationUk(deviceOfflineMinutes) : '';
      if (!isGridOn && soc <= (this.config.BATTERY.SAFETY_BUFFER_SOC || 10)) {
        offlineType = "BATTERY_DEPLETED";
        offlineReason = `Акумулятор розрядився до мінімального порогу (${soc}%). Резервне живлення будинку вимкнено інвертором. Сигнал відсутній ${durStr ? `понад ${durStr}` : ''} (останній зв'язок: ${deviceLastSeen}).`;
      } else {
        offlineType = "DEVICE_OFFLINE";
        offlineReason = `Сигнал відсутній ${durStr ? `понад ${durStr}` : ''}. Останній зв'язок був ${deviceLastSeen}. Можливо, відключено роутер або живлення в щитовій.`;
      }
    }

    return {
      is_online: isOnline,
      device_offline_minutes: deviceOfflineMinutes,
      device_last_seen: deviceLastSeen,
      offline_reason: offlineReason,
      offline_type: offlineType,
      lastRecord,
      lastRecordSec
    };
  }

  /**
   * Побудова графіків та розбивка на категорії ДТЕК / Захист напруги з закріпленою активною подією.
   */
  buildOutageChartsPayload(outageJournal, multiDayRecords) {
    const validOutages = outageJournal.validEvents || [];
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
    const outageCharts = ongoing_outage_chart ? [ongoing_outage_chart, ...combinedCompleted] : combinedCompleted;

    return { ongoing_outage_chart, blackout_outages, voltage_outages, outageCharts };
  }

  async getTelemetry() {
    const currentUtcSec = nowUtcSec();
    const nowStr = formatKyivTime(currentUtcSec);
    const todayDateStr = formatKyivDate(currentUtcSec);
    const [yToday, mToday, dToday] = todayDateStr.split('-').map(Number);
    const nowKyiv = new Date(currentUtcSec * 1000 + this.config.TIME.KYIV_OFFSET_SEC * 1000);
    const pastDays = getPastDaysList(currentUtcSec, this.config.CACHE.HISTORY_DAYS);

    try {
      const dispPromise = this.client.getStationDisplay();
      const todayPromise = this.repository.loadTodayWithVoltages(yToday, mToday, dToday);
      const { pastRecordsChronological, daysFetched } = await this.repository.loadPastWindow(pastDays);
      const [disp, { todayRecords, latestVoltages }] = await Promise.all([dispPromise, todayPromise]);

      const multiDayRecords = [...pastRecordsChronological, ...todayRecords];
      const records24h = multiDayRecords.slice(-288);

      const soc = disp.batterySoc ?? 100;
      const voltage = disp.batteryBv ?? 645.0;
      const is_grid_on = (disp.gridRelayStatus === "on" || (disp.wirePower ?? 0) > this.config.THRESHOLDS.GRID_MIN_W);
      const rawBatteryPower = disp.batteryPower ?? 0;

      const is_charging = (disp.batteryStatus === "CHARGE" || rawBatteryPower < -100);
      const charge_power_kw = is_charging ? Math.abs(rawBatteryPower / 1000.0) : 0;
      const discharge_power_kw = !is_charging ? Math.max(0, rawBatteryPower / 1000.0) : 0;
      const use_power_kw = (disp.usePower ?? 2000) / 1000.0;
      const grid_power_kw = (disp.wirePower ?? 12000) / 1000.0;

      const health = this.evaluateDeviceHealth(disp, todayRecords, soc, is_grid_on, todayDateStr, nowStr);

      let time_to_full_formatted = "--";
      let time_to_full_est = "--";
      if (is_charging && charge_power_kw > 0.5) {
        const kwhNeeded = this.config.BATTERY.NOMINAL_CAPACITY_KWH * Math.max(0, 100 - soc) / 100.0;
        const hoursToFull = kwhNeeded / charge_power_kw;
        time_to_full_formatted = formatDurationUk(Math.round(hoursToFull * 60));
        time_to_full_est = formatKyivTime(currentUtcSec + Math.round(hoursToFull * 3600));
      }

      const outageJournal = analyzeMultiDayOutages(multiDayRecords, currentUtcSec, this.config);
      const { statActiveKw, statNightKw } = calculateOutageStatistics(multiDayRecords, this.config, outageJournal);
      const { est_hours_formatted, est_time_until, hoursConservative } = calculateAutonomy(
        soc, is_grid_on, use_power_kw, statActiveKw, statNightKw, nowKyiv, this.config
      );
      const { est_hours_formatted: full_est_hours_formatted } = calculateAutonomy(
        100, true, statActiveKw, statActiveKw, statNightKw, nowKyiv, this.config
      );

      const charge_rate_pct = charge_power_kw > 0
        ? (charge_power_kw / this.config.BATTERY.NOMINAL_CAPACITY_KWH * 100).toFixed(1)
        : "0";

      const { ongoing_outage_chart, blackout_outages, voltage_outages, outageCharts } =
        this.buildOutageChartsPayload(outageJournal, multiDayRecords);

      const discharge_24h_kwh = calculate24hDischarge(records24h, this.config);
      const { ratePct: discharge_rate_pct, subtext: discharge_rate_subtext } = calculateDischargeRate(
        use_power_kw, discharge_power_kw, ongoing_outage_chart, this.config
      );

      const lastRecord = health.lastRecord;
      const fallbackGridVoltages = (lastRecord && typeof lastRecord.v1 === 'number' && typeof lastRecord.v2 === 'number' && typeof lastRecord.v3 === 'number')
        ? { l1: lastRecord.v1, l2: lastRecord.v2, l3: lastRecord.v3, ts: lastRecord.dateTime }
        : null;
      const fallbackLoadVoltages = (lastRecord && typeof lastRecord.lv1 === 'number' && typeof lastRecord.lv2 === 'number' && typeof lastRecord.lv3 === 'number')
        ? { l1: lastRecord.lv1, l2: lastRecord.lv2, l3: lastRecord.lv3, ts: lastRecord.dateTime }
        : null;

      const rawResult = {
        version: this.config.APP_VERSION,
        is_online: health.is_online,
        device_last_seen: health.device_last_seen,
        device_offline_minutes: health.device_offline_minutes,
        offline_type: health.offline_type,
        offline_reason: health.offline_reason,
        updated_at: nowStr,
        is_grid_on,
        is_charging: health.is_online ? is_charging : false,
        battery_status: disp.batteryStatus ?? (is_charging ? "CHARGE" : "DISCHARGE"),
        current_outage: outageJournal.currentOutage,
        battery_soc: soc,
        battery_voltage: voltage,
        grid_voltages: latestVoltages?.grid || fallbackGridVoltages,
        load_voltages: latestVoltages?.load || fallbackLoadVoltages,
        charge_power_kw: health.is_online ? charge_power_kw : 0,
        discharge_power_kw: health.is_online ? discharge_power_kw : 0,
        charge_rate_pct: health.is_online ? charge_rate_pct : "0",
        discharge_rate_pct: health.is_online ? discharge_rate_pct : "0",
        discharge_rate_subtext: health.is_online ? discharge_rate_subtext : (health.offline_reason || "Немає зв'язку"),
        use_power_kw: health.is_online ? use_power_kw : 0,
        grid_power_kw: health.is_online ? grid_power_kw : 0,
        discharge_24h_kwh,
        today_discharge_kwh: discharge_24h_kwh,
        nominal_capacity_kwh: this.config.BATTERY.NOMINAL_CAPACITY_KWH,
        time_to_full_formatted: health.is_online ? time_to_full_formatted : "--",
        time_to_full_est: health.is_online ? time_to_full_est : "--",
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
          isOnline: health.is_online,
          dispNetworkStatus: disp.networkStatus || null,
          dispLastUpdateTime: disp.lastUpdateTime || null,
          lastRecordTime: health.lastRecordSec || null,
          deviceOfflineMinutes: health.device_offline_minutes,
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
      await this.repository.saveTelemetrySnapshotIfNeeded(rawResult, snapshotTs);

      return rawResult;
    } catch (e) {
      return this.#handleTelemetryFailure(e, nowStr);
    }
  }

  async #handleTelemetryFailure(e, nowStr) {
    const rawMsg = (e && e.message) ? e.message : 'помилка мережі';
    const cleanErrMsg = rawMsg
      .replace(/The operation was aborted\.?/gi, 'перевищено час очікування')
      .replace(/AbortError:?/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    let recent = this.cache.getRecent();
    if (!recent) {
      recent = await this.repository.readSnapshotFallback();
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
      offline_reason: `Не вдалося зв'ятися з сервером Deye Cloud (${cleanErrMsg || 'перевищено час очікування'}).`,
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

  /**
   * Повертає 30-денний архів подій (блекаути ДТЕК та захисти напруги) з кешем у пам'яті та інкрементальним KV-кешем.
   */
  async getOutageArchive({
    days = this.config.CACHE?.ARCHIVE_DAYS || 30,
    maxBatchDays = this.config.CACHE?.ARCHIVE_BATCH_DAYS || 15,
    bypassCache = false
  } = {}) {
    const archiveTtlMs = this.config.CACHE?.ARCHIVE_TTL_MS || 120000;
    if (!bypassCache && this.cache.isArchiveFresh(archiveTtlMs)) {
      return this.cache.getArchiveRecent();
    }

    const currentUtcSec = nowUtcSec();
    const todayDateStr = formatKyivDate(currentUtcSec);
    const fromDateStr = formatKyivDate(currentUtcSec - days * 86400);
    const [yToday, mToday, dToday] = todayDateStr.split('-').map(Number);
    const pastDays = getPastDaysList(currentUtcSec, days);

    const [{ pastChronological, daysLoadedPast, remainingAfterFetch }, { todayRecords }] = await Promise.all([
      this.repository.loadArchive30dWindow(pastDays, maxBatchDays),
      this.repository.loadTodayWithVoltages(yToday, mToday, dToday)
    ]);

    const allRecords = [...pastChronological, ...todayRecords];
    const journal = analyzeMultiDayOutages(allRecords, currentUtcSec, this.config);
    const daysAvailable = daysLoadedPast + (todayRecords.length > 0 ? 1 : 0);

    const archive = buildArchiveResponse({
      events: journal.validEvents || [],
      records: allRecords,
      daysAvailable,
      daysRequested: days,
      remainingDays: remainingAfterFetch,
      fromDateStr,
      toDateStr: todayDateStr
    });

    if (!archive.period.isPartial) {
      this.cache.setArchiveRecent(archive, Date.now());
    }

    return archive;
  }
}
