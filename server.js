'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Game, GameError, makeCode } = require('./game');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // rooms evaporate 6 hours after last activity

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** code -> { game, sockets: Map<playerId, Set<ws>>, timer, lastSeen } */
const rooms = new Map();

function createRoom(cardsPerPlayer) {
  let code = makeCode();
  let guard = 0;
  while (rooms.has(code) && guard++ < 50) code = makeCode();
  const game = new Game({ code, cardsPerPlayer });
  const room = { game, sockets: new Map(), timer: null, lastSeen: Date.now() };
  rooms.set(code, room);
  return room;
}

function touch(room) {
  room.lastSeen = Date.now();
}

function broadcast(room) {
  touch(room);
  for (const [playerId, set] of room.sockets) {
    const payload = JSON.stringify({ type: 'state', state: room.game.snapshot(playerId) });
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }
}

function sendError(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message }));
}

function sendTo(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function clearTurnTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function armTurnTimer(room, seconds) {
  clearTurnTimer(room);
  room.timer = setTimeout(() => {
    room.timer = null;
    room.game.endTurn();
    broadcast(room);
  }, seconds * 1000 + 150); // small grace so the client's 0 lands first
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.room = null;
  ws.playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'Bad message.');
    }
    try {
      handle(ws, msg);
    } catch (err) {
      if (err instanceof GameError || err.expected) sendError(ws, err.message);
      else {
        console.error('[handler]', err);
        sendError(ws, 'Something went wrong.');
      }
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room || !ws.playerId) return;
    const set = room.sockets.get(ws.playerId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        room.sockets.delete(ws.playerId);
        const p = room.game.getPlayer(ws.playerId);
        if (p) {
          if (room.game.phase === 'lobby' && !p.submitted) room.game.removePlayer(ws.playerId);
          else p.connected = false;
        }
        broadcast(room);
      }
    }
  });
});

function attach(ws, room, playerId) {
  ws.room = room;
  ws.playerId = playerId;
  if (!room.sockets.has(playerId)) room.sockets.set(playerId, new Set());
  room.sockets.get(playerId).add(ws);
  const p = room.game.getPlayer(playerId);
  if (p) p.connected = true;
}

function handle(ws, msg) {
  const { type } = msg;

  // ---- entry points -------------------------------------------------
  if (type === 'create') {
    const room = createRoom(msg.cardsPerPlayer);
    const player = room.game.addPlayer(msg.name);
    attach(ws, room, player.id);
    sendTo(ws, { type: 'joined', code: room.game.code, playerId: player.id });
    return broadcast(room);
  }

  if (type === 'join') {
    const code = String(msg.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) throw new GameError('No game with that code. Check it and try again.');
    const player = room.game.addPlayer(msg.name);
    attach(ws, room, player.id);
    sendTo(ws, { type: 'joined', code: room.game.code, playerId: player.id });
    return broadcast(room);
  }

  if (type === 'rejoin') {
    const code = String(msg.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return sendTo(ws, { type: 'rejoin-failed' });
    const player = room.game.getPlayer(msg.playerId);
    if (!player) return sendTo(ws, { type: 'rejoin-failed' });
    attach(ws, room, player.id);
    sendTo(ws, { type: 'joined', code: room.game.code, playerId: player.id });
    return broadcast(room);
  }

  // ---- everything below needs an established seat --------------------
  const room = ws.room;
  if (!room) throw new GameError('You are not in a game.');
  const game = room.game;
  const me = ws.playerId;
  touch(room);

  switch (type) {
    case 'setCardsPerPlayer':
      game.setCardsPerPlayer(me, msg.value);
      break;

    case 'submitCards':
      game.submitCards(me, msg.cards);
      break;

    case 'unsubmitCards': {
      const p = game.getPlayer(me);
      if (p && game.phase === 'lobby') p.submitted = false;
      break;
    }

    case 'openTeams':
      game.openTeamSetup(me, msg.teamCount || 2);
      break;

    case 'setTeamCount':
      game.setTeamCount(me, msg.value);
      break;

    case 'assign':
      game.assignPlayer(me, msg.playerId, msg.teamId);
      break;

    case 'randomiseTeams':
      game.randomiseTeams(me);
      break;

    case 'backToLobby':
      game.requireHost(me);
      if (game.phase === 'teams') game.phase = 'lobby';
      break;

    case 'start':
      game.start(me);
      break;

    case 'setDuration':
      game.setDuration(me, msg.value);
      break;

    case 'readyTurn':
      game.readyTurn(me);
      break;

    case 'beginTurn': {
      const { seconds } = game.beginTurn(me);
      armTurnTimer(room, seconds);
      break;
    }

    case 'correct': {
      const r = game.markCorrect(me);
      if (r && r.done) clearTurnTimer(room);
      break;
    }

    case 'skip': {
      const r = game.markSkip(me);
      if (r && r.done) clearTurnTimer(room);
      break;
    }

    case 'adjustScore':
      game.adjustScore(me, msg.delta);
      break;

    case 'advance':
      clearTurnTimer(room);
      game.advance(me);
      break;

    case 'transferLeadership':
      game.transferLeadership(me, msg.playerId);
      break;

    case 'endGame':
      clearTurnTimer(room);
      game.endGame(me);
      break;

    case 'ping':
      return sendTo(ws, { type: 'pong' });

    default:
      throw new GameError('Unknown action.');
  }

  broadcast(room);
}

// Drop dead sockets so a backgrounded phone does not hold a seat forever.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  });
}, 30000);
// unref so a script that only imports the app (tests, the audio renderer)
// can exit once its own work is done.
heartbeat.unref();

// Reap abandoned rooms.
const reaper = setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms) {
    if (room.lastSeen < cutoff && room.sockets.size === 0) {
      clearTurnTimer(room);
      rooms.delete(code);
    }
  }
}, 1000 * 60 * 10);
reaper.unref();

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(reaper);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Fishbowl running on http://localhost:${PORT}`);
  });
}

module.exports = { app, server, rooms };
