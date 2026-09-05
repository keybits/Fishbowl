/* Fishbowl — client.
 * One socket, one state object from the server, one render function.
 * Everything the player sees is derived from `state`; nothing is guessed
 * locally except the countdown, which ticks against the server's end time.
 */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var offlineBar = document.getElementById('offline');

  var ws = null;
  var state = null;          // latest server snapshot
  var screen = 'home';       // pre-game local screen
  var joinCode = '';
  var draftCards = [];       // survives re-renders while writing cards
  var showHandover = false;
  var lastKey = '';
  var tickTimer = null;
  var toastTimer = null;
  var reconnectDelay = 500;
  var clockOffset = 0;       // server clock minus this device's clock

  // Sound bookkeeping, keyed to the turn's end time so a state update
  // arriving mid-turn (someone joining, a score changing) cannot restart the
  // ticking or re-fire the alarm.
  var soundTurn = null;
  var lastTickSecond = null;
  var alarmFired = false;
  var lastPhase = null;

  var stored = {
    get code() { try { return localStorage.getItem('fb.code'); } catch (e) { return null; } },
    get playerId() { try { return localStorage.getItem('fb.pid'); } catch (e) { return null; } },
    save: function (code, pid) {
      try { localStorage.setItem('fb.code', code); localStorage.setItem('fb.pid', pid); } catch (e) {}
    },
    clear: function () {
      try { localStorage.removeItem('fb.code'); localStorage.removeItem('fb.pid'); } catch (e) {}
    }
  };

  // ------------------------------------------------------------- socket
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = function () {
      reconnectDelay = 500;
      offlineBar.hidden = true;
      if (stored.code && stored.playerId) {
        send({ type: 'rejoin', code: stored.code, playerId: stored.playerId });
      }
    };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }

      if (msg.type === 'state') {
        state = msg.state;
        // Phone clocks drift by seconds. Correcting against the server keeps
        // every screen in the room showing the same number.
        if (typeof state.now === 'number') clockOffset = state.now - Date.now();
        render();
      } else if (msg.type === 'joined') {
        stored.save(msg.code, msg.playerId);
        screen = 'game';
      } else if (msg.type === 'rejoin-failed') {
        stored.clear();
        state = null;
        screen = 'home';
        render();
      } else if (msg.type === 'error') {
        toast(msg.message);
        render();
      }
    };

    ws.onclose = function () {
      offlineBar.hidden = false;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
    };

    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    else toast('Still reconnecting — try again in a second.');
  }

  function toast(message) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, 3200);
  }

  // ------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function words(s) { return String(s).trim().split(/\s+/).filter(Boolean).length; }

  function on(sel, ev, fn) {
    var nodes = app.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) nodes[i].addEventListener(ev, fn);
  }

  function teamPill(team) {
    if (!team) return '';
    return '<span class="team-pill"><span class="swatch" style="background:' + esc(team.color) +
      '"></span>' + esc(team.name) + '</span>';
  }

  function findTeam(id) {
    if (!state || !state.teams) return null;
    for (var i = 0; i < state.teams.length; i++) if (state.teams[i].id === id) return state.teams[i];
    return null;
  }

  // ------------------------------------------------------------- topbar
  function topbar(opts) {
    opts = opts || {};
    var left = opts.code
      ? '<span class="code-chip">' + esc(state.code) + '</span>'
      : '<span class="label">' + esc(opts.label || '') + '</span>';
    var right = '';
    if (opts.endGame) {
      right = '<button class="btn-small btn-danger" data-act="end-game">End game</button>';
    } else if (opts.back) {
      right = '<button class="btn-small btn-ghost" data-act="back">Back</button>';
    }
    return '<div class="topbar">' + left + '<span class="spacer"></span>' + right + '</div>';
  }

  // ------------------------------------------------------------- render
  function render() {
    var key = renderKey();
    // Re-rendering while someone is typing would eat their keystrokes, so a
    // rebuild only happens when the key actually moves.
    if (key === lastKey) { patch(); return; }
    lastKey = key;

    var html = '';
    if (!state || screen !== 'game') html = renderPreGame();
    else html = renderGame();

    app.innerHTML = html;
    wire();
    patch();
  }

  function renderKey() {
    if (!state || screen !== 'game') return 'pre:' + screen + ':' + joinCode.length;
    var k = 'g:' + state.phase + ':' + state.roundIndex + ':' + (state.youAreHost ? 'h' : 'p') +
      ':' + (state.you ? state.you.submitted : '') + ':' + showHandover +
      ':' + (Sound.isEnabled() ? 's1' : 's0');
    // Card writing must not be interrupted by other people joining.
    if (state.phase === 'lobby' && state.you && !state.you.submitted) return k + ':writing';
    k += ':' + state.players.map(function (p) { return p.id + (p.submitted ? 1 : 0) + (p.teamId || '') + (p.connected ? 'c' : 'd'); }).join(',');
    k += ':' + state.teams.length + ':' + state.turnDuration;
    if (state.turn) k += ':' + state.turn.playerId;
    // Taking a card back changes the summary under the leader's fingers, and
    // there is nothing to type into on that screen, so rebuild it on any move.
    if (state.summary) k += ':' + state.summary.correct + ':' + state.cardsLeft;
    return k;
  }

  // ---------------------------------------------------------- pre-game
  function renderPreGame() {
    if (screen === 'home') {
      return topbar({ label: 'Fishbowl' }) +
        '<div class="screen">' +
          '<div class="grow" style="display:flex;flex-direction:column;justify-content:center;padding-bottom:14vh">' +
            '<h1>Fishbowl</h1>' +
            '<p class="lede">Everyone writes a few cards. Four rounds, same cards, ' +
            'a new way to explain them every time.</p>' +
            '<div class="stack">' +
              '<button class="btn-primary btn-block" data-act="go-create">Create game</button>' +
              '<button class="btn-block btn-ghost" data-act="go-join">Join game</button>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    if (screen === 'join-code') {
      return topbar({ label: 'Join a game', back: true }) +
        '<div class="screen">' +
          '<h2>Enter the code</h2>' +
          '<p>The person who made the game has it on their screen.</p>' +
          '<input class="code-input" id="code" maxlength="4" autocomplete="off" ' +
            'autocapitalize="characters" autocorrect="off" spellcheck="false" ' +
            'inputmode="text" value="' + esc(joinCode) + '" placeholder="････">' +
          '<div class="grow"></div>' +
          '<div class="sticky-foot">' +
            '<button class="btn-primary btn-block" data-act="code-next"' +
              (joinCode.length === 4 ? '' : ' disabled') + '>Continue</button>' +
          '</div>' +
        '</div>';
    }

    if (screen === 'join-name') {
      return topbar({ label: 'Joining ' + esc(joinCode), back: true }) +
        '<div class="screen">' +
          '<h2>What should we call you?</h2>' +
          '<p>This is the name your team will see when it is your turn.</p>' +
          '<label class="field"><span class="cap">Your name</span>' +
            '<input type="text" id="name" maxlength="20" autocomplete="off" placeholder="Isaac"></label>' +
          '<div class="grow"></div>' +
          '<div class="sticky-foot">' +
            '<button class="btn-primary btn-block" data-act="do-join">Join game</button>' +
          '</div>' +
        '</div>';
    }

    if (screen === 'create') {
      return topbar({ label: 'New game', back: true }) +
        '<div class="screen">' +
          '<h2>Set it up</h2>' +
          '<p>You will be the leader. Your phone runs the game once everyone has written their cards.</p>' +
          '<label class="field"><span class="cap">Your name</span>' +
            '<input type="text" id="name" maxlength="20" autocomplete="off" placeholder="Isaac"></label>' +
          '<label class="field"><span class="cap">Cards per player</span></label>' +
          '<div class="chips" id="cpp">' +
            [1, 2, 3, 4, 5, 6].map(function (n) {
              return '<button class="chip' + (n === 3 ? ' sel' : '') + '" data-cpp="' + n + '">' + n + '</button>';
            }).join('') +
          '</div>' +
          
          '<div class="grow"></div>' +
          '<div class="sticky-foot">' +
            '<button class="btn-primary btn-block" data-act="do-create">Create game</button>' +
          '</div>' +
        '</div>';
    }

    return '';
  }

  // ------------------------------------------------------------- in-game
  function renderGame() {
    switch (state.phase) {
      case 'lobby':      return state.you && !state.you.submitted ? renderWriting() : renderLobby();
      case 'teams':      return renderTeams();
      case 'roundIntro': return renderRoundIntro();
      case 'turnReady':  return renderTurnReady();
      case 'playing':    return renderPlaying();
      case 'turnSummary':return renderSummary();
      case 'gameOver':   return renderGameOver();
      default:           return topbar({ code: true }) + '<div class="screen"><p>Loading…</p></div>';
    }
  }

  function renderWriting() {
    var n = state.cardsPerPlayer;
    if (draftCards.length !== n) {
      var next = [];
      for (var i = 0; i < n; i++) next.push(draftCards[i] || '');
      draftCards = next;
    }
    var rows = '';
    for (var j = 0; j < n; j++) {
      var v = draftCards[j] || '';
      var wc = words(v);
      rows += '<div class="card-row">' +
        '<span class="num">' + (j + 1) + '</span>' +
        '<input type="text" data-card="' + j + '" maxlength="60" autocomplete="off" ' +
          'placeholder="Word or short phrase" value="' + esc(v) + '">' +
        '<span class="wc' + (wc > 5 ? ' over' : '') + '" data-wc="' + j + '">' + (v ? wc + '/5' : '') + '</span>' +
        '</div>';
    }
    return topbar({ code: true }) +
      '<div class="screen">' +
        '<h2>Write your cards</h2>' +
        '<p>Anything goes — a person, a film, an in-joke. Five words maximum each.</p>' +
        '<div class="scroll">' + rows +
          '<p class="hint mt">Nobody sees these until they come up in the game.</p>' +
        '</div>' +
        '<div class="sticky-foot">' +
          '<button class="btn-primary btn-block" data-act="submit-cards">Confirm my cards</button>' +
        '</div>' +
      '</div>';
  }

  function renderLobby() {
    var everyone = state.players.every(function (p) { return p.submitted; });
    var waiting = state.players.filter(function (p) { return !p.submitted; });

    var items = state.players.map(function (p) {
      var isHost = p.id === state.hostId;
      var isYou = state.you && p.id === state.you.id;
      return '<li>' +
        '<span class="dot ' + (p.submitted ? 'on' : '') + '"></span>' +
        '<span class="name">' + esc(p.name) + (isYou ? ' <span class="tag">(you)</span>' : '') + '</span>' +
        (isHost ? '<span class="tag">Leader</span>' : '') +
        '<span class="tag">' + (p.submitted ? 'Ready' : 'Writing…') + '</span>' +
        '</li>';
    }).join('');

    var foot = '';
    if (state.youAreHost) {
      foot = '<button class="btn-primary btn-block" data-act="open-teams"' +
        (everyone && state.players.length >= 2 ? '' : ' disabled') + '>Set up teams</button>' +
        (state.players.length < 2
          ? '<p class="hint center mt">Waiting for more players to join.</p>'
          : (!everyone ? '<p class="hint center mt">Waiting on ' +
              esc(waiting.map(function (p) { return p.name; }).join(', ')) + '.</p>' : ''));
    } else {
      foot = '<p class="hint center">Waiting for the leader to set up teams.</p>' +
        '<button class="btn-ghost btn-block mt" data-act="edit-cards">Edit my cards</button>';
    }

    return topbar({ code: true }) +
      '<div class="screen">' +
        '<h2>' + state.players.length + ' in the game</h2>' +
        '<p>Share the code <strong style="color:var(--accent)">' + esc(state.code) +
          '</strong> so others can join. ' + state.totalCards + ' cards written so far.</p>' +
        '<div class="scroll"><ul class="list">' + items + '</ul></div>' +
        '<div class="sticky-foot">' + foot + '</div>' +
      '</div>';
  }

  function renderTeams() {
    if (!state.youAreHost) {
      var mine = state.you && state.you.teamId ? findTeam(state.you.teamId) : null;
      return topbar({ code: true }) +
        '<div class="screen"><div class="grow" style="display:flex;flex-direction:column;justify-content:center;text-align:center">' +
          '<h2>Picking teams</h2>' +
          '<p>' + (mine ? 'You are on ' : 'The leader is sorting everyone out.') + '</p>' +
          (mine ? '<div>' + teamPill(mine) + '</div>' : '') +
        '</div></div>';
    }

    var counts = state.teams.map(function (t) {
      return teamPill(t) + ' <span class="hint">' + t.playerIds.length + '</span>';
    }).join(' &nbsp; ');

    var rows = state.players.map(function (p) {
      var opts = state.teams.map(function (t) {
        var sel = p.teamId === t.id;
        return '<button data-assign="' + p.id + '" data-team="' + t.id + '" style="' +
          (sel ? 'background:' + t.color + ';color:#0d0d10;border-color:' + t.color : 'border-color:transparent') +
          '">' + esc(t.name.charAt(0)) + '</button>';
      }).join('');
      return '<div class="assign-row"><span class="name">' + esc(p.name) + '</span>' +
        '<span class="opts">' + opts + '</span></div>';
    }).join('');

    var maxTeams = Math.min(6, state.players.length);
    var teamChips = '';
    for (var i = 2; i <= maxTeams; i++) {
      teamChips += '<button class="chip' + (state.teams.length === i ? ' sel' : '') +
        '" data-teamcount="' + i + '">' + i + '</button>';
    }

    var ready = state.players.every(function (p) { return p.teamId; });

    return topbar({ code: true, back: true }) +
      '<div class="screen">' +
        '<h2>Teams</h2>' +
        '<div class="panel"><span class="cap" style="font-size:13px;text-transform:uppercase;letter-spacing:1.1px;color:var(--muted)">How many teams</span>' +
          '<div class="chips" style="margin-top:8px">' + teamChips + '</div></div>' +
        '<div class="btn-row" style="margin-bottom:14px">' +
          '<button class="btn-ghost" data-act="randomise">Randomise</button>' +
          '<button class="btn-ghost" data-act="clear-teams">Clear</button>' +
        '</div>' +
        '<div class="scroll">' + rows + '<p class="hint mt">' + counts + '</p></div>' +
        '<div class="sticky-foot">' +
          '<button class="btn-primary btn-block" data-act="start"' + (ready ? '' : ' disabled') + '>Start game</button>' +
          (ready ? '' : '<p class="hint center mt">Give everyone a team first.</p>') +
        '</div>' +
      '</div>';
  }

  function renderRoundIntro() {
    var r = state.round;
    if (!state.youAreHost) {
      return topbar({ code: true }) +
        '<div class="screen"><div class="grow" style="display:flex;flex-direction:column;justify-content:center;text-align:center">' +
          '<span class="round-badge">Round ' + (state.roundIndex + 1) + ' of ' + state.roundCount + '</span>' +
          '<h1>' + esc(r.name) + '</h1>' +
          '<p>' + esc(r.tagline) + '</p>' +
          '<p class="hint mt">Put your phone away — the game runs on the leader\'s phone from here.</p>' +
        '</div></div>';
    }

    var durChips = state.durations.map(function (d) {
      return '<button class="chip' + (state.turnDuration === d ? ' sel' : '') + '" data-dur="' + d + '">' + d + 's</button>';
    }).join('');

    return topbar({ code: true, endGame: true }) +
      '<div class="screen">' +
        '<span class="round-badge">Round ' + (state.roundIndex + 1) + ' of ' + state.roundCount + '</span>' +
        '<h1>' + esc(r.name) + '</h1>' +
        '<p>' + esc(r.tagline) + '</p>' +
        '<div class="panel"><ul class="rules">' +
          r.rules.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') +
        '</ul></div>' +
        '<div class="panel">' +
          '<span style="font-size:13px;text-transform:uppercase;letter-spacing:1.1px;color:var(--muted)">Seconds per turn</span>' +
          '<div class="chips" style="margin-top:9px">' + durChips + '</div>' +
          '<div style="display:flex;align-items:center;gap:10px;margin-top:14px;padding-top:13px;border-top:1px solid var(--line)">' +
            '<span style="flex:1;font-size:15px;color:var(--muted)">Ticking clock and buzzer</span>' +
            '<button class="btn-small ' + (Sound.isEnabled() ? 'btn-primary' : 'btn-ghost') +
              '" data-act="toggle-sound">' + (Sound.isEnabled() ? 'On' : 'Off') + '</button>' +
          '</div>' +
        '</div>' +
        (showHandover ? handoverPanel() : '') +
        '<div class="grow"></div>' +
        '<div class="sticky-foot">' +
          '<button class="btn-primary btn-block" data-act="ready-turn">Start round ' + (state.roundIndex + 1) + '</button>' +
          '<button class="btn-ghost btn-block mt" data-act="toggle-handover">' +
            (showHandover ? 'Never mind' : 'Hand the game to another phone') + '</button>' +
        '</div>' +
      '</div>';
  }

  function handoverPanel() {
    var others = state.players.filter(function (p) { return p.id !== state.hostId; });
    if (!others.length) return '<div class="panel"><p class="hint" style="margin:0">Nobody else to hand it to.</p></div>';
    return '<div class="panel"><p class="hint">The new leader runs the game from their phone. Cards and scores carry over.</p>' +
      others.map(function (p) {
        return '<button class="btn-ghost btn-block" style="margin-bottom:8px" data-handover="' + p.id + '">' +
          'Give it to ' + esc(p.name) + '</button>';
      }).join('') + '</div>';
  }

  function renderTurnReady() {
    if (!state.youAreHost) return spectator('Pass the phone to ' + state.turn.playerName + '.');
    var t = state.turn;
    var seconds = typeof t.seconds === 'number' ? t.seconds : state.turnDuration + (t.bonus || 0);
    var carryover = t.isRoundStarter
      ? '<p class="hint">' + seconds + 's left from the previous round.</p>' : '';
    return topbar({ code: true, endGame: true }) +
      '<div class="screen">' +
        '<div class="grow pass-phone" style="display:flex;flex-direction:column;justify-content:center">' +
          '<p style="margin-bottom:0">Pass the phone to</p>' +
          '<div class="who">' + esc(t.playerName) + '</div>' +
          '<div>' + teamPill(findTeam(t.teamId)) + '</div>' +
          '<p class="hint mt">' + esc(state.round.name) + ' · ' + seconds + ' seconds · ' +
            state.cardsLeft + ' cards left</p>' +
          carryover +
        '</div>' +
        '<div class="sticky-foot">' +
          '<button class="btn-primary btn-block" data-act="begin-turn">Begin</button>' +
          '<p class="hint center mt">' + esc(state.round.rules[0]) + '</p>' +
        '</div>' +
      '</div>';
  }

  function renderPlaying() {
    if (!state.youAreHost) {
      return spectator(state.turn.playerName + ' is playing for ' + state.turn.teamName + '.',
        { timer: true });
    }
    return topbar({ code: true, endGame: true }) +
      '<div class="screen">' +
        '<div class="timer-bar"><div id="bar"></div></div>' +
        '<div class="clock" id="clock">--</div>' +
        '<div class="center hint"><span id="gotcount">0</span> right · ' +
          '<span id="left">' + state.cardsLeft + '</span> cards left</div>' +
        '<div class="bigcard" id="card">' + esc(state.turn.card || '') + '</div>' +
        '<div class="judge">' +
          '<button class="pass" data-act="skip">Skip<small>try another</small></button>' +
          '<button class="got" data-act="correct">Got it<small>+1 point</small></button>' +
        '</div>' +
      '</div>';
  }

  function spectator(line, opts) {
    opts = opts || {};
    var board = (state.standings || []).map(function (t, i) {
      return '<li' + (i === 0 ? ' class="lead"' : '') + '><span class="rank">' + (i + 1) + '</span>' +
        '<span class="tname">' + esc(t.name) + '</span><span class="tscore">' + t.score + '</span></li>';
    }).join('');

    // While a turn is running every phone shows the same clock, so the room
    // feels the time going rather than only whoever is holding the game. The
    // ids match the leader's screen, so patch()/tick() drive both unchanged.
    if (opts.timer) {
      return topbar({ code: true }) +
        '<div class="screen">' +
          '<div class="timer-bar"><div id="bar"></div></div>' +
          '<div class="clock" id="clock">--</div>' +
          '<div class="center hint"><span id="gotcount">' + (state.turn.correctSoFar || 0) + '</span> right · ' +
            '<span id="left">' + state.cardsLeft + '</span> cards left</div>' +
          '<div class="grow" style="display:flex;flex-direction:column;justify-content:center;text-align:center">' +
            '<h2>' + esc(line) + '</h2>' +
            '<div>' + teamPill(findTeam(state.turn.teamId)) + '</div>' +
            '<ul class="board mt" style="text-align:left">' + board + '</ul>' +
          '</div>' +
        '</div>';
    }

    return topbar({ code: true }) +
      '<div class="screen"><div class="grow" style="display:flex;flex-direction:column;justify-content:center;text-align:center">' +
        '<h2>' + esc(line) + '</h2>' +
        '<p class="hint">You do not need your phone for this bit.</p>' +
        '<ul class="board mt" style="text-align:left">' + board + '</ul>' +
      '</div></div>';
  }

  function renderSummary() {
    if (!state.youAreHost) return spectator('Turn over.');
    var s = state.summary;
    var player = state.players.filter(function (p) { return p.id === s.playerId; })[0];
    var roundDone = state.cardsLeft === 0;

    var board = (state.standings || []).map(function (t, i) {
      return '<li' + (i === 0 ? ' class="lead"' : '') + '>' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<span class="tname">' + esc(t.name) +
          '<span class="sub">' + t.players.map(function (p) { return esc(p.name); }).join(', ') + '</span>' +
        '</span>' +
        '<span class="tscore">' + t.score + '</span></li>';
    }).join('');

    var nextRound = roundDone && state.nextRoundStarter
      ? (function () {
          var starter = state.players.filter(function (p) { return p.id === state.nextRoundStarter.playerId; })[0];
          return '<p class="hint center">Round ' + (state.roundIndex + 2) + ' starts with ' +
            esc(starter ? starter.name : '') + ' using ' + state.nextRoundStarter.seconds + ' seconds left.</p>';
        })()
      : '';

    var nextLabel = roundDone
      ? (state.roundIndex >= state.roundCount - 1 ? 'See the final result' : 'Next round')
      : 'Next player';

    // Only the cards that scored matter here — skips stayed in the pile all
    // along, so there is nothing to take off for them.
    var scored = (s.cards || []).filter(function (c) {
      return c.result === 'correct' || c.result === 'revoked';
    });
    var cardList = scored.length
      ? scored.map(function (c) {
          if (c.result === 'revoked') {
            return '<li class="turn-card gone">' +
              '<span class="tc-text">' + esc(c.text) + '</span>' +
              '<span class="tc-note">back in the pile</span></li>';
          }
          return '<li class="turn-card">' +
            '<span class="tc-text">' + esc(c.text) + '</span>' +
            '<button class="tc-take" data-revoke="' + esc(c.cardId) + '" ' +
              'aria-label="Take back ' + esc(c.text) + '">−</button></li>';
        }).join('')
      : '<li class="turn-card empty">Nothing guessed this turn.</li>';

    return topbar({ code: true, endGame: true }) +
      '<div class="screen">' +
        '<div class="center">' +
          '<p style="margin-bottom:2px">' + esc(player ? player.name : '') + ' got</p>' +
          '<div class="turn-total">' + s.correct + '</div>' +
        '</div>' +
        (s.correct
          ? '<p class="hint center">Tap − on anything that should not have counted. ' +
            'It comes off the score and goes back in the pile.</p>'
          : '') +
        (roundDone ? '<p class="center" style="color:var(--accent);font-weight:700">Round complete</p>' : '') +
        nextRound +
        '<div class="divider"></div>' +
        '<div class="scroll">' +
          '<ul class="turn-cards">' + cardList + '</ul>' +
          (s.skipped ? '<p class="hint center">' + s.skipped + ' skipped.</p>' : '') +
          '<ul class="board mt">' + board + '</ul>' +
          (showHandover ? handoverPanel() : '') +
        '</div>' +
        '<div class="sticky-foot">' +
          '<button class="btn-primary btn-block" data-act="advance">' + nextLabel + '</button>' +
          (roundDone ? '<button class="btn-ghost btn-block mt" data-act="toggle-handover">' +
            (showHandover ? 'Never mind' : 'Hand the game to another phone') + '</button>' : '') +
        '</div>' +
      '</div>';
  }

  function renderGameOver() {
    var w = state.winner;
    var head = !w ? 'Game over'
      : w.tie ? 'It is a tie!'
      : esc(w.teams[0].name) + ' wins';

    var board = (state.standings || []).map(function (t, i) {
      var people = t.players.map(function (p) {
        return '<div class="hint" style="display:flex;justify-content:space-between;padding:3px 0">' +
          '<span>' + esc(p.name) + '</span>' +
          '<span>' + p.correct + ' right · ' + p.skipped + ' skipped</span></div>';
      }).join('');
      return '<li' + (i === 0 ? ' class="lead"' : '') + ' style="flex-direction:column;align-items:stretch">' +
        '<div style="display:flex;align-items:center;gap:12px;width:100%">' +
          '<span class="rank">' + (i + 1) + '</span>' +
          '<span class="tname">' + esc(t.name) + '</span>' +
          '<span class="tscore">' + t.score + '</span>' +
        '</div>' +
        '<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:7px">' + people + '</div>' +
        '</li>';
    }).join('');

    return topbar({ code: true }) +
      '<div class="screen">' +
        '<div class="center">' +
          '<span class="round-badge">' + (state.endedEarly ? 'Ended early' : 'Final result') + '</span>' +
          '<h1>' + head + '</h1>' +
          (w && !w.tie ? '<p>' + w.score + ' cards guessed.</p>' : '') +
        '</div>' +
        '<div class="scroll"><ul class="board">' + board + '</ul></div>' +
        '<div class="sticky-foot">' +
          '<button class="btn-ghost btn-block" data-act="leave">Back to the start</button>' +
        '</div>' +
      '</div>';
  }

  // --------------------------------------------------------- live patches
  function patch() {
    if (!state || screen !== 'game') return;

    var cardEl = document.getElementById('card');
    if (cardEl && state.turn && state.turn.card != null) cardEl.textContent = state.turn.card;

    var got = document.getElementById('gotcount');
    if (got && state.turn) got.textContent = state.turn.correctSoFar;

    var left = document.getElementById('left');
    if (left) left.textContent = state.cardsLeft;

    // The round finishing early is a different sound to running out of time,
    // and it must not be mistaken for the alarm.
    if (state.phase === 'turnSummary' && lastPhase === 'playing' && !alarmFired &&
        state.cardsLeft === 0 && state.youAreHost) {
      Sound.roundDone();
    }
    lastPhase = state.phase;

    clearInterval(tickTimer);
    tickTimer = null;

    if (state.phase !== 'playing' || !state.turn || !state.turn.endsAt) {
      soundTurn = null;
      return;
    }

    // A new turn resets the tick/alarm guards; a mid-turn re-render does not.
    if (soundTurn !== state.turn.endsAt) {
      soundTurn = state.turn.endsAt;
      lastTickSecond = null;
      alarmFired = false;
    }

    var total = typeof state.turn.seconds === 'number'
      ? state.turn.seconds : state.turnDuration + (state.turn.bonus || 0);
    var tick = function () {
      var clock = document.getElementById('clock');
      var bar = document.getElementById('bar');
      if (!clock) { clearInterval(tickTimer); return; }
      var ms = state.turn.endsAt - (Date.now() + clockOffset);
      var secs = Math.max(0, Math.ceil(ms / 1000));
      clock.textContent = secs;
      clock.className = 'clock' + (secs <= 10 ? ' danger' : '');
      if (bar) {
        bar.style.width = Math.max(0, Math.min(100, (ms / (total * 1000)) * 100)) + '%';
        bar.className = secs <= 10 ? 'danger' : (secs <= 20 ? 'warn' : '');
      }

      if (secs !== lastTickSecond) {
        // Only sound a second we actually crossed while the clock was live —
        // never the initial paint, and never a second already gone.
        // Every phone counts, but only the leader's makes noise — a dozen
        // handsets ticking a few milliseconds apart is just mush.
        if (lastTickSecond !== null && secs > 0 && state.youAreHost) {
          if (secs <= 10) Sound.tickUrgent(secs % 2 === 1);
          else Sound.tick(secs % 2 === 1);
        }
        lastTickSecond = secs;
      }

      if (secs === 0 && !alarmFired) {
        alarmFired = true;
        if (state.youAreHost) Sound.alarm();
        clearInterval(tickTimer);
        tickTimer = null;
      }
    };
    tick();
    tickTimer = setInterval(tick, 100);
  }

  // ------------------------------------------------------------- events
  function wire() {
    // pre-game
    var codeInput = document.getElementById('code');
    if (codeInput) {
      codeInput.addEventListener('input', function () {
        var v = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        this.value = v;
        var was = joinCode.length === 4;
        joinCode = v;
        var btn = app.querySelector('[data-act="code-next"]');
        if (btn) btn.disabled = v.length !== 4;
        if (!was && v.length === 4) this.blur();
      });
      setTimeout(function () { codeInput.focus(); }, 60);
    }

    var nameInput = document.getElementById('name');
    if (nameInput) setTimeout(function () { nameInput.focus(); }, 60);

    on('[data-cpp]', 'click', function () {
      var chips = app.querySelectorAll('[data-cpp]');
      for (var i = 0; i < chips.length; i++) chips[i].classList.remove('sel');
      this.classList.add('sel');
    });

    // card writing
    on('[data-card]', 'input', function () {
      var i = Number(this.getAttribute('data-card'));
      draftCards[i] = this.value;
      var wc = app.querySelector('[data-wc="' + i + '"]');
      if (wc) {
        var n = words(this.value);
        wc.textContent = this.value ? n + '/5' : '';
        wc.className = 'wc' + (n > 5 ? ' over' : '');
      }
    });

    // team assignment
    on('[data-assign]', 'click', function () {
      send({ type: 'assign', playerId: this.getAttribute('data-assign'), teamId: this.getAttribute('data-team') });
    });
    on('[data-teamcount]', 'click', function () {
      send({ type: 'setTeamCount', value: Number(this.getAttribute('data-teamcount')) });
    });
    on('[data-dur]', 'click', function () {
      send({ type: 'setDuration', value: Number(this.getAttribute('data-dur')) });
    });
    on('[data-revoke]', 'click', function () {
      send({ type: 'revokeCard', cardId: this.getAttribute('data-revoke') });
    });
    on('[data-handover]', 'click', function () {
      showHandover = false;
      send({ type: 'transferLeadership', playerId: this.getAttribute('data-handover') });
    });

    on('[data-act]', 'click', function () { action(this.getAttribute('data-act')); });
  }

  function action(act) {
    // Every tap is a valid gesture for unlocking audio on iOS, and the API
    // ignores repeat calls, so this is the cheapest reliable place for it.
    Sound.unlock();
    switch (act) {
      case 'go-create': screen = 'create'; return render();
      case 'go-join': screen = 'join-code'; joinCode = ''; return render();

      case 'back':
        if (screen === 'join-name') screen = 'join-code';
        else if (state && state.phase === 'teams') send({ type: 'backToLobby' });
        else { screen = 'home'; joinCode = ''; }
        return render();

      case 'code-next':
        if (joinCode.length !== 4) return;
        screen = 'join-name';
        return render();

      case 'do-join': {
        var n1 = (document.getElementById('name') || {}).value || '';
        if (!n1.trim()) return toast('Please enter a name.');
        return send({ type: 'join', code: joinCode, name: n1 });
      }

      case 'do-create': {
        var n2 = (document.getElementById('name') || {}).value || '';
        if (!n2.trim()) return toast('Please enter a name.');
        var sel = app.querySelector('[data-cpp].sel');
        var cpp = sel ? Number(sel.getAttribute('data-cpp')) : 3;
        return send({ type: 'create', name: n2, cardsPerPlayer: cpp });
      }

      case 'submit-cards': {
        for (var i = 0; i < state.cardsPerPlayer; i++) {
          var v = (draftCards[i] || '').trim();
          if (!v) return toast('Card ' + (i + 1) + ' is empty.');
          if (words(v) > 5) return toast('Card ' + (i + 1) + ' is over five words.');
        }
        return send({ type: 'submitCards', cards: draftCards.slice(0, state.cardsPerPlayer) });
      }

      case 'edit-cards': return send({ type: 'unsubmitCards' });
      case 'open-teams': return send({ type: 'openTeams', teamCount: 2 });
      case 'randomise': return send({ type: 'randomiseTeams' });
      case 'clear-teams': return send({ type: 'setTeamCount', value: state.teams.length });
      case 'start': return send({ type: 'start' });
      case 'ready-turn': showHandover = false; return send({ type: 'readyTurn' });
      case 'begin-turn': Sound.start(); return send({ type: 'beginTurn' });

      case 'toggle-sound':
        Sound.setEnabled(!Sound.isEnabled());
        if (Sound.isEnabled()) Sound.tick(true);
        lastKey = '';
        return render();
      case 'correct': return send({ type: 'correct' });
      case 'skip': return send({ type: 'skip' });
      case 'advance': showHandover = false; return send({ type: 'advance' });
      case 'toggle-handover': showHandover = !showHandover; lastKey = ''; return render();

      case 'end-game':
        if (confirm('End the game now and show the final scores?')) send({ type: 'endGame' });
        return;

      case 'leave':
        stored.clear();
        state = null;
        screen = 'home';
        joinCode = '';
        draftCards = [];
        lastKey = '';
        return render();
    }
  }

  // Keep the screen awake during a turn where possible — nothing worse than
  // the phone locking mid-round.
  var wakeLock = null;
  async function keepAwake(want) {
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', function () { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* not supported, or denied — harmless */ }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && state && state.phase === 'playing') keepAwake(true);
  });
  var origRender = render;
  render = function () {
    origRender();
    keepAwake(!!(state && screen === 'game' &&
      (state.phase === 'playing' || (state.youAreHost && state.phase === 'turnReady'))));
  };

  render();
  connect();
})();
