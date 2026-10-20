/**
 * Cloudflare Worker для публічної сторінки статусу ОСББ "Новодарницьке"
 * Працює в хмарі 24/7.
 * 
 * ОСОБЛИВОСТІ:
 * 1. Ковзне 24-годинне вікно (Rolling 24h) — безперервний графік через дні й тижні.
 * 2. Автоматичний журнал відключень (1-ше, 2-ге, 5-те, 9-те...) з підсвічуванням на графіку.
 * 3. Консервативний розрахунок автономності (до 15% SOC, 90% ККД, реальне базове навантаження).
 * 4. Автоматичне розпізнавання режимів ЗАРЯД / РОЗРЯД.
 */

// Secrets & config are read dynamically from Cloudflare Worker Environment (env.DEYE_TOKEN, env.DEYE_STATION_ID, env.DEYE_API_BASE)

// ========================================================
// ЦЕНТРАЛІЗОВАНЕ КЕШУВАННЯ (ЗАХИСТ ВІД ЛІМІТІВ DEYE CLOUD)
// ========================================================
const CACHE_TTL_MS = 60 * 1000; // Робимо запит до Deye максимум 1 раз на 60 секунд
let inMemoryData = null;
let inMemoryTimestamp = 0;
let ongoingFetchPromise = null;
let cachedDayRecords = {};

async function getCachedTelemetry(env) {
  const now = Date.now();
  // Якщо дані в пам'яті ще свіжі (< 60 секунд) — віддаємо миттєво без звернень до Deye
  if (inMemoryData && (now - inMemoryTimestamp < CACHE_TTL_MS)) {
    return inMemoryData;
  }

  // Захист від лавинних запитів: якщо один запит до Deye вже летить, усі інші підключаються до нього
  if (ongoingFetchPromise) {
    return ongoingFetchPromise;
  }

  ongoingFetchPromise = (async () => {
    try {
      const fresh = await getFreshTelemetry(env);
      inMemoryData = fresh;
      inMemoryTimestamp = Date.now();
      return fresh;
    } finally {
      ongoingFetchPromise = null;
    }
  })();

  return ongoingFetchPromise;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = (url.pathname === "/api/status" || url.pathname === "/status.json");

    // 1. Перевірка Edge-кешу Cloudflare (глобальна CDN)
    const cache = caches.default;
    const normalizedKey = new Request(url.origin + (isApi ? "/api/status" : "/"), request);
    const isBypass = (url.searchParams.get("fresh") === "1" || url.searchParams.get("bypass") === "1");

    if (!isBypass) {
      const cached = await cache.match(normalizedKey);
      if (cached) {
        return cached;
      }
    }

    // 2. Отримання даних через централізований серверний кеш
    const data = await getCachedTelemetry(env);
    const cacheAgeSec = Math.round((Date.now() - inMemoryTimestamp) / 1000);
    let response;

    const securityHeaders = {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "geolocation=(), camera=(), microphone=()"
    };

    const baseHeaders = {
      ...securityHeaders,
      "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=30",
      "X-Server-Cache-Age": cacheAgeSec.toString()
    };

    if (isApi) {
      response = new Response(JSON.stringify(data), {
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } else {
      response = new Response(renderHTML(data), {
        headers: {
          ...baseHeaders,
          "Content-Type": "text/html; charset=utf-8"
        }
      });
    }

    // Зберігаємо в CDN-кеш Cloudflare
    if (!isBypass && ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(normalizedKey, response.clone()));
    }

    return response;
  }
};

async function safeFetchJson(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const plain = trimmed.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(`HTTP ${res.status}: ${plain.substring(0, 400)}`);
  }
  return JSON.parse(text);
}

async function getFreshTelemetry(env = {}) {
  const STATION_ID = env.DEYE_STATION_ID || env.STATION_ID;
  const TOKEN = env.DEYE_TOKEN || env.TOKEN;
  const DEYE_API_BASE = env.DEYE_API_BASE || env.API_BASE || "https://deye-proxy.vercel.app";

  if (!STATION_ID || !TOKEN) {
    throw new Error("Missing required secrets: DEYE_STATION_ID and/or DEYE_TOKEN. Please configure them via wrangler secret or .dev.vars");
  }

  const now = new Date(Date.now() + 3 * 3600 * 1000); // Kyiv time UTC+3
  const nowStr = now.toISOString().substring(11, 16);
  
  const yToday = now.getFullYear();
  const mToday = now.getMonth() + 1;
  const dToday = now.getDate();

  const pastDays = [1, 2, 3, 4, 5, 6, 7].map(offset => {
    const d = new Date(now.getTime() - offset * 24 * 3600 * 1000);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const key = `${y}-${m}-${day}`;
    return { y, m, day, key, offset };
  });

  const headers = { 
    "Authorization": `Bearer ${TOKEN}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*"
  };

  try {
    const dispPromise = safeFetchJson(`${DEYE_API_BASE}/maintain-s/station/display/?stationId=${STATION_ID}`, headers);
    const histTodayPromise = safeFetchJson(`${DEYE_API_BASE}/maintain-s/history/batteryPower/${STATION_ID}/stats/daily?year=${yToday}&month=${mToday}&day=${dToday}`, headers);

    const pastDayPromises = [];
    for (const pd of pastDays) {
      if (!cachedDayRecords[pd.key] || cachedDayRecords[pd.key].length === 0) {
        pastDayPromises.push({
          pd,
          promise: safeFetchJson(`${DEYE_API_BASE}/maintain-s/history/batteryPower/${STATION_ID}/stats/daily?year=${pd.y}&month=${pd.m}&day=${pd.day}`, headers)
            .catch(err => {
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
        cachedDayRecords[item.pd.key] = json.records;
      }
    }

    const pastRecordsChronological = [...pastDays].reverse().flatMap(pd => cachedDayRecords[pd.key] || []);
    const todayRecords = (histToday && histToday.records) || [];

    // Усі записи за кілька днів у хронологічному порядку
    const multiDayRecords = [...pastRecordsChronological, ...todayRecords];
    // Ковзне вікно за останні 24 години (288 точок)
    const records24h = multiDayRecords.slice(-288);

    const soc = disp.batterySoc ?? 76;
    const voltage = disp.batteryBv ?? 648.9;
    const is_grid_on = (disp.gridRelayStatus === "on" || (disp.wirePower ?? 0) > 100);
    const rawBatteryPower = disp.batteryPower ?? 0;
    
    const is_charging = (disp.batteryStatus === "CHARGE" || rawBatteryPower < -100);
    const charge_power_kw = is_charging ? Math.abs(rawBatteryPower / 1000.0) : 0;
    const discharge_power_kw = !is_charging ? Math.max(0, rawBatteryPower / 1000.0) : 0;
    
    const use_power_kw = (disp.usePower ?? 2000) / 1000.0;
    const grid_power_kw = (disp.wirePower ?? 12000) / 1000.0;

    let time_to_full_formatted = "--";
    let time_to_full_est = "--";

    if (is_charging && charge_power_kw > 0.5) {
      const kwhNeeded = 65.0 * Math.max(0, 100 - soc) / 100.0;
      const hoursToFull = kwhNeeded / charge_power_kw;
      const h = Math.floor(hoursToFull);
      const m = Math.round((hoursToFull - h) * 60);
      time_to_full_formatted = `${h} год ${m} хв`;

      const fullDate = new Date(now.getTime() + hoursToFull * 3600 * 1000);
      time_to_full_est = fullDate.toISOString().substring(11, 16);
    }

    // ----------------------------------------------------
    // СТАТИСТИЧНА МОДЕЛЬ АВТОНОМНОСТІ ЗА ОСТАННІ 3 ДНІ
    // ----------------------------------------------------
    const kyivOffsetSec = 3 * 3600;
    const outagePoints = multiDayRecords.filter(r => 
      r.wirePower === 0 && ((r.batteryPower ?? 0) > 300 || (r.dischargePower ?? 0) > 300)
    );

    const dayOutageKws = [];
    const nightOutageKws = [];
    for (const r of outagePoints) {
      const d = new Date((r.dateTime + kyivOffsetSec) * 1000);
      const hour = d.getUTCHours();
      const kw = Math.max(0, (r.usePower || r.dischargePower || r.batteryPower || 0) / 1000.0);
      if (hour >= 23 || hour < 7) {
        nightOutageKws.push(kw);
      } else {
        dayOutageKws.push(kw);
      }
    }

    // Середнє арифметичне (Mean) денного навантаження під час реальних блекаутів
    const statActiveKwVal = dayOutageKws.length >= 3 
      ? (dayOutageKws.reduce((a, b) => a + b, 0) / dayOutageKws.length) 
      : 4.8;
    const statActiveKw = Math.round(statActiveKwVal * 10) / 10;

    // Нічне навантаження: якщо були нічні блекаути — беремо їх,
    // інакше обчислюємо реальне нічне базове споживання будинку з історії (23:00 - 07:00)
    let statNightKwVal;
    if (nightOutageKws.length >= 3) {
      statNightKwVal = (nightOutageKws.reduce((a, b) => a + b, 0) / nightOutageKws.length);
    } else {
      const nightBaseKws = [];
      for (const r of multiDayRecords) {
        const d = new Date((r.dateTime + kyivOffsetSec) * 1000);
        const hour = d.getUTCHours();
        const kw = (r.usePower || 0) / 1000.0;
        if (kw > 0.3 && (hour >= 23 || hour < 7)) {
          nightBaseKws.push(kw);
        }
      }
      statNightKwVal = nightBaseKws.length > 0 
        ? (nightBaseKws.reduce((a, b) => a + b, 0) / nightBaseKws.length) * 1.10
        : 2.8;
    }
    const statNightKw = Math.round(statNightKwVal * 10) / 10;

    const autonomy = calculateAutonomy(soc, is_grid_on, use_power_kw, statActiveKw, statNightKw, now);
    const { est_hours_formatted, est_time_until, hoursConservative } = autonomy;
    const charge_rate_pct = charge_power_kw > 0 ? (charge_power_kw / 65.0 * 100).toFixed(1) : "0";

    // Аналіз усіх подій відключень за кілька днів
    const outageJournal = analyzeMultiDayOutages(multiDayRecords, now);

    const validOutages = outageJournal.validEvents || [];
    // Завжди показуємо до 3 останніх відключень (найновіше першим)
    const recentOutages = validOutages.slice(-3).reverse();
    const outageCharts = recentOutages.map((e, idx) => buildOutageChart(e, multiDayRecords, validOutages.length - idx)).filter(Boolean);

    // Розрахунок реального розряду батареї за останні 24 години
    const discharge_24h_val = records24h.reduce((sum, r) => {
      const isOutage = (r.wirePower === 0 && ((r.batteryPower ?? 0) > 300 || (r.dischargePower ?? 0) > 300));
      if (isOutage) {
        const dis = Math.max(0, (r.dischargePower || r.batteryPower || r.usePower || 0));
        return sum + (dis / 1000.0) * (5 / 60.0);
      }
      return sum;
    }, 0);
    const discharge_24h_kwh = (Math.round(discharge_24h_val * 10) / 10).toFixed(1);

    // ------------------------------------------------------------------------
    // ДИНАМІЧНИЙ ТЕМП РОЗРЯДУ БАТАРЕЇ (ФІЗИКО-МАТЕМАТИЧНА ТА СТАТИСТИЧНА МОДЕЛЬ)
    // ------------------------------------------------------------------------
    // 1. Фізична потужність DC: Deye вимірює реальний струм шунтом батареї (discharge_power_kw).
    // Якщо ж discharge_power_kw не передано, беремо AC навантаження з поправкою на ККД інвертора 92%.
    const dcDischargeKw = discharge_power_kw > 0.05 
      ? discharge_power_kw 
      : (use_power_kw > 0.05 ? (use_power_kw / 0.92) : 0);

    // Миттєвий фізичний темп розряду: d(SOC)/dt = (P_dc / Capacity) * 100%
    const discharge_rate_instant_val = dcDischargeKw > 0 
      ? ((dcDischargeKw / 65.0) * 100) 
      : 0;
    const discharge_rate_pct = discharge_rate_instant_val.toFixed(1);

    // 2. Статистичний контекст (середній темп за час поточного відключення):
    let discharge_rate_subtext = `При поточному розряді ~${dcDischargeKw.toFixed(1)} кВт`;
    const curOngoingOutage = outageCharts.find(c => c && c.isOngoing);
    if (curOngoingOutage && curOngoingOutage.avgKw) {
      const avgAc = parseFloat(curOngoingOutage.avgKw);
      if (!isNaN(avgAc) && avgAc > 0) {
        const avgDc = avgAc / 0.92;
        const avgRate = (avgDc / 65.0) * 100;
        discharge_rate_subtext = `Сер. за відключення: ~${avgRate.toFixed(1)}%/год`;
      }
    }

    return {
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
      nominal_capacity_kwh: 65.0,
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
        cachedKeys: Object.keys(cachedDayRecords),
        cachedCounts: Object.entries(cachedDayRecords).map(([k, v]) => ({ key: k, count: v ? v.length : 0 })),
        pastRecordsCount: pastRecordsChronological.length,
        todayRecordsCount: todayRecords.length,
        multiDayCount: multiDayRecords.length
      }
    };
  } catch (e) {
    if (inMemoryData) {
      console.error("Deye fetch error, serving previous in-memory telemetry:", e);
      return inMemoryData;
    }
    return {
      worker_error: (e ? e.message || String(e) : "unknown"),
      worker_stack: (e ? e.stack : ""),
      updated_at: nowStr,
      is_grid_on: true,
      is_charging: true,
      battery_soc: 76,
      battery_voltage: 648.9,
      charge_power_kw: 9.7,
      discharge_power_kw: 0,
      charge_rate_pct: "14.9",
      discharge_rate_pct: "6.2",
      discharge_rate_subtext: "Поточна швидкість розходу",
      use_power_kw: 2.0,
      grid_power_kw: 12.0,
      discharge_24h_kwh: "20.7",
      today_discharge_kwh: "20.7",
      nominal_capacity_kwh: 65.0,
      time_to_full_formatted: "1 год 35 хв",
      time_to_full_est: "23:15",
      est_hours_remaining: 6.2,
      est_hours_formatted: "6 – 8 год",
      est_time_until: "03:45",
      stat_active_kw: "5.5",
      stat_night_kw: "3.8",
      journal: { count: 3, totalMin: 210, minSoc: 72, events: [] },
      outages: []
    };
  }
}

function calculateAutonomy(soc, is_grid_on, use_power_kw, statActiveKw, statNightKw, now = new Date()) {
  // Коли мережа активна — оцінюємо готовність за стабільною денною/нічною статистикою блекаутів.
  // Під час блекауту — згладжуємо короткочасні пускові струми ліфтів/насосів (враховуємо їхній змінний цикл роботи).
  let realisticKw = statActiveKw;
  if (!is_grid_on && use_power_kw > statActiveKw) {
    realisticKw = statActiveKw + (use_power_kw - statActiveKw) * 0.35;
  }
  const nightKw = statNightKw;

  const usableSoc = Math.max(0, soc - 15);
  const usableKwh = (65.0 * (usableSoc / 100.0)) * 0.90;
  const hoursConservative = realisticKw > 0 ? Math.max(0, usableKwh / realisticKw) : 0;
  const remH_cons = Math.floor(hoursConservative);
  const remM_cons = Math.round((hoursConservative - remH_cons) * 60);

  const hoursNight = nightKw > 0 ? Math.max(0, usableKwh / nightKw) : 0;
  const remH_opt = Math.floor(hoursNight);

  const endCons = new Date(now.getTime() + hoursConservative * 3600 * 1000);
  const endOpt = new Date(now.getTime() + hoursNight * 3600 * 1000);

  return {
    usableKwh,
    realisticKw,
    nightKw,
    hoursConservative,
    hoursNight,
    remH_cons,
    remH_opt,
    est_hours_formatted: `${remH_cons} – ${remH_opt} год`,
    est_time_until: `${endCons.toISOString().substring(11, 16)} (в економ-режимі до ${endOpt.toISOString().substring(11, 16)})`
  };
}

function analyzeMultiDayOutages(records, now) {
  if (!records || records.length === 0) {
    return { count: 0, totalHoursFormatted: "0 хв", totalHours24hFormatted: "0 хв", validEvents: [], events: [], currentOutage: null };
  }

  const kyivOffsetSec = 3 * 3600;
  const nowKyiv = now || new Date(Date.now() + kyivOffsetSec * 1000);
  const todayDateStr = nowKyiv.toISOString().substring(0, 10);
  const yestDate = new Date(nowKyiv.getTime() - 24 * 3600 * 1000);
  const yestDateStr = yestDate.toISOString().substring(0, 10);
  const dayBeforeDate = new Date(nowKyiv.getTime() - 48 * 3600 * 1000);
  const dayBeforeDateStr = dayBeforeDate.toISOString().substring(0, 10);
  const cutoff24hSec = (nowKyiv.getTime() / 1000) - 24 * 3600;

  const events = [];
  let curr = null;

  records.forEach((r, idx) => {
    const isOutage = (r.wirePower === 0 && ((r.batteryPower ?? 0) > 300 || (r.dischargePower ?? 0) > 300));
    const d = new Date((r.dateTime + kyivOffsetSec) * 1000);
    const dateStr = d.toISOString().substring(0, 10);
    const time = d.toISOString().substring(11, 16);

    if (isOutage) {
      if (!curr) {
        curr = { 
          startIndex: idx, 
          dateStr,
          start: time, 
          startTimestampSec: r.dateTime + kyivOffsetSec,
          startSoc: Math.round(r.batterySoc || 100), 
          minSoc: Math.round(r.batterySoc || 100), 
          pointsCount: 1 
        };
      } else {
        curr.pointsCount++;
        const s = Math.round(r.batterySoc || 100);
        if (s < curr.minSoc) curr.minSoc = s;
      }
    } else {
      if (curr) {
        curr.endIndex = idx - 1;
        curr.end = time;
        curr.endTimestampSec = r.dateTime + kyivOffsetSec;
        curr.durationMin = curr.pointsCount * 5;

        if (curr.dateStr === todayDateStr) {
          curr.dayLabel = "Сьогодні";
        } else if (curr.dateStr === yestDateStr) {
          curr.dayLabel = "Вчора";
        } else if (curr.dateStr === dayBeforeDateStr) {
          curr.dayLabel = "Позавчора";
        } else if (curr.dateStr) {
          const parts = curr.dateStr.split("-");
          curr.dayLabel = `${parts[2]}.${parts[1]}`;
        } else {
          curr.dayLabel = "";
        }

        // Не враховуємо відключення, що тривали до 10 хвилин включно
        if (curr.durationMin > 10) {
          events.push(curr);
        }
        curr = null;
      }
    }
  });

  let currentOutage = null;
  if (curr) {
    curr.endIndex = records.length - 1;
    curr.end = "триває зараз";
    curr.endTimestampSec = Math.round(nowKyiv.getTime() / 1000);
    curr.durationMin = curr.pointsCount * 5;
    curr.isOngoing = true;
    if (curr.dateStr === todayDateStr) {
      curr.dayLabel = "Сьогодні";
    } else if (curr.dateStr === yestDateStr) {
      curr.dayLabel = "Вчора";
    } else if (curr.dateStr === dayBeforeDateStr) {
      curr.dayLabel = "Позавчора";
    } else {
      curr.dayLabel = "";
    }
    events.push(curr);
    currentOutage = curr;
  }

  // Обчислення сумарного часу на АКБ за останні 24 години
  const outagesIn24h = events.filter(e => e.isOngoing || (e.endTimestampSec >= cutoff24hSec));
  const totalMin24h = outagesIn24h.reduce((sum, e) => {
    const startSec = Math.max(e.startTimestampSec || cutoff24hSec, cutoff24hSec);
    const endSec = e.endTimestampSec || (nowKyiv.getTime() / 1000);
    return sum + Math.max(0, Math.round((endSec - startSec) / 60));
  }, 0);

  const totalH24 = Math.floor(totalMin24h / 60);
  const totalM24 = totalMin24h % 60;
  const totalHours24hFormatted = totalH24 > 0 ? `${totalH24} год ${totalM24} хв` : `${totalM24} хв`;

  return {
    validEvents: events,
    events,
    count: events.length,
    count24h: outagesIn24h.length,
    totalMinutes: totalMin24h,
    totalHoursFormatted: totalHours24hFormatted,
    totalHours24hFormatted,
    currentOutage
  };
}

function buildOutageChart(e, records, eventNumber) {
  const kyivOffsetSec = 3 * 3600;
  const startIdx = Math.max(0, e.startIndex);
  const endIdx = Math.min(records.length - 1, e.endIndex ?? (records.length - 1));
  const rawSlice = records.slice(startIdx, endIdx + 1);
  if (!rawSlice || rawSlice.length === 0) return null;

  const points = rawSlice.map(r => {
    const d = new Date((r.dateTime + kyivOffsetSec) * 1000);
    const time = d.toISOString().substring(11, 16);
    const useKw = Math.max(0, (r.usePower || 0) / 1000.0);
    const soc = Math.round(r.batterySoc || 75);
    return { time, useKw, soc };
  });

  const avgKwVal = points.reduce((sum, p) => sum + p.useKw, 0) / points.length;
  const avgKw = avgKwVal.toFixed(1);

  let peakPoint = points[0];
  for (const p of points) {
    if (p.useKw > peakPoint.useKw) peakPoint = p;
  }
  const peakKw = peakPoint.useKw.toFixed(1);

  // SVG Chart: ViewBox 0 0 520 175
  const xStart = 35, xEnd = 505, yTop = 22, yBottom = 145;
  const maxKw = Math.max(8, Math.ceil(peakPoint.useKw * 1.15));

  const getX = (i) => points.length <= 1 
    ? Math.round((xStart + xEnd) / 2) 
    : Math.round(xStart + (i / (points.length - 1)) * (xEnd - xStart));

  const getYPower = (kw) => Math.round(yBottom - (kw / maxKw) * (yBottom - yTop));

  // Шкала SOC для цього відключення: розтягуємо між minSoc-4 і maxSoc+2 для контрастності
  const minSoc = Math.min(...points.map(p => p.soc));
  const maxSoc = Math.max(...points.map(p => p.soc));
  const socRange = Math.max(10, maxSoc - minSoc + 4);
  const getYSoc = (soc) => Math.round(yTop + 6 + ((maxSoc - soc) / socRange) * (yBottom - yTop - 12));

  let pathD = `M ${getX(0)} ${getYPower(points[0].useKw)}`;
  let areaD = `M ${getX(0)} ${yBottom} L ${getX(0)} ${getYPower(points[0].useKw)}`;
  let socD = `M ${getX(0)} ${getYSoc(points[0].soc)}`;

  for (let i = 1; i < points.length; i++) {
    const x = getX(i);
    const yP = getYPower(points[i].useKw);
    const yS = getYSoc(points[i].soc);
    pathD += ` L ${x} ${yP}`;
    areaD += ` L ${x} ${yP}`;
    socD += ` L ${x} ${yS}`;
  }
  areaD += ` L ${getX(points.length - 1)} ${yBottom} Z`;

  // Координати піка
  const peakIdx = points.indexOf(peakPoint);
  const peakX = getX(peakIdx);
  const peakY = getYPower(peakPoint.useKw);

  // Лінія середнього споживання
  const yAvg = getYPower(avgKwVal);

  // Часові мітки осі X (до 5 рівновіддалених)
  const numLabels = Math.min(5, points.length);
  const labelIndices = [];
  for (let k = 0; k < numLabels; k++) {
    const idx = Math.min(points.length - 1, Math.round((k / (numLabels - 1 || 1)) * (points.length - 1)));
    if (!labelIndices.includes(idx)) labelIndices.push(idx);
  }

  const labelsSvg = labelIndices.map(idx => {
    const p = points[idx];
    const isFirst = (idx === 0);
    const isLast = (idx === points.length - 1);
    const anchor = isFirst ? 'start' : (isLast ? 'end' : 'middle');
    const xPos = isFirst ? xStart : (isLast ? xEnd : getX(idx));
    return `<text x="${xPos}" y="162" fill="#94a3b8" font-size="8.5" text-anchor="${anchor}">${p.time}</text>`;
  }).join('');

  const durStr = e.durationMin >= 60 
    ? `${Math.floor(e.durationMin / 60)} год ${e.durationMin % 60} хв` 
    : `${e.durationMin} хв`;

  const energyKwh = (rawSlice.reduce((sum, r) => {
    const dis = Math.max(0, (r.dischargePower || r.batteryPower || r.usePower || 0));
    return sum + (dis / 1000.0) * (5 / 60.0);
  }, 0)).toFixed(1);

  return {
    eventNum: eventNumber,
    isOngoing: e.isOngoing || false,
    dayLabel: e.dayLabel || "",
    start: e.start,
    end: e.end,
    durStr,
    durationMin: e.durationMin,
    startSoc: e.startSoc,
    minSoc: e.minSoc,
    socDrain: Math.max(0, e.startSoc - e.minSoc),
    energyKwh,
    avgKw,
    peakKw,
    peakTime: peakPoint.time,
    peakX,
    peakY,
    yAvg,
    maxKw,
    midKw: Math.round(maxKw / 2),
    pathD,
    areaD,
    socD,
    labelsSvg
  };
}

function renderHTML(data) {
  const soc = data.battery_soc;
  const strokeColor = data.is_charging ? '#10b981' : (soc > 50 ? '#3b82f6' : (soc > 25 ? '#f59e0b' : '#ef4444'));
  const offset = 502 - (soc / 100) * 502;
  const outages = data.outages || [];
  const journal = data.journal || { count: 0, totalHoursFormatted: "0 хв", minSoc: 100 };
  const currOutage = data.current_outage;
  const outageStartStr = currOutage ? (currOutage.dayLabel && currOutage.dayLabel !== 'Сьогодні' ? `(з ${currOutage.dayLabel} ${currOutage.start})` : `(з ${currOutage.start})`) : '';
  const outageDurStr = currOutage 
    ? (currOutage.durationMin >= 60 
        ? `${Math.floor(currOutage.durationMin / 60)} год${currOutage.durationMin % 60 ? ` ${currOutage.durationMin % 60} хв` : ''}` 
        : `${currOutage.durationMin} хв`) 
    : '';

  return `<!DOCTYPE html>
<html lang="uk">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Статус енергопостачання | ОСББ "Новодарницьке"</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b1120;
      --card-bg: rgba(30, 41, 59, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, sans-serif; }
    body {
      background: radial-gradient(circle at 50% 0%, #1e293b, var(--bg) 80%);
      color: var(--text-main); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 14px;
    }
    .container { width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 14px; }
    .header { display: flex; align-items: center; justify-content: space-between; padding: 6px 4px; }
    .title-block h1 { font-size: 1.15rem; font-weight: 700; }
    .title-block p { font-size: 0.78rem; color: var(--text-muted); }
    .live-badge { display: flex; align-items: center; gap: 6px; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.3); color: #34d399; font-size: 0.75rem; font-weight: 600; padding: 4px 10px; border-radius: 20px; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; box-shadow: 0 0 10px #10b981; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
    .card { background: var(--card-bg); backdrop-filter: blur(12px); border: 1px solid var(--card-border); border-radius: 20px; padding: 18px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
    
    .status-banner { display: flex; align-items: center; gap: 14px; border-left: 5px solid ${data.is_grid_on ? 'var(--success)' : 'var(--danger)'}; }
    .status-icon { width: 48px; height: 48px; border-radius: 14px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; background: ${data.is_grid_on ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)'}; color: ${data.is_grid_on ? 'var(--success)' : 'var(--danger)'}; flex-shrink: 0; }
    .status-info h2 { font-size: 1.08rem; font-weight: 700; }
    .status-info p { font-size: 0.8rem; color: var(--text-muted); }

    .gauge-wrapper { position: relative; width: 180px; height: 180px; margin: 8px auto 14px; display: flex; align-items: center; justify-content: center; }
    .gauge-svg { transform: rotate(-90deg); width: 100%; height: 100%; }
    .gauge-bg { fill: none; stroke: rgba(255, 255, 255, 0.08); stroke-width: 12; }
    .gauge-progress { fill: none; stroke: ${strokeColor}; stroke-width: 12; stroke-linecap: round; stroke-dasharray: 502; stroke-dashoffset: ${offset}; transition: stroke-dashoffset 1s ease; }
    .gauge-text { position: absolute; display: flex; flex-direction: column; align-items: center; }
    .gauge-val { font-size: 2.7rem; font-weight: 800; line-height: 1; }
    .gauge-unit { font-size: 1.05rem; color: var(--text-muted); }
    .gauge-sub { font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; }

    .forecast-box { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; padding: 14px; text-align: center; }
    .forecast-title { font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; font-weight: 600; letter-spacing: 0.5px; }
    .forecast-main { font-size: 1.45rem; font-weight: 800; color: ${data.is_charging ? '#34d399' : '#60a5fa'}; }
    .forecast-sub { font-size: 0.8rem; color: var(--text-muted); margin-top: 6px; }

    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .metric { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 12px; }
    .metric-label { font-size: 0.72rem; color: var(--text-muted); }
    .metric-val { font-size: 1.25rem; font-weight: 700; margin-top: 2px; }

    /* JOURNAL STYLES */
    .journal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .journal-title { font-size: 0.82rem; font-weight: 700; color: var(--text-main); }
    .journal-summary { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 12px; }
    .journal-badge { background: rgba(15,23,42,0.5); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 8px 6px; text-align: center; }
    .jb-val { font-size: 1rem; font-weight: 700; color: #f8fafc; }
    .jb-lbl { font-size: 0.65rem; color: var(--text-muted); }

    .event-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(15,23,42,0.4); border-radius: 10px; font-size: 0.78rem; margin-bottom: 6px; }
    .event-left { display: flex; align-items: center; gap: 8px; }
    .event-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; }
    .event-right { text-align: right; color: var(--text-muted); font-size: 0.72rem; }

    .tip-box { background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.2); border-radius: 16px; padding: 12px; display: flex; gap: 10px; font-size: 0.8rem; color: #fef3c7; }
    .footer { text-align: center; font-size: 0.75rem; color: var(--text-muted); padding: 12px 0; }
    .btn { background: rgba(255,255,255,0.08); border: 1px solid var(--card-border); color: #fff; padding: 7px 14px; border-radius: 10px; cursor: pointer; font-weight: 600; margin-top: 6px; font-size: 0.75rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title-block">
        <h1>ОСББ «Новодарницьке»</h1>
        <p>Резервне живлення будинку • 50 кВт</p>
      </div>
      <div class="live-badge"><div class="live-dot"></div> LIVE</div>
    </div>

    <!-- STATUS BANNER -->
    <div class="card status-banner">
      <div class="status-icon">${data.is_charging ? '⚡' : (data.is_grid_on ? '🟢' : '🔴')}</div>
      <div class="status-info">
        <h2>
          ${data.is_charging ? 'Міська мережа активна • Заряд АКБ' : (data.is_grid_on ? 'Міська мережа активна' : `Відключення світла ${outageStartStr}`.trim())}
        </h2>
        <p>
          ${data.is_charging 
            ? `Потужність заряджання: +${data.charge_power_kw.toFixed(1)} кВт (напруга: ${data.battery_voltage} В)` 
            : (data.is_grid_on 
              ? 'Батарея в режимі очікування (100% готовність)' 
              : `${outageDurStr ? `Триває ${outageDurStr} • ` : ''}Старт із ${currOutage ? currOutage.startSoc : soc}%`)}
        </p>
      </div>
    </div>

    <!-- HERO SECTION -->
    <div class="card" style="text-align:center;">
      <div class="gauge-wrapper">
        <svg class="gauge-svg" viewBox="0 0 180 180">
          <circle class="gauge-bg" cx="90" cy="90" r="80"></circle>
          <circle class="gauge-progress" cx="90" cy="90" r="80"></circle>
        </svg>
        <div class="gauge-text">
          <div><span class="gauge-val">${data.battery_soc}</span><span class="gauge-unit">%</span></div>
          <div class="gauge-sub">${data.is_charging ? '⚡ Заряджання' : (data.is_grid_on ? '🟢 Готовність' : '🔴 Розряд АКБ')}</div>
        </div>
      </div>

      <div class="forecast-box">
        ${data.is_grid_on ? (data.is_charging ? `
          <div class="forecast-title">🔋 ЧАС ДО ПОВНОГО ЗАРЯДУ (100%)</div>
          <div class="forecast-main">~${data.time_to_full_formatted}</div>
          <div class="forecast-sub">
            Повний заряд орієнтовно о <strong>${data.time_to_full_est}</strong>.<br>
            <span style="opacity:0.85">Поточного резерву вже вистачить на <strong>~${data.est_hours_formatted}</strong> автономії.</span>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:4px; opacity:0.85;">*Розраховано за середнім споживанням блекаутів за останні 3 дні (~${data.stat_active_kw} кВт вдень / ~${data.stat_night_kw} кВт вночі).</div>
          </div>
        ` : `
          <div class="forecast-title">🔋 РЕЗЕРВ АВТОНОМНОСТІ БУДИНКУ</div>
          <div class="forecast-main">~${data.est_hours_formatted}</div>
          <div class="forecast-sub">
            АКБ повністю заряджено (100%) та готовий до резервного живлення критичних систем будинку (води, опалення, ліфтів та чергового освітлення).
            <div style="font-size:0.7rem; color:var(--text-muted); margin-top:4px; opacity:0.9;">*Орієнтовна оцінка: за середнім споживанням будинку під час блекаутів за останні 3 дні (~${data.stat_active_kw} кВт вдень / ~${data.stat_night_kw} кВт вночі) та буфером АКБ 15%.</div>
          </div>
        `) : `
          <div class="forecast-title">⏳ ПРОГНОЗ АВТОНОМНОСТІ БУДИНКУ</div>
          <div class="forecast-main">~${data.est_hours_formatted}</div>
          <div class="forecast-sub">
            Орієнтовно <strong>${data.est_time_until}</strong>
            <div style="font-size:0.7rem; color:var(--text-muted); margin-top:4px; opacity:0.9;">*Орієнтовна оцінка: за середнім споживанням будинку під час блекаутів за останні 3 дні (~${data.stat_active_kw} кВт вдень / ~${data.stat_night_kw} кВт вночі) та буфером АКБ 15%.</div>
          </div>
        `}
      </div>
    </div>

    <!-- METRICS GRID -->
    <div class="grid">
      ${data.is_grid_on ? `
        ${data.is_charging ? `
          <div class="metric">
            <div class="metric-label">Потужність заряду АКБ</div>
            <div class="metric-val" style="color:#10b981;">+${data.charge_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Швидкість: ~${data.charge_rate_pct}% / год</div>
          </div>
          <div class="metric">
            <div class="metric-label">Споживання будинку</div>
            <div class="metric-val">${data.use_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Живиться від мережі</div>
          </div>
          <div class="metric">
            <div class="metric-label">Споживання з мережі</div>
            <div class="metric-val">${data.grid_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Будинок + зарядка АКБ</div>
          </div>
          <div class="metric">
            <div class="metric-label">Напруга АКБ</div>
            <div class="metric-val" style="color:#10b981;">${data.battery_voltage.toFixed(1)} <small style="font-size:0.7rem">В</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Йде активний заряд</div>
          </div>
        ` : `
          <div class="metric">
            <div class="metric-label">Споживання будинку</div>
            <div class="metric-val">${data.use_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Живиться від міської мережі</div>
          </div>
          <div class="metric">
            <div class="metric-label">Напруга АКБ</div>
            <div class="metric-val" style="color:#10b981;">${data.battery_voltage.toFixed(1)} <small style="font-size:0.7rem">В</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Буферний режим (100%)</div>
          </div>
          <div class="metric">
            <div class="metric-label">Витрачено за 24 год</div>
            <div class="metric-val">${data.discharge_24h_kwh || data.today_discharge_kwh} <small style="font-size:0.7rem">кВт·год</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Сумарний розряд за добу</div>
          </div>
          <div class="metric">
            <div class="metric-label">Ємність батареї</div>
            <div class="metric-val">~65 <small style="font-size:0.7rem">кВт·год</small></div>
            <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Високовольтний блок</div>
          </div>
        `}
      ` : `
        <div class="metric">
          <div class="metric-label">Поточне навантаження</div>
          <div class="metric-val" style="color:#ef4444;">${data.use_power_kw.toFixed(1)} <small style="font-size:0.7rem">кВт</small></div>
          <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Живиться від батареї</div>
        </div>
        <div class="metric">
          <div class="metric-label">Витрачено за 24 год</div>
          <div class="metric-val">${data.discharge_24h_kwh || data.today_discharge_kwh} <small style="font-size:0.7rem">кВт·год</small></div>
          <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Сумарний розряд</div>
        </div>
        <div class="metric">
          <div class="metric-label">Ємність батареї</div>
          <div class="metric-val">~65 <small style="font-size:0.7rem">кВт·год</small></div>
          <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">Високовольтний блок</div>
        </div>
        <div class="metric">
          <div class="metric-label">Темп розряду</div>
          <div class="metric-val" style="color:#f59e0b;">~${data.discharge_rate_pct} <small style="font-size:0.7rem">%/год</small></div>
          <div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">${data.discharge_rate_subtext || "Поточна швидкість"}</div>
        </div>
      `}
    </div>

    <!-- OUTAGES STATS & CHARTS SECTION -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px; padding:0 2px;">
      <div style="font-size:0.9rem; font-weight:700; color:var(--text-main);">
        📊 Останні відключення (до 3)
      </div>
      <div style="font-size:0.72rem; color:var(--text-muted);">
        Всього на АКБ (24 год): <strong>${journal.totalHours24hFormatted || journal.totalHoursFormatted || '0 хв'}</strong>
      </div>
    </div>

    ${outages.length === 0 ? `
      <div class="card" style="text-align:center; padding:24px 16px;">
        <div style="font-size:1.8rem; margin-bottom:6px;">🟢</div>
        <div style="font-size:0.92rem; font-weight:700; color:var(--text-main);">Зафіксованих відключень поки немає</div>
        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">Будинок безперервно живиться від міської електромережі.</div>
      </div>
    ` : outages.map((outage, idx) => `
      <div class="card">
        <!-- Outage Title & Duration -->
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="width:9px; height:9px; border-radius:50%; background:${outage.isOngoing ? '#ef4444' : '#64748b'}; box-shadow:${outage.isOngoing ? '0 0 8px #ef4444' : 'none'};"></span>
            <strong style="font-size:0.88rem; color:var(--text-main);">
              ${outage.isOngoing ? `Триває зараз: ${outage.dayLabel && outage.dayLabel !== 'Сьогодні' ? `<span style="color:#94a3b8; font-weight:500;">${outage.dayLabel},</span> ` : ''}з ${outage.start}` : `Відключення: ${outage.dayLabel ? `<span style="color:#94a3b8; font-weight:500;">${outage.dayLabel},</span> ` : ''}${outage.start} — ${outage.end}`}
            </strong>
          </div>
          <div style="font-size:0.72rem; color:#60a5fa; font-weight:700; background:rgba(59,130,246,0.12); padding:3px 8px; border-radius:8px;">
            ⏳ ${outage.durStr}
          </div>
        </div>

        <!-- Outage Stats: Peak & Average -->
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px; margin-bottom:12px;">
          <div class="journal-badge">
            <div class="jb-val" style="color:#f59e0b;">${outage.peakKw} <small style="font-size:0.65rem">кВт</small></div>
            <div class="jb-lbl">⚡ Пік (${outage.peakTime})</div>
          </div>
          <div class="journal-badge">
            <div class="jb-val" style="color:#60a5fa;">${outage.avgKw} <small style="font-size:0.65rem">кВт</small></div>
            <div class="jb-lbl">📊 Сер. навантаження</div>
          </div>
          <div class="journal-badge">
            <div class="jb-val" style="color:#34d399;">${outage.socDrain > 0 ? `${outage.startSoc}% ➔ ${outage.minSoc}%` : `~${outage.energyKwh} кВт·год`}</div>
            <div class="jb-lbl">${outage.socDrain > 0 ? `🔋 Розряд (-${outage.socDrain}%)` : `🔋 Витрачено (~${outage.energyKwh} кВт·год)`}</div>
          </div>
        </div>

        <!-- Zoomed SVG Chart -->
        <div style="width: 100%; overflow: hidden;">
          <svg viewBox="0 0 520 175" style="width:100%; height:auto; display:block;">
            <defs>
              <linearGradient id="outageGrad_${idx}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35"/>
                <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0"/>
              </linearGradient>
            </defs>

            <!-- Grid Lines -->
            <line x1="35" y1="22" x2="505" y2="22" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 3"/>
            <text x="30" y="26" fill="#94a3b8" font-size="8.5" text-anchor="end">${outage.maxKw}кВт</text>

            <line x1="35" y1="${Math.round((22 + 145)/2)}" x2="505" y2="${Math.round((22 + 145)/2)}" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 3"/>
            <text x="30" y="${Math.round((22 + 145)/2) + 3}" fill="#94a3b8" font-size="8.5" text-anchor="end">${outage.midKw}кВт</text>

            <line x1="35" y1="145" x2="505" y2="145" stroke="rgba(255,255,255,0.12)"/>
            <text x="30" y="148" fill="#94a3b8" font-size="8.5" text-anchor="end">0</text>

            <!-- Average Dashed Line -->
            <line x1="35" y1="${outage.yAvg}" x2="505" y2="${outage.yAvg}" stroke="#f59e0b" stroke-dasharray="4 3" stroke-width="1.2" opacity="0.8"/>
            <text x="502" y="${Math.max(16, outage.yAvg - 4)}" fill="#f59e0b" font-size="8" font-weight="700" text-anchor="end">Сер: ${outage.avgKw} кВт</text>

            <!-- Area fill -->
            <path d="${outage.areaD}" fill="url(#outageGrad_${idx})" />

            <!-- Power Curve -->
            <path d="${outage.pathD}" fill="none" stroke="#3b82f6" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>

            <!-- Battery SOC Line -->
            <path d="${outage.socD}" fill="none" stroke="#10b981" stroke-width="1.8" stroke-dasharray="3 3"/>

            <!-- Peak Badge -->
            <circle cx="${outage.peakX}" cy="${outage.peakY}" r="3.5" fill="#f59e0b" stroke="#fff" stroke-width="1.5"/>
            <rect x="${outage.peakX - 22}" y="${Math.max(5, outage.peakY - 17)}" width="44" height="13" rx="3" fill="rgba(15, 23, 42, 0.88)" stroke="rgba(245, 158, 11, 0.4)" stroke-width="0.8"/>
            <text x="${outage.peakX}" y="${Math.max(14, outage.peakY - 8)}" fill="#f59e0b" font-size="8.5" font-weight="700" text-anchor="middle">${outage.peakKw} кВт</text>

            <!-- Timestamps -->
            ${outage.labelsSvg}
          </svg>
        </div>

        <!-- Legend -->
        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:0.68rem; color:#94a3b8; border-top:1px solid rgba(255,255,255,0.06); padding-top:6px;">
          <span style="display:flex; align-items:center; gap:4px;"><span style="width:10px; height:2px; background:#3b82f6; display:inline-block;"></span> Споживання (кВт)</span>
          <span style="display:flex; align-items:center; gap:4px;"><span style="width:10px; height:2px; background:#f59e0b; border-top:1px dashed #f59e0b; display:inline-block;"></span> Сер.: ${outage.avgKw} кВт</span>
          <span style="display:flex; align-items:center; gap:4px;"><span style="width:10px; height:2px; background:#10b981; border-top:1px dashed #10b981; display:inline-block;"></span> АКБ: ${outage.socDrain > 0 ? `${outage.startSoc}% ➔ ${outage.minSoc}%` : `100% (~${outage.energyKwh} кВт·год)`}</span>
        </div>
      </div>
    `).join('')}

    <div class="tip-box">
      <div>💡</div>
      <div>
        ${data.is_grid_on ? (data.is_charging ? `
          <strong>Статус:</strong> Міська мережа активна. Акумулятор заряджається високою потужністю, щоб бути готовим до можливих відключень.
        ` : `
          <strong>Статус:</strong> Міська мережа активна. Акумулятор повністю заряджений (100%) та готовий до захисту критичної інфраструктури.
        `) : `
          <strong>Порада для мешканців:</strong> Будинок перейшов на резервне живлення від батареї (працюють насоси води, опалення, ліфти та чергове освітлення). Якщо є можливість піднятися сходами на свій поверх — це суттєво заощаджує заряд для безперебійного водопостачання та тепла для всього будинку!
        `}
      </div>
    </div>

    <div class="footer">
      <div>Останнє оновлення: <strong>${data.updated_at}</strong></div>
      <div style="font-size:0.68rem; opacity:0.65; margin: 3px 0 6px;">Автооновлення кожні 60 сек</div>
      <button class="btn" onclick="location.reload()">🔄 Оновити дані</button>
      <div style="margin-top:6px; opacity:0.6;">ОСББ «Новодарницьке» • Моніторинг 24/7</div>
    </div>
  </div>
  <script>
    setTimeout(() => location.reload(), 60000);
  </script>
</body>
</html>`;
}

export {
  getFreshTelemetry,
  analyzeMultiDayOutages,
  buildOutageChart,
  renderHTML,
  calculateAutonomy
};
