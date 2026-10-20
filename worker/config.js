import { VERSION } from './version.js';

/**
 * Єдина конфігурація системи моніторингу Deye для ОСББ "Новодарницьке"
 * Принцип Single Source of Truth: усі константи та порогові значення зосереджені тут.
 */

export const CONFIG = {
  APP_VERSION: VERSION,
  BATTERY: {
    NOMINAL_CAPACITY_KWH: 65.0, // Номінальна ємність батареї (кВт·год)
    SAFETY_BUFFER_SOC: 15,       // Безпековий буфер розряду (до 15% SOC)
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
    NIGHT_HOUR_END: 7            // Кінець нічного інтервалу (година)
  },
  TIME: {
    KYIV_OFFSET_HOURS: 3,
    KYIV_OFFSET_SEC: 3 * 3600
  },
  CACHE: {
    TTL_MS: 60 * 1000,           // TTL кешу телеметрії (60 сек)
    HISTORY_DAYS: 7              // Глибина історії відключень (днів)
  }
};
