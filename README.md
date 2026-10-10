# Domino — Curaçao style, online

A browser-based, real-time multiplayer domino game for four players in two
teams. Open a table, share a four-letter code, and play.

No installs, no accounts — players pick a name, join with a code, and play.

## The game

Curaçao-style partnership dominoes:

- **Double-six set (28 tiles), four players, two teams.** Partners sit
  opposite each other: seats 1 & 3 against seats 2 & 4.
- **The whole set is dealt** — seven tiles each, so there is **no boneyard**.
- **Nothing tells you what you can play.** The server deliberately does not
  send the list of legal moves, and the board shows no highlighting: pick a
  tile, pick an end, and find out. A tile that does not fit is refused.
- **Passing is a choice.** You may pass at any time, even holding a playable
  tile. But every pass is recorded, and when hands are revealed at the end of
  the round, **a pass made on a tile you could have played gives the other
  team a point**. Bluff at your own risk.
- **Somebody has to lead**, so the opening tile cannot be passed.
- **The 6-6 opens the first round** of a match, and whoever holds it leads.
  Afterwards the previous round's winner leads with any tile.
- **A round ends** when someone plays their last tile, or when all four pass
  in turn.
- **Winning a round is worth one point — or two for a capicú**, going out on
  a tile that matched both open ends. A blocked round goes to the team with
  the fewer pips; dead level scores nothing for the round.
- **The match is first to 10 — but only while the other team is under 5.**
  The moment **both** teams have reached 5 the match stops level and is
  **drawn**, 5-5 included. So 10-4 is a win, while 5-5, 6-5, 7-5 and 10-5 are
  all draws. The race is to get clear to 10 before the other team catches up
  to 5, not merely to arrive first.

### House rules you can toggle

Local domino varies family to family, so the contested parts are options set
when the table is created:

| Option | Default | Effect |
| --- | --- | --- |
| Scoring | **Rounds won** | One point per round, or the older style of counting the losers' pips. |
| Play to | **10** | 7, 10, 12 or 15 rounds (100/150/200 when counting pips). |
| Draw once both teams reach 5 | **on** | Off means the target alone decides it. |
| Point against a false pass | **on** | Passing while holding a playable tile scores for the other team. |
| Capicú counts double | **on** | A capicú round is worth 2 instead of 1 (+25 pips in the pip game). |
| Forced 6-6 opening | on | Round one is opened by the 6-6 holder, who must play it. |

Two conventions are baked in and worth confirming against how you play:

1. **A blocked round is won on team pip totals**, and the next lead goes to
   whichever member of the winning team held fewer pips.
2. **A level blocked round scores nothing** and is re-dealt by the same opener.

Both live in `shared/src/rules.ts` and are small to change.

## Running it

```bash
npm install
npm run build
npm start          # http://localhost:8080
```

For development, with the client hot-reloading against the game server:

```bash
npm run dev        # client on :5173, server on :8080
```

Tests:

```bash
npm test           # rules unit tests + a full end-to-end match over WebSockets
npm run typecheck
```

## Try it without a server

```bash
npm run build:demo        # -> demo/dist/index.html, open it in a browser
```

One static file: four players, two teams, one device, with a hand-off screen
between turns. It embeds the real rules engine — `scripts/build-demo.mjs`
bundles the same compiled `shared/` the server imports — so it is the quickest
way to check the house rules match how you play. It is not the multiplayer
game: there is no network and no hidden state.

Pushing to the default branch publishes it to GitHub Pages
(`.github/workflows/pages.yml`), giving the repo a link anyone can open. Pages
has to be switched on once, by hand, under **Settings → Pages → Build and
deployment → Source: "GitHub Actions"** — a workflow is not allowed to enable
it. After that every push deploys.

Pages serves static files only, so it can host this demo but never the real
game, which needs a Node process and WebSockets.

## Deploying — so people can play on their own phones

Everyone on a separate phone means the server has to be running somewhere both
phones can reach. One process is the whole app: it serves the built client
itself, listens on `$PORT` (default 8080) and answers `GET /healthz`.

**You do not need a computer for this.** Render deploys straight from the repo
through its web dashboard, which works fine in a phone browser:

1. Sign in at [render.com](https://render.com) with GitHub.
2. **New → Blueprint**, pick this repo, **Apply**.
3. `render.yaml` supplies the rest. When it goes live you get a URL like
   `https://domino.onrender.com` — send that to the other three players.

The blueprint does not pin a region, so it uses Render's default. Dominoes is
turn-based, so region makes no perceptible difference; change it in the
dashboard afterwards if you want.

On the free plan the service sleeps after about 15 minutes with no traffic and
takes roughly a minute to wake, so whoever opens the link first after a quiet
spell waits for that; the page says so while it happens. Once a game is going,
the server's 30-second heartbeat keeps traffic flowing so it should not sleep
mid-match. Rooms live in memory, so a sleep or a redeploy ends any table in
progress.

From a computer, `fly launch --now` works the same way off the `Dockerfile`.

The only real requirement is a host that runs a persistent Node process and
allows **WebSockets**. Static hosts cannot do it — see the note on GitHub Pages
above.

## Accounts and stats (optional)

Supabase adds durable identity and match history. It is entirely optional: with
no credentials configured, every player is a guest and the game is unchanged.

Players sign in **anonymously**, so joining still costs nothing but a name —
but that anonymous user is a real account underneath, so a record survives a
reload and can later be claimed with an email, keeping its history.

Setup is three steps, in [`supabase/README.md`](supabase/README.md): run the
migration, switch on anonymous sign-ins (**off by default** — nothing works
until it is on), and set four environment variables. Then
`npm run verify:supabase` checks the result by actively trying to cheat: it
attempts to write match rows with the public anon key and to read a stranger's
match, and reports a failure if either succeeds.

The division of trust matters here:

- The browser signs in with Supabase and gets a JWT.
- It hands that JWT to the **game server**, which verifies it against the
  project's JWKS (or a legacy HS256 secret). Only then does the server trust a
  user id. A token that is expired, tampered with, or minted for another
  project is rejected and the player stays a guest.
- Only the server writes results, with the service role key, through a single
  `record_match()` function. There is **no insert policy** on the match tables
  and that function is revoked from `anon` and `authenticated`, so a tampered
  client cannot award itself a win.
- Clients read their own profile, matches and stats directly from Postgres,
  where row-level security — not client-side good behaviour — is what stops
  them reading anyone else's.

Supabase is deliberately not on the critical path. Every call is time-boxed,
failures are swallowed and logged, and the client falls back to guest play if
sign-in does not complete. A Supabase outage costs you a history row, never a
game in progress.

`supabase-js` is loaded in its own chunk only when the project is configured,
so a guest-only deployment ships ~8 kB gzipped rather than ~67 kB.

## How it is put together

```
shared/   rules engine + wire protocol   (pure, no I/O, heavily tested)
server/   WebSocket server, rooms, seats (owns all authoritative state)
client/   browser UI                     (renders what the server sends)
supabase/ schema, RLS policies, setup    (optional: accounts and history)
```

**The server is authoritative.** Dominoes is a hidden-information game: if the
browser held the hands, anyone could read the other players' tiles out of
devtools. So the server owns the shuffle, every hand, and move validation, and
sends each player only their own tiles plus public information — the board and
everyone else's tile *counts*. The client never decides whether a move is legal;
it only offers the moves the server has already said are available. An end-to-end
test asserts that no frame ever carries a tile belonging to someone else.

Other things the server handles, because online games need them:

- **Reconnection.** Players are identified by a token, not a socket. Close the
  tab mid-match and rejoin to the same seat with the same hand.
- **A turn clock.** 60 seconds per move; when it runs out the server plays a
  legal move so one person walking away does not freeze the table.
- **Disconnects.** A seat is held for the rest of the match; before the match
  starts, leaving frees the seat.
- **Abuse basics.** Per-connection rate limiting, a 4 KB frame cap, name and
  chat length limits, and idle rooms reclaimed after 30 minutes.

## Not built yet

Deliberately out of scope: a public lobby or matchmaking, leaderboards across
players, spectator-friendly replays, sound, and AI opponents to fill empty
seats — right now a table needs four humans to start.
