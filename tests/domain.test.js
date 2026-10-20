import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../worker/config.js';
import { VERSION } from '../worker/version.js';
import { isOutageRecord, calculateDischargeRate, calculate24hDischarge, simulateTimelineAutonomy } from '../worker/domain/autonomy.js';
import { calculateOutageStatistics } from '../worker/domain/outages.js';
import { TelemetryCache } from '../worker/services/cache.js';
import { DeyeClient } from '../worker/services/deye-client.js';

describe('Domain: Autonomy & Outage Detection (DRY / SRP)', () => {
  test('isOutageRecord correctly detects outage conditions and filters grid power', () => {
    assert.equal(isOutageRecord(null), false);
    assert.equal(isOutageRecord({ wirePower: 5000, batteryPower: 2000 }), false, 'Grid is active');
    assert.equal(isOutageRecord({ wirePower: 0, batteryPower: 150 }), false, 'Below 300W noise threshold');
    assert.equal(isOutageRecord({ wirePower: 0, batteryPower: 350 }), true, 'Outage with battery power > 300W');
    assert.equal(isOutageRecord({ wirePower: 0, dischargePower: 500 }), true, 'Outage with discharge power > 300W');
  });

  test('calculateDischargeRate calculates physical DC rate and formats subtext', () => {
    // 6.5 kW discharge on a 65 kWh battery is exactly 10% / hour
    const rate = calculateDischargeRate(0, 6.5);
    assert.equal(rate.ratePct, '10.0');
    assert.ok(rate.subtext.includes('~6.5 кВт'));

    // When dischargePowerKw is 0, converts AC usePowerKw using 0.92 efficiency
    const rateAc = calculateDischargeRate(4.6, 0);
    // 4.6 / 0.92 = 5.0 kW => (5.0 / 65) * 100 = 7.7%
    assert.equal(rateAc.ratePct, '7.7');
  });

  test('calculate24hDischarge aggregates energy exclusively during blackouts', () => {
    const records = [
      { wirePower: 5000, batteryPower: 0, usePower: 3000 },
      // 12 points of 5 min = 1 hour blackout at 3000 W = 3.0 kWh
      ...Array(12).fill({ wirePower: 0, batteryPower: 3000, usePower: 3000 }),
      { wirePower: 5000, batteryPower: -2000, usePower: 2000 }
    ];

    const totalKwh = calculate24hDischarge(records);
    assert.equal(totalKwh, '3.0');
  });

  test('calculateOutageStatistics computes separate day and night averages', () => {
    const kyivOffsetSec = CONFIG.TIME.KYIV_OFFSET_SEC;
    // Create day points (e.g. 14:00 Kyiv = 11:00 UTC) at 4000 W
    const daySec = 1792060000;
    // Create night points (e.g. 02:00 Kyiv = 23:00 UTC) at 2000 W
    const records = [
      { dateTime: 1792065600, wirePower: 0, batteryPower: 4000, usePower: 4000 }, // 14:00
      { dateTime: 1792065900, wirePower: 0, batteryPower: 4000, usePower: 4000 },
      { dateTime: 1792066200, wirePower: 0, batteryPower: 4000, usePower: 4000 },
      { dateTime: 1792108800, wirePower: 0, batteryPower: 2000, usePower: 2000 }, // 02:00
      { dateTime: 1792109100, wirePower: 0, batteryPower: 2000, usePower: 2000 },
      { dateTime: 1792109400, wirePower: 0, batteryPower: 2000, usePower: 2000 }
    ];

    const stats = calculateOutageStatistics(records);
    assert.equal(typeof stats.statActiveKw, 'number');
    assert.equal(typeof stats.statNightKw, 'number');
    assert.ok(stats.statActiveKw > 0);
    assert.ok(stats.statNightKw > 0);
  });

  test('simulateTimelineAutonomy calculates realistic day/night combined transition', () => {
    // 49.725 kWh usable energy, starts at 14:00 (Kyiv hour 14)
    // 14:00 to 23:00 = 9h day @ 3.3 kW = 29.7 kWh
    // Remaining = 20.025 kWh
    // 23:00 to 07:00 = 8h night @ 2.1 kW = 16.8 kWh
    // Remaining = 3.225 kWh
    // 07:00 onwards = day @ 3.3 kW => 3.225 / 3.3 = 0.98h
    // Total = ~17.98h => Math.round is 18h
    const startDate = new Date('2026-10-20T14:00:00.000Z');
    const sim = simulateTimelineAutonomy(49.725, startDate, 3.3, 2.1);

    assert.ok(sim.hours > 17.5 && sim.hours < 18.5, `Expected ~18h, got ${sim.hours}`);
    assert.equal(Math.round(sim.hours), 18);
    assert.ok(sim.endDate instanceof Date);
  });
});

describe('Services: TelemetryCache (Anti-stampede & TTL)', () => {
  test('returns fresh cached data within TTL without calling fetcher', async () => {
    const cache = new TelemetryCache(5000);
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      return { val: 42 };
    };

    const first = await cache.getOrFetch(fetcher);
    assert.equal(first.val, 42);
    assert.equal(fetchCount, 1);

    const second = await cache.getOrFetch(fetcher);
    assert.equal(second.val, 42);
    assert.equal(fetchCount, 1, 'Should NOT call fetcher second time within TTL');
  });

  test('deduplicates concurrent fetches into a single promise', async () => {
    const cache = new TelemetryCache(5000);
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      await new Promise(r => setTimeout(r, 20));
      return { val: 100 };
    };

    // Launch two requests concurrently
    const [res1, res2] = await Promise.all([
      cache.getOrFetch(fetcher),
      cache.getOrFetch(fetcher)
    ]);

    assert.equal(res1.val, 100);
    assert.equal(res2.val, 100);
    assert.equal(fetchCount, 1, 'Concurrent requests must be coalesced into single fetch');
  });
});

describe('Services: DeyeClient (API & Error Handling)', () => {
  test('strips HTML error page when API fails and throws informative error', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => ({
        status: 502,
        text: async () => '<html><body><style>body{color:red;}</style><h1>Bad Gateway</h1></body></html>'
      });

      const client = new DeyeClient('https://mock.deye.com', 'test-token', '12345');
      await assert.rejects(
        () => client.getStationDisplay(),
        /Deye API HTTP 502: Bad Gateway/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('System Versioning (SemVer)', () => {
  test('VERSION follows valid Semantic Versioning format (X.Y.Z)', () => {
    const semVerRegex = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
    assert.match(VERSION, semVerRegex, `VERSION "${VERSION}" must match SemVer format`);
  });

  test('worker/version.js is synchronized with package.json', () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    assert.equal(VERSION, pkg.version, 'worker/version.js must match package.json version');
    assert.equal(CONFIG.APP_VERSION, VERSION, 'CONFIG.APP_VERSION must match VERSION');
  });
});
