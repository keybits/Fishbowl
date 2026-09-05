'use strict';

/** Renders a preview of the game's sounds to a WAV file, so the sound design
 *  can be judged by ear rather than by reading code.
 *
 *  It runs the real public/sound.js against an OfflineAudioContext, so what
 *  you hear is produced by the code that ships — not a reimplementation. */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { server } = require('../server');

const OUT = process.argv[2] || path.join(__dirname, '..', 'sound-preview.wav');

(async () => {
  await new Promise((res) => server.listen(0, res));
  const base = 'http://localhost:' + server.address().port;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(base);

  const result = await page.evaluate(async () => {
    const RATE = 44100;
    const SECONDS = 17;
    const off = new OfflineAudioContext(1, RATE * SECONDS, RATE);

    // An OfflineAudioContext reports state "suspended" until it renders, which
    // sound.js treats as "not ready". Present it as running; everything else
    // passes straight through to the real context.
    const shim = new Proxy(off, {
      get(target, key) {
        if (key === 'state') return 'running';
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const src = await (await fetch('sound.js')).text();
    const factory = new Function('window', 'localStorage', 'navigator',
      src + '; return window.Sound;');
    const Sound = factory(
      { AudioContext: function () { return shim; } },
      { getItem: () => null, setItem: () => {} },
      {}
    );
    Sound.unlock();

    // With currentTime pinned at 0, the optional `at` offset doubles as an
    // absolute position on the timeline. This is the last stretch of a turn.
    Sound.start(0);
    for (let i = 0; i < 4; i++) Sound.tick(i % 2 === 1, 1 + i);
    for (let i = 0; i < 10; i++) Sound.tickUrgent(i % 2 === 1, 5 + i);
    Sound.alarm(14.9);

    const buf = await off.startRendering();
    const data = buf.getChannelData(0);

    // Encode in-page: moving 750k floats across the bridge as JSON is far
    // slower than moving the finished 16-bit file as base64.
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    const bytes = new Uint8Array(data.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < data.length; i++) {
      view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, data[i])) * 32767), true);
    }
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return { pcm: btoa(binary), sampleRate: buf.sampleRate, samples: data.length, peak };
  });

  const pcm = Buffer.from(result.pcm, 'base64');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(result.sampleRate, 24);
  header.writeUInt32LE(result.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(OUT, Buffer.concat([header, pcm]));

  console.log('wrote ' + OUT);
  console.log('  ' + (result.samples / result.sampleRate).toFixed(1) + 's, peak amplitude ' +
    result.peak.toFixed(3));

  await browser.close();
  server.close();

  if (result.peak < 0.01) {
    console.error('SILENT RENDER — the sound module produced nothing');
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
