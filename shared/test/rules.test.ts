import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BoardTile,
  type HouseRules,
  type MatchState,
  type Move,
  type RoundState,
  type Seat,
  DEFAULT_RULES,
  RuleError,
  SEATS,
  applyMove,
  dealRound,
  fullSet,
  handPips,
  legalMoves,
  newMatch,
  openEnds,
  parseTile,
  placeTile,
  seededRng,
  startNextRound,
  teamOf,
  tilePips,
} from '../dist/index.js';

const rules = (over: Partial<HouseRules> = {}): HouseRules => ({ ...DEFAULT_RULES, ...over });

function round(over: Partial<RoundState> = {}): RoundState {
  return {
    hands: [[], [], [], []],
    board: [],
    turn: 0,
    passes: 0,
    starter: 0,
    requireTile: null,
    ...over,
  };
}

function match(r: RoundState, over: Partial<MatchState> = {}): MatchState {
  return {
    rules: DEFAULT_RULES,
    scores: [0, 0],
    roundNumber: 2,
    round: r,
    phase: 'playing',
    lastResult: null,
    winner: null,
    ...over,
  };
}

/** board[i].right must always equal board[i+1].left. */
function assertChain(board: readonly BoardTile[]): void {
  for (let i = 0; i + 1 < board.length; i++) {
    const a = board[i]!;
    const b = board[i + 1]!;
    assert.equal(a.right, b.left, `chain broken between ${a.id} and ${b.id}`);
  }
  // Every laid tile must still be the tile it claims to be.
  for (const placed of board) {
    const t = parseTile(placed.id);
    const laid = [placed.left, placed.right].sort((x, y) => x - y);
    assert.deepEqual(laid, [t.low, t.high], `tile ${placed.id} laid as ${placed.left}|${placed.right}`);
  }
}

describe('the tile set', () => {
  it('is 28 unique double-six tiles totalling 168 pips', () => {
    const set = fullSet();
    assert.equal(set.length, 28);
    assert.equal(new Set(set).size, 28);
    assert.equal(handPips(set), 168);
  });

  it('counts pips per tile', () => {
    assert.equal(tilePips('0-0'), 0);
    assert.equal(tilePips('6-6'), 12);
    assert.equal(tilePips('2-5'), 7);
  });
});

describe('dealing', () => {
  it('deals all 28 tiles into four hands of seven with no duplicates', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = dealRound(rules(), 1, null, seededRng(seed));
      const all = r.hands.flat();
      assert.equal(all.length, 28);
      assert.equal(new Set(all).size, 28, 'a tile was dealt twice');
      for (const seat of SEATS) assert.equal(r.hands[seat]!.length, 7);
      assert.deepEqual([...all].sort(), fullSet().sort());
    }
  });

  it('opens the first round with whoever holds the 6-6', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = dealRound(rules(), 1, null, seededRng(seed));
      assert.equal(r.requireTile, '6-6');
      assert.ok(r.hands[r.turn]!.includes('6-6'), 'opener does not hold the 6-6');
    }
  });

  it('lets the previous winner open later rounds with any tile', () => {
    const r = dealRound(rules(), 3, 2, seededRng(7));
    assert.equal(r.turn, 2);
    assert.equal(r.requireTile, null);
    assert.equal(legalMoves(r, 2).length, 7, 'every tile should be a legal opener');
  });

  it('honours the house rule that drops the forced 6-6 opening', () => {
    const r = dealRound(rules({ mustOpenDoubleSix: false }), 1, 3, seededRng(4));
    assert.equal(r.requireTile, null);
    assert.equal(r.turn, 3);
  });
});

describe('seating and teams', () => {
  it('pairs seats across the table', () => {
    assert.equal(teamOf(0), teamOf(2));
    assert.equal(teamOf(1), teamOf(3));
    assert.notEqual(teamOf(0), teamOf(1));
  });
});

describe('placing tiles', () => {
  it('flips a tile so the matching pip faces the board', () => {
    const one = placeTile([], '2-4', 'right');
    assert.deepEqual(one, [{ id: '2-4', left: 2, right: 4 }]);

    // Right end is 4, so 4-6 must be laid 4|6.
    const right = placeTile(one, '4-6', 'right');
    assert.deepEqual(right[right.length - 1], { id: '4-6', left: 4, right: 6 });

    // Left end is 2, so 0-2 must be laid 0|2 with the 2 facing inward.
    const left = placeTile(one, '0-2', 'left');
    assert.deepEqual(left[0], { id: '0-2', left: 0, right: 2 });
    assertChain(left);
  });

  it('refuses a tile that does not match the chosen end', () => {
    const board = placeTile([], '2-4', 'right');
    assert.throws(() => placeTile(board, '5-6', 'left'), /does not match/);
    assert.throws(() => placeTile(board, '5-6', 'right'), /does not match/);
  });

  it('reports the open ends', () => {
    assert.equal(openEnds([]), null);
    const board = placeTile(placeTile([], '2-4', 'right'), '4-6', 'right');
    assert.deepEqual(openEnds(board), { left: 2, right: 6 });
  });
});

describe('legal moves', () => {
  it('offers only the 6-6 on the opening move of a match', () => {
    const r = round({ hands: [['6-6', '0-1', '3-4'], [], [], []], requireTile: '6-6' });
    const moves = legalMoves(r, 0);
    assert.equal(moves.length, 1);
    assert.deepEqual(moves[0], { kind: 'play', tile: '6-6', end: 'right' });
  });

  it('gives nothing to a player who is not on turn', () => {
    const r = round({ hands: [['0-1'], ['0-2'], [], []], turn: 0 });
    assert.deepEqual(legalMoves(r, 1), []);
  });

  it('offers both ends when a tile fits both', () => {
    const board = placeTile(placeTile([], '2-4', 'right'), '4-5', 'right');
    const r = round({ hands: [['2-5'], [], [], []], board });
    const moves = legalMoves(r, 0);
    assert.equal(moves.length, 2);
    assert.ok(moves.some((m) => m.kind === 'play' && m.end === 'left'));
    assert.ok(moves.some((m) => m.kind === 'play' && m.end === 'right'));
  });

  it('offers a pass only when nothing in hand fits', () => {
    const board = placeTile([], '0-0', 'right');
    const stuck = round({ hands: [['1-2', '3-4'], [], [], []], board });
    assert.deepEqual(legalMoves(stuck, 0), [{ kind: 'pass' }]);

    const playable = round({ hands: [['0-5'], [], [], []], board });
    assert.ok(legalMoves(playable, 0).every((m) => m.kind === 'play'));
  });
});

describe('making moves', () => {
  it('rejects a move out of turn', () => {
    const m = match(round({ hands: [['0-1'], ['0-2'], [], []], turn: 0 }));
    assert.throws(() => applyMove(m, 1, { kind: 'play', tile: '0-2', end: 'right' }), RuleError);
  });

  it('refuses to let a player pass when they can play', () => {
    const board = placeTile([], '0-0', 'right');
    const m = match(round({ hands: [['0-5'], ['1-2'], ['1-3'], ['2-3']], board }));
    assert.throws(
      () => applyMove(m, 0, { kind: 'pass' }),
      /must play/,
      'passing with a playable tile should be rejected',
    );
  });

  it('refuses a tile the player does not hold', () => {
    const board = placeTile([], '0-0', 'right');
    const m = match(round({ hands: [['0-5'], ['0-6'], [], []], board }));
    assert.throws(() => applyMove(m, 0, { kind: 'play', tile: '0-6', end: 'right' }), RuleError);
  });

  it('advances the turn around the table', () => {
    const board = placeTile([], '0-0', 'right');
    const m = match(round({ hands: [['0-5', '1-1'], ['0-6', '2-2'], ['0-4', '3-3'], ['0-3', '4-4']], board }));
    const after = applyMove(m, 0, { kind: 'play', tile: '0-5', end: 'right' });
    assert.equal(after.match.round!.turn, 1);
  });

  it('removes the played tile from the hand and leaves others alone', () => {
    const board = placeTile([], '0-0', 'right');
    const m = match(round({ hands: [['0-5', '1-1'], ['0-6'], ['0-4'], ['0-3']], board }));
    const after = applyMove(m, 0, { kind: 'play', tile: '0-5', end: 'right' });
    assert.deepEqual(after.match.round!.hands[0], ['1-1']);
    assert.deepEqual(after.match.round!.hands[1], ['0-6']);
  });

  it('clears the forced opening tile after it is played', () => {
    const m = match(
      round({ hands: [['6-6', '0-1'], ['1-2'], ['2-3'], ['3-4']], requireTile: '6-6' }),
      { roundNumber: 1 },
    );
    const after = applyMove(m, 0, { kind: 'play', tile: '6-6', end: 'right' });
    assert.equal(after.match.round!.requireTile, null);
  });
});

describe('scoring a round', () => {
  it('awards the opponents pips when a player goes out', () => {
    const board = placeTile([], '3-3', 'right');
    const m = match(round({ hands: [['3-5'], ['6-6'], ['0-1'], ['4-4']], board }));
    const out = applyMove(m, 0, { kind: 'play', tile: '3-5', end: 'right' });

    assert.ok(out.result);
    assert.equal(out.result!.kind, 'domino');
    assert.equal(out.result!.dominoedBy, 0);
    assert.equal(out.result!.winningTeam, 0);
    // Opponents hold 6-6 (12) and 4-4 (8); the partner's 0-1 is not counted.
    assert.equal(out.result!.points, 20);
    assert.deepEqual(out.match.scores, [20, 0]);
    assert.equal(out.match.phase, 'roundOver');
  });

  it('counts every unplayed tile under the all-remaining house rule', () => {
    const board = placeTile([], '3-3', 'right');
    const m = match(round({ hands: [['3-5'], ['6-6'], ['0-1'], ['4-4']], board }), {
      rules: rules({ countAllRemaining: true }),
    });
    const out = applyMove(m, 0, { kind: 'play', tile: '3-5', end: 'right' });
    assert.equal(out.result!.points, 21, '12 + 8 + the partner’s 1');
  });

  it('decides a blocked round on team pips', () => {
    const board = placeTile([], '0-0', 'right');
    // Nobody holds a blank, so every seat must pass.
    const m = match(round({ hands: [['1-2'], ['3-4'], ['5-6'], ['1-3']], board, turn: 0 }));

    let state = m;
    let result = null;
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const out = applyMove(state, seat, { kind: 'pass' });
      state = out.match;
      result = out.result ?? result;
    }

    assert.ok(result, 'four passes should end the round');
    assert.equal(result!.kind, 'blocked');
    // Team A: 1-2 + 5-6 = 14. Team B: 3-4 + 1-3 = 11. Team B is lower.
    assert.equal(result!.winningTeam, 1);
    assert.equal(result!.points, 14);
    assert.deepEqual(state.scores, [0, 14]);
  });

  it('ends a blocked round as soon as no one can move', () => {
    // Seat 0 plays the last blank; after it nobody has a 1 or a 6.
    const board = placeTile([], '1-1', 'right');
    const m = match(round({ hands: [['1-6', '2-2'], ['3-4'], ['5-5'], ['2-3']], board, turn: 0 }));
    const out = applyMove(m, 0, { kind: 'play', tile: '1-6', end: 'right' });
    assert.ok(out.result, 'the round should end without four explicit passes');
    assert.equal(out.result!.kind, 'blocked');
  });

  it('scores nothing when a blocked round is level', () => {
    const board = placeTile([], '0-0', 'right');
    // Team A: 1-2 (3) + 3-4 (7) = 10. Team B: 1-3 (4) + 2-4 (6) = 10.
    const m = match(round({ hands: [['1-2'], ['1-3'], ['3-4'], ['2-4']], board, turn: 0 }));
    let state = m;
    let result = null;
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const out = applyMove(state, seat, { kind: 'pass' });
      state = out.match;
      result = out.result ?? result;
    }
    assert.equal(result!.kind, 'tie');
    assert.equal(result!.winningTeam, null);
    assert.equal(result!.points, 0);
    assert.deepEqual(state.scores, [0, 0]);
  });

  it('pays the capicu bonus only when it is switched on', () => {
    const board = placeTile(placeTile([], '2-4', 'right'), '4-5', 'right');
    const hands = [['2-5'], ['6-6'], ['0-1'], ['1-1']];

    const off = applyMove(match(round({ hands, board })), 0, {
      kind: 'play',
      tile: '2-5',
      end: 'left',
    });
    assert.equal(off.result!.capicu, false);
    assert.equal(off.result!.points, 14, '6-6 plus 1-1');

    const on = applyMove(
      match(round({ hands, board }), { rules: rules({ capicuBonus: 25 }) }),
      0,
      { kind: 'play', tile: '2-5', end: 'left' },
    );
    assert.equal(on.result!.capicu, true);
    assert.equal(on.result!.points, 39, '14 plus the 25 bonus');
  });

  it('does not pay capicu for a tile that only matched one end', () => {
    const board = placeTile(placeTile([], '2-4', 'right'), '4-5', 'right');
    const out = applyMove(
      match(round({ hands: [['5-6'], ['6-6'], ['0-1'], ['1-1']], board }), {
        rules: rules({ capicuBonus: 25 }),
      }),
      0,
      { kind: 'play', tile: '5-6', end: 'right' },
    );
    assert.equal(out.result!.capicu, false);
    assert.equal(out.result!.points, 14);
  });
});

describe('match flow', () => {
  it('ends the match when a team reaches the target', () => {
    const board = placeTile([], '3-3', 'right');
    const m = match(round({ hands: [['3-5'], ['6-6'], ['0-1'], ['4-4']], board }), {
      rules: rules({ targetScore: 20 }),
      scores: [0, 0],
    });
    const out = applyMove(m, 0, { kind: 'play', tile: '3-5', end: 'right' });
    assert.equal(out.match.phase, 'matchOver');
    assert.equal(out.match.winner, 0);
    assert.throws(() => startNextRound(out.match, seededRng(1)), RuleError);
  });

  it('hands the next lead to whoever went out', () => {
    const board = placeTile([], '3-3', 'right');
    const m = match(round({ hands: [['0-1'], ['3-5'], ['2-2'], ['4-4']], board, turn: 1 }));
    const out = applyMove(m, 1, { kind: 'play', tile: '3-5', end: 'right' });
    assert.equal(out.result!.nextStarter, 1);
    const next = startNextRound(out.match, seededRng(3));
    assert.equal(next.round!.turn, 1);
    assert.equal(next.roundNumber, 3);
  });

  it('gives a blocked round’s lead to the lighter hand on the winning team', () => {
    const board = placeTile([], '0-0', 'right');
    // Team B wins; seat 3 holds 1-3 (4) against seat 1's 3-4 (7).
    const m = match(round({ hands: [['1-2'], ['3-4'], ['5-6'], ['1-3']], board, turn: 0 }));
    let state = m;
    let result = null;
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const out = applyMove(state, seat, { kind: 'pass' });
      state = out.match;
      result = out.result ?? result;
    }
    assert.equal(result!.winningTeam, 1);
    assert.equal(result!.nextStarter, 3);
  });

  it('refuses to deal the next round while one is in progress', () => {
    const m = newMatch(rules(), seededRng(11));
    assert.throws(() => startNextRound(m, seededRng(12)), RuleError);
  });
});

describe('full simulated matches', () => {
  /** Pick a legal move pseudo-randomly, so games explore odd states. */
  function pick(moves: readonly Move[], rng: () => number): Move {
    return moves[Math.floor(rng() * moves.length)] ?? { kind: 'pass' };
  }

  it('plays many matches to completion without breaking an invariant', () => {
    let dominoes = 0;
    let blocks = 0;
    let ties = 0;

    for (let seed = 1; seed <= 200; seed++) {
      const rng = seededRng(seed);
      let state = newMatch(rules({ targetScore: 100, capicuBonus: 25 }), rng);
      let moves = 0;

      while (state.phase !== 'matchOver') {
        if (state.phase === 'roundOver') {
          const kind = state.lastResult!.kind;
          if (kind === 'domino') dominoes++;
          else if (kind === 'blocked') blocks++;
          else ties++;
          state = startNextRound(state, rng);
          continue;
        }

        const r = state.round!;
        const seat = r.turn;
        const legal = legalMoves(r, seat);
        assert.ok(legal.length > 0, `seat ${seat} had no legal move at all`);

        // Tiles are conserved: nothing is created, duplicated or lost.
        const inPlay = [...r.hands.flat(), ...r.board.map((b) => b.id)];
        assert.equal(inPlay.length, 28, 'a tile went missing');
        assert.equal(new Set(inPlay).size, 28, 'a tile was duplicated');
        assertChain(r.board);

        const out = applyMove(state, seat, pick(legal, rng));
        state = out.match;

        assert.ok(++moves < 5000, 'match failed to terminate');
      }

      const final = state.lastResult!;
      if (final.kind === 'domino') dominoes++;
      else if (final.kind === 'blocked') blocks++;
      else ties++;

      assert.ok(state.winner !== null, 'a finished match must have a winner');
      assert.ok(
        state.scores[state.winner] >= 100,
        'the winner must actually have reached the target',
      );
      assertChain(state.round!.board);
    }

    // Both endings should show up across 200 matches; this guards against a
    // regression that makes one of them unreachable.
    assert.ok(dominoes > 0, 'no round ever ended by going out');
    assert.ok(blocks > 0, 'no round ever ended blocked');
    assert.ok(dominoes + blocks + ties > 200);
  });
});
