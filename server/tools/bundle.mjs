/**
 * Сборка всего бэкенда в один самодостаточный файл dist/p2p-gateway.mjs.
 * Сначала tsc проверяет типы и компилирует в dist/src/*.js, затем esbuild
 * склеивает граф модулей в один ESM-файл. Встроенные модули node остаются
 * внешними (bundle зависит ТОЛЬКО от стандартной библиотеки Node ≥ 20).
 * Запуск результата: node dist/p2p-gateway.mjs
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const banner = `/*
 * P2P Light — Gateway (single-file build), v${pkg.version}
 * Самодостаточный бэкенд: REST + WebSocket-стрим стаканов.
 * Зависимости рантайма: только стандартная библиотека Node.js (>= 20.11).
 *
 * Запуск:
 *   SESSION_SECRET=<>=32 символа> ALLOW_DEV_AUTH=true node p2p-gateway.mjs
 * Порты и переменные окружения: см. server/.env.example и server/README.md.
 * Исходники (hexagonal ports & adapters): server/src/. Этот файл сгенерирован.
 */`;

const result = await build({
  entryPoints: [resolve(root, 'dist/src/main.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: resolve(root, 'dist/p2p-gateway.mjs'),
  banner: { js: banner },
  legalComments: 'none',
  minify: false,
  metafile: true,
});

const out = result.metafile.outputs[Object.keys(result.metafile.outputs).find((k) => k.endsWith('p2p-gateway.mjs'))];
console.log(`собрано модулей: ${Object.keys(result.metafile.inputs).length}`);
console.log(`dist/p2p-gateway.mjs: ${(out.bytes / 1024).toFixed(0)} KB`);
