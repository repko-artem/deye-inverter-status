import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker, { CONFIG, analyzeMultiDayOutages, buildOutageChart, renderHTML, calculateAutonomy, getFreshTelemetry, globalCache } from '../worker/cloudflare-worker.js';
import { compactHistoryRecord, getPastDaysList, mergeDeviceVoltagesIntoRecords } from '../worker/services/telemetry-service.js';
import { classifyOutageEvent } from '../worker/domain/outages.js';

describe('Outage Journal Analysis (analyzeMultiDayOutages)', () => {
  test('returns empty summary when records array is empty', () => {
    const result = analyzeMultiDayOutages([], new Date());
    assert.equal(result.count, 0);
    assert.deepEqual(result.events, []);
    assert.equal(result.currentOutage, null);
  });

  test('captures short voltage sag events >= 5 minutes (e.g. 2 points of 5 min)', () => {
    const baseTimeSec = 1792060000;
    // 2 points where wirePower is 0 and batteryPower is 2000W (= 10 minutes)
    const records = [
      { dateTime: baseTimeSec, wirePower: 5000, batteryPower: 0, batterySoc: 100 },
      { dateTime: baseTimeSec + 300, wirePower: 0, batteryPower: 2500, batterySoc: 100 },
      { dateTime: baseTimeSec + 600, wirePower: 0, batteryPower: 2600, batterySoc: 99 },
      { dateTime: baseTimeSec + 900, wirePower: 5000, batteryPower: -1000, batterySoc: 99 } // power restored
    ];

    const result = analyzeMultiDayOutages(records, new Date((baseTimeSec + 1200) * 1000));
    assert.equal(result.validEvents.length, 1, '10-minute outage should be captured as voltage sag');
    assert.equal(result.validEvents[0].eventType, 'VOLTAGE_SAG');
    assert.equal(result.validEvents[0].durationMin, 10);
  });

  test('captures completed outages longer than 10 minutes', () => {
    const baseTimeSec = 1792060000;
    // 3 points of 5 min = 15 minutes outage
    const records = [
      { dateTime: baseTimeSec, wirePower: 5000, batteryPower: 0, batterySoc: 100 },
      { dateTime: baseTimeSec + 300, wirePower: 0, batteryPower: 3000, batterySoc: 100 },
      { dateTime: baseTimeSec + 600, wirePower: 0, batteryPower: 3200, batterySoc: 98 },
      { dateTime: baseTimeSec + 900, wirePower: 0, batteryPower: 3100, batterySoc: 96 },
      { dateTime: baseTimeSec + 1200, wirePower: 5000, batteryPower: -2000, batterySoc: 96 } // restored
    ];

    const result = analyzeMultiDayOutages(records, new Date((baseTimeSec + 1500) * 1000));
    assert.equal(result.validEvents.length, 1);
    const event = result.validEvents[0];
    assert.equal(event.durationMin, 15);
    assert.equal(event.startSoc, 100);
    assert.equal(event.minSoc, 96);
  });

  test('correctly flags ongoing blackout as isOngoing=true', () => {
    const baseTimeSec = 1792060000;
    const records = [
      { dateTime: baseTimeSec, wirePower: 5000, batteryPower: 0, batterySoc: 100 },
      { dateTime: baseTimeSec + 300, wirePower: 0, batteryPower: 3500, batterySoc: 100 },
      { dateTime: baseTimeSec + 600, wirePower: 0, batteryPower: 3700, batterySoc: 99 } // active now
    ];

    const result = analyzeMultiDayOutages(records, new Date((baseTimeSec + 650) * 1000));
    assert.notEqual(result.currentOutage, null);
    assert.equal(result.currentOutage.isOngoing, true);
    assert.equal(result.currentOutage.durationMin, 10);
  });

  test('accurately calculates duration by wall-clock timestamps when telemetry points are missing', () => {
    const baseTimeSec = 1793522100; // 08:35
    // 8h 10m later = 490 min = 29400 sec => 16:45
    const endTimeSec = baseTimeSec + 29400;
    // Simulate packet loss: 95 points recorded across a 490-minute blackout
    const records = [
      { dateTime: baseTimeSec, wirePower: 0, batteryPower: 4000, batterySoc: 100 },
      ...Array(94).fill({ dateTime: baseTimeSec + 300, wirePower: 0, batteryPower: 4000, batterySoc: 50 }),
      { dateTime: endTimeSec, wirePower: 5000, batteryPower: -2000, batterySoc: 50 } // restored at 16:45
    ];

    const result = analyzeMultiDayOutages(records, new Date((endTimeSec + 60) * 1000));
    assert.equal(result.validEvents.length, 1);
    const event = result.validEvents[0];
    assert.equal(event.durationMin, 490, 'Duration must be 490 minutes (8h 10m), not 475 min (7h 55m)');
  });

  test('calculates socDrain property on outage events', () => {
    const baseTimeSec = 1792060000;
    const records = [
      { dateTime: baseTimeSec, wirePower: 5000, batteryPower: 0, batterySoc: 100 },
      { dateTime: baseTimeSec + 300, wirePower: 0, batteryPower: 3000, batterySoc: 100 },
      { dateTime: baseTimeSec + 600, wirePower: 0, batteryPower: 3200, batterySoc: 95 },
      { dateTime: baseTimeSec + 900, wirePower: 0, batteryPower: 3100, batterySoc: 92 },
      { dateTime: baseTimeSec + 1200, wirePower: 5000, batteryPower: -2000, batterySoc: 92 }
    ];

    const result = analyzeMultiDayOutages(records, new Date((baseTimeSec + 1500) * 1000));
    assert.equal(result.validEvents.length, 1);
    const event = result.validEvents[0];
    assert.equal(event.startSoc, 100);
    assert.equal(event.minSoc, 92);
    assert.equal(event.socDrain, 8);
  });
});

describe('Chart & HTML Rendering', () => {
  test('buildOutageChart returns chart calculations with SVG path coordinates', () => {
    const baseTimeSec = 1792060000;
    const records = [
      { dateTime: baseTimeSec, wirePower: 0, batteryPower: 3000, usePower: 3000, batterySoc: 100 },
      { dateTime: baseTimeSec + 300, wirePower: 0, batteryPower: 4500, usePower: 4500, batterySoc: 98 },
      { dateTime: baseTimeSec + 600, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 96 }
    ];
    const event = { startIndex: 0, endIndex: 2, durationMin: 15, isOngoing: false };
    const chart = buildOutageChart(event, records, 1);

    assert.ok(chart, 'Chart object should be returned');
    assert.ok(chart.pathD.startsWith('M '), 'Should contain SVG path coordinates');
    assert.ok(chart.areaD.startsWith('M '), 'Should contain SVG area coordinates');
    assert.equal(chart.peakKw, '4.5');
    assert.equal(chart.avgKw, '3.7');
  });

  test('renderHTML produces clean HTML containing expected metrics without leaks', () => {
    const mockData = {
      updated_at: '14:30',
      battery_soc: 85,
      battery_voltage: 645.2,
      is_grid_on: false,
      is_charging: false,
      use_power_kw: 4.8,
      charge_power_kw: 0.0,
      discharge_power_kw: 4.8,
      grid_power_kw: 0.0,
      est_hours_formatted: '9 – 14 год',
      est_time_until: '23:30',
      full_est_hours_formatted: '15 – 18 год',
      stat_active_kw: '4.8',
      stat_night_kw: '2.8',
      discharge_24h_kwh: '15.2',
      discharge_rate_pct: '7.4',
      current_outage: { start: '14:00', durationMin: 30, startSoc: 100, dayLabel: 'Сьогодні' },
      outages: [],
      journal: { count: 1, totalHours24hFormatted: '30 хв', minSoc: 85 }
    };

    const html = renderHTML(mockData);
    assert.ok(html.includes('ОСББ «Новодарницьке»'));
    assert.ok(html.includes('85'));
    assert.ok(html.includes('Відключення світла (з 14:00)'));
    assert.ok(html.includes('Триває 30 хв'));
    assert.ok(html.includes('ЗАЛИШОК АВТОНОМНОСТІ'));
    assert.ok(html.includes('Повний резерв при 100% АКБ'));
    assert.ok(html.includes('Автооновлення кожні 5 хв'));
    assert.ok(html.includes('setTimeout(() => location.reload(), 300000)'));
    assert.ok(!html.includes('undefined'));
    assert.ok(!html.includes('NaN'));
  });
});

describe('Autonomy Estimation (calculateAutonomy)', () => {
  test('uses stable statistical load when grid is active, ignoring transient elevator/pump spikes', () => {
    const soc = 100;
    const is_grid_on = true;
    const use_power_kw = 10.5; // huge transient spike while on grid
    const statActiveKw = 3.3;
    const statNightKw = 2.1;
    const fixedAfternoonDate = new Date('2026-10-20T14:00:00.000Z');

    const result = calculateAutonomy(soc, is_grid_on, use_power_kw, statActiveKw, statNightKw, fixedAfternoonDate);

    // realisticKw must strictly equal statActiveKw (3.3 kW), not 10.5 kW
    assert.equal(result.realisticKw, 3.3);
    assert.equal(result.nightKw, 2.1);
    // Usable energy: 65 kWh * 90% * 90% = 52.65 kWh
    // Conservative active day: 52.65 / 3.3 = 15.95h => 15h
    // Realistic day/night timeline simulation: ~19h (instead of unrealistic 23h)
    assert.equal(result.remH_cons, 15);
    assert.equal(result.remH_opt, 19);
    assert.equal(result.est_hours_formatted, '15 – 19 год');
    assert.equal(result.est_time_until, 'до 08:51 (мінімум до 05:57)');
  });

  test('smooths out motor/elevator spikes during an active blackout with intermittent factor', () => {
    const soc = 100;
    const is_grid_on = false; // blackout
    const use_power_kw = 9.5; // elevator moving
    const statActiveKw = 3.3;
    const statNightKw = 2.1;
    const fixedAfternoonDate = new Date('2026-10-20T14:00:00.000Z');

    const result = calculateAutonomy(soc, is_grid_on, use_power_kw, statActiveKw, statNightKw, fixedAfternoonDate);

    // smoothed: 3.3 + (9.5 - 3.3) * 0.35 = 5.47 kW
    assert.ok(result.realisticKw < 6.0, 'realisticKw should be smoothed down from 9.5 kW');
    assert.ok(result.realisticKw > 3.3, 'realisticKw should reflect the additional load');
    assert.equal(result.remH_cons, 9, 'Should forecast ~9 hours instead of dropping to 5 hours');
  });

  test('returns 0 hours remaining when SOC is at or below safety buffer (10%)', () => {
    const soc = 10;
    const is_grid_on = false;
    const testDate = new Date('2026-10-20T14:00:00.000Z');
    const result = calculateAutonomy(soc, is_grid_on, 3.3, 3.3, 2.1, testDate);

    assert.equal(result.usableKwh, 0);
    assert.equal(result.remH_cons, 0);
    assert.equal(result.remH_opt, 0);
    assert.equal(result.est_hours_formatted, '0 год');
    assert.equal(result.est_time_until, 'до 14:00');
  });

  test('does not duplicate hours or times when conservative and optimistic match', () => {
    // 50% SOC, 4.5 kW day load starting at 12:00 -> exhausts in ~4.5h by 16:30 (all daytime)
    const testDate = new Date('2026-10-20T12:00:00.000Z');
    const result = calculateAutonomy(50, false, 4.5, 4.5, 2.5, testDate);

    assert.equal(result.remH_cons, result.remH_opt);
    assert.doesNotMatch(result.est_hours_formatted, /–/);
    assert.doesNotMatch(result.est_time_until, /мінімум/);
  });

  test('returns all essential estimation fields including hoursConservative', () => {
    const result = calculateAutonomy(80, true, 3.0, 3.5, 2.0);
    assert.equal(typeof result.hoursConservative, 'number');
    assert.ok(result.hoursConservative > 0);
    assert.equal(typeof result.hoursNight, 'number');
    assert.equal(typeof result.est_hours_formatted, 'string');
    assert.equal(typeof result.est_time_until, 'string');
  });
});

describe('Full Telemetry Flow (getFreshTelemetry)', () => {
  test('successfully processes telemetry and computes fields without throwing ReferenceError', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              batterySoc: 100,
              batteryBv: 653.9,
              gridRelayStatus: 'on',
              wirePower: 14500,
              batteryPower: -6400,
              batteryStatus: 'CHARGE',
              usePower: 2500,
              networkStatus: 'NORMAL',
              lastUpdateTime: Math.floor(Date.now() / 1000)
            })
          };
        }
        if (urlStr.includes('/maintain-s/history/batteryPower/')) {
          const nowSec = Math.floor(Date.now() / 1000);
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              records: [
                { dateTime: nowSec - 7200, wirePower: 5000, batteryPower: 0, usePower: 2000, batterySoc: 100 },
                { dateTime: nowSec - 5400, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 98 },
                { dateTime: nowSec - 4800, wirePower: 0, batteryPower: 3600, usePower: 3600, batterySoc: 96 },
                { dateTime: nowSec - 4200, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 94 },
                { dateTime: nowSec - 3600, wirePower: 6000, batteryPower: -2000, usePower: 2200, batterySoc: 95 }
              ]
            })
          };
        }
        return { ok: false, status: 404, text: async () => "{}" };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com'
      };

      const data = await getFreshTelemetry(env);

      // Verify that no internal error occurred (no ReferenceError caught)
      assert.equal(data.worker_error, undefined, `Expected no worker_error, but got: ${data.worker_error}`);
      assert.equal(data.battery_soc, 100, 'Expected real SOC 100%, not the emergency fallback 76%');
      assert.equal(data.is_charging, true);
      assert.equal(typeof data.est_hours_remaining, 'number');
      assert.ok(data.est_hours_remaining > 0);
      assert.equal(typeof data.full_est_hours_formatted, 'string');
      assert.ok(data.journal);
      assert.ok(data.journal.events.length > 0);
      assert.ok(data.outages.length > 0, 'Outage events must be populated');

      // Verify that HTML renders cleanly with this data
      const html = renderHTML(data);
      assert.ok(html.includes('100%'), 'HTML must include 100%');
      assert.ok(!html.includes('undefined'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('correctly flags inverter as offline when telemetry is stale or router disconnected', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              batterySoc: 100,
              batteryBv: 641.3,
              gridRelayStatus: 'on',
              wirePower: 2650,
              batteryPower: 0,
              batteryStatus: 'DISCHARGE',
              usePower: 2650,
              networkStatus: 'OFFLINE',
              // 2 hours ago
              lastUpdateTime: nowSec - 7200
            })
          };
        }
        if (urlStr.includes('/maintain-s/history/batteryPower/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              records: [
                { dateTime: nowSec - 7200, wirePower: 5000, batteryPower: 0, usePower: 2000, batterySoc: 100 }
              ]
            })
          };
        }
        return { ok: false, status: 404, text: async () => "{}" };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com'
      };

      const data = await getFreshTelemetry(env);

      assert.equal(data.is_online, false, 'Must be flagged as offline');
      assert.ok(data.device_offline_minutes >= 115, 'Must report ~120 min offline');
      assert.ok(data.offline_reason.includes("Сигнал відсутній"));
      assert.equal(data.is_charging, false);

      const html = renderHTML(data);
      assert.ok(html.includes('OFFLINE'), 'HTML badge must show OFFLINE');
      assert.ok(html.includes("Немає зв'язку з інвертором"), 'HTML must include clear warning');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('correctly identifies BATTERY_DEPLETED when connection lost with battery <= 10% during blackout', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              batterySoc: 10,
              batteryBv: 606.8,
              gridRelayStatus: 'off',
              wirePower: 0,
              batteryPower: 6980,
              batteryStatus: 'DISCHARGE',
              usePower: 6500,
              networkStatus: 'NORMAL',
              lastUpdateTime: nowSec - 1200 // 20 min ago
            })
          };
        }
        if (urlStr.includes('/maintain-s/history/batteryPower/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              records: [
                { dateTime: nowSec - 1200, wirePower: 0, batteryPower: 6980, usePower: 6500, batterySoc: 10 }
              ]
            })
          };
        }
        return { ok: false, status: 404, text: async () => "{}" };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com'
      };

      const data = await getFreshTelemetry(env);
      assert.equal(data.is_online, false);
      assert.equal(data.offline_type, 'BATTERY_DEPLETED');
      assert.ok(data.offline_reason.includes('Резервне живлення будинку вимкнено інвертором'));

      const html = renderHTML(data);
      assert.ok(html.includes('Резерв батареї вичерпано (10%)'));
      assert.ok(html.includes('Резерв акумулятора повністю вичерпано'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('filters out past outage charts with socDrain <= 1% while preserving ongoing outage', async () => {
    globalCache.clear();
    const originalFetch = globalThis.fetch;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const nowKyiv = new Date(Date.now() + 7200 * 1000);
      const todayQuery = `year=${nowKyiv.getFullYear()}&month=${nowKyiv.getMonth() + 1}&day=${nowKyiv.getDate()}`;

      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              batterySoc: 100,
              batteryBv: 641.3,
              gridRelayStatus: 'off',
              wirePower: 0,
              batteryPower: 3500,
              batteryStatus: 'DISCHARGE',
              usePower: 3500,
              networkStatus: 'ONLINE',
              lastUpdateTime: nowSec
            })
          };
        }
        if (urlStr.includes('/maintain-s/history/batteryPower/')) {
          if (!urlStr.includes(todayQuery)) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ records: [] })
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              records: [
                // Event 1 (past, 15 min): battery stayed 100% -> socDrain: 0 (<= 1%, MUST BE FILTERED)
                { dateTime: nowSec - 9000, wirePower: 5000, batteryPower: 0, usePower: 2000, batterySoc: 100 },
                { dateTime: nowSec - 8100, wirePower: 0, batteryPower: 3000, usePower: 3000, batterySoc: 100 },
                { dateTime: nowSec - 7800, wirePower: 0, batteryPower: 3000, usePower: 3000, batterySoc: 100 },
                { dateTime: nowSec - 7500, wirePower: 0, batteryPower: 3000, usePower: 3000, batterySoc: 100 },
                { dateTime: nowSec - 7200, wirePower: 5000, batteryPower: -2000, usePower: 2000, batterySoc: 100 },
                // Event 1b (past, 15 min): battery 100% -> 99% -> socDrain: 1% (<= 1%, MUST BE FILTERED)
                { dateTime: nowSec - 6300, wirePower: 0, batteryPower: 3000, usePower: 3000, batterySoc: 100 },
                { dateTime: nowSec - 6000, wirePower: 0, batteryPower: 3000, usePower: 3000, batterySoc: 99 },
                { dateTime: nowSec - 5700, wirePower: 0, batteryPower: 3000, usePower: 3000, batterySoc: 99 },
                { dateTime: nowSec - 5400, wirePower: 5000, batteryPower: -2000, usePower: 2000, batterySoc: 99 },
                // Event 2 (past, 20 min): battery 100% -> 98% -> socDrain: 2% (> 1%, MUST BE KEPT)
                { dateTime: nowSec - 4200, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 100 },
                { dateTime: nowSec - 3900, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 99 },
                { dateTime: nowSec - 3600, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 98 },
                { dateTime: nowSec - 3300, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 98 },
                { dateTime: nowSec - 3000, wirePower: 5000, batteryPower: -2000, usePower: 2000, batterySoc: 98 },
                // Event 3 (ongoing, 15 min): battery 100% -> 100% -> socDrain: 0 (<= 1%, MUST BE KEPT BECAUSE ONGOING)
                { dateTime: nowSec - 900, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 100 },
                { dateTime: nowSec - 600, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 100 },
                { dateTime: nowSec - 300, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 100 }
              ]
            })
          };
        }
        return { ok: false, status: 404, text: async () => "{}" };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com'
      };

      const data = await getFreshTelemetry(env);

      // In journal: all 4 events are recorded
      assert.equal(data.journal.events.length, 4);

      // In outage charts: Event 1 (0% drain) & Event 1b (1% drain) omitted, Event 2 (2% drain) & Event 3 (ongoing 0% drain) kept
      assert.equal(data.outages.length, 2, 'Only meaningful past outages (>1%) and ongoing outage should have charts');
      const ongoingChart = data.outages.find(o => o.isOngoing);
      assert.ok(ongoingChart, 'Ongoing outage chart must be preserved even if socDrain <= 1%');
      assert.equal(ongoingChart.socDrain, 0);

      const pastChart = data.outages.find(o => !o.isOngoing);
      assert.ok(pastChart, 'Meaningful past outage must be preserved');
      assert.equal(pastChart.socDrain, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('gracefully handles today history failure without marking inverter offline', async () => {
    globalCache.clear();
    const originalFetch = globalThis.fetch;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              batterySoc: 95,
              batteryBv: 640.0,
              gridRelayStatus: 'on',
              wirePower: 3500,
              batteryPower: 0,
              batteryStatus: 'DISCHARGE',
              usePower: 3500,
              networkStatus: 'NORMAL',
              lastUpdateTime: nowSec
            })
          };
        }
        if (urlStr.includes('/maintain-s/history/batteryPower/')) {
          // Simulate slow/aborted history call
          const err = new Error('перевищено час очікування відповіді (15 сек)');
          err.name = 'AbortError';
          throw err;
        }
        return { ok: false, status: 404, text: async () => "{}" };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com'
      };

      const data = await getFreshTelemetry(env);
      assert.equal(data.is_online, true, 'Inverter must remain online even if history query fails');
      assert.equal(data.battery_soc, 95);
      assert.equal(data.is_grid_on, true);
      assert.equal(data.offline_reason, "");

      const html = renderHTML(data);
      assert.ok(html.includes('LIVE'), 'HTML must show LIVE badge');
      assert.equal(html.includes('OFFLINE'), false, 'HTML must not show OFFLINE badge');
      assert.equal(html.includes('The operation was aborted'), false, 'HTML must never contain raw abort message');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('calculates ongoing outage duration in getFreshTelemetry with pure UTC without 2-hour offset skew', async () => {
    globalCache.clear();
    const originalFetch = globalThis.fetch;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const startOutageSec = nowSec - 30 * 60; // outage started exactly 30 min ago
      const nowKyiv = new Date(Date.now() + 7200 * 1000);
      const todayQuery = `year=${nowKyiv.getFullYear()}&month=${nowKyiv.getMonth() + 1}&day=${nowKyiv.getDate()}`;

      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              batterySoc: 98,
              batteryBv: 641.0,
              gridRelayStatus: 'off',
              wirePower: 0,
              batteryPower: 4500,
              batteryStatus: 'DISCHARGE',
              usePower: 4500,
              networkStatus: 'NORMAL',
              lastUpdateTime: nowSec
            })
          };
        }
        if (urlStr.includes('/maintain-s/history/batteryPower/')) {
          if (!urlStr.includes(todayQuery)) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ records: [] })
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              records: [
                { dateTime: startOutageSec - 300, wirePower: 5000, batteryPower: 0, usePower: 3000, batterySoc: 100 },
                { dateTime: startOutageSec, wirePower: 0, batteryPower: 4500, usePower: 4500, batterySoc: 100 },
                { dateTime: startOutageSec + 300, wirePower: 0, batteryPower: 4500, usePower: 4500, batterySoc: 99 },
                { dateTime: startOutageSec + 600, wirePower: 0, batteryPower: 4500, usePower: 4500, batterySoc: 98 }
              ]
            })
          };
        }
        return { ok: false, status: 404, text: async () => "{}" };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com'
      };

      const data = await getFreshTelemetry(env);
      assert.ok(data.current_outage, 'current_outage must be populated');
      assert.equal(data.current_outage.isOngoing, true);
      // Invariant: Duration must be ~30 min, NEVER ~150 min (+2h)
      assert.ok(
        data.current_outage.durationMin >= 28 && data.current_outage.durationMin <= 32,
        `Expected ~30 min, got ${data.current_outage.durationMin} min`
      );

      const html = renderHTML(data);
      assert.ok(html.includes(`Триває ${data.current_outage.durationMin} хв`));
      assert.equal(html.includes('Триває 2 год'), false, 'HTML must not have phantom 2 hours added to ongoing blackout');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function createMockKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  return {
    store,
    calls,
    async get(key, opts) {
      calls.push({ op: 'get', key });
      const val = store.get(key);
      if (val === undefined) return null;
      if (opts && opts.type === 'json') {
        return typeof val === 'string' ? JSON.parse(val) : val;
      }
      return val;
    },
    async put(key, val) {
      calls.push({ op: 'put', key });
      store.set(key, typeof val === 'string' ? val : JSON.stringify(val));
    }
  };
}

describe('Worker Performance Optimization (KV Caching, SWR & HEAD Requests)', () => {
  test('compactHistoryRecord preserves required telemetry fields and strips bulky unused fields', () => {
    const compacted = compactHistoryRecord({
      dateTime: 1794400000,
      wirePower: 5000,
      batteryPower: -1000,
      usePower: 3200,
      batterySoc: 95,
      dischargePower: 250,
      extraUnusedField: 'huge payload',
      irPower: 0,
      generationPower: 0
    });

    assert.deepEqual(compacted, {
      dateTime: 1794400000,
      wirePower: 5000,
      batteryPower: -1000,
      usePower: 3200,
      batterySoc: 95,
      dischargePower: 250
    });
  });

  test('loads past-day history from NOTIFY_KV without calling Deye API for cached past days and does not call device-list', async () => {
    globalCache.clear();
    const originalFetch = globalThis.fetch;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const pastDays = getPastDaysList(nowSec);
      const preCachedPastHistory = {};
      for (const pd of pastDays) {
        preCachedPastHistory[pd.key] = [
          { dateTime: nowSec - pd.offset * 86400, wirePower: 5000, batteryPower: 0, usePower: 2200, batterySoc: 100 }
        ];
      }

      const kv = createMockKV({
        history_past_days: JSON.stringify(preCachedPastHistory)
      });

      const fetchedUrls = [];
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        fetchedUrls.push(urlStr);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              batterySoc: 100,
              batteryBv: 650.0,
              gridRelayStatus: 'on',
              wirePower: 5000,
              batteryPower: 0,
              batteryStatus: 'STANDBY',
              usePower: 2500,
              networkStatus: 'NORMAL',
              lastUpdateTime: nowSec
            })
          };
        }
        if (urlStr.includes('/maintain-s/history/batteryPower/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              records: [{ dateTime: nowSec - 300, wirePower: 5000, batteryPower: 0, usePower: 2500, batterySoc: 100 }]
            })
          };
        }
        return { ok: false, status: 404, text: async () => '{}' };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com',
        NOTIFY_KV: kv
      };

      const data = await getFreshTelemetry(env);
      assert.equal(data.battery_soc, 100);
      // Only 2 HTTP calls: station/display + today's history (no 7 past-day calls and no device-list call)
      assert.equal(fetchedUrls.length, 2, `Expected exactly 2 HTTP requests, got ${fetchedUrls.length}: ${fetchedUrls.join(', ')}`);
      assert.equal(fetchedUrls.some(u => u.includes('device-list')), false, 'Should not fetch unused device-list');
      assert.equal(data.debug_info.daysFetched.length, 0, 'No past days should be fetched from HTTP when present in KV');

      // Telemetry snapshot must be persisted to KV
      const savedSnap = await kv.get('telemetry_snapshot', { type: 'json' });
      assert.ok(savedSnap && savedSnap.data && savedSnap.timestamp, 'telemetry_snapshot must be saved to KV');
      assert.equal(savedSnap.data.battery_soc, 100);
    } finally {
      globalThis.fetch = originalFetch;
      globalCache.clear();
    }
  });

  test('persists newly fetched past-day history into NOTIFY_KV when KV history cache misses', async () => {
    globalCache.clear();
    const originalFetch = globalThis.fetch;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const kv = createMockKV();

      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              batterySoc: 98,
              batteryBv: 648.0,
              gridRelayStatus: 'on',
              wirePower: 4000,
              batteryPower: 0,
              usePower: 2000,
              networkStatus: 'NORMAL',
              lastUpdateTime: nowSec
            })
          };
        }
        if (urlStr.includes('/maintain-s/history/batteryPower/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              records: [{
                dateTime: nowSec - 300,
                wirePower: 4000,
                batteryPower: 0,
                usePower: 2000,
                batterySoc: 98,
                extraUnusedBlob: 'should-be-stripped'
              }]
            })
          };
        }
        return { ok: false, status: 404, text: async () => '{}' };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com',
        NOTIFY_KV: kv
      };

      const data = await getFreshTelemetry(env);
      assert.equal(data.debug_info.daysFetched.length, 7, 'All 7 missing past days should be fetched once');

      const savedPast = await kv.get('history_past_days', { type: 'json' });
      assert.ok(savedPast && Object.keys(savedPast).length === 7, 'All 7 past days must be cached in KV');
      const firstKey = Object.keys(savedPast)[0];
      assert.equal(savedPast[firstKey][0].extraUnusedBlob, undefined, 'Compacted history records must strip unused fields');
    } finally {
      globalThis.fetch = originalFetch;
      globalCache.clear();
    }
  });

  test('cold isolate serves KV telemetry_snapshot via SWR and refreshes in background via ctx.waitUntil', async () => {
    globalCache.clear();
    const originalFetch = globalThis.fetch;
    try {
      const staleSnapshotData = {
        updated_at: '14:00',
        battery_soc: 88,
        battery_voltage: 644.0,
        is_online: true,
        is_grid_on: true,
        is_charging: false,
        use_power_kw: 4.0,
        charge_power_kw: 0,
        discharge_power_kw: 0,
        grid_power_kw: 4.0,
        est_hours_formatted: '10 год',
        est_time_until: 'до 00:00',
        full_est_hours_formatted: '12 год',
        stat_active_kw: '4.0',
        stat_night_kw: '3.0',
        discharge_24h_kwh: '0.0',
        discharge_rate_pct: '0',
        outages: [],
        journal: { count: 0, totalHours24hFormatted: '0 хв', minSoc: 100 }
      };

      // 2 minutes old (> 60s TTL, < 5m SWR max age)
      const kv = createMockKV({
        telemetry_snapshot: JSON.stringify({
          timestamp: Date.now() - 120 * 1000,
          data: staleSnapshotData
        })
      });

      let fetchCalls = 0;
      globalThis.fetch = async (url) => {
        fetchCalls++;
        const urlStr = String(url);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              batterySoc: 99,
              batteryBv: 651.0,
              gridRelayStatus: 'on',
              wirePower: 5000,
              batteryPower: 0,
              usePower: 2500,
              networkStatus: 'NORMAL',
              lastUpdateTime: Math.floor(Date.now() / 1000)
            })
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ records: [] }) };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com',
        NOTIFY_KV: kv
      };

      const backgroundPromises = [];
      const ctx = {
        waitUntil(p) {
          backgroundPromises.push(p);
        }
      };

      const res = await worker.fetch(new Request('https://power.osbbnd.workers.dev/api/status'), env, ctx);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.battery_soc, 88, 'Should immediately serve stale KV snapshot on cold start');
      assert.ok(backgroundPromises.length >= 1, 'Should schedule background SWR refresh via ctx.waitUntil');

      await Promise.all(backgroundPromises);
      assert.ok(fetchCalls >= 1, 'Background SWR task should fetch fresh data from Deye API');
      assert.equal(globalCache.getRecent().battery_soc, 99, 'In-memory cache should be updated by background refresh');
    } finally {
      globalThis.fetch = originalFetch;
      globalCache.clear();
    }
  });

  test('HEAD requests return 200 OK with empty body and normalize cache.put key to GET', async () => {
    globalCache.clear();
    const originalCaches = globalThis.caches;
    const putKeys = [];

    try {
      globalCache.setRecent({
        updated_at: '14:20',
        battery_soc: 100,
        battery_voltage: 653.0,
        is_online: true,
        is_grid_on: true,
        is_charging: false,
        use_power_kw: 3.5,
        charge_power_kw: 0,
        discharge_power_kw: 0,
        grid_power_kw: 3.5,
        est_hours_formatted: '12 год',
        est_time_until: 'до 02:20',
        full_est_hours_formatted: '12 год',
        stat_active_kw: '3.5',
        stat_night_kw: '2.5',
        discharge_24h_kwh: '0.0',
        discharge_rate_pct: '0',
        outages: [],
        journal: { count: 0, totalHours24hFormatted: '0 хв', minSoc: 100 }
      }, Date.now());

      globalThis.caches = {
        default: {
          async match() { return undefined; },
          async put(reqKey) {
            if (reqKey.method !== 'GET') {
              throw new TypeError(`Cannot put a ${reqKey.method} request into the cache`);
            }
            putKeys.push({ url: reqKey.url, method: reqKey.method });
          }
        }
      };

      const backgroundPromises = [];
      const ctx = { waitUntil(p) { backgroundPromises.push(p); } };
      const env = { DEYE_TOKEN: 't', DEYE_STATION_ID: 's' };

      const headHtmlRes = await worker.fetch(new Request('https://power.osbbnd.workers.dev/', { method: 'HEAD' }), env, ctx);
      assert.equal(headHtmlRes.status, 200);
      assert.equal(await headHtmlRes.text(), '');

      const headApiRes = await worker.fetch(new Request('https://power.osbbnd.workers.dev/api/status', { method: 'HEAD' }), env, ctx);
      assert.equal(headApiRes.status, 200);
      assert.equal(await headApiRes.text(), '');

      await Promise.all(backgroundPromises);
      assert.deepEqual(putKeys, [
        { url: 'https://power.osbbnd.workers.dev/', method: 'GET' },
        { url: 'https://power.osbbnd.workers.dev/api/status', method: 'GET' }
      ]);
    } finally {
      globalThis.caches = originalCaches;
      globalCache.clear();
    }
  });

  test('throttles telemetry_snapshot KV writes within SNAPSHOT_KV_INTERVAL_MS unless system_state transitions', async () => {
    globalCache.clear();
    const originalFetch = globalThis.fetch;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const historyDays = getPastDaysList(nowSec, CONFIG.CACHE.HISTORY_DAYS);
      const preCachedPast = {};
      for (const pd of historyDays) {
        preCachedPast[pd.key] = [{ dateTime: nowSec - 86400, wirePower: 5000, batteryPower: 0, usePower: 2500, batterySoc: 100 }];
      }

      const kv = createMockKV({
        history_past_days: JSON.stringify(preCachedPast),
        telemetry_snapshot: JSON.stringify({
          timestamp: Date.now() - 2 * 60 * 1000, // Only 2 min ago (< 20m interval)
          data: { system_state: 'GRID_STANDBY' }
        })
      });

      let gridOnMode = true;
      globalThis.fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/maintain-s/station/display/')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(gridOnMode ? {
              batterySoc: 100,
              batteryBv: 652.0,
              gridRelayStatus: 'on',
              wirePower: 4500,
              batteryPower: 0,
              usePower: 4000,
              networkStatus: 'NORMAL',
              lastUpdateTime: Math.floor(Date.now() / 1000)
            } : {
              batterySoc: 98,
              batteryBv: 645.0,
              gridRelayStatus: 'off',
              wirePower: 0,
              batteryPower: 7500,
              usePower: 7500,
              networkStatus: 'NORMAL',
              lastUpdateTime: Math.floor(Date.now() / 1000)
            })
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ records: [] }) };
      };

      const env = {
        DEYE_TOKEN: 'mock-token',
        DEYE_STATION_ID: 'mock-station',
        DEYE_API_BASE: 'https://mock.deye.com',
        NOTIFY_KV: kv
      };

      // 1. Steady-state GRID_ON within 20m -> must SKIP telemetry_snapshot kv.put
      await getFreshTelemetry(env);
      let snapshotWrites = kv.calls.filter(c => c.op === 'put' && c.key === 'telemetry_snapshot').length;
      assert.equal(snapshotWrites, 0, 'Must skip KV snapshot write within SNAPSHOT_KV_INTERVAL_MS when state unchanged');

      // 2. Repeated poll on warm isolate -> still skips KV write AND skips extra KV read
      const readsBefore = kv.calls.filter(c => c.op === 'get' && c.key === 'telemetry_snapshot').length;
      await getFreshTelemetry(env);
      const readsAfter = kv.calls.filter(c => c.op === 'get' && c.key === 'telemetry_snapshot').length;
      snapshotWrites = kv.calls.filter(c => c.op === 'put' && c.key === 'telemetry_snapshot').length;
      assert.equal(snapshotWrites, 0, 'Repeated warm poll must still skip KV snapshot write');
      assert.equal(readsAfter, readsBefore, 'Warm isolate must not re-read telemetry_snapshot from KV');

      // 3. State transition GRID_ON -> OUTAGE -> must write telemetry_snapshot immediately
      gridOnMode = false;
      await getFreshTelemetry(env);
      snapshotWrites = kv.calls.filter(c => c.op === 'put' && c.key === 'telemetry_snapshot').length;
      assert.equal(snapshotWrites, 1, 'Must immediately persist telemetry_snapshot on system_state transition');
    } finally {
      globalThis.fetch = originalFetch;
      globalCache.clear();
    }
  });
});

describe('3-Phase Voltage Tracking & Outage Cause Classification', () => {
  test('mergeDeviceVoltagesIntoRecords aligns 5-min collectionTime offsets onto stats/daily records', () => {
    const bucket0 = 1794580200; // divisible by 300
    const bucket1 = 1794580500;
    const records = [
      { dateTime: bucket0, wirePower: 5000, batteryPower: 0, usePower: 2500, batterySoc: 100 },
      { dateTime: bucket1, wirePower: 0, batteryPower: 3500, usePower: 3500, batterySoc: 99 }
    ];

    const seriesList = [
      {
        storageName: 'G_V_L1',
        detailList: [
          { collectionTime: bucket0 + 78, value: 239.44 },
          { collectionTime: bucket1 + 84, value: 241.23 }
        ]
      },
      {
        storageName: 'G_V_L2',
        detailList: [
          { collectionTime: bucket0 + 78, value: 255.12 },
          { collectionTime: bucket1 + 84, value: 258.64 }
        ]
      },
      {
        storageName: 'G_V_L3',
        detailList: [
          { collectionTime: bucket0 + 78, value: 240.1 },
          { collectionTime: bucket1 + 84, value: 242.0 }
        ]
      },
      {
        storageName: 'C_V_L1',
        detailList: [{ collectionTime: bucket1 + 84, value: 232.1 }]
      },
      {
        storageName: 'C_V_L2',
        detailList: [{ collectionTime: bucket1 + 84, value: 232.4 }]
      },
      {
        storageName: 'C_V_L3',
        detailList: [{ collectionTime: bucket1 + 84, value: 231.9 }]
      }
    ];

    const latest = mergeDeviceVoltagesIntoRecords(records, seriesList);
    assert.equal(records[0].v1, 239.4);
    assert.equal(records[0].v2, 255.1);
    assert.equal(records[1].v2, 258.6);
    assert.equal(records[1].lv2, 232.4);
    assert.deepEqual(latest.grid, { l1: 241.2, l2: 258.6, l3: 242, ts: bucket1 + 84 });
    assert.deepEqual(latest.load, { l1: 232.1, l2: 232.4, l3: 231.9, ts: bucket1 + 84 });
  });

  test('analyzeMultiDayOutages distinguishes 0V blackout, >255V overvoltage (even >25m), and <195V undervoltage', () => {
    const t0 = 1794570000;
    const records = [
      // Normal grid before Event 1
      { dateTime: t0, wirePower: 5000, batteryPower: 0, batterySoc: 100, v1: 235, v2: 242, v3: 238 },
      // Event 1: Overvoltage on L2 lasting 35 minutes (8 ticks * 5m = 35m), never drops to 0V
      ...Array.from({ length: 8 }, (_, i) => ({
        dateTime: t0 + (i + 1) * 300,
        wirePower: 0,
        batteryPower: 3500,
        usePower: 3500,
        batterySoc: 100 - Math.floor(i / 2),
        v1: 240,
        v2: i === 2 ? 258.6 : 251.2,
        v3: 241
      })),
      // Recovery
      { dateTime: t0 + 9 * 300, wirePower: 6000, batteryPower: -2000, batterySoc: 96, v1: 236, v2: 245, v3: 239 },
      // Event 2: Undervoltage on L3 (191.4V) for 15 min
      { dateTime: t0 + 10 * 300, wirePower: 0, batteryPower: 3200, usePower: 3200, batterySoc: 97, v1: 214, v2: 218, v3: 191.4 },
      { dateTime: t0 + 11 * 300, wirePower: 0, batteryPower: 3200, usePower: 3200, batterySoc: 96, v1: 215, v2: 219, v3: 199.8 },
      { dateTime: t0 + 12 * 300, wirePower: 0, batteryPower: 3200, usePower: 3200, batterySoc: 95, v1: 216, v2: 220, v3: 202.1 },
      { dateTime: t0 + 13 * 300, wirePower: 6000, batteryPower: -2000, batterySoc: 95, v1: 222, v2: 225, v3: 210 },
      // Event 3: Real DTEK 0V blackout (10 min - short, but clearly 0V on all phases!)
      { dateTime: t0 + 14 * 300, wirePower: 0, batteryPower: 4000, usePower: 4000, batterySoc: 96, v1: 0, v2: 0, v3: 0 },
      { dateTime: t0 + 15 * 300, wirePower: 0, batteryPower: 4000, usePower: 4000, batterySoc: 95, v1: 0, v2: 0, v3: 0 },
      { dateTime: t0 + 16 * 300, wirePower: 6000, batteryPower: -2000, batterySoc: 95, v1: 231, v2: 232, v3: 230 }
    ];

    const journal = analyzeMultiDayOutages(records, new Date((t0 + 17 * 300) * 1000));
    assert.equal(journal.validEvents.length, 3);

    const [evOver, evUnder, evBlackout] = journal.validEvents;
    assert.equal(evOver.eventType, 'VOLTAGE_SAG');
    assert.equal(evOver.voltageCause, 'OVERVOLTAGE');
    assert.ok(evOver.eventLabel.includes('Завищена напруга (L2: 259 В)'), `Got: ${evOver.eventLabel}`);

    assert.equal(evUnder.eventType, 'VOLTAGE_SAG');
    assert.equal(evUnder.voltageCause, 'UNDERVOLTAGE');
    assert.ok(evUnder.eventLabel.includes('Занижена напруга (L3: 191 В)'), `Got: ${evUnder.eventLabel}`);

    assert.equal(evBlackout.eventType, 'BLACKOUT');
    assert.equal(evBlackout.voltageCause, 'BLACKOUT');
    assert.ok(evBlackout.eventLabel.includes('0 В'), `Got: ${evBlackout.eventLabel}`);
  });

  test('renderHTML renders 3-phase grid voltages bar and overvoltage banner cleanly', () => {
    const html = renderHTML({
      version: '1.6.0',
      updated_at: '16:15',
      battery_soc: 96,
      battery_voltage: 649.1,
      is_grid_on: false,
      is_charging: false,
      use_power_kw: 4.5,
      charge_power_kw: 0,
      discharge_power_kw: 4.5,
      grid_power_kw: 0,
      grid_voltages: { l1: 241.2, l2: 255.4, l3: 240.8 },
      load_voltages: { l1: 232.0, l2: 232.2, l3: 231.8 },
      est_hours_formatted: '11 год',
      est_time_until: 'до 03:15',
      full_est_hours_formatted: '12 год',
      stat_active_kw: '4.5',
      stat_night_kw: '3.0',
      discharge_24h_kwh: '4.2',
      discharge_rate_pct: '6.9',
      current_outage: {
        start: '16:05',
        durationMin: 15,
        startSoc: 100,
        voltageCause: 'OVERVOLTAGE',
        maxPhase: 'L2',
        maxGridV: 255.4
      },
      outages: [],
      journal: { count: 1, blackoutCount24h: 0, voltageSagCount24h: 1, totalHours24hFormatted: '15 хв', minSoc: 96 }
    });

    assert.ok(html.includes('Захист від перенапруги (з 16:05)'));
    assert.ok(html.includes('Напруга міської мережі (вхід)') || html.includes('Напруга міської мережі (по фазах)'));
    assert.ok(html.includes('L1'));
    assert.ok(html.includes('255'));
    assert.ok(html.includes('~232 В'));
    assert.ok(!html.includes('undefined'));
    assert.ok(!html.includes('NaN'));
  });
});
