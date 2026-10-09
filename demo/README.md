# Pass-and-play demo

A single static HTML file: four players, two teams, one device. A hand-off
screen between turns keeps hands private, or you can switch it off and play
all four seats yourself to try the rules out.

```bash
npm run build:demo        # -> demo/dist/index.html
```

Then open `demo/dist/index.html` directly in a browser. There is no server and
no build output to host beyond that one file.

## Why it exists

It is the fastest way to check that the rules match how you actually play,
without deploying anything. Every house rule is a control on the setup screen.

It is **not** the multiplayer game. There is no network, no room code, and no
hidden state — everyone shares one screen. The real game needs the server in
`server/`, because hiding each player's hand from the others is exactly what a
client cannot be trusted to do.

## It cannot drift from the real rules

`scripts/build-demo.mjs` bundles `shared/dist` — the same compiled rules engine
the server imports — straight into the page. Dealing, legal moves, blocked
rounds and scoring are the code covered by the test suite, not a second
implementation that has to be kept in step.

## Source

- `src/page.html` — title, styles and the app container
- `src/app.js` — screens and input handling only; no game rules

The same two files are also what gets published as a shareable artifact, so
fixes land in both places.
