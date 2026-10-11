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

/**
 * Drag from one element to a point. Returns false if there was nothing to
 * take hold of: the hand is rebuilt whenever the table changes, so a tile
 * picked out a moment ago may be gone. That is the game moving on, not a
 * fault.
 */
async function drag(from, to) {
  const a = await from.boundingBox({ timeout: 2000 }).catch(() => null);
  const b = 'x' in to ? to : await to.boundingBox({ timeout: 2000 }).catch(() => null);
  if (a === null || b === null) return false;
  const [x0, y0] = [a.x + a.width / 2, a.y + a.height / 2];
  const [x1, y1] = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
  }
  await page.mouse.up();
  return true;
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
        // Viewport coordinates, for aiming the pointer at it...
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
        // ...and layout coordinates, in the same frame as the tiles, for
        // checking afterwards that the tile landed on the spot it showed.
        ol: n.offsetLeft,
        ot: n.offsetTop,
        ow: n.offsetWidth,
        oh: n.offsetHeight,
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

/**
 * Picking a tile up must not move the board.
 *
 * The spots a tile can go sit outside the tiles already down, so the frame
 * has to make room for them — and when that room was only measured while a
 * tile was in hand, the whole board shrank the moment one was picked up. A
 * drag that began on the board then moved the board out from under the
 * finger that started it.
 */
async function boardHoldsStillWhenATileIsPickedUp() {
  // The pitch's own rect for where the board sits, and a tile's layout box
  // for how big the tiles are. Not a tile's rect: one just laid is still
  // running its drop animation, and a rect includes the transform.
  const read = () =>
    page.evaluate(() => {
      const p = document.querySelector('.pitch');
      const t = document.querySelector('.pitch .tile');
      if (p === null || t === null) return null;
      const r = p.getBoundingClientRect();
      return { x: r.left, y: r.top, w: t.offsetWidth };
    });
  const idle = await read();
  if (idle === null) return;
  const tile = page.locator('.hand .tile').first();
  const a = await tile.boundingBox();
  if (a === null) return;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y - 30);
  await page.mouse.move(a.x + a.width / 2, a.y - 60);
  const held = await read();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(200);
  if (held === null) return;
  const moved = Math.max(Math.abs(held.x - idle.x), Math.abs(held.y - idle.y));
  const resized = Math.abs(held.w - idle.w);
  if (moved > 1 || resized > 1) {
    problems.push(
      `picking a tile up moved the board ${moved.toFixed(0)}px and resized the tiles by ` +
        `${resized.toFixed(0)}px — whatever you were aiming at has shifted`,
    );
  } else {
    console.log('picking a tile up leaves the board exactly where it was');
  }
}

const seen = new Map();
/** Keep going until both a straight run and a corner have been laid. */
const needMore = () => seen.size < 2 || (!seen.has(1) && !seen.has(3));
let placed = 0;
let refused = 0;

let steadied = false;
for (let turn = 0; turn < 40 && needMore(); turn++) {
  if (!(await waitForTurn())) break;
  if (!steadied && (await page.locator('.pitch .tile').count()) >= 2) {
    steadied = true;
    await boardHoldsStillWhenATileIsPickedUp();
  }
  const hand = page.locator('.hand .tile');
  const tiles = await hand.count();
  if (tiles === 0) break;

  let laid = false;
  for (let i = 0; i < tiles && !laid; i++) {
    const tile = hand.nth(i);
    if (!(await tile.click({ timeout: 2000 }).then(() => true).catch(() => false))) continue;
    const spots = await offeredSpots();
    if (spots.length === 0) {
      // The opening lead: one target over the whole table.
      const lead = page.locator('.dropzone');
      if ((await lead.count()) === 0) continue;
      const before = await page.locator('.pitch .tile').count();
      if (!(await drag(tile, lead.first()))) continue;
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

      if (!(await drag(tile, spot))) break;
      await page.waitForTimeout(700); // the server has to answer
      const after = await tableBoxes();
      if (!after.some((t) => t.id === held)) {
        refused++;
        // Show the spots again; if the tile has gone there is nothing left.
        if (!(await tile.click({ timeout: 2000 }).then(() => true).catch(() => false))) break;
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
      // Did it land on the spot it was showing? Measured against a tile that was
      // already down, so re-framing between the two readings cancels out. The new
      // tile against its neighbour would not catch this: a rule that shifts every
      // tile shifts them both. The board does legitimately change size as it
      // grows, so this compares in multiples of a tile rather than in pixels.
      const refBefore = before.find((t) => t.id === neighbourId);
      const refAfter = after.find((t) => t.id === neighbourId);
      if (refBefore !== undefined && refAfter !== undefined) {
        const wasWide = refBefore.right - refBefore.left;
        const nowWide = refAfter.right - refAfter.left;
        const k = wasWide > 0 ? nowWide / wasWide : 1;
        const tile = Math.max(1, Math.min(nowWide, refAfter.bottom - refAfter.top));
        const slipX = Math.abs(fresh.left - refAfter.left - (spot.ol - refBefore.left) * k);
        const slipY = Math.abs(fresh.top - refAfter.top - (spot.ot - refBefore.top) * k);
        const slipW = Math.abs(fresh.right - fresh.left - spot.ow * k);
        const slipH = Math.abs(fresh.bottom - fresh.top - spot.oh * k);
        // A tenth of a tile: tighter than anything a player would call lined up,
        // looser than rounding.
        const allowed = tile / 10;
        if (slipX > allowed || slipY > allowed) {
          problems.push(
            `${fresh.id} came to rest ${slipX.toFixed(0)},${slipY.toFixed(0)}px from the ` +
              `${DIRS[spot.dir]} spot that was showing — the guide and the tile disagree`,
          );
        }
        if (slipW > allowed || slipH > allowed) {
          problems.push(
            `the ${DIRS[spot.dir]} spot was the wrong size for ${fresh.id} by ` +
              `${slipW.toFixed(0)}x${slipH.toFixed(0)}px`,
          );
        }
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
