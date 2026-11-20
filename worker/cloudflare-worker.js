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
 * Отримання телеметрії з монотонним багаторівневим кешуванням (Memory + KV Snapshot + SWR).
 * Повертає `{ data, isStale, source }` щоб HTTP-шар ніколи не клав застарілу SWR-відповідь у Edge CDN.
 */
async function resolveTelemetry(env, ctx, isBypass = false) {
  const runLocalFetch = async (forceKvWrite = false) => {
    globalCache.markRefreshStart();
    try {
      const service = new TelemetryService(env, globalCache, CONFIG);
      const fresh = await service.getTelemetry({ forceKvWrite });
      globalCache.setRecent(fresh, fresh?.generated_at_ts || Date.now(), { force: true });
      return fresh;
    } finally {
      globalCache.markRefreshEnd();
    }
  };

  if (isBypass) {
    const data = await runLocalFetch(false);
    return { data, isStale: false, source: 'bypass' };
  }

  if (globalCache.isFresh()) {
    return { data: globalCache.getRecent(), isStale: false, source: 'memory' };
  }

  const scheduleBackgroundRefresh = () => {
    if (ctx && ctx.waitUntil && !globalCache.isRefreshing()) {
      ctx.waitUntil(runLocalFetch(false).catch(err => console.error('SWR refresh error:', err)));
    }
  };

  const swrMaxAgeMs = CONFIG.CACHE.SWR_MAX_AGE_MS || 180000;
  const recent = globalCache.getRecent();
  if (recent && (globalCache.getAgeSec() * 1000) < swrMaxAgeMs) {
    scheduleBackgroundRefresh();
    return { data: recent, isStale: true, source: 'memory-swr' };
  }

  if (!recent && env && env.NOTIFY_KV) {
    try {
      const snap = await env.NOTIFY_KV.get('telemetry_snapshot', { type: 'json' });
      globalCache.setKvSnapshotMeta(
        snap?.timestamp || 0,
        snap?.data?.system_state || null,
        snap?.data?.battery_soc ?? null
      );
      if (snap && snap.data && snap.timestamp) {
        if (!snap.data.generated_at_ts) {
          snap.data.generated_at_ts = snap.timestamp;
        }
        globalCache.setRecent(snap.data, snap.timestamp);
        const ageMs = Date.now() - snap.timestamp;
        if (ageMs < CONFIG.CACHE.TTL_MS) {
          return { data: globalCache.getRecent(), isStale: false, source: 'kv-fresh' };
        }
        if (ageMs < swrMaxAgeMs) {
          scheduleBackgroundRefresh();
          return { data: globalCache.getRecent(), isStale: true, source: 'kv-swr' };
        }
      }
    } catch (err) {
      console.error('Failed to read telemetry_snapshot from KV:', err);
    }
  }

  const data = await runLocalFetch(false);
  return { data, isStale: false, source: 'origin' };
}

/**
 * Прямий виклик збору телеметрії (для тестів, Cron та байпасу кешу)
 */
export async function getFreshTelemetry(env, { forceKvWrite = false } = {}) {
  const service = new TelemetryService(env, globalCache, CONFIG);
  return service.getTelemetry({ forceKvWrite });
}

const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), camera=(), microphone=()"
});

function buildCacheHeaders(routeKind, { isStale = false, isPartial = false, cacheAgeSec = 0, source = 'memory' } = {}) {
  if (routeKind === "archive") {
    return {
      ...SECURITY_HEADERS,
      "Cache-Control": isPartial ? "no-store" : "public, max-age=120, s-maxage=120"
    };
  }
  const edgeTtlSec = CONFIG.CACHE?.EDGE_TTL_SEC || 45;
  return {
    ...SECURITY_HEADERS,
    "Cache-Control": isStale
      ? "no-store, no-cache, must-revalidate"
      : `public, max-age=0, s-maxage=${edgeTtlSec}, must-revalidate`,
    "X-Server-Cache-Age": String(cacheAgeSec),
    "X-Cache-Source": source
  };
}

function resolveRoute(pathname) {
  if (pathname === "/api/archive") return { kind: "archive", cachePath: "/api/archive" };
  if (pathname === "/api/status" || pathname === "/status.json") return { kind: "status", cachePath: "/api/status" };
  return { kind: "html", cachePath: "/" };
}

function buildRouteResponse(routeKind, body, headers) {
  if (routeKind === "html") {
    return new Response(body, {
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" }
    });
  }
  return new Response(JSON.stringify(body), {
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const route = resolveRoute(url.pathname);
    const isGetOrHead = (request.method === 'GET' || request.method === 'HEAD');
    const isBypass = (url.searchParams.get("fresh") === "1" || url.searchParams.get("bypass") === "1");

    // 1. Перевірка Edge-кешу Cloudflare (глобальна CDN)
    const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
    const normalizedKey = new Request(url.origin + route.cachePath, { method: 'GET' });

    if (!isBypass && isGetOrHead && cache) {
      const cached = await cache.match(normalizedKey);
      if (cached) {
        return request.method === 'HEAD'
          ? new Response(null, { status: cached.status, headers: cached.headers })
          : cached;
      }
    }

    // 2. Виконання запиту за таблицею маршрутів (OCP)
    let payload;
    let headers;
    let shouldEdgeCache = false;

    if (route.kind === "archive") {
      const service = new TelemetryService(env, globalCache, CONFIG);
      payload = await service.getOutageArchive({ bypassCache: isBypass });
      const isPartial = Boolean(payload?.period?.isPartial);
      shouldEdgeCache = (isGetOrHead && !isBypass && !isPartial);
      headers = buildCacheHeaders("archive", { isPartial });
    } else {
      const { data, isStale, source } = await resolveTelemetry(env, ctx, isBypass);
      const cacheAgeSec = Math.max(0, globalCache.getAgeSec());
      shouldEdgeCache = (isGetOrHead && !isStale);
      payload = (route.kind === "html") ? renderHTML(data) : data;
      headers = buildCacheHeaders(route.kind, { isStale, cacheAgeSec, source });
    }

    const response = buildRouteResponse(route.kind, payload, headers);

    // 3. Зберігаємо тільки свіжу GET/HEAD-відповідь у CDN-кеш Cloudflare (включно з ?fresh=1 для оновлення CDN)
    if (shouldEdgeCache && cache && ctx && ctx.waitUntil) {
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
      const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
      if (cache && typeof cache.delete === 'function') {
        await Promise.allSettled([
          cache.delete(new Request('https://power.osbbnd.workers.dev/', { method: 'GET' })),
          cache.delete(new Request('https://power.osbbnd.workers.dev/api/status', { method: 'GET' }))
        ]);
      }
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
