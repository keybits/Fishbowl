/* Fruit Salad — sound.
 *
 * Everything is synthesised with the Web Audio API. No audio files: nothing to
 * download, nothing to fail on a bad connection at a party, and the whole thing
 * is about 3 KB.
 *
 * Two things matter for phones:
 *  - iOS will not let a page make noise until the user has tapped something, and
 *    it suspends the audio context when the page is backgrounded. `unlock()` is
 *    therefore called on every tap; it is cheap and idempotent.
 *  - A phone that has been on silent all evening still cannot play through the
 *    ringer switch on iOS. Nothing can be done about that in a web app — the
 *    README says so.
 */
window.Sound = (function () {
  'use strict';

  var ctx = null;
  var master = null;
  var enabled = true;

  try {
    var saved = localStorage.getItem('fb.sound');
    if (saved === 'off') enabled = false;
  } catch (e) { /* private mode */ }

  function supported() {
    return typeof (window.AudioContext || window.webkitAudioContext) === 'function';
  }

  /** Safe to call on every tap. Creates the context on first gesture and
   *  resumes it if the OS suspended it while backgrounded. */
  function unlock() {
    if (!supported()) return;
    try {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 1;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e) { ctx = null; }
  }

  function ready() {
    return enabled && ctx && ctx.state === 'running';
  }

  /**
   * One shaped tone. Attack and release are deliberate: a raw gain switch
   * produces an audible click on most phone speakers.
   */
  function tone(opts) {
    if (!ready()) return;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var dur = opts.duration;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();

    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + dur);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(opts.gain, t0 + Math.min(0.012, dur * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  /** A short filtered noise burst — gives the tick a woody edge rather than a
   *  pure beep, which cuts through room noise better. */
  function click(gainValue, delay) {
    if (!ready()) return;
    var t0 = ctx.currentTime + (delay || 0);
    var len = Math.floor(ctx.sampleRate * 0.02);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 5);
    }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 1.4;
    var g = ctx.createGain();
    g.gain.value = gainValue;
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t0);
  }

  return {
    unlock: unlock,
    supported: supported,

    isEnabled: function () { return enabled; },

    setEnabled: function (on) {
      enabled = !!on;
      try { localStorage.setItem('fb.sound', enabled ? 'on' : 'off'); } catch (e) {}
      if (enabled) unlock();
    },

    /* Every call takes an optional `at` offset in seconds. The game always
     * omits it (play now); the offline renderer in test/render-audio.js uses
     * it to lay these out on a timeline, so the preview you hear is produced
     * by this exact code rather than a reimplementation of it. */

    /** Ordinary second passing. Alternating pitch gives it a tick-tock feel
     *  so the room hears time moving rather than a metronome. */
    tick: function (odd, at) {
      tone({ freq: odd ? 1050 : 880, duration: 0.045, gain: 0.05, type: 'triangle', delay: at });
      click(0.035, at);
    },

    /** Final ten seconds — louder, brighter, with a bit more bite. */
    tickUrgent: function (odd, at) {
      tone({ freq: odd ? 1500 : 1250, duration: 0.055, gain: 0.16, type: 'square', delay: at });
      click(0.12, at);
    },

    /** Time up. Three hard bursts with a low body underneath, so it reads as
     *  an alarm and not as another tick. */
    alarm: function (at) {
      if (!ready()) return;
      var base = at || 0;
      for (var i = 0; i < 3; i++) {
        var d = base + i * 0.26;
        tone({ freq: 880, duration: 0.2, gain: 0.28, type: 'square', delay: d });
        tone({ freq: 220, duration: 0.22, gain: 0.22, type: 'sawtooth', delay: d });
      }
      tone({ freq: 300, sweepTo: 120, duration: 0.5, gain: 0.2, type: 'sawtooth', delay: base + 0.78 });
      try { if (navigator.vibrate) navigator.vibrate([220, 90, 220, 90, 320]); } catch (e) {}
    },

    /** Small confirmation when the turn actually starts. */
    start: function (at) {
      var base = at || 0;
      tone({ freq: 620, duration: 0.1, gain: 0.16, type: 'triangle', delay: base });
      tone({ freq: 930, duration: 0.14, gain: 0.14, type: 'triangle', delay: base + 0.09 });
    },

    /** Every card in the round has been guessed. */
    roundDone: function (at) {
      var base = at || 0;
      [523, 659, 784, 1047].forEach(function (f, i) {
        tone({ freq: f, duration: 0.18, gain: 0.16, type: 'triangle', delay: base + i * 0.1 });
      });
    }
  };
})();
