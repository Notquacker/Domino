/** DOM rendering for domino tiles: real pip patterns, not numbers. */

import type { BoardTile, TileId } from '@domino/shared';
import { parseTile } from '@domino/shared';

/**
 * Pip positions in a 3x3 grid, numbered left-to-right, top-to-bottom:
 *   1 2 3
 *   4 5 6
 *   7 8 9
 */
const PIP_LAYOUT: Readonly<Record<number, readonly number[]>> = {
  0: [],
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function half(pips: number): HTMLElement {
  const face = el('span', 'half');
  const positions = PIP_LAYOUT[pips] ?? [];
  for (let i = 1; i <= 9; i++) {
    face.appendChild(el('span', positions.includes(i) ? 'pip' : undefined));
  }
  return face;
}

function tile(a: number, b: number, vertical: boolean, extra: string): HTMLElement {
  const node = el('div', `tile ${vertical ? 'v' : 'h'} ${extra}`);
  node.appendChild(half(a));
  node.appendChild(half(b));
  return node;
}

/** A tile as it sits on the table — doubles turned across the chain. */
export function boardTile(placed: BoardTile): HTMLElement {
  const isDouble = placed.left === placed.right;
  const node = tile(placed.left, placed.right, isDouble, 'board');
  node.dataset['tile'] = placed.id;
  node.setAttribute('aria-label', `${placed.left} ${placed.right}`);
  return node;
}

/** A tile in your hand, stood upright with the low half on top. */
export function handTile(id: TileId, state: 'playable' | 'dead' | 'sel'): HTMLElement {
  const t = parseTile(id);
  const node = tile(t.low, t.high, true, `inhand ${state}`);
  node.dataset['tile'] = id;
  node.setAttribute('role', 'button');
  node.setAttribute('aria-label', `${t.low} ${t.high}`);
  if (state !== 'dead') node.tabIndex = 0;
  return node;
}

/** Face-down placeholders for an opponent's hand. */
export function tileBacks(count: number): HTMLElement {
  const wrap = el('div', 'backs');
  for (let i = 0; i < Math.min(count, 7); i++) wrap.appendChild(el('span', 'back'));
  return wrap;
}
