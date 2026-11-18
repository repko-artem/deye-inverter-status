import { CONFIG } from '../config.js';
import { isOutageRecord } from './autonomy.js';
import { 
  nowUtcSec, 
  formatKyivTime, 
  formatKyivDate, 
  getKyivHour, 
  formatKyivDayLabel, 
  getKyivOffsetSec 
} from './time.js';

/**
 * Форматування тривалості у хвилинах українською ("2 год 15 хв" або "20 хв").
 * @param {number} totalMinutes
 * @returns {string}
 */
export function formatDurationUk(totalMinutes) {
  const mins = Math.max(0, Math.round(totalMinutes || 0));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h} год ${m} хв` : `${m} хв`;
}

/**
 * Типи подій живлення
 */
export const OutageType = Object.freeze({
  BLACKOUT: 'BLACKOUT',
  VOLTAGE_SAG: 'VOLTAGE_SAG'
});

/**
 * Допоміжна функція для накопичення статистики вхідної напруги мережі під час події відключення.
 */
function createEmptyPhaseStats() {
  return {
    L1: { min: null, max: null, sum: 0, count: 0, avg: null },
    L2: { min: null, max: null, sum: 0, count: 0, avg: null },
    L3: { min: null, max: null, sum: 0, count: 0, avg: null }
  };
}

function updateEventVoltageStats(curr, record, isPreTrigger = false) {
  if (!record || typeof record.v1 !== 'number' || typeof record.v2 !== 'number' || typeof record.v3 !== 'number') {
    return;
  }
  const maxV = Math.max(record.v1, record.v2, record.v3);
  if (!isPreTrigger) {
    curr.voltageSampleCount = (curr.voltageSampleCount || 0) + 1;
    curr.lastGridVoltages = { l1: record.v1, l2: record.v2, l3: record.v3 };
    if (maxV < 50) {
      curr.zeroVoltageTicks = (curr.zeroVoltageTicks || 0) + 1;
      return;
    }
  }
  if (maxV < 50) return;

  const phases = [
    ['L1', record.v1],
    ['L2', record.v2],
    ['L3', record.v3]
  ];

  if (isPreTrigger) {
    const pt = curr._preTriggerStats || (curr._preTriggerStats = {
      minGridV: null,
      minPhase: null,
      maxGridV: null,
      maxPhase: null,
      phaseStats: createEmptyPhaseStats()
    });
    for (const [phase, val] of phases) {
      if (val < 50) continue;
      const ps = pt.phaseStats[phase];
      ps.sum += val;
      ps.count += 1;
      if (ps.max === null || val > ps.max) ps.max = val;
      if (ps.min === null || val < ps.min) ps.min = val;
      ps.avg = Math.round((ps.sum / ps.count) * 10) / 10;

      if (pt.maxGridV === null || val > pt.maxGridV) {
        pt.maxGridV = val;
        pt.maxPhase = phase;
      }
      if (pt.minGridV === null || val < pt.minGridV) {
        pt.minGridV = val;
        pt.minPhase = phase;
      }
    }
    return;
  }

  const phaseStats = curr.phaseStats || (curr.phaseStats = createEmptyPhaseStats());
  for (const [phase, val] of phases) {
    if (val < 50) continue;
    const ps = phaseStats[phase];
    ps.sum += val;
    ps.count += 1;
    if (ps.max === null || val > ps.max) ps.max = val;
    if (ps.min === null || val < ps.min) ps.min = val;
    ps.avg = Math.round((ps.sum / ps.count) * 10) / 10;

    curr.voltageValueCount = (curr.voltageValueCount || 0) + 1;
    if (curr.maxGridV === null || val > curr.maxGridV) {
      curr.maxGridV = val;
      curr.maxPhase = phase;
    }
    if (curr.minGridV === null || val < curr.minGridV) {
      curr.minGridV = val;
      curr.minPhase = phase;
    }
  }
}

function finalizeEventVoltageStats(curr, config = CONFIG) {
  if (!curr) return;
  const pt = curr._preTriggerStats;
  if (pt) {
    if ((curr.voltageValueCount || 0) === 0) {
      curr.minGridV = pt.minGridV;
      curr.minPhase = pt.minPhase;
      curr.maxGridV = pt.maxGridV;
      curr.maxPhase = pt.maxPhase;
      curr.phaseStats = pt.phaseStats;
    } else {
      const { lowReconnect, highReconnect } = getGridVoltageBounds(config);
      if (pt.maxGridV !== null && pt.maxGridV >= highReconnect && (curr.maxGridV === null || pt.maxGridV > curr.maxGridV)) {
        curr.maxGridV = pt.maxGridV;
        curr.maxPhase = pt.maxPhase;
        const ps = curr.phaseStats?.[pt.maxPhase];
        if (ps && (ps.max === null || pt.maxGridV > ps.max)) {
          ps.max = pt.maxGridV;
        }
      }
      if (pt.minGridV !== null && pt.minGridV < lowReconnect && (curr.minGridV === null || pt.minGridV < curr.minGridV)) {
        curr.minGridV = pt.minGridV;
        curr.minPhase = pt.minPhase;
        const ps = curr.phaseStats?.[pt.minPhase];
        if (ps && (ps.min === null || pt.minGridV < ps.min)) {
          ps.min = pt.minGridV;
        }
      }
    }
  }
  delete curr._preTriggerStats;
  delete curr.voltageValueCount;
}

function resolveProblemPhaseMetrics(curr) {
  if (!curr) return;
  let problemPhase = null;
  let extremeType = null;

  if (curr.voltageCause === 'OVERVOLTAGE') {
    problemPhase = curr.maxPhase;
    extremeType = 'MAX';
  } else if (curr.voltageCause === 'UNDERVOLTAGE') {
    problemPhase = curr.minPhase;
    extremeType = 'MIN';
  } else if (curr.maxGridV !== null && curr.minGridV !== null) {
    const isHighSide = Math.abs(curr.maxGridV - 230) >= Math.abs(230 - curr.minGridV);
    problemPhase = isHighSide ? curr.maxPhase : curr.minPhase;
    extremeType = isHighSide ? 'MAX' : 'MIN';
  }

  const ps = problemPhase && curr.phaseStats ? curr.phaseStats[problemPhase] : null;
  curr.problemPhase = problemPhase || null;
  curr.extremeType = extremeType || null;
  curr.avgGridV = ps ? ps.avg : null;
  curr.extremeGridV = ps
    ? (extremeType === 'MIN' ? ps.min : ps.max)
    : (extremeType === 'MIN' ? curr.minGridV : (extremeType === 'MAX' ? curr.maxGridV : null));
  delete curr.phaseStats;
}

function computeSliceVoltageStats(rawSlice, voltageCause = null) {
  const acc = {
    minGridV: null,
    minPhase: null,
    maxGridV: null,
    maxPhase: null,
    voltageCause,
    problemPhase: null,
    extremeType: null,
    avgGridV: null,
    extremeGridV: null
  };
  for (const r of rawSlice) {
    updateEventVoltageStats(acc, r, false);
  }
  finalizeEventVoltageStats(acc);
  resolveProblemPhaseMetrics(acc);
  delete acc.voltageSampleCount;
  delete acc.zeroVoltageTicks;
  delete acc.lastGridVoltages;
  return acc;
}

/**
 * Пороги напруги мережі з конфігурації (Single Source of Truth).
 */
function getGridVoltageBounds(config = CONFIG) {
  const t = config?.THRESHOLDS || CONFIG.THRESHOLDS;
  return {
    lv1: t.GRID_LV1_V ?? 192,
    lowReconnect: t.GRID_RECONNECT_LOW_V ?? 200,
    highReconnect: t.GRID_RECONNECT_HIGH_V ?? 250,
    hv1: t.GRID_HV1_V ?? 255
  };
}

/**
 * Класифікує подію відключення за характером (блекаут ДТЕК 0 В vs просідання < LV1 vs перенапруга > HV1).
 */
export function classifyOutageEvent(event, config = CONFIG) {
  const maxSagMin = config.THRESHOLDS?.VOLTAGE_SAG_MAX_MINUTES ?? 25;
  const maxSagSoc = config.THRESHOLDS?.VOLTAGE_SAG_MAX_SOC_DRAIN ?? 3;
  const { lv1, lowReconnect, highReconnect, hv1 } = getGridVoltageBounds(config);

  const durationMin = event.durationMin || 0;
  const socDrain = event.socDrain ?? Math.max(0, (event.startSoc || 0) - (event.minSoc || 0));

  // 1. Точна класифікація за трифазною вхідною напругою мережі (якщо є дані в події або на старті)
  if ((event.voltageSampleCount || 0) > 0 || event.maxGridV !== null || event.minGridV !== null) {
    if ((event.zeroVoltageTicks || 0) > 0) {
      return {
        type: OutageType.BLACKOUT,
        voltageCause: 'BLACKOUT',
        label: '🔴 Відключення ДТЕК (0 В)',
        badgeColor: '#ef4444',
        badgeBg: 'rgba(239, 68, 68, 0.15)',
        description: 'Повне зникнення напруги в міській мережі ДТЕК (0 В).'
      };
    }

    if (event.maxGridV !== null && event.maxGridV >= highReconnect && (event.maxGridV >= hv1 - 2 || event.minGridV === null || event.minGridV >= lowReconnect)) {
      return {
        type: OutageType.VOLTAGE_SAG,
        voltageCause: 'OVERVOLTAGE',
        label: `📈 Завищена напруга (${event.maxPhase}: ${Math.round(event.maxGridV)} В)`,
        badgeColor: '#f59e0b',
        badgeBg: 'rgba(245, 158, 11, 0.15)',
        description: `Захисне відсікання мережі інвертором через перенапругу (${event.maxPhase} до ${event.maxGridV.toFixed(1)} В, поріг HV1 ${hv1} В / повернення < ${highReconnect} В).`
      };
    }

    if (event.minGridV !== null && event.minGridV < lowReconnect) {
      return {
        type: OutageType.VOLTAGE_SAG,
        voltageCause: 'UNDERVOLTAGE',
        label: `📉 Занижена напруга (${event.minPhase}: ${Math.round(event.minGridV)} В)`,
        badgeColor: '#f59e0b',
        badgeBg: 'rgba(245, 158, 11, 0.15)',
        description: `Захисне відсікання мережі інвертором через просідання напруги (${event.minPhase} до ${event.minGridV.toFixed(1)} В, поріг LV1 ${lv1} В / повернення > ${lowReconnect} В).`
      };
    }
  }

  // 2. Фолбек-евристика за тривалістю та розрядом (коли телеметрія напруги відсутня)
  if (durationMin <= maxSagMin && socDrain <= maxSagSoc) {
    return {
      type: OutageType.VOLTAGE_SAG,
      voltageCause: 'VOLTAGE_SAG',
      label: '⚡ Стрибок напруги',
      badgeColor: '#f59e0b',
      badgeBg: 'rgba(245, 158, 11, 0.15)',
      description: `Короткочасне відсікання міської мережі захистом інвертора (напруга поза межами ${lv1}–${hv1} В). Запобігло аварійному блокуванню ліфтів.`
    };
  }

  return {
    type: OutageType.BLACKOUT,
    voltageCause: 'BLACKOUT',
    label: '🔴 Відключення ДТЕК',
    badgeColor: '#ef4444',
    badgeBg: 'rgba(239, 68, 68, 0.15)',
    description: 'Планове або аварійне відключення міської електромережі ДТЕК.'
  };
}

/**
 * Підмішує найсвіжіші поточні напруги пристрою у триваючу подію (навіть до появи чергового 5-хв бару).
 */
function applyLiveGridVoltages(curr, liveGridVoltages) {
  if (!curr || !liveGridVoltages) return;
  const { l1, l2, l3, ts } = liveGridVoltages;
  if (typeof l1 !== 'number' || typeof l2 !== 'number' || typeof l3 !== 'number') return;
  if (typeof ts === 'number' && ts < curr.startTimestampSec - 300) return;

  const isPreTrigger = typeof ts === 'number' && ts < curr.startTimestampSec;
  updateEventVoltageStats(curr, { v1: l1, v2: l2, v3: l3 }, isPreTrigger);
}

/**
 * Обирає фазу з найбільшим відхиленням від номіналу 230 В для компактного бейджа перевірки.
 */
function formatNominalPhaseHint(curr) {
  if (curr.maxGridV !== null && curr.minGridV !== null) {
    const overDist = Math.abs(curr.maxGridV - 230);
    const underDist = Math.abs(230 - curr.minGridV);
    if (overDist >= underDist && curr.maxPhase) {
      return `${curr.maxPhase}: ${Math.round(curr.maxGridV)} В`;
    }
    if (curr.minPhase) {
      return `${curr.minPhase}: ${Math.round(curr.minGridV)} В`;
    }
  }
  if (curr.lastGridVoltages) {
    const { l1, l2, l3 } = curr.lastGridVoltages;
    const phases = [['L1', l1], ['L2', l2], ['L3', l3]].filter(([, v]) => typeof v === 'number');
    if (phases.length > 0) {
      phases.sort((a, b) => Math.abs(b[1] - 230) - Math.abs(a[1] - 230));
      return `${phases[0][0]}: ${Math.round(phases[0][1])} В`;
    }
  }
  return null;
}

/**
 * Аналіз багатоденного журналу відключень (фільтрація шуму <= 10 хв, підрахунок тривалості та агрегація).
 */
export function analyzeMultiDayOutages(records, now, config = CONFIG, options = {}) {
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

  const currentSec = (now instanceof Date) 
    ? Math.floor(now.getTime() / 1000) 
    : (typeof now === 'number' ? now : nowUtcSec());

  const todayDateStr = formatKyivDate(currentSec);
  const yestDateStr = formatKyivDate(currentSec - 86400);
  const dayBeforeDateStr = formatKyivDate(currentSec - 172800);
  const cutoff24hSec = currentSec - 86400;

  const events = [];
  let curr = null;

  records.forEach((r, idx) => {
    const isOutage = isOutageRecord(r, config);
    const dateStr = formatKyivDate(r.dateTime);
    const time = formatKyivTime(r.dateTime);

    if (isOutage) {
      if (!curr) {
        curr = { 
          startIndex: idx, 
          dateStr,
          start: time, 
          startTimestampSec: r.dateTime,
          startSoc: Math.round(r.batterySoc || 100), 
          minSoc: Math.round(r.batterySoc || 100), 
          pointsCount: 1,
          voltageSampleCount: 0,
          zeroVoltageTicks: 0,
          minGridV: null,
          minPhase: null,
          maxGridV: null,
          maxPhase: null,
          problemPhase: null,
          extremeType: null,
          avgGridV: null,
          extremeGridV: null,
          lastGridVoltages: null
        };
        if (idx > 0) {
          updateEventVoltageStats(curr, records[idx - 1], true);
        }
        updateEventVoltageStats(curr, r, false);
      } else {
        curr.pointsCount++;
        const s = Math.round(r.batterySoc || 100);
        if (s < curr.minSoc) curr.minSoc = s;
        updateEventVoltageStats(curr, r, false);
      }
    } else {
      if (curr) {
        curr.endIndex = idx - 1;
        curr.end = time;
        curr.endTimestampSec = r.dateTime;
        // Тривалість за реальними астрономічними мітками початку й кінця (UTC секунди)
        curr.durationMin = Math.max(
          curr.pointsCount * 5,
          Math.round((curr.endTimestampSec - curr.startTimestampSec) / 60)
        );
        curr.socDrain = Math.max(0, curr.startSoc - curr.minSoc);
        finalizeEventVoltageStats(curr, config);
        const classification = classifyOutageEvent(curr, config);
        curr.eventType = classification.type;
        curr.voltageCause = classification.voltageCause || classification.type;
        resolveProblemPhaseMetrics(curr);
        curr.eventLabel = classification.label;
        curr.eventBadgeColor = classification.badgeColor;
        curr.eventBadgeBg = classification.badgeBg;
        curr.eventDescription = classification.description;

        curr.dayLabel = formatKyivDayLabel(curr.dateStr, todayDateStr, yestDateStr, dayBeforeDateStr);

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
    curr.endTimestampSec = currentSec;
    // Тривалість за реальними астрономічними мітками часу (UTC)
    curr.durationMin = Math.max(
      curr.pointsCount * 5,
      Math.round((curr.endTimestampSec - curr.startTimestampSec) / 60)
    );
    curr.dayLabel = formatKyivDayLabel(curr.dateStr, todayDateStr, yestDateStr, dayBeforeDateStr);
    curr.isOngoing = true;
    curr.socDrain = Math.max(0, curr.startSoc - curr.minSoc);

    if (options && options.liveGridVoltages) {
      applyLiveGridVoltages(curr, options.liveGridVoltages);
    }
    finalizeEventVoltageStats(curr, config);

    const { lv1, lowReconnect, highReconnect, hv1 } = getGridVoltageBounds(config);
    const hasOutOfBoundsVoltage = (
      (curr.maxGridV !== null && curr.maxGridV >= highReconnect) ||
      (curr.minGridV !== null && curr.minGridV < lowReconnect)
    );
    const hasExplicitVoltageCause = (
      ((curr.voltageSampleCount || 0) > 0 && (curr.zeroVoltageTicks > 0 || hasOutOfBoundsVoltage)) ||
      hasOutOfBoundsVoltage
    );

    if (hasExplicitVoltageCause) {
      const classification = classifyOutageEvent(curr, config);
      curr.isInitialPhase = false;
      curr.eventType = classification.type;
      curr.voltageCause = classification.voltageCause || classification.type;
      curr.eventLabel = classification.label;
      curr.eventBadgeColor = classification.badgeColor;
      curr.eventBadgeBg = classification.badgeBg;
      curr.eventDescription = classification.description;
    } else {
      const initialPhaseMin = config.THRESHOLDS?.VOLTAGE_SAG_INITIAL_PHASE_MINUTES ?? 15;
      const isInitialPhase = curr.durationMin <= initialPhaseMin && curr.socDrain <= 1;
      curr.isInitialPhase = isInitialPhase;
      if (isInitialPhase) {
        const phaseHint = formatNominalPhaseHint(curr);
        curr.eventType = OutageType.VOLTAGE_SAG;
        curr.voltageCause = 'VOLTAGE_SAG';
        curr.eventLabel = phaseHint
          ? `⚡ Перевірка стабільності (${phaseHint})`
          : '⚡ Перевірка стабільності мережі';
        curr.eventBadgeColor = '#f59e0b';
        curr.eventBadgeBg = 'rgba(245, 158, 11, 0.15)';
        curr.eventDescription = phaseHint
          ? `Перевірка стабільності мережі (зараз ${phaseHint}, допустимо ${lowReconnect}–${highReconnect} В).`
          : `Можливе виходження напруги за межі ${lv1}–${hv1} В або початок відключення.`;
      } else {
        curr.eventType = OutageType.BLACKOUT;
        curr.voltageCause = 'BLACKOUT';
        curr.eventLabel = '🔴 Відключення ДТЕК';
        curr.eventBadgeColor = '#ef4444';
        curr.eventBadgeBg = 'rgba(239, 68, 68, 0.15)';
        curr.eventDescription = 'Стійке відключення електромережі ДТЕК.';
      }
    }
    resolveProblemPhaseMetrics(curr);

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

  const totalHours24hFormatted = formatDurationUk(totalMin24h);

  const blackoutsIn24h = outagesIn24h.filter(e => e.eventType === OutageType.BLACKOUT);
  const voltageSagsIn24h = outagesIn24h.filter(e => e.eventType === OutageType.VOLTAGE_SAG);
  const allBlackouts = events.filter(e => e.eventType === OutageType.BLACKOUT);
  const allVoltageSags = events.filter(e => e.eventType === OutageType.VOLTAGE_SAG);

  const blackoutsTotalMin = blackoutsIn24h.reduce((sum, e) => {
    const startSec = Math.max(cutoff24hSec, e.startTimestampSec);
    const endSec = e.endTimestampSec || (e.startTimestampSec + e.durationMin * 60);
    return sum + Math.max(0, Math.round((endSec - startSec) / 60));
  }, 0);

  const voltageSagsTotalMin = voltageSagsIn24h.reduce((sum, e) => {
    const startSec = Math.max(cutoff24hSec, e.startTimestampSec);
    const endSec = e.endTimestampSec || (e.startTimestampSec + e.durationMin * 60);
    return sum + Math.max(0, Math.round((endSec - startSec) / 60));
  }, 0);

  return {
    validEvents: events,
    events,
    count: events.length,
    count24h: outagesIn24h.length,
    blackoutCount24h: blackoutsIn24h.length,
    blackoutMinutes24h: blackoutsTotalMin,
    blackoutCountTotal: allBlackouts.length,
    voltageSagCount24h: voltageSagsIn24h.length,
    voltageSagMinutes24h: voltageSagsTotalMin,
    voltageSagCountTotal: allVoltageSags.length,
    totalMinutes: totalMin24h,
    totalHoursFormatted: totalHours24hFormatted,
    totalHours24hFormatted,
    currentOutage
  };
}

/**
 * Розрахунок середнього денного та нічного навантаження будинку виключно по інтервалах блекаутів ДТЕК (BLACKOUT).
 * Якщо достатньої кількості точок BLACKOUT немає (< 3), повертаються базові константи DEFAULT_ACTIVE_KW / DEFAULT_NIGHT_KW.
 */
export function calculateOutageStatistics(multiDayRecords = [], config = CONFIG, outageJournal = null) {
  const { DEFAULT_ACTIVE_KW, DEFAULT_NIGHT_KW, NIGHT_HOUR_START, NIGHT_HOUR_END, HEATING_SEASON_START } = config.THRESHOLDS;

  if (!Array.isArray(multiDayRecords) || multiDayRecords.length === 0) {
    return {
      statActiveKw: Math.round(DEFAULT_ACTIVE_KW * 10) / 10,
      statNightKw: Math.round(DEFAULT_NIGHT_KW * 10) / 10
    };
  }

  let heatingCutoffSec = 0;
  if (HEATING_SEASON_START) {
    const heatingDate = new Date(`${HEATING_SEASON_START}T00:00:00Z`);
    heatingCutoffSec = Math.floor(heatingDate.getTime() / 1000) - getKyivOffsetSec(heatingDate);
  }

  const lastTs = multiDayRecords[multiDayRecords.length - 1]?.dateTime;
  const journal = outageJournal || analyzeMultiDayOutages(
    multiDayRecords,
    typeof lastTs === 'number' ? lastTs + 300 : nowUtcSec(),
    config
  );

  // Збираємо індекси виключно тих точок, що належать до реальних блекаутів ДТЕК (OutageType.BLACKOUT)
  const blackoutIndices = new Set();
  for (const ev of (journal.events || [])) {
    if (ev.eventType !== OutageType.BLACKOUT) continue;
    const startIdx = Math.max(0, ev.startIndex ?? 0);
    const endIdx = Math.min(multiDayRecords.length - 1, ev.endIndex ?? (multiDayRecords.length - 1));
    for (let i = startIdx; i <= endIdx; i++) {
      if (isOutageRecord(multiDayRecords[i], config)) {
        blackoutIndices.add(i);
      }
    }
  }

  const allBlackoutPoints = Array.from(blackoutIndices)
    .sort((a, b) => a - b)
    .map(i => multiDayRecords[i]);

  const heatingBlackoutPoints = heatingCutoffSec > 0
    ? allBlackoutPoints.filter(r => r.dateTime >= heatingCutoffSec)
    : allBlackoutPoints;

  // Використовуємо точки періоду опалення, якщо їх достатньо (від 3 точок), інакше всі точки BLACKOUT
  const blackoutPoints = heatingBlackoutPoints.length >= 3 ? heatingBlackoutPoints : allBlackoutPoints;

  const dayOutageKws = [];
  const nightOutageKws = [];

  for (const r of blackoutPoints) {
    const hour = getKyivHour(r.dateTime);
    const kw = Math.max(0, (r.usePower || r.dischargePower || r.batteryPower || 0) / 1000.0);
    if (hour >= NIGHT_HOUR_START || hour < NIGHT_HOUR_END) {
      nightOutageKws.push(kw);
    } else {
      dayOutageKws.push(kw);
    }
  }

  // Денне навантаження під час реальних блекаутів ДТЕК (фолбек — константа DEFAULT_ACTIVE_KW)
  const statActiveKwVal = dayOutageKws.length >= 3
    ? (dayOutageKws.reduce((a, b) => a + b, 0) / dayOutageKws.length)
    : DEFAULT_ACTIVE_KW;
  const statActiveKw = Math.round(statActiveKwVal * 10) / 10;

  // Нічне навантаження під час реальних блекаутів ДТЕК (фолбек — константа DEFAULT_NIGHT_KW)
  const statNightKwVal = nightOutageKws.length >= 3
    ? (nightOutageKws.reduce((a, b) => a + b, 0) / nightOutageKws.length)
    : DEFAULT_NIGHT_KW;
  const statNightKw = Math.round(statNightKwVal * 10) / 10;

  return {
    statActiveKw,
    statNightKw
  };
}

/**
 * Єдиний розрахунок метрик окремої події відключення (без побудови SVG) — використовується як у графіках, так і в 30-денному архіві.
 */
export function summarizeOutageMetrics(e, records, { includeSeries = false } = {}) {
  if (!e || !Array.isArray(records) || records.length === 0) return null;

  const startIdx = Math.max(0, e.startIndex ?? 0);
  const endIdx = Math.min(records.length - 1, e.endIndex ?? (records.length - 1));
  const rawSlice = records.slice(startIdx, endIdx + 1);
  if (rawSlice.length === 0) return null;

  const points = rawSlice.map(r => ({
    time: formatKyivTime(r.dateTime),
    useKw: Math.max(0, (r.usePower || 0) / 1000.0),
    soc: Math.round(r.batterySoc || 75)
  }));

  const avgKwVal = points.reduce((sum, p) => sum + p.useKw, 0) / points.length;
  let peakPoint = points[0];
  let peakIdx = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].useKw > peakPoint.useKw) {
      peakPoint = points[i];
      peakIdx = i;
    }
  }

  const energyKwh = (rawSlice.reduce((sum, r) => {
    const dis = Math.max(0, (r.dischargePower || r.batteryPower || r.usePower || 0));
    return sum + (dis / 1000.0) * (5 / 60.0);
  }, 0)).toFixed(1);

  const startSoc = e.startSoc ?? points[0].soc;
  const minSoc = e.minSoc ?? Math.min(...points.map(p => p.soc));
  const sliceV = (e.avgGridV == null || e.extremeGridV == null)
    ? computeSliceVoltageStats(rawSlice, e.voltageCause || e.eventType)
    : null;
  const problemPhase = e.problemPhase ?? sliceV?.problemPhase ?? null;
  const extremeType = e.extremeType ?? sliceV?.extremeType ?? null;
  const avgGridV = e.avgGridV ?? sliceV?.avgGridV ?? null;
  const extremeGridV = e.extremeGridV ?? sliceV?.extremeGridV ?? null;
  const minGridV = e.minGridV ?? sliceV?.minGridV ?? null;
  const minPhase = e.minPhase ?? sliceV?.minPhase ?? null;
  const maxGridV = e.maxGridV ?? sliceV?.maxGridV ?? null;
  const maxPhase = e.maxPhase ?? sliceV?.maxPhase ?? null;

  const summary = {
    eventType: e.eventType || OutageType.BLACKOUT,
    voltageCause: e.voltageCause || e.eventType || OutageType.BLACKOUT,
    eventLabel: e.eventLabel || '🔴 Відключення ДТЕК',
    eventBadgeColor: e.eventBadgeColor || '#ef4444',
    eventBadgeBg: e.eventBadgeBg || 'rgba(239, 68, 68, 0.15)',
    eventDescription: e.eventDescription || '',
    problemPhase,
    extremeType,
    avgGridV,
    extremeGridV,
    minGridV,
    minPhase,
    maxGridV,
    maxPhase,
    isOngoing: Boolean(e.isOngoing),
    dateStr: e.dateStr || '',
    dayLabel: e.dayLabel || '',
    start: e.start,
    end: e.end,
    startTimestampSec: e.startTimestampSec,
    endTimestampSec: e.endTimestampSec,
    durStr: formatDurationUk(e.durationMin),
    durationMin: e.durationMin || 0,
    startSoc,
    minSoc,
    socDrain: Math.max(0, startSoc - minSoc),
    energyKwh,
    avgKw: avgKwVal.toFixed(1),
    peakKw: peakPoint.useKw.toFixed(1),
    peakTime: peakPoint.time
  };

  if (includeSeries) {
    return { summary, points, avgKwVal, peakPoint, peakIdx };
  }
  return summary;
}

/**
 * Формує зведення та список подій для API /api/archive за останній місяць.
 */
export function buildArchiveResponse({
  events = [],
  records = [],
  daysAvailable = 0,
  daysRequested = 30,
  remainingDays = 0,
  fromDateStr = '',
  toDateStr = ''
}) {
  const archivedEvents = [...events]
    .reverse()
    .map(ev => summarizeOutageMetrics(ev, records))
    .filter(Boolean);

  let blackoutCount = 0;
  let blackoutTotalMin = 0;
  let blackoutWeightedKwSum = 0;
  let voltageCount = 0;
  let voltageTotalMin = 0;
  let minSoc = 100;
  let maxPeakKw = 0;

  for (const ev of archivedEvents) {
    const dur = Math.max(1, ev.durationMin || 0);
    if (ev.minSoc < minSoc) minSoc = ev.minSoc;
    const pk = parseFloat(ev.peakKw || '0');
    if (pk > maxPeakKw) maxPeakKw = pk;
    if (ev.eventType === OutageType.BLACKOUT) {
      blackoutCount += 1;
      blackoutTotalMin += ev.durationMin || 0;
      blackoutWeightedKwSum += parseFloat(ev.avgKw || '0') * dur;
    } else {
      voltageCount += 1;
      voltageTotalMin += ev.durationMin || 0;
    }
  }

  const blackoutWeightTotal = archivedEvents
    .filter(ev => ev.eventType === OutageType.BLACKOUT)
    .reduce((sum, ev) => sum + Math.max(1, ev.durationMin || 0), 0);

  return {
    period: {
      fromDateStr,
      toDateStr,
      daysRequested,
      daysAvailable,
      remainingDays,
      isPartial: remainingDays > 0
    },
    summary: {
      totalEvents: archivedEvents.length,
      blackoutCount,
      blackoutTotalMin,
      blackoutTotalFormatted: formatDurationUk(blackoutTotalMin),
      voltageCount,
      voltageTotalMin,
      voltageTotalFormatted: formatDurationUk(voltageTotalMin),
      avgBlackoutKw: blackoutWeightTotal > 0 ? (blackoutWeightedKwSum / blackoutWeightTotal).toFixed(1) : '0.0',
      maxPeakKw: archivedEvents.length > 0 ? maxPeakKw.toFixed(1) : '0.0',
      minSoc: archivedEvents.length > 0 ? minSoc : 100
    },
    events: archivedEvents
  };
}
