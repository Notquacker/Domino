/**
 * Does a tile land where you put it?
 *
 * The shape of the chain is the players' choice: a tile can be laid straight
 * on, or round a corner above or below an end. This drives the pass-and-play
 * demo in a real browser and checks that a tile dropped on a spot ends up in
 * that direction from the end it was played against — and that nothing on
 * the table ever overlaps anything else.
 *
 * Measuring against the neighbour, rather than against where the finger let
 * go, is deliberate: placing a tile re-frames and re-scales the whole board,
 * so a screen position from before the drop means nothing after it.
 *
 * Needs Playwright:
 *   npm run build:demo && node scripts/check-placement.mjs
 */

import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const PAGE = pathToFileURL(new URL('../demo/dist/index.html', import.meta.url).pathname).href;
const DIRS = ['right', 'down', 'left', 'up'];

const browser = await chromium.launch({
  // The container ships one Chromium; point at it rather than downloading.
  executablePath:
    process.env['CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

await page.goto(PAGE);
await page.check('#solo');
await page.getByRole('button', { name: /deal|start|play/i }).first().click();
await page.waitForSelector('.hand .tile');

/**
 * Where every tile on the table is, by id.
 *
 * `offsetLeft` and friends, not `getBoundingClientRect`: a tile just laid is
 * still running its drop animation, and a rect includes the transform. Read
 * the rect and a tile halfway through landing looks like it is on top of its
 * neighbour.
 */
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

/** Drag from the middle of one node to the middle of another. */
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

// The opening lead: the whole table is one target, so there is no choice to
// make. Raise it with a small drag, then drop on it.
{
  const tile = page.locator('.hand .tile').first();
  const a = await tile.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y - 50);
  const zone = await page.locator('.dropzone').boundingBox();
  await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2);
  await page.mouse.up();
}
await page.waitForSelector('.pitch .tile', { timeout: 5000 });

const seen = new Map();
/** Keep going until both a straight run and a corner have been laid. */
const needMore = () => seen.size < 2 || (!seen.has(1) && !seen.has(3));
let placements = 0;
let refusals = 0;

/**
 * Try to lay one tile, trying each spot it is offered until one is taken.
 *
 * The demo never says what fits — that is the game — so spots appear at both
 * ends whatever is held, and a drop on the wrong one is an ordinary refusal.
 * Working through them is what a player does too.
 */
async function tryTile(tile) {
  // The hand is rebuilt whenever the table changes, so a tile picked out a
  // moment ago may not be there any more. That is not a fault; move on.
  try {
    await tile.click({ timeout: 2000 }); // tapping shows the spots on offer
  } catch {
    return false;
  }
  // Corners first: they are what was not possible before, and what is most
  // likely to be wrong. Straight on comes last.
  const spots = (await offeredSpots()).sort((a, b) => Number(a.dir === 0) - Number(b.dir === 0));

  for (const spot of spots) {
    const before = await tableBoxes();
    const neighbourId = spot.end === 'right' ? before[before.length - 1].id : before[0].id;
    const held = await tile.getAttribute('data-tile');

    await drag(tile, spot);
    const after = await tableBoxes();

    if (!after.some((t) => t.id === held)) {
      refusals++;
      // The refusal shake clears the selection, so show the spots again. If
      // the tile has gone from the hand there is nothing left to try.
      await page.waitForTimeout(650);
      try {
        await tile.click({ timeout: 2000 });
      } catch {
        return false;
      }
      continue;
    }

    placements++;
    const fresh = after.find((t) => t.id === held);
    const neighbour = after.find((t) => t.id === neighbourId);
    if (fresh === undefined || neighbour === undefined) {
      problems.push(`could not find the tile just played on the ${spot.end} end`);
      return true;
    }

    // dir 0 right, 1 down, 2 left, 3 up — from the tile it was laid against.
    const dx = fresh.cx - neighbour.cx;
    const dy = fresh.cy - neighbour.cy;
    const landed = [
      dx > 4 && Math.abs(dy) <= Math.abs(dx),
      dy > 4 && Math.abs(dx) <= Math.abs(dy),
      dx < -4 && Math.abs(dy) <= Math.abs(dx),
      dy < -4 && Math.abs(dx) <= Math.abs(dy),
    ][spot.dir];
    if (landed !== true) {
      problems.push(
        `dropped ${fresh.id} on the ${DIRS[spot.dir]} spot at the ${spot.end} end, ` +
          `but it landed ${dx.toFixed(0)},${dy.toFixed(0)} from ${neighbour.id}`,
      );
    } else {
      console.log(
        `${fresh.id} dropped ${DIRS[spot.dir]} of ${neighbour.id} (${spot.end} end): ` +
          `landed ${dx.toFixed(0)},${dy.toFixed(0)} — correct`,
      );
      seen.set(spot.dir, (seen.get(spot.dir) ?? 0) + 1);
    }
    return true;
  }
  return false;
}

for (let turn = 0; turn < 40 && needMore(); turn++) {
  const hand = page.locator('.hand .tile');
  const tiles = await hand.count();
  if (tiles === 0) break;

  let laid = false;
  for (let i = 0; i < tiles && !laid; i++) {
    laid = await tryTile(hand.nth(i));
  }
  if (!laid) {
    const pass = page.getByRole('button', { name: /^pass$/i });
    if ((await pass.count()) === 0) break;
    await pass.first().click();
    await page.waitForTimeout(60);
  }
}

// Nothing may sit on top of anything else, whatever shape the players made.
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
  `${placements} placed, ${refusals} refused, ${boxes.length} on the table; ` +
    `directions exercised: ${[...seen.keys()].map((d) => DIRS[d]).join(', ') || 'none'}`,
);
// Straight on worked before any of this. A corner is the new part.
if (!seen.has(1) && !seen.has(3)) {
  problems.push('no corner was ever laid — the check proved little');
}

await page.screenshot({ path: new URL('../demo/dist/placement.png', import.meta.url).pathname });
await browser.close();

if (problems.length > 0) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log(' -', p);
  process.exit(1);
}
console.log('OK: tiles land where they are dropped, and nothing overlaps.');
