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
 * Симуляція вичерпання заряду батареї за добовим графіком зміни дня і ночі.
 * Враховує реальний час доби та плавний перехід між денним (~3.3 кВт) та нічним (~2.1 кВт) споживанням.
 * 
 * @param {number} usableKwh - Доступна корисна енергія (кВт·год)
 * @param {Date} startKyivDate - Початковий час за Києвом
 * @param {number} dayKw - Денне навантаження (кВт)
 * @param {number} nightKw - Нічне навантаження (кВт)
 * @param {typeof CONFIG} [config]
 */
export function simulateTimelineAutonomy(usableKwh, startKyivDate, dayKw, nightKw, config = CONFIG) {
  if (usableKwh <= 0 || (dayKw <= 0 && nightKw <= 0)) {
    return { hours: 0, endDate: new Date(startKyivDate.getTime()) };
  }

  const { NIGHT_HOUR_START, NIGHT_HOUR_END } = config.THRESHOLDS;
  let remainingEnergy = usableKwh;
  let currentMillis = startKyivDate.getTime();
  const stepMinutes = 15;
  const stepHours = stepMinutes / 60.0;
  let elapsedMinutes = 0;

  // Запобіжник від нескінченного циклу (максимум 72 години)
  const maxSteps = (72 * 60) / stepMinutes;
  let steps = 0;

  while (remainingEnergy > 0 && steps < maxSteps) {
    const curDate = new Date(currentMillis);
    const hour = curDate.getUTCHours();
    const isNight = (hour >= NIGHT_HOUR_START || hour < NIGHT_HOUR_END);
    const loadKw = isNight ? nightKw : dayKw;

    const energyConsumed = loadKw * stepHours;
    if (remainingEnergy <= energyConsumed) {
      const fraction = remainingEnergy / (energyConsumed || 1);
      elapsedMinutes += fraction * stepMinutes;
      currentMillis += fraction * stepMinutes * 60 * 1000;
      remainingEnergy = 0;
      break;
    }

    remainingEnergy -= energyConsumed;
    elapsedMinutes += stepMinutes;
    currentMillis += stepMinutes * 60 * 1000;
    steps++;
  }

  const hours = elapsedMinutes / 60.0;
  return {
    hours,
    endDate: new Date(currentMillis)
  };
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

  // Доступна енергія до встановленої межі вимкнення 10% SOC з урахуванням ККД 90%
  const usableSoc = Math.max(0, soc - SAFETY_BUFFER_SOC);
  const usableKwh = (NOMINAL_CAPACITY_KWH * (usableSoc / 100.0)) * INVERTER_EFFICIENCY;

  // 1. Консервативна оцінка: якщо весь час триватиме активне денне навантаження
  const hoursConservative = realisticKw > 0 ? Math.max(0, usableKwh / realisticKw) : 0;

  // 2. Реалістична оцінка: хронологічна симуляція з урахуванням зміни дня і ночі за годинником
  const timeline = simulateTimelineAutonomy(usableKwh, now, realisticKw, nightKw, config);
  const hoursNight = timeline.hours;

  const endCons = new Date(now.getTime() + hoursConservative * 3600 * 1000);
  const endOpt = timeline.endDate;

  const tOpt = endOpt.toISOString().substring(11, 16);
  const tCons = endCons.toISOString().substring(11, 16);

  // Значуща різниця: коли нічна економія реально додає час (від 15 хвилин різниці)
  const isDiffMeaningful = (tOpt !== tCons) && (Math.abs(endOpt.getTime() - endCons.getTime()) >= 15 * 60 * 1000);

  let remH_cons = Math.floor(hoursConservative);
  let remH_opt = Math.round(hoursNight);

  if (!isDiffMeaningful) {
    remH_cons = Math.round(hoursConservative);
    remH_opt = remH_cons;
  }

  const est_time_until = isDiffMeaningful
    ? `до ${tOpt} (мінімум до ${tCons})`
    : `до ${tOpt}`;

  const est_hours_formatted = (remH_cons === remH_opt)
    ? `${remH_cons} год`
    : `${remH_cons} – ${remH_opt} год`;

  return {
    usableKwh,
    realisticKw,
    nightKw,
    hoursConservative,
    hoursNight,
    remH_cons,
    remH_opt,
    est_hours_formatted,
    est_time_until
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
