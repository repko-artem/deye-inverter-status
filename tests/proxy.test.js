import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const proxyHandler = require('../proxy/api/proxy.js');

describe('Vercel Proxy Relay (proxy.js)', () => {
  test('handles CORS OPTIONS preflight with 204 No Content', async () => {
    const headersSet = {};
    let statusSet = 0;
    let ended = false;

    const mockReq = {
      method: 'OPTIONS',
      url: '/test',
      headers: {}
    };

    const mockRes = {
      setHeader(k, v) {
        headersSet[k.toLowerCase()] = v;
      },
      status(s) {
        statusSet = s;
        return this;
      },
      end() {
        ended = true;
      }
    };

    await proxyHandler(mockReq, mockRes);

    assert.equal(statusSet, 204);
    assert.equal(headersSet['access-control-allow-origin'], '*');
    assert.equal(headersSet['access-control-allow-methods'], 'GET, POST, OPTIONS');
    assert.equal(ended, true);
  });
});
