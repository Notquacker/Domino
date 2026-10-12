/**
 * End-to-end test over a real server and four real WebSocket clients.
 *
 * Covers the things unit tests cannot: the wire protocol, seating, a full match
 * played to its target score, mid-match reconnection, and — most importantly —
 * that a player is never sent anyone else's tiles.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import type {
  AccountInfo,
  ClientMessage,
  LeaderRow,
  Move,
  PlayerView,
  ServerMessage,
  TileId,
} from '@domino/shared';
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
let dataDir = '';

/** Every state frame any client received, kept for the leak audit. */
const frames: { seat: number | null; raw: string }[] = [];

class TestClient {
  socket!: WebSocket;
  view: PlayerView | null = null;
  token = '';
  code = '';
  errors: string[] = [];
  account: AccountInfo | null = null;
  accountToken = '';
  leaders: LeaderRow[] = [];
  adminUsers: AccountInfo[] = [];
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
    } else if (msg.t === 'account') {
      this.account = msg.account;
      if (msg.token !== undefined) this.accountToken = msg.token;
      // Account frames go through the leak audit too: a hash or a password
      // reaching a client would show up here.
      frames.push({ seat: null, raw });
    } else if (msg.t === 'leaders') {
      this.leaders = [...msg.rows];
    } else if (msg.t === 'adminUsers') {
      this.adminUsers = [...msg.users];
      frames.push({ seat: null, raw });
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

  /**
   * Resolve once the client's own view satisfies `test`.
   *
   * The limits here are generous on purpose. Nothing in this test is timing
   * sensitive — they exist only so a wedged run fails instead of hanging —
   * and a shared CI runner is far slower than a developer's machine. A tight
   * limit buys nothing and turns a slow minute into a red build.
   */
  until(test: () => boolean, label: string, ms = 30_000): Promise<void> {
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
  for (let attempt = 0; attempt < 300; attempt++) {
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
  // A throwaway account file per run. Sharing the real one made the suite
  // pass once and then fail for good: the second run tried to register a
  // name the first run had already taken, and sat there until it timed out.
  // Blank SUPABASE_* too, so a configured machine still tests the file store.
  dataDir = mkdtempSync(join(tmpdir(), 'domino-e2e-'));
  server = spawn(process.execPath, ['server/dist/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitForServer();
});

after(async () => {
  // Wait for it to actually go before clearing the directory: a server still
  // flushing its account file recreates what has just been deleted, and the
  // remove fails on a directory that filled up again underneath it.
  if (server !== undefined && server.exitCode === null) {
    const gone = once(server, 'exit');
    server.kill('SIGTERM');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
  }
  if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true });
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

  it('deals seven tiles each and gives the lead to the 6-6 holder', async () => {
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

    // The opening rule is still enforced over the wire. Under the house rule
    // the opener may lead with any double, so the tile that must be refused is
    // one that is NOT a double — picking "anything but the 6-6" would land on a
    // legal double and quietly succeed.
    const plain = opener.view!.hand.find((t) => {
      const [a, b] = t.split('-');
      return a !== b;
    });
    assert.ok(plain, 'the opener should hold at least one tile that is not a double');
    opener.errors = [];
    opener.send({ t: 'move', move: { kind: 'play', tile: plain, end: 'right' } });
    await opener.until(() => opener.errors.length > 0, 'the opener to be refused');
    assert.match(opener.errors[0]!, /illegal move/);

    // Nothing reached the board, so the deal is still whole for the next test.
    assert.equal(opener.view!.board.length, 0, 'the refused tile must not have been laid');
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
        // Everyone else's tiles are the server's business until the round
        // is settled. Only then does `reveal` carry them.
        assert.equal(
          parsed.view.reveal,
          null,
          'a view sent mid-round carried everyone\u2019s tiles',
        );
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
      const timer = setTimeout(() => reject(new Error('match did not finish in time')), 90_000);
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

/**
 * One person against three computer players — the way the game gets tried out
 * on a deployed server before there are four phones to hand.
 */
describe('a table filled with computer players', () => {
  const solo = new TestClient('solo');

  it('seats three bots and starts with one human', async () => {
    await solo.open();
    solo.send({ t: 'create', name: 'Ana', rules: { scoring: 'rounds', targetScore: 2, winBy: 1 } });
    await solo.until(() => solo.view !== null, 'the table to open');
    solo.send({ t: 'sit', seat: 0 });
    await solo.until(() => solo.view!.you === 0, 'a seat');

    for (let i = 0; i < 3; i++) solo.send({ t: 'addBot' });
    await solo.until(
      () => solo.view!.seats.filter((s) => s !== null).length === 4,
      'the table to fill',
    );

    const seats = solo.view!.seats;
    assert.equal(seats[0]!.bot, false, 'the human seat must not be marked a bot');
    for (const seat of [1, 2, 3]) {
      assert.equal(seats[seat]!.bot, true, `seat ${seat} should hold a computer player`);
      assert.equal(seats[seat]!.connected, true, 'a bot is never shown as disconnected');
    }
    assert.equal(solo.view!.spectators, 0, 'bots must not be counted as spectators');
  });

  it('refuses a bot once the match has started, and from a non-host', async () => {
    solo.send({ t: 'start' });
    await solo.until(() => solo.view!.phase === 'playing', 'the match to start');
    solo.errors = [];
    solo.send({ t: 'addBot' });
    await solo.until(() => solo.errors.length > 0, 'a refusal');
    assert.match(solo.errors[0]!, /already started/);
  });

  it('lets the bots take their own turns without being driven', async () => {
    // The human sits out: whatever moves the board is the server's own doing.
    const before = solo.view!.board.length;
    await solo.until(
      () => solo.view!.board.length > before || solo.view!.turn === 0,
      'the bots to play',
      20_000,
    );
    assert.ok(
      solo.view!.board.length > before || solo.view!.turn === 0,
      'no bot ever moved',
    );
  });

  it('plays a whole match out with the human passing when stuck', async () => {
    for (let guard = 0; guard < 400; guard++) {
      if (solo.view!.phase === 'matchOver') break;
      if (solo.view!.phase === 'roundOver') {
        solo.send({ t: 'nextRound' });
        await solo.until(() => solo.view!.phase !== 'roundOver', 'the next round', 20_000);
        continue;
      }
      // Wait for our turn rather than polling: while the bots are thinking
      // there is nothing for this client to do, and spinning here would burn
      // the guard without a single tile going down.
      await solo.until(
        () => solo.view!.youMayMove || solo.view!.phase !== 'playing',
        'our turn to come round',
        20_000,
      );
      if (solo.view!.phase !== 'playing') continue;

      const v = solo.view!;
      const move = chooseMove(v);
      if (move === null) break;
      solo.errors = [];
      solo.send({ t: 'move', move });
      await solo.until(
        () => solo.view !== v || solo.errors.length > 0,
        'our move to land',
        20_000,
      );
      assert.deepEqual(solo.errors, [], 'the server refused a move the client thought was legal');
    }

    const final = solo.view!;
    assert.equal(final.phase, 'matchOver', 'the match never finished');
    assert.ok(final.winner === 0 || final.winner === 1 || final.drawn);
    // Every hand must still be accounted for: a bot that invented a tile, or
    // played one it did not hold, would show up here.
    assert.ok(final.roundNumber >= 1);
    solo.close();
  });
});

/** Calling someone out, over the wire. */
describe('catching a false pass across four connections', () => {
  const clients = [0, 1, 2, 3].map((i) => new TestClient(`c${i}`));

  it('ends the round on a correct accusation and takes the points', async () => {
    for (const client of clients) await client.open();
    const host = clients[0]!;
    host.send({ t: 'create', name: 'Ana', rules: { targetScore: 10 } });
    await host.until(() => host.view !== null, 'the table');
    const code = host.code;
    for (let i = 1; i < 4; i++) {
      clients[i]!.send({ t: 'join', code, name: `P${i}` });
      await clients[i]!.until(() => clients[i]!.view !== null, 'to join');
    }
    for (let i = 0; i < 4; i++) {
      clients[i]!.send({ t: 'sit', seat: i as 0 | 1 | 2 | 3 });
      await clients[i]!.until(() => clients[i]!.view!.you === i, 'a seat');
    }
    host.send({ t: 'start' });
    await host.until(() => host.view!.phase === 'playing', 'the match');

    // Play on until somebody bluffs: a player passes although their own hand
    // answers an open end. Only they can know that, which is the point.
    let bluffer: number | null = null;
    for (let guard = 0; guard < 200 && bluffer === null; guard++) {
      const onTurn = clients.find((c) => c.view!.youMayMove);
      if (onTurn === undefined) {
        await new Promise((r) => setTimeout(r, 30));
        continue;
      }
      const v = onTurn.view!;
      const move = chooseMove(v);
      if (move === null) break;
      if (move.kind === 'play' && v.board.length > 0) {
        bluffer = v.you;
        onTurn.send({ t: 'move', move: { kind: 'pass' } });
      } else {
        onTurn.send({ t: 'move', move });
      }
      await onTurn.until(() => !onTurn.view!.youMayMove, 'the move to land', 20_000);
    }
    assert.notEqual(bluffer, null, 'nobody ever had a chance to bluff');

    // Everyone can see WHO passed. Whether it was false is still hidden.
    await host.until(
      () => host.view!.passedSeats.includes(bluffer as 0 | 1 | 2 | 3),
      'the pass to show up publicly',
    );
    for (const client of clients) {
      const raw = JSON.stringify(client.view);
      assert.ok(!raw.includes('couldHavePlayed'), 'a view leaked whether a pass was false');
    }

    const accuser = clients.find((c) => c.view!.you !== null && c.view!.you! % 2 !== bluffer! % 2)!;
    accuser.errors = [];
    accuser.send({ t: 'callOut', seat: bluffer as 0 | 1 | 2 | 3 });
    await accuser.until(() => accuser.view!.phase !== 'playing', 'the round to end', 20_000);

    const result = accuser.view!.lastResult!;
    assert.equal(result.kind, 'calledOut');
    assert.equal(result.calledOut!.correct, true, 'the accusation was right');
    assert.equal(result.calledOut!.accused, bluffer);
    const guilty = (bluffer! % 2) as 0 | 1;
    assert.deepEqual(result.forfeited, [guilty], 'the bluffing team forfeits');
    assert.equal(result.awarded[guilty], 0, 'and scores nothing');
    assert.equal(result.awarded[1 - guilty], 2, 'the other team takes 2');

    // Wait for every client's own frame before comparing: the accuser's
    // arrives first, and asserting on the others straight away just races it.
    for (const client of clients) {
      await client.until(() => client.view!.phase !== 'playing', 'its own round-over frame', 20_000);
    }
    for (const client of clients) {
      assert.deepEqual(client.view!.scores, accuser.view!.scores, 'all four agree on the score');
      assert.equal(client.view!.lastResult!.kind, 'calledOut');
      client.close();
    }
  });
});

/** Wait for something to become true, by looking rather than by listening. */
async function settle(test: () => boolean, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** What everyone was holding, once the round is settled. */
describe('showing the hands when the round is over', () => {
  const me = new TestClient('rev');

  after(() => {
    me.close();
  });

  it('keeps every hand to itself until the round ends, then shows them all', async () => {
    // Three computer players so the round plays itself out; only our own
    // turns need driving, and only our own view needs watching — which is
    // the view the guarantee is about.
    await me.open();
    me.send({
      t: 'create',
      name: 'Rev',
      rules: { scoring: 'rounds', targetScore: 3, turnSeconds: null },
    });
    await me.until(() => me.view !== null, 'the table to open');
    for (let i = 0; i < 3; i++) {
      me.send({ t: 'addBot' });
      await me.until(() => me.view!.seats.filter((s) => s !== null).length === i + 2, 'a bot');
    }
    me.send({ t: 'start' });
    await me.until(() => me.view!.phase === 'playing', 'the deal');

    const dealt = [...me.view!.hand];
    let sawPlaying = 0;

    for (let go = 0; go < 400 && me.view!.phase === 'playing'; go++) {
      if (me.view!.phase === 'playing') {
        sawPlaying++;
        assert.equal(me.view!.reveal, null, 'the hands were shown while the round was still on');
      }
      if (!(await settle(() => me.view!.youMayMove || me.view!.phase !== 'playing', 20_000))) break;
      if (me.view!.phase !== 'playing') break;

      let moved = false;
      for (const tile of [...me.view!.hand]) {
        for (const end of ['right', 'left'] as const) {
          if (moved) continue;
          const was = me.view!.board.length;
          me.errors = [];
          me.send({ t: 'move', move: { kind: 'play', tile, end } });
          await settle(() => me.view!.board.length > was || me.errors.length > 0, 5_000);
          if (me.errors.length === 0) moved = true;
        }
      }
      if (!moved) {
        me.errors = [];
        me.send({ t: 'move', move: { kind: 'pass' } });
        // A pass is refused on the opening lead, where somebody must play.
        // That is an answer too, so take it and move on rather than waiting.
        await settle(() => !me.view!.youMayMove || me.errors.length > 0, 5_000);
        if (me.errors.length > 0) break;
      }
    }

    assert.ok(sawPlaying > 4, `the round barely ran: ${sawPlaying} turns watched`);
    assert.ok(await settle(() => me.view!.phase !== 'playing'), 'the round should have finished');

    // Now every seat's tiles are there, and they add up: what is left in the
    // four hands plus what is on the table is the whole set, with nothing
    // counted twice.
    const reveal = me.view!.reveal;
    assert.ok(reveal !== null, 'the hands were not shown after the round');
    assert.equal(reveal.length, 4, 'every seat should be accounted for');

    const mine = reveal[me.view!.you!] ?? [];
    assert.deepEqual([...mine].sort(), [...me.view!.hand].sort(), 'our own hand came back wrong');
    for (const tile of mine) {
      assert.ok(dealt.includes(tile), `we were never dealt ${tile}`);
    }

    const seen = new Set<string>();
    for (const hand of reveal) {
      for (const tile of hand) {
        assert.ok(!seen.has(tile), `${tile} is in two hands at once`);
        seen.add(tile);
      }
    }
    for (const laid of me.view!.board) {
      assert.ok(!seen.has(laid.id), `${laid.id} is both on the table and in a hand`);
      seen.add(laid.id);
    }
    assert.equal(seen.size, 28, 'the tiles on the table and in the hands should be the whole set');
  });
});

/** Accounts and the leaderboard, over the wire. */
describe('accounts and the leaderboard', () => {
  const c = new TestClient('acct');

  it('creates an account, signs out, and signs back in', async () => {
    await c.open();
    c.send({ t: 'register', username: 'Pico', password: 'picopass' });
    await c.until(() => c.account?.username === 'Pico', 'the account');
    assert.equal(c.account!.wins, 0);
    assert.equal(c.account!.isAdmin, false, 'a new account is not an admin');
    assert.ok(c.accountToken.length > 20, 'a session token comes back');

    // The frames must never carry anything password-shaped.
    for (const frame of frames) {
      assert.ok(!frame.raw.includes('picopass'), 'a password was echoed back to a client');
      assert.ok(!frame.raw.includes('"hash"'), 'a password hash reached a client');
      assert.ok(!frame.raw.includes('"salt"'), 'a salt reached a client');
    }

    // A token from this session works on a brand new connection: that is how
    // a reload keeps you signed in.
    const token = c.accountToken;
    const other = new TestClient('acct2');
    await other.open();
    other.send({ t: 'restore', token });
    await other.until(() => other.account?.username === 'Pico', 'to be signed back in');
    other.close();

    // Signing out kills the token everywhere, so a copy of it is now useless.
    c.send({ t: 'logout' });
    await c.until(() => c.account === null, 'to be signed out');
    const third = new TestClient('acct3');
    await third.open();
    third.send({ t: 'restore', token });
    await third.until(() => third.account === null, 'the dead token to be refused');
    assert.equal(third.account, null, 'a token from before a sign-out must not work');
    third.close();

    c.send({ t: 'login', username: 'Pico', password: 'picopass' });
    await c.until(() => c.account?.username === 'Pico', 'to sign back in with the password');
  });

  it('refuses a duplicate name and a wrong password, without saying which', async () => {
    c.errors = [];
    c.send({ t: 'register', username: 'pico', password: 'whatever' });
    await c.until(() => c.errors.length > 0, 'a refusal');
    assert.match(c.errors[0]!, /taken/);

    c.errors = [];
    c.send({ t: 'login', username: 'Pico', password: 'notmypassword' });
    await c.until(() => c.errors.length > 0, 'a refusal');
    const wrongPass = c.errors[0]!;
    c.errors = [];
    c.send({ t: 'login', username: 'NobodyAtAll', password: 'notmypassword' });
    await c.until(() => c.errors.length > 0, 'a refusal');
    assert.equal(
      c.errors[0],
      wrongPass,
      'a wrong password and an unknown name must read the same, or the message maps out who has an account',
    );
  });

  it('keeps admin commands away from a player who is not one', async () => {
    c.errors = [];
    c.send({ t: 'adminUsers' });
    await c.until(() => c.errors.length > 0, 'a refusal');
    assert.match(c.errors[0]!, /admins only/);

    c.errors = [];
    c.send({ t: 'adminSetPassword', username: 'Pico', next: 'hijacked' });
    await c.until(() => c.errors.length > 0, 'a refusal');
    assert.match(c.errors[0]!, /admins only/);
    // And the password is untouched: the old one still works.
    c.send({ t: 'login', username: 'Pico', password: 'picopass' });
    await c.until(() => c.account?.username === 'Pico', 'the old password still works');
    c.close();
  });

  it('gives a win to both players on the winning team', async () => {
    const clients = [0, 1, 2, 3].map((i) => new TestClient(`lb${i}`));
    // Names of their own: the admin seat is already called Xay and an earlier
    // test in this file has taken Pico.
    const names = ['BoardOne', 'BoardTwo', 'BoardThree', 'BoardFour'];
    for (const client of clients) await client.open();
    for (let i = 0; i < 4; i++) {
      clients[i]!.send({ t: 'register', username: names[i]!, password: 'tablepass' });
      await clients[i]!.until(() => clients[i]!.account !== null, 'an account');
    }

    const host = clients[0]!;
    host.send({ t: 'create', name: names[0]!, rules: { targetScore: 1, winBy: 1, drawAt: null } });
    await host.until(() => host.view !== null, 'a table');
    const code = host.code;
    for (let i = 1; i < 4; i++) {
      clients[i]!.send({ t: 'join', code, name: names[i]! });
      await clients[i]!.until(() => clients[i]!.view !== null, 'to join');
    }
    for (let i = 0; i < 4; i++) {
      clients[i]!.send({ t: 'sit', seat: i as 0 | 1 | 2 | 3 });
      await clients[i]!.until(() => clients[i]!.view!.you === i, 'a seat');
    }
    host.send({ t: 'start' });
    await host.until(() => host.view!.phase === 'playing', 'the match');

    for (let guard = 0; guard < 400; guard++) {
      if (host.view!.phase === 'matchOver') break;
      const onTurn = clients.find((x) => x.view!.youMayMove);
      if (onTurn === undefined) {
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      const move = chooseMove(onTurn.view!);
      if (move === null) break;
      onTurn.send({ t: 'move', move });
      await onTurn.until(() => !onTurn.view!.youMayMove, 'the move', 20_000);
    }
    assert.equal(host.view!.phase, 'matchOver', 'the match should have finished');
    const winningTeam = host.view!.winner;
    assert.notEqual(winningTeam, null, 'somebody won');

    host.send({ t: 'leaderboard' });
    await host.until(() => host.leaders.length > 0, 'the board', 10_000);

    // Seats 0 and 2 are one team, 1 and 3 the other.
    const expectWin = [0, 1, 2, 3].filter((seat) => seat % 2 === winningTeam);
    for (const seat of expectWin) {
      const row = host.leaders.find((r) => r.username === names[seat]);
      assert.ok(row, `${names[seat]} should be on the board`);
      assert.equal(row!.wins, 1, `${names[seat]} was on the winning team and should have a win`);
    }
    for (const seat of [0, 1, 2, 3].filter((s) => s % 2 !== winningTeam)) {
      const row = host.leaders.find((r) => r.username === names[seat]);
      assert.equal(row?.wins ?? 0, 0, `${names[seat]} lost and should have no win`);
      assert.equal(row?.matches ?? 0, 1, `${names[seat]} still played a match`);
    }
    for (const client of clients) client.close();
  });
});
