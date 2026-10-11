/**
 * Can you tell whose turn it is?
 *
 * Four people round a table on four phones cannot see each other's screens,
 * so the one question the page has to answer at a glance is "is it me?".
 * This drives a real game and checks the answer is there, in both states,
 * and that nothing is quietly broken in the saying of it.
 *
 * It exists because a generic class name has twice reshaped something it was
 * never meant to touch: a `.board` rule for the leaderboard moved every tile
 * on the table, and a `.turn` rule for this very badge collapsed the card of
 * the player it was pointing at. Both looked fine in the code.
 *
 * Needs a server running and Playwright:
 *   node server/dist/index.js &
 *   node scripts/check-turn.mjs http://127.0.0.1:3000/
 */

import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000/';
const problems = [];

const browser = await chromium.launch({
  executablePath:
    process.env['CHROMIUM'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});

// The narrowest phone worth caring about, and a common one.
for (const width of [360, 412]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('pageerror', (e) => problems.push(`${width}px: page error: ${e.message}`));

  await page.goto(BASE);
  await page.waitForSelector('#yourname', { timeout: 20_000 });
  await page.fill('#yourname', 'You');
  await page.getByRole('button', { name: 'Create table' }).click();
  await page.waitForSelector('text=Add a computer player', { timeout: 20_000 });
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Add a computer player' }).click();
    await page.waitForTimeout(200);
  }
  await page.getByRole('button', { name: /deal|start/i }).first().click();
  await page.waitForSelector('.opp', { timeout: 20_000 });

  /** Everything the page is saying about whose turn it is. */
  const readSignals = () =>
    page.evaluate(() => {
      const badge = document.querySelector('.whoseturn');
      const cards = [...document.querySelectorAll('.opp')].map((c) => {
        const name = c.querySelector('.name span:not(.dot):not(.tag)');
        const r = c.getBoundingClientRect();
        return {
          name: name === null ? '' : (name.textContent ?? ''),
          cut: name === null ? 0 : name.scrollWidth - name.clientWidth,
          onTurn: c.classList.contains('turn'),
          state: (c.querySelector('.sub .state')?.textContent ?? '').trim(),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
      return {
        // The spoken label, not the text: the words are spaced by the layout,
        // so textContent runs them together.
        badge: badge === null ? null : (badge.getAttribute('aria-label') ?? ''),
        mine: badge !== null && badge.classList.contains('mine'),
        handLit: document.querySelector('.handzone')?.classList.contains('mine') ?? false,
        clockBar: document.querySelector('.clockbar i') !== null,
        cards,
      };
    });

  let sawMine = false;
  let sawTheirs = false;

  for (let go = 0; go < 90 && !(sawMine && sawTheirs); go++) {
    await page.waitForTimeout(300);
    const s = await readSignals();
    if (s.badge === null) continue;

    // The cards must all be the same shape. A collapsed one is how a stray
    // rule shows up, and it is always the card being pointed at.
    const heights = s.cards.map((c) => c.h);
    if (Math.max(...heights) - Math.min(...heights) > 4) {
      problems.push(`${width}px: the players' cards are different heights (${heights.join(', ')})`);
    }
    for (const c of s.cards) {
      if (c.cut > 0) problems.push(`${width}px: "${c.name}" is cut off by ${c.cut}px`);
      if (c.name === '') problems.push(`${width}px: a player's card is showing no name`);
    }

    const onTurn = s.cards.filter((c) => c.onTurn);
    if (s.mine) {
      sawMine = true;
      if (!/YOUR TURN/i.test(s.badge)) problems.push(`${width}px: your turn, but it says "${s.badge}"`);
      if (!s.handLit) problems.push(`${width}px: your turn, but your hand is not lit`);
      if (onTurn.length !== 0) {
        problems.push(`${width}px: your turn, but ${onTurn[0].name}'s card is marked as playing`);
      }
    } else {
      sawTheirs = true;
      if (!/waiting for \S/i.test(s.badge)) {
        problems.push(`${width}px: somebody else's turn, but it says "${s.badge}"`);
      }
      if (s.handLit) problems.push(`${width}px: not your turn, but your hand is lit`);
      if (onTurn.length !== 1) {
        problems.push(`${width}px: ${onTurn.length} cards marked as playing, expected exactly one`);
      } else {
        if (onTurn[0].state !== 'PLAYING') {
          problems.push(`${width}px: the card on turn says "${onTurn[0].state}", not PLAYING`);
        }
        // The badge must name the same player the card points at.
        if (!s.badge.includes(onTurn[0].name)) {
          problems.push(
            `${width}px: the badge says "${s.badge}" but ${onTurn[0].name}'s card is the one marked`,
          );
        }
      }
    }
    if (!s.clockBar) problems.push(`${width}px: the turn clock bar is missing`);

    // Keep the game moving so both states come round.
    if (s.mine) {
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
          await page.waitForTimeout(300);
          if ((await page.locator('.pitch .tile').count()) > before) { laid = true; break; }
        }
      }
      if (!laid) {
        const pass = page.getByRole('button', { name: /^pass$/i });
        if (await pass.count()) await pass.first().click();
      }
    }
  }

  if (!sawMine) problems.push(`${width}px: never saw your own turn, so nothing was proved`);
  if (!sawTheirs) problems.push(`${width}px: never saw anyone else's turn`);
  console.log(`${width}px: your turn ${sawMine ? 'seen' : 'MISSED'}, someone else's ${sawTheirs ? 'seen' : 'MISSED'}`);
  await page.close();
}

await browser.close();
const unique = [...new Set(problems)];
if (unique.length > 0) {
  console.log('\nPROBLEMS:');
  for (const p of unique) console.log(' -', p);
  process.exit(1);
}
console.log('OK: the page says whose turn it is, and says the same thing twice over.');
