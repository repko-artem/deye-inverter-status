import { CONFIG } from '../config.js';

/**
 * Перевірка, чи є точка телеметрії записом під час відключення мережі (DRY).
 */
export function isOutageRecord(record, config = CONFIG) {
  if (!record) return false;
  const wirePower = record.wirePower ?? 0;
  const batteryPower = record.batteryPower ?? 0;
  const dischargePower = record.dischargePower ?? 0;
  const minThreshold = config.THRESHOLDS.OUTAGE_BATTERY_MIN_W;

  return wirePower === 0 && (batteryPower > minThreshold || dischargePower > minThreshold);
}

/**
 * Фізико-математична модель розрахунку автономності будинку.
 * 
 * @param {number} soc - Поточний рівень заряду батареї (%)
 * @param {boolean} isGridOn - Чи активна міська мережа
 * @param {number} usePowerKw - Поточна потужність споживання (кВт)
 * @param {number} statActiveKw - Статистичне денне навантаження будинку (кВт)
 * @param {number} statNightKw - Статистичне нічне навантаження будинку (кВт)
 * @param {Date} [now] - Точка відліку часу
 * @param {typeof CONFIG} [config] - Конфігураційні константи
 */
export function calculateAutonomy(
  soc,
  isGridOn,
  usePowerKw,
  statActiveKw,
  statNightKw,
  now = new Date(),
  config = CONFIG
) {
  const { NOMINAL_CAPACITY_KWH, SAFETY_BUFFER_SOC, INVERTER_EFFICIENCY } = config.BATTERY;
  const { SMOOTHING_INTERMITTENT_FACTOR } = config.THRESHOLDS;

  // Під час блекауту згладжуємо пускові сплески ліфтів/насосів (враховуємо змінний цикл роботи)
  let realisticKw = statActiveKw;
  if (!isGridOn && usePowerKw > statActiveKw) {
    realisticKw = statActiveKw + (usePowerKw - statActiveKw) * SMOOTHING_INTERMITTENT_FACTOR;
  }
  const nightKw = statNightKw;

  // Доступна енергія до безпекового порогу 15% SOC з урахуванням ККД 90%
  const usableSoc = Math.max(0, soc - SAFETY_BUFFER_SOC);
  const usableKwh = (NOMINAL_CAPACITY_KWH * (usableSoc / 100.0)) * INVERTER_EFFICIENCY;

  const hoursConservative = realisticKw > 0 ? Math.max(0, usableKwh / realisticKw) : 0;
  const remH_cons = Math.floor(hoursConservative);

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

/**
 * Розрахунок сумарного розходу енергії (кВт·год) під час блекаутів за 24 години.
 */
export function calculate24hDischarge(records24h = [], config = CONFIG) {
  const totalKwh = records24h.reduce((sum, r) => {
    if (isOutageRecord(r, config)) {
      const disW = Math.max(0, (r.dischargePower || r.batteryPower || r.usePower || 0));
      return sum + (disW / 1000.0) * (5 / 60.0); // 5 хвилин на точку
    }
    return sum;
  }, 0);

  return (Math.round(totalKwh * 10) / 10).toFixed(1);
}

/**
 * Розрахунок темпу розряду батареї (%/год) на основі фізичної моделі.
 */
export function calculateDischargeRate(usePowerKw, dischargePowerKw, currentOutageChart, config = CONFIG) {
  const { NOMINAL_CAPACITY_KWH, DISCHARGE_EFFICIENCY } = config.BATTERY;

  // Виміряна шунтом потужність DC або розрахункова AC з поправкою на ККД 92%
  const dcDischargeKw = dischargePowerKw > 0.05
    ? dischargePowerKw
    : (usePowerKw > 0.05 ? (usePowerKw / DISCHARGE_EFFICIENCY) : 0);

  const instantRateVal = dcDischargeKw > 0
    ? ((dcDischargeKw / NOMINAL_CAPACITY_KWH) * 100)
    : 0;

  const ratePct = instantRateVal.toFixed(1);
  let subtext = `При поточному розряді ~${dcDischargeKw.toFixed(1)} кВт`;

  if (currentOutageChart && currentOutageChart.avgKw) {
    const avgAc = parseFloat(currentOutageChart.avgKw);
    if (!isNaN(avgAc) && avgAc > 0) {
      const avgDc = avgAc / DISCHARGE_EFFICIENCY;
      const avgRate = (avgDc / NOMINAL_CAPACITY_KWH) * 100;
      subtext = `Сер. за відключення: ~${avgRate.toFixed(1)}%/год`;
    }
  }

  return {
    ratePct,
    subtext,
    dcDischargeKw
  };
}
