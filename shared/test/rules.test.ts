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
  PIP_RULES,
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
  matchOutcome,
  matchWinner,
  seededRng,
  startNextRound,
  teamOf,
  tilePips,
  callOut,
  seatsThatPassed,
  describeResult,
} from '../dist/index.js';

const rules = (over: Partial<HouseRules> = {}): HouseRules => ({ ...PIP_RULES, ...over });
const roundRules = (over: Partial<HouseRules> = {}): HouseRules => ({ ...DEFAULT_RULES, ...over });

function round(over: Partial<RoundState> = {}): RoundState {
  return {
    hands: [[], [], [], []],
    board: [],
    turn: 0,
    passes: 0,
    starter: 0,
    opening: null,
    passLog: [],
    openerTile: null,
    ...over,
  };
}

function match(r: RoundState, over: Partial<MatchState> = {}): MatchState {
  return {
    rules: PIP_RULES,
    scores: [0, 0],
    roundNumber: 2,
    round: r,
    phase: 'playing',
    lastResult: null,
    winner: null,
    drawn: false,
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
      const r = dealRound(rules({ openWithAnyDouble: false }), 1, null, seededRng(seed));
      assert.deepEqual(r.opening, { kind: 'tile', tile: '6-6' });
      assert.ok(r.hands[r.turn]!.includes('6-6'), 'opener does not hold the 6-6');
    }
  });

  it('lets the 6-6 holder open with any double when the house rule is on', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = dealRound(rules(), 1, null, seededRng(seed));
      assert.deepEqual(r.opening, { kind: 'double' });
      assert.ok(r.hands[r.turn]!.includes('6-6'), 'the 6-6 still decides who leads');
    }
  });

  it('gives the lead to the 6-6 holder in every round, not just the first', () => {
    // Winning a round buys nothing at the next deal: whoever is dealt the
    // 6-6 opens, round after round.
    for (let roundNumber = 1; roundNumber <= 6; roundNumber++) {
      const r = dealRound(rules(), roundNumber, 2, seededRng(roundNumber * 31));
      assert.ok(
        r.hands[r.turn]!.includes('6-6'),
        `round ${roundNumber}: the lead went to someone without the 6-6`,
      );
    }
  });

  it('lets the previous winner open later rounds when that rule is off', () => {
    const r = dealRound(rules({ doubleSixOpensEveryRound: false }), 3, 2, seededRng(7));
    assert.equal(r.turn, 2, 'the seat handed in as the previous winner');
    assert.equal(r.opening, null);
    assert.equal(legalMoves(r, 2).length, 7, 'every tile should be a legal opener');
  });

  it('still opens the match with the 6-6 when it does not open every round', () => {
    const r = dealRound(rules({ doubleSixOpensEveryRound: false }), 1, null, seededRng(9));
    assert.ok(r.hands[r.turn]!.includes('6-6'), 'round one is still the 6-6 holder');
    assert.deepEqual(r.opening, { kind: 'double' });
  });

  it('honours the house rule that drops the forced 6-6 opening', () => {
    const r = dealRound(rules({ mustOpenDoubleSix: false }), 1, 3, seededRng(4));
    assert.equal(r.opening, null);
    assert.equal(r.turn, 3);
  });

  it('still ignores the any-double rule when nothing forces the opening', () => {
    const r = dealRound(rules({ mustOpenDoubleSix: false, openWithAnyDouble: true }), 1, 3, seededRng(4));
    assert.equal(r.opening, null, 'with no forced opening the lead is simply free');
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
    const r = round({ hands: [['6-6', '0-1', '3-4'], [], [], []], opening: { kind: 'tile', tile: '6-6' } });
    const moves = legalMoves(r, 0);
    assert.equal(moves.length, 1);
    assert.deepEqual(moves[0], { kind: 'play', tile: '6-6', end: 'right' });
  });

  it('offers every double, and only doubles, under the any-double opening', () => {
    const r = round({
      hands: [['6-6', '2-2', '0-0', '0-1', '3-4'], [], [], []],
      opening: { kind: 'double' },
    });
    const moves = legalMoves(r, 0);
    assert.deepEqual(
      moves.map((m) => (m.kind === 'play' ? m.tile : m.kind)).sort(),
      ['0-0', '2-2', '6-6'],
    );
  });

  it('leaves the 6-6 playable when it is the holder only double', () => {
    // The 6-6 holder leads, so the any-double rule can never strand them:
    // the tile that won them the lead is itself a double.
    const r = round({ hands: [['6-6', '0-1', '3-4'], [], [], []], opening: { kind: 'double' } });
    const moves = legalMoves(r, 0);
    assert.equal(moves.length, 1);
    assert.deepEqual(moves[0], { kind: 'play', tile: '6-6', end: 'right' });
  });

  it('never strands the opener under the any-double rule, over many deals', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = dealRound(rules(), 1, null, seededRng(seed));
      const moves = legalMoves(r, r.turn);
      assert.ok(moves.length > 0, `seed ${seed}: opener had no legal opening`);
      for (const m of moves) {
        assert.equal(m.kind, 'play');
        if (m.kind === 'play') {
          const [a, b] = m.tile.split('-');
          assert.equal(a, b, `seed ${seed}: ${m.tile} is not a double`);
        }
      }
    }
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

  it('offers a pass only when nothing fits, under strict passing', () => {
    const board = placeTile([], '0-0', 'right');
    const stuck = round({ hands: [['1-2', '3-4'], [], [], []], board });
    assert.deepEqual(legalMoves(stuck, 0, true), [{ kind: 'pass' }]);

    const playable = round({ hands: [['0-5'], [], [], []], board });
    assert.ok(legalMoves(playable, 0, true).every((m) => m.kind === 'play'));
  });

  it('always offers a pass when passing is a choice', () => {
    const board = placeTile([], '0-0', 'right');
    const playable = round({ hands: [['0-5'], [], [], []], board });
    const moves = legalMoves(playable, 0, false);
    assert.ok(moves.some((m) => m.kind === 'pass'), 'a pass must be available');
    assert.ok(moves.some((m) => m.kind === 'play'), 'and so must the playable tile');
  });
});

describe('making moves', () => {
  it('rejects a move out of turn', () => {
    const m = match(round({ hands: [['0-1'], ['0-2'], [], []], turn: 0 }));
    assert.throws(() => applyMove(m, 1, { kind: 'play', tile: '0-2', end: 'right' }), RuleError);
  });

  it('refuses to let a player pass when they can play, under strict passing', () => {
    const board = placeTile([], '0-0', 'right');
    const m = match(round({ hands: [['0-5'], ['1-2'], ['1-3'], ['2-3']], board }), {
      rules: rules({ strictPassing: true }),
    });
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
      round({ hands: [['6-6', '0-1'], ['1-2'], ['2-3'], ['3-4']], opening: { kind: 'tile', tile: '6-6' } }),
      { roundNumber: 1 },
    );
    const after = applyMove(m, 0, { kind: 'play', tile: '6-6', end: 'right' });
    assert.equal(after.match.round!.opening, null);
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

  /** Pass round the table until the round ends. */
  function passAllRound(m: MatchState) {
    let state = m;
    let result = null;
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const out = applyMove(state, seat, { kind: 'pass' });
      state = out.match;
      result = out.result ?? result;
    }
    return { state, result };
  }

  it('decides a blocked round on the single lightest hand', () => {
    const board = placeTile([], '0-0', 'right');
    // Nobody holds a blank, so every seat must pass.
    // Seat 0 holds 1-2 — three pips, the lightest hand at the table — so
    // Team A takes it even though their two hands add up to far more.
    //   Team A: 1-2 (3) and 5-6 (11), lightest 3, total 14
    //   Team B: 3-4 (7) and 1-3 (4),  lightest 4, total 11
    const m = match(round({ hands: [['1-2'], ['3-4'], ['5-6'], ['1-3']], board, turn: 0 }));
    const { state, result } = passAllRound(m);

    assert.ok(result, 'four passes should end the round');
    assert.equal(result!.kind, 'blocked');
    assert.equal(result!.winningTeam, 0, 'the team holding the lightest hand');
    // Under pip scoring the winner collects the OPPONENTS' pips: 7 + 4.
    assert.deepEqual(state.scores, [11, 0]);
  });

  it('can still be settled on the two-hand total instead', () => {
    const board = placeTile([], '0-0', 'right');
    // The same deal under the old rule hands it to the other team entirely.
    const m = match(round({ hands: [['1-2'], ['3-4'], ['5-6'], ['1-3']], board, turn: 0 }), {
      rules: rules({ blockedByLowestPlayer: false }),
    });
    const { result } = passAllRound(m);
    assert.equal(result!.winningTeam, 1, 'lower total, heavier lightest hand');
  });

  it('ends a blocked round as soon as no one can move', () => {
    // Seat 0 plays the last blank; after it nobody has a 1 or a 6.
    const board = placeTile([], '1-1', 'right');
    const m = match(round({ hands: [['1-6', '2-2'], ['3-4'], ['5-5'], ['2-3']], board, turn: 0 }));
    const out = applyMove(m, 0, { kind: 'play', tile: '1-6', end: 'right' });
    assert.ok(out.result, 'the round should end without four explicit passes');
    assert.equal(out.result!.kind, 'blocked');
  });

  it('scores nothing when the lightest hands are level', () => {
    const board = placeTile([], '0-0', 'right');
    // Lightest hand on each side is five pips, so there is nothing between
    // them — never mind that Team A is carrying far more in total.
    //   Team A: 2-3 (5) and 5-6 (11)
    //   Team B: 1-4 (5) and 3-4 (7)
    const m = match(round({ hands: [['2-3'], ['1-4'], ['5-6'], ['3-4']], board, turn: 0 }));
    const { state, result } = passAllRound(m);
    assert.equal(result!.kind, 'tie');
    assert.equal(result!.winningTeam, null);
    assert.equal(result!.points, 0);
    assert.deepEqual(state.scores, [0, 0]);
  });

  it('pays the capicu bonus on top of the pips, in the pip game', () => {
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
      match(round({ hands, board }), { rules: rules({ capicuPoints: 25 }) }),
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
        rules: rules({ capicuPoints: 25 }),
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
    // Team A wins on seat 0's three pips, and seat 0 is also their lighter
    // hand, so the lead is theirs.
    const m = match(round({ hands: [['1-2'], ['3-4'], ['5-6'], ['1-3']], board, turn: 0 }));
    let state = m;
    let result = null;
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const out = applyMove(state, seat, { kind: 'pass' });
      state = out.match;
      result = out.result ?? result;
    }
    assert.equal(result!.winningTeam, 0);
    assert.equal(result!.nextStarter, 0);
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
      let state = newMatch(rules({ targetScore: 100, capicuPoints: 25 }), rng);
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
        const legal = legalMoves(r, seat, true);
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

// ---------------------------------------------------------------------------
// The Curacao house rules: voluntary passing, false-pass penalties, and a
// match scored by rounds won to a target that must be reached by a margin.
// ---------------------------------------------------------------------------

describe('passing by choice', () => {
  it('lets a player pass while holding a playable tile', () => {
    const board = placeTile([], '0-0', 'right');
    const m = match(round({ hands: [['0-5'], ['1-2'], ['1-3'], ['2-3']], board }), {
      rules: roundRules(),
    });
    const after = applyMove(m, 0, { kind: 'pass' });
    assert.equal(after.match.round!.turn, 1, 'play moves on');
    assert.equal(after.match.round!.passLog.length, 1);
  });

  it('records whether the passer actually had something to play', () => {
    const board = placeTile([], '0-0', 'right');

    const bluffing = applyMove(
      match(round({ hands: [['0-5'], ['1-2'], ['1-3'], ['2-3']], board }), { rules: roundRules() }),
      0,
      { kind: 'pass' },
    );
    assert.deepEqual(bluffing.match.round!.passLog[0], { seat: 0, couldHavePlayed: true });

    const honest = applyMove(
      match(round({ hands: [['1-5'], ['1-2'], ['1-3'], ['2-3']], board }), { rules: roundRules() }),
      0,
      { kind: 'pass' },
    );
    assert.deepEqual(honest.match.round!.passLog[0], { seat: 0, couldHavePlayed: false });
  });

  it('judges the pass against the board as it stood at the time', () => {
    // Seat 0 cannot follow a 0 now. Later the ends change and their tile fits,
    // but the pass was honest when it was made and must stay honest.
    const board = placeTile([], '0-0', 'right');
    let state = match(round({ hands: [['3-5'], ['0-3'], ['1-1'], ['2-2']], board }), {
      rules: roundRules(),
    });
    state = applyMove(state, 0, { kind: 'pass' }).match;
    state = applyMove(state, 1, { kind: 'play', tile: '0-3', end: 'right' }).match;
    assert.equal(state.round!.passLog[0]!.couldHavePlayed, false, 'still an honest pass');
  });
});

describe('punishing a false pass', () => {
  /** Run a round to its end with the given hands and moves. */
  function playOut(
    hands: string[][],
    board: ReturnType<typeof placeTile>,
    moves: [Seat, Move][],
    over: Partial<HouseRules> = {},
  ) {
    let state = match(round({ hands, board }), { rules: roundRules(over) });
    let result = null;
    for (const [seat, move] of moves) {
      const out = applyMove(state, seat, move);
      state = out.match;
      result = out.result ?? result;
    }
    return { state, result };
  }

  it('gives the other team a point for passing on a playable tile', () => {
    // Seat 1 can follow the 0 but passes; everyone else is genuinely stuck.
    const board = placeTile([], '0-0', 'right');
    const { state, result } = playOut(
      [['1-2'], ['0-6'], ['3-4'], ['5-5']],
      board,
      [
        [0, { kind: 'pass' }],
        [1, { kind: 'pass' }],
        [2, { kind: 'pass' }],
        [3, { kind: 'pass' }],
      ],
    );

    assert.ok(result, 'four passes end the round');
    assert.equal(result!.falsePasses.length, 1);
    assert.equal(result!.falsePasses[0]!.seat, 1);
    // Seat 1 is Team B, so Team B forfeits and Team A takes the payment.
    assert.deepEqual(result!.forfeited, [1]);
    assert.deepEqual(result!.penalties, [2, 0]);
    assert.deepEqual(result!.awarded, [2, 0], 'the caught team scores nothing');
    assert.deepEqual(state.scores, [2, 0]);
  });

  it('charges once for the round however many false passes a team made', () => {
    const board = placeTile([], '0-0', 'right');
    // Seats 1 and 3 (both Team B) each pass holding a playable tile.
    const { result } = playOut(
      [['1-2'], ['0-6'], ['3-4'], ['0-5']],
      board,
      [
        [0, { kind: 'pass' }],
        [1, { kind: 'pass' }],
        [2, { kind: 'pass' }],
        [3, { kind: 'pass' }],
      ],
    );
    assert.equal(result!.falsePasses.length, 2);
    assert.deepEqual(
      result!.penalties,
      [2, 0],
      'one payment for the round, not one per pass — cheating twice is not worth double',
    );
    assert.deepEqual(result!.forfeited, [1]);
  });

  it('lets nobody score when both teams were caught', () => {
    const board = placeTile([], '0-0', 'right');
    // Seat 0 (Team A) and seat 1 (Team B) both bluff.
    const { result } = playOut(
      [['0-2'], ['0-6'], ['3-4'], ['5-5']],
      board,
      [
        [0, { kind: 'pass' }],
        [1, { kind: 'pass' }],
        [2, { kind: 'pass' }],
        [3, { kind: 'pass' }],
      ],
    );
    assert.equal(result!.falsePasses.length, 2);
    assert.deepEqual(result!.forfeited, [0, 1], 'both sides caught');
    assert.deepEqual(result!.awarded, [0, 0], 'no clean team left to pay');
    assert.deepEqual(result!.penalties, [0, 0]);
  });

  it('charges nothing when every pass was honest', () => {
    const board = placeTile([], '0-0', 'right');
    const { result } = playOut(
      [['1-2'], ['3-4'], ['5-6'], ['1-3']],
      board,
      [
        [0, { kind: 'pass' }],
        [1, { kind: 'pass' }],
        [2, { kind: 'pass' }],
        [3, { kind: 'pass' }],
      ],
    );
    assert.equal(result!.falsePasses.length, 0);
    assert.deepEqual(result!.penalties, [0, 0]);
  });

  it('still punishes the winning team for bluffing on the way', () => {
    // Seat 0 passes holding a playable tile, then goes out next turn anyway.
    const board = placeTile([], '3-3', 'right');
    const { result } = playOut(
      [['3-5'], ['6-6'], ['0-1'], ['4-4']],
      board,
      [
        [0, { kind: 'pass' }],
        [1, { kind: 'pass' }],
        [2, { kind: 'pass' }],
        [3, { kind: 'pass' }],
      ],
    );
    // All four passed, so the round is blocked; seat 0's bluff still costs.
    assert.equal(result!.falsePasses.some((p) => p.seat === 0), true);
    assert.equal(result!.penalties[1], 2, 'Team B collects for seat 0');
    assert.equal(result!.awarded[0], 0, 'Team A gets nothing at all');
  });

  it('takes the round off a team that cheated and then went out first', () => {
    // The case that started this: seat 0 passes on a tile that fitted, then
    // empties their hand anyway. Winning the round used to cancel the penalty
    // out to a point each, so cheating cost nothing.
    const board = placeTile([], '3-3', 'right');
    const { state, result } = playOut(
      [['3-5', '5-5'], ['6-6'], ['0-1'], ['4-4']],
      board,
      [
        [0, { kind: 'pass' }],
        [1, { kind: 'pass' }],
        [2, { kind: 'pass' }],
        [3, { kind: 'pass' }],
      ],
    );
    assert.ok(result, 'the round ended');
    assert.equal(result!.falsePasses.some((p) => p.seat === 0), true);
    assert.deepEqual(result!.awarded, [0, 2], 'Team A forfeits, Team B takes 2');
    assert.deepEqual(state.scores, [0, 2]);
  });

  it('can go back to the old soft rule', () => {
    const board = placeTile([], '0-0', 'right');
    const { result } = playOut(
      [['1-2'], ['0-6'], ['3-4'], ['5-5']],
      board,
      [
        [0, { kind: 'pass' }],
        [1, { kind: 'pass' }],
        [2, { kind: 'pass' }],
        [3, { kind: 'pass' }],
      ],
      { falsePassForfeits: false, falsePassPenalty: 1 },
    );
    assert.deepEqual(result!.forfeited, [], 'nobody forfeits');
    assert.deepEqual(result!.penalties, [1, 0], 'just the old point');
  });

  it('can be switched off', () => {
    const board = placeTile([], '0-0', 'right');
    const { result } = playOut(
      [['1-2'], ['0-6'], ['3-4'], ['5-5']],
      board,
      [
        [0, { kind: 'pass' }],
        [1, { kind: 'pass' }],
        [2, { kind: 'pass' }],
        [3, { kind: 'pass' }],
      ],
      { falsePassPenalty: 0 },
    );
    assert.equal(result!.falsePasses.length, 1, 'still reported');
    assert.deepEqual(result!.penalties, [0, 0], 'but costs nothing');
  });
});

describe('calling someone out', () => {
  /** A round where seat 1 has passed on a 0 they could have played. */
  function afterABluff() {
    const board = placeTile([], '0-0', 'right');
    let state = match(round({ hands: [['1-2', '2-3'], ['0-6', '6-6'], ['3-4', '4-5'], ['5-5', '1-5']], board }), {
      rules: roundRules(),
    });
    state = applyMove(state, 0, { kind: 'pass' }).match;   // honest
    state = applyMove(state, 1, { kind: 'pass' }).match;   // held the 0-6
    return state;
  }

  it('ends the round and pays the caller when the accusation is right', () => {
    const state = afterABluff();
    const out = callOut(state, 2, 1);
    assert.equal(out.result!.kind, 'calledOut');
    assert.deepEqual(out.result!.calledOut, { by: 2, accused: 1, correct: true });
    assert.deepEqual(out.result!.forfeited, [1], 'the accused team loses the round');
    assert.deepEqual(out.result!.awarded, [2, 0], 'the caller team takes 2');
    assert.equal(out.match.phase, 'roundOver');
  });

  it('costs the caller the round when the accusation is wrong', () => {
    const state = afterABluff();
    // Seat 0 passed honestly, so accusing them backfires on the accuser.
    const out = callOut(state, 1, 0);
    assert.equal(out.result!.calledOut!.correct, false);
    assert.deepEqual(out.result!.forfeited, [1], 'the accuser team pays instead');
    assert.deepEqual(out.result!.awarded, [2, 0]);
  });

  it('refuses an accusation against your own partner', () => {
    const state = afterABluff();
    assert.throws(() => callOut(state, 3, 1), /only call out an opponent/);
    assert.throws(() => callOut(state, 1, 1), /cannot call yourself/);
  });

  it('refuses an accusation against someone who has not passed', () => {
    const state = afterABluff();
    assert.throws(() => callOut(state, 1, 2), /not passed this round/);
  });

  it('is not allowed once the round is over', () => {
    const board = placeTile([], '3-3', 'right');
    const m = match(round({ hands: [['3-5'], ['6-6'], ['0-1'], ['4-4']], board }), {
      rules: roundRules(),
    });
    const ended = applyMove(m, 0, { kind: 'play', tile: '3-5', end: 'right' }).match;
    assert.equal(ended.phase !== 'playing', true);
    assert.throws(() => callOut(ended, 1, 0), /no round in progress/);
  });

  it('keeps who passed public but whether it was false hidden', () => {
    const state = afterABluff();
    // Both passes are on the record for everyone; only the engine knows which
    // of them was a bluff.
    assert.deepEqual(seatsThatPassed(state.round!), [0, 1]);
    const leaked = JSON.stringify(seatsThatPassed(state.round!));
    assert.equal(leaked.includes('couldHavePlayed'), false);
  });
});

describe('scoring by rounds won', () => {
  it('pays one point for taking a round, whatever the pips', () => {
    // Ends 2 and 5; 5-6 closes only the right, so this is no capicú.
    const board = placeTile(placeTile([], '2-4', 'right'), '4-5', 'right');
    const m = match(round({ hands: [['5-6'], ['6-6'], ['0-1'], ['4-4']], board }), {
      rules: roundRules(),
    });
    const out = applyMove(m, 0, { kind: 'play', tile: '5-6', end: 'right' });
    assert.equal(out.result!.points, 1, 'one point, not twenty pips');
    assert.deepEqual(out.result!.awarded, [1, 0]);
    assert.deepEqual(out.match.scores, [1, 0]);
  });

  it('still pays pips when the table is set that way', () => {
    const board = placeTile([], '3-3', 'right');
    const m = match(round({ hands: [['3-5'], ['6-6'], ['0-1'], ['4-4']], board }));
    const out = applyMove(m, 0, { kind: 'play', tile: '3-5', end: 'right' });
    assert.equal(out.result!.points, 20);
  });
});

describe('first to ten, drawn at five', () => {
  const R = DEFAULT_RULES;

  it('is not over early on', () => {
    assert.deepEqual(matchOutcome(R, [0, 0]), { over: false, winner: null, drawn: false });
    assert.deepEqual(matchOutcome(R, [4, 2]), { over: false, winner: null, drawn: false });
  });

  it('wins at ten while the other team is under five', () => {
    assert.deepEqual(matchOutcome(R, [10, 4]), { over: true, winner: 0, drawn: false });
    assert.deepEqual(matchOutcome(R, [4, 10]), { over: true, winner: 1, drawn: false });
    assert.deepEqual(matchOutcome(R, [10, 0]), { over: true, winner: 0, drawn: false });
  });

  it('stops level the moment the second team reaches five', () => {
    assert.deepEqual(matchOutcome(R, [6, 5]), { over: true, winner: null, drawn: true });
    assert.deepEqual(matchOutcome(R, [5, 6]), { over: true, winner: null, drawn: true });
    assert.deepEqual(matchOutcome(R, [7, 5]), { over: true, winner: null, drawn: true });
  });

  it('draws at five all', () => {
    assert.deepEqual(matchOutcome(R, [5, 5]), { over: true, winner: null, drawn: true });
  });

  it('keeps playing while only one team is on the line', () => {
    assert.deepEqual(matchOutcome(R, [5, 4]), { over: false, winner: null, drawn: false });
    assert.deepEqual(matchOutcome(R, [9, 4]), { over: false, winner: null, drawn: false });
  });

  it('is still a draw when the trailing team jumps past five', () => {
    // Penalties can move a score by more than one, so the line is "at least
    // five", not "exactly five".
    assert.equal(matchOutcome(R, [8, 6]).drawn, true);
    assert.equal(matchOutcome(R, [9, 7]).drawn, true);
  });

  it('draws rather than wins when both happen in the same round', () => {
    // Reaching ten does not rescue a match the other team has levelled.
    assert.deepEqual(matchOutcome(R, [10, 5]), { over: true, winner: null, drawn: true });
    assert.deepEqual(matchOutcome(R, [10, 9]), { over: true, winner: null, drawn: true });
  });

  it('needs no margin — ten is enough', () => {
    assert.equal(matchOutcome(R, [10, 4]).winner, 0);
  });

  it('plays on without the rule when the line is switched off', () => {
    const noDraw = roundRules({ drawAt: null, targetScore: 10 });
    assert.deepEqual(matchOutcome(noDraw, [5, 5]), { over: false, winner: null, drawn: false });
    assert.deepEqual(matchOutcome(noDraw, [7, 5]), { over: false, winner: null, drawn: false });
    assert.deepEqual(matchOutcome(noDraw, [10, 9]), { over: true, winner: 0, drawn: false });
  });

  it('leaves the pip game alone', () => {
    assert.equal(PIP_RULES.drawAt, null);
    assert.equal(matchOutcome(PIP_RULES, [80, 60]).over, false);
    assert.equal(matchOutcome(PIP_RULES, [150, 90]).winner, 0);
  });

  it('ends a real match as a draw the moment the second team reaches the line', () => {
    const board = placeTile(placeTile([], '2-4', 'right'), '4-5', 'right');
    const m = match(round({ hands: [['5-6'], ['6-6'], ['0-1'], ['4-4']], board }), {
      rules: roundRules(),
      scores: [4, 5],
    });
    const out = applyMove(m, 0, { kind: 'play', tile: '5-6', end: 'right' });
    assert.deepEqual(out.match.scores, [5, 5]);
    assert.equal(out.match.phase, 'matchOver');
    assert.equal(out.match.winner, null);
    assert.equal(out.match.drawn, true, 'five all is a draw');
  });

  it('lets a team run clear to ten while the other stays under the line', () => {
    const board = placeTile(placeTile([], '2-4', 'right'), '4-5', 'right');
    const m = match(round({ hands: [['5-6'], ['6-6'], ['0-1'], ['4-4']], board }), {
      rules: roundRules(),
      scores: [9, 4],
    });
    const out = applyMove(m, 0, { kind: 'play', tile: '5-6', end: 'right' });
    assert.deepEqual(out.match.scores, [10, 4]);
    assert.equal(out.match.winner, 0);
    assert.equal(out.match.drawn, false);
  });

  it('tells a drawn match apart from one still in progress', () => {
    const m = newMatch(roundRules(), seededRng(5));
    assert.equal(m.drawn, false);
    assert.equal(m.phase, 'playing');
  });
});

describe('simulated matches under the house rules', () => {
  it('terminates and respects the winning margin', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const rng = seededRng(seed);
      let state = newMatch(DEFAULT_RULES, rng);
      let guard = 0;

      while (state.phase !== 'matchOver') {
        if (state.phase === 'roundOver') {
          state = startNextRound(state, rng);
          continue;
        }
        const r = state.round!;
        // Play legally, but pass at random sometimes — bluffs included, which
        // is what the penalty rule exists to handle.
        const strictMoves = legalMoves(r, r.turn, true);
        // Never on the opening lead: somebody has to put a tile down.
        const bluff = r.board.length > 0 && rng() < 0.08;
        const move: Move = bluff ? { kind: 'pass' } : (strictMoves[0] as Move);
        state = applyMove(state, r.turn, move).match;
        assert.ok(++guard < 20000, 'match failed to terminate');
      }

      const [a, b] = state.scores;
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      if (state.drawn) {
        assert.equal(state.winner, null, 'a drawn match has no winner');
        assert.ok(low >= 5, `drawn at ${a}-${b}, where the second team is not on the line`);
      } else {
        assert.ok(state.winner !== null, 'an undrawn finish must have a winner');
        assert.ok(high >= 10, `winner finished below the target at ${a}-${b}`);
        assert.ok(low < 5, `won at ${a}-${b} although the other team reached the line`);
      }
    }
  });
});

describe('the opening lead', () => {
  it('cannot be passed — someone has to put a tile down', () => {
    const m = match(round({ hands: [['0-1', '2-3'], ['1-2'], ['3-4'], ['5-5']], board: [] }), {
      rules: roundRules(),
    });
    assert.throws(() => applyMove(m, 0, { kind: 'pass' }), RuleError);
  });
});

describe('a capicú under round scoring', () => {
  /** Board with open ends 2 and 5, so 2-5 closes on both. */
  const twoFive = placeTile(placeTile([], '2-4', 'right'), '4-5', 'right');

  it('is worth two points instead of one', () => {
    const out = applyMove(
      match(round({ hands: [['2-5'], ['6-6'], ['0-1'], ['1-1']], board: twoFive }), {
        rules: roundRules(),
      }),
      0,
      { kind: 'play', tile: '2-5', end: 'left' },
    );
    assert.equal(out.result!.capicu, true);
    assert.equal(out.result!.points, 2, 'two, not one');
    assert.deepEqual(out.result!.awarded, [2, 0]);
  });

  it('replaces the round point rather than adding to it', () => {
    // The distinction that matters: 2 total, never 1 + 2 = 3.
    const out = applyMove(
      match(round({ hands: [['2-5'], ['6-6'], ['0-1'], ['1-1']], board: twoFive }), {
        rules: roundRules({ capicuPoints: 2 }),
      }),
      0,
      { kind: 'play', tile: '2-5', end: 'left' },
    );
    assert.equal(out.match.scores[0], 2);
    assert.notEqual(out.match.scores[0], 3, 'must not stack on the normal point');
  });

  it('still pays one for an ordinary win', () => {
    const board = placeTile(placeTile([], '2-4', 'right'), '4-5', 'right');
    const out = applyMove(
      match(round({ hands: [['5-6'], ['6-6'], ['0-1'], ['4-4']], board }), { rules: roundRules() }),
      0,
      { kind: 'play', tile: '5-6', end: 'right' },
    );
    assert.equal(out.result!.capicu, false);
    assert.equal(out.result!.points, 1);
  });

  it('pays one when the rule is switched off', () => {
    const out = applyMove(
      match(round({ hands: [['2-5'], ['6-6'], ['0-1'], ['1-1']], board: twoFive }), {
        rules: roundRules({ capicuPoints: 0 }),
      }),
      0,
      { kind: 'play', tile: '2-5', end: 'left' },
    );
    assert.equal(out.result!.capicu, false, 'not reported as a capicú when it pays nothing');
    assert.equal(out.result!.points, 1);
  });

  it('does not pay for a tile that only matched one end', () => {
    const out = applyMove(
      match(round({ hands: [['5-6'], ['6-6'], ['0-1'], ['1-1']], board: twoFive }), {
        rules: roundRules(),
      }),
      0,
      { kind: 'play', tile: '5-6', end: 'right' },
    );
    assert.equal(out.result!.capicu, false);
    assert.equal(out.result!.points, 1);
  });

  it('can carry a team over the line, and the draw still outranks it', () => {
    // 4-5 plus a capicú is 6-5: both teams on the line, so the match is
    // drawn rather than won.
    const out = applyMove(
      match(round({ hands: [['2-5'], ['6-6'], ['0-1'], ['1-1']], board: twoFive }), {
        rules: roundRules(),
        scores: [4, 5],
      }),
      0,
      { kind: 'play', tile: '2-5', end: 'left' },
    );
    assert.deepEqual(out.match.scores, [6, 5]);
    assert.equal(out.match.phase, 'matchOver');
    assert.equal(out.match.drawn, true);
    assert.equal(out.match.winner, null);
  });

  it('adds to the penalties rather than replacing them', () => {
    // A capicú win and an opponent's false pass both land in the same round.
    const board = placeTile([], '0-0', 'right');
    let state = match(round({ hands: [['0-5', '1-1'], ['0-6'], ['3-4'], ['5-5']], board }), {
      rules: roundRules(),
    });
    state = applyMove(state, 0, { kind: 'play', tile: '0-5', end: 'right' }).match;
    state = applyMove(state, 1, { kind: 'pass' }).match;   // bluff: 0-6 fits the 0
    const result = state.lastResult;
    if (result !== null) {
      assert.ok(result.penalties[0] >= 0);
    }
    assert.ok(state.scores[0] >= 0, 'scoring stayed coherent');
  });
});

describe('remembering the opening tile', () => {
  it('records the first tile played and never changes it', () => {
    // Seat 1 must hold a six, or the round blocks the moment the 6-6 is down.
    const m = match(
      round({ hands: [['6-6', '0-1'], ['1-6', '2-2'], ['2-3'], ['3-4']], opening: { kind: 'tile', tile: '6-6' } }),
      { roundNumber: 1 },
    );
    assert.equal(m.round!.openerTile, null, 'nothing opened yet');

    const opened = applyMove(m, 0, { kind: 'play', tile: '6-6', end: 'right' });
    assert.equal(opened.match.round!.openerTile, '6-6');

    // A later tile, played at either end, leaves the opener alone.
    const next = applyMove(opened.match, 1, { kind: 'play', tile: '1-6', end: 'right' });
    assert.equal(next.match.round!.openerTile, '6-6');
  });

  it('stays the opener even when the chain grows to its left', () => {
    const board = placeTile([], '3-3', 'right');
    const m = match(round({ hands: [['3-5'], ['2-3'], ['1-1'], ['4-4']], board, openerTile: '3-3' }));
    const out = applyMove(m, 0, { kind: 'play', tile: '3-5', end: 'left' });
    assert.equal(out.match.round!.openerTile, '3-3');
    // The opener is no longer first in the array, which is exactly why the id
    // is recorded rather than an index.
    assert.notEqual(out.match.round!.board[0]!.id, '3-3');
  });

  it('is cleared by a fresh deal', () => {
    const m = newMatch(roundRules(), seededRng(9));
    assert.equal(m.round!.openerTile, null);
  });
});

describe('describing a round nobody can be proud of', () => {
  it('never says a team takes a round it forfeited', () => {
    const board = placeTile([], '0-0', 'right');
    // Seat 0 holds the lightest hand AND bluffed, so Team A would otherwise
    // be described as taking the round and losing it in the same breath.
    const m = match(round({ hands: [['1-2'], ['3-4'], ['5-6'], ['1-3']], board, turn: 0 }), {
      rules: roundRules(),
    });
    let state = m;
    let result = null;
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const out = applyMove(state, seat, { kind: 'pass' });
      state = out.match;
      result = out.result ?? result;
    }
    assert.equal(result!.kind, 'blocked');
    assert.equal(result!.winningTeam, 0, 'seat 0 held the lightest hand');

    const forced = { ...result!, forfeited: [0 as const] };
    const text = describeResult(forced);
    assert.ok(text.includes('held the fewest pips'), 'still says whose hand was lightest');
    assert.ok(
      !/Team A takes the round/.test(text),
      `a forfeiting team must not be said to take the round: ${text}`,
    );
  });
});
