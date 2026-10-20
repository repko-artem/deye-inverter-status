import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const pkgPath = path.join(rootDir, 'package.json');
const workerVersionPath = path.join(rootDir, 'worker', 'version.js');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const versionContent = `/**
 * Поточна версія проєкту згідно з SemVer (Semantic Versioning)
 * Синхронізується з package.json
 */
export const VERSION = "${pkg.version}";
`;

fs.writeFileSync(workerVersionPath, versionContent, 'utf8');
console.log(`Synced worker/version.js to v${pkg.version}`);
