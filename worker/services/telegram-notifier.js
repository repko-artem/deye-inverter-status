/**
 * Сервіс сповіщень у закриту Telegram-групу ОСББ "Новодарницьке".
 * Відповідає за порогові сповіщення розряду батарей (90%, 80%, 70%... 10%)
 * та сповіщення про відновлення міської електромережі.
 */

export const NOTIFICATION_THRESHOLDS = Object.freeze([90, 80, 70, 60, 50, 40, 30, 20, 10]);

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
export function formatThresholdMessage(threshold, data) {
  const soc = data.battery_soc ?? threshold;
  const estHours = data.est_hours_formatted || '--';
  const estUntil = data.est_time_until || '--';
  const useKw = Number(data.use_power_kw || 0).toFixed(1);
  const outage = data.current_outage;
  const durStr = outage && outage.durationMin > 0
    ? (outage.durationMin >= 60 
        ? `${Math.floor(outage.durationMin / 60)} год ${outage.durationMin % 60 ? `${outage.durationMin % 60} хв` : ''}`.trim()
        : `${outage.durationMin} хв`)
    : 'щойно';

  const icon = threshold === 40 ? '🛗' : (threshold <= 10 ? '🚨' : (threshold <= 20 ? '⚠️' : (threshold <= 50 ? '🪫' : '🔋')));

  let footerNote = '';
  if (threshold === 10) {
    footerNote = '\n\n🛑 <b>Увага:</b> Досягнуто захисний поріг інвертора (10%). Резервне живлення відключається для збереження ресурсу акумуляторів.';
  } else if (threshold === 40) {
    footerNote = '\n\n🛗 <b>УВАГА МЕШКАНЦЯМ: Ліфти будуть відключені!</b>\nРівень заряду акумуляторів знизився до 40%. Згідно з регламентом енергозбереження, ліфти відключаються, щоб гарантувати тривалу роботу насосів опалення та водопостачання будинку. Будь ласка, користуйтеся сходами!';
  } else if (threshold <= 20) {
    footerNote = '\n\n⚠️ <i>Критичний рівень заряду. Працюють виключно насоси опалення, водопостачання та чергове освітлення.</i>';
  }

  return `${icon} <b>Рівень заряду батареї: ${threshold}%</b> (фактично ${soc}%)

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

  const durStr = previousOutageDurMin && previousOutageDurMin > 0
    ? (previousOutageDurMin >= 60 
        ? `${Math.floor(previousOutageDurMin / 60)} год ${previousOutageDurMin % 60 ? `${previousOutageDurMin % 60} хв` : ''}`.trim()
        : `${previousOutageDurMin} хв`)
    : null;

  return `🟢 <b>Міську електромережу відновлено!</b>

🔋 Поточний заряд акумулятора: <b>${soc}%</b>${Number(chargeKw) > 0.5 ? ` (зарядка +${chargeKw} кВт)` : ''}
⚡ Споживання будинку: <b>${useKw} кВт</b>${durStr ? `\n⏱ Відключення тривало: <b>${durStr}</b>` : ''}

🌐 <a href="https://power.osbbnd.workers.dev">Статус енергопостачання онлайн</a>`;
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

  // Зчитуємо збережений стан з KV (або дефолт)
  let state = {
    isOutage: false,
    outageStart: null,
    outageStartTimestampSec: null,
    notifiedLevels: [],
    lastNotifiedThreshold: null,
    lastOutageDurMin: 0
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
  }

  if (!Array.isArray(state.notifiedLevels)) {
    state.notifiedLevels = [];
  }

  const isGridOn = Boolean(data.is_grid_on);
  const currentSoc = Number.isFinite(data.battery_soc) ? data.battery_soc : 100;
  let stateChanged = false;

  // 1. Сценарій: Мережа відсутня (робота на батареї)
  if (!isGridOn) {
    if (!state.isOutage) {
      state.isOutage = true;
      state.outageStart = data.current_outage?.start || data.updated_at || null;
      state.outageStartTimestampSec = data.current_outage?.startTimestampSec || Math.floor(Date.now() / 1000);
      state.notifiedLevels = [];
      state.lastNotifiedThreshold = null;
      stateChanged = true;
    }

    // Шукаємо пороги розряду (від 90 до 10)
    for (const threshold of NOTIFICATION_THRESHOLDS) {
      if (currentSoc <= threshold && !state.notifiedLevels.includes(threshold)) {
        // Відправляємо сповіщення про цей поріг
        const msg = formatThresholdMessage(threshold, data);
        const sent = await sendTelegramMessage(botToken, chatId, msg);
        if (sent) {
          state.notifiedLevels.push(threshold);
          state.lastNotifiedThreshold = threshold;
          stateChanged = true;
          // Відправляємо по одному повідомленню за раз (найвищий несповіщений поріг)
          break;
        }
      }
    }
  } 
  // 2. Сценарій: Мережа відновлена (робота від міста)
  else {
    if (state.isOutage) {
      // Якщо під час відключення було надіслано хоча б одне порогове сповіщення
      // (тобто це був реальний блекаут, а не 10-хвилинний мікро-стрибок без розряду)
      const hadDischargeAlerts = (state.notifiedLevels && state.notifiedLevels.length > 0);
      const nowSec = Math.floor(Date.now() / 1000);
      const durMin = state.outageStartTimestampSec
        ? Math.max(1, Math.round((nowSec - state.outageStartTimestampSec) / 60))
        : (data.journal?.validEvents?.[data.journal.validEvents.length - 1]?.durationMin || 0);

      if (hadDischargeAlerts || durMin >= 20) {
        const msg = formatRestorationMessage(data, durMin);
        await sendTelegramMessage(botToken, chatId, msg);
      }

      state.isOutage = false;
      state.outageStart = null;
      state.outageStartTimestampSec = null;
      state.notifiedLevels = [];
      state.lastNotifiedThreshold = null;
      state.lastOutageDurMin = durMin;
      stateChanged = true;
    }
  }

  // Зберігаємо оновлений стан в KV
  if (kv && stateChanged) {
    try {
      await kv.put('notification_state', JSON.stringify(state));
    } catch (e) {
      console.error('Failed to save notification_state to KV:', e);
    }
  }

  return { notified: stateChanged, state };
}
