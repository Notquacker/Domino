/**
 * Accounts, for the leaderboard.
 *
 * Username and password, nothing else — no email, no recovery. That keeps it
 * simple but it also means a forgotten password can only be reset by an
 * admin, which is why admins can set anyone's.
 *
 * What is stored for a password is a scrypt hash with a per-account salt, and
 * nothing else. The plaintext is used to derive that hash and is then dropped;
 * it is never written to disk, never logged, and never sent back to a client.
 * Comparisons are timing-safe, so a wrong guess takes the same time to reject
 * whether the first character matched or not.
 */

import {
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
/** Deliberately low: these are family passwords, not a bank. */
export const MIN_PASSWORD = 4;
export const MAX_PASSWORD = 200;
const MAX_USERNAME = 16;
/** Wrong guesses allowed in a window before the account stops answering. */
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export class AccountError extends Error {}

export interface Account {
  /** Lower-cased, the key everything is looked up by. */
  readonly id: string;
  /** As the player typed it, for showing back to them. */
  display: string;
  salt: string;
  hash: string;
  isAdmin: boolean;
  wins: number;
  matches: number;
  createdAt: string;
  /** Set when an admin reset the password, so the owner is told to change it. */
  mustChangePassword: boolean;
}

export interface PublicAccount {
  readonly username: string;
  readonly isAdmin: boolean;
  readonly wins: number;
  readonly matches: number;
  readonly mustChangePassword: boolean;
}

export interface LeaderRow {
  readonly rank: number;
  readonly username: string;
  readonly wins: number;
  readonly matches: number;
}

/** Everything persisted. Deliberately plain so a human can read the file. */
interface Stored {
  readonly version: 1;
  readonly accounts: Account[];
}

function normalise(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (name.length < 2) throw new AccountError('a name needs at least 2 characters');
  if (name.length > MAX_USERNAME) {
    throw new AccountError(`a name can be at most ${MAX_USERNAME} characters`);
  }
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) {
    throw new AccountError('a name can use letters, numbers, spaces, dots, dashes');
  }
  return name;
}

function checkPassword(raw: unknown): string {
  const password = String(raw ?? '');
  if (password.length < MIN_PASSWORD) {
    throw new AccountError(`a password needs at least ${MIN_PASSWORD} characters`);
  }
  if (password.length > MAX_PASSWORD) throw new AccountError('that password is too long');
  return password;
}

export class Accounts {
  private readonly byId = new Map<string, Account>();
  private readonly sessions = new Map<string, { id: string; expires: number }>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'accounts.json');
  }

  /** Read what is on disk. A missing file simply means no accounts yet. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Stored;
      for (const account of parsed.accounts ?? []) {
        if (typeof account?.id === 'string') this.byId.set(account.id, account);
      }
    } catch {
      // A corrupt file must not stop the server booting. Starting empty is
      // recoverable; refusing to start is not.
    }
  }

  /**
   * Write through a temporary file and rename, so a crash mid-write cannot
   * leave a half-written file where the accounts used to be. Writes are
   * chained rather than run in parallel for the same reason.
   */
  private persist(): Promise<void> {
    const snapshot: Stored = { version: 1, accounts: [...this.byId.values()] };
    this.writing = this.writing.then(async () => {
      const body = JSON.stringify(snapshot, null, 2);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writing.catch(() => {
      // Losing a write is bad but must not take the table down with it.
    });
  }

  private async hash(password: string, salt: Buffer): Promise<string> {
    const key = await scrypt(password, salt, KEY_LENGTH);
    return key.toString('base64');
  }

  private async verify(account: Account, password: string): Promise<boolean> {
    const expected = Buffer.from(account.hash, 'base64');
    const got = await scrypt(password, Buffer.from(account.salt, 'base64'), KEY_LENGTH);
    // Lengths must match before timingSafeEqual, which throws otherwise.
    if (expected.length !== got.length) return false;
    return timingSafeEqual(expected, got);
  }

  count(): number {
    return this.byId.size;
  }

  get(username: string): Account | null {
    return this.byId.get(String(username ?? '').trim().toLowerCase()) ?? null;
  }

  publicOf(account: Account): PublicAccount {
    return {
      username: account.display,
      isAdmin: account.isAdmin,
      wins: account.wins,
      matches: account.matches,
      mustChangePassword: account.mustChangePassword,
    };
  }

  async register(username: unknown, password: unknown, isAdmin = false): Promise<Account> {
    const display = normalise(username);
    const pass = checkPassword(password);
    const id = display.toLowerCase();
    if (this.byId.has(id)) throw new AccountError('that name is taken');

    const salt = randomBytes(SALT_BYTES);
    const account: Account = {
      id,
      display,
      salt: salt.toString('base64'),
      hash: await this.hash(pass, salt),
      isAdmin,
      wins: 0,
      matches: 0,
      createdAt: new Date().toISOString(),
      mustChangePassword: false,
    };
    this.byId.set(id, account);
    await this.persist();
    return account;
  }

  /**
   * Check a password. Returns null for both "no such account" and "wrong
   * password" so a caller cannot use the difference to find out which names
   * exist.
   */
  async authenticate(username: unknown, password: unknown): Promise<Account | null> {
    const id = String(username ?? '').trim().toLowerCase();
    const limit = this.attempts.get(id);
    if (limit !== undefined && limit.until > Date.now() && limit.count >= MAX_ATTEMPTS) {
      throw new AccountError('too many tries — wait a few minutes');
    }

    const account = this.byId.get(id) ?? null;
    const ok = account !== null && (await this.verify(account, String(password ?? '')));
    if (!ok) {
      const now = Date.now();
      const fresh = limit === undefined || limit.until <= now;
      this.attempts.set(id, {
        count: fresh ? 1 : limit.count + 1,
        until: fresh ? now + ATTEMPT_WINDOW_MS : limit.until,
      });
      return null;
    }
    this.attempts.delete(id);
    return account;
  }

  /** Mint a session token. The token is the credential; it is never stored. */
  startSession(account: Account): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { id: account.id, expires: Date.now() + SESSION_MS });
    return token;
  }

  fromSession(token: unknown): Account | null {
    const entry = this.sessions.get(String(token ?? ''));
    if (entry === undefined) return null;
    if (entry.expires <= Date.now()) {
      this.sessions.delete(String(token));
      return null;
    }
    return this.byId.get(entry.id) ?? null;
  }

  endSession(token: unknown): void {
    this.sessions.delete(String(token ?? ''));
  }

  /** Drop every session for an account, used when its password changes. */
  private revokeAll(id: string): void {
    for (const [token, entry] of this.sessions) {
      if (entry.id === id) this.sessions.delete(token);
    }
  }

  async setPassword(account: Account, next: unknown, byAdmin: boolean): Promise<void> {
    const pass = checkPassword(next);
    const salt = randomBytes(SALT_BYTES);
    account.salt = salt.toString('base64');
    account.hash = await this.hash(pass, salt);
    // An admin reset is a temporary password; the owner is told to replace it.
    account.mustChangePassword = byAdmin;
    // Anyone holding an old session was authenticated under the old password.
    this.revokeAll(account.id);
    await this.persist();
  }

  async changeOwnPassword(account: Account, current: unknown, next: unknown): Promise<void> {
    if (!(await this.verify(account, String(current ?? '')))) {
      throw new AccountError('that is not your current password');
    }
    await this.setPassword(account, next, false);
  }

  /** Credit a win to each named account, and a match played to all of them. */
  async recordResult(winners: readonly string[], played: readonly string[]): Promise<void> {
    let touched = false;
    for (const name of played) {
      const account = this.get(name);
      if (account === null) continue;
      account.matches += 1;
      touched = true;
    }
    for (const name of winners) {
      const account = this.get(name);
      if (account === null) continue;
      account.wins += 1;
      touched = true;
    }
    if (touched) await this.persist();
  }

  /**
   * Most wins first. Ties break on fewer matches played — the same number of
   * wins from fewer games is the better record — and then by name so the
   * order never wobbles between requests.
   */
  leaderboard(limit = 50): LeaderRow[] {
    const rows = [...this.byId.values()]
      .filter((a) => a.matches > 0 || a.wins > 0)
      .sort((a, b) => b.wins - a.wins || a.matches - b.matches || a.id.localeCompare(b.id))
      .slice(0, limit);
    return rows.map((a, i) => ({
      rank: i + 1,
      username: a.display,
      wins: a.wins,
      matches: a.matches,
    }));
  }

  /** Admin view: everyone, including those who have never played. */
  everyone(): PublicAccount[] {
    return [...this.byId.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => this.publicOf(a));
  }

  async setWins(account: Account, wins: number): Promise<void> {
    account.wins = Math.max(0, Math.min(100_000, Math.round(wins)));
    await this.persist();
  }

  async setAdmin(account: Account, isAdmin: boolean): Promise<void> {
    account.isAdmin = isAdmin;
    await this.persist();
  }

  async remove(account: Account): Promise<void> {
    this.byId.delete(account.id);
    this.revokeAll(account.id);
    await this.persist();
  }

  /**
   * Make sure the admin account exists on boot. The password comes from
   * ADMIN_PASSWORD when set; the fallback is a placeholder meant to be
   * changed, and the caller is told so it can say that out loud.
   */
  async ensureAdmin(
    username: string,
    password: string,
  ): Promise<{ created: boolean; usingFallback: boolean }> {
    const existing = this.get(username);
    const fromEnv = process.env['ADMIN_PASSWORD'];
    const usingFallback = fromEnv === undefined || fromEnv.length < MIN_PASSWORD;
    if (existing !== null) {
      if (!existing.isAdmin) await this.setAdmin(existing, true);
      return { created: false, usingFallback };
    }
    await this.register(username, usingFallback ? password : fromEnv, true);
    return { created: true, usingFallback };
  }
}
