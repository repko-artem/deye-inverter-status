/**
 * Cloudflare Worker для публічної сторінки статусу ОСББ "Новодарницьке".
 * Архітектура: Controller / HTTP Router, що зв'язує доменні сервіси та презентаційний шар.
 */

import { CONFIG } from './config.js';
import { VERSION } from './version.js';
import { globalCache } from './services/cache.js';
import { TelemetryService } from './services/telemetry-service.js';
import { renderHTML } from './ui/template.js';
import { calculateAutonomy, isOutageRecord, calculateDischargeRate, calculate24hDischarge, simulateTimelineAutonomy } from './domain/autonomy.js';
import { analyzeMultiDayOutages, calculateOutageStatistics } from './domain/outages.js';
import { buildOutageChart } from './ui/chart.js';
import { resolveSystemState, SystemStateId, SystemState } from './domain/system-state.js';
import { processTelegramNotifications } from './services/telegram-notifier.js';

/**
 * Отримання телеметрії з багаторівневим кешуванням (Memory + KV Snapshot + SWR).
 * Кожен запит виконує fetch у власному I/O контексті (без спільного Promise між запитами),
 * щоб виключити помилку 1101 (handle_cross_request_promise_resolution) у Cloudflare Workers.
 */
async function getCachedTelemetry(env, ctx, isBypass = false) {
  if (!isBypass && globalCache.isFresh()) {
    return globalCache.getRecent();
  }

  const runLocalFetch = async () => {
    globalCache.markRefreshStart();
    try {
      const service = new TelemetryService(env, globalCache, CONFIG);
      const fresh = await service.getTelemetry();
      if (!globalCache.isFresh()) {
        globalCache.setRecent(fresh);
      }
      return fresh;
    } finally {
      globalCache.markRefreshEnd();
    }
  };

  const scheduleBackgroundRefresh = () => {
    if (ctx && ctx.waitUntil && !globalCache.isRefreshing()) {
      ctx.waitUntil(runLocalFetch().catch(err => console.error('SWR refresh error:', err)));
    }
  };

  if (!isBypass) {
    const swrMaxAgeMs = CONFIG.CACHE.SWR_MAX_AGE_MS || 300000;
    const recent = globalCache.getRecent();
    if (recent && (globalCache.getAgeSec() * 1000) < swrMaxAgeMs) {
      scheduleBackgroundRefresh();
      return recent;
    }

    if (!recent && env && env.NOTIFY_KV) {
      try {
        const snap = await env.NOTIFY_KV.get('telemetry_snapshot', { type: 'json' });
        globalCache.setKvSnapshotMeta(snap?.timestamp || 0, snap?.data?.system_state || null);
        if (snap && snap.data && snap.timestamp) {
          globalCache.setRecent(snap.data, snap.timestamp);
          const ageMs = Date.now() - snap.timestamp;
          if (ageMs < CONFIG.CACHE.TTL_MS) {
            return snap.data;
          }
          if (ageMs < swrMaxAgeMs) {
            scheduleBackgroundRefresh();
            return snap.data;
          }
        }
      } catch (err) {
        console.error('Failed to read telemetry_snapshot from KV:', err);
      }
    }
  }

  return runLocalFetch();
}

/**
 * Прямий виклик збору телеметрії (для тестів та байпасу кешу)
 */
export async function getFreshTelemetry(env) {
  const service = new TelemetryService(env, globalCache, CONFIG);
  return service.getTelemetry();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApi = (url.pathname === "/api/status" || url.pathname === "/status.json");
    const isGetOrHead = (request.method === 'GET' || request.method === 'HEAD');

    // 1. Перевірка Edge-кешу Cloudflare (глобальна CDN)
    const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
    const normalizedKey = new Request(url.origin + (isApi ? "/api/status" : "/"), { method: 'GET' });
    const isBypass = (url.searchParams.get("fresh") === "1" || url.searchParams.get("bypass") === "1");

    if (!isBypass && isGetOrHead && cache) {
      const cached = await cache.match(normalizedKey);
      if (cached) {
        return request.method === 'HEAD'
          ? new Response(null, { status: cached.status, headers: cached.headers })
          : cached;
      }
    }

    // 2. Отримання даних через багаторівневий кеш (Memory + KV + SWR)
    const data = await getCachedTelemetry(env, ctx, isBypass);
    const cacheAgeSec = Math.max(0, globalCache.getAgeSec());

    // Перевірка та відправка сповіщень Telegram (асинхронно у фоні)
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(processTelegramNotifications(data, env));
    }

    const securityHeaders = {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "geolocation=(), camera=(), microphone=()"
    };

    const baseHeaders = {
      ...securityHeaders,
      "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=30",
      "X-Server-Cache-Age": cacheAgeSec.toString()
    };

    let response;
    if (isApi) {
      response = new Response(JSON.stringify(data), {
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        }
      });
    } else {
      response = new Response(renderHTML(data), {
        headers: {
          ...baseHeaders,
          "Content-Type": "text/html; charset=utf-8"
        }
      });
    }

    // Зберігаємо в CDN-кеш Cloudflare
    if (!isBypass && isGetOrHead && cache && ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(normalizedKey, response.clone()));
    }

    if (request.method === 'HEAD') {
      return new Response(null, { status: response.status, headers: response.headers });
    }

    return response;
  },

  /**
   * Фоновий планувальник Cloudflare Cron Triggers (опитування кожні 2 хв)
   */
  async scheduled(controller, env, ctx) {
    try {
      const data = await getFreshTelemetry(env);
      await processTelegramNotifications(data, env);
    } catch (err) {
      console.error('Scheduled notification error:', err);
    }
  }
};

// Експорт функцій для збереження повної зворотної сумісності з тестами та зовнішніми модулями
export {
  VERSION,
  CONFIG,
  globalCache,
  calculateAutonomy,
  simulateTimelineAutonomy,
  analyzeMultiDayOutages,
  calculateOutageStatistics,
  buildOutageChart,
  renderHTML,
  isOutageRecord,
  calculateDischargeRate,
  calculate24hDischarge,
  resolveSystemState,
  SystemStateId,
  SystemState,
  processTelegramNotifications
};
