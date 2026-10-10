/**
 * Optional Supabase integration: identity and match history.
 *
 * Two hard rules shape this file.
 *
 * 1. It is optional. With no `SUPABASE_URL` set, every method is a no-op and
 *    the game behaves exactly as it does without accounts. Guests keep playing.
 * 2. It is never load-bearing. Supabase being slow, down or misconfigured must
 *    not stall or break a match, so every call is time-boxed and swallows its
 *    own errors. Losing a history row is acceptable; dropping a game is not.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

const REQUEST_TIMEOUT_MS = 5000;

export interface AuthedUser {
  readonly id: string;
  readonly isAnonymous: boolean;
}

export interface MatchPlayerRecord {
  readonly seat: number;
  readonly player_id: string | null;
  readonly display_name: string;
  readonly team: number;
  readonly won: boolean;
  readonly pips_left: number;
}

export interface MatchRecord {
  readonly room_code: string;
  readonly rules: unknown;
  readonly target_score: number;
  readonly winning_team: number | null;
  readonly score_a: number;
  readonly score_b: number;
  readonly rounds_played: number;
  readonly started_at: string;
  readonly players: readonly MatchPlayerRecord[];
}

/** One row of the accounts table, exactly as Postgres stores it. */
export interface AccountRow {
  readonly id: string;
  readonly display: string;
  readonly salt: string;
  readonly hash: string;
  readonly is_admin: boolean;
  readonly wins: number;
  readonly matches: number;
  readonly must_change_password: boolean;
  readonly created_at: string;
}

export interface SupabaseOptions {
  readonly url: string;
  readonly serviceRoleKey: string;
  /**
   * Legacy projects sign JWTs with a shared HS256 secret. Newer ones use
   * asymmetric keys published at the JWKS endpoint. If this is set we verify
   * with it; otherwise we verify against JWKS.
   */
  readonly jwtSecret?: string | undefined;
}

export class Supabase {
  readonly enabled: boolean;
  private readonly url: string;
  private readonly serviceRoleKey: string;
  private readonly hmacKey: Uint8Array | null;
  private readonly jwks: JWTVerifyGetKey | null;

  constructor(options: SupabaseOptions | null) {
    if (options === null) {
      this.enabled = false;
      this.url = '';
      this.serviceRoleKey = '';
      this.hmacKey = null;
      this.jwks = null;
      return;
    }
    this.enabled = true;
    this.url = options.url.replace(/\/+$/, '');
    this.serviceRoleKey = options.serviceRoleKey;
    this.hmacKey = options.jwtSecret
      ? new TextEncoder().encode(options.jwtSecret)
      : null;
    this.jwks =
      this.hmacKey === null
        ? createRemoteJWKSet(new URL(`${this.url}/auth/v1/.well-known/jwks.json`))
        : null;
  }

  /** Build from the process environment, or null when not configured. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Supabase {
    const url = env['SUPABASE_URL'];
    const serviceRoleKey = env['SUPABASE_SERVICE_ROLE_KEY'];
    if (!url || !serviceRoleKey) return new Supabase(null);
    return new Supabase({ url, serviceRoleKey, jwtSecret: env['SUPABASE_JWT_SECRET'] });
  }

  /**
   * Verify a Supabase access token and extract the user it belongs to.
   * Returns null for anything that does not verify — expired, tampered with,
   * wrong issuer, or signed by a key we do not trust.
   */
  async verify(jwt: string): Promise<AuthedUser | null> {
    if (!this.enabled || typeof jwt !== 'string' || jwt.length === 0) return null;
    const expectations = {
      issuer: `${this.url}/auth/v1`,
      audience: 'authenticated',
    };
    try {
      let payload: JWTPayload;
      if (this.hmacKey !== null) {
        ({ payload } = await jwtVerify(jwt, this.hmacKey, expectations));
      } else {
        ({ payload } = await jwtVerify(jwt, this.jwks as JWTVerifyGetKey, expectations));
      }
      const id = payload.sub;
      if (typeof id !== 'string' || id.length === 0) return null;
      // Supabase marks anonymous sessions with this claim; absent means a real
      // account, which is the safer assumption to get wrong in that direction.
      const anonymous = payload['is_anonymous'];
      return { id, isAnonymous: anonymous === true };
    } catch {
      return null;
    }
  }

  /** Keep the stored profile in step with the name used at the table. */
  async upsertProfile(user: AuthedUser, displayName: string): Promise<void> {
    await this.rpc('upsert_profile', {
      p_id: user.id,
      p_name: displayName,
      p_anonymous: user.isAnonymous,
    });
  }

  /** Write a finished match and its four seats, atomically, server-side. */
  async recordMatch(record: MatchRecord): Promise<void> {
    await this.rpc('record_match', { payload: record });
  }

  // -- leaderboard accounts --------------------------------------------------
  //
  // These do NOT swallow their errors, unlike everything above. A lost match
  // history row costs a line in a table nobody is looking at; a lost password
  // change locks someone out of their account the next time the server
  // restarts. The caller is told, so it can tell the player.

  async loadAccounts(): Promise<AccountRow[]> {
    const res = await this.accountsFetch('?select=*', { method: 'GET' });
    return (await res.json()) as AccountRow[];
  }

  /** Insert or replace one account. */
  async putAccount(row: AccountRow): Promise<void> {
    await this.accountsFetch('', {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });
  }

  async deleteAccount(id: string): Promise<void> {
    await this.accountsFetch(`?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  private async accountsFetch(
    query: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    if (!this.enabled) throw new Error('Supabase is not configured');
    const res = await fetch(`${this.url}/rest/v1/domino_accounts${query}`, {
      method: init.method,
      headers: {
        'content-type': 'application/json',
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // The body can echo the row back, so never put it in an error a player
      // might see. The status is enough to act on.
      throw new Error(`accounts store returned ${res.status}`);
    }
    return res;
  }

  /**
   * Call a Postgres function with the service role key. Returns quietly on any
   * failure: history is a nice-to-have, the live game is not.
   */
  private async rpc(fn: string, body: unknown): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(`[domino] supabase ${fn} failed: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.warn(`[domino] supabase ${fn} unreachable:`, (err as Error).message);
    }
  }
}
