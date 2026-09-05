'use strict';

/** Engine tests. Run with `npm test`. No framework — plain asserts so this
 *  stays runnable anywhere, including inside a CI step or a phone-side repl. */

const assert = require('assert');
const { Game, GameError } = require('../game');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    console.log('  ✗ ' + name);
    console.log('      ' + (err && err.message));
  }
}

function group(name) { console.log('\n' + name); }

/** Build a game with n players, each with `cards` cards, teams assigned. */
function setup({ players = 4, cards = 2, teams = 2, clock } = {}) {
  const now = clock || (() => Date.now());
  const g = new Game({ cardsPerPlayer: cards, now });
  const ps = [];
  for (let i = 0; i < players; i++) {
    const p = g.addPlayer('P' + (i + 1));
    ps.push(p);
    const texts = [];
    for (let c = 0; c < cards; c++) texts.push('card ' + (i + 1) + '-' + (c + 1));
    g.submitCards(p.id, texts);
  }
  const host = ps[0].id;
  g.openTeamSetup(host, teams);
  ps.forEach((p, i) => g.assignPlayer(host, p.id, g.teams[i % teams].id));
  return { g, ps, host };
}

/** A clock we control, so timer behaviour is testable without waiting. */
function fakeClock(start = 1000000) {
  let t = start;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
}

// ------------------------------------------------------------------ lobby
group('Lobby and cards');

test('players join and get unique ids', () => {
  const g = new Game({ cardsPerPlayer: 2 });
  const a = g.addPlayer('Isaac');
  const b = g.addPlayer('Aoife');
  assert.notStrictEqual(a.id, b.id);
  assert.strictEqual(g.hostId, a.id, 'first player is the leader');
});

test('duplicate names are rejected', () => {
  const g = new Game();
  g.addPlayer('Isaac');
  assert.throws(() => g.addPlayer('isaac'), GameError);
});

test('blank names are rejected', () => {
  const g = new Game();
  assert.throws(() => g.addPlayer('   '), GameError);
});

test('cards over five words are rejected', () => {
  const g = new Game({ cardsPerPlayer: 1 });
  const p = g.addPlayer('Isaac');
  assert.throws(() => g.submitCards(p.id, ['one two three four five six']), GameError);
  g.submitCards(p.id, ['one two three four five']);
  assert.strictEqual(p.submitted, true);
});

test('wrong number of cards is rejected', () => {
  const g = new Game({ cardsPerPlayer: 3 });
  const p = g.addPlayer('Isaac');
  assert.throws(() => g.submitCards(p.id, ['a', 'b']), GameError);
});

test('changing the card count un-submits affected players', () => {
  const g = new Game({ cardsPerPlayer: 2 });
  const p = g.addPlayer('Isaac');
  g.submitCards(p.id, ['a', 'b']);
  g.setCardsPerPlayer(p.id, 4);
  assert.strictEqual(p.submitted, false);
});

test('non-leaders cannot change settings', () => {
  const g = new Game({ cardsPerPlayer: 1 });
  const a = g.addPlayer('Isaac');
  const b = g.addPlayer('Aoife');
  assert.throws(() => g.setCardsPerPlayer(b.id, 5), GameError);
  assert.doesNotThrow(() => g.setCardsPerPlayer(a.id, 5));
});

// ------------------------------------------------------------------ teams
group('Teams');

test('cannot open team setup until everyone has written cards', () => {
  const g = new Game({ cardsPerPlayer: 1 });
  const a = g.addPlayer('Isaac');
  const b = g.addPlayer('Aoife');
  g.submitCards(a.id, ['x']);
  assert.throws(() => g.openTeamSetup(a.id, 2), GameError);
  g.submitCards(b.id, ['y']);
  assert.doesNotThrow(() => g.openTeamSetup(a.id, 2));
});

test('randomise gives every player a team and balances sizes', () => {
  const { g, host } = setup({ players: 7, teams: 2 });
  g.randomiseTeams(host);
  assert.ok(g.players.every((p) => p.teamId), 'everyone assigned');
  const sizes = g.teams.map((t) => g.teamPlayers(t.id).length).sort();
  assert.deepStrictEqual(sizes, [3, 4], 'sizes differ by at most one');
});

test('cannot start with an unassigned player', () => {
  const { g, ps, host } = setup({ players: 4, teams: 2 });
  g.assignPlayer(host, ps[3].id, null);
  assert.throws(() => g.start(host), GameError);
});

test('cannot start with an empty team', () => {
  const { g, ps, host } = setup({ players: 4, teams: 2 });
  g.teams.forEach(() => {});
  ps.forEach((p) => g.assignPlayer(host, p.id, g.teams[0].id));
  assert.throws(() => g.start(host), GameError);
});

// ------------------------------------------------------------- rotation
group('Turn rotation');

test('strict rotation alternates teams and cycles players', () => {
  const { g, host } = setup({ players: 4, teams: 2, cards: 8 });
  g.start(host);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    g.readyTurn(host);
    seen.push(g.getPlayer(g.turnPlayerId).name + '/' + g.turnTeamId);
    g.beginTurn(host);
    g.endTurn();
    if (g.phase === 'turnSummary' && g.pile.length > 0) { /* stay in round */ }
  }
  // P1,P3 on t1; P2,P4 on t2 (round-robin assignment in setup)
  assert.deepStrictEqual(seen, [
    'P1/t1', 'P2/t2', 'P3/t1', 'P4/t2', 'P1/t1', 'P2/t2',
  ]);
});

test('uneven teams still rotate without skipping anyone', () => {
  const { g, ps, host } = setup({ players: 5, teams: 2, cards: 8 });
  // t1 gets 3 players, t2 gets 2
  g.assignPlayer(host, ps[0].id, 't1');
  g.assignPlayer(host, ps[1].id, 't1');
  g.assignPlayer(host, ps[2].id, 't1');
  g.assignPlayer(host, ps[3].id, 't2');
  g.assignPlayer(host, ps[4].id, 't2');
  g.start(host);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    g.readyTurn(host);
    seen.push(g.getPlayer(g.turnPlayerId).name);
    g.beginTurn(host);
    g.endTurn();
  }
  assert.deepStrictEqual(seen, ['P1', 'P4', 'P2', 'P5', 'P3', 'P4']);
});

// ------------------------------------------------------------- gameplay
group('Scoring and the pile');

test('correct removes the card and scores the team', () => {
  const { g, host } = setup({ players: 2, teams: 2, cards: 3 });
  g.start(host);
  g.readyTurn(host);
  g.beginTurn(host);
  const before = g.pile.length;
  g.markCorrect(host);
  assert.strictEqual(g.pile.length, before - 1);
  assert.strictEqual(g.teams[0].score, 1);
});

test('skip sends the card to the back and never loses it', () => {
  const { g, host } = setup({ players: 2, teams: 2, cards: 3 });
  g.start(host);
  g.readyTurn(host);
  g.beginTurn(host);
  const before = g.pile.slice();
  g.markSkip(host);
  assert.strictEqual(g.pile.length, before.length, 'pile size unchanged');
  assert.strictEqual(g.pile[g.pile.length - 1], before[0], 'skipped card is now last');
  assert.strictEqual(g.currentCardId, before[1], 'next card is served');
});

test('skips are unlimited and tracked as a stat', () => {
  const { g, ps, host } = setup({ players: 2, teams: 2, cards: 2 });
  g.start(host);
  g.readyTurn(host);
  g.beginTurn(host);
  for (let i = 0; i < 25; i++) g.markSkip(host);
  assert.strictEqual(g.pile.length, 4, 'no cards lost');
  assert.strictEqual(g.getPlayer(ps[0].id).stats.skipped, 25);
});

test('the leader can correct a miscount afterwards', () => {
  const { g, host } = setup({ players: 2, teams: 2, cards: 3 });
  g.start(host);
  g.readyTurn(host);
  g.beginTurn(host);
  g.markCorrect(host);
  g.endTurn();
  assert.strictEqual(g.teams[0].score, 1);
  g.adjustScore(host, 1);
  assert.strictEqual(g.teams[0].score, 2);
  assert.strictEqual(g.turnSummary().correct, 2);
  g.adjustScore(host, -1);
  g.adjustScore(host, -1);
  assert.strictEqual(g.teams[0].score, 0);
  assert.throws(() => g.adjustScore(host, -1), GameError, 'cannot go below zero cards');
});

test('the card is only ever exposed to the leader', () => {
  const { g, ps, host } = setup({ players: 2, teams: 2, cards: 3 });
  g.start(host);
  g.readyTurn(host);
  g.beginTurn(host);
  assert.ok(g.snapshot(host).turn.card, 'leader sees the card');
  assert.strictEqual(g.snapshot(ps[1].id).turn.card, null, 'other phones do not');
});

// -------------------------------------------------------------- carryover
group('Round transitions and carryover');

test('emptying the pile mid-turn carries the current player and remaining time into the next round', () => {
  const clock = fakeClock();
  const { g, host } = setup({ players: 2, teams: 2, cards: 1, clock });
  g.setDuration(host, 60);
  g.start(host);
  g.readyTurn(host);
  g.beginTurn(host);
  const currentPlayerId = g.turnPlayerId;
  clock.advance(20000); // 20s used, 40s left
  g.markCorrect(host); // card 1 of 2
  const res = g.markCorrect(host); // last card -> round over
  assert.strictEqual(res.done, true);
  assert.strictEqual(g.phase, 'turnSummary');
  assert.deepStrictEqual(g.nextRoundStarter, {
    playerId: currentPlayerId,
    teamId: 't1',
    seconds: 40,
  });
  assert.deepStrictEqual(g.carryover, {}, 'no team carryover is created');
});

test('the next round starts with the same player and uses only their remaining time', () => {
  const clock = fakeClock();
  const { g, host } = setup({ players: 2, teams: 2, cards: 1, clock });
  g.setDuration(host, 60);
  g.start(host);
  g.readyTurn(host);
  g.beginTurn(host);
  const currentPlayerId = g.turnPlayerId;
  clock.advance(15000);
  g.markCorrect(host);
  g.markCorrect(host); // round 1 done, 45s left
  g.advance(host);     // -> round 2 intro
  assert.strictEqual(g.roundIndex, 1);
  assert.strictEqual(g.round.key, 'act');
  assert.strictEqual(g.snapshot(host).nextUp.playerId, currentPlayerId);

  // The leader still chooses the new round's standard duration.
  g.setDuration(host, 30);
  g.readyTurn(host);
  assert.strictEqual(g.turnPlayerId, currentPlayerId);
  const starter = g.beginTurn(host);
  assert.strictEqual(starter.seconds, 45, 'the starter uses only the 45s remaining');
  assert.strictEqual(g.carryover['t1'], undefined, 'no team bank is spent');

  // The selected duration applies to later turns in the new round.
  clock.advance(45000);
  g.endTurn();
  g.advance(host);
  assert.strictEqual(g.turnTeamId, 't2');
  const next = g.beginTurn(host);
  assert.strictEqual(next.seconds, 30);
});

test('a fresh pile is dealt each round with every card back in play', () => {
  const { g, host } = setup({ players: 3, teams: 2, cards: 2 });
  const total = g.allCards().length;
  g.start(host);
  assert.strictEqual(g.pile.length, total);
  g.readyTurn(host);
  g.beginTurn(host);
  while (g.pile.length > 0 && g.phase === 'playing') g.markCorrect(host);
  g.advance(host);
  assert.strictEqual(g.roundIndex, 1);
  assert.strictEqual(g.pile.length, total, 'all cards return for round 2');
});

test('four rounds then game over', () => {
  const { g, host } = setup({ players: 2, teams: 2, cards: 2 });
  const names = [];
  for (let r = 0; r < 4; r++) {
    names.push(g.round.name);
    g.readyTurnSafe = true;
    if (r === 0) g.start(host);
    g.readyTurn(host);
    g.beginTurn(host);
    while (g.phase === 'playing') g.markCorrect(host);
    g.advance(host);
  }
  assert.deepStrictEqual(names, ['Describe It', 'Act It Out', 'One Word', 'Noises Only']);
  assert.strictEqual(g.phase, 'gameOver');
  assert.ok(g.winner());
});

// ------------------------------------------------------------- leadership
group('Leadership and ending early');

test('leadership can be handed over between turns but not during one', () => {
  const { g, ps, host } = setup({ players: 2, teams: 2, cards: 3 });
  g.start(host);
  g.readyTurn(host);
  g.beginTurn(host);
  assert.throws(() => g.transferLeadership(host, ps[1].id), GameError);
  g.endTurn();
  g.transferLeadership(host, ps[1].id);
  assert.strictEqual(g.hostId, ps[1].id);
  assert.throws(() => g.advance(host), GameError, 'old leader loses control');
  assert.doesNotThrow(() => g.advance(ps[1].id));
});

test('end game early jumps straight to the final board', () => {
  const { g, host } = setup({ players: 2, teams: 2, cards: 3 });
  g.start(host);
  g.readyTurn(host);
  g.beginTurn(host);
  g.markCorrect(host);
  g.endGame(host);
  assert.strictEqual(g.phase, 'gameOver');
  assert.strictEqual(g.endedEarly, true);
  assert.strictEqual(g.winner().teams[0].id, 't1');
});

test('a tie is reported as a tie', () => {
  const { g, host } = setup({ players: 2, teams: 2, cards: 3 });
  g.start(host);
  g.endGame(host);
  assert.strictEqual(g.winner().tie, true);
});

test('non-leaders cannot drive the game', () => {
  const { g, ps, host } = setup({ players: 2, teams: 2, cards: 3 });
  g.start(host);
  assert.throws(() => g.readyTurn(ps[1].id), GameError);
  g.readyTurn(host);
  assert.throws(() => g.beginTurn(ps[1].id), GameError);
  g.beginTurn(host);
  assert.throws(() => g.markCorrect(ps[1].id), GameError);
  assert.throws(() => g.endGame(ps[1].id), GameError);
});

// ------------------------------------------------------- full simulation
group('Full game simulation');

test('a 6-player, 3-team, 4-round game completes with consistent totals', () => {
  const clock = fakeClock();
  const { g, ps, host } = setup({ players: 6, teams: 3, cards: 3, clock });
  g.setDuration(host, 40);
  g.start(host);

  const totalCards = g.allCards().length;
  assert.strictEqual(totalCards, 18);

  let guard = 0;
  while (g.phase !== 'gameOver' && guard++ < 500) {
    if (g.phase === 'roundIntro' || (g.phase === 'turnSummary')) {
      if (g.phase === 'turnSummary') { g.advance(host); continue; }
    }
    if (g.phase === 'roundIntro') { g.readyTurn(host); continue; }
    if (g.phase === 'turnReady') { g.beginTurn(host); continue; }
    if (g.phase === 'playing') {
      // Guess two, skip one, until the clock runs out or the pile empties.
      const roll = guard % 3;
      if (roll === 2) g.markSkip(host); else g.markCorrect(host);
      if (g.phase === 'playing' && guard % 7 === 0) { clock.advance(41000); g.endTurn(); }
      continue;
    }
  }

  assert.strictEqual(g.phase, 'gameOver', 'game reached the end');
  const standings = g.standings();
  const totalScore = standings.reduce((s, t) => s + t.score, 0);
  assert.strictEqual(totalScore, totalCards * 4, 'every card scored once per round');

  const playerCorrect = g.players.reduce((s, p) => s + p.stats.correct, 0);
  assert.strictEqual(playerCorrect, totalScore, 'player stats match team scores');
  assert.strictEqual(g.roundResults.length, 4);
  ps.forEach((p) => assert.ok(p.stats.turns > 0, p.name + ' got at least one turn'));
});

test('snapshot never leaks another player\'s cards', () => {
  const { g, ps, host } = setup({ players: 3, teams: 2, cards: 2 });
  const snap = g.snapshot(ps[1].id);
  const json = JSON.stringify(snap);
  g.players[0].cards.forEach((c) => {
    assert.ok(!json.includes(c.text), 'card text ' + c.text + ' must not be in another player\'s snapshot');
  });
  assert.strictEqual(snap.you.id, ps[1].id);
  assert.strictEqual(snap.youAreHost, false);
  assert.strictEqual(g.snapshot(host).youAreHost, true);
});

// ----------------------------------------------------------------- report
console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
