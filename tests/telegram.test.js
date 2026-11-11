import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  NOTIFICATION_THRESHOLDS,
  formatThresholdMessage,
  formatRestorationMessage,
  processTelegramNotifications
} from '../worker/services/telegram-notifier.js';

test('Telegram Notification: formatting', async (t) => {
  await t.test('formatThresholdMessage includes SOC, autonomy, and load', () => {
    const data = {
      battery_soc: 89,
      est_hours_formatted: '6 – 7 год',
      est_time_until: 'до 02:40',
      use_power_kw: 5.2,
      current_outage: { durationMin: 75 }
    };

    const msg = formatThresholdMessage(90, data);
    assert.ok(msg.includes('Рівень заряду батареї: 89%</b>'));
    assert.ok(msg.includes('~6 – 7 год'));
    assert.ok(msg.includes('5.2 кВт'));
    assert.ok(msg.includes('1 год 15 хв'));
    assert.ok(msg.includes('https://power.osbbnd.workers.dev'));
  });

  await t.test('formatThresholdMessage includes elevator warning at <= 20%', () => {
    const data = {
      battery_soc: 20,
      est_hours_formatted: '1 – 2 год',
      est_time_until: 'до 21:30',
      use_power_kw: 4.8,
      current_outage: { durationMin: 300 }
    };

    const msg = formatThresholdMessage(20, data);
    assert.ok(msg.includes('⚠️'));
    assert.ok(msg.includes('Критичний рівень заряду'));
  });

  await t.test('formatThresholdMessage includes elevator shutdown warning at 40%', () => {
    const data = {
      battery_soc: 40,
      est_hours_formatted: '3 – 4 год',
      est_time_until: 'до 01:15',
      use_power_kw: 4.8,
      current_outage: { durationMin: 220 }
    };

    const msg = formatThresholdMessage(40, data);
    assert.ok(msg.includes('40%'));
    assert.ok(msg.includes('🛗'));
    assert.ok(msg.includes('Ліфти будуть відключені'));
  });

  await t.test('formatThresholdMessage includes shutdown warning at 10%', () => {
    const data = {
      battery_soc: 10,
      est_hours_formatted: '0 год',
      est_time_until: 'зараз',
      use_power_kw: 4.5,
      current_outage: { durationMin: 420 }
    };

    const msg = formatThresholdMessage(10, data);
    assert.ok(msg.includes('🛑'));
    assert.ok(msg.includes('Досягнуто захисний поріг інвертора (10%)'));
  });

  await t.test('formatRestorationMessage includes duration and charge rate', () => {
    const data = {
      battery_soc: 68,
      use_power_kw: 5.5,
      charge_power_kw: 12.0
    };

    const msg = formatRestorationMessage(data, 135);
    assert.ok(msg.includes('🟢 <b>Міську електромережу відновлено!</b>'));
    assert.ok(msg.includes('68%'));
    assert.ok(msg.includes('зарядка +12.0 кВт'));
    assert.ok(msg.includes('2 год 15 хв'));
  });
});

test('Telegram Notification: processTelegramNotifications workflow', async (t) => {
  // In-memory mock KV
  const createMockKv = () => {
    const store = new Map();
    return {
      async get(key, type) {
        const val = store.get(key);
        if (!val) return null;
        return type === 'json' ? JSON.parse(val) : val;
      },
      async put(key, val) {
        store.set(key, typeof val === 'string' ? val : JSON.stringify(val));
      }
    };
  };

  const originalFetch = globalThis.fetch;

  try {
    const sentMessages = [];
    globalThis.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('api.telegram.org')) {
        const body = JSON.parse(options.body);
        sentMessages.push(body);
        return { ok: true, status: 200, text: async () => '{"ok":true}' };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    };

    const mockKv = createMockKv();
    const env = {
      TELEGRAM_BOT_TOKEN: 'mock-bot-token',
      TELEGRAM_CHAT_ID: '-100mock',
      NOTIFY_KV: mockKv
    };

    // 1. Grid is ON, normal operation -> no notifications
    sentMessages.length = 0;
    const res1 = await processTelegramNotifications({ is_grid_on: true, battery_soc: 100 }, env);
    assert.equal(sentMessages.length, 0);

    // 2. Blackout starts: SOC drops to 89% (crosses 90%)
    sentMessages.length = 0;
    const res2 = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 89,
      est_hours_formatted: '7 – 8 год',
      est_time_until: 'до 03:00',
      use_power_kw: 5.0,
      current_outage: { durationMin: 45, startTimestampSec: Math.floor(Date.now() / 1000) - 2700 }
    }, env);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('89%'));
    assert.deepEqual(res2.state.notifiedLevels, [90]);

    // 3. Next tick: SOC is 88% -> 90% is already notified, no new message!
    sentMessages.length = 0;
    const res3 = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 88,
      est_hours_formatted: '7 – 8 год',
      use_power_kw: 5.0
    }, env);
    assert.equal(sentMessages.length, 0);

    // 4. SOC drops to 79% (crosses 80%) -> notifies 80%!
    sentMessages.length = 0;
    const res4 = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 79,
      est_hours_formatted: '6 – 7 год',
      use_power_kw: 5.0
    }, env);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('79%'));
    assert.deepEqual(res4.state.notifiedLevels, [90, 80]);

    // 5. Grid restores! Since we had notifications, send restoration alert!
    sentMessages.length = 0;
    const res5 = await processTelegramNotifications({
      is_grid_on: true,
      battery_soc: 79,
      use_power_kw: 5.0,
      charge_power_kw: 10.0
    }, env);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Міську електромережу відновлено'));
    assert.equal(res5.state.isOutage, false);
    assert.deepEqual(res5.state.notifiedLevels, []);

    // 6. Micro-sag (10 min at 100% SOC) -> no threshold crossed, no restoration alert on restore!
    sentMessages.length = 0;
    await processTelegramNotifications({ is_grid_on: false, battery_soc: 100 }, env);
    assert.equal(sentMessages.length, 0); // No alert
    await processTelegramNotifications({ is_grid_on: true, battery_soc: 100 }, env);
    assert.equal(sentMessages.length, 0); // No restoration spam
  } finally {
    globalThis.fetch = originalFetch;
  }
});
