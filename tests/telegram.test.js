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

    // 2. Blackout starts: SOC drops to 89% (above 80% threshold -> no message yet)
    sentMessages.length = 0;
    const res2 = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 89,
      est_hours_formatted: '7 – 8 год',
      est_time_until: 'до 03:00',
      use_power_kw: 5.0,
      current_outage: { durationMin: 45, startTimestampSec: Math.floor(Date.now() / 1000) - 2700 }
    }, env);
    assert.equal(sentMessages.length, 0);
    assert.deepEqual(res2.state.notifiedLevels, []);

    // 3. SOC drops to 79% (crosses 80%) -> notifies 80%!
    sentMessages.length = 0;
    const res3 = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 79,
      est_hours_formatted: '6 – 7 год',
      est_time_until: 'до 02:30',
      use_power_kw: 5.0,
      current_outage: { durationMin: 70, startTimestampSec: Math.floor(Date.now() / 1000) - 4200 }
    }, env);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('79%'));
    assert.deepEqual(res3.state.notifiedLevels, [80]);

    // 4. Next tick: SOC is 78% -> 80% is already notified, no new message!
    sentMessages.length = 0;
    const res4 = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 78,
      est_hours_formatted: '6 – 7 год',
      use_power_kw: 5.0
    }, env);
    assert.equal(sentMessages.length, 0);

    // 5. SOC drops to 59% (crosses 60%) -> notifies 60%!
    sentMessages.length = 0;
    const res5 = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 59,
      est_hours_formatted: '4 – 5 год',
      use_power_kw: 5.0
    }, env);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('59%'));
    assert.deepEqual(res5.state.notifiedLevels, [80, 60]);

    // 6. Grid restores! Since we had notifications, send restoration alert with exact journal duration!
    sentMessages.length = 0;
    const res6 = await processTelegramNotifications({
      is_grid_on: true,
      battery_soc: 59,
      use_power_kw: 5.0,
      charge_power_kw: 10.0,
      journal: {
        validEvents: [
          { durationMin: 260 }
        ]
      }
    }, env);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Міську електромережу відновлено'));
    assert.ok(sentMessages[0].text.includes('4 год 20 хв'));
    assert.equal(res6.state.isOutage, false);
    assert.deepEqual(res6.state.notifiedLevels, []);

    // 6. Micro-sag (10 min at 100% SOC) -> no threshold crossed, no restoration alert on restore!
    sentMessages.length = 0;
    await processTelegramNotifications({ is_grid_on: false, battery_soc: 100 }, env);
    assert.equal(sentMessages.length, 0); // No alert
    await processTelegramNotifications({ is_grid_on: true, battery_soc: 100 }, env);
    assert.equal(sentMessages.length, 0); // No restoration spam

    // 7. Sustained outage (e.g. 40 min) with battery staying above first threshold (97% > 80%)
    // -> Must NOT send restoration alert because no threshold alert was ever sent to the group
    sentMessages.length = 0;
    await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 97,
      current_outage: { start: '08:50', durationMin: 40 }
    }, env);
    assert.equal(sentMessages.length, 0, 'No threshold message sent when SOC is 97% (above 80%)');

    const res7 = await processTelegramNotifications({
      is_grid_on: true,
      battery_soc: 97,
      use_power_kw: 5.0,
      charge_power_kw: 6.0,
      journal: { validEvents: [{ durationMin: 40 }] }
    }, env);
    assert.equal(sentMessages.length, 0, 'Must NOT send restoration message if no threshold alert was sent');
    assert.equal(res7.state.isOutage, false);

    // 8. Outage starts at intermediate SOC (e.g. 63% - today's real bug scenario!)
    // -> MUST NOT send threshold 80% message with "63% щойно"!
    sentMessages.length = 0;
    const res8a = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 63,
      current_outage: { start: '20:30', durationMin: 1 }
    }, env);
    assert.equal(sentMessages.length, 0, 'Must be silent on start at 63% (do NOT catch up 80% threshold)');
    assert.deepEqual(res8a.state.notifiedLevels, [80]);
    assert.deepEqual(res8a.state.sentAlerts, []);

    // Next tick: battery drops to 62% -> still above 60%, silent!
    sentMessages.length = 0;
    await processTelegramNotifications({ is_grid_on: false, battery_soc: 62 }, env);
    assert.equal(sentMessages.length, 0);

    // Next tick: battery reaches 60% -> fires 60% threshold!
    sentMessages.length = 0;
    const res8b = await processTelegramNotifications({ is_grid_on: false, battery_soc: 60 }, env);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('60%'));
    assert.deepEqual(res8b.state.notifiedLevels, [80, 60]);
    assert.deepEqual(res8b.state.sentAlerts, [60]);

    // Grid restores -> restoration message sent because 60% was alerted!
    sentMessages.length = 0;
    const res8c = await processTelegramNotifications({
      is_grid_on: true,
      battery_soc: 60,
      journal: { validEvents: [{ durationMin: 50 }] }
    }, env);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Міську електромережу відновлено'));
    assert.equal(res8c.state.isOutage, false);

    // 9. Sudden multi-threshold jump (e.g. 65% -> 38%, skipping 60% and landing in 40%)
    // -> Must prioritize the most critical reached threshold (40% with elevator warning!)
    sentMessages.length = 0;
    const res9a = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 65,
      current_outage: { start: '21:00', durationMin: 10 }
    }, env);
    assert.equal(sentMessages.length, 0); // 80 pre-filtered, 65 > 60

    sentMessages.length = 0;
    const res9b = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 38
    }, env);
    assert.equal(sentMessages.length, 1);
    // Crucial: Must deliver the elevator warning from the 40% threshold!
    assert.ok(sentMessages[0].text.includes('Ліфти будуть відключені'));
    assert.deepEqual(res9b.state.notifiedLevels, [80, 60, 40]);
    assert.deepEqual(res9b.state.sentAlerts, [40]);

    // Next tick at 37%: no duplicate message!
    sentMessages.length = 0;
    await processTelegramNotifications({ is_grid_on: false, battery_soc: 37 }, env);
    assert.equal(sentMessages.length, 0);

    // 10. Battery bounce / chemical relaxation (60% -> 61% -> 59%)
    // -> Must NOT re-trigger 60% when battery recovers slightly under light load
    sentMessages.length = 0;
    // Restore grid first
    await processTelegramNotifications({ is_grid_on: true, battery_soc: 100 }, env);
    // Start outage
    await processTelegramNotifications({ is_grid_on: false, battery_soc: 85 }, env);
    // Drops to 60%
    sentMessages.length = 0;
    await processTelegramNotifications({ is_grid_on: false, battery_soc: 60 }, env);
    assert.equal(sentMessages.length, 1);
    // Bounces to 61%
    sentMessages.length = 0;
    await processTelegramNotifications({ is_grid_on: false, battery_soc: 61 }, env);
    assert.equal(sentMessages.length, 0);
    // Drops back to 59%
    sentMessages.length = 0;
    await processTelegramNotifications({ is_grid_on: false, battery_soc: 59 }, env);
    assert.equal(sentMessages.length, 0, 'No duplicate 60% notification on bounce');

    // 11. Outage starts at critically low SOC (e.g. 10% cutoff buffer)
    // -> Must immediately send the 10% shutdown alert!
    await processTelegramNotifications({ is_grid_on: true, battery_soc: 100 }, env);
    sentMessages.length = 0;
    const res11 = await processTelegramNotifications({
      is_grid_on: false,
      battery_soc: 10,
      current_outage: { start: '22:00', durationMin: 1 }
    }, env);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].text.includes('Досягнуто захисний поріг інвертора (10%)'));
    assert.deepEqual(res11.state.sentAlerts, [10]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
