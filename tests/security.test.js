import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function getFilesRecursively(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === '.git' || file === 'node_modules') continue;
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getFilesRecursively(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Security & Secrets Leak Prevention', () => {
  const rootDir = path.resolve(import.meta.dirname, '..');
  const allFiles = getFilesRecursively(rootDir);

  test('no sensitive env files (.dev.vars, .env) are present in the repo', () => {
    for (const file of allFiles) {
      const base = path.basename(file);
      assert.notEqual(base, '.dev.vars', `Disallowed file committed: ${file}`);
      assert.notEqual(base, '.env', `Disallowed file committed: ${file}`);
    }
  });

  test('no hardcoded JWT tokens or API keys exist in committed code', () => {
    const jwtPattern = /eyJ[a-zA-Z0-9_\-]{30,}\.[a-zA-Z0-9_\-]{30,}/;
    const cfTokenPattern = /cfut_[a-zA-Z0-9_\-]{30,}/;

    for (const file of allFiles) {
      // Skip test file itself and documentation examples
      if (file.endsWith('security.test.js')) continue;

      const content = fs.readFileSync(file, 'utf-8');
      assert.ok(!jwtPattern.test(content), `Possible JWT token found in: ${file}`);
      assert.ok(!cfTokenPattern.test(content), `Cloudflare token found in: ${file}`);
    }
  });
});
