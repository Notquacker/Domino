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
  /** A computer player rather than a person. */
  readonly bot: boolean;
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
  /** The tile that opened the round, which the board is laid out around. */
  readonly openerTile: TileId | null;
  readonly ends: { readonly left: Pip; readonly right: Pip } | null;
  readonly turn: Seat | null;
  /**
   * Seats that have passed at least once this round. Public — everyone saw it
   * happen — and it is what you pick from when calling someone out. Whether a
   * pass was false stays hidden until it is punished.
   */
  readonly passedSeats: readonly Seat[];
  readonly scores: readonly [number, number];
  readonly roundNumber: number;
  /**
   * Whether it is your turn to act. Deliberately NOT a list of legal moves:
   * working out what you can play is part of the game, so the server does not
   * hand it over. Attempt a move and it is accepted or refused.
   */
  readonly youMayMove: boolean;
  /**
   * What every seat was left holding, once the round is over — by seat, your
   * own included. Null while a round is still being played.
   *
   * Dominoes is a hidden-information game and the server never sends another
   * player's tiles during play; an end-to-end test holds it to that. Once the
   * round has finished they are not secret any more — counting them is how
   * the round is settled — and seeing who was stuck with what is half of
   * talking about the hand afterwards.
   */
  readonly reveal: readonly (readonly TileId[])[] | null;
  readonly lastResult: RoundResult | null;
  readonly winner: Team | null;
  /** True when the match finished level on the drawn line. */
  readonly drawn: boolean;
  /**
   * True when you have earned a smash and not yet used it: your team took the
   * round with a capicú. The server is the judge, so the button cannot be
   * conjured up by a tampered client.
   */
  readonly smashReady: boolean;
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
  /** Host only, lobby only: seat a computer player in the first free seat. */
  | { readonly t: 'addBot' }
  | { readonly t: 'removeBot'; readonly seat: Seat }
  | { readonly t: 'stand' }
  | { readonly t: 'start' }
  | { readonly t: 'move'; readonly move: Move }
  | { readonly t: 'nextRound' }
  | { readonly t: 'rematch' }
  | { readonly t: 'chat'; readonly text: string }
  /** Slam the table after taking a round with a capicú. */
  | { readonly t: 'smash' }
  /** Accuse an opponent of having passed while holding a playable tile. */
  | { readonly t: 'callOut'; readonly seat: Seat }
  /** Host only, and only with a computer player at the table: bin the match. */
  | { readonly t: 'abandon' }
  | { readonly t: 'ping' }
  // --- accounts, for the leaderboard --------------------------------------
  | { readonly t: 'register'; readonly username: string; readonly password: string }
  | { readonly t: 'login'; readonly username: string; readonly password: string }
  /** Sign back in with a token kept from a previous visit. */
  | { readonly t: 'restore'; readonly token: string }
  | { readonly t: 'logout' }
  | { readonly t: 'changePassword'; readonly current: string; readonly next: string }
  | { readonly t: 'leaderboard' }
  // --- admin only ----------------------------------------------------------
  | { readonly t: 'adminUsers' }
  | { readonly t: 'adminSetPassword'; readonly username: string; readonly next: string }
  | { readonly t: 'adminSetWins'; readonly username: string; readonly wins: number }
  | { readonly t: 'adminSetAdmin'; readonly username: string; readonly isAdmin: boolean }
  | { readonly t: 'adminDelete'; readonly username: string };

/** What a player may know about an account — never a hash, never a salt. */
export interface AccountInfo {
  readonly username: string;
  readonly isAdmin: boolean;
  readonly wins: number;
  readonly matches: number;
  /** An admin reset this password, so the owner should pick a new one. */
  readonly mustChangePassword: boolean;
}

export interface LeaderRow {
  readonly rank: number;
  readonly username: string;
  readonly wins: number;
  readonly matches: number;
}

export type ServerMessage =
  | {
      readonly t: 'account';
      /** Null when signed out. */
      readonly account: AccountInfo | null;
      /** Only sent on a fresh sign-in, for the client to keep. */
      readonly token?: string;
    }
  | { readonly t: 'leaders'; readonly rows: readonly LeaderRow[] }
  | { readonly t: 'adminUsers'; readonly users: readonly AccountInfo[] }
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
  | { readonly t: 'smashed'; readonly by: Seat; readonly name: string }
  | { readonly t: 'pong' };

export const TEAM_NAMES: readonly [string, string] = ['Team A', 'Team B'];

export function teamName(team: Team): string {
  return TEAM_NAMES[team];
}
