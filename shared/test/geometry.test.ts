/**
 * Where the tiles sit.
 *
 * The shape is now the players' doing, which means the geometry has to hold
 * up under choices nobody anticipated — including deliberately awkward ones.
 * These tests play boards out picking directions at random and check the two
 * things that must never happen: a tile on top of another, and pips that do
 * not match where two tiles touch.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type Dir,
  type LaidTile,
  DEFAULT_RULES,
  applyMove,
  directionsAt,
  isDouble,
  isSound,
  laidTiles,
  layout,
  legalMoves,
  newMatch,
  openEnds,
  openerIndexOf,
  outwardDir,
  overlaps,
  placeTile,
  seededRng,
} from '../dist/index.js';

describe('laying out a chain', () => {
  it('puts the opener down and grows both ways from it', () => {
    let board = placeTile([], '3-3', 'right');
    board = placeTile(board, '3-4', 'right', 0, '3-3');
    board = placeTile(board, '1-3', 'left', 2, '3-3');
    const out = layout(laidTiles(board), 1);

    assert.equal(out.placements.length, 3);
    assert.ok(isSound(out), 'nothing is stacked');
    // The left-hand tile really is to the left of the right-hand one.
    const [left, , right] = out.placements;
    assert.ok(left!.x < right!.x, `${left!.x} should be left of ${right!.x}`);
  });

  it('stands a double across its run and lies an ordinary tile along it', () => {
    const board = placeTile([], '3-3', 'right');
    const [双] = layout(laidTiles(board), 0).placements;
    assert.ok(双!.h > 双!.w, 'a double in a rightward run stands upright');

    const plain = layout([{ id: '3-4', dir: 0 }], 0).placements[0];
    assert.ok(plain!.w > plain!.h, 'an ordinary tile lies flat along the run');
  });

  it('knows which way each end is growing', () => {
    const one = laidTiles(placeTile([], '2-4', 'right'));
    assert.equal(outwardDir(one, 0, 'right'), 0, 'rightward from the opener');
    assert.equal(outwardDir(one, 0, 'left'), 2, 'and leftward the other way');
  });

  it('never offers a direction that would land on another tile', () => {
    // Curl the chain round on itself as tightly as the rules allow, then
    // check every direction still on offer really is free.
    let board = placeTile([], '0-1', 'right');
    const run: [string, Dir][] = [
      ['1-2', 0],
      ['2-3', 1],
      ['3-4', 2],
      ['4-5', 3],
      ['5-6', 0],
    ];
    for (const [id, dir] of run) {
      const allowed = directionsAt(laidTiles(board), 0, id, 'right');
      if (!allowed.includes(dir)) continue;
      board = placeTile(board, id, 'right', dir, '0-1');
      assert.ok(isSound(layout(laidTiles(board), 0)), `placing ${id} broke the board`);
    }

    for (const end of ['left', 'right'] as const) {
      for (const dir of directionsAt(laidTiles(board), 0, '6-6', end)) {
        const next: LaidTile[] =
          end === 'right'
            ? [...laidTiles(board), { id: '6-6', dir }]
            : [{ id: '6-6', dir }, ...laidTiles(board)];
        const opener = end === 'right' ? 0 : 1;
        assert.ok(
          isSound(layout(next, opener)),
          `direction ${dir} at the ${end} end was offered but collides`,
        );
      }
    }
  });

  it('never lets the chain double straight back on itself', () => {
    const board = placeTile([], '0-1', 'right');
    const allowed = directionsAt(laidTiles(board), 0, '1-2', 'right');
    assert.ok(!allowed.includes(2), 'going back left from a rightward end is not a direction');
  });

  it('never lets a double turn a corner', () => {
    // A double lies across the line rather than along it, so it has no end
    // to turn with. Let it and it comes to rest flat against its neighbour,
    // long edge to long edge, with the halves that are meant to match never
    // touching — which is what a real set cannot do.
    let board = placeTile([], '6-6', 'right');
    board = placeTile(board, '2-6', 'left', undefined, '6-6');
    const tiles = laidTiles(board);
    const opener = openerIndexOf(board, '6-6');

    assert.deepEqual(
      directionsAt(tiles, opener, '2-2', 'left'),
      [outwardDir(tiles, opener, 'left')],
      'a double may only carry straight on',
    );
    assert.ok(
      directionsAt(tiles, opener, '2-5', 'left').length > 1,
      'an ordinary tile may still turn a corner',
    );

    // And the table ignores a direction it does not allow, so a client that
    // asks for one anyway still gets a sound board.
    const laid = placeTile(board, '2-2', 'left', 1, '6-6');
    assert.equal(laid[0]?.dir, outwardDir(tiles, opener, 'left'), 'laid straight on anyway');
  });

  it('refuses a corner on the tile straight after a double', () => {
    // The double lies crosswise already; turning there folds through it.
    const board = placeTile([], '3-3', 'right');
    assert.deepEqual(
      directionsAt(laidTiles(board), 0, '3-5', 'right'),
      [0],
      'only straight on is available after a double',
    );
  });
});

describe('boards played out with the shape chosen at random', () => {
  /** Play a whole round, picking a direction at random each time. */
  function playOut(seed: number): { board: readonly { id: string; dir: Dir }[]; opener: number } {
    const rng = seededRng(seed);
    let match = newMatch(DEFAULT_RULES, rng);
    for (let i = 0; i < 300 && match.phase === 'playing' && match.round !== null; i++) {
      const round = match.round;
      const seat = round.turn;
      const moves = legalMoves(round, seat);
      const plays = moves.filter((m) => m.kind === 'play');
      if (plays.length === 0) {
        match = applyMove(match, seat, { kind: 'pass' }).match;
        continue;
      }
      const pick = plays[Math.floor(rng() * plays.length)] as Extract<
        (typeof plays)[number],
        { kind: 'play' }
      >;
      const openerAt =
        round.openerTile === null
          ? 0
          : Math.max(0, round.board.findIndex((t) => t.id === round.openerTile));
      const dirs = directionsAt(laidTiles(round.board), openerAt, pick.tile, pick.end);
      const dir = dirs[Math.floor(rng() * dirs.length)];
      match = applyMove(match, seat, { ...pick, ...(dir === undefined ? {} : { dir }) }).match;
    }
    const round = match.round;
    const board = (round?.board ?? []).map((t) => ({ id: t.id, dir: t.dir }));
    const opener =
      round?.openerTile == null
        ? 0
        : Math.max(0, board.findIndex((t) => t.id === round.openerTile));
    return { board, opener };
  }

  it('never stacks one tile on another, over many played-out boards', () => {
    let longest = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const { board, opener } = playOut(seed);
      if (board.length < 2) continue;
      longest = Math.max(longest, board.length);
      const out = layout(board, opener);
      for (let i = 0; i < out.placements.length; i++) {
        for (let j = i + 1; j < out.placements.length; j++) {
          const a = out.placements[i]!;
          const b = out.placements[j]!;
          assert.ok(
            !overlaps(a, b),
            `seed ${seed}: ${a.id} and ${b.id} overlap at (${a.x},${a.y}) and (${b.x},${b.y})`,
          );
        }
      }
    }
    assert.ok(longest >= 10, `boards should get long enough to be worth checking, got ${longest}`);
  });

  it('keeps touching tiles adjacent, with no gap in the chain', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const { board, opener } = playOut(seed);
      if (board.length < 3) continue;
      const out = layout(board, opener);
      for (let i = 0; i + 1 < out.placements.length; i++) {
        const a = out.placements[i]!;
        const b = out.placements[i + 1]!;
        const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
        const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
        assert.equal(
          Math.max(gapX, gapY),
          0,
          `seed ${seed}: ${a.id} and ${b.id} are not touching`,
        );
      }
    }
  });

  it('always lays a double across the line, whatever shape was chosen', () => {
    // Across the line means at right angles to both its neighbours, every
    // time. Two in a row lying the same way is a double laid alongside its
    // neighbour instead of meeting it.
    let pairs = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const { board, opener } = playOut(seed);
      if (board.length < 2) continue;
      const out = layout(board, opener);
      for (let i = 0; i + 1 < out.placements.length; i++) {
        const a = out.placements[i] as (typeof out.placements)[number];
        const b = out.placements[i + 1] as (typeof out.placements)[number];
        if (!isDouble(a.id) && !isDouble(b.id)) continue;
        pairs++;
        assert.notEqual(
          a.w > a.h,
          b.w > b.h,
          `seed ${seed}: ${a.id} and ${b.id} lie the same way round`,
        );
      }
    }
    assert.ok(pairs > 200, `too few pairs to have proved anything: ${pairs}`);
  });

  it('keeps the matching pips together however the shape was chosen', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rng = seededRng(seed * 7919);
      let match = newMatch(DEFAULT_RULES, rng);
      for (let i = 0; i < 300 && match.phase === 'playing' && match.round !== null; i++) {
        const round = match.round;
        const seat = round.turn;
        const plays = legalMoves(round, seat).filter((m) => m.kind === 'play');
        if (plays.length === 0) {
          match = applyMove(match, seat, { kind: 'pass' }).match;
          continue;
        }
        const pick = plays[Math.floor(rng() * plays.length)] as {
          kind: 'play';
          tile: string;
          end: 'left' | 'right';
        };
        match = applyMove(match, seat, pick).match;

        // The chain is only ever sound if each tile's right pip equals the
        // next tile's left pip. That is what "the pips match" means.
        const board = match.round?.board ?? [];
        for (let k = 0; k + 1 < board.length; k++) {
          assert.equal(
            board[k]!.right,
            board[k + 1]!.left,
            `seed ${seed}: ${board[k]!.id} does not meet ${board[k + 1]!.id}`,
          );
        }
        const ends = openEnds(board);
        if (ends !== null && board.length > 0) {
          assert.equal(ends.left, board[0]!.left);
          assert.equal(ends.right, board[board.length - 1]!.right);
        }
      }
    }
  });
});
