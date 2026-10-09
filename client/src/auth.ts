/**
 * Supabase identity and stats, used only when the project is configured.
 *
 * Players sign in anonymously, so joining a table still costs nothing but a
 * name. The anonymous user is a real account underneath, which means a record
 * that survives a reload and can later be claimed with an email.
 *
 * Everything here returns an empty/neutral result when Supabase is absent, so
 * the UI needs no special cases for guest play.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

const URL_ = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const ANON_KEY = import.meta.env['VITE_SUPABASE_ANON_KEY'] as string | undefined;

export const accountsEnabled = Boolean(URL_ && ANON_KEY);

let clientPromise: Promise<SupabaseClient | null> | null = null;

/**
 * Load supabase-js on demand. It is by far the largest thing the client could
 * pull in, so a guest-only deployment should never download it: the import is
 * dynamic, which keeps it in its own chunk.
 */
function getClient(): Promise<SupabaseClient | null> {
  if (!accountsEnabled) return Promise.resolve(null);
  if (clientPromise === null) {
    clientPromise = import('@supabase/supabase-js')
      .then(({ createClient }) =>
        createClient(URL_ as string, ANON_KEY as string, {
          auth: { persistSession: true, autoRefreshToken: true },
        }),
      )
      .catch((err: unknown) => {
        console.warn('[domino] could not load Supabase:', (err as Error).message);
        return null;
      });
  }
  return clientPromise;
}

export interface Account {
  readonly id: string;
  readonly anonymous: boolean;
  readonly email: string | null;
}

export interface Stats {
  readonly played: number;
  readonly won: number;
  readonly winPercent: number;
}

export interface MatchSummary {
  readonly id: string;
  readonly finishedAt: string;
  readonly won: boolean;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly partner: string | null;
  readonly opponents: string[];
}

let signingIn: Promise<void> | null = null;

/**
 * Make sure a session exists, signing in anonymously the first time. Safe to
 * call repeatedly and concurrently — the work happens once.
 */
export async function ensureSession(displayName: string): Promise<void> {
  if (!accountsEnabled) return;
  if (signingIn !== null) return signingIn;
  signingIn = (async () => {
    try {
      const client = await getClient();
      if (client === null) return;
      const { data } = await client.auth.getSession();
      if (data.session !== null) return;
      const { error } = await client.auth.signInAnonymously({
        options: { data: { display_name: displayName } },
      });
      if (error !== null) {
        // Anonymous sign-ins may simply be switched off in the dashboard.
        console.warn('[domino] anonymous sign-in unavailable:', error.message);
      }
    } catch (err) {
      console.warn('[domino] auth unavailable:', (err as Error).message);
    } finally {
      signingIn = null;
    }
  })();
  return signingIn;
}

/** The access token to hand the game server, or null when playing as a guest. */
export async function accessToken(): Promise<string | null> {
  try {
    const client = await getClient();
    if (client === null) return null;
    const { data } = await client.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function currentAccount(): Promise<Account | null> {
  try {
    const client = await getClient();
    if (client === null) return null;
    const { data } = await client.auth.getUser();
    const user = data.user;
    if (user === null) return null;
    return {
      id: user.id,
      anonymous: user.is_anonymous === true,
      email: user.email ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Turn an anonymous account into a permanent one. Supabase emails a
 * confirmation link; the record carries over, since it is the same user id.
 */
export async function claimAccount(email: string): Promise<{ ok: boolean; message: string }> {
  try {
    const client = await getClient();
    if (client === null) {
      return { ok: false, message: 'Accounts are not set up on this server.' };
    }
    const { error } = await client.auth.updateUser({ email });
    if (error !== null) return { ok: false, message: error.message };
    return { ok: true, message: `Check ${email} for a confirmation link.` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export async function signOut(): Promise<void> {
  const client = await getClient();
  await client?.auth.signOut();
}

/** Read-only, and protected by row-level security rather than by trust. */
export async function fetchStats(): Promise<Stats | null> {
  try {
    const client = await getClient();
    if (client === null) return null;
    const account = await currentAccount();
    if (account === null) return null;
    const { data, error } = await client
      .from('player_stats')
      .select('matches_played, matches_won, win_percent')
      .eq('player_id', account.id)
      .maybeSingle();
    if (error !== null || data === null) return null;
    const row = data as { matches_played: number; matches_won: number; win_percent: number };
    return {
      played: Number(row.matches_played ?? 0),
      won: Number(row.matches_won ?? 0),
      winPercent: Number(row.win_percent ?? 0),
    };
  } catch {
    return null;
  }
}

export async function fetchHistory(limit = 10): Promise<MatchSummary[]> {
  try {
    const client = await getClient();
    if (client === null) return [];
    const account = await currentAccount();
    if (account === null) return [];
    const { data, error } = await client
      .from('matches')
      .select(
        'id, score_a, score_b, winning_team, finished_at, match_players(seat, display_name, team, won, player_id)',
      )
      .order('finished_at', { ascending: false })
      .limit(limit);
    if (error !== null || data === null) return [];

    type SeatRow = {
      seat: number;
      display_name: string;
      team: number;
      won: boolean;
      player_id: string | null;
    };
    type MatchRow = {
      id: string;
      score_a: number;
      score_b: number;
      winning_team: number | null;
      finished_at: string;
      match_players: SeatRow[];
    };

    return (data as MatchRow[]).map((row) => {
      const seats = row.match_players ?? [];
      const me = seats.find((s) => s.player_id === account.id);
      const partner = me ? seats.find((s) => s.team === me.team && s.seat !== me.seat) : undefined;
      const opponents = me ? seats.filter((s) => s.team !== me.team) : [];
      return {
        id: row.id,
        finishedAt: row.finished_at,
        won: me?.won ?? false,
        scoreA: row.score_a,
        scoreB: row.score_b,
        partner: partner?.display_name ?? null,
        opponents: opponents.map((o) => o.display_name),
      };
    });
  } catch {
    return [];
  }
}
