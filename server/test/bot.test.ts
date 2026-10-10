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
  legalMoves,
  newMatch,
  openEnds,
  seededRng,
} from '@domino/shared';
import { type BotContext, chooseMove } from '../dist/bot.js';

/** Build a bot's context the way the room does: own hand plus public state. */
function contextFor(round: RoundState, seat: Seat, voids: Pip[][]): BotContext {
  return {
    seat,
    hand: round.hands[seat] ?? [],
    board: round.board,
    ends: openEnds(round.board),
    tilesLeft: SEATS.map((s) => (round.hands[s] ?? []).length),
    voids: voids.map((v) => [...v]),
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
    const board: BoardTile[] = [{ id: '3-4', left: 3, right: 4 }];
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
    assert.deepEqual(move, { kind: 'play', tile: '4-5', end: 'right' } satisfies Move);
  });

  it('prefers the end an opponent is known to be stuck on', () => {
    // Ends are 2 and 6. Exactly two tiles fit: 2-5 on the left (leaving a 5
    // out) and 3-6 on the right (leaving a 3). Seat 1 is an opponent who has
    // already passed on 5s, so the 5 shuts them out — and 3-6 is the heavier
    // tile, so the shedding weight alone would have picked the other one.
    const board: BoardTile[] = [
      { id: '2-2', left: 2, right: 2 },
      { id: '2-6', left: 2, right: 6 },
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
    assert.deepEqual(move, { kind: 'play', tile: '2-5', end: 'left' } satisfies Move);
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
