/**
 * Can you actually type on a phone?
 *
 * This guards a bug that made the game unusable: `render()` rebuilds the page
 * with `replaceChildren`, which destroys whatever input had focus. On Android
 * the on-screen keyboard appearing IS a window resize, so focusing the name
 * field fired a resize, which re-rendered, which tore out the field, which
 * closed the keyboard, which fired another resize. The keyboard flickered up
 * and down and not a character could be entered.
 *
 * Two things keep it fixed and both are checked here:
 *   1. a height-only resize (the keyboard) must not re-render at all;
 *   2. when something else does re-render, focus and the caret must come back.
 *
 * Needs a server running and Playwright installed:
 *   node server/dist/index.js &
 *   node scripts/check-keyboard.mjs http://127.0.0.1:3000/
 */

import { chromium } from 'playwright';

const target = process.argv[2] ?? 'http://127.0.0.1:3000/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({
  viewport: { width: 412, height: 900 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
await page.goto(target);
await page.waitForSelector('#yourname', { timeout: 20_000 });

/** Is the focused element still the very node we started typing in? */
const sameNode = () =>
  page.evaluate(() => document.activeElement?.dataset?.mark === 'watched');

await page.locator('#yourname').click();
await page.evaluate(() => {
  document.activeElement.dataset.mark = 'watched';
});
check('the name field takes focus when tapped', await sameNode());

// The keyboard opening: the window gets shorter, nothing else changes.
await page.setViewportSize({ width: 412, height: 520 });
await sleep(400);
check('focus survives the keyboard opening', await sameNode());

await page.keyboard.type('Shon Pedro', { delay: 40 });
await sleep(300);
const typed = await page.locator('#yourname').inputValue();
check('the name actually gets typed', typed === 'Shon Pedro', JSON.stringify(typed));

// A width change is a real layout change and must still re-render — but it
// must not cost the player what they were halfway through writing.
await page.setViewportSize({ width: 900, height: 520 });
await sleep(400);
const kept = await page.locator('#yourname').inputValue();
check('a rotation keeps the text', kept === 'Shon Pedro', JSON.stringify(kept));
check('a rotation restores focus to the field', await page.evaluate(
  () => document.activeElement?.id === 'yourname',
));

// The room code is the other field nobody could fill in.
await page.setViewportSize({ width: 412, height: 900 });
await sleep(200);
await page.locator('#tablecode').click();
await page.setViewportSize({ width: 412, height: 520 });
await sleep(300);
await page.keyboard.type('5LYD', { delay: 40 });
await sleep(200);
const code = await page.locator('#tablecode').inputValue();
check('the table code can be typed', code.toUpperCase() === '5LYD', JSON.stringify(code));

await browser.close();

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nAll keyboard checks passed.');
