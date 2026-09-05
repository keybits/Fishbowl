'use strict';

/** Integration test: real HTTP server, real WebSockets, four simulated phones
 *  playing a whole game. Catches anything the pure engine tests cannot —
 *  message routing, broadcast fan-out, per-player snapshots, timers. */

const assert = require('assert');
const WebSocket = require('ws');
const { server } = require('../server');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

function makeClient(port) {
  const ws = new WebSocket('ws://localhost:' + port);
  const client = { ws, state: null, code: null, playerId: null, errors: [] };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'state') client.state = msg.state;
    else if (msg.type === 'joined') { client.code = msg.code; client.playerId = msg.playerId; }
    else if (msg.type === 'error') client.errors.push(msg.message);
  });
  client.send = (o) => ws.send(JSON.stringify(o));
  client.ready = new Promise((res) => ws.on('open', res));
  return client;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` is truthy, so the test tracks the server instead of
 *  guessing at fixed sleeps. */
async function until(fn, label, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return;
    await wait(20);
  }
  throw new Error('timed out waiting for: ' + label);
}

(async function run() {
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  console.log('\nServer integration (port ' + port + ')');

  const host = makeClient(port);
  await host.ready;
  host.send({ type: 'create', name: 'Isaac', cardsPerPlayer: 2 });
  await until(() => host.code, 'room created');

  const code = host.code;
  check('create returns a 4-character code', () => {
    assert.strictEqual(typeof code, 'string');
    assert.strictEqual(code.length, 4);
  });

  const others = [];
  for (const name of ['Aoife', 'Cian', 'Niamh']) {
    const c = makeClient(port);
    await c.ready;
    c.send({ type: 'join', code, name });
    await until(() => c.playerId, name + ' joined');
    others.push(c);
  }
  const all = [host, ...others];

  await until(() => host.state && host.state.players.length === 4, 'four players visible');
  check('everyone sees all four players', () => {
    all.forEach((c) => assert.strictEqual(c.state.players.length, 4, 'client sees 4'));
  });

  check('only the creator is the leader', () => {
    assert.strictEqual(host.state.youAreHost, true);
    others.forEach((c) => assert.strictEqual(c.state.youAreHost, false));
  });

  const bad = makeClient(port);
  await bad.ready;
  bad.send({ type: 'join', code: 'ZZZZ', name: 'Ghost' });
  await until(() => bad.errors.length, 'bad code rejected');
  check('a wrong code is refused with a readable message', () => {
    assert.match(bad.errors[0], /No game with that code/);
  });
  bad.ws.close();

  // duplicate name
  const dupe = makeClient(port);
  await dupe.ready;
  dupe.send({ type: 'join', code, name: 'Isaac' });
  await until(() => dupe.errors.length, 'duplicate name rejected');
  check('a duplicate name is refused', () => assert.match(dupe.errors[0], /already has that name/));
  dupe.ws.close();

  // cards
  all.forEach((c, i) => c.send({ type: 'submitCards', cards: ['alpha ' + i, 'beta ' + i] }));
  await until(() => host.state.players.every((p) => p.submitted), 'all cards in');
  check('all eight cards are registered', () => assert.strictEqual(host.state.totalCards, 8));

  // a non-leader cannot start the game
  others[0].send({ type: 'openTeams', teamCount: 2 });
  await until(() => others[0].errors.length, 'non-leader blocked');
  check('a non-leader cannot open team setup', () =>
    assert.match(others[0].errors[0], /Only the game leader/));

  host.send({ type: 'openTeams', teamCount: 2 });
  await until(() => host.state.phase === 'teams', 'team setup open');
  host.send({ type: 'randomiseTeams' });
  await until(() => host.state.players.every((p) => p.teamId), 'teams assigned');
  check('every player lands on a team', () =>
    assert.ok(host.state.players.every((p) => p.teamId)));

  host.send({ type: 'start' });
  await until(() => host.state.phase === 'roundIntro', 'round 1 intro');
  check('round one is the describe round', () =>
    assert.strictEqual(host.state.round.key, 'describe'));

  // Short turns so the real timer is exercised without a long test.
  host.send({ type: 'setDuration', value: 30 });
  host.send({ type: 'readyTurn' });
  await until(() => host.state.phase === 'turnReady', 'turn ready');
  check('non-leaders are told who has the phone', () =>
    assert.ok(others[0].state.turn && others[0].state.turn.playerName));

  host.send({ type: 'beginTurn' });
  await until(() => host.state.phase === 'playing', 'playing');

  check('the leader is served a card', () => assert.ok(host.state.turn.card));
  check('other phones are not served the card', () =>
    others.forEach((c) => assert.strictEqual(c.state.turn.card, null)));

  // Guess every card in the round.
  let guard = 0;
  while (host.state.phase === 'playing' && guard++ < 40) {
    host.send({ type: 'correct' });
    await wait(30);
  }
  await until(() => host.state.phase === 'turnSummary', 'round finished mid-turn');
  check('clearing the pile ends the turn and banks the time', () => {
    assert.strictEqual(host.state.cardsLeft, 0);
    const teamId = host.state.turn.teamId;
    assert.ok(host.state.carryover[teamId] > 0, 'seconds were banked');
  });
  check('the summary reports eight correct', () =>
    assert.strictEqual(host.state.summary.correct, 8));

  // score editing
  host.send({ type: 'adjustScore', delta: -1 });
  await until(() => host.state.summary.correct === 7, 'score edited down');
  check('the leader can edit the score after a turn', () =>
    assert.strictEqual(host.state.summary.correct, 7));
  host.send({ type: 'adjustScore', delta: 1 });
  await until(() => host.state.summary.correct === 8, 'score restored');

  // hand over leadership
  host.send({ type: 'transferLeadership', playerId: others[0].playerId });
  await until(() => others[0].state.youAreHost, 'leadership moved');
  check('leadership transfers to another phone', () => {
    assert.strictEqual(others[0].state.youAreHost, true);
    assert.strictEqual(host.state.youAreHost, false);
  });
  const leader = others[0];

  leader.send({ type: 'advance' });
  await until(() => leader.state.roundIndex === 1, 'round 2');
  check('round two is the acting round', () =>
    assert.strictEqual(leader.state.round.key, 'act'));
  check('all cards return for the new round', () =>
    assert.strictEqual(leader.state.cardsLeft, 8));

  // Let a real turn actually time out, to prove the server-side timer fires.
  leader.send({ type: 'setDuration', value: 30 });
  leader.send({ type: 'readyTurn' });
  await until(() => leader.state.phase === 'turnReady', 'turn 2 ready');
  const bonusTeam = leader.state.turn.teamId;
  const expectedBonus = leader.state.carryover[bonusTeam] || 0;
  leader.send({ type: 'beginTurn' });
  await until(() => leader.state.phase === 'playing', 'turn 2 playing');
  check('banked seconds are added to the right team\'s turn', () => {
    const total = Math.round((leader.state.turn.endsAt - Date.now()) / 1000);
    assert.ok(total > 30 === expectedBonus > 0,
      'bonus ' + expectedBonus + ' reflected in a ' + total + 's turn');
  });

  // reconnect mid-game
  const ghost = makeClient(port);
  await ghost.ready;
  ghost.send({ type: 'rejoin', code, playerId: host.playerId });
  await until(() => ghost.state, 'rejoined');
  check('a dropped phone can rejoin and resume', () => {
    assert.strictEqual(ghost.state.you.id, host.playerId);
    assert.strictEqual(ghost.state.phase, 'playing');
  });
  ghost.ws.close();

  // end early
  leader.send({ type: 'endGame' });
  await until(() => leader.state.phase === 'gameOver', 'game over');
  check('end game shows a final board to every phone', () => {
    all.forEach((c) => {
      assert.strictEqual(c.state.phase, 'gameOver');
      assert.ok(Array.isArray(c.state.standings) && c.state.standings.length === 2);
    });
    assert.strictEqual(leader.state.endedEarly, true);
    assert.ok(leader.state.winner);
  });

  check('final stats include per-player breakdowns', () => {
    const withPlayers = leader.state.standings.every(
      (t) => Array.isArray(t.players) && t.players.every((p) => typeof p.correct === 'number'));
    assert.ok(withPlayers);
  });

  all.forEach((c) => c.ws.close());
  await wait(120);
  server.close();

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nFATAL', err);
  process.exit(1);
});
