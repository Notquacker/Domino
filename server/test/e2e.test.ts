/**
 * End-to-end test over a real server and four real WebSocket clients.
 *
 * Covers the things unit tests cannot: the wire protocol, seating, a full match
 * played to its target score, mid-match reconnection, and — most importantly —
 * that a player is never sent anyone else's tiles.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import type { ClientMessage, Move, PlayerView, ServerMessage, TileId } from '@domino/shared';
import { parseTile } from '@domino/shared';

/**
 * Pick a move from nothing but this player's own view. The server no longer
 * hands over a list of legal moves — working out what fits is the player's
 * job — so the test does what a real client must do.
 */
function chooseMove(v: PlayerView): Move | null {
  if (v.hand.length === 0) return null;
  if (v.ends === null) {
    // Opening lead. The first round demands the 6-6.
    const opener = v.hand.includes('6-6') ? '6-6' : (v.hand[0] as TileId);
    return { kind: 'play', tile: opener, end: 'right' };
  }
  for (const id of v.hand) {
    const t = parseTile(id);
    if (t.low === v.ends.left || t.high === v.ends.left) {
      return { kind: 'play', tile: id, end: 'left' };
    }
    if (t.low === v.ends.right || t.high === v.ends.right) {
      return { kind: 'play', tile: id, end: 'right' };
    }
  }
  return { kind: 'pass' };
}

const PORT = 8231;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;

let server: ChildProcess;

/** Every state frame any client received, kept for the leak audit. */
const frames: { seat: number | null; raw: string }[] = [];

class TestClient {
  socket!: WebSocket;
  view: PlayerView | null = null;
  token = '';
  code = '';
  errors: string[] = [];
  private waiters: { test: () => boolean; resolve: () => void }[] = [];

  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  async open(): Promise<void> {
    this.socket = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.on('message', (data) => this.receive(String(data)));
  }

  private receive(raw: string): void {
    const msg = JSON.parse(raw) as ServerMessage;
    if (msg.t === 'welcome') {
      this.token = msg.token;
      this.code = msg.code;
      this.view = msg.view;
      frames.push({ seat: msg.view.you, raw });
    } else if (msg.t === 'state') {
      this.view = msg.view;
      frames.push({ seat: msg.view.you, raw });
    } else if (msg.t === 'error') {
      this.errors.push(msg.message);
    }
    for (const waiter of this.waiters.slice()) {
      if (waiter.test()) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve();
      }
    }
  }

  send(msg: ClientMessage): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** Resolve once the client's own view satisfies `test`. */
  until(test: () => boolean, label: string, ms = 10_000): Promise<void> {
    if (test()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.label}: timed out waiting for ${label}`)),
        ms,
      );
      this.waiters.push({
        test,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not come up');
}

before(async () => {
  server = spawn(process.execPath, ['server/dist/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForServer();
});

after(() => {
  server?.kill('SIGTERM');
});

describe('a full four-player match over the wire', () => {
  const clients = [0, 1, 2, 3].map((i) => new TestClient(`p${i}`));

  it('reports healthy', async () => {
    const res = await fetch(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  });

  it('seats four players at one table', async () => {
    for (const client of clients) await client.open();

    const host = clients[0]!;
    host.send({ t: 'create', name: 'Ana', rules: { scoring: 'rounds', targetScore: 3, winBy: 2 } });
    await host.until(() => host.view !== null, 'the table to open');
    const code = host.code;
    assert.match(code, /^[A-Z2-9]{4}$/);

    const names = ['Bo', 'Cyd', 'Dee'];
    for (let i = 1; i < 4; i++) {
      clients[i]!.send({ t: 'join', code, name: names[i - 1]! });
      await clients[i]!.until(() => clients[i]!.view !== null, 'to join');
    }

    await host.until(
      () => host.view!.seats.every((s) => s !== null),
      'all four seats to fill',
    );
    // Each player landed on a distinct seat.
    const seats = clients.map((c) => c.view!.you);
    assert.deepEqual([...seats].sort(), [0, 1, 2, 3]);
  });

  it('rejects a start before the table is full', async () => {
    const stray = new TestClient('stray');
    await stray.open();
    stray.send({ t: 'create', name: 'Solo', rules: { scoring: 'rounds', targetScore: 3 } });
    await stray.until(() => stray.view !== null, 'a table');
    stray.send({ t: 'start' });
    await stray.until(() => stray.errors.length > 0, 'a refusal');
    assert.match(stray.errors[0]!, /four seats/);
    stray.close();
  });

  it('deals seven tiles each and opens with the 6-6', async () => {
    const host = clients[0]!;
    host.send({ t: 'start' });
    await host.until(() => host.view!.phase === 'playing', 'the match to start');

    for (const client of clients) {
      await client.until(() => client.view!.phase === 'playing', 'the deal');
      assert.equal(client.view!.hand.length, 7, `${client.label} should hold seven tiles`);
    }

    // The player on turn is the one holding the double six.
    const opener = clients.find((c) => c.view!.turn === c.view!.you)!;
    assert.ok(opener.view!.hand.includes('6-6'), 'the opener must hold the 6-6');
    assert.equal(opener.view!.youMayMove, true, 'the opener is on turn');

    // The view must NOT carry a list of legal moves: that would be a hint.
    assert.equal(
      (opener.view as unknown as { legal?: unknown }).legal,
      undefined,
      'the server must not tell a player what they can play',
    );

    // And the rule is still enforced: another tile is refused.
    const other = opener.view!.hand.find((t) => t !== '6-6')!;
    opener.errors = [];
    opener.send({ t: 'move', move: { kind: 'play', tile: other, end: 'right' } });
    await opener.until(() => opener.errors.length > 0, 'the opener to be refused');
    assert.match(opener.errors[0]!, /illegal move/);
  });

  it('never sends a player another player’s tiles', () => {
    const hands = new Map<number, Set<TileId>>();
    for (const client of clients) {
      hands.set(client.view!.you!, new Set(client.view!.hand));
    }
    // No tile appears in two hands.
    const seen = new Set<TileId>();
    for (const [, hand] of hands) {
      for (const tile of hand) {
        assert.ok(!seen.has(tile), `tile ${tile} was dealt to two players`);
        seen.add(tile);
      }
    }
    assert.equal(seen.size, 28, 'all 28 tiles should be accounted for');

    // And no frame carried a hidden-state key or a hand that was not the
    // recipient's own.
    for (const frame of frames) {
      assert.ok(!frame.raw.includes('"hands"'), 'a frame leaked the server-side hands array');
      const parsed = JSON.parse(frame.raw) as { view: PlayerView };
      const own = parsed.view.hand;
      for (const seat of parsed.view.seats) {
        if (seat === null) continue;
        assert.equal(
          typeof (seat as unknown as { hand?: unknown }).hand,
          'undefined',
          'seat info must not carry tiles',
        );
      }
      if (parsed.view.you !== null && parsed.view.phase === 'playing') {
        const mine = hands.get(parsed.view.you);
        if (mine && own.length === 7) {
          for (const tile of own) {
            assert.ok(mine.has(tile), `player ${parsed.view.you} was sent a foreign tile ${tile}`);
          }
        }
      }
    }
  });

  it('survives a player dropping and reconnecting to the same seat', async () => {
    const victim = clients[2]!;
    const handBefore = [...victim.view!.hand];
    const seatBefore = victim.view!.you;
    const { token, code } = victim;

    victim.close();
    const host = clients[0]!;
    await host.until(
      () => host.view!.seats[seatBefore!]?.connected === false,
      'the drop to show up for everyone',
    );

    const returning = new TestClient('p2-again');
    await returning.open();
    returning.send({ t: 'resume', code, token });
    await returning.until(() => returning.view !== null, 'the resume');

    assert.equal(returning.view!.you, seatBefore, 'should return to the same seat');
    assert.deepEqual(
      [...returning.view!.hand].sort(),
      [...handBefore].sort(),
      'should get the same hand back',
    );
    clients[2] = returning;
  });

  it('plays the match through to its target score', async () => {
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('match did not finish in time')), 25_000);
      let settled = false;

      const step = (client: TestClient): void => {
        const v = client.view;
        if (v === null || settled) return;

        if (v.phase === 'matchOver') {
          settled = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        // Only the host deals, so the two do not race.
        if (v.phase === 'roundOver' && v.you === 0) {
          client.send({ t: 'nextRound' });
          return;
        }
        if (v.phase === 'playing' && v.turn === v.you) {
          const move = chooseMove(v);
          if (move !== null) client.send({ t: 'move', move });
        }
      };

      for (const client of clients) {
        client.socket.on('message', () => step(client));
        step(client);
      }
    });

    await done;

    // The resolve above fires on whichever client saw the end first; the other
    // three have frames still in flight, so wait for everyone to land on it.
    for (const client of clients) {
      await client.until(() => client.view!.phase === 'matchOver', 'the match to end');
    }

    const final = clients[0]!.view!;
    assert.equal(final.phase, 'matchOver');
    assert.ok(final.winner === 0 || final.winner === 1);
    const [a, b] = final.scores;
    const lead = final.winner === 0 ? a - b : b - a;
    assert.ok(Math.max(a, b) >= 3, `winner finished below the target at ${a}-${b}`);
    assert.ok(lead >= 2, `won by only ${lead} at ${a}-${b}`);
    assert.ok(final.roundNumber >= 1);
    for (const client of clients) {
      assert.deepEqual(client.view!.scores, final.scores, 'all clients agree on the score');
      assert.equal(client.view!.winner, final.winner, 'all clients agree on the winner');
    }
  });

  it('refuses a move once the match is over', async () => {
    const host = clients[0]!;
    host.errors = [];
    host.send({ t: 'move', move: { kind: 'pass' } });
    await host.until(() => host.errors.length > 0, 'a refusal');
    assert.match(host.errors[0]!, /no round in progress|not your turn/);
    for (const client of clients) client.close();
  });
});
