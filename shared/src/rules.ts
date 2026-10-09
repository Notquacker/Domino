/**
 * Curacao-style partnership dominoes.
 *
 * Four players, two teams, partners seated opposite each other. The whole
 * double-six set is dealt out (7 tiles each), so there is no boneyard: a player
 * who cannot follow either open end passes. A player who *can* play must play.
 *
 * Everything here is a pure function over immutable state. The server owns the
 * only authoritative copy; clients receive a redacted view (see protocol.ts).
 */

import {
  DOUBLE_SIX,
  HAND_SIZE,
  type Pip,
  type Rng,
  type TileId,
  fullSet,
  handPips,
  parseTile,
  shuffle,
} from './tiles.js';

export type Seat = 0 | 1 | 2 | 3;
export type Team = 0 | 1;

export const SEATS: readonly Seat[] = [0, 1, 2, 3];

/** Seats 0 and 2 form one team; 1 and 3 the other. Partners sit opposite. */
export function teamOf(seat: Seat): Team {
  return (seat % 2) as Team;
}

export function partnerOf(seat: Seat): Seat {
  return ((seat + 2) % 4) as Seat;
}

export function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}

export function seatsOfTeam(team: Team): readonly [Seat, Seat] {
  return team === 0 ? [0, 2] : [1, 3];
}

export type End = 'left' | 'right';

/** A tile as laid on the table: `left`/`right` are the pips as they face. */
export interface BoardTile {
  readonly id: TileId;
  readonly left: Pip;
  readonly right: Pip;
}

export type Move =
  | { readonly kind: 'play'; readonly tile: TileId; readonly end: End }
  | { readonly kind: 'pass' };

export interface HouseRules {
  /** Match runs until a team reaches this many points. */
  readonly targetScore: number;
  /** First round of a match is opened by whoever holds the 6-6, who must play it. */
  readonly mustOpenDoubleSix: boolean;
  /**
   * When false (the common rule) a winning team scores only the pips left in
   * the two opponents' hands. When true, every unplayed tile on the table
   * counts, including the winner's partner's.
   */
  readonly countAllRemaining: boolean;
  /**
   * Extra points for closing the round with a tile that matched both open ends
   * ("capicu"). Zero disables the bonus.
   */
  readonly capicuBonus: number;
}

export const DEFAULT_RULES: HouseRules = {
  targetScore: 150,
  mustOpenDoubleSix: true,
  countAllRemaining: false,
  capicuBonus: 0,
};

export interface RoundState {
  /** Hands by seat. Server-only — never serialised to a client. */
  readonly hands: readonly (readonly TileId[])[];
  readonly board: readonly BoardTile[];
  readonly turn: Seat;
  /** Consecutive passes; four in a row means the round is blocked. */
  readonly passes: number;
  readonly starter: Seat;
  /** Forces the opening tile (the 6-6) on the first round of a match. */
  readonly requireTile: TileId | null;
}

export interface RoundResult {
  readonly kind: 'domino' | 'blocked' | 'tie';
  readonly winningTeam: Team | null;
  readonly points: number;
  /** Seat that emptied its hand, if the round ended that way. */
  readonly dominoedBy: Seat | null;
  readonly capicu: boolean;
  /** Pips left per seat at the end of the round. */
  readonly remaining: readonly number[];
  /** Seat that opens the next round. */
  readonly nextStarter: Seat;
}

export type Phase = 'playing' | 'roundOver' | 'matchOver';

export interface MatchState {
  readonly rules: HouseRules;
  readonly scores: readonly [number, number];
  readonly roundNumber: number;
  readonly round: RoundState | null;
  readonly phase: Phase;
  readonly lastResult: RoundResult | null;
  readonly winner: Team | null;
}

// ---------------------------------------------------------------------------
// Board geometry
// ---------------------------------------------------------------------------

export function openEnds(board: readonly BoardTile[]): { left: Pip; right: Pip } | null {
  if (board.length === 0) return null;
  const first = board[0] as BoardTile;
  const last = board[board.length - 1] as BoardTile;
  return { left: first.left, right: last.right };
}

/**
 * Lay a tile against one end of the chain, flipping it so the matching pip
 * faces inward. Throws if the tile does not actually match that end — callers
 * are expected to have validated with `legalMoves` first.
 */
export function placeTile(
  board: readonly BoardTile[],
  id: TileId,
  end: End,
): readonly BoardTile[] {
  const tile = parseTile(id);
  const ends = openEnds(board);
  if (ends === null) {
    return [{ id, left: tile.low, right: tile.high }];
  }
  if (end === 'left') {
    const match = ends.left;
    // The new tile's right half must touch the board's left end.
    if (tile.high === match) return [{ id, left: tile.low, right: tile.high }, ...board];
    if (tile.low === match) return [{ id, left: tile.high, right: tile.low }, ...board];
    throw new Error(`tile ${id} does not match left end ${match}`);
  }
  const match = ends.right;
  if (tile.low === match) return [...board, { id, left: tile.low, right: tile.high }];
  if (tile.high === match) return [...board, { id, left: tile.high, right: tile.low }];
  throw new Error(`tile ${id} does not match right end ${match}`);
}

function handOf(round: RoundState, seat: Seat): readonly TileId[] {
  return round.hands[seat] ?? [];
}

/** Can this tile be laid at this end of the current board? */
export function fits(board: readonly BoardTile[], id: TileId, end: End): boolean {
  const ends = openEnds(board);
  if (ends === null) return true;
  const tile = parseTile(id);
  const match = end === 'left' ? ends.left : ends.right;
  return tile.low === match || tile.high === match;
}

/**
 * Every move the seated player may legally make right now. A pass is offered
 * only when no tile in hand fits either end — passing is never voluntary.
 */
export function legalMoves(round: RoundState, seat: Seat): readonly Move[] {
  if (round.turn !== seat) return [];
  const hand = handOf(round, seat);
  const ends = openEnds(round.board);

  if (ends === null) {
    const candidates =
      round.requireTile === null ? hand : hand.filter((id) => id === round.requireTile);
    return candidates.map((id) => ({ kind: 'play', tile: id, end: 'right' }) as const);
  }

  const moves: Move[] = [];
  for (const id of hand) {
    if (fits(round.board, id, 'left')) moves.push({ kind: 'play', tile: id, end: 'left' });
    if (fits(round.board, id, 'right')) moves.push({ kind: 'play', tile: id, end: 'right' });
  }
  return moves.length > 0 ? moves : [{ kind: 'pass' }];
}

export function isLegal(round: RoundState, seat: Seat, move: Move): boolean {
  return legalMoves(round, seat).some(
    (m) =>
      m.kind === move.kind &&
      (m.kind !== 'play' || move.kind !== 'play' || (m.tile === move.tile && m.end === move.end)),
  );
}

// ---------------------------------------------------------------------------
// Dealing
// ---------------------------------------------------------------------------

/**
 * Deal a fresh round. On the opening round of a match the 6-6 both decides who
 * leads and must be the first tile played; afterwards the previous round's
 * winner leads with any tile.
 */
export function dealRound(
  rules: HouseRules,
  roundNumber: number,
  starter: Seat | null,
  rng: Rng,
): RoundState {
  const deck = shuffle(fullSet(), rng);
  const hands: TileId[][] = [[], [], [], []];
  for (let i = 0; i < deck.length; i++) {
    const seat = (i % 4) as Seat;
    (hands[seat] as TileId[]).push(deck[i] as TileId);
  }

  const openingRound = roundNumber === 1 && rules.mustOpenDoubleSix;
  let turn: Seat;
  let requireTile: TileId | null = null;

  if (openingRound) {
    turn = SEATS.find((s) => (hands[s] as TileId[]).includes(DOUBLE_SIX)) ?? 0;
    requireTile = DOUBLE_SIX;
  } else {
    turn = starter ?? 0;
  }

  return {
    hands: hands.map((h) => sortHand(h)),
    board: [],
    turn,
    passes: 0,
    starter: turn,
    requireTile,
  };
}

/** Stable display order: doubles first by value, then the rest. */
export function sortHand(hand: readonly TileId[]): TileId[] {
  return hand.slice().sort((x, y) => {
    const a = parseTile(x);
    const b = parseTile(y);
    const aDouble = a.low === a.high ? 0 : 1;
    const bDouble = b.low === b.high ? 0 : 1;
    if (aDouble !== bDouble) return aDouble - bDouble;
    if (a.high !== b.high) return a.high - b.high;
    return a.low - b.low;
  });
}

export function newMatch(rules: HouseRules, rng: Rng): MatchState {
  return {
    rules,
    scores: [0, 0],
    roundNumber: 1,
    round: dealRound(rules, 1, null, rng),
    phase: 'playing',
    lastResult: null,
    winner: null,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function pipsPerSeat(round: RoundState): number[] {
  return SEATS.map((s) => handPips(handOf(round, s)));
}

function teamPips(remaining: readonly number[], team: Team): number {
  const [a, b] = seatsOfTeam(team);
  return (remaining[a] ?? 0) + (remaining[b] ?? 0);
}

function scoreFor(
  rules: HouseRules,
  remaining: readonly number[],
  winningTeam: Team,
): number {
  const losing = (1 - winningTeam) as Team;
  return rules.countAllRemaining
    ? teamPips(remaining, 0) + teamPips(remaining, 1)
    : teamPips(remaining, losing);
}

/**
 * Who leads the next round. The winner leads; when a blocked round is decided
 * on pips the lead goes to whichever member of the winning team held the fewer,
 * and a dead tie is re-dealt by the same opener.
 */
function nextStarterFor(
  round: RoundState,
  remaining: readonly number[],
  result: { kind: RoundResult['kind']; winningTeam: Team | null; dominoedBy: Seat | null },
): Seat {
  if (result.dominoedBy !== null) return result.dominoedBy;
  if (result.winningTeam === null) return round.starter;
  const [a, b] = seatsOfTeam(result.winningTeam);
  return (remaining[a] ?? 0) <= (remaining[b] ?? 0) ? a : b;
}

// ---------------------------------------------------------------------------
// Applying moves
// ---------------------------------------------------------------------------

export interface MoveOutcome {
  readonly match: MatchState;
  /** Set when this move ended the round. */
  readonly result: RoundResult | null;
  /** Human-readable line for the game log. */
  readonly note: string;
}

export class RuleError extends Error {}

/**
 * Apply one move by one seat, returning the next match state. Rejects anything
 * illegal — this is the only path by which a match advances, so the server can
 * trust nothing else.
 */
export function applyMove(match: MatchState, seat: Seat, move: Move): MoveOutcome {
  const round = match.round;
  if (round === null || match.phase !== 'playing') {
    throw new RuleError('no round in progress');
  }
  if (round.turn !== seat) {
    throw new RuleError('not your turn');
  }
  if (!isLegal(round, seat, move)) {
    throw new RuleError(
      move.kind === 'pass' ? 'you have a playable tile, so you must play' : 'illegal move',
    );
  }

  if (move.kind === 'pass') {
    const passes = round.passes + 1;
    const passed: RoundState = { ...round, passes, turn: nextSeat(round.turn) };
    if (passes >= 4) {
      return finishRound(match, passed, null, false);
    }
    return {
      match: { ...match, round: passed },
      result: null,
      note: `Seat ${seat} passed.`,
    };
  }

  // A play that matched both ends and empties the hand is a capicu.
  const bothEnds =
    round.board.length > 0 &&
    fits(round.board, move.tile, 'left') &&
    fits(round.board, move.tile, 'right');

  const hand = handOf(round, seat);
  if (!hand.includes(move.tile)) throw new RuleError('you do not hold that tile');

  const hands = round.hands.map((h, i) => (i === seat ? h.filter((id) => id !== move.tile) : h));
  const board = placeTile(round.board, move.tile, move.end);
  const played: RoundState = {
    ...round,
    hands,
    board,
    passes: 0,
    turn: nextSeat(round.turn),
    requireTile: null,
  };

  const remainingInHand = (hands[seat] ?? []).length;
  if (remainingInHand === 0) {
    return finishRound(match, played, seat, bothEnds);
  }

  // All four hands blocked immediately after a play is also a dead round.
  if (SEATS.every((s) => legalMovesWouldPass(played, s))) {
    return finishRound(match, played, null, false);
  }

  return {
    match: { ...match, round: played },
    result: null,
    note: `Seat ${seat} played ${move.tile}.`,
  };
}

/** True when the seat holds nothing that fits either open end. */
function legalMovesWouldPass(round: RoundState, seat: Seat): boolean {
  const hand = handOf(round, seat);
  if (hand.length === 0) return false;
  return !hand.some(
    (id) => fits(round.board, id, 'left') || fits(round.board, id, 'right'),
  );
}

function finishRound(
  match: MatchState,
  round: RoundState,
  dominoedBy: Seat | null,
  capicu: boolean,
): MoveOutcome {
  const remaining = pipsPerSeat(round);
  const rules = match.rules;

  let kind: RoundResult['kind'];
  let winningTeam: Team | null;

  if (dominoedBy !== null) {
    kind = 'domino';
    winningTeam = teamOf(dominoedBy);
  } else {
    const t0 = teamPips(remaining, 0);
    const t1 = teamPips(remaining, 1);
    if (t0 === t1) {
      kind = 'tie';
      winningTeam = null;
    } else {
      kind = 'blocked';
      winningTeam = t0 < t1 ? 0 : 1;
    }
  }

  const base = winningTeam === null ? 0 : scoreFor(rules, remaining, winningTeam);
  const bonus = capicu && winningTeam !== null ? rules.capicuBonus : 0;
  const points = base + bonus;

  const nextStarter = nextStarterFor(round, remaining, { kind, winningTeam, dominoedBy });

  const scores: [number, number] = [match.scores[0], match.scores[1]];
  if (winningTeam !== null) scores[winningTeam] += points;

  const result: RoundResult = {
    kind,
    winningTeam,
    points,
    dominoedBy,
    capicu: capicu && bonus > 0,
    remaining,
    nextStarter,
  };

  const reachedTarget = winningTeam !== null && scores[winningTeam] >= rules.targetScore;

  return {
    match: {
      ...match,
      round,
      scores,
      phase: reachedTarget ? 'matchOver' : 'roundOver',
      lastResult: result,
      winner: reachedTarget ? winningTeam : null,
    },
    result,
    note: describeResult(result),
  };
}

export function describeResult(r: RoundResult): string {
  if (r.kind === 'tie') return 'Round blocked with the teams level — no points, re-deal.';
  const team = r.winningTeam === 0 ? 'Team A' : 'Team B';
  if (r.kind === 'domino') {
    const capicu = r.capicu ? ' with a capicu' : '';
    return `Seat ${r.dominoedBy} domino'd${capicu} — ${team} scores ${r.points}.`;
  }
  return `Round blocked — ${team} had fewer pips and scores ${r.points}.`;
}

/** Start the next round after a completed one. */
export function startNextRound(match: MatchState, rng: Rng): MatchState {
  if (match.phase === 'matchOver') throw new RuleError('match is over');
  if (match.phase !== 'roundOver') throw new RuleError('round still in progress');
  const starter = match.lastResult?.nextStarter ?? 0;
  const roundNumber = match.roundNumber + 1;
  return {
    ...match,
    roundNumber,
    round: dealRound(match.rules, roundNumber, starter, rng),
    phase: 'playing',
  };
}

export { HAND_SIZE };
