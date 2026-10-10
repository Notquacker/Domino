/**
 * Wire protocol between client and server.
 *
 * The important property: a `PlayerView` carries only what its recipient is
 * entitled to know — their own hand, the public board, and tile *counts* for
 * everyone else. Other players' hands never leave the server.
 */

import type { BoardTile, HouseRules, Move, Phase, RoundResult, Seat, Team } from './rules.js';
export type { Move };
import type { Pip, TileId } from './tiles.js';

export const PROTOCOL_VERSION = 1;

export interface SeatInfo {
  readonly name: string;
  readonly connected: boolean;
  /** Tiles still in hand — public information in dominoes. */
  readonly tiles: number;
}

export type RoomPhase = 'lobby' | Phase;

export interface PlayerView {
  readonly v: number;
  readonly code: string;
  readonly phase: RoomPhase;
  readonly rules: HouseRules;
  /** Your seat, or null if you are watching. */
  readonly you: Seat | null;
  readonly isHost: boolean;
  readonly seats: readonly (SeatInfo | null)[];
  /** Your tiles. Never anyone else's. */
  readonly hand: readonly TileId[];
  readonly board: readonly BoardTile[];
  readonly ends: { readonly left: Pip; readonly right: Pip } | null;
  readonly turn: Seat | null;
  readonly scores: readonly [number, number];
  readonly roundNumber: number;
  /**
   * Whether it is your turn to act. Deliberately NOT a list of legal moves:
   * working out what you can play is part of the game, so the server does not
   * hand it over. Attempt a move and it is accepted or refused.
   */
  readonly youMayMove: boolean;
  readonly lastResult: RoundResult | null;
  readonly winner: Team | null;
  /** True when the match finished level on the drawn line. */
  readonly drawn: boolean;
  readonly log: readonly string[];
  /** Epoch ms by which the player on turn must move, or null if untimed. */
  readonly turnDeadline: number | null;
  readonly spectators: number;
  /** True once the server has verified a Supabase token for this connection. */
  readonly authed: boolean;
}

export type ClientMessage =
  /**
   * Present a Supabase access token. Optional: without it the player is a
   * guest, which works exactly as before but earns no stats.
   */
  | { readonly t: 'auth'; readonly jwt: string }
  | { readonly t: 'create'; readonly name: string; readonly rules?: Partial<HouseRules> }
  | { readonly t: 'join'; readonly code: string; readonly name: string }
  | { readonly t: 'resume'; readonly code: string; readonly token: string }
  | { readonly t: 'sit'; readonly seat: Seat }
  | { readonly t: 'stand' }
  | { readonly t: 'start' }
  | { readonly t: 'move'; readonly move: Move }
  | { readonly t: 'nextRound' }
  | { readonly t: 'rematch' }
  | { readonly t: 'chat'; readonly text: string }
  | { readonly t: 'ping' };

export type ServerMessage =
  | {
      readonly t: 'welcome';
      readonly code: string;
      /** Opaque credential for reconnecting to the same seat. */
      readonly token: string;
      readonly view: PlayerView;
    }
  | { readonly t: 'state'; readonly view: PlayerView }
  | { readonly t: 'chat'; readonly from: string; readonly text: string; readonly at: number }
  | { readonly t: 'error'; readonly message: string }
  | { readonly t: 'authed'; readonly ok: boolean; readonly anonymous: boolean }
  | { readonly t: 'pong' };

export const TEAM_NAMES: readonly [string, string] = ['Team A', 'Team B'];

export function teamName(team: Team): string {
  return TEAM_NAMES[team];
}
