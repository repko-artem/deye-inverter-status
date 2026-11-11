import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSystemState, SystemStateId } from '../worker/domain/system-state.js';

describe('Domain: System State Machine (FSM / State Pattern)', () => {
  test('resolves to GRID_STANDBY when grid is on, battery is full/idle and not charging', () => {
    const data = {
      is_online: true,
      is_grid_on: true,
      is_charging: false,
      battery_soc: 100,
      battery_voltage: 645.0
    };
    const state = resolveSystemState(data);
    assert.equal(state.id, SystemStateId.GRID_STANDBY);
    assert.equal(state.isOnline, true);
    assert.equal(state.badgeText, 'LIVE');
    assert.equal(state.bannerIcon, '🟢');
    assert.ok(state.bannerTitle.includes('Міська мережа активна'));
    assert.ok(state.bannerSubtitle.includes('Батарея в режимі очікування'));
    assert.ok(state.tipHtml.includes('повністю заряджений'));
  });

  test('resolves to GRID_CHARGING when grid is on and battery is actively charging', () => {
    const data = {
      is_online: true,
      is_grid_on: true,
      is_charging: true,
      battery_soc: 45,
      battery_voltage: 615.2,
      charge_power_kw: 6.2
    };
    const state = resolveSystemState(data);
    assert.equal(state.id, SystemStateId.GRID_CHARGING);
    assert.equal(state.isOnline, true);
    assert.equal(state.badgeText, 'LIVE');
    assert.equal(state.bannerIcon, '⚡');
    assert.ok(state.bannerTitle.includes('Заряд АКБ'));
    assert.ok(state.bannerSubtitle.includes('+6.2 кВт'));
    assert.ok(state.tipHtml.includes('заряджається високою потужністю'));
  });

  test('resolves to BLACKOUT_BATTERY during an active blackout with remaining charge (> 10%)', () => {
    const data = {
      is_online: true,
      is_grid_on: false,
      is_charging: false,
      battery_soc: 65,
      current_outage: {
        start: '17:10',
        durationMin: 120,
        startSoc: 90
      }
    };
    const state = resolveSystemState(data);
    assert.equal(state.id, SystemStateId.BLACKOUT_BATTERY);
    assert.equal(state.isOnline, true);
    assert.equal(state.badgeText, 'LIVE');
    assert.equal(state.bannerIcon, '🔴');
    assert.ok(state.bannerTitle.includes('Відключення світла (з 17:10)'));
    assert.ok(state.bannerSubtitle.includes('Триває 2 год'));
    assert.ok(state.bannerSubtitle.includes('Старт із 90%'));
    assert.ok(state.tipHtml.includes('Будинок перейшов на резервне живлення від батареї'));
  });

  test('resolves to BLACKOUT_BATTERY with VOLTAGE_SAG checking state during initial phase (<= 15 min, minimal drain)', () => {
    const data = {
      is_online: true,
      is_grid_on: false,
      is_charging: false,
      battery_soc: 100,
      current_outage: {
        start: '14:10',
        durationMin: 8,
        startSoc: 100,
        socDrain: 0,
        isInitialPhase: true
      }
    };
    const state = resolveSystemState(data);
    assert.equal(state.id, SystemStateId.BLACKOUT_BATTERY);
    assert.equal(state.bannerIcon, '⚡');
    assert.ok(state.bannerTitle.includes('Резервне живлення • Перевірка мережі (з 14:10)'));
    assert.ok(state.bannerSubtitle.includes('Можливий стрибок напруги'));
    assert.ok(state.tipHtml.includes('Захист інвертора'));
  });

  test('resolves to BATTERY_DEPLETED when grid is off and battery reaches safety buffer (<= 10%)', () => {
    const data = {
      is_online: false,
      is_grid_on: false,
      is_charging: false,
      battery_soc: 10,
      offline_type: 'BATTERY_DEPLETED',
      device_last_seen: 'сьогодні о 22:10'
    };
    const state = resolveSystemState(data, { safetyBufferSoc: 10 });
    assert.equal(state.id, SystemStateId.BATTERY_DEPLETED);
    assert.equal(state.isOnline, false);
    assert.equal(state.badgeText, 'OFFLINE');
    assert.equal(state.bannerIcon, '🪫');
    assert.ok(state.bannerTitle.includes('Резерв батареї вичерпано (10%)'));
    assert.ok(state.tipHtml.includes('досягнуто безпечний поріг 10%'));
    assert.ok(state.tipHtml.includes('Інвертор автоматично знеструмив будинок'));
  });

  test('resolves to LOGGER_OFFLINE when telemetry is lost but battery is healthy or grid was active', () => {
    const data = {
      is_online: false,
      is_grid_on: true,
      battery_soc: 85,
      offline_type: 'DEVICE_OFFLINE',
      device_last_seen: 'сьогодні о 14:00'
    };
    const state = resolveSystemState(data);
    assert.equal(state.id, SystemStateId.LOGGER_OFFLINE);
    assert.equal(state.isOnline, false);
    assert.equal(state.badgeText, 'OFFLINE');
    assert.equal(state.bannerIcon, '📡');
    assert.ok(state.bannerTitle.includes("Немає зв'язку з інвертором"));
    assert.ok(state.tipHtml.includes("Втрачено інтернет-зв'язок із даталогером"));
  });

  test('resolves to CLOUD_ERROR when Deye Cloud API fails or is unreachable', () => {
    const data = {
      is_online: false,
      offline_type: 'CLOUD_ERROR',
      offline_reason: 'Сервер Deye Cloud тимчасово не відповів (перевищено час очікування)'
    };
    const state = resolveSystemState(data);
    assert.equal(state.id, SystemStateId.CLOUD_ERROR);
    assert.equal(state.isOnline, false);
    assert.equal(state.bannerIcon, '☁️');
    assert.ok(state.bannerTitle.includes('Сервер Deye Cloud не відповідає'));
    assert.ok(state.tipHtml.includes('Сервер моніторингу Deye Cloud тимчасово не відповідає'));
  });
});
