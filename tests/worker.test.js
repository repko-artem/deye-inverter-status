import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMultiDayOutages, buildOutageChart, renderHTML, calculateAutonomy, getFreshTelemetry } from '../worker/cloudflare-worker.js';

describe('Outage Journal Analysis (analyzeMultiDayOutages)', () => {
  test('returns empty summary when records array is empty', () => {
    const result = analyzeMultiDayOutages([], new Date());
    assert.equal(result.count, 0);
    assert.deepEqual(result.events, []);
    assert.equal(result.currentOutage, null);
  });

  test('filters out short outages <= 10 minutes (2 points of 5 min)', () => {
    const baseTimeSec = 1792060000;
    // 2 points where wirePower is 0 and batteryPower is 2000W (= 10 minutes)
    const records = [
      { dateTime: baseTimeSec, wirePower: 5000, batteryPower: 0, batterySoc: 100 },
      { dateTime: baseTimeSec + 300, wirePower: 0, batteryPower: 2500, batterySoc: 100 },
      { dateTime: baseTimeSec + 600, wirePower: 0, batteryPower: 2600, batterySoc: 99 },
      { dateTime: baseTimeSec + 900, wirePower: 5000, batteryPower: -1000, batterySoc: 99 } // power restored
    ];

    const result = analyzeMultiDayOutages(records, new Date((baseTimeSec + 1200) * 1000));
    assert.equal(result.validEvents.length, 0, '10-minute outage should be filtered out (>10 min required)');
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

    const result = calculateAutonomy(soc, is_grid_on, use_power_kw, statActiveKw, statNightKw);

    // realisticKw must strictly equal statActiveKw (3.3 kW), not 10.5 kW
    assert.equal(result.realisticKw, 3.3);
    assert.equal(result.nightKw, 2.1);
    // Usable energy: 65 kWh * 85% * 90% = 49.725 kWh
    // Conservative active day: 49.725 / 3.3 = 15.06h => 15h
    // Realistic day/night timeline simulation: ~18h (instead of unrealistic 23h)
    assert.equal(result.remH_cons, 15);
    assert.equal(result.remH_opt, 18);
    assert.equal(result.est_hours_formatted, '15 – 18 год');
  });

  test('smooths out motor/elevator spikes during an active blackout with intermittent factor', () => {
    const soc = 100;
    const is_grid_on = false; // blackout
    const use_power_kw = 9.5; // elevator moving
    const statActiveKw = 3.3;
    const statNightKw = 2.1;

    const result = calculateAutonomy(soc, is_grid_on, use_power_kw, statActiveKw, statNightKw);

    // smoothed: 3.3 + (9.5 - 3.3) * 0.35 = 5.47 kW
    assert.ok(result.realisticKw < 6.0, 'realisticKw should be smoothed down from 9.5 kW');
    assert.ok(result.realisticKw > 3.3, 'realisticKw should reflect the additional load');
    // 49.725 / 5.47 = ~9.09h => 9h (instead of dropping to 5h!)
    assert.equal(result.remH_cons, 9, 'Should forecast ~9 hours instead of dropping to 5 hours');
  });

  test('returns 0 hours remaining when SOC is at or below safety buffer (15%)', () => {
    const soc = 14;
    const is_grid_on = false;
    const result = calculateAutonomy(soc, is_grid_on, 3.3, 3.3, 2.1);

    assert.equal(result.usableKwh, 0);
    assert.equal(result.remH_cons, 0);
    assert.equal(result.remH_opt, 0);
    assert.equal(result.est_hours_formatted, '0 – 0 год');
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
      assert.ok(data.offline_reason.includes("Немає зв'язку з інвертором"));
      assert.equal(data.is_charging, false);

      const html = renderHTML(data);
      assert.ok(html.includes('OFFLINE'), 'HTML badge must show OFFLINE');
      assert.ok(html.includes("Немає зв'язку з інвертором"), 'HTML must include clear warning');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
