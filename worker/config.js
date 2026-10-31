import { VERSION } from './version.js';

/**
 * Єдина конфігурація системи моніторингу Deye для ОСББ "Новодарницьке"
 * Принцип Single Source of Truth: усі константи та порогові значення зосереджені тут.
 */

/**
 * Динамічне визначення зміщення київського часу відносно UTC (враховує літній/зимовий час).
 * Взимку (EET): UTC+2 (7200 сек).
 * Влітку (EEST): UTC+3 (10800 сек).
 */
export function getKyivOffsetSec(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { 
      timeZone: 'Europe/Kyiv', 
      timeZoneName: 'longOffset' 
    }).formatToParts(date);
    const tz = parts.find(p => p.type === 'timeZoneName')?.value;
    const match = tz && tz.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
    if (match) {
      const sign = match[1] === '+' ? 1 : -1;
      const h = parseInt(match[2], 10);
      const m = match[3] ? parseInt(match[3], 10) : 0;
      return sign * (h * 3600 + m * 60);
    }
  } catch (e) {
    // Fallback якщо середовище не підтримує timeZoneName
  }
  return 2 * 3600; // Стандартний київський час UTC+2
}

export const CONFIG = {
  APP_VERSION: VERSION,
  BATTERY: {
    NOMINAL_CAPACITY_KWH: 65.0, // Номінальна ємність батареї (кВт·год)
    SAFETY_BUFFER_SOC: 10,       // Межа відключення інвертора (Shutdown SOC: 10%)
    INVERTER_EFFICIENCY: 0.90,   // Базовий ККД перетворення інвертора
    DISCHARGE_EFFICIENCY: 0.92,  // ККД батареї на розряд (AC/DC)
    ABSORPTION_VOLTAGE_MIN: 645.0 // Напруга режиму балансування комірок
  },
  THRESHOLDS: {
    MIN_OUTAGE_MINUTES: 10,      // Мінімальна тривалість блекауту для врахування в журналі (хв)
    OUTAGE_BATTERY_MIN_W: 300,   // Поріг потужності розряду (Вт) для фіксації відключення
    GRID_MIN_W: 100,             // Поріг наявності міської мережі (Вт)
    SMOOTHING_INTERMITTENT_FACTOR: 0.35, // Коефіцієнт згладжування пускових струмів ліфтів/насосів
    DEFAULT_ACTIVE_KW: 4.8,      // Базове денне споживання за замовчуванням (кВт)
    DEFAULT_NIGHT_KW: 2.8,       // Базове нічне споживання за замовчуванням (кВт)
    NIGHT_HOUR_START: 23,        // Початок нічного інтервалу (година)
    NIGHT_HOUR_END: 7,           // Кінець нічного інтервалу (година)
    OFFLINE_THRESHOLD_MIN: 15    // Максимальний допустимий інтервал без оновлень (хв) перед переходом в OFFLINE
  },
  TIME: {
    TIMEZONE: 'Europe/Kyiv',
    get KYIV_OFFSET_SEC() {
      return getKyivOffsetSec();
    },
    get KYIV_OFFSET_HOURS() {
      return Math.round(getKyivOffsetSec() / 3600);
    }
  },
  CACHE: {
    TTL_MS: 60 * 1000,           // TTL кешу телеметрії (60 сек)
    HISTORY_DAYS: 7              // Глибина історії відключень (днів)
  }
};
