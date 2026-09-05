# Fishbowl

A four-round party word game. Everyone writes cards on their own phone, then
one phone runs the game while it gets passed around the room.

Working title — rename it whenever you like (it appears in `public/index.html`
and on the home screen in `public/app.js`).

---

## Running it on your laptop

```bash
npm install
npm start
```

Open <http://localhost:3000>.

To let phones on your home wifi join, find your machine's LAN address
(`ip addr` on Linux, `ipconfig getifaddr en0` on macOS) and have everyone visit
`http://<that-address>:3000`. Same wifi network only — this is for testing
before you deploy.

## Tests

```bash
npm test                  # 28 rules tests, no network, instant
node test/server.test.js  # 23 integration tests over real websockets
node test/ui.js           # drives a phone-sized browser, writes shots/ (needs playwright)
node test/sound.js        # 17 audio tests — plays a real 30s turn, so it takes a minute
```

The first two are the ones to run after any change. The last two need
Playwright installed and catch layout and audio regressions respectively.

```bash
node test/render-audio.js sound-preview.wav
```

renders the tick and alarm to a WAV using the real `sound.js`, so you can
judge the sound design by ear without starting a game.

---

## Deploying so friends can actually join

Any host that runs Node and supports websockets works. Two easy ones:

**Render** (has a free tier)

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com) → New → Web Service → connect the repo.
3. Build command `npm install`, start command `npm start`.
4. Leave the port alone — the server reads `process.env.PORT`, which Render sets.

**Railway** (~$5/mo, no cold starts)

1. `npm i -g @railway/cli && railway login`
2. `railway init && railway up` from this folder.

**Fly.io**

This repository includes a `Dockerfile` and `.dockerignore` for Fly. Install and
sign in to `flyctl`, then run these commands from the project directory:

```bash
brew install flyctl                 # macOS; skip if already installed
fly auth login
fly launch --no-deploy              # choose a unique app name and a nearby region
fly deploy
fly apps open                       # opens the public HTTPS URL
```

When `fly launch` asks about a database, choose **No**. The app does not need
one for a party game. Keep it to one machine: rooms and game state are stored in
this Node process, so multiple machines would not share rooms. In the generated
`fly.toml`, make sure the HTTP service uses `internal_port = 3000`; for a live
party, set `auto_stop_machines = "off"` so Fly does not stop the process and
end an in-progress game. Check the deployment with:

```bash
fly status
curl https://YOUR-APP-NAME.fly.dev/healthz
fly logs
```

The deployed site uses `wss://` automatically because the browser derives the
WebSocket protocol from the page URL. A machine restart still ends active games;
that is expected because rooms are intentionally in memory.

Free tiers sleep when idle, so the first person to open it waits ten or twenty
seconds. Fine for testing, worth paying the few euro before a real party.

Nothing is stored on disk — rooms live in memory and are cleaned up six hours
after the last person leaves. Restarting the server ends any game in progress.

---

## How the code is laid out

| File | What it does |
|---|---|
| `game.js` | All the rules. No networking, no DOM, no timers. |
| `server.js` | Express + websockets. Routes messages to `game.js` and broadcasts state. |
| `public/app.js` | The whole client. One socket, one state object, one render function. |
| `public/sound.js` | Tick and alarm, synthesised with Web Audio. No audio files. |
| `public/styles.css` | Mobile-first dark theme. |
| `test/` | Rules tests, integration tests, and a browser walkthrough. |

`game.js` is deliberately free of anything platform-specific. When you port to
React Native, that file moves across unchanged and you rewrite only the views.

### How state flows

The server is the single source of truth. Every client action is a websocket
message; the server applies it to the `Game` instance and broadcasts a fresh
snapshot to every connected phone. Clients never compute game state locally —
the only thing the client works out for itself is the countdown, which it
renders against the server's `turn.endsAt` timestamp so a laggy connection
cannot desync the clock.

Snapshots are built per player. **The card face is only ever sent to the
leader's device** — there is no way for another phone to read ahead, because
the answer never leaves the server for anyone else.

---

## Rules as implemented

- **Cards.** Each player writes the same number (leader picks 1–6 in the UI,
  engine allows up to 10). Five words maximum per card.
- **Teams.** Two to six. Assign by tapping, or hit Randomise.
- **Rotation.** Strict: teams alternate, and each team advances its own pointer
  through its players. Uneven team sizes work — nobody gets skipped.
- **Rounds.** Describe It → Act It Out → One Word → Noises Only. Every card
  returns to the pile at the start of each round.
- **Skips** are unlimited. A skipped card goes to the back of the pile and
  always comes back.
- **Round finish.** If the pile empties mid-turn, the same player starts the
  next round with the seconds left on their clock. The leader still chooses the
  standard duration for the new round, which applies after that opening turn.
- **Score editing.** The leader can nudge a turn's count up or down on the
  summary screen. Adjusting also corrects that player's personal stats.
- **Leader handover** is offered between rounds and after a completed round.
  Cards and scores carry over to the new phone.
- **End game** is available to the leader at any point and jumps to the final
  board, marked "ended early".

## Sound

Everything is synthesised at runtime — there are no audio files to download,
so nothing fails on bad wifi and the whole module is about 3 KB.

- A soft tick every second, alternating pitch so it reads as tick-tock.
- The final ten seconds switch to a brighter, louder tick — roughly three
  times the amplitude, so the change is obvious across a room.
- Time up is three hard bursts plus a descending sweep, about eight times the
  soft tick, and it vibrates the phone on Android.
- Clearing the whole pile plays a rising four-note flourish instead, so
  finishing the round is never confused with running out of time.

The leader can turn sound off on the round setup screen; the choice is
remembered on that phone.

**To make the quiet tick louder**, raise `gain` in the `tick` function in
`public/sound.js` — `0.05` is deliberately subtle. Re-run
`node test/render-audio.js` to hear the change.

**iOS caveat:** a page cannot play audio until the user has tapped something,
which is handled — the tap that starts a turn unlocks it. But if the phone's
physical ringer switch is set to silent, nothing a web page does can override
it. If the leader hears no tick, that switch is the first thing to check.

## Reconnecting

Each phone stores its room code and player id in `localStorage` and rejoins
automatically if the connection drops or the browser is closed and reopened.

One consequence worth knowing: two tabs in the same browser are the *same*
player. To test multiple players on one machine, use separate browsers or
private windows.

---

## Known gaps before this is an App Store product

These are deliberate — they were not needed to playtest the game, and several
of them are decisions better made after you have played it a few times.

1. **No persistence.** A server restart loses in-progress games. Fine for a
   party; needs Redis or Postgres for anything real.
2. **No rate limiting or abuse controls.** Anyone who guesses a four-letter
   code can join a room. Worth adding before a public launch.
3. **No reconnection grace for the leader.** If the leader's phone dies
   entirely, the game stalls — hand leadership over *before* the battery goes.
4. **Web, not native.** Add to Home Screen gets you most of the way (it is
   configured for standalone mode), but there is no App Store binary yet.
5. **The ringer switch.** See the iOS caveat above — worth knowing before you
   blame the code.
