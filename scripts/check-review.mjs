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
const page = await browser.newPage({ viewport: { width: 412, height: 900 } });
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
