# Working on this project

Curaçao-style partnership dominoes: four players, two teams, partners
opposite. Built to play with family on separate phones. Live at
`https://domino-p75y.onrender.com` (Render, deploying from this branch).

`README.md` is the real documentation — the rules, the board geometry, the
architecture and why it is shaped that way. Read it first. This file is the
shorter thing: how to work here without re-learning what has already been
learnt the hard way.

## Getting it running

```bash
npm install
npm run build
npm start          # http://localhost:8080
npm run dev        # watch mode: client on :5173, server on :8080
npm test           # 181 tests
npm run typecheck
```

Node 22 or newer. npm workspaces: `shared/`, `server/`, `client/`, plus
`demo/` (a standalone pass-and-play page) and `scripts/`.

Accounts fall back to a file in `data/` when Supabase is not configured.
`data/` is gitignored because it holds password hashes — keep it that way.

## The boundaries that are not up for negotiation

**The server is authoritative.** Dominoes is a hidden-information game. The
browser never learns another player's tiles: the server redacts every view.
There is an end-to-end test that reads every frame and fails if a hand
reaches the wrong player. Do not work around it.

The one exception is `reveal` in `PlayerView`, which carries every hand
*once the round is over* — null while one is being played. Two tests hold
that line, and both fail if the server is made to send hands throughout.

**The server never sends the list of legal moves.** Working out what fits is
the game. Clients show a tile at both ends regardless of pips and let the
move be refused. Do not add a "playable" hint, however helpful it looks.

**`SUPABASE_SERVICE_ROLE_KEY` bypasses every row-level policy.** Server-side
only. Never in the client bundle, never in a file in the repo — it belongs in
the shell or in Render's Environment screen. Same for anything else secret:
never ask for a key to be pasted into a chat.

## The geometry is shared, not duplicated

`shared/src/geometry.ts` walks the chain and decides where every tile sits,
on a whole-unit grid (a tile is 2 units across, 4 along). The server and both
clients import the same walker, so what the table decides and what you see
cannot disagree. If you are tempted to lay tiles out in the client, don't —
that is where a whole class of bugs came from.

Rules worth knowing, all enforced in `directionsAt`:

- An end grows outward; the way it came is not a direction.
- **A double never turns a corner.** It lies across the line and the line
  carries straight on through it. Let it turn and it comes to rest flat
  against its neighbour with the matching halves never touching.
- Nothing may be laid on top of anything else; every candidate is measured.

## How things get verified here

Unit tests cover the engine. They do not cover where a tile *lands on a
screen*, so there are browser checks in `scripts/` that drive a real
Chromium:

```bash
npm run build:demo && node scripts/check-placement.mjs    # the demo
node server/dist/index.js &                               # then, live:
node scripts/check-client-placement.mjs http://127.0.0.1:3000/
node scripts/check-turn.mjs   http://127.0.0.1:3000/
node scripts/check-zoom.mjs   http://127.0.0.1:3000/
node scripts/check-review.mjs http://127.0.0.1:3000/
node scripts/check-hand.mjs   http://127.0.0.1:3000/
node scripts/check-keyboard.mjs http://127.0.0.1:3000/
```

They need Playwright (`npm i -D playwright`). Each one's header says what it
guards and which bug it was written for.

**The habit that matters:** when a change is visual, measure it in a browser
rather than reasoning about the CSS. Most of the real bugs in this project
were invisible in the code and obvious in a measurement — and several times
the *measurement* was wrong before the code was. When you write a check,
confirm it fails on the old behaviour before trusting it.

## Things that have bitten, more than once

- **`getBoundingClientRect` includes transforms.** A tile mid drop-animation
  measures as if it were somewhere else. Use `offsetLeft`/`offsetTop`/
  `offsetWidth` when you want the layout box.
- **Generic class names collide.** `.board` was the leaderboard *and* every
  tile on the table (it moved all of them 6px). `.turn` was the turn badge
  *and* the on-turn player's card (it collapsed the card). Check before
  reusing a short name.
- **Never let the layout change height between states.** The board sits above
  the hand, so anything that grows or shrinks — a hint that wraps to two
  lines, room appearing for the drop spots — shoves the board up or down. If
  that happens mid-drag, the thing you are aiming at moves out from under
  your thumb. Reserve the space in both states instead.
- **A pinch ends with one `pointerup` per finger**, which reads as a
  double-tap unless you guard for it.
- **`render()` rebuilds the page with `replaceChildren`**, which destroys the
  focused input. On Android the keyboard opening *is* a resize, so
  re-rendering on resize made typing impossible. There is a width-only guard
  and a focus/caret restore — leave them.
- The end-to-end suite uses a throwaway `DATA_DIR` per run. It used to share
  the real one and so passed exactly once.

## State of things

- Everything is on the branch `ccr-064abddc-ejnnem`. There is no `main`.
- `supabase/SETUP.md` has the setup. `0002_accounts.sql` is applied;
  `0001_init.sql` (match history) is not — until it is, the server logs a
  harmless `record_match failed` after each match.
- Commit messages here are long on purpose: they carry the reasoning and the
  measurements. `git log` is the best record of why things are the way they
  are. Please keep writing them that way.
