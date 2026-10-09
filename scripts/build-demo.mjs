#!/usr/bin/env node
/**
 * Builds the standalone pass-and-play demo into a single HTML file.
 *
 * The point of building it rather than hand-maintaining a copy: the page
 * embeds the real rules engine from shared/, bundled straight out of the same
 * compiled output the server imports. The demo cannot drift from the game.
 *
 * Output: demo/dist/index.html — one file, no server, works from any static
 * host (GitHub Pages) or straight off disk.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'demo/dist');
const OUT = resolve(OUT_DIR, 'index.html');

function read(rel) {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

// Bundle shared/ as an IIFE exposing `DominoRules` on the page.
const bundled = await build({
  entryPoints: [resolve(ROOT, 'shared/dist/index.js')],
  bundle: true,
  format: 'iife',
  globalName: 'DominoRules',
  minify: true,
  write: false,
  legalComments: 'none',
});
const engine = bundled.outputFiles[0].text;

const page = read('demo/src/page.html');
const app = read('demo/src/app.js');

/**
 * The artifact host wraps the page in its own skeleton; a static host does
 * not, so the standalone build supplies an equivalent one.
 */
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#10231b">
<meta name="description" content="Pass-and-play Curacao-style partnership dominoes for four players on one device.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23f5f0e3'/%3E%3Crect x='3' y='15' width='26' height='2' fill='%2314201a'/%3E%3Ccircle cx='10' cy='9' r='3' fill='%2314201a'/%3E%3Ccircle cx='22' cy='9' r='3' fill='%2314201a'/%3E%3Ccircle cx='16' cy='23' r='3' fill='%2314201a'/%3E%3C/svg%3E">
<style>
  :root {
    color-scheme: light;
    padding-top: env(safe-area-inset-top, 0px);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  body { margin: 0; font: 14px system-ui, sans-serif; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
${page}
</head>
<body></body>
<script>${engine}</script>
<script>${app}</script>
</html>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html);
console.log(`demo built: ${OUT} (${(Buffer.byteLength(html) / 1024).toFixed(1)} kB, one file, no server)`);
