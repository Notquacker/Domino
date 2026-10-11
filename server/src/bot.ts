/**
 * Computer players.
 *
 * The boundary matters more than the strategy here. A bot runs inside the
 * server, where every hand is in reach, so the only thing stopping it from
 * cheating is what we hand it. `chooseMove` therefore takes a `BotContext`
 * that carries the bot's OWN hand and nothing but public information — the
 * board, the tile counts, and what the passes have given away. It never sees
 * `RoundState`, so it cannot read another player's tiles even by accident.
 *
 * The legal moves are passed in rather than derived, for the same reason:
 * `legalMoves` reads only the seat's own hand, so its result is safe to hand
 * over, and the bot never needs the round to work out what it may play.
 */

import {
  type BoardTile,
  type Dir,
  type End,
  type HouseRules,
  type Move,
  type Pip,
  type Seat,
  type TileId,
  directionsAt,
  isDouble,
  outwardDir,
  laidTiles,
  layout,
  openerIndexOf,
  parseTile,
  teamOf,
  tileHas,
  tilePips,
} from '@domino/shared';

/** Everything a bot is allowed to know. */
export interface BotContext {
  readonly seat: Seat;
  /** The bot's own tiles — the one piece of hidden state it is entitled to. */
  readonly hand: readonly TileId[];
  readonly board: readonly BoardTile[];
  /** Which tile opened, so the bot can work out the shape on the table. */
  readonly openerTile: TileId | null;
  readonly ends: { readonly left: Pip; readonly right: Pip } | null;
  /** Tiles still held, by seat. Public: everyone can count them. */
  readonly tilesLeft: readonly number[];
  /**
   * Pips each seat has shown they cannot match, by seat. Public too: a pass
   * is made in the open, and the ends at that moment were on the table for
   * everyone to see. Tracking it is ordinary good play, not peeking.
   */
  readonly voids: readonly (readonly Pip[])[];
  /**
   * Seats proven to have passed on a playable tile, from public play alone —
   * see `provenFalsePass`. Not a guess and not a peek at anyone's hand.
   */
  readonly caught: readonly Seat[];
  readonly rules: HouseRules;
}

/**
 * Does playing this tile prove the seat's earlier pass was false?
 *
 * The whole set is dealt and there is no boneyard, so a player holds every
 * tile they will ever hold from the moment of the deal. If they passed while
 * the ends showed 2 and 5, and later lay a tile with a 2 on it, they must
 * have been holding that tile when they passed — and a 2 was sitting right
 * there. Nobody had to see their hand to know it.
 */
export function provenFalsePass(tile: TileId, passedOn: readonly Pip[]): boolean {
  return passedOn.some((pip) => tileHas(tile, pip));
}

/**
 * Which opponent, if any, this bot should call out. It only ever accuses on
 * proof: a wrong accusation costs its own team the round, so guessing is
 * worse than saying nothing.
 */
export function shouldCallOut(ctx: BotContext): Seat | null {
  for (const seat of ctx.caught) {
    if (teamOf(seat) !== teamOf(ctx.seat)) return seat;
  }
  return null;
}

/** Where the ends land if this tile goes down on this side. */
function endsAfter(
  ctx: BotContext,
  tile: TileId,
  end: 'left' | 'right',
): { left: Pip; right: Pip } {
  const t = parseTile(tile);
  if (ctx.ends === null) return { left: t.low, right: t.high };
  if (end === 'left') {
    // The pip that matches goes inward; the other becomes the new outer end.
    const outer = t.low === ctx.ends.left ? t.high : t.low;
    return { left: outer, right: ctx.ends.right };
  }
  const outer = t.low === ctx.ends.right ? t.high : t.low;
  return { left: ctx.ends.left, right: outer };
}

function isVoidOn(ctx: BotContext, seat: Seat, pip: Pip): boolean {
  return (ctx.voids[seat] ?? []).includes(pip);
}

/**
 * How good this play looks. Higher is better. The weights are deliberately
 * mild: the bot should be a decent table partner, not an oracle.
 */
function scorePlay(ctx: BotContext, tile: TileId, end: 'left' | 'right'): number {
  const rest = ctx.hand.filter((t) => t !== tile);

  // Going out ends the round in our favour. Nothing else comes close.
  if (rest.length === 0) return 10_000;

  let score = 0;

  // Shed weight. If the round gets blocked the pips left in hand are what
  // costs, and heavy tiles are the hardest to place later.
  score += tilePips(tile) * 1.2;

  // Doubles only ever match one number, so they strand easily. Lead them out.
  if (isDouble(tile)) score += 5;

  const after = endsAfter(ctx, tile, end);

  // Keep control: prefer leaving ends we can still answer ourselves.
  for (const t of rest) {
    if (tileHas(t, after.left)) score += 2;
    if (tileHas(t, after.right)) score += 2;
  }

  // Shut the opponents out where we know they are void, and avoid doing the
  // same to our own partner.
  const partner = ((ctx.seat + 2) % 4) as Seat;
  for (const other of [0, 1, 2, 3] as Seat[]) {
    if (other === ctx.seat) continue;
    const opposed = teamOf(other) !== teamOf(ctx.seat);
    for (const pip of [after.left, after.right]) {
      if (!isVoidOn(ctx, other, pip)) continue;
      score += opposed ? 6 : other === partner ? -6 : 0;
    }
  }

  // An opponent down to their last tile or two is about to go out; dumping
  // weight matters more than finesse at that point.
  const pressure = ([0, 1, 2, 3] as Seat[]).some(
    (s) => teamOf(s) !== teamOf(ctx.seat) && (ctx.tilesLeft[s] ?? 7) <= 2,
  );
  if (pressure) score += tilePips(tile) * 1.5;

  return score;
}

/**
 * Pick a move. `moves` must be the legal moves for this bot's seat; passing
 * is chosen only when the rules offer nothing else, so a bot never takes the
 * false-pass penalty.
 */
/**
 * How far an arm may run before a bot folds it round a corner.
 *
 * A tile is four grid units long, so this is about seven tiles — roughly what
 * fits across a phone. Nothing stops a bot laying a straight line of all
 * twenty-eight, but then everyone is looking at a chain the width of four
 * screens, shrunk to nothing. Folding is what people do with a real set on a
 * real table, for the same reason.
 */
const TIDY_SPAN = 28;

/**
 * Which way to lay the tile.
 *
 * Shape is the players' choice now, so a bot has to make one. It carries
 * straight on while the board is still a comfortable size and turns a corner
 * once the arm has run far enough, picking whichever direction leaves the
 * tidiest board. Returns undefined when there is nothing to choose.
 */
function tidyDir(ctx: BotContext, tile: TileId, end: End): Dir | undefined {
  const laid = laidTiles(ctx.board);
  const openerAt = openerIndexOf(ctx.board, ctx.openerTile);
  const allowed = directionsAt(laid, openerAt, tile, end);
  if (allowed.length < 2) return allowed[0];

  // How big the board would be, laid each way. Measuring the real layout
  // beats guessing: it already knows how doubles sit and how corners turn.
  const span = (dir: Dir): number => {
    const next: { id: TileId; dir: Dir }[] =
      end === 'right' ? [...laid, { id: tile, dir }] : [{ id: tile, dir }, ...laid];
    const opener = end === 'right' ? openerAt : openerAt + 1;
    const out = layout(next, opener);
    return Math.max(out.width, out.height);
  };

  let best = allowed[0] as Dir;
  let bestSpan = Infinity;
  for (const dir of allowed) {
    const size = span(dir);
    if (size < bestSpan) {
      bestSpan = size;
      best = dir;
    }
  }
  // While the board is still small, prefer carrying straight on even if a
  // corner would be a shade tidier — a zigzag every tile looks restless.
  // Straight on is not allowed[0]: the directions come back in compass
  // order, so it has to be asked for by name.
  const straight = outwardDir(laid, openerAt, end);
  if (allowed.includes(straight) && span(straight) <= TIDY_SPAN) return straight;
  return best;
}

export function chooseMove(moves: readonly Move[], ctx: BotContext, jitter = 0): Move {
  const plays = moves.filter((m): m is Extract<Move, { kind: 'play' }> => m.kind === 'play');
  if (plays.length === 0) return { kind: 'pass' };
  if (plays.length === 1) {
    const only = plays[0] as Extract<Move, { kind: 'play' }>;
    return { ...only, ...dirOf(ctx, only) };
  }

  let best = plays[0] as Extract<Move, { kind: 'play' }>;
  let bestScore = -Infinity;
  for (const m of plays) {
    // The jitter keeps a bot from playing an identical game every time
    // without letting it pick a plainly worse tile.
    const score = scorePlay(ctx, m.tile, m.end) + jitter * Math.random();
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { ...best, ...dirOf(ctx, best) };
}

/** `{ dir }` to spread into a move, or nothing when there is no choice. */
function dirOf(ctx: BotContext, m: Extract<Move, { kind: 'play' }>): { dir?: Dir } {
  const dir = tidyDir(ctx, m.tile, m.end);
  return dir === undefined ? {} : { dir };
}

/** Names for the computer players, kept clearly apart from real ones. */
export const BOT_NAMES: readonly string[] = ['Kiko', 'Nena', 'Pichi', 'Shon'];
