/**
 * What comes in off the wire.
 *
 * The server trusts nothing a client sends, so every message is read field by
 * field. That reading is also where a field can go missing without anybody
 * noticing: the move parser once took the tile and the end and quietly
 * dropped the direction, so every corner a player turned was laid straight
 * instead. Nothing failed — the move was legal, just not the one they made.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMove } from '../dist/wire.js';

describe('reading a move off the wire', () => {
  it('keeps the direction the player turned the tile', () => {
    for (const dir of [0, 1, 2, 3] as const) {
      assert.deepEqual(parseMove({ kind: 'play', tile: '3-4', end: 'right', dir }), {
        kind: 'play',
        tile: '3-4',
        end: 'right',
        dir,
      });
    }
  });

  it('takes a move with no direction, which lays it straight on', () => {
    const move = parseMove({ kind: 'play', tile: '3-4', end: 'left' });
    assert.deepEqual(move, { kind: 'play', tile: '3-4', end: 'left' });
    assert.ok(!('dir' in move), 'no direction at all, rather than a made-up one');
    // A client that sends null means the same thing.
    assert.deepEqual(parseMove({ kind: 'play', tile: '3-4', end: 'left', dir: null }), {
      kind: 'play',
      tile: '3-4',
      end: 'left',
    });
  });

  it('refuses a direction that is not one of the four', () => {
    for (const dir of [4, -1, 7, 1.5, '1', true, {}, []]) {
      assert.throws(
        () => parseMove({ kind: 'play', tile: '3-4', end: 'right', dir }),
        /malformed move/,
        `dir ${JSON.stringify(dir)} should have been refused`,
      );
    }
  });

  it('still refuses the rest of a malformed move', () => {
    assert.throws(() => parseMove(null), /malformed move/);
    assert.throws(() => parseMove({ kind: 'play', tile: 3, end: 'right' }), /malformed move/);
    assert.throws(() => parseMove({ kind: 'play', tile: '3-4', end: 'up' }), /malformed move/);
    assert.throws(() => parseMove({ kind: 'shout' }), /malformed move/);
    assert.deepEqual(parseMove({ kind: 'pass' }), { kind: 'pass' });
  });
});
