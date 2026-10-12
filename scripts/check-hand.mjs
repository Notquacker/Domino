/**
 * Is your hand centred, and does a tile stay whole when it lifts?
 *
 * The strip holding your tiles scrolls sideways when a hand is wider than
 * the screen, and a scrolling box clips both ways — so a tile that rises
 * under the pointer had its top sliced off at the moment you reached for
 * it. This measures the lifted tile against the strip that holds it, at
 * several widths, and checks the tiles sit in the middle of the screen
 * rather than banked against one edge.
 *
 * Needs a server running and Playwright:
 *   node server/dist/index.js &
 *   node scripts/check-hand.mjs http://127.0.0.1:3000/
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000/';
const problems = [];

const browser = await chromium.launch({
  executablePath:
    process.env['CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

// A narrow phone, a common phone, and a desktop window.
for (const width of [360, 412, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('pageerror', (e) => problems.push(`${width}px: page error: ${e.message}`));

  await page.goto(BASE);
  await page.waitForSelector('#yourname', { timeout: 20_000 });
  await page.fill('#yourname', 'Hands');
  await page.getByRole('button', { name: 'Create table' }).click();
  await page.waitForSelector('text=Add a computer player', { timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Add a computer player' }).click();
    await page.waitForTimeout(200);
  }
  await page.getByRole('button', { name: /deal|start/i }).first().click();
  await page.waitForSelector('.hand .tile', { timeout: 20_000 });

  // Centred: the gap of empty strip on each side of the tiles should match.
  const centred = await page.evaluate(() => {
    const hand = document.querySelector('.hand');
    const tiles = [...document.querySelectorAll('.hand .tile')];
    if (hand === null || tiles.length === 0) return null;
    const h = hand.getBoundingClientRect();
    const first = tiles[0].getBoundingClientRect();
    const last = tiles[tiles.length - 1].getBoundingClientRect();
    return {
      left: Math.round(first.left - h.left),
      right: Math.round(h.right - last.right),
      overflowing: hand.scrollWidth - hand.clientWidth > 2,
      tiles: tiles.length,
    };
  });
  if (centred === null) {
    problems.push(`${width}px: no hand to measure`);
  } else if (centred.overflowing) {
    console.log(`${width}px: ${centred.tiles} tiles, wider than the screen — scrolls instead`);
    if (centred.left < 0) problems.push(`${width}px: the first tile is off the scrollable area`);
  } else {
    console.log(`${width}px: ${centred.tiles} tiles, ${centred.left}px left / ${centred.right}px right`);
    if (Math.abs(centred.left - centred.right) > 4) {
      problems.push(
        `${width}px: the hand sits ${centred.left}px from one side and ${centred.right}px from the other`,
      );
    }
  }

  // Nothing may be cut off when a tile rises under the pointer.
  const tile = page.locator('.hand .tile').first();
  const beforeTop = await tile.evaluate((n) => n.getBoundingClientRect().top);
  await tile.hover();
  await page.waitForTimeout(220);
  const lift = await page.evaluate(() => {
    const hand = document.querySelector('.hand');
    const t = document.querySelector('.hand .tile');
    if (hand === null || t === null) return null;
    const h = hand.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    return { over: Math.round(h.top - r.top), top: r.top, handTop: h.top };
  });
  if (lift === null) {
    problems.push(`${width}px: nothing to measure after hovering`);
  } else {
    const rose = Math.round(beforeTop - lift.top);
    console.log(`${width}px: the tile rises ${rose}px and clears the strip by ${-lift.over}px`);
    if (rose < 4) problems.push(`${width}px: hovering barely moved the tile (${rose}px)`);
    if (lift.over > 0) {
      problems.push(`${width}px: the lifted tile is cut off by ${lift.over}px at the top`);
    }
  }
  await page.close();
}

await browser.close();
if (problems.length > 0) {
  console.log('\nPROBLEMS:');
  for (const p of [...new Set(problems)]) console.log(' -', p);
  process.exit(1);
}
console.log('OK: the hand is centred and a lifted tile stays whole.');
