'use strict';

/** Drives the real UI in a phone-sized Chromium across four simulated
 *  devices and screenshots each key screen. Not an assertion suite — this
 *  exists to catch layout and wiring bugs that headless logic tests miss. */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { server } = require('../server');

const SHOTS = path.join(__dirname, '..', 'shots');
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await new Promise((res) => server.listen(0, res));
  const base = 'http://localhost:' + server.address().port;

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const problems = [];

  // One context per phone: contexts share localStorage, and the app
  // deliberately auto-rejoins a returning device, so a shared context would
  // make every "guest" resume as the host.
  const open = async () => {
    const ctx = await browser.newContext({ viewport: PHONE, ...PHONE });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => problems.push('JS error: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    await p.goto(base);
    return p;
  };

  const shot = async (page, name) => {
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(SHOTS, name + '.png') });
    console.log('  · ' + name);
  };

  // ---- leader creates -------------------------------------------------
  const host = await open();
  await shot(host, '01-home');

  await host.click('[data-act="go-create"]');
  await host.fill('#name', 'Isaac');
  await host.click('[data-cpp="2"]');
  await shot(host, '02-create');
  await host.click('[data-act="do-create"]');
  await host.waitForSelector('[data-card="0"]');

  const code = (await host.textContent('.code-chip')).trim();
  console.log('  room code: ' + code);
  await shot(host, '03-write-cards');

  // ---- three more phones join ----------------------------------------
  const names = ['Aoife', 'Cian', 'Niamh'];
  const guests = [];
  for (const name of names) {
    const g = await open();
    await g.click('[data-act="go-join"]');
    await g.fill('#code', code);
    if (guests.length === 0) await shot(g, '04-join-code');
    await g.click('[data-act="code-next"]');
    await g.fill('#name', name);
    if (guests.length === 0) await shot(g, '05-join-name');
    await g.click('[data-act="do-join"]');
    await g.waitForSelector('[data-card="0"]');
    guests.push(g);
  }

  // ---- everyone writes cards -----------------------------------------
  const decks = {
    Isaac: ['Ballydehob', 'wing foiling'],
    Aoife: ['a slow puncture', 'Mrs Doubtfire'],
    Cian: ['the Wild Atlantic Way', 'sourdough starter'],
    Niamh: ['parallel parking', 'Eurovision'],
  };
  const fillCards = async (page, who) => {
    for (let i = 0; i < decks[who].length; i++) await page.fill('[data-card="' + i + '"]', decks[who][i]);
    await page.click('[data-act="submit-cards"]');
  };
  await fillCards(host, 'Isaac');
  for (let i = 0; i < guests.length; i++) await fillCards(guests[i], names[i]);

  await host.waitForSelector('[data-act="open-teams"]:not([disabled])');
  await shot(host, '06-lobby-leader');
  await shot(guests[0], '07-lobby-player');

  // ---- teams ----------------------------------------------------------
  await host.click('[data-act="open-teams"]');
  await host.waitForSelector('[data-act="randomise"]');
  await host.click('[data-act="randomise"]');
  await host.waitForTimeout(200);
  await shot(host, '08-teams');
  await shot(guests[0], '09-teams-player');

  await host.click('[data-act="start"]');
  await host.waitForSelector('[data-act="ready-turn"]');
  await shot(host, '10-round-intro');
  await shot(guests[0], '11-round-intro-player');

  // handover panel
  await host.click('[data-act="toggle-handover"]');
  await shot(host, '12-handover');
  await host.click('[data-act="toggle-handover"]');

  // ---- play -----------------------------------------------------------
  await host.click('[data-dur="30"]');
  await host.click('[data-act="ready-turn"]');
  await host.waitForSelector('[data-act="begin-turn"]');
  await shot(host, '13-pass-phone');
  await shot(guests[0], '14-spectator');

  await host.click('[data-act="begin-turn"]');
  await host.waitForSelector('#card');
  await shot(host, '15-playing');

  const cardText = (await host.textContent('#card')).trim();
  if (!cardText) problems.push('card face rendered empty');

  await host.click('[data-act="correct"]');
  await host.waitForTimeout(150);
  await host.click('[data-act="skip"]');
  await host.waitForTimeout(150);
  await shot(host, '16-playing-after');

  // burn through the rest of the round
  for (let i = 0; i < 12; i++) {
    if (!(await host.$('[data-act="correct"]'))) break;
    await host.click('[data-act="correct"]');
    await host.waitForTimeout(110);
  }

  await host.waitForSelector('[data-act="advance"]', { timeout: 5000 });
  await shot(host, '17-turn-summary');

  await host.click('[data-adjust="1"]');
  await host.waitForTimeout(200);
  await shot(host, '18-summary-edited');
  await host.click('[data-adjust="-1"]');
  await host.waitForTimeout(200);

  await host.click('[data-act="advance"]');
  await host.waitForSelector('[data-act="ready-turn"]');
  await shot(host, '19-round-two');

  // ---- end early to reach the final board -----------------------------
  host.on('dialog', (d) => d.accept());
  await host.click('[data-act="end-game"]');
  await host.waitForSelector('[data-act="leave"]', { timeout: 5000 });
  await shot(host, '20-final-board');
  await shot(guests[0], '21-final-player');

  // ---- landscape sanity check ----------------------------------------
  await host.setViewportSize({ width: 844, height: 390 });
  await shot(host, '22-landscape');

  // ---- small-phone check ---------------------------------------------
  const small = await browser.newContext({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
  const sp = await small.newPage();
  await sp.goto(base);
  await sp.click('[data-act="go-create"]');
  await sp.fill('#name', 'Tiny');
  await sp.click('[data-act="do-create"]');
  await sp.waitForSelector('[data-card="0"]');
  await sp.screenshot({ path: path.join(SHOTS, '23-small-phone.png') });
  console.log('  · 23-small-phone');

  // horizontal overflow check across the pages we built
  const overflow = await host.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  if (overflow) problems.push('page scrolls horizontally');

  await browser.close();
  server.close();

  console.log('\n' + (problems.length ? 'PROBLEMS:\n  ' + problems.join('\n  ') : 'No JS errors, no overflow.'));
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
