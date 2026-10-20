/**
 * Cloudflare Worker для публічної сторінки статусу ОСББ "Новодарницьке".
 * Архітектура: Controller / HTTP Router, що зв'язує доменні сервіси та презентаційний шар.
 */

import { CONFIG } from './config.js';
import { globalCache } from './services/cache.js';
import { TelemetryService } from './services/telemetry-service.js';
import { renderHTML } from './ui/template.js';
import { calculateAutonomy, isOutageRecord, calculateDischargeRate, calculate24hDischarge } from './domain/autonomy.js';
import { analyzeMultiDayOutages, calculateOutageStatistics } from './domain/outages.js';
import { buildOutageChart } from './ui/chart.js';

/**
 * Отримання свіжої телеметрії (з кешуванням на рівні інстансу)
 */
async function getCachedTelemetry(env) {
  return globalCache.getOrFetch(() => {
    const service = new TelemetryService(env, globalCache, CONFIG);
    return service.getTelemetry();
  });
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

    // 1. Перевірка Edge-кешу Cloudflare (глобальна CDN)
    const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
    const normalizedKey = new Request(url.origin + (isApi ? "/api/status" : "/"), request);
    const isBypass = (url.searchParams.get("fresh") === "1" || url.searchParams.get("bypass") === "1");

    if (!isBypass && cache) {
      const cached = await cache.match(normalizedKey);
      if (cached) {
        return cached;
      }
    }

    // 2. Отримання даних через централізований серверний кеш
    const data = await getCachedTelemetry(env);
    const cacheAgeSec = globalCache.getAgeSec();

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
    if (!isBypass && cache && ctx && ctx.waitUntil) {
      ctx.waitUntil(cache.put(normalizedKey, response.clone()));
    }

    return response;
  }
};

// Експорт функцій для збереження повної зворотної сумісності з тестами та зовнішніми модулями
export {
  CONFIG,
  calculateAutonomy,
  analyzeMultiDayOutages,
  calculateOutageStatistics,
  buildOutageChart,
  renderHTML,
  isOutageRecord,
  calculateDischargeRate,
  calculate24hDischarge
};
