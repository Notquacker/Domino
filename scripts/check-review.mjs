/**
 * Can you look at the table once the round is over?
 *
 * How a hand finished — what the last tile was, who was left holding what —
 * is most of the conversation afterwards, and the result sheet covers the
 * board exactly when everyone wants to see it. This plays a round out to its
 * end, puts the sheet aside, and checks the board is really there behind it
 * and that the sheet comes back.
 *
 * Needs a server running and Playwright:
 *   node server/dist/index.js &
 *   node scripts/check-review.mjs http://127.0.0.1:3000/
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000/';
const problems = [];

const browser = await chromium.launch({
  executablePath:
    process.env['CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
// A tall window on purpose: that is where a board laid out to a guessed
// height instead of the real one leaves most of the screen standing empty.
const page = await browser.newPage({ viewport: { width: 760, height: 1080 } });
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

await page.goto(BASE);
await page.waitForSelector('#yourname', { timeout: 20_000 });
await page.fill('#yourname', 'Looker');
await page.getByRole('button', { name: 'Create table' }).click();
await page.waitForSelector('text=Add a computer player', { timeout: 20_000 });
for (let i = 0; i < 3; i++) {
  await page.getByRole('button', { name: 'Add a computer player' }).click();
  await page.waitForTimeout(200);
}
await page.getByRole('button', { name: /deal|start/i }).first().click();

const sheet = () => page.locator('.sheet').count();
const mine = () => page.locator('.handbar .hint').count().then((n) => n > 0);

// Play the round out. Taking the first spot that is accepted is enough:
// somebody goes out soon enough either way.
for (let go = 0; go < 160 && (await sheet()) === 0; go++) {
  await page.waitForTimeout(200);
  if (!(await mine())) continue;
  const hand = page.locator('.hand .tile');
  const n = await hand.count();
  let laid = false;
  for (let i = 0; i < n && !laid; i++) {
    if (!(await hand.nth(i).click({ timeout: 2000 }).then(() => true).catch(() => false))) continue;
    const sel = (await page.locator('.slot').count()) > 0 ? '.slot' : '.dropzone';
    const k = await page.locator(sel).count();
    for (let j = 0; j < k; j++) {
      const before = await page.locator('.pitch .tile').count();
      await page.locator(sel).nth(j).click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(220);
      if ((await page.locator('.pitch .tile').count()) > before) { laid = true; break; }
      if ((await sheet()) > 0) { laid = true; break; }
    }
  }
  if (!laid && (await sheet()) === 0) {
    const pass = page.getByRole('button', { name: /^pass$/i });
    if (await pass.count()) await pass.first().click();
    await page.waitForTimeout(220);
  }
}

if ((await sheet()) === 0) {
  problems.push('the round never finished, so nothing was proved');
} else {
  const laidOut = await page.locator('.pitch .tile').count();
  console.log(`the round ended with ${laidOut} tiles on the table`);

  const look = page.getByRole('button', { name: 'Look at the table' });
  if ((await look.count()) === 0) {
    problems.push('the result sheet offers no way to look at the table');
  } else {
    await look.first().click();
    await page.waitForTimeout(250);
    if ((await sheet()) > 0) problems.push('the sheet is still covering the board');
    const seen = await page.locator('.pitch .tile').count();
    console.log(`with the sheet put aside, ${seen} tiles are in view`);
    if (seen !== laidOut) {
      problems.push(`the board shows ${seen} tiles, not the ${laidOut} it ended with`);
    }
    // Nothing on the board may be hidden behind an overlay.
    const covered = await page.evaluate(() => document.querySelector('.overlay') !== null);
    if (covered) problems.push('something is still laid over the table');

    // What everyone was left holding. Hidden all through the round; shown
    // once it is settled, because counting them is how the score is made.
    const held = await page.evaluate(() =>
      [...document.querySelectorAll('.revealseat')].map((c) => ({
        who: c.querySelector('.revealname span')?.textContent ?? '',
        tiles: c.querySelectorAll('.revealtiles .tile').length,
        says: c.querySelector('.revealname .sub')?.textContent ?? '',
      })),
    );
    if (held.length < 3) {
      problems.push(`only ${held.length} players' tiles are shown, expected at least three`);
    } else {
      console.log(
        'shown: ' + held.map((h) => `${h.who} (${h.says})`).join(', '),
      );
      for (const h of held) {
        if (h.who === '') problems.push('a revealed hand has no name on it');
        const says = /^(\d+) tiles?/.exec(h.says);
        const claimed = says === null ? 0 : Number(says[1]);
        if (claimed !== h.tiles) {
          problems.push(`${h.who} is said to hold ${claimed} tiles but ${h.tiles} are drawn`);
        }
      }
    }

    // And the board should be using the room it has, not a fraction of it.
    const fill = await page.evaluate(() => {
      const table = document.querySelector('.table');
      const tiles = [...document.querySelectorAll('.pitch .tile')];
      if (table === null || tiles.length === 0) return null;
      const v = table.getBoundingClientRect();
      let shortSide = 0;
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const t of tiles) {
        const r = t.getBoundingClientRect();
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
        // A tile's short side, which is what "full size" means: they are
        // all at the same scale, so the largest is the scale.
        shortSide = Math.max(shortSide, Math.min(r.width, r.height));
      }
      return {
        across: (right - left) / v.width,
        down: (bottom - top) / v.height,
        shortest: Math.round(shortSide),
      };
    });
    if (fill === null) {
      problems.push('could not measure how much of the table the board uses');
    } else {
      const uses = Math.round(Math.max(fill.across, fill.down) * 100);
      console.log(`the board fills ${uses}% of the table, tiles ${fill.shortest}px across`);
      // Either it has grown until one side of it meets the edge of the
      // room, or the tiles are already at their natural size and it has no
      // reason to grow further. Anything else is a board laid out to a
      // guess rather than to the space it has.
      if (uses < 85 && fill.shortest < 38) {
        problems.push(
          `the board uses only ${uses}% of the table and its tiles are ${fill.shortest}px across, ` +
            'short of the 40 they could be',
        );
      }
    }

    const back = page.getByRole('button', { name: 'Show the result' });
    if ((await back.count()) === 0) {
      problems.push('no way back to the result once the sheet is put aside');
    } else {
      await back.first().click();
      await page.waitForTimeout(250);
      if ((await sheet()) === 0) problems.push('the result sheet did not come back');
      else console.log('the result comes back when asked for');
    }
  }
}

await page.screenshot({ path: 'client/dist/review.png' });
await browser.close();
if (problems.length > 0) {
  console.log('\nPROBLEMS:');
  for (const p of [...new Set(problems)]) console.log(' -', p);
  process.exit(1);
}
console.log('OK: the table can be looked at once the round is over.');
