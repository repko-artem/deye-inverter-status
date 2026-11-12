import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  nowUtcSec, 
  formatKyivTime, 
  formatKyivDate, 
  getKyivHour, 
  formatKyivDayLabel,
  getKyivOffsetSec
} from '../worker/domain/time.js';
import { analyzeMultiDayOutages } from '../worker/domain/outages.js';

test('Clean Time Architecture: Core Invariants', async (t) => {
  await t.test('nowUtcSec returns current valid epoch seconds within 5 seconds of Date.now()', () => {
    const sec = nowUtcSec();
    const expected = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(sec - expected) <= 2, `Expected ${expected}, got ${sec}`);
  });

  await t.test('formatKyivTime formats UTC timestamps to Europe/Kyiv time across winter (UTC+2) and summer (UTC+3)', () => {
    // 2026-11-11 19:25:00 UTC -> 21:25 Kyiv (winter UTC+2)
    const winterSec = Math.floor(new Date('2026-11-11T19:25:00Z').getTime() / 1000);
    assert.equal(formatKyivTime(winterSec), '21:25');

    // 2026-07-15 18:25:00 UTC -> 21:25 Kyiv (summer UTC+3)
    const summerSec = Math.floor(new Date('2026-07-15T18:25:00Z').getTime() / 1000);
    assert.equal(formatKyivTime(summerSec), '21:25');
  });

  await t.test('formatKyivDate formats UTC timestamps to Europe/Kyiv calendar date across midnight rollover', () => {
    // 2026-11-11 22:30:00 UTC -> 2026-11-12 00:30 Kyiv (next calendar day in Kyiv!)
    const rolloverSec = Math.floor(new Date('2026-11-11T22:30:00Z').getTime() / 1000);
    assert.equal(formatKyivDate(rolloverSec), '2026-11-12');
    assert.equal(formatKyivTime(rolloverSec), '00:30');
  });

  await t.test('getKyivHour extracts true local hour in Kyiv', () => {
    const winterSec = Math.floor(new Date('2026-11-11T19:25:00Z').getTime() / 1000);
    assert.equal(getKyivHour(winterSec), 21);

    const morningSec = Math.floor(new Date('2026-11-11T05:00:00Z').getTime() / 1000);
    assert.equal(getKyivHour(morningSec), 7);
  });

  await t.test('formatKyivDayLabel maps labels accurately', () => {
    assert.equal(formatKyivDayLabel('2026-11-12', '2026-11-12', '2026-11-11', '2026-11-10'), 'Сьогодні');
    assert.equal(formatKyivDayLabel('2026-11-11', '2026-11-12', '2026-11-11', '2026-11-10'), 'Вчора');
    assert.equal(formatKyivDayLabel('2026-11-10', '2026-11-12', '2026-11-11', '2026-11-10'), 'Позавчора');
    assert.equal(formatKyivDayLabel('2026-11-04', '2026-11-12', '2026-11-11', '2026-11-10'), '04.11');
  });

  await t.test('analyzeMultiDayOutages stores pure UTC timestamps matching duration without timezone drift', () => {
    // Outage from 21:25 to 01:45 UTC (260 minutes)
    const startSec = 1794425100; // 21:25 Kyiv (19:25 UTC)
    const endSec = startSec + 260 * 60; // 01:45 Kyiv
    const records = [
      { dateTime: startSec, wirePower: 0, batteryPower: 4500, batterySoc: 100 },
      ...Array(51).fill(null).map((_, i) => ({
        dateTime: startSec + (i + 1) * 300,
        wirePower: 0,
        batteryPower: 4500,
        batterySoc: 100 - i
      })),
      { dateTime: endSec, wirePower: 5000, batteryPower: -2000, batterySoc: 44 } // restored
    ];

    const result = analyzeMultiDayOutages(records, endSec + 60);
    assert.equal(result.validEvents.length, 1);
    const ev = result.validEvents[0];

    // Invariant 1: startTimestampSec is real pure UTC
    assert.equal(ev.startTimestampSec, startSec);
    assert.equal(ev.endTimestampSec, endSec);

    // Invariant 2: Mathematical exactness between timestamps and duration
    assert.equal(ev.endTimestampSec - ev.startTimestampSec, ev.durationMin * 60);
    assert.equal(ev.durationMin, 260);

    // Invariant 3: UI time formatting matches Kyiv clock
    assert.equal(ev.start, '21:25');
    assert.equal(ev.end, '01:45');
  });

  await t.test('analyzeMultiDayOutages calculates accurate ongoing duration in pure UTC', () => {
    const startSec = 1794466200; // 08:50 Kyiv (06:50 UTC)
    const currentUtc = startSec + 34 * 60; // 34 minutes later (07:24 UTC)
    const records = [
      { dateTime: startSec, wirePower: 0, batteryPower: 4500, batterySoc: 100 },
      { dateTime: startSec + 300, wirePower: 0, batteryPower: 4500, batterySoc: 99 },
      { dateTime: startSec + 600, wirePower: 0, batteryPower: 4500, batterySoc: 98 }
    ];

    const result = analyzeMultiDayOutages(records, currentUtc);
    assert.ok(result.currentOutage);
    assert.equal(result.currentOutage.isOngoing, true);
    assert.equal(result.currentOutage.durationMin, 34);
    assert.equal(result.currentOutage.start, '08:50');
  });
});
