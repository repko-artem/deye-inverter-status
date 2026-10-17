import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMultiDayOutages, buildOutageChart, renderHTML } from '../worker/cloudflare-worker.js';

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
