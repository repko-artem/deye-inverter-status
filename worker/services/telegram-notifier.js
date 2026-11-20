/**
 * Сервіс сповіщень у закриту Telegram-групу ОСББ "Новодарницьке".
 * Відповідає за порогові сповіщення розряду батарей (90%, 80%, 70%... 10%)
 * та сповіщення про відновлення міської електромережі.
 */

import { nowUtcSec } from '../domain/time.js';

export const NOTIFICATION_THRESHOLDS = Object.freeze([80, 60, 40, 20, 10]);
export const CRITICAL_SHUTDOWN_THRESHOLD = 10;
const RESTORATION_DEDUP_WINDOW_SEC = 300;
const EVENT_MATCH_TOLERANCE_SEC = 900;

/**
 * Єдине форматування тривалості у хвилинах українською (повертає null для <= 0).
 */
export function formatOutageDuration(minutes) {
  const dur = Math.round(Number(minutes) || 0);
  if (dur <= 0) return null;
  const h = Math.floor(dur / 60);
  const m = dur % 60;
  return h > 0 ? `${h} год ${m > 0 ? `${m} хв` : ''}`.trim() : `${m} хв`;
}

/**
 * Пороги > CRITICAL_SHUTDOWN_THRESHOLD працюють за фронтом спаду (startSoc > T -> currentSoc <= T),
 * тому на старті >= T вважаються вже досягнутими. Поріг 10% спрацьовує завжди (level-triggered).
 */
export function computeInitialNotifiedLevels(startSoc, thresholds = NOTIFICATION_THRESHOLDS) {
  const soc = Number.isFinite(startSoc) ? startSoc : 100;
  return thresholds.filter(t => t > CRITICAL_SHUTDOWN_THRESHOLD && t >= soc);
}

/**
 * Повертає пороги, перетнуті станом на поточний заряд АКБ і ще не надіслані в межах цієї події.
 */
export function findReachedThresholds(currentSoc, notifiedLevels = [], thresholds = NOTIFICATION_THRESHOLDS) {
  return thresholds.filter(t => currentSoc <= t && !notifiedLevels.includes(t));
}

/**
 * Визначає, чи поточна телеметрія є заглушкою помилки хмари Deye (не достовірним станом мережі).
 */
export function isUnreliableCloudErrorTelemetry(data) {
  if (!data || typeof data !== 'object') return true;
  if (data.system_state === 'CLOUD_ERROR') return true;
  return typeof data.offline_type === 'string' && data.offline_type.startsWith('CLOUD_');
}

/**
 * Перевіряє, чи остання завершена подія з журналу відповідає активному відключенню в state.
 */
export function isMatchingCompletedEvent(event, state, nowSec) {
  if (!event || !(Number(event.durationMin) > 0)) return false;
  const hasEnd = typeof event.endTimestampSec === 'number';
  const hasStart = typeof event.startTimestampSec === 'number';
  if (!hasStart && !hasEnd) return true;

  const stateStart = state?.outageStartTimestampSec;
  if (hasEnd && typeof stateStart === 'number') {
    return event.endTimestampSec >= stateStart - 300 && (nowSec - event.endTimestampSec) <= EVENT_MATCH_TOLERANCE_SEC;
  }
  if (hasStart && typeof stateStart === 'number') {
    return Math.abs(event.startTimestampSec - stateStart) <= EVENT_MATCH_TOLERANCE_SEC;
  }
  return true;
}

/**
 * Визначає точну тривалість завершеного відключення (з релевантного запису журналу або за стінним часом).
 */
export function resolveRestoredOutageDurationMin(data, state, nowSec) {
  const events = data?.journal?.validEvents;
  const lastCompletedEvent = Array.isArray(events) && events.length > 0 ? events[events.length - 1] : null;
  if (isMatchingCompletedEvent(lastCompletedEvent, state, nowSec)) {
    return Number(lastCompletedEvent.durationMin);
  }
  if (state?.outageStartTimestampSec) {
    return Math.max(1, Math.round((nowSec - state.outageStartTimestampSec) / 60));
  }
  return 0;
}

/**
 * Відправка повідомлення в Telegram Bot API
 */
export async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId || !text) return false;

  const cleanToken = String(botToken).trim();
  const cleanChatId = String(chatId).trim();

  const url = `https://api.telegram.org/bot${cleanToken}/sendMessage`;
  const body = {
    chat_id: cleanChatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Telegram API error HTTP ${res.status}:`, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Failed to send Telegram message:', err);
    return false;
  }
}

/**
 * Форматування повідомлення про поріг розряду батареї
 */
export function formatThresholdMessage(threshold, data, elapsedOutageMin = null) {
  const soc = data.battery_soc ?? threshold;
  const estHours = data.est_hours_formatted || '--';
  const estUntil = data.est_time_until || '--';
  const useKw = Number(data.use_power_kw || 0).toFixed(1);
  const outage = data.current_outage;
  const rawDurMin = (outage && Number(outage.durationMin) > 0)
    ? Number(outage.durationMin)
    : Number(elapsedOutageMin || 0);
  const durStr = formatOutageDuration(rawDurMin) || 'щойно';

  const icon = threshold === 40 ? '🛗' : (threshold <= 10 ? '🚨' : (threshold <= 20 ? '⚠️' : (threshold <= 50 ? '🪫' : '🔋')));

  let footerNote = '';
  if (threshold === 10) {
    footerNote = '\n\n🛑 <b>Увага:</b> Досягнуто захисний поріг інвертора (10%). Резервне живлення відключається для збереження ресурсу акумуляторів.';
  } else if (threshold === 40) {
    footerNote = '\n\n🛗 <b>УВАГА МЕШКАНЦЯМ: Ліфти будуть відключені!</b>\nРівень заряду акумуляторів знизився до 40%. Згідно з регламентом енергозбереження, ліфти відключаються, щоб гарантувати тривалу роботу насосів опалення та водопостачання будинку. Будь ласка, користуйтеся сходами!';
  } else if (threshold <= 20) {
    footerNote = '\n\n⚠️ <i>Критичний рівень заряду. Працюють виключно насоси опалення, водопостачання та чергове освітлення.</i>';
  }

  return `${icon} <b>Рівень заряду батареї: ${soc}%</b>

⏳ Залишок автономності: <b>~${estHours}</b>
🕒 Вистачить орієнтовно: <b>${estUntil}</b>
⚡ Споживання будинку: <b>${useKw} кВт</b> (ліфти, насоси опалення та води)
⏱ Відключення триває: <b>${durStr}</b>${footerNote}

🌐 <a href="https://power.osbbnd.workers.dev">Переглянути графік онлайн</a>`;
}

/**
 * Форматування повідомлення про відновлення міської мережі
 */
export function formatRestorationMessage(data, previousOutageDurMin) {
  const soc = data.battery_soc ?? 100;
  const useKw = Number(data.use_power_kw || 0).toFixed(1);
  const chargeKw = Number(data.charge_power_kw || 0).toFixed(1);
  const durStr = formatOutageDuration(previousOutageDurMin);

  return `🟢 <b>Міську електромережу відновлено!</b>

🔋 Поточний заряд акумулятора: <b>${soc}%</b>${Number(chargeKw) > 0.5 ? ` (зарядка +${chargeKw} кВт)` : ''}
⚡ Споживання будинку: <b>${useKw} кВт</b>${durStr ? `\n⏱ Відключення тривало: <b>${durStr}</b>` : ''}

🌐 <a href="https://power.osbbnd.workers.dev">Статус енергопостачання онлайн</a>`;
}

const notificationLocks = new WeakMap();
const latestStateByKv = new WeakMap();

async function withKvSerialization(kv, fn) {
  if (!kv || typeof kv !== 'object') return fn();
  const prev = notificationLocks.get(kv) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  const cleanup = next.finally(() => {
    if (notificationLocks.get(kv) === cleanup) {
      notificationLocks.delete(kv);
    }
  });
  notificationLocks.set(kv, cleanup);
  return next;
}

/**
 * Головний обробник перевірки та відправки сповіщень.
 * @param {Object} data Дані поточної телеметрії
 * @param {Object} env Змінні середовища Cloudflare (NOTIFY_KV, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
 */
export async function processTelegramNotifications(data, env) {
  const botToken = env.TELEGRAM_BOT_TOKEN ? String(env.TELEGRAM_BOT_TOKEN).trim() : '';
  const chatId = env.TELEGRAM_CHAT_ID ? String(env.TELEGRAM_CHAT_ID).trim() : '';
  const kv = env.NOTIFY_KV;

  if (!botToken || !chatId) {
    return { notified: false, reason: 'missing_credentials' };
  }

  if (isUnreliableCloudErrorTelemetry(data)) {
    return { notified: false, reason: 'cloud_error' };
  }

  return withKvSerialization(kv, async () => {
    // Зчитуємо збережений стан з KV (з урахуванням свіжішого локального стану при eventual consistency)
    let state = {
      isOutage: false,
      outageStart: null,
      outageStartTimestampSec: null,
      notifiedLevels: [],
      lastNotifiedThreshold: null,
      lastOutageDurMin: 0,
      updatedAtMs: 0
    };

    if (kv) {
      try {
        const stored = await kv.get('notification_state', { type: 'json' });
        if (stored) {
          state = typeof stored === 'string' ? JSON.parse(stored) : stored;
        }
      } catch (e) {
        console.error('Failed to read notification_state from KV:', e);
      }
      const memState = latestStateByKv.get(kv);
      if (memState && (memState.updatedAtMs || 0) > (state.updatedAtMs || 0)) {
        state = { ...memState };
      }
    }

    if (!Array.isArray(state.notifiedLevels)) {
      state.notifiedLevels = [];
    }
    if (!Array.isArray(state.sentAlerts)) {
      state.sentAlerts = [];
    }

    const persistState = async (nextState) => {
      nextState.updatedAtMs = Date.now();
      if (kv) {
        latestStateByKv.set(kv, { ...nextState, notifiedLevels: [...nextState.notifiedLevels], sentAlerts: [...nextState.sentAlerts] });
        try {
          await kv.put('notification_state', JSON.stringify(nextState));
        } catch (e) {
          console.error('Failed to save notification_state to KV:', e);
        }
      }
    };

    const isGridOn = Boolean(data.is_grid_on);
    const currentSoc = Number.isFinite(data.battery_soc) ? data.battery_soc : 100;
    let stateChanged = false;

    // 1. Сценарій: Мережа відсутня (робота на батареї)
    if (!isGridOn) {
      if (!state.isOutage) {
        state.isOutage = true;
        state.outageStart = data.current_outage?.start || data.updated_at || null;
        state.outageStartTimestampSec = data.current_outage?.startTimestampSec || nowUtcSec();
        state.outageStartSoc = currentSoc;
        state.notifiedLevels = computeInitialNotifiedLevels(currentSoc);
        state.sentAlerts = [];
        state.lastNotifiedThreshold = null;
        stateChanged = true;
      } else if (!state.outageStart && data.current_outage?.startTimestampSec) {
        state.outageStart = data.current_outage.start || state.outageStart;
        state.outageStartTimestampSec = data.current_outage.startTimestampSec;
        stateChanged = true;
      }

      const reachedThresholds = findReachedThresholds(currentSoc, state.notifiedLevels);

      if (reachedThresholds.length > 0) {
        const targetThreshold = reachedThresholds[reachedThresholds.length - 1];
        const elapsedMin = state.outageStartTimestampSec
          ? Math.max(0, Math.round((nowUtcSec() - state.outageStartTimestampSec) / 60))
          : null;
        const msg = formatThresholdMessage(targetThreshold, data, elapsedMin);
        const sent = await sendTelegramMessage(botToken, chatId, msg);
        if (sent) {
          for (const t of reachedThresholds) {
            if (!state.notifiedLevels.includes(t)) {
              state.notifiedLevels.push(t);
            }
          }
          state.sentAlerts.push(targetThreshold);
          state.lastNotifiedThreshold = targetThreshold;
          stateChanged = true;
        }
      }

      if (stateChanged) {
        await persistState(state);
      }
    }
    // 2. Сценарій: Мережа відновлена (робота від міста)
    else if (state.isOutage) {
      const hadDischargeAlerts = Boolean(state.sentAlerts && state.sentAlerts.length > 0);
      const nowSec = nowUtcSec();
      const outageKey = String(state.outageStartTimestampSec || state.outageStart || '');
      const isDuplicateRestore = Boolean(
        outageKey &&
        state.lastRestoredOutageKey === outageKey &&
        (nowSec - (state.lastRestorationSentSec || 0)) < RESTORATION_DEDUP_WINDOW_SEC
      );

      const durMin = resolveRestoredOutageDurationMin(data, state, nowSec);

      // Спочатку фіксуємо скидання стану в KV, і лише потім шлемо повідомлення (запобігає гонці/дублям)
      state.isOutage = false;
      state.outageStart = null;
      state.outageStartTimestampSec = null;
      state.outageStartSoc = null;
      state.notifiedLevels = [];
      state.sentAlerts = [];
      state.lastNotifiedThreshold = null;
      state.lastOutageDurMin = durMin;
      if (hadDischargeAlerts && !isDuplicateRestore) {
        state.lastRestoredOutageKey = outageKey;
        state.lastRestorationSentSec = nowSec;
      }
      stateChanged = true;
      await persistState(state);

      if (hadDischargeAlerts && !isDuplicateRestore) {
        const msg = formatRestorationMessage(data, durMin);
        await sendTelegramMessage(botToken, chatId, msg);
      }
    }

    return { notified: stateChanged, state };
  });
}
