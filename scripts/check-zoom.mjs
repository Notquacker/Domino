/**
 * Can you zoom in on the board, and does anything still line up?
 *
 * The board shrinks itself to fit, so by the end of a round the pips are
 * too small to read. Zoom sits on top of that fitting. This drives a real
 * game and checks the three things that make it usable rather than merely
 * present: the tiles really do get bigger, the board can be panned once it
 * is bigger than the screen, and the spots showing where a tile can go
 * still line up with the tiles after zooming — the whole point is that you
 * are looking at a bigger board, not a differently broken one.
 *
 * Needs a server running and Playwright:
 *   node server/dist/index.js &
 *   node scripts/check-zoom.mjs http://127.0.0.1:3000/
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000/';
const problems = [];

const browser = await chromium.launch({
  executablePath:
    process.env['CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 412, height: 900 }, hasTouch: true });
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

await page.goto(BASE);
await page.waitForSelector('#yourname', { timeout: 20_000 });
await page.fill('#yourname', 'Zoom');
await page.getByRole('button', { name: 'Create table' }).click();
await page.waitForSelector('text=Add a computer player', { timeout: 20_000 });
for (let i = 0; i < 3; i++) {
  await page.getByRole('button', { name: 'Add a computer player' }).click();
  await page.waitForTimeout(200);
}
await page.getByRole('button', { name: /deal|start/i }).first().click();

const mine = () => page.locator('.handbar .hint').count().then((n) => n > 0);
const count = () => page.locator('.pitch .tile').count();

/** Lay a tile however we can, to grow the chain. */
async function layOne() {
  const hand = page.locator('.hand .tile');
  const n = await hand.count();
  for (let i = 0; i < n; i++) {
    if (!(await hand.nth(i).click({ timeout: 2000 }).then(() => true).catch(() => false))) continue;
    const sel = (await page.locator('.slot').count()) > 0 ? '.slot' : '.dropzone';
    const k = await page.locator(sel).count();
    for (let j = 0; j < k; j++) {
      const before = await count();
      await page.locator(sel).nth(j).click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      if ((await count()) > before) return true;
    }
  }
  return false;
}

// Get a chain long enough that fitting it has actually shrunk the tiles, and
// stop on one of our own turns: the table waits for us then, so the board
// holds still for the whole measurement. Checking across somebody else's
// move would read the board growing as a zoom that did not stick.
for (let go = 0; go < 70; go++) {
  await page.waitForTimeout(250);
  if (!(await mine())) continue;
  if ((await count()) >= 8) break;
  if (!(await layOne())) {
    const pass = page.getByRole('button', { name: /^pass$/i });
    if (await pass.count()) await pass.first().click();
    await page.waitForTimeout(250);
  }
}
if (!(await mine())) problems.push('never got a turn with a long enough chain to measure');

/** A tile's size and the board's scrollable extent, on screen. */
const read = () =>
  page.evaluate(() => {
    const t = document.querySelector('.pitch .tile');
    const table = document.querySelector('.table');
    const r = t === null ? null : t.getBoundingClientRect();
    return {
      tile: r === null ? 0 : Math.round(r.width),
      level: document.getElementById('zoomlevel')?.textContent ?? '',
      scrollable: table === null ? 0 : table.scrollWidth - table.clientWidth,
      scrollLeft: table === null ? 0 : table.scrollLeft,
    };
  });

const fitted = await read();
console.log(`fitted: tiles ${fitted.tile}px, ${fitted.level}`);
if (fitted.scrollable > 2) problems.push('the fitted board does not fit — it already scrolls');

// Zoom in twice with the button.
for (let i = 0; i < 2; i++) {
  await page.locator('#zoomin').click();
  await page.waitForTimeout(150);
}
const zoomed = await read();
console.log(`zoomed in: tiles ${zoomed.tile}px, ${zoomed.level}, ${zoomed.scrollable}px to pan`);
if (zoomed.tile <= fitted.tile + 2) {
  problems.push(`zooming in did not make the tiles bigger (${fitted.tile} -> ${zoomed.tile})`);
}
if (zoomed.scrollable < 20) {
  problems.push('zoomed in, but there is nothing to pan — the board is still clamped to the screen');
}

// Pan it, and check it actually moved.
await page.evaluate(() => {
  const table = document.querySelector('.table');
  if (table !== null) table.scrollLeft = 80;
});
await page.waitForTimeout(100);
if ((await read()).scrollLeft < 40) problems.push('the zoomed board would not pan sideways');

// The spots must still sit against the tiles at this size: the whole point
// is a bigger board, not a differently broken one.
await page.locator('.hand .tile').first().click({ timeout: 2000 }).catch(() => {});
await page.waitForTimeout(200);
const lined = await page.evaluate(() => {
  const slots = [...document.querySelectorAll('.slot')];
  const tiles = [...document.querySelectorAll('.pitch .tile')];
  if (slots.length === 0 || tiles.length === 0) return null;
  const gap = (a, b) =>
    Math.max(
      Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)),
      Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)),
    );
  // Every spot must be touching some tile. One floating off on its own is
  // what it looks like when the spots and the tiles scale differently.
  let worst = 0;
  for (const s of slots) {
    const sr = s.getBoundingClientRect();
    let best = Infinity;
    for (const t of tiles) best = Math.min(best, gap(sr, t.getBoundingClientRect()));
    worst = Math.max(worst, best);
  }
  return {
    worst: Math.round(worst),
    slots: slots.length,
    tile: Math.round(tiles[0].getBoundingClientRect().width),
  };
});
if (lined === null) {
  problems.push('no spots appeared when a tile was picked up while zoomed');
} else {
  console.log(`zoomed, ${lined.slots} spots on offer, furthest is ${lined.worst}px from the chain`);
  if (lined.worst > Math.max(3, lined.tile / 8)) {
    problems.push(`a spot sits ${lined.worst}px away from the chain while zoomed`);
  }
}

// Pinch. Two fingers is the gesture people reach for first, and it goes
// through a different path from the buttons: real touch events, not a click.
await page.locator('#zoomlevel').click();
await page.waitForTimeout(250);
const beforePinch = await read();
{
  const cdp = await page.context().newCDPSession(page);
  const table = await page.locator('.table').boundingBox();
  const cx = table.x + table.width / 2;
  const cy = table.y + table.height / 2;
  const touch = (type, gap) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints:
        type === 'touchEnd'
          ? []
          : [
              { x: cx - gap, y: cy, id: 1 },
              { x: cx + gap, y: cy, id: 2 },
            ],
    });
  await touch('touchStart', 40);
  for (const gap of [55, 70, 85, 100, 115]) {
    await touch('touchMove', gap);
    await page.waitForTimeout(40);
  }
  await touch('touchEnd', 115);
  await page.waitForTimeout(200);
}
const pinched = await read();
console.log(`pinched open: tiles ${beforePinch.tile}px -> ${pinched.tile}px, ${pinched.level}`);
if (pinched.tile <= beforePinch.tile + 2) {
  problems.push(`pinching did not zoom in (${beforePinch.tile} -> ${pinched.tile})`);
}

// Double-tap the felt: in, then out again. Lifting a pinch also fires one
// pointerup per finger, so this and the pinch above have to stay told apart.
await page.locator('#zoomlevel').click();
// Well clear of the pinch: a tap too soon after one is ignored on purpose,
// since lifting two fingers would otherwise read as a double-tap.
await page.waitForTimeout(800);
{
  const table = await page.locator('.table').boundingBox();
  // A corner of the felt, well away from the chain and the controls.
  const x = table.x + 30;
  const y = table.y + table.height - 30;
  for (const [label, wanted] of [['in', true], ['out', false]]) {
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(90);
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(300);
    const now = await read();
    const zoomedIn = now.level !== '100%';
    console.log(`double-tap ${label}: ${now.level}`);
    if (zoomedIn !== wanted) {
      problems.push(`double-tapping to zoom ${label} left it at ${now.level}`);
    }
    // Far enough apart that the next pair is not read as part of this one.
    await page.waitForTimeout(500);
  }
}

// And back to fitting. Still our turn, so the board has not moved on.
await page.locator('#zoomlevel').click();
await page.waitForTimeout(250);
const back = await read();
console.log(`back to fit: tiles ${back.tile}px, ${back.level}`);
if (Math.abs(back.tile - fitted.tile) > 2) {
  problems.push(`fitting again did not restore the size (${fitted.tile} -> ${back.tile})`);
}
if (back.level !== '100%') problems.push(`the level reads "${back.level}" after fitting`);

await page.screenshot({ path: 'client/dist/zoom.png' });
await browser.close();
if (problems.length > 0) {
  console.log('\nPROBLEMS:');
  for (const p of [...new Set(problems)]) console.log(' -', p);
  process.exit(1);
}
console.log('OK: the board zooms, pans, and the spots stay against the chain.');
