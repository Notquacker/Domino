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
  isDouble,
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

/**
 * How a match is scored.
 *
 * 'rounds' — winning a round is worth one point, and the match runs to a
 * target that must be reached by a margin (first to 7, win by 2). This is the
 * table default.
 *
 * 'pips' — the winning team scores the pips left in the losing hands, and the
 * match runs to 100/150/200. No margin applies.
 */
export type ScoringMode = 'rounds' | 'pips';

export interface HouseRules {
  readonly scoring: ScoringMode;
  /** Match runs until a team reaches this many points. */
  readonly targetScore: number;
  /**
   * The winner must also lead by this much. 1 means reaching the target is
   * enough.
   */
  readonly winBy: number;
  /**
   * The drawn-match line. Once BOTH teams have reached it the match stops
   * level, so with a line of 5 the scores 5-5, 6-5 and 10-5 are all draws.
   * The only way to win is to reach the target while the other team is still
   * below the line. Null disables the rule.
   */
  readonly drawAt: number | null;
  /** First round of a match is opened by whoever holds the 6-6, who must play it. */
  readonly mustOpenDoubleSix: boolean;
  /**
   * Relaxes that opening. The 6-6 still decides who leads, but that player may
   * lead with whichever double they like rather than being made to lay the 6-6
   * itself. They always hold at least one double — the 6-6 — so the lead can
   * never be stuck. Ignored when mustOpenDoubleSix is off.
   */
  readonly openWithAnyDouble: boolean;
  /**
   * When true a player may only pass with nothing playable — the engine
   * refuses any other pass. When false (the default) passing is a choice, and
   * a pass made while holding a playable tile is punished at the end of the
   * round instead.
   */
  readonly strictPassing: boolean;
  /**
   * Points the clean team takes when a false pass is punished — a pass made
   * while actually holding a playable tile. Awarded once for the round, not
   * once per pass, so a player who cheats twice does not hand over double.
   * Zero disables the penalty.
   */
  readonly falsePassPenalty: number;
  /**
   * The teeth behind the penalty: a team caught passing on a playable tile
   * scores nothing at all for that round, even if one of them went out first.
   * Winning the round no longer cancels out the penalty.
   *
   * With this off, the old behaviour returns — the round scores as normal and
   * the penalty is simply added on top.
   */
  readonly falsePassForfeits: boolean;
  /**
   * When false (the common rule) a winning team scores only the pips left in
   * the two opponents' hands. When true, every unplayed tile on the table
   * counts, including the winner's partner's. Only applies to 'pips' scoring.
   */
  readonly countAllRemaining: boolean;
  /**
   * What winning a round with a capicu is worth — going out on a tile that
   * matched both open ends.
   *
   * Under round scoring this REPLACES the usual single point, so 2 means a
   * capicu round counts double rather than paying 1 plus a bonus. Under pip
   * scoring it is added to the pips instead. Zero turns the rule off.
   */
  readonly capicuPoints: number;
}

export const DEFAULT_RULES: HouseRules = {
  scoring: 'rounds',
  targetScore: 10,
  winBy: 1,
  drawAt: 5,
  mustOpenDoubleSix: true,
  openWithAnyDouble: true,
  strictPassing: false,
  falsePassPenalty: 2,
  falsePassForfeits: true,
  countAllRemaining: false,
  capicuPoints: 2,
};

/** Sensible defaults for the older pip-counting game. */
export const PIP_RULES: HouseRules = {
  ...DEFAULT_RULES,
  scoring: 'pips',
  targetScore: 150,
  winBy: 1,
  drawAt: null,
  // The pip game traditionally plays capicu as an optional extra.
  capicuPoints: 0,
};

/** A pass, recorded so it can be judged once every hand is face up. */
export interface PassRecord {
  readonly seat: Seat;
  /** True if the player held a tile that would have fitted an open end. */
  readonly couldHavePlayed: boolean;
}

/** How the opening tile of a round is constrained. */
export type OpeningRequirement =
  | { readonly kind: 'tile'; readonly tile: TileId }
  | { readonly kind: 'double' };

export interface RoundState {
  /** Hands by seat. Server-only — never serialised to a client. */
  readonly hands: readonly (readonly TileId[])[];
  readonly board: readonly BoardTile[];
  readonly turn: Seat;
  /** Consecutive passes; four in a row means the round is blocked. */
  readonly passes: number;
  readonly starter: Seat;
  /**
   * What the first tile of the round must be, when it is constrained at all.
   *
   * `{ kind: 'tile' }` pins it to one tile — the 6-6 under the standard
   * opening. `{ kind: 'double' }` is the house rule that lets whoever holds
   * the 6-6 lead with any double in their hand. Null leaves the lead free,
   * which is every round after the first.
   *
   * This cannot be a plain TileId: TileId is a string, so a sentinel like
   * 'any-double' would satisfy the type checker and then quietly match no
   * tile at all.
   */
  readonly opening: OpeningRequirement | null;
  /** Every pass this round, judged at the moment it was made. */
  readonly passLog: readonly PassRecord[];
  /**
   * The tile that opened the round. The chain grows from it in both
   * directions, so a board can be drawn with it held in the middle the way it
   * sits on a real table.
   */
  readonly openerTile: TileId | null;
}

export interface RoundResult {
  readonly kind: 'domino' | 'blocked' | 'tie' | 'calledOut';
  readonly winningTeam: Team | null;
  /** Total points this round moved to each team, penalties included. */
  readonly points: number;
  /** Points each team gained, by team index — the authoritative breakdown. */
  readonly awarded: readonly [number, number];
  /** Passes made while holding a playable tile, by the player who made them. */
  readonly falsePasses: readonly PassRecord[];
  /** Penalty points each team received for the other's false passes. */
  readonly penalties: readonly [number, number];
  /** Teams that scored nothing this round because they were caught passing. */
  readonly forfeited: readonly Team[];
  /**
   * Set when a player accused someone of passing on a playable tile. A wrong
   * accusation costs the accuser's own team the round, which is what keeps
   * calling someone out a risk rather than a free guess.
   */
  readonly calledOut: {
    readonly by: Seat;
    readonly accused: Seat;
    readonly correct: boolean;
  } | null;
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
  /** True when the match ended level on the drawn line rather than being won. */
  readonly drawn: boolean;
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
export function legalMoves(
  round: RoundState,
  seat: Seat,
  strict = true,
): readonly Move[] {
  if (round.turn !== seat) return [];
  const hand = handOf(round, seat);
  const ends = openEnds(round.board);

  if (ends === null) {
    const want = round.opening;
    const candidates =
      want === null
        ? hand
        : want.kind === 'tile'
          ? hand.filter((id) => id === want.tile)
          : hand.filter((id) => isDouble(id));
    return candidates.map((id) => ({ kind: 'play', tile: id, end: 'right' }) as const);
  }

  const moves: Move[] = [];
  for (const id of hand) {
    if (fits(round.board, id, 'left')) moves.push({ kind: 'play', tile: id, end: 'left' });
    if (fits(round.board, id, 'right')) moves.push({ kind: 'play', tile: id, end: 'right' });
  }
  if (moves.length === 0 || !strict) moves.push({ kind: 'pass' });
  return moves;
}

/** Does this seat hold anything that would fit an open end right now? */
export function hasPlayable(round: RoundState, seat: Seat): boolean {
  const ends = openEnds(round.board);
  if (ends === null) return handOf(round, seat).length > 0;
  return handOf(round, seat).some(
    (id) => fits(round.board, id, 'left') || fits(round.board, id, 'right'),
  );
}

export function isLegal(
  round: RoundState,
  seat: Seat,
  move: Move,
  strict = true,
): boolean {
  return legalMoves(round, seat, strict).some(
    (m) =>
      m.kind === move.kind &&
      (m.kind !== 'play' || move.kind !== 'play' || (m.tile === move.tile && m.end === move.end)),
  );
}

// ---------------------------------------------------------------------------
// Dealing
// ---------------------------------------------------------------------------

/**
 * Deal a fresh round. On the opening round of a match the 6-6 decides who
 * leads; whether that player must lay the 6-6 itself or may lead with any
 * double is up to the house rules. Afterwards the previous round's winner
 * leads with any tile.
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
  let opening: OpeningRequirement | null = null;

  if (openingRound) {
    turn = SEATS.find((s) => (hands[s] as TileId[]).includes(DOUBLE_SIX)) ?? 0;
    opening = rules.openWithAnyDouble
      ? { kind: 'double' }
      : { kind: 'tile', tile: DOUBLE_SIX };
  } else {
    turn = starter ?? 0;
  }

  return {
    hands: hands.map((h) => sortHand(h)),
    board: [],
    turn,
    passes: 0,
    starter: turn,
    opening,
    passLog: [],
    openerTile: null,
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
    drawn: false,
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
  const strict = match.rules.strictPassing;
  if (!isLegal(round, seat, move, strict)) {
    throw new RuleError(
      move.kind === 'pass' ? 'you have a playable tile, so you must play' : 'illegal move',
    );
  }

  if (move.kind === 'pass') {
    // Judged now, while the board still looks the way it did when they chose
    // to pass. Whether it costs them is settled once hands are revealed.
    const couldHavePlayed = hasPlayable(round, seat);
    const passes = round.passes + 1;
    const passed: RoundState = {
      ...round,
      passes,
      turn: nextSeat(round.turn),
      passLog: [...round.passLog, { seat, couldHavePlayed }],
    };
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
  const openingPlay = round.board.length === 0;
  const board = placeTile(round.board, move.tile, move.end);
  const played: RoundState = {
    ...round,
    hands,
    board,
    passes: 0,
    turn: nextSeat(round.turn),
    opening: null,
    openerTile: openingPlay ? move.tile : round.openerTile,
  };

  const remainingInHand = (hands[seat] ?? []).length;
  if (remainingInHand === 0) {
    return finishRound(match, played, seat, bothEnds);
  }

  // Everyone genuinely stuck right after a play is a dead round. Voluntary
  // passes do not count here — only hands that truly cannot follow.
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

/**
 * Punish the passes that turned out to be false, mutating `awarded` and
 * `penalties` in place and returning the teams that forfeited the round.
 *
 * Under the forfeiting rule a caught team scores nothing at all — the round
 * win included — and the clean team takes a flat payment instead of the
 * round's own points. Before this, cheating and then winning cancelled out to
 * a point each, so cheating cost nothing.
 *
 * When both teams were caught, neither scores: there is no clean team left to
 * pay.
 */
/**
 * Has this seat passed at all this round? Public information — everyone saw
 * it happen — so it is safe to show in a player's view.
 */
export function seatsThatPassed(round: RoundState): Seat[] {
  const seen: Seat[] = [];
  for (const p of round.passLog) if (!seen.includes(p.seat)) seen.push(p.seat);
  return seen;
}

/**
 * Accuse a seat of having passed while holding a playable tile.
 *
 * This is how a false pass gets punished before the hands come up: play
 * carries on until somebody works it out and says so. Getting it right ends
 * the round and takes the points; getting it wrong ends the round and gives
 * them away, which is the whole risk of opening your mouth.
 *
 * Only an opponent may call: accusing your own partner would be a way of
 * throwing a round you were losing.
 */
export function callOut(match: MatchState, by: Seat, accused: Seat): MoveOutcome {
  const round = match.round;
  if (round === null || match.phase !== 'playing') {
    throw new RuleError('no round in progress');
  }
  if (by === accused) throw new RuleError('you cannot call yourself out');
  if (teamOf(by) === teamOf(accused)) {
    throw new RuleError('you can only call out an opponent');
  }
  if (!round.passLog.some((p) => p.seat === accused)) {
    throw new RuleError('they have not passed this round');
  }

  const correct = round.passLog.some((p) => p.seat === accused && p.couldHavePlayed);
  const guilty = correct ? teamOf(accused) : teamOf(by);
  const clean = (1 - guilty) as Team;

  const remaining = pipsPerSeat(round);
  const awarded: [number, number] = [0, 0];
  const penalties: [number, number] = [0, 0];
  awarded[clean] = match.rules.falsePassPenalty;
  penalties[clean] = match.rules.falsePassPenalty;

  const scores: [number, number] = [
    match.scores[0] + awarded[0],
    match.scores[1] + awarded[1],
  ];

  const result: RoundResult = {
    kind: 'calledOut',
    winningTeam: clean,
    points: awarded[0] + awarded[1],
    awarded,
    falsePasses: round.passLog.filter((p) => p.couldHavePlayed),
    penalties,
    forfeited: [guilty],
    calledOut: { by, accused, correct },
    dominoedBy: null,
    capicu: false,
    remaining,
    nextStarter: nextStarterFor(round, remaining, {
      kind: 'calledOut',
      winningTeam: clean,
      dominoedBy: null,
    }),
  };

  const outcome = matchOutcome(match.rules, scores);
  return {
    match: {
      ...match,
      round,
      scores,
      phase: outcome.over ? 'matchOver' : 'roundOver',
      lastResult: result,
      winner: outcome.winner,
      drawn: outcome.drawn,
    },
    result,
    note: describeResult(result),
  };
}

function applyFalsePassPenalty(
  rules: HouseRules,
  falsePasses: readonly PassRecord[],
  awarded: [number, number],
  penalties: [number, number],
): Team[] {
  if (falsePasses.length === 0 || rules.falsePassPenalty <= 0) return [];

  const guilty = ([0, 1] as Team[]).filter((t) =>
    falsePasses.some((p) => teamOf(p.seat) === t),
  );

  if (!rules.falsePassForfeits) {
    // The older, softer rule: one payment per false pass, round still scores.
    for (const pass of falsePasses) {
      const opponents = (1 - teamOf(pass.seat)) as Team;
      penalties[opponents] += rules.falsePassPenalty;
      awarded[opponents] += rules.falsePassPenalty;
    }
    return [];
  }

  awarded[0] = 0;
  awarded[1] = 0;
  for (const team of [0, 1] as Team[]) {
    if (guilty.includes(team)) continue;
    if (!guilty.includes((1 - team) as Team)) continue;
    penalties[team] += rules.falsePassPenalty;
    awarded[team] += rules.falsePassPenalty;
  }
  return guilty;
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

  const awarded: [number, number] = [0, 0];

  // What winning the round itself is worth. A capicu is worth more: under
  // round scoring it replaces the single point outright.
  const capicuCounts = capicu && rules.capicuPoints > 0;
  if (winningTeam !== null) {
    if (rules.scoring === 'rounds') {
      awarded[winningTeam] += capicuCounts ? rules.capicuPoints : 1;
    } else {
      awarded[winningTeam] +=
        scoreFor(rules, remaining, winningTeam) + (capicuCounts ? rules.capicuPoints : 0);
    }
  }

  // Now the hands are face up, so every pass can be judged.
  const falsePasses = round.passLog.filter((p) => p.couldHavePlayed);
  const penalties: [number, number] = [0, 0];
  const forfeited = applyFalsePassPenalty(rules, falsePasses, awarded, penalties);

  const nextStarter = nextStarterFor(round, remaining, { kind, winningTeam, dominoedBy });

  const scores: [number, number] = [match.scores[0] + awarded[0], match.scores[1] + awarded[1]];

  const result: RoundResult = {
    kind,
    winningTeam,
    points: awarded[0] + awarded[1],
    awarded,
    falsePasses,
    penalties,
    forfeited,
    calledOut: null,
    dominoedBy,
    capicu: capicuCounts,
    remaining,
    nextStarter,
  };

  const outcome = matchOutcome(rules, scores);

  return {
    match: {
      ...match,
      round,
      scores,
      phase: outcome.over ? 'matchOver' : 'roundOver',
      lastResult: result,
      winner: outcome.winner,
      drawn: outcome.drawn,
    },
    result,
    note: describeResult(result),
  };
}

export interface MatchOutcome {
  /** True once the match is finished, won or drawn. */
  readonly over: boolean;
  readonly winner: Team | null;
  readonly drawn: boolean;
}

/**
 * How the match stands.
 *
 * The drawn line is checked first and ends the match on the spot: the moment
 * the second team reaches it, both sides are on the line and the game is
 * level. A team therefore only wins outright by reaching the target while the
 * other is still below the line — the race is to get clear before they catch
 * up, not merely to arrive first.
 */
export function matchOutcome(
  rules: HouseRules,
  scores: readonly [number, number],
): MatchOutcome {
  const [a, b] = scores;
  const low = Math.min(a, b);

  if (rules.drawAt !== null && low >= rules.drawAt) {
    return { over: true, winner: null, drawn: true };
  }

  const margin = Math.max(1, rules.winBy);
  if (a >= rules.targetScore && a - b >= margin) return { over: true, winner: 0, drawn: false };
  if (b >= rules.targetScore && b - a >= margin) return { over: true, winner: 1, drawn: false };
  return { over: false, winner: null, drawn: false };
}

/** Convenience wrapper: the winning team, or null when not won. */
export function matchWinner(
  rules: HouseRules,
  scores: readonly [number, number],
): Team | null {
  return matchOutcome(rules, scores).winner;
}

export function describeResult(r: RoundResult): string {
  const parts: string[] = [];
  const named = (t: Team): string => (t === 0 ? 'Team A' : 'Team B');

  if (r.kind === 'calledOut') {
    const call = r.calledOut;
    if (call !== null) {
      parts.push(
        call.correct
          ? `Seat ${call.by} called out seat ${call.accused} — and was right.`
          : `Seat ${call.by} called out seat ${call.accused} — and was wrong.`,
      );
    }
  } else if (r.kind === 'tie') {
    parts.push('Round blocked with the teams level — no points for the round.');
  } else {
    const team = named(r.winningTeam === 0 ? 0 : 1);
    const won = r.winningTeam === null ? 0 : r.awarded[r.winningTeam] - r.penalties[r.winningTeam];
    if (r.kind === 'domino') {
      const capicu = r.capicu ? ' with a capicu' : '';
      parts.push(`Seat ${r.dominoedBy} went out${capicu} — ${team} takes the round (+${won}).`);
    } else {
      parts.push(`Round blocked — ${team} had fewer pips and takes the round (+${won}).`);
    }
  }

  if (r.forfeited.length > 0) {
    const lost = r.forfeited.map(named).join(' and ');
    const also = r.kind === 'domino' ? ', going out or not' : '';
    parts.push(`${lost} passed on a playable tile and scored nothing${also}.`);
  }
  if (r.falsePasses.length > 0 && r.kind !== 'calledOut') {
    const who = r.falsePasses.map((p) => `seat ${p.seat}`).join(', ');
    parts.push(`Caught when the hands came up: ${who}.`);
  }
  if (r.penalties[0] > 0 || r.penalties[1] > 0) {
    parts.push(`Penalty — Team A +${r.penalties[0]}, Team B +${r.penalties[1]}.`);
  }
  return parts.join(' ');
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
