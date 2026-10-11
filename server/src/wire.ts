/**
 * Reading what comes in off the wire.
 *
 * Nothing a client sends is trusted, so each message is taken apart field by
 * field. This lives on its own because that reading is also where a field can
 * quietly go missing: the move parser once took the tile and the end and
 * dropped the direction, so every corner a player turned was laid straight
 * instead — a legal move, just not the one they made. A parser that can be
 * tested on its own is a parser whose fields can be checked.
 */

import { type Move, type Seat, RuleError, SEATS } from '@domino/shared';

export function parseSeat(value: unknown): Seat {
  const n = Number(value);
  if (!SEATS.includes(n as Seat)) throw new RuleError('no such seat');
  return n as Seat;
}

export function parseMove(value: unknown): Move {
  if (typeof value !== 'object' || value === null) throw new RuleError('malformed move');
  const raw = value as { kind?: unknown; tile?: unknown; end?: unknown; dir?: unknown };
  if (raw.kind === 'pass') return { kind: 'pass' };
  if (raw.kind === 'play') {
    if (typeof raw.tile !== 'string') throw new RuleError('malformed move');
    if (raw.end !== 'left' && raw.end !== 'right') throw new RuleError('malformed move');
    // Which way the player laid it. Leaving it out is fine — the table then
    // carries the chain straight on — but a direction that is there must be
    // one of the four, and the rules still decide whether it is free.
    if (raw.dir === undefined || raw.dir === null) {
      return { kind: 'play', tile: raw.tile, end: raw.end };
    }
    if (raw.dir !== 0 && raw.dir !== 1 && raw.dir !== 2 && raw.dir !== 3) {
      throw new RuleError('malformed move');
    }
    return { kind: 'play', tile: raw.tile, end: raw.end, dir: raw.dir };
  }
  throw new RuleError('malformed move');
}
