/**
 * Where the tiles actually sit on the table.
 *
 * The chain used to be laid out by the client, which decided for itself when
 * to turn a corner. Players wanted to decide that themselves — dragging a
 * tile above, beside or below an end — so the direction each tile was laid in
 * is now part of the game state, and the shape is whatever the table made.
 *
 * That means the server has to know the geometry too: it is the only thing
 * that can refuse a placement which would drop a tile on top of another. So
 * the walk lives here, in integer grid units, and the client simply scales it
 * to pixels. One implementation, no chance of the two disagreeing.
 *
 * Units: a tile is SHORT (2) across and LONG (4) along. Those are doubled
 * from the obvious 1 and 2 so that a double, which lies crosswise and is
 * centred on its row, still lands on whole numbers.
 */

import { type TileId, isDouble } from './tiles.js';

/** Travel direction: right, down, left, up — in that order, so +1 turns. */
export type Dir = 0 | 1 | 2 | 3;

export const DIRS: readonly Dir[] = [0, 1, 2, 3];

/** Across the run. */
const SHORT = 2;
/** Along the run. */
const LONG = 4;

/** Unit step for each direction. */
const STEP: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** A tile's footprint on the table, in grid units. */
export interface Placement {
  /** Position in the chain, so tiles can be drawn in playing order. */
  readonly index: number;
  readonly id: TileId;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly dir: Dir;
  /** True when the tile stands on its short edge rather than lying flat. */
  readonly vertical: boolean;
  /** Which half faces the tile before it; see the note in the client. */
  readonly flipped: boolean;
}

export interface Board {
  readonly placements: readonly Placement[];
  readonly width: number;
  readonly height: number;
  /**
   * What was subtracted to bring the board to the origin. Raw coordinates are
   * anchored on the opening tile, so two boards that share an opener can be
   * lined up by their offsets — which is how a client draws a would-be
   * placement in the same frame as the tiles already down.
   */
  readonly offsetX: number;
  readonly offsetY: number;
}

/** How far a tile reaches along its run, and across it. */
function size(id: TileId): { along: number; across: number } {
  return isDouble(id)
    ? { along: SHORT, across: LONG }
    : { along: LONG, across: SHORT };
}

function isVertical(dir: Dir): boolean {
  return dir === 1 || dir === 3;
}

/**
 * Lay a tile with its near end at the cursor, and return where the next one
 * attaches.
 */
function put(
  id: TileId,
  index: number,
  dir: Dir,
  cx: number,
  cy: number,
  backward: boolean,
  out: Placement[],
): { x: number; y: number } {
  const { along, across } = size(id);
  const vertical = isVertical(dir);
  const x = dir === 2 ? cx - along : dir === 0 ? cx : cx - across / 2;
  const y = dir === 3 ? cy - along : dir === 1 ? cy : cy - across / 2;
  // Walking outward from the opener a tile meets its neighbour by its near
  // half; walking back the other way it meets by the far one. Getting this
  // wrong draws the board with mismatched pips touching.
  const nearIsSecondHalf = dir === 2 || dir === 3;
  out.push({
    index,
    id,
    x,
    y,
    w: vertical ? across : along,
    h: vertical ? along : across,
    dir,
    vertical,
    flipped: backward ? !nearIsSecondHalf : nearIsSecondHalf,
  });
  return {
    x: cx + (dir === 0 ? along : dir === 2 ? -along : 0),
    y: cy + (dir === 1 ? along : dir === 3 ? -along : 0),
  };
}

/**
 * Move the cursor round a corner.
 *
 * Left alone the turning tile would be centred on the previous tile's far
 * edge and lap back over it. Stepping back along the old direction by half
 * the new tile's width, and on along the new direction by half the old
 * tile's, sets the two corner to corner: touching, nothing stacked.
 */
function turnCursor(
  at: { x: number; y: number },
  from: Dir,
  to: Dir,
  oldAcross: number,
  newAcross: number,
): { x: number; y: number } {
  const o = STEP[from] as readonly [number, number];
  const n = STEP[to] as readonly [number, number];
  return {
    x: at.x - o[0] * (newAcross / 2) + n[0] * (oldAcross / 2),
    y: at.y - o[1] * (newAcross / 2) + n[1] * (oldAcross / 2),
  };
}

/** The tiles a board needs laid out, in the order they were played. */
export interface LaidTile {
  readonly id: TileId;
  readonly dir: Dir;
}

/**
 * Walk the chain and work out where every tile sits.
 *
 * `openerIndex` is where the first tile went down: the chain grows from it in
 * both directions, which is why a board is walked outward from the middle
 * rather than from one end.
 */
export function layout(input: readonly LaidTile[], openerIndex = 0): Board {
  const out: Placement[] = [];
  if (input.length === 0) {
    return { placements: out, width: 0, height: 0, offsetX: 0, offsetY: 0 };
  }

  // A board reaches the page over the wire, so a direction arriving missing
  // or out of range is possible however well typed this is. Reading it as
  // rightward draws a slightly odd chain; not reading it at all walks off the
  // end of STEP and takes the whole table down with it.
  const tiles = input.map((t) =>
    t.dir === 0 || t.dir === 1 || t.dir === 2 || t.dir === 3 ? t : { ...t, dir: 0 as Dir },
  );

  const opener = tiles[openerIndex] as LaidTile;
  let cursor = put(opener.id, openerIndex, opener.dir, 0, 0, false, out);
  let lastDir = opener.dir;
  let lastAcross = size(opener.id).across;

  for (let i = openerIndex + 1; i < tiles.length; i++) {
    const tile = tiles[i] as LaidTile;
    const across = size(tile.id).across;
    if (tile.dir !== lastDir) {
      cursor = turnCursor(cursor, lastDir, tile.dir, lastAcross, across);
    }
    cursor = put(tile.id, i, tile.dir, cursor.x, cursor.y, false, out);
    lastDir = tile.dir;
    lastAcross = across;
  }

  let back = { x: 0, y: 0 };
  // The left arm grows the opposite way from the opener, so that is what
  // "carrying straight on" means here. Comparing against the opener's own
  // direction would read the very first tile as a 180-degree corner and open
  // a gap where the two should meet.
  let backDir = ((opener.dir + 2) % 4) as Dir;
  let backAcross = size(opener.id).across;
  for (let i = openerIndex - 1; i >= 0; i--) {
    const tile = tiles[i] as LaidTile;
    const across = size(tile.id).across;
    if (tile.dir !== backDir) {
      back = turnCursor(back, backDir, tile.dir, backAcross, across);
    }
    back = put(tile.id, i, tile.dir, back.x, back.y, true, out);
    backDir = tile.dir;
    backAcross = across;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of out) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  const shifted = out
    .map((p) => ({ ...p, x: p.x - minX, y: p.y - minY }))
    .sort((a, b) => a.index - b.index);
  return {
    placements: shifted,
    width: maxX - minX,
    height: maxY - minY,
    offsetX: minX,
    offsetY: minY,
  };
}

/** Where a tile would land, in the frame of the board as it stands. */
export interface Slot {
  readonly end: 'left' | 'right';
  readonly dir: Dir;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Every place this tile could go, given where the chain already is.
 *
 * Positions come back in the same frame as `layout(tiles, openerIndex)`, so a
 * client can draw them straight onto the board it has already drawn. That
 * works because raw coordinates are anchored on the opening tile: lining the
 * two up is just a matter of subtracting their offsets.
 */
export function slotsFor(
  tiles: readonly LaidTile[],
  openerIndex: number,
  id: TileId,
  ends: readonly ('left' | 'right')[] = ['left', 'right'],
): Slot[] {
  const here = layout(tiles, openerIndex);
  const slots: Slot[] = [];
  for (const end of ends) {
    for (const dir of directionsAt(tiles, openerIndex, id, end)) {
      const next: LaidTile[] =
        end === 'right' ? [...tiles, { id, dir }] : [{ id, dir }, ...tiles];
      const opener = end === 'right' ? openerIndex : openerIndex + 1;
      const freshIndex = end === 'right' ? next.length - 1 : 0;
      const laidOut = layout(next, opener);
      const fresh = laidOut.placements.find((p) => p.index === freshIndex);
      if (fresh === undefined) continue;
      slots.push({
        end,
        dir,
        // Back to raw, then into the frame of the board as it stands.
        x: fresh.x + laidOut.offsetX - here.offsetX,
        y: fresh.y + laidOut.offsetY - here.offsetY,
        w: fresh.w,
        h: fresh.h,
      });
    }
  }
  return slots;
}

/** Do two footprints share any ground? Touching edges do not count. */
export function overlaps(a: Placement, b: Placement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Does this board lie flat, with nothing on top of anything? */
export function isSound(board: Board): boolean {
  const { placements } = board;
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      if (overlaps(placements[i] as Placement, placements[j] as Placement)) return false;
    }
  }
  return true;
}

/**
 * Would one more tile fit, given a board already known to be sound?
 *
 * Checking the newcomer against the rest is linear, where re-checking every
 * pair is not. This runs for every candidate move the rules offer, so the
 * difference is worth having.
 */
function newcomerFits(board: Board, index: number): boolean {
  const { placements } = board;
  const fresh = placements.find((p) => p.index === index);
  if (fresh === undefined) return false;
  for (const other of placements) {
    if (other.index === index) continue;
    if (overlaps(fresh, other)) return false;
  }
  return true;
}

/**
 * The directions a tile may be laid in at one end of the chain.
 *
 * Three things rule a direction out. You cannot doubly back on yourself — the
 * chain would run straight back through itself. You cannot turn immediately
 * after a double, which lies crosswise already and would be folded through.
 * And you cannot land on a tile that is already there, which is the whole
 * reason this has to be worked out rather than assumed.
 *
 * This says nothing about which tiles fit which pips, so it gives away
 * nothing about anybody's hand.
 */
/**
 * Which way this end of the chain is growing — "straight on" from here.
 *
 * Every tile's dir points outward from the opener, so for most of the chain
 * this is simply the end tile's own direction. The exception is the left end
 * while it is still the opening tile: the opener lies rightward by
 * convention, and the left arm travels the opposite way.
 */
export function outwardDir(
  tiles: readonly LaidTile[],
  openerIndex: number,
  end: 'left' | 'right',
): Dir {
  if (tiles.length === 0) return 0;
  if (end === 'right') return (tiles[tiles.length - 1] as LaidTile).dir;
  const first = tiles[0] as LaidTile;
  return openerIndex === 0 ? (((first.dir + 2) % 4) as Dir) : first.dir;
}

export function directionsAt(
  tiles: readonly LaidTile[],
  openerIndex: number,
  id: TileId,
  end: 'left' | 'right',
): Dir[] {
  if (tiles.length === 0) return [0];
  const neighbour = (end === 'right' ? tiles[tiles.length - 1] : tiles[0]) as LaidTile;
  const away = outwardDir(tiles, openerIndex, end);
  const back = ((away + 2) % 4) as Dir;

  return DIRS.filter((dir) => {
    if (dir === back) return false;
    // A double lies across the chain rather than along it, so it has no end
    // to turn a corner with. Let it and it comes to rest flat against its
    // neighbour, long edge to long edge, with the halves that are supposed
    // to match never touching at all. A double is laid across the line and
    // the line carries straight on through it; the tile after it does the
    // turning.
    if (dir !== away && isDouble(id)) return false;
    // And a corner on the tile straight after a double folds back through a
    // tile that is already crosswise.
    if (dir !== away && isDouble(neighbour.id)) return false;
    const next: LaidTile[] =
      end === 'right' ? [...tiles, { id, dir }] : [{ id, dir }, ...tiles];
    const opener = end === 'right' ? openerIndex : openerIndex + 1;
    const freshIndex = end === 'right' ? next.length - 1 : 0;
    return newcomerFits(layout(next, opener), freshIndex);
  });
}

/**
 * Could this tile go down at this end at all?
 *
 * Matching the pips is no longer enough: with the players choosing the shape,
 * a chain can curl round and leave an end with nowhere to go. A tile that
 * fits the number but has no room is not a playable move, and the rules have
 * to know that or the board would end up with tiles stacked on each other.
 */
export function hasRoomAt(
  tiles: readonly LaidTile[],
  openerIndex: number,
  id: TileId,
  end: 'left' | 'right',
): boolean {
  return directionsAt(tiles, openerIndex, id, end).length > 0;
}
