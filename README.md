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
  send the list of legal moves, and the board shows no highlighting: choose a
  tile and an end, and find out. A tile that does not fit is refused.
- **Drag a tile to the end you want.** Pick a tile up — by dragging or by
  tapping it — and the table splits into two targets, each showing the pip you
  would be playing against. Drop on one, or tap it. That is the only place the
  open ends appear: there is no standing readout, so the board is clear until
  you are actually choosing. On the opening lead, where there is nothing to
  choose between, the whole table is one target.
- **Passing is a choice.** You may pass at any time, even holding a playable
  tile. But a pass made on a tile you could have played **loses your team the
  whole round** — you score nothing, even if you went out first, and the other
  team takes 2 points. Bluff at your own risk.
- **You can call someone out.** Play carries on; nobody is stopped mid-round.
  Any player may hit **Catch a pass** at any moment and name an opponent who
  passed. Right, and that team loses the round there and then. Wrong, and your
  own team does. If nobody ever says anything, the hands come up at the end of
  the round and a false pass is caught anyway — calling it out early just ends
  the round on your terms.

  Who passed is public; whether a pass was *false* is not. A computer player
  only ever accuses on proof: with the whole set dealt and no boneyard, a
  player who passes while a 2 is on an end and later lays a tile with a 2 on it
  must have been holding it at the time. Nobody has to see their hand to
  know.
- **Somebody has to lead**, so the opening tile cannot be passed.
- **The 6-6 decides who leads — every round, not just the first.** Whoever
  is dealt it opens, however the last round went: winning a round does not win
  you the next lead. That player may open with **any double they like**, not
  necessarily the 6-6 itself; they always hold at least one, so the lead is
  never stuck.

  Two toggles cover the alternatives: turn off *"the 6-6 opens every round"*
  for the commoner tournament rule, where the 6-6 opens the match and the
  previous round's winner leads after that, and turn off *"the 6-6 holder may
  open with any double"* to make them lay the 6-6 itself.
- **A round ends** when someone plays their last tile, or when all four pass
  in turn.

### Computer players

A table needs four. If you have not got four phones to hand, the host can fill
the empty seats from the lobby — **Add a computer player**, or **Fill the
table**. They are server-side, so they play whether or not anyone is watching,
and a seat can be handed back to a person before the match starts.

A computer player sees exactly what somebody sitting in that seat would see:
its own tiles, the board, how many tiles everyone else is holding, and what the
passes have given away. It is handed a `BotContext` rather than the round, so
it cannot read another hand even by mistake — see `server/src/bot.ts` and the
tests in `server/test/bot.test.ts`, which assert the boundary directly.

A match with a computer player at the table is **not recorded to the stats**:
it is practice, and counting it would inflate everyone's record.
- **Winning a round is worth one point — or two for a capicú**, going out on
  a tile that matched both open ends. A capicú also earns your team a
  **smash**: slam the table and send the tiles skidding out of line until the
  next deal. The server decides who has earned one, so the button cannot be
  conjured up by a tampered client.
- **A locked round goes to the single lightest hand.** When nobody can play
  and everyone still holds tiles, the round is decided on the lightest hand at
  the table, not on which team's two hands add up to less. One player sitting
  on three pips wins it for their side however much their partner is holding.
  Level on the lightest hand scores nothing. In three thousand deals this
  changed who took the round in **23% of locked rounds**, so it is not a
  detail.
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
| Turn clock | 60s | Seconds per turn, or no limit. 30s, 60s, 2 min, none, or any value from 10 to 600. |
| 6-6 decides the lead | on | Whoever holds the 6-6 opens. |
| 6-6 opens every round | on | Not just the match's first round, so winning a round does not win the next lead. |
| Locked round to the lightest hand | on | A blocked round is settled on the lightest single hand, not the lower two-hand total. |

Two conventions are baked in and worth confirming against how you play:

1. **A blocked round is won on the lightest single hand**, not on team pip
   totals, and the next lead goes to whichever member of the winning team
   held fewer pips. Turn `blockedByLowestPlayer` off for the totals rule.
2. **A level blocked round scores nothing** and is re-dealt by the same opener.

Both live in `shared/src/rules.ts` and are small to change.

## Accounts and the leaderboard

Username and password, nothing else — no email, no recovery link. Signing in
is optional: guests play exactly as before, their matches just are not
counted.

**What is counted.** When a match finishes, everyone signed in at that table
gets a match played, and both players on the winning team get a win. Wins
follow the person, not the pair: win with one partner and again with another
and you have two while each of them has one. A table with a computer player
at it is practice and is not counted at all.

**Passwords.** Stored as a scrypt hash with a per-account salt and nothing
else. The plaintext is used to derive the hash and then dropped — never
written, never logged, never sent back. Comparisons are timing-safe, a run of
wrong guesses locks an account for a few minutes, and changing a password
drops every session it had. "Wrong name" and "wrong password" give the same
message so nobody can map out which accounts exist.

### The admin

One admin account is created on first boot — `Xay` by default, or whatever
`ADMIN_USERNAME` says. Its password comes from **`ADMIN_PASSWORD`**; with
that unset it falls back to a placeholder and the server says so loudly in
its log on every boot:

```
[domino] WARNING: admin "Xay" is using the placeholder password.
```

> **Set `ADMIN_PASSWORD`, or change the password from the app, before anyone
> else has the URL.** A known password on a public address is an open door —
> this one can reset every other player's password.

The admin can reset anyone's password, adjust or correct a win count, grant
or remove admin, and delete an account. Two things it deliberately cannot do:
remove its own admin rights, or delete itself, either of which would leave
the table with no admin at all. A password an admin sets is marked temporary,
and its owner is prompted to choose their own.

### Where it is stored, and when it is lost

Accounts live in **`data/accounts.json`** (set `DATA_DIR` to move it), written
to a temporary file and renamed so a crash mid-write cannot destroy what was
there. It is gitignored: it holds password hashes.

**A container that restarts from its image loses files written at runtime.**
On a host like that — a free-tier web service with no persistent disk — the
leaderboard resets on every redeploy. For it to last, point `DATA_DIR` at a
mounted disk, or move the store to Supabase, which this project is already
wired for.

### Whose turn it is

The player on turn gets a gold card with a **PLAYING** badge; the one after
them gets a quieter version with **NEXT**. Both are said in words as well as
colour — a tinted border is easy to miss on a phone, and colour alone is no
use to everyone. The status line under the table reads `Nena is playing ·
then Pichi`, which saves counting seats round the table.

Play always goes round one seat at a time, so "next" is simply `(turn + 1) %
4`. When the next player is you, the badge has nowhere to go — there is no
card for your own seat — and the status line says `then you` instead.

### The turn clock

`turnSeconds` is a table rule, not a constant: 60 seconds by default, any
value from 10 to 600, or **null for no clock at all**. With a clock, a player
who runs out has their first legal move played for them, so one person
wandering off cannot stall three others. With none, the table simply waits
and nobody is ever played for. The clock only shows on screen when there is
one.

### Typing on a phone

`render()` rebuilds the page with `replaceChildren`, which destroys whatever
input had focus. On Android the on-screen keyboard appearing **is** a window
resize, so a naive resize handler makes the name and table-code fields
impossible to fill in: the keyboard opens, the page re-renders, the field is
torn out, the keyboard closes, and round it goes.

Two things prevent it, and `npm run check:keyboard` (against a running server)
checks both: a height-only resize does not re-render at all, and any render
that does happen puts focus and the caret back. Keep both in mind before
adding another `render()` trigger.

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

## The board

The chain is drawn as one continuous line of dominoes. Every tile is placed
from the point where the last one ended, so neighbours actually touch — it
reads as a single connected chain rather than separate rows.

It is laid out around the tile that opened the round, growing both ways from
it the way a chain spreads across a real table, and a straight run turns a
corner after **seven tiles**. Because both arms share the opener's row, that
row holds seven in total rather than seven in each direction.

**The chain never turns straight after a double.** A double lies across the
chain rather than along it, so a corner there would fold back through a tile
that is already crosswise. When a turn falls on one the run carries straight
on and turns at the next tile, which is why a run occasionally reaches eight.

Whichever way the chain runs, the halves that touch always show the same
number of pips — the tile is drawn from whichever side meets its neighbour.

Two shapes, switched with the button in the top bar. It is a local preference
rather than a table rule, so everyone can pick their own.

- **Snaking** turns back on itself, giving the S and Z shapes.
- **Square** keeps turning the same way, sweeping out a rectangle whose two
  open ends finish apart.

Tiles turn with each corner and doubles lie across the run, which falls out of
a single rule: a tile lies across its run, a double along it, and turning the
chain swaps both. Tiles shrink as the chain grows, so the whole board stays on
screen without scrolling.

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
