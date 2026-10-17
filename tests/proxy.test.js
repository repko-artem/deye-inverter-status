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

  test('rejects malformed or SSRF attempt paths with 400 Bad Request', async () => {
    const maliciousPaths = ['//@evil.com', '//169.254.169.254', '/test\\evil', '@evil.com'];

    for (const badPath of maliciousPaths) {
      let statusSet = 0;
      let jsonSent = null;

      const mockReq = { method: 'GET', url: badPath, headers: {} };
      const mockRes = {
        setHeader() {},
        status(s) { statusSet = s; return this; },
        json(d) { jsonSent = d; }
      };

      await proxyHandler(mockReq, mockRes);
      assert.equal(statusSet, 400, `Path ${badPath} should be rejected with 400`);
      assert.equal(jsonSent.error, 'Bad Request');
    }
  });

  test('blocks non-whitelisted API endpoints with 403 Forbidden', async () => {
    const forbiddenPaths = ['/admin/config', '/api/users', '/oauth/token'];

    for (const badPath of forbiddenPaths) {
      let statusSet = 0;
      let jsonSent = null;

      const mockReq = { method: 'GET', url: badPath, headers: {} };
      const mockRes = {
        setHeader() {},
        status(s) { statusSet = s; return this; },
        json(d) { jsonSent = d; }
      };

      await proxyHandler(mockReq, mockRes);
      assert.equal(statusSet, 403, `Path ${badPath} should be rejected with 403`);
      assert.equal(jsonSent.error, 'Forbidden');
    }
  });
});
