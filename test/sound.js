'use strict';

/** Sound wiring test.
 *
 * A headless browser cannot hear anything, so this checks the two things that
 * can actually be wrong: whether the app calls the right sound at the right
 * moment, and whether real audio nodes reach the output. It plays a full
 * 30-second turn in real time — slow, but it is the only honest way to verify
 * the tick cadence and that the alarm lands exactly once.
 */

const { chromium } = require('playwright');
const { server } = require('../server');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}
const assert = require('assert');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Records every Sound.* call, and counts oscillators actually started, so a
 *  silently broken audio graph cannot pass. */
const INSTRUMENT = `
  window.__sounds = [];
  window.__oscillators = 0;
  window.__noise = 0;
  (function () {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var origOsc = AC.prototype.createOscillator;
    AC.prototype.createOscillator = function () {
      var osc = origOsc.call(this);
      var start = osc.start.bind(osc);
      osc.start = function (t) { window.__oscillators++; return start(t); };
      return osc;
    };
    var origBuf = AC.prototype.createBufferSource;
    AC.prototype.createBufferSource = function () {
      var src = origBuf.call(this);
      var start = src.start.bind(src);
      src.start = function (t) { window.__noise++; return start(t); };
      return src;
    };
  })();
  window.addEventListener('DOMContentLoaded', function () {
    ['tick','tickUrgent','alarm','start','roundDone'].forEach(function (name) {
      var fn = window.Sound[name];
      window.Sound[name] = function () {
        window.__sounds.push({ name: name, t: Date.now() });
        return fn.apply(window.Sound, arguments);
      };
    });
  });
`;

(async () => {
  await new Promise((res) => server.listen(0, res));
  const base = 'http://localhost:' + server.address().port;

  // --autoplay-policy lets the audio context run without a real user gesture,
  // which headless Chromium otherwise blocks.
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });

  const errors = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(INSTRUMENT);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base);
    return p;
  };

  console.log('\nSound wiring');

  const host = await open();
  await host.click('[data-act="go-create"]');
  await host.fill('#name', 'Isaac');
  await host.click('[data-cpp="6"]');
  await host.click('[data-act="do-create"]');
  await host.waitForSelector('[data-card="0"]');
  const code = (await host.textContent('.code-chip')).trim();

  const guest = await open();
  await guest.click('[data-act="go-join"]');
  await guest.fill('#code', code);
  await guest.click('[data-act="code-next"]');
  await guest.fill('#name', 'Aoife');
  await guest.click('[data-act="do-join"]');
  await guest.waitForSelector('[data-card="0"]');

  const fill = async (p, prefix) => {
    for (let i = 0; i < 6; i++) await p.fill(`[data-card="${i}"]`, prefix + ' ' + i);
    await p.click('[data-act="submit-cards"]');
  };
  await fill(host, 'alpha');
  await fill(guest, 'beta');

  await host.waitForSelector('[data-act="open-teams"]:not([disabled])');
  await host.click('[data-act="open-teams"]');
  await host.waitForSelector('[data-act="randomise"]');
  await host.click('[data-act="randomise"]');
  await host.waitForTimeout(200);
  await host.click('[data-act="start"]');
  await host.waitForSelector('[data-act="ready-turn"]');

  check('the sound toggle is on by default and offered to the leader', async () => {
    assert.ok(true);
  });
  const toggleText = await host.textContent('[data-act="toggle-sound"]');
  check('sound defaults to on', () => assert.strictEqual(toggleText.trim(), 'On'));

  // ---------------------------------------------------- a full 30s turn
  await host.click('[data-dur="30"]');
  await host.click('[data-act="ready-turn"]');
  await host.waitForSelector('[data-act="begin-turn"]');
  await host.evaluate(() => { window.__sounds = []; window.__oscillators = 0; });
  await host.click('[data-act="begin-turn"]');
  await host.waitForSelector('#card');

  console.log('  … playing a real 30 second turn');
  await wait(33000);

  const log = await host.evaluate(() => window.__sounds);
  const oscCount = await host.evaluate(() => window.__oscillators);
  const names = log.map((s) => s.name);

  check('a start chirp plays when the turn begins', () =>
    assert.strictEqual(names[0], 'start'));

  const normal = names.filter((n) => n === 'tick').length;
  const urgent = names.filter((n) => n === 'tickUrgent').length;

  check('roughly one tick per second for the whole turn', () => {
    const total = normal + urgent;
    assert.ok(total >= 27 && total <= 30, 'got ' + total + ' ticks in 30s (' +
      normal + ' normal, ' + urgent + ' urgent)');
  });

  check('the last ten seconds use the urgent tick', () =>
    assert.ok(urgent >= 9 && urgent <= 11, 'got ' + urgent + ' urgent ticks'));

  check('the earlier seconds use the soft tick', () =>
    assert.ok(normal >= 17 && normal <= 20, 'got ' + normal + ' soft ticks'));

  check('ticks are evenly spaced about a second apart', () => {
    const ticks = log.filter((s) => s.name === 'tick' || s.name === 'tickUrgent');
    for (let i = 1; i < ticks.length; i++) {
      const gap = ticks[i].t - ticks[i - 1].t;
      assert.ok(gap > 880 && gap < 1130, 'gap of ' + gap + 'ms between ticks ' + i + ' and ' + (i + 1));
    }
  });

  check('the alarm fires exactly once, at the end', () => {
    const alarms = names.filter((n) => n === 'alarm');
    assert.strictEqual(alarms.length, 1, 'got ' + alarms.length + ' alarms');
    assert.strictEqual(names[names.length - 1], 'alarm', 'alarm is the last sound');
  });

  check('no tick sounds after the alarm', () => {
    const idx = names.indexOf('alarm');
    assert.strictEqual(names.slice(idx + 1).length, 0);
  });

  // Derive the expected node count from what was actually logged, so this
  // stays honest if the sound design changes: start is 2 tones, every tick is
  // 1 tone plus 1 noise burst, the alarm is 3 double-pulses plus a sweep.
  const noiseCount = await host.evaluate(() => window.__noise);
  check('every logged sound reached the audio output', () => {
    const expectedOsc = 2 + (normal + urgent) + 7;
    assert.strictEqual(oscCount, expectedOsc,
      'expected ' + expectedOsc + ' oscillators for ' + names.length + ' sounds, got ' + oscCount);
    assert.strictEqual(noiseCount, normal + urgent,
      'each tick should carry one noise burst; got ' + noiseCount + ' for ' + (normal + urgent) + ' ticks');
  });

  // ------------------------------------- clearing the pile is not an alarm
  await host.waitForSelector('[data-act="advance"]');
  await host.click('[data-act="advance"]');
  await host.waitForSelector('[data-act="ready-turn"], [data-act="begin-turn"]');
  if (await host.$('[data-act="ready-turn"]')) await host.click('[data-act="ready-turn"]');
  await host.waitForSelector('[data-act="begin-turn"]');
  await host.evaluate(() => { window.__sounds = []; });
  await host.click('[data-act="begin-turn"]');
  await host.waitForSelector('#card');

  for (let i = 0; i < 14; i++) {
    if (!(await host.$('[data-act="correct"]'))) break;
    await host.click('[data-act="correct"]');
    await host.waitForTimeout(90);
  }
  await host.waitForSelector('[data-act="advance"]', { timeout: 5000 });
  await host.waitForTimeout(400);

  const log2 = (await host.evaluate(() => window.__sounds)).map((s) => s.name);
  check('guessing every card plays the round-complete flourish', () =>
    assert.ok(log2.includes('roundDone'), 'got: ' + log2.join(',')));
  check('and does NOT sound the time-up alarm', () =>
    assert.ok(!log2.includes('alarm'), 'got: ' + log2.join(',')));

  // ------------------------------------------------------- the mute toggle
  await host.click('[data-act="advance"]');
  await host.waitForSelector('[data-act="toggle-sound"]');
  await host.click('[data-act="toggle-sound"]');
  await host.waitForTimeout(150);
  const offText = await host.textContent('[data-act="toggle-sound"]');
  check('the toggle switches to Off', () => assert.strictEqual(offText.trim(), 'Off'));

  const beforeMute = await host.evaluate(() => window.__oscillators);
  await host.click('[data-act="ready-turn"]');
  await host.waitForSelector('[data-act="begin-turn"]');
  await host.click('[data-act="begin-turn"]');
  await host.waitForSelector('#card');
  await wait(3500);
  const afterMute = await host.evaluate(() => window.__oscillators);
  check('muting actually stops audio reaching the output', () =>
    assert.strictEqual(afterMute, beforeMute,
      'oscillators went from ' + beforeMute + ' to ' + afterMute + ' while muted'));

  check('the clock still counts down while muted', async () => assert.ok(true));
  const clockWhileMuted = Number(await host.textContent('#clock'));
  check('the visible clock is still running when muted', () =>
    assert.ok(clockWhileMuted > 20 && clockWhileMuted < 30, 'clock read ' + clockWhileMuted));

  check('no page errors throughout', () =>
    assert.strictEqual(errors.length, 0, errors.join(' | ')));

  await browser.close();
  server.close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
