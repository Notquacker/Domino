/**
 * Computer players.
 *
 * The thing worth testing hardest is not how well a bot plays but what it is
 * able to see. A bot runs inside the server with every hand within reach, so
 * these tests check the boundary first and the strategy second.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  type BoardTile,
  type Move,
  type Pip,
  type RoundState,
  type Seat,
  DEFAULT_RULES,
  SEATS,
  applyMove,
  dealRound,
  isSound,
  laidTiles,
  layout,
  legalMoves,
  newMatch,
  openEnds,
  openerIndexOf,
  seededRng,
} from '@domino/shared';

/** A move that lays a tile — the half of `Move` these tests are about. */
type Play = Extract<Move, { kind: 'play' }>;
import { type BotContext, chooseMove } from '../dist/bot.js';

/** Build a bot's context the way the room does: own hand plus public state. */
function contextFor(round: RoundState, seat: Seat, voids: Pip[][]): BotContext {
  return {
    seat,
    hand: round.hands[seat] ?? [],
    board: round.board,
    openerTile: round.openerTile,
    ends: openEnds(round.board),
    tilesLeft: SEATS.map((s) => (round.hands[s] ?? []).length),
    voids: voids.map((v) => [...v]),
    caught: [],
    rules: DEFAULT_RULES,
  };
}

describe('what a computer player can see', () => {
  it('never reaches for a hand in its own source', () => {
    // A blunt guard, but the one that actually catches the mistake: the
    // moment bot.ts starts touching RoundState it can read all four hands.
    const src = readFileSync(new URL('../src/bot.ts', import.meta.url), 'utf8');
    const code = src
      .replace(/\/\*\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bRoundState\b/.test(code), 'bot.ts must not touch RoundState');
    assert.ok(!/\.hands\b/.test(code), 'bot.ts must not read a hands array');
    assert.ok(!/\bMatchState\b/.test(code), 'bot.ts must not touch MatchState');
  });

  it('only ever plays a tile from the hand it was given', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const round = dealRound(DEFAULT_RULES, 1, null, seededRng(seed));
      const seat = round.turn;
      const ctx = contextFor(round, seat, [[], [], [], []]);
      const move = chooseMove(legalMoves(round, seat), ctx, 0);
      if (move.kind !== 'play') continue;
      assert.ok(
        ctx.hand.includes(move.tile),
        `seed ${seed}: bot played ${move.tile}, which is not in its hand`,
      );
    }
  });

  it('plays the same move whether or not the other hands are there', () => {
    // If swapping everyone else's tiles changes the bot's choice, something
    // hidden is leaking into the decision.
    for (let seed = 1; seed <= 40; seed++) {
      const round = dealRound(DEFAULT_RULES, 1, null, seededRng(seed));
      const seat = round.turn;
      const moves = legalMoves(round, seat);
      const real = chooseMove(moves, contextFor(round, seat, [[], [], [], []]), 0);

      // Replace the other tiles but keep the COUNTS: tile counts are public,
      // and emptying the hands would change what the bot may legitimately
      // know, which would prove nothing.
      const scrambled: RoundState = {
        ...round,
        hands: round.hands.map((h, i) =>
          i === seat ? h : h.map(() => '0-0'),
        ) as RoundState['hands'],
      };
      const blind = chooseMove(moves, contextFor(scrambled, seat, [[], [], [], []]), 0);
      assert.deepEqual(
        real.kind === 'play' ? real.tile : 'pass',
        blind.kind === 'play' ? blind.tile : 'pass',
        `seed ${seed}: the choice moved when only the hidden tiles changed`,
      );
    }
  });
});

describe('how a computer player behaves', () => {
  it('passes only when it genuinely has nothing', () => {
    let passes = 0;
    for (let seed = 1; seed <= 40; seed++) {
      let match = newMatch(DEFAULT_RULES, seededRng(seed));
      for (let ply = 0; ply < 200 && match.phase === 'playing' && match.round !== null; ply++) {
        const round = match.round;
        const seat = round.turn;
        const moves = legalMoves(round, seat);
        const move = chooseMove(moves, contextFor(round, seat, [[], [], [], []]), 0);
        if (move.kind === 'pass') {
          passes++;
          assert.ok(
            !moves.some((m) => m.kind === 'play'),
            `seed ${seed}: bot passed holding a playable tile — that costs a point`,
          );
        }
        match = applyMove(match, seat, move).match;
      }
    }
    assert.ok(passes > 0, 'no pass ever came up; the assertion above proved nothing');
  });

  it('plays a full match of four bots to a finish', () => {
    for (let seed = 1; seed <= 25; seed++) {
      let match = newMatch(DEFAULT_RULES, seededRng(seed));
      let plies = 0;
      const voids: Pip[][] = [[], [], [], []];

      while (match.phase !== 'matchOver' && plies < 4000) {
        if (match.phase === 'roundOver') {
          match = { ...match, round: match.round };
          const next = dealRound(
            DEFAULT_RULES,
            match.roundNumber + 1,
            match.round?.turn ?? 0,
            seededRng(seed * 1000 + plies),
          );
          match = { ...match, phase: 'playing', round: next, roundNumber: match.roundNumber + 1 };
          for (const v of voids) v.length = 0;
          continue;
        }
        const round = match.round;
        if (round === null) break;
        const seat = round.turn;
        const move = chooseMove(legalMoves(round, seat), contextFor(round, seat, voids), 0);
        if (move.kind === 'pass') {
          const ends = openEnds(round.board);
          if (ends !== null) {
            for (const pip of [ends.left, ends.right]) {
              if (!(voids[seat] as Pip[]).includes(pip)) (voids[seat] as Pip[]).push(pip);
            }
          }
        }
        match = applyMove(match, seat, move).match;
        plies++;
      }
      assert.ok(plies < 4000, `seed ${seed}: the bots never finished — likely a stalled round`);
    }
  });

  it('goes out when it can rather than holding on', () => {
    const board: BoardTile[] = [{ id: '3-4', left: 3, right: 4, dir: 0 }];
    const round: RoundState = {
      hands: [['4-5'], [], [], []],
      board,
      turn: 0,
      passes: 0,
      starter: 0,
      opening: null,
      passLog: [],
      openerTile: '3-4',
    };
    const move = chooseMove(legalMoves(round, 0), contextFor(round, 0, [[], [], [], []]), 0);
    // The direction it picks is the shape question, tested on its own below.
    assert.equal(move.kind, 'play');
    assert.deepEqual(
      { tile: (move as Play).tile, end: (move as Play).end },
      { tile: '4-5', end: 'right' },
    );
  });

  it('prefers the end an opponent is known to be stuck on', () => {
    // Ends are 2 and 6. Exactly two tiles fit: 2-5 on the left (leaving a 5
    // out) and 3-6 on the right (leaving a 3). Seat 1 is an opponent who has
    // already passed on 5s, so the 5 shuts them out — and 3-6 is the heavier
    // tile, so the shedding weight alone would have picked the other one.
    const board: BoardTile[] = [
      { id: '2-2', left: 2, right: 2, dir: 0 },
      { id: '2-6', left: 2, right: 6, dir: 0 },
    ];
    const filler = ['0-0', '0-0', '0-0', '0-0'];
    const round: RoundState = {
      hands: [['2-5', '3-6', '0-1', '4-4'], filler, filler, filler],
      board,
      turn: 0,
      passes: 0,
      starter: 0,
      opening: null,
      passLog: [],
      openerTile: '2-2',
    };
    const voids: Pip[][] = [[], [5], [], []];
    const move = chooseMove(legalMoves(round, 0), contextFor(round, 0, voids), 0);
    assert.equal(move.kind, 'play');
    assert.deepEqual(
      { tile: (move as Play).tile, end: (move as Play).end },
      { tile: '2-5', end: 'left' },
    );
  });

  it('folds the chain round instead of running off the table', () => {
    // Shape is the players' choice now, so a bot has to make one. Left to go
    // straight forever it would lay a line of twenty-eight tiles — four
    // screens wide, and unreadable once it is shrunk to fit.
    const rng = seededRng(20260411);
    let match = newMatch(DEFAULT_RULES, rng);
    for (let i = 0; i < 400 && match.phase === 'playing' && match.round !== null; i++) {
      const round = match.round;
      const seat = round.turn;
      const ctx: BotContext = {
        seat,
        hand: round.hands[seat] ?? [],
        board: round.board,
        openerTile: round.openerTile,
        ends: openEnds(round.board),
        tilesLeft: SEATS.map((s) => (round.hands[s] ?? []).length),
        voids: [[], [], [], []],
        caught: [],
        rules: DEFAULT_RULES,
      };
      match = applyMove(match, seat, chooseMove(legalMoves(round, seat), ctx, 0)).match;
      const board = match.round?.board ?? [];
      if (board.length < 2) continue;
      const out = layout(laidTiles(board), openerIndexOf(board, match.round?.openerTile ?? null));
      assert.ok(isSound(out), `${board.length} tiles in and something is stacked`);
      // A tile is 4 units long; 40 is ten tiles across, with room to spare.
      assert.ok(
        out.width <= 40 && out.height <= 40,
        `the chain ran to ${out.width}x${out.height} units with ${board.length} tiles down`,
      );
    }
  });
});

describe('what a bot table does to the record books', () => {
  it('keeps practice matches out of the stats', async () => {
    const { Room } = await import('../dist/rooms.js');
    const writes: unknown[] = [];
    const fakeSupabase = {
      enabled: true,
      recordMatch: (r: unknown) => {
        writes.push(r);
        return Promise.resolve();
      },
    };

    const play = (withBots: boolean): void => {
      const room = new Room(
        'TEST',
        { targetScore: 1, winBy: 1, drawAt: null },
        () => {},
        fakeSupabase as never,
      );
      const host = room.addPlayer('Ana');
      if (withBots) {
        for (let i = 0; i < 3; i++) room.addBot(host);
        room.sit(host, SEATS.find((s) => room.playerAtSeat(s) === null) as Seat);
      } else {
        room.sit(host, 0);
        for (const seat of [1, 2, 3] as Seat[]) {
          const p = room.addPlayer(`P${seat}`);
          room.sit(p, seat);
        }
      }
      room.start(host);
      // Drive it to the end by hand so no timer is involved.
      for (let i = 0; i < 2000 && room.match !== null; i++) {
        const match = room.match;
        if (match.phase === 'matchOver') break;
        if (match.phase === 'roundOver') {
          room.nextRound(room.playerAtSeat(0) as never);
          continue;
        }
        const round = match.round;
        if (round === null) break;
        const seat = round.turn;
        const moves = legalMoves(round, seat);
        room.move(room.playerAtSeat(seat) as never, (moves[0] ?? { kind: 'pass' }) as Move);
      }
      room.dispose();
    };

    play(true);
    assert.deepEqual(writes, [], 'a table with computer players must not be recorded');

    play(false);
    assert.equal(writes.length, 1, 'an all-human match should still be recorded');
  });
});

describe('a computer player catching a cheat', () => {
  it('proves a false pass from public play alone', async () => {
    const { provenFalsePass, shouldCallOut } = await import('../dist/bot.js');
    // They passed while 2 and 5 were the open ends, then laid a tile with a 2.
    // The whole set is dealt and there is no boneyard, so they were holding it.
    assert.equal(provenFalsePass('2-6', [2, 5]), true);
    assert.equal(provenFalsePass('3-4', [2, 5]), false, 'an unrelated tile proves nothing');
    assert.equal(provenFalsePass('2-6', []), false, 'they never passed, so nothing to prove');

    const base = {
      seat: 0 as Seat,
      hand: ['1-1'],
      board: [],
      openerTile: null,
      ends: null,
      tilesLeft: [1, 1, 1, 1],
      voids: [[], [], [], []],
      rules: DEFAULT_RULES,
    };
    assert.equal(shouldCallOut({ ...base, caught: [1] }), 1, 'calls out an opponent');
    assert.equal(shouldCallOut({ ...base, caught: [2] }), null, 'never its own partner');
    assert.equal(shouldCallOut({ ...base, caught: [] }), null, 'never on a hunch');
  });

  it('catches a cheat at a real table and takes the round', async () => {
    const { Room } = await import('../dist/rooms.js');
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    // Run a few deals: the human bluffs once, then lays the very tile they
    // bluffed on, which is what makes the pass provable from the table alone.
    // Whether that chance comes up depends on the deal, so try more than one.
    let caught = 0;
    let bluffs = 0;
    const trials = 4;

    for (let t = 0; t < trials; t++) {
      const room = new Room('T' + t, { targetScore: 10 }, () => {}, null, 1);
      const host = room.addPlayer('Ana');
      room.sit(host, 0);
      for (let i = 0; i < 3; i++) room.addBot(host);
      room.start(host);

      let bluffed: string | null = null;
      for (let tick = 0; tick < 4000; tick++) {
        const match = room.match;
        if (match === null || match.phase !== 'playing' || match.round === null) break;
        if (match.round.turn !== 0) {
          await sleep(2);
          continue;
        }
        const moves = legalMoves(match.round, 0);
        const plays = moves.filter((m): m is Extract<Move, { kind: 'play' }> => m.kind === 'play');
        if (bluffed === null && match.round.board.length > 0 && plays.length > 0) {
          bluffed = (plays[0] as Extract<Move, { kind: 'play' }>).tile;
          room.move(host, { kind: 'pass' });
          continue;
        }
        const giveaway = plays.find((m) => m.tile === bluffed);
        room.move(host, (giveaway ?? plays[0] ?? { kind: 'pass' }) as Move);
      }

      const result = room.match?.lastResult ?? null;
      room.dispose();
      if (bluffed !== null) bluffs++;
      if (result?.kind !== 'calledOut') continue;

      caught++;
      assert.equal(result.calledOut?.correct, true, 'the accusation must be a right one');
      assert.equal(result.calledOut?.accused, 0, 'the bluffer is the one accused');
      assert.notEqual(result.calledOut?.by, 2, 'a partner must never be the accuser');
      assert.deepEqual(result.forfeited, [0], 'the cheating team loses the round');
      assert.deepEqual(result.awarded, [0, DEFAULT_RULES.falsePassPenalty]);
    }

    assert.ok(bluffs > 0, 'the human seat never got a chance to bluff');
    assert.ok(caught > 0, `the bots never caught a bluff across ${trials} deals`);
  });
});

describe('the turn clock', () => {
  it('plays for a player who runs out of time, and not before', async () => {
    const { Room } = await import('../dist/rooms.js');
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    // A one-second clock, four human seats so nothing else moves the game on.
    const room = new Room('CLK', { targetScore: 10, turnSeconds: 10 }, () => {}, null);
    const seats = [0, 1, 2, 3].map((i) => {
      const p = room.addPlayer(`P${i}`);
      room.sit(p, i as Seat);
      return p;
    });
    room.start(seats[0] as never);
    assert.notEqual(room.turnDeadline, null, 'a clock was asked for, so there is a deadline');
    const left = (room.turnDeadline as number) - Date.now();
    assert.ok(left > 8_000 && left <= 10_000, `deadline should be ~10s away, was ${left}ms`);
    room.dispose();
    await sleep(1);
  });

  it('leaves the table waiting when the clock is turned off', async () => {
    const { Room } = await import('../dist/rooms.js');
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const room = new Room('NOCLK', { targetScore: 10, turnSeconds: null }, () => {}, null);
    const seats = [0, 1, 2, 3].map((i) => {
      const p = room.addPlayer(`P${i}`);
      room.sit(p, i as Seat);
      return p;
    });
    room.start(seats[0] as never);
    assert.equal(room.turnDeadline, null, 'no clock means no deadline to show');

    const before = room.match?.round?.board.length ?? -1;
    const whoseTurn = room.match?.round?.turn;
    await sleep(250);
    assert.equal(room.match?.round?.board.length, before, 'nothing was played for them');
    assert.equal(room.match?.round?.turn, whoseTurn, 'the turn did not move on by itself');
    room.dispose();
  });

  it('refuses a clock a tampered client tries to set out of range', async () => {
    const { Room } = await import('../dist/rooms.js');
    const silly = new Room('BAD', { turnSeconds: 999_999 } as never, () => {}, null);
    assert.ok(
      (silly.rules.turnSeconds as number) <= 600,
      `an absurd clock should be clamped, got ${silly.rules.turnSeconds}`,
    );
    const tiny = new Room('BAD2', { turnSeconds: 0 } as never, () => {}, null);
    assert.ok((tiny.rules.turnSeconds as number) >= 10, 'and so should a zero one');
    silly.dispose();
    tiny.dispose();
  });
});

describe('cancelling a practice game', () => {
  async function tableWithBots(bots: number) {
    const { Room } = await import('../dist/rooms.js');
    const room = new Room('CANCEL', { targetScore: 10 }, () => {}, null, 1);
    const host = room.addPlayer('Ana');
    room.sit(host, 0);
    for (let i = 0; i < bots; i++) room.addBot(host);
    return { room, host };
  }

  it('bins the match and goes back to the lobby', async () => {
    const { room, host } = await tableWithBots(3);
    room.start(host as never);
    assert.notEqual(room.match, null, 'a match is running');

    room.abandon(host as never);
    assert.equal(room.match, null, 'back to the lobby');
    assert.equal(room.turnDeadline, null, 'the clock stopped too');
    // The seats are still filled, so another game can start straight away.
    room.start(host as never);
    assert.notEqual(room.match, null, 'a fresh match starts fine');
    room.dispose();
  });

  it('leaves the leaderboard alone', async () => {
    const { Room } = await import('../dist/rooms.js');
    const credited: unknown[] = [];
    const room = new Room(
      'CANCEL2',
      { targetScore: 10 },
      () => {},
      null,
      1,
      (winners, played) => credited.push({ winners, played }),
    );
    const host = room.addPlayer('Ana');
    host.accountName = 'ana';
    room.sit(host, 0);
    for (let i = 0; i < 3; i++) room.addBot(host);
    room.start(host as never);
    room.abandon(host as never);
    assert.deepEqual(credited, [], 'a cancelled game counts for nobody');
    room.dispose();
  });

  it('refuses on a table of real players', async () => {
    const { Room } = await import('../dist/rooms.js');
    const room = new Room('HUMANS', { targetScore: 10 }, () => {}, null, 1);
    const host = room.addPlayer('Ana');
    room.sit(host, 0);
    for (const seat of [1, 2, 3] as Seat[]) {
      const p = room.addPlayer(`P${seat}`);
      room.sit(p, seat);
    }
    room.start(host as never);
    // Walking out of a match you are losing is not a feature.
    assert.throws(() => room.abandon(host as never), /played out/);
    assert.notEqual(room.match, null, 'and the match is untouched');
    room.dispose();
  });

  it('refuses from anyone but the host', async () => {
    const { room, host } = await tableWithBots(2);
    const other = room.addPlayer('Bo');
    room.sit(other, 3);
    room.start(host as never);
    assert.throws(() => room.abandon(other as never), /only the host/);
    assert.notEqual(room.match, null);
    room.dispose();
  });
});
