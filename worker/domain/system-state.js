/**
 * Автомат станів системи резервного живлення Deye Inverter.
 * Паттерн: State Machine / State Pattern.
 * Єдине джерело правди для визначення операційного режиму системи та його візуалізації в UI.
 */

export const SystemStateId = Object.freeze({
  GRID_CHARGING: 'GRID_CHARGING',
  GRID_STANDBY: 'GRID_STANDBY',
  BLACKOUT_BATTERY: 'BLACKOUT_BATTERY',
  BATTERY_DEPLETED: 'BATTERY_DEPLETED',
  LOGGER_OFFLINE: 'LOGGER_OFFLINE',
  CLOUD_ERROR: 'CLOUD_ERROR'
});

export class SystemState {
  constructor({
    id,
    isOnline,
    badgeText,
    badgeColor,
    badgeBg,
    badgeBorder,
    dotColor,
    bannerIcon,
    bannerBorderColor,
    bannerIconBg,
    bannerIconColor,
    bannerTitle,
    bannerSubtitle,
    gaugeSubtext,
    gaugeStrokeColor,
    tipIcon,
    tipBg,
    tipBorder,
    tipColor,
    tipHtml
  }) {
    this.id = id;
    this.isOnline = isOnline;
    this.badgeText = badgeText;
    this.badgeColor = badgeColor;
    this.badgeBg = badgeBg;
    this.badgeBorder = badgeBorder;
    this.dotColor = dotColor;
    this.bannerIcon = bannerIcon;
    this.bannerBorderColor = bannerBorderColor;
    this.bannerIconBg = bannerIconBg;
    this.bannerIconColor = bannerIconColor;
    this.bannerTitle = bannerTitle;
    this.bannerSubtitle = bannerSubtitle;
    this.gaugeSubtext = gaugeSubtext;
    this.gaugeStrokeColor = gaugeStrokeColor;
    this.tipIcon = tipIcon;
    this.tipBg = tipBg;
    this.tipBorder = tipBorder;
    this.tipColor = tipColor;
    this.tipHtml = tipHtml;
  }
}

/**
 * Детермінований розрахунок стану системи на основі вхідної телеметрії.
 * @param {Object} data Дані телеметрії інвертора
 * @param {Object} config Додаткова конфігурація (напр. safetyBufferSoc)
 * @returns {SystemState}
 */
export function resolveSystemState(data, config = {}) {
  const isOnline = (data.is_online !== false);
  const isGridOn = Boolean(data.is_grid_on);
  const isCharging = Boolean(data.is_charging);
  const soc = Number.isFinite(data.battery_soc) ? data.battery_soc : 100;
  const safetyBuffer = config.safetyBufferSoc ?? 10;
  const offlineType = data.offline_type || '';
  const offlineReason = data.offline_reason || '';
  const lastSeen = data.device_last_seen || data.updated_at || '--';

  // Розрахунок тривалості та стартових параметрів блекауту
  const currOutage = data.current_outage;
  const outageStartStr = currOutage ? `(з ${currOutage.start})` : '';
  const outageDurStr = currOutage && currOutage.durationMin > 0
    ? (currOutage.durationMin >= 60 
        ? `${Math.floor(currOutage.durationMin / 60)} год ${currOutage.durationMin % 60 ? `${currOutage.durationMin % 60} хв` : ''}`.trim()
        : `${currOutage.durationMin} хв`) 
    : '';

  // 1. Помилка хмарного сервісу Deye Cloud
  if (offlineType.startsWith('CLOUD_')) {
    return new SystemState({
      id: SystemStateId.CLOUD_ERROR,
      isOnline: false,
      badgeText: 'OFFLINE',
      badgeColor: '#f87171',
      badgeBg: 'rgba(239, 68, 68, 0.15)',
      badgeBorder: 'rgba(239, 68, 68, 0.4)',
      dotColor: '#ef4444',
      bannerIcon: '☁️',
      bannerBorderColor: 'var(--danger)',
      bannerIconBg: 'rgba(239, 68, 68, 0.15)',
      bannerIconColor: 'var(--danger)',
      bannerTitle: 'Сервер Deye Cloud не відповідає',
      bannerSubtitle: offlineReason || `Сервер Deye Cloud тимчасово не відповів. Відображено збережені дані.`,
      gaugeSubtext: '☁️ Збій хмари',
      gaugeStrokeColor: '#f59e0b',
      tipIcon: '☁️',
      tipBg: 'rgba(239, 68, 68, 0.08)',
      tipBorder: 'rgba(239, 68, 68, 0.25)',
      tipColor: '#fecaca',
      tipHtml: `<strong>Увага для мешканців / чергового:</strong> Сервер моніторингу Deye Cloud тимчасово не відповідає. Обладнання в щитовій продовжує працювати штатно в автоматичному режимі.`
    });
  }

  // 2. Резерв батареї вичерпано (блекаут або офлайн при заряді <= 10%)
  const isBatteryDepleted = (!isGridOn && soc <= safetyBuffer) || (offlineType === 'BATTERY_DEPLETED');
  if (isBatteryDepleted) {
    return new SystemState({
      id: SystemStateId.BATTERY_DEPLETED,
      isOnline: false,
      badgeText: 'OFFLINE',
      badgeColor: '#f87171',
      badgeBg: 'rgba(239, 68, 68, 0.15)',
      badgeBorder: 'rgba(239, 68, 68, 0.4)',
      dotColor: '#ef4444',
      bannerIcon: '🪫',
      bannerBorderColor: 'var(--danger)',
      bannerIconBg: 'rgba(239, 68, 68, 0.15)',
      bannerIconColor: 'var(--danger)',
      bannerTitle: `Резерв батареї вичерпано (${soc}%)`,
      bannerSubtitle: offlineReason || `Акумулятор розрядився до мінімального порогу (${soc}%). Резервне живлення будинку вимкнено інвертором. Останній зв'язок: ${lastSeen}.`,
      gaugeSubtext: '🪫 АКБ вичерпано',
      gaugeStrokeColor: '#ef4444',
      tipIcon: '🪫',
      tipBg: 'rgba(239, 68, 68, 0.08)',
      tipBorder: 'rgba(239, 68, 68, 0.25)',
      tipColor: '#fecaca',
      tipHtml: `<strong>Увага для мешканців / чергового:</strong> Резерв акумулятора повністю вичерпано (досягнуто безпечний поріг 10%). Інвертор автоматично знеструмив будинок (включно з роутером у щитовій) для захисту батареї від пошкодження. Живлення насосів, ліфтів та освітлення відновиться автоматично, щойно з'явиться напруга в міській електромережі або буде запущено генератор.`
    });
  }

  // 3. Звичайна втрата зв'язку з даталогером інвертора (АКБ ще має заряд або міська мережа є)
  if (!isOnline) {
    return new SystemState({
      id: SystemStateId.LOGGER_OFFLINE,
      isOnline: false,
      badgeText: 'OFFLINE',
      badgeColor: '#f87171',
      badgeBg: 'rgba(239, 68, 68, 0.15)',
      badgeBorder: 'rgba(239, 68, 68, 0.4)',
      dotColor: '#ef4444',
      bannerIcon: '📡',
      bannerBorderColor: 'var(--danger)',
      bannerIconBg: 'rgba(239, 68, 68, 0.15)',
      bannerIconColor: 'var(--danger)',
      bannerTitle: 'Немає зв\'язку з інвертором',
      bannerSubtitle: offlineReason || `Дані не оновлюються з ${lastSeen}. Можливо, відключено роутер або живлення в щитовій.`,
      gaugeSubtext: '⚠️ Немає зв\'язку',
      gaugeStrokeColor: '#f59e0b',
      tipIcon: '📡',
      tipBg: 'rgba(239, 68, 68, 0.08)',
      tipBorder: 'rgba(239, 68, 68, 0.25)',
      tipColor: '#fecaca',
      tipHtml: `<strong>Увага для мешканців / чергового:</strong> Втрачено інтернет-зв'язок із даталогером інвертора. Найчастіша причина — збій роутера або каналу зв'язку в щитовій. Якщо в міській мережі є напруга або в батареї залишається заряд, резервне живлення продовжує працювати в автоматичному режимі.`
    });
  }

  // 4. Блекаут або захисне відсікання міської мережі (робота будинку від батареї)
  if (!isGridOn) {
    const isSagPhase = Boolean(currOutage?.isInitialPhase);
    const title = isSagPhase
      ? `Резервне живлення • Перевірка мережі ${outageStartStr}`.trim()
      : `Відключення світла ${outageStartStr}`.trim();
    const subtitle = isSagPhase
      ? `${outageDurStr ? `Триває ${outageDurStr} • ` : ''}Можливий стрибок напруги або початок відключення`
      : `${outageDurStr ? `Триває ${outageDurStr} • ` : ''}Старт із ${currOutage ? currOutage.startSoc : soc}%`;
    const tipHtml = isSagPhase
      ? `<strong>Захист інвертора:</strong> Будинок переведено на резервне живлення від батарей (ліфти, насоси та освітлення працюють стабільно). Найчастіша причина коротких перемикань — захисне відсікання міської мережі через просідання напруги нижче 195 В. Щойно напруга в місті стабілізується вище 205 В протягом 1 хв, система автоматично повернеться на міську мережу.`
      : `<strong>Порада для мешканців:</strong> Будинок перейшов на резервне живлення від батареї (працюють насоси води, опалення, ліфти та чергове освітлення). Якщо є можливість піднятися сходами на свій поверх — це суттєво заощаджує заряд для безперебійного водопостачання та тепла для всього будинку!`;

    return new SystemState({
      id: SystemStateId.BLACKOUT_BATTERY,
      isOnline: true,
      badgeText: 'LIVE',
      badgeColor: '#34d399',
      badgeBg: 'rgba(16, 185, 129, 0.15)',
      badgeBorder: 'rgba(16, 185, 129, 0.3)',
      dotColor: '#10b981',
      bannerIcon: isSagPhase ? '⚡' : '🔴',
      bannerBorderColor: isSagPhase ? '#f59e0b' : 'var(--danger)',
      bannerIconBg: isSagPhase ? 'rgba(245, 158, 11, 0.15)' : 'rgba(239, 68, 68, 0.15)',
      bannerIconColor: isSagPhase ? '#f59e0b' : 'var(--danger)',
      bannerTitle: title,
      bannerSubtitle: subtitle,
      gaugeSubtext: isSagPhase ? '⚡ Захист АКБ' : '🔴 Розряд АКБ',
      gaugeStrokeColor: soc > 50 ? '#3b82f6' : (soc > 25 ? '#f59e0b' : '#ef4444'),
      tipIcon: isSagPhase ? '⚡' : '💡',
      tipBg: 'rgba(245, 158, 11, 0.08)',
      tipBorder: 'rgba(245, 158, 11, 0.2)',
      tipColor: '#fef3c7',
      tipHtml: tipHtml
    });
  }

  // 5. Міська мережа активна, батарея заряджається
  if (isCharging) {
    const chargeKw = (data.charge_power_kw || 0).toFixed(1);
    const voltage = (data.battery_voltage || 645.0).toFixed(1);
    return new SystemState({
      id: SystemStateId.GRID_CHARGING,
      isOnline: true,
      badgeText: 'LIVE',
      badgeColor: '#34d399',
      badgeBg: 'rgba(16, 185, 129, 0.15)',
      badgeBorder: 'rgba(16, 185, 129, 0.3)',
      dotColor: '#10b981',
      bannerIcon: '⚡',
      bannerBorderColor: 'var(--success)',
      bannerIconBg: 'rgba(16, 185, 129, 0.15)',
      bannerIconColor: 'var(--success)',
      bannerTitle: 'Міська мережа активна • Заряд АКБ',
      bannerSubtitle: `Потужність заряджання: +${chargeKw} кВт (напруга: ${voltage} В)`,
      gaugeSubtext: '⚡ Заряджання',
      gaugeStrokeColor: '#10b981',
      tipIcon: '💡',
      tipBg: 'rgba(245, 158, 11, 0.08)',
      tipBorder: 'rgba(245, 158, 11, 0.2)',
      tipColor: '#fef3c7',
      tipHtml: `<strong>Статус:</strong> Міська мережа активна. Акумулятор заряджається високою потужністю, щоб бути готовим до можливих відключень.`
    });
  }

  // 6. Міська мережа активна, батарея в режимі очікування (готовність)
  return new SystemState({
    id: SystemStateId.GRID_STANDBY,
    isOnline: true,
    badgeText: 'LIVE',
    badgeColor: '#34d399',
    badgeBg: 'rgba(16, 185, 129, 0.15)',
    badgeBorder: 'rgba(16, 185, 129, 0.3)',
    dotColor: '#10b981',
    bannerIcon: '🟢',
    bannerBorderColor: 'var(--success)',
    bannerIconBg: 'rgba(16, 185, 129, 0.15)',
    bannerIconColor: 'var(--success)',
    bannerTitle: 'Міська мережа активна',
    bannerSubtitle: 'Батарея в режимі очікування (100% готовність)',
    gaugeSubtext: '🟢 Готовність',
    gaugeStrokeColor: '#3b82f6',
    tipIcon: '💡',
    tipBg: 'rgba(245, 158, 11, 0.08)',
    tipBorder: 'rgba(245, 158, 11, 0.2)',
    tipColor: '#fef3c7',
    tipHtml: `<strong>Статус:</strong> Міська мережа активна. Акумулятор повністю заряджений (100%) та готовий до захисту критичної інфраструктури.`
  });
}
