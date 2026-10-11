/**
 * The real client, in a real browser, against the real server.
 *
 * The pass-and-play demo and the online client share the geometry, so
 * `check-placement.mjs` covers the shape itself. What this covers is the
 * other half: that the online client — which gets its board over the wire,
 * never sees another hand, and is never told what fits — draws the spots and
 * sends a direction the server accepts.
 *
 * One human seat and three computer players, so one browser is enough.
 *
 * Needs a server running and Playwright:
 *   node server/dist/index.js &
 *   node scripts/check-client-placement.mjs http://127.0.0.1:3000/
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000/';
const DIRS = ['right', 'down', 'left', 'up'];
const problems = [];

const browser = await chromium.launch({
  executablePath:
    process.env['CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console error: ${m.text()}`);
});

await page.goto(BASE);
await page.waitForSelector('#yourname', { timeout: 20_000 });
await page.fill('#yourname', 'Checker');
await page.getByRole('button', { name: 'Create table' }).click();
await page.waitForSelector('text=Add a computer player', { timeout: 20_000 });
for (let i = 0; i < 3; i++) {
  await page.getByRole('button', { name: 'Add a computer player' }).click();
  await page.waitForTimeout(250);
}
const start = page.getByRole('button', { name: /deal|start/i }).first();
await start.waitFor({ timeout: 20_000 });
await start.click();
await page.waitForSelector('.hand .tile', { timeout: 20_000 });

/** Tiles on the table, by layout box — not a rect, which includes transforms. */
async function tableBoxes() {
  return page.locator('.pitch .tile').evaluateAll((ns) =>
    ns.map((n) => ({
      id: n.getAttribute('data-tile'),
      cx: n.offsetLeft + n.offsetWidth / 2,
      cy: n.offsetTop + n.offsetHeight / 2,
      left: n.offsetLeft,
      right: n.offsetLeft + n.offsetWidth,
      top: n.offsetTop,
      bottom: n.offsetTop + n.offsetHeight,
    })),
  );
}

async function drag(from, to) {
  const a = await from.boundingBox();
  const b = 'x' in to ? to : await to.boundingBox();
  const [x0, y0] = [a.x + a.width / 2, a.y + a.height / 2];
  const [x1, y1] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
  }
  await page.mouse.up();
}

/**
 * Every spot on offer, read in one go.
 *
 * Reading the end and the direction off a locator and then dragging to it
 * separately is a race: the page re-renders whenever the table changes, and
 * the locator quietly re-resolves to whatever is at that index now. Then the
 * check drags to one spot while believing it picked another.
 */
async function offeredSpots() {
  return page.locator('.slot').evaluateAll((ns) =>
    ns.map((n) => {
      const r = n.getBoundingClientRect();
      return {
        end: n.getAttribute('data-end'),
        dir: Number(n.getAttribute('data-dir')),
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      };
    }),
  );
}

/**
 * Wait until it is our turn again, or give up.
 *
 * The hint under the hand only appears on your own turn, which is the same
 * thing the player goes by.
 */
async function waitForTurn(ms = 25_000) {
  try {
    await page.waitForSelector('.handbar .hint', { timeout: ms });
    return true;
  } catch {
    return false;
  }
}

const seen = new Map();
/** Keep going until both a straight run and a corner have been laid. */
const needMore = () => seen.size < 2 || (!seen.has(1) && !seen.has(3));
let placed = 0;
let refused = 0;

for (let turn = 0; turn < 40 && needMore(); turn++) {
  if (!(await waitForTurn())) break;
  const hand = page.locator('.hand .tile');
  const tiles = await hand.count();
  if (tiles === 0) break;

  let laid = false;
  for (let i = 0; i < tiles && !laid; i++) {
    const tile = hand.nth(i);
    await tile.click();
    const spots = await offeredSpots();
    if (spots.length === 0) {
      // The opening lead: one target over the whole table.
      const lead = page.locator('.dropzone');
      if ((await lead.count()) === 0) continue;
      const before = await page.locator('.pitch .tile').count();
      await drag(tile, lead.first());
      await page.waitForTimeout(600);
      if ((await page.locator('.pitch .tile').count()) > before) {
        laid = true;
        placed++;
        console.log('opening tile laid');
      } else {
        refused++;
      }
      continue;
    }

    // Corners first: straight on worked before this change too.
    spots.sort((a, b) => Number(a.dir === 0) - Number(b.dir === 0));

    // Which tile this is, by name. Looking for "the tile that was not there
    // before" is not good enough: the computer players answer within a
    // moment of your own move, so by the time the table is read again theirs
    // are on it too, and the first unfamiliar tile can easily be one of
    // theirs at the other end.
    const held = await tile.getAttribute('data-tile');

    for (const spot of spots) {
      const before = await tableBoxes();
      const neighbourId =
        spot.end === 'right' ? before[before.length - 1].id : before[0].id;

      await drag(tile, spot);
      await page.waitForTimeout(700); // the server has to answer
      const after = await tableBoxes();
      if (!after.some((t) => t.id === held)) {
        refused++;
        await tile.click();
        continue;
      }

      placed++;
      laid = true;
      const fresh = after.find((t) => t.id === held);
      const neighbour = after.find((t) => t.id === neighbourId);
      if (fresh === undefined || neighbour === undefined) {
        problems.push('could not find the tile just played');
        break;
      }
      const dx = fresh.cx - neighbour.cx;
      const dy = fresh.cy - neighbour.cy;
      const landed = [
        dx > 4 && Math.abs(dy) <= Math.abs(dx),
        dy > 4 && Math.abs(dx) <= Math.abs(dy),
        dx < -4 && Math.abs(dy) <= Math.abs(dx),
        dy < -4 && Math.abs(dx) <= Math.abs(dy),
      ][spot.dir];
      if (landed !== true) {
        // Give the page a moment in case the measurement beat the server's
        // own state, then dump what is actually on screen.
        await page.waitForTimeout(1200);
        const settled = await tableBoxes();
        console.log('MISMATCH — what the page is showing:');
        for (const t of settled) {
          console.log(`   ${t.id} left=${t.left} top=${t.top} ` +
            `w=${(t.right - t.left).toFixed(0)} h=${(t.bottom - t.top).toFixed(0)}`);
        }
        problems.push(
          `the server took ${fresh.id} on the ${DIRS[spot.dir]} spot at the ` +
            `${spot.end} end, but it came back ${dx.toFixed(0)},${dy.toFixed(0)} ` +
            `from ${neighbour.id} — board was ${before.map((t) => t.id).join(' ')}`,
        );
      } else {
        console.log(
          `${fresh.id} laid ${DIRS[spot.dir]} of ${neighbour.id} — the server agreed`,
        );
        seen.set(spot.dir, (seen.get(spot.dir) ?? 0) + 1);
      }
      break;
    }
  }

  if (!laid) {
    const pass = page.getByRole('button', { name: /^pass$/i });
    if ((await pass.count()) === 0) break;
    await pass.first().click();
    await page.waitForTimeout(400);
  }
}

const boxes = await tableBoxes();
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i];
    const b = boxes[j];
    const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ox > 2 && oy > 2) {
      problems.push(`${a.id} and ${b.id} overlap by ${ox.toFixed(0)}x${oy.toFixed(0)}px`);
    }
  }
}

console.log(
  `${placed} laid, ${refused} refused, ${boxes.length} on the table; ` +
    `directions the server accepted: ${[...seen.keys()].map((d) => DIRS[d]).join(', ') || 'none'}`,
);
// Straight on worked before any of this. A corner is the new part, so the
// check has not proved much until one has gone down and come back right.
if (!seen.has(1) && !seen.has(3)) {
  problems.push('no corner was ever laid — the check proved little');
}

await page.screenshot({ path: 'client/dist/placement.png' });
await browser.close();
if (problems.length > 0) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log(' -', p);
  process.exit(1);
}
console.log('OK: the online client lays tiles where you drop them.');
