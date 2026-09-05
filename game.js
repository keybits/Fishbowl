'use strict';

/**
 * Fishbowl — pure game engine.
 *
 * No networking, no DOM, no timers. The transport layer (server.js) owns
 * sockets and setTimeout; this file owns rules. Keeping it separate means the
 * same rules can be dropped into a React Native app later without changes.
 */

const ROUNDS = [
  {
    key: 'describe',
    name: 'Describe It',
    tagline: 'Say anything except the words on the card',
    rules: [
      'Describe the card out loud however you like.',
      'You may not say any word printed on the card.',
      'No rhymes, no spelling it out, no gestures.',
    ],
  },
  {
    key: 'act',
    name: 'Act It Out',
    tagline: 'Charades — your body only, no words',
    rules: [
      'Act the card out with your body.',
      'No words, no sounds, no pointing at objects in the room.',
      'Miming "sounds like" is allowed.',
    ],
  },
  {
    key: 'oneword',
    name: 'One Word',
    tagline: 'A single word. That is all you get.',
    rules: [
      'Say exactly one word as your clue.',
      'You may repeat that same word, but never a second word.',
      'No gestures, no sounds.',
    ],
  },
  {
    key: 'noise',
    name: 'Noises Only',
    tagline: 'Out of sight, sound effects only',
    rules: [
      'Stand where your team cannot see you.',
      'Make noises only — no words and no acting.',
      'Yes, this round is meant to be ridiculous.',
    ],
  },
];

const TEAM_PRESETS = [
  { name: 'Red', color: '#e05252' },
  { name: 'Blue', color: '#4a7fd4' },
  { name: 'Green', color: '#3fa06b' },
  { name: 'Amber', color: '#d99a2b' },
  { name: 'Purple', color: '#8b5cc7' },
  { name: 'Teal', color: '#2fa3a3' },
];

const DURATIONS = [30, 40, 50, 60];
const MAX_CARD_WORDS = 5;
const MAX_PLAYERS = 24;
const MAX_CARDS_PER_PLAYER = 10;

// Ambiguous characters removed so a code read aloud across a noisy room is
// never misheard: no O/0, I/1, S/5.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

function makeCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function makeId() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function countWords(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

class GameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameError';
    this.expected = true;
  }
}

class Game {
  constructor({ code, cardsPerPlayer = 3, now = () => Date.now() } = {}) {
    this.code = code || makeCode();
    this.cardsPerPlayer = clampInt(cardsPerPlayer, 1, MAX_CARDS_PER_PLAYER);
    this.now = now;
    this.createdAt = this.now();

    this.phase = 'lobby';
    this.players = []; // {id, name, cards:[], submitted, teamId, connected}
    this.teams = [];
    this.hostId = null;

    this.roundIndex = 0;
    this.turnNumber = 0; // global count of turns started
    this.turnDuration = 60;

    this.pile = []; // card ids remaining this round
    this.currentCardId = null;
    this.turnEndsAt = null;
    this.turnPlayerId = null;
    this.turnTeamId = null;
    this.turnLog = []; // {cardId, result} for the turn in progress
    this.turnBonus = 0; // seconds carried in to the current turn

    this.carryover = {}; // teamId -> seconds banked for that team's next turn
    this.roundResults = [];
    this.endedEarly = false;
  }

  // ---------------------------------------------------------------- lobby

  addPlayer(name) {
    if (this.phase !== 'lobby') throw new GameError('This game has already started.');
    if (this.players.length >= MAX_PLAYERS) throw new GameError('This game is full.');
    const clean = String(name || '').trim().slice(0, 20);
    if (!clean) throw new GameError('Please enter a name.');
    if (this.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      throw new GameError('Someone in this game already has that name.');
    }
    const player = {
      id: makeId(),
      name: clean,
      cards: [],
      submitted: false,
      teamId: null,
      connected: true,
      stats: { correct: 0, skipped: 0, turns: 0 },
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    return player;
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  requireHost(playerId) {
    if (playerId !== this.hostId) throw new GameError('Only the game leader can do that.');
  }

  removePlayer(playerId) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return;
    // Only fully remove during the lobby; mid-game we keep them for scoring.
    if (this.phase === 'lobby') {
      this.players.splice(idx, 1);
      if (this.hostId === playerId) this.hostId = this.players[0] ? this.players[0].id : null;
    } else {
      this.players[idx].connected = false;
    }
  }

  setCardsPerPlayer(playerId, n) {
    this.requireHost(playerId);
    if (this.phase !== 'lobby') throw new GameError('Cards are locked in once the game starts.');
    this.cardsPerPlayer = clampInt(n, 1, MAX_CARDS_PER_PLAYER);
    // Anyone who already submitted a different count has to redo it.
    for (const p of this.players) {
      if (p.cards.length !== this.cardsPerPlayer) p.submitted = false;
    }
  }

  submitCards(playerId, texts) {
    const player = this.getPlayer(playerId);
    if (!player) throw new GameError('You are not in this game.');
    if (this.phase !== 'lobby') throw new GameError('Card writing is closed.');
    if (!Array.isArray(texts) || texts.length !== this.cardsPerPlayer) {
      throw new GameError(`Please fill in all ${this.cardsPerPlayer} cards.`);
    }
    const cleaned = texts.map((t) => String(t || '').trim().replace(/\s+/g, ' '));
    for (const text of cleaned) {
      if (!text) throw new GameError('One of your cards is empty.');
      if (countWords(text) > MAX_CARD_WORDS) {
        throw new GameError(`"${text}" is over the ${MAX_CARD_WORDS} word limit.`);
      }
      if (text.length > 60) throw new GameError('That card is too long.');
    }
    player.cards = cleaned.map((text) => ({ id: makeId(), text, authorId: playerId }));
    player.submitted = true;
    return player;
  }

  allCards() {
    return this.players.flatMap((p) => p.cards);
  }

  getCard(cardId) {
    for (const p of this.players) {
      const c = p.cards.find((x) => x.id === cardId);
      if (c) return c;
    }
    return null;
  }

  everyoneSubmitted() {
    return this.players.length > 0 && this.players.every((p) => p.submitted);
  }

  // ---------------------------------------------------------------- teams

  openTeamSetup(playerId, teamCount = 2) {
    this.requireHost(playerId);
    if (this.phase !== 'lobby') throw new GameError('Teams are already set.');
    if (this.players.length < 2) throw new GameError('You need at least 2 players.');
    if (!this.everyoneSubmitted()) throw new GameError('Everyone needs to finish their cards first.');
    this.setTeamCount(playerId, teamCount);
    this.phase = 'teams';
  }

  setTeamCount(playerId, n) {
    this.requireHost(playerId);
    const count = clampInt(n, 2, Math.min(TEAM_PRESETS.length, this.players.length));
    this.teams = [];
    for (let i = 0; i < count; i++) {
      this.teams.push({
        id: 't' + (i + 1),
        name: TEAM_PRESETS[i].name,
        color: TEAM_PRESETS[i].color,
        score: 0,
        rotationIndex: 0,
        stats: { correct: 0, skipped: 0 },
      });
    }
    for (const p of this.players) p.teamId = null;
    this.carryover = {};
  }

  assignPlayer(playerId, targetPlayerId, teamId) {
    this.requireHost(playerId);
    if (this.phase !== 'teams') throw new GameError('Teams are locked.');
    const target = this.getPlayer(targetPlayerId);
    if (!target) throw new GameError('Player not found.');
    if (teamId !== null && !this.teams.some((t) => t.id === teamId)) {
      throw new GameError('That team does not exist.');
    }
    target.teamId = teamId;
  }

  randomiseTeams(playerId) {
    this.requireHost(playerId);
    if (this.phase !== 'teams') throw new GameError('Teams are locked.');
    const order = shuffle(this.players);
    order.forEach((p, i) => {
      p.teamId = this.teams[i % this.teams.length].id;
    });
  }

  teamPlayers(teamId) {
    return this.players.filter((p) => p.teamId === teamId);
  }

  teamsAreValid() {
    if (this.teams.length < 2) return false;
    if (this.players.some((p) => !p.teamId)) return false;
    return this.teams.every((t) => this.teamPlayers(t.id).length >= 1);
  }

  // ---------------------------------------------------------------- rounds

  start(playerId) {
    this.requireHost(playerId);
    if (this.phase !== 'teams') throw new GameError('Set up teams first.');
    if (!this.teamsAreValid()) {
      throw new GameError('Every player needs a team, and every team needs at least one player.');
    }
    if (this.allCards().length === 0) throw new GameError('There are no cards to play with.');
    this.roundIndex = 0;
    this.beginRound();
  }

  beginRound() {
    this.pile = shuffle(this.allCards().map((c) => c.id));
    this.currentCardId = null;
    this.turnLog = [];
    this.phase = 'roundIntro';
  }

  get round() {
    return ROUNDS[this.roundIndex] || null;
  }

  setDuration(playerId, seconds) {
    this.requireHost(playerId);
    if (!DURATIONS.includes(Number(seconds))) throw new GameError('Pick 30, 40, 50 or 60 seconds.');
    this.turnDuration = Number(seconds);
  }

  /** Strict rotation: teams alternate in order, each team advances its own
   *  pointer. Handles uneven team sizes without anyone being skipped. */
  nextUpTeam() {
    return this.teams[this.turnNumber % this.teams.length];
  }

  nextUpPlayer() {
    const team = this.nextUpTeam();
    const members = this.teamPlayers(team.id);
    if (members.length === 0) return null;
    return members[team.rotationIndex % members.length];
  }

  /** Move from the round intro / previous summary to "pass the phone". */
  readyTurn(playerId) {
    this.requireHost(playerId);
    if (!['roundIntro', 'turnSummary'].includes(this.phase)) {
      throw new GameError('Not ready for a turn right now.');
    }
    if (this.pile.length === 0) throw new GameError('This round is already finished.');
    const team = this.nextUpTeam();
    const player = this.nextUpPlayer();
    if (!player) throw new GameError('That team has no players.');
    this.turnPlayerId = player.id;
    this.turnTeamId = team.id;
    this.turnBonus = this.carryover[team.id] || 0;
    this.phase = 'turnReady';
  }

  beginTurn(playerId) {
    this.requireHost(playerId);
    if (this.phase !== 'turnReady') throw new GameError('Not ready to begin.');
    const team = this.teams.find((t) => t.id === this.turnTeamId);
    const bonus = this.carryover[team.id] || 0;
    this.carryover[team.id] = 0;
    this.turnBonus = bonus;
    const total = this.turnDuration + bonus;
    this.turnEndsAt = this.now() + total * 1000;
    this.turnLog = [];
    this.currentCardId = this.pile[0] || null;
    this.turnNumber += 1;
    team.rotationIndex += 1;
    const p = this.getPlayer(this.turnPlayerId);
    if (p) p.stats.turns += 1;
    this.phase = 'playing';
    return { endsAt: this.turnEndsAt, seconds: total };
  }

  secondsLeft() {
    if (this.phase !== 'playing' || !this.turnEndsAt) return 0;
    return Math.max(0, Math.ceil((this.turnEndsAt - this.now()) / 1000));
  }

  /** Green box — the team guessed it. */
  markCorrect(playerId) {
    this.requireHost(playerId);
    if (this.phase !== 'playing') throw new GameError('No turn in progress.');
    const cardId = this.pile.shift();
    if (!cardId) return this.finishRoundMidTurn();
    const team = this.teams.find((t) => t.id === this.turnTeamId);
    team.score += 1;
    team.stats.correct += 1;
    const p = this.getPlayer(this.turnPlayerId);
    if (p) p.stats.correct += 1;
    this.turnLog.push({ cardId, result: 'correct' });

    if (this.pile.length === 0) return this.finishRoundMidTurn();
    this.currentCardId = this.pile[0];
    return { done: false };
  }

  /** Yellow box — pass, card goes to the back of the pile. Unlimited. */
  markSkip(playerId) {
    this.requireHost(playerId);
    if (this.phase !== 'playing') throw new GameError('No turn in progress.');
    if (this.pile.length === 0) return this.finishRoundMidTurn();
    const cardId = this.pile.shift();
    this.pile.push(cardId);
    const team = this.teams.find((t) => t.id === this.turnTeamId);
    team.stats.skipped += 1;
    const p = this.getPlayer(this.turnPlayerId);
    if (p) p.stats.skipped += 1;
    this.turnLog.push({ cardId, result: 'skip' });
    this.currentCardId = this.pile[0];
    return { done: false };
  }

  /** The pile emptied while the clock was still running: bank the remainder
   *  for this team's next turn, exactly as the house rules say. */
  finishRoundMidTurn() {
    const remaining = this.secondsLeft();
    if (remaining > 0) {
      this.carryover[this.turnTeamId] = (this.carryover[this.turnTeamId] || 0) + remaining;
    }
    this.turnEndsAt = null;
    this.currentCardId = null;
    this.phase = 'turnSummary';
    this.pendingRoundEnd = true;
    return { done: true, carried: remaining };
  }

  /** Clock hit zero. */
  endTurn() {
    if (this.phase !== 'playing') return;
    this.turnEndsAt = null;
    this.currentCardId = null;
    this.phase = 'turnSummary';
    this.pendingRoundEnd = this.pile.length === 0;
  }

  turnSummary() {
    const correct = this.turnLog.filter((l) => l.result === 'correct').length;
    const skipped = this.turnLog.filter((l) => l.result === 'skip').length;
    return {
      playerId: this.turnPlayerId,
      teamId: this.turnTeamId,
      correct,
      skipped,
      cards: this.turnLog.map((l) => {
        const card = this.getCard(l.cardId);
        return { text: card ? card.text : '(missing)', result: l.result };
      }),
    };
  }

  /** Leader fixes a miscount on the summary screen. */
  adjustScore(playerId, delta) {
    this.requireHost(playerId);
    if (this.phase !== 'turnSummary') throw new GameError('You can only edit the score right after a turn.');
    const d = clampInt(delta, -1, 1);
    if (d === 0) return;
    const team = this.teams.find((t) => t.id === this.turnTeamId);
    const player = this.getPlayer(this.turnPlayerId);
    const turnCorrect = this.turnLog.filter((l) => l.result === 'correct').length;
    if (d < 0 && turnCorrect === 0) throw new GameError('Nothing to take off.');
    team.score = Math.max(0, team.score + d);
    team.stats.correct = Math.max(0, team.stats.correct + d);
    if (player) player.stats.correct = Math.max(0, player.stats.correct + d);
    if (d > 0) {
      this.turnLog.push({ cardId: null, result: 'correct', manual: true });
    } else {
      const idx = [...this.turnLog].reverse().findIndex((l) => l.result === 'correct');
      if (idx !== -1) this.turnLog.splice(this.turnLog.length - 1 - idx, 1);
    }
  }

  /** Advance from the turn summary: next turn, next round, or game over. */
  advance(playerId) {
    this.requireHost(playerId);
    if (this.phase !== 'turnSummary') throw new GameError('Nothing to advance.');
    if (this.pendingRoundEnd || this.pile.length === 0) {
      this.pendingRoundEnd = false;
      this.roundResults.push({
        round: this.round ? this.round.key : 'unknown',
        name: this.round ? this.round.name : '',
        scores: this.teams.map((t) => ({ teamId: t.id, score: t.score })),
      });
      if (this.roundIndex >= ROUNDS.length - 1) {
        this.phase = 'gameOver';
        return { gameOver: true };
      }
      this.roundIndex += 1;
      this.beginRound();
      return { nextRound: true };
    }
    this.phase = 'turnSummary';
    this.readyTurn(playerId);
    return { nextTurn: true };
  }

  transferLeadership(playerId, targetId) {
    this.requireHost(playerId);
    const target = this.getPlayer(targetId);
    if (!target) throw new GameError('Player not found.');
    if (this.phase === 'playing') throw new GameError('Finish this turn before handing over.');
    this.hostId = targetId;
    return target;
  }

  endGame(playerId) {
    this.requireHost(playerId);
    this.endedEarly = this.phase !== 'gameOver';
    this.turnEndsAt = null;
    this.currentCardId = null;
    this.phase = 'gameOver';
  }

  standings() {
    return this.teams
      .map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        score: t.score,
        skipped: t.stats.skipped,
        players: this.teamPlayers(t.id).map((p) => ({
          id: p.id,
          name: p.name,
          correct: p.stats.correct,
          skipped: p.stats.skipped,
          turns: p.stats.turns,
        })),
      }))
      .sort((a, b) => b.score - a.score);
  }

  winner() {
    const s = this.standings();
    if (s.length === 0) return null;
    const top = s[0].score;
    const tied = s.filter((t) => t.score === top);
    return { teams: tied, tie: tied.length > 1, score: top };
  }

  /** What every connected device is allowed to see. `forId` tailors the
   *  private bits (your own cards, whether you are the leader). */
  snapshot(forId) {
    const me = this.getPlayer(forId);
    const base = {
      code: this.code,
      phase: this.phase,
      cardsPerPlayer: this.cardsPerPlayer,
      hostId: this.hostId,
      youAreHost: forId === this.hostId,
      you: me
        ? { id: me.id, name: me.name, teamId: me.teamId, submitted: me.submitted, cardCount: me.cards.length }
        : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        submitted: p.submitted,
        teamId: p.teamId,
        connected: p.connected,
      })),
      teams: this.teams.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        score: t.score,
        playerIds: this.teamPlayers(t.id).map((p) => p.id),
      })),
      totalCards: this.allCards().length,
      durations: DURATIONS,
      roundIndex: this.roundIndex,
      roundCount: ROUNDS.length,
      round: this.round,
      turnDuration: this.turnDuration,
      cardsLeft: this.pile.length,
      carryover: this.carryover,
      endedEarly: this.endedEarly,
    };

    if (['turnReady', 'playing', 'turnSummary'].includes(this.phase)) {
      const tp = this.getPlayer(this.turnPlayerId);
      const tt = this.teams.find((t) => t.id === this.turnTeamId);
      base.turn = {
        playerId: this.turnPlayerId,
        playerName: tp ? tp.name : '',
        teamId: this.turnTeamId,
        teamName: tt ? tt.name : '',
        teamColor: tt ? tt.color : '#888',
        bonus: this.turnBonus,
        endsAt: this.turnEndsAt,
        // The card only ever goes to the leader's device — nobody else's
        // phone should be able to peek at the answer.
        card: this.phase === 'playing' && forId === this.hostId && this.currentCardId
          ? (this.getCard(this.currentCardId) || {}).text
          : null,
        correctSoFar: this.turnLog.filter((l) => l.result === 'correct').length,
      };
    }

    if (this.phase === 'turnSummary') base.summary = this.turnSummary();

    if (['turnReady', 'roundIntro', 'turnSummary', 'playing'].includes(this.phase)) {
      const upTeam = this.nextUpTeam();
      const upPlayer = this.nextUpPlayer();
      base.nextUp = upTeam && upPlayer
        ? { playerId: upPlayer.id, playerName: upPlayer.name, teamId: upTeam.id, teamName: upTeam.name, teamColor: upTeam.color }
        : null;
    }

    if (this.phase === 'gameOver') {
      base.standings = this.standings();
      base.winner = this.winner();
      base.roundResults = this.roundResults;
    } else if (this.teams.length) {
      base.standings = this.standings();
    }

    return base;
  }
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (Number.isNaN(v)) return min;
  return Math.max(min, Math.min(max, v));
}

module.exports = { Game, GameError, ROUNDS, DURATIONS, MAX_CARD_WORDS, makeCode, shuffle, countWords };
