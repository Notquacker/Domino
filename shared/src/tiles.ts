/**
 * Tile primitives for a double-six domino set.
 *
 * A tile is identified on the wire by a stable string id `"low-high"` where
 * `low <= high`, so `"2-5"` and `"5-2"` are never both valid. Orientation is a
 * property of where a tile sits on the board, never of the tile itself.
 */

export type Pip = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const PIPS: readonly Pip[] = [0, 1, 2, 3, 4, 5, 6];

export interface Tile {
  readonly low: Pip;
  readonly high: Pip;
}

export type TileId = string;

export const DOUBLE_SIX: TileId = '6-6';

/** Tiles dealt to each player in the 4-handed partnership game (28 / 4). */
export const HAND_SIZE = 7;

export function tileId(low: Pip, high: Pip): TileId {
  return low <= high ? `${low}-${high}` : `${high}-${low}`;
}

export function makeTile(a: Pip, b: Pip): Tile {
  return a <= b ? { low: a, high: b } : { low: b, high: a };
}

export function parseTile(id: TileId): Tile {
  const parts = id.split('-');
  if (parts.length !== 2) throw new Error(`malformed tile id: ${id}`);
  const low = Number(parts[0]);
  const high = Number(parts[1]);
  if (!isPip(low) || !isPip(high) || low > high) {
    throw new Error(`malformed tile id: ${id}`);
  }
  return { low, high };
}

export function isPip(n: number): n is Pip {
  return Number.isInteger(n) && n >= 0 && n <= 6;
}

export function isDouble(id: TileId): boolean {
  const t = parseTile(id);
  return t.low === t.high;
}

/** Pip total of a single tile. */
export function tilePips(id: TileId): number {
  const t = parseTile(id);
  return t.low + t.high;
}

/** Pip total of a set of tiles — the currency of domino scoring. */
export function handPips(ids: readonly TileId[]): number {
  return ids.reduce((sum, id) => sum + tilePips(id), 0);
}

/** All 28 tiles of a double-six set, in canonical order. */
export function fullSet(): TileId[] {
  const out: TileId[] = [];
  for (const low of PIPS) {
    for (const high of PIPS) {
      if (low <= high) out.push(tileId(low, high));
    }
  }
  return out;
}

/** Does this tile carry the given pip value on either half? */
export function tileHas(id: TileId, pip: Pip): boolean {
  const t = parseTile(id);
  return t.low === pip || t.high === pip;
}

export type Rng = () => number;

/**
 * mulberry32 — small, fast, and seedable so that tests can replay an exact
 * shuffle. Not cryptographic; the server seeds it from `crypto` instead.
 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, returning a new array and leaving the input untouched. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
