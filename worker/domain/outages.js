import { CONFIG } from '../config.js';
import { isOutageRecord } from './autonomy.js';

/**
 * Аналіз багатоденного журналу відключень (фільтрація шуму <= 10 хв, підрахунок тривалості та агрегація).
 */
export function analyzeMultiDayOutages(records, now, config = CONFIG) {
  if (!records || records.length === 0) {
    return {
      count: 0,
      count24h: 0,
      totalMinutes: 0,
      totalHoursFormatted: "0 хв",
      totalHours24hFormatted: "0 хв",
      validEvents: [],
      events: [],
      currentOutage: null
    };
  }

  const kyivOffsetSec = config.TIME.KYIV_OFFSET_SEC;
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
    const isOutage = isOutageRecord(r, config);
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

        // Не враховуємо мікро-відключення, що тривали до 10 хвилин включно
        if (curr.durationMin > config.THRESHOLDS.MIN_OUTAGE_MINUTES) {
          events.push(curr);
        }
        curr = null;
      }
    }
  });

  let currentOutage = null;
  if (curr) {
    curr.endIndex = records.length - 1;
    curr.end = "зараз";
    curr.endTimestampSec = Math.floor(nowKyiv.getTime() / 1000);
    curr.durationMin = curr.pointsCount * 5;
    curr.dayLabel = (curr.dateStr === todayDateStr) ? "Сьогодні" : curr.dateStr;
    curr.isOngoing = true;

    if (curr.durationMin > config.THRESHOLDS.MIN_OUTAGE_MINUTES) {
      events.push(curr);
      currentOutage = curr;
    } else {
      currentOutage = curr;
    }
  }

  // Розрахунок загального часу відключень у ковзному вікні останніх 24 годин
  const outagesIn24h = events.filter(e => {
    const endSec = e.endTimestampSec || (e.startTimestampSec + e.durationMin * 60);
    return endSec >= cutoff24hSec;
  });

  const totalMin24h = outagesIn24h.reduce((sum, e) => {
    const startSec = Math.max(cutoff24hSec, e.startTimestampSec);
    const endSec = e.endTimestampSec || (e.startTimestampSec + e.durationMin * 60);
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

/**
 * Розрахунок середнього денного та нічного навантаження будинку за історією відключень.
 */
export function calculateOutageStatistics(multiDayRecords = [], config = CONFIG) {
  const kyivOffsetSec = config.TIME.KYIV_OFFSET_SEC;
  const { DEFAULT_ACTIVE_KW, DEFAULT_NIGHT_KW, NIGHT_HOUR_START, NIGHT_HOUR_END } = config.THRESHOLDS;

  const outagePoints = multiDayRecords.filter(r => isOutageRecord(r, config));

  const dayOutageKws = [];
  const nightOutageKws = [];

  for (const r of outagePoints) {
    const d = new Date((r.dateTime + kyivOffsetSec) * 1000);
    const hour = d.getUTCHours();
    const kw = Math.max(0, (r.usePower || r.dischargePower || r.batteryPower || 0) / 1000.0);
    if (hour >= NIGHT_HOUR_START || hour < NIGHT_HOUR_END) {
      nightOutageKws.push(kw);
    } else {
      dayOutageKws.push(kw);
    }
  }

  // Денне навантаження під час реальних блекаутів
  const statActiveKwVal = dayOutageKws.length >= 3 
    ? (dayOutageKws.reduce((a, b) => a + b, 0) / dayOutageKws.length) 
    : DEFAULT_ACTIVE_KW;
  const statActiveKw = Math.round(statActiveKwVal * 10) / 10;

  // Нічне навантаження (якщо блекаутів вночі не було — беремо нічне базове споживання будинку)
  let statNightKwVal;
  if (nightOutageKws.length >= 3) {
    statNightKwVal = (nightOutageKws.reduce((a, b) => a + b, 0) / nightOutageKws.length);
  } else {
    const nightBaseKws = [];
    for (const r of multiDayRecords) {
      const d = new Date((r.dateTime + kyivOffsetSec) * 1000);
      const hour = d.getUTCHours();
      const kw = (r.usePower || 0) / 1000.0;
      if (kw > 0.3 && (hour >= NIGHT_HOUR_START || hour < NIGHT_HOUR_END)) {
        nightBaseKws.push(kw);
      }
    }
    statNightKwVal = nightBaseKws.length > 0 
      ? (nightBaseKws.reduce((a, b) => a + b, 0) / nightBaseKws.length) * 1.10
      : DEFAULT_NIGHT_KW;
  }
  const statNightKw = Math.round(statNightKwVal * 10) / 10;

  return {
    statActiveKw,
    statNightKw
  };
}
