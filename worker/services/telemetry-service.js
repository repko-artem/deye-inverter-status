import { CONFIG } from '../config.js';
import { DeyeClient } from './deye-client.js';
import { globalCache } from './cache.js';
import { calculateAutonomy, calculateDischargeRate, calculate24hDischarge } from '../domain/autonomy.js';
import { analyzeMultiDayOutages, calculateOutageStatistics } from '../domain/outages.js';
import { buildOutageChart } from '../ui/chart.js';

/**
 * Генерує список дат за минулі дні для побудови багатоденного графіка
 */
export function getPastDaysList(nowDate, daysCount = CONFIG.CACHE.HISTORY_DAYS) {
  const days = [];
  for (let i = 1; i <= daysCount; i++) {
    const d = new Date(nowDate.getTime() - i * 24 * 3600 * 1000);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
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

    this.client = new DeyeClient(apiBase, token, stationId);
  }

  async getTelemetry() {
    const nowKyiv = new Date(Date.now() + this.config.TIME.KYIV_OFFSET_SEC * 1000);
    const nowStr = nowKyiv.toISOString().substring(11, 16);

    const yToday = nowKyiv.getFullYear();
    const mToday = nowKyiv.getMonth() + 1;
    const dToday = nowKyiv.getDate();

    const pastDays = getPastDaysList(nowKyiv, this.config.CACHE.HISTORY_DAYS);

    try {
      // 1. Паралельний запит: станція + сьогоднішня історія
      const dispPromise = this.client.getStationDisplay();
      const histTodayPromise = this.client.getDailyBatteryHistory(yToday, mToday, dToday);

      // 2. Довантаження відсутніх днів з кешу
      const pastDayPromises = [];
      for (const pd of pastDays) {
        if (!this.cache.getDayRecords(pd.key)) {
          pastDayPromises.push({
            pd,
            promise: this.client.getDailyBatteryHistory(pd.y, pd.m, pd.day).catch(err => {
              console.error(`Error fetching history for ${pd.key}:`, err);
              return null;
            })
          });
        }
      }

      const [disp, histToday] = await Promise.all([dispPromise, histTodayPromise]);

      for (const item of pastDayPromises) {
        const json = await item.promise;
        if (json && json.records && json.records.length > 0) {
          this.cache.setDayRecords(item.pd.key, json.records);
        }
      }

      // 3. Формування хронологічного масиву записів
      const pastRecordsChronological = [...pastDays].reverse().flatMap(pd => this.cache.getDayRecords(pd.key) || []);
      const todayRecords = (histToday && histToday.records) || [];
      const multiDayRecords = [...pastRecordsChronological, ...todayRecords];
      const records24h = multiDayRecords.slice(-288); // 24h = 288 точок по 5 хв

      // 4. Базові показники інвертора
      const soc = disp.batterySoc ?? 100;
      const voltage = disp.batteryBv ?? 645.0;
      const is_grid_on = (disp.gridRelayStatus === "on" || (disp.wirePower ?? 0) > this.config.THRESHOLDS.GRID_MIN_W);
      const rawBatteryPower = disp.batteryPower ?? 0;

      const is_charging = (disp.batteryStatus === "CHARGE" || rawBatteryPower < -100);
      const charge_power_kw = is_charging ? Math.abs(rawBatteryPower / 1000.0) : 0;
      const discharge_power_kw = !is_charging ? Math.max(0, rawBatteryPower / 1000.0) : 0;

      const use_power_kw = (disp.usePower ?? 2000) / 1000.0;
      const grid_power_kw = (disp.wirePower ?? 12000) / 1000.0;

      // 5. Розрахунок часу до повного заряду
      let time_to_full_formatted = "--";
      let time_to_full_est = "--";
      if (is_charging && charge_power_kw > 0.5) {
        const kwhNeeded = this.config.BATTERY.NOMINAL_CAPACITY_KWH * Math.max(0, 100 - soc) / 100.0;
        const hoursToFull = kwhNeeded / charge_power_kw;
        const h = Math.floor(hoursToFull);
        const m = Math.round((hoursToFull - h) * 60);
        time_to_full_formatted = `${h} год ${m} хв`;

        const fullDate = new Date(nowKyiv.getTime() + hoursToFull * 3600 * 1000);
        time_to_full_est = fullDate.toISOString().substring(11, 16);
      }

      // 6. Доменна статистика споживання (день / ніч)
      const { statActiveKw, statNightKw } = calculateOutageStatistics(multiDayRecords, this.config);

      // 7. Доменний розрахунок автономності
      const autonomy = calculateAutonomy(soc, is_grid_on, use_power_kw, statActiveKw, statNightKw, nowKyiv, this.config);
      const { est_hours_formatted, est_time_until, hoursConservative } = autonomy;

      const charge_rate_pct = charge_power_kw > 0 
        ? (charge_power_kw / this.config.BATTERY.NOMINAL_CAPACITY_KWH * 100).toFixed(1) 
        : "0";

      // 8. Журнал та графіки відключень
      const outageJournal = analyzeMultiDayOutages(multiDayRecords, nowKyiv, this.config);
      const validOutages = outageJournal.validEvents || [];
      const recentOutages = validOutages.slice(-3).reverse();
      const outageCharts = recentOutages
        .map((e, idx) => buildOutageChart(e, multiDayRecords, validOutages.length - idx, this.config))
        .filter(Boolean);

      // 9. Доменний розрахунок витрати та темпу розряду
      const discharge_24h_kwh = calculate24hDischarge(records24h, this.config);
      const curOngoingChart = outageCharts.find(c => c && c.isOngoing);
      const { ratePct: discharge_rate_pct, subtext: discharge_rate_subtext } = calculateDischargeRate(
        use_power_kw,
        discharge_power_kw,
        curOngoingChart,
        this.config
      );

      return {
        version: this.config.APP_VERSION,
        updated_at: nowStr,
        is_grid_on,
        is_charging,
        battery_status: disp.batteryStatus ?? (is_charging ? "CHARGE" : "DISCHARGE"),
        current_outage: outageJournal.currentOutage,
        battery_soc: soc,
        battery_voltage: voltage,
        charge_power_kw,
        discharge_power_kw,
        charge_rate_pct,
        discharge_rate_pct,
        discharge_rate_subtext,
        use_power_kw,
        grid_power_kw,
        discharge_24h_kwh,
        today_discharge_kwh: discharge_24h_kwh,
        nominal_capacity_kwh: this.config.BATTERY.NOMINAL_CAPACITY_KWH,
        time_to_full_formatted,
        time_to_full_est,
        est_hours_remaining: Math.round(hoursConservative * 10) / 10,
        est_hours_formatted,
        est_time_until,
        stat_active_kw: statActiveKw.toFixed(1),
        stat_night_kw: statNightKw.toFixed(1),
        journal: outageJournal,
        outages: outageCharts,
        debug_info: {
          daysFetched: pastDayPromises.map(p => p.pd.key),
          cachedKeys: this.cache.getCachedDayKeys(),
          cachedCounts: this.cache.getCachedDayCounts(),
          pastRecordsCount: pastRecordsChronological.length,
          todayRecordsCount: todayRecords.length,
          multiDayCount: multiDayRecords.length
        }
      };
    } catch (e) {
      const recent = this.cache.getRecent();
      if (recent) {
        console.error("Deye fetch error, serving previous in-memory telemetry:", e);
        return recent;
      }
      return {
        version: this.config.APP_VERSION,
        worker_error: (e ? e.message || String(e) : "unknown"),
        worker_stack: (e ? e.stack : ""),
        updated_at: nowStr,
        is_grid_on: true,
        is_charging: false,
        battery_soc: 100,
        battery_voltage: 645.0,
        charge_power_kw: 0,
        discharge_power_kw: 0,
        charge_rate_pct: "0",
        discharge_rate_pct: "0",
        discharge_rate_subtext: "Помилка зв'язку з Deye API",
        use_power_kw: 0,
        grid_power_kw: 0,
        discharge_24h_kwh: "0.0",
        today_discharge_kwh: "0.0",
        nominal_capacity_kwh: this.config.BATTERY.NOMINAL_CAPACITY_KWH,
        time_to_full_formatted: "--",
        time_to_full_est: "--",
        est_hours_remaining: 15.0,
        est_hours_formatted: "15 – 23 год",
        est_time_until: "--",
        stat_active_kw: this.config.THRESHOLDS.DEFAULT_ACTIVE_KW.toFixed(1),
        stat_night_kw: this.config.THRESHOLDS.DEFAULT_NIGHT_KW.toFixed(1),
        journal: { count: 0, totalMin: 0, minSoc: 100, events: [] },
        outages: []
      };
    }
  }
}
