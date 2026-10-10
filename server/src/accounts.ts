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

/**
 * Where accounts are kept. Two implementations: a file, which is simple and
 * works anywhere, and Supabase, which survives a container being rebuilt.
 *
 * `put` and `remove` are given both the account that changed and a snapshot
 * of them all, because the two backends want different things: a file is
 * rewritten whole, while Supabase upserts the single changed row. Saying so
 * here beats each backend having to ask the other for what it needs.
 */
export interface AccountStorage {
  /** Named in the boot log so it is obvious which one is in use. */
  readonly label: string;
  loadAll(): Promise<Account[]>;
  put(account: Account, all: readonly Account[]): Promise<void>;
  remove(id: string, all: readonly Account[]): Promise<void>;
}

/** A plain JSON file. Readable, copyable, and gone if the container is. */
export class FileAccountStorage implements AccountStorage {
  readonly label: string;
  private readonly file: string;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'accounts.json');
    this.label = `file ${this.file}`;
  }

  async loadAll(): Promise<Account[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Stored;
      return (parsed.accounts ?? []).filter((a) => typeof a?.id === 'string');
    } catch {
      // A corrupt file must not stop the server booting. Starting empty is
      // recoverable; refusing to start is not.
      return [];
    }
  }

  /**
   * Write through a temporary file and rename, so a crash mid-write cannot
   * leave a half-written file where the accounts used to be. Writes are
   * chained rather than run in parallel for the same reason.
   */
  private write(all: readonly Account[]): Promise<void> {
    const snapshot: Stored = { version: 1, accounts: [...all] };
    this.writing = this.writing.then(async () => {
      const body = JSON.stringify(snapshot, null, 2);
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 });
      await rename(temp, this.file);
    });
    return this.writing;
  }

  put(_account: Account, all: readonly Account[]): Promise<void> {
    return this.write(all);
  }

  remove(_id: string, all: readonly Account[]): Promise<void> {
    return this.write(all);
  }
}

export class Accounts {
  private readonly byId = new Map<string, Account>();
  private readonly sessions = new Map<string, { id: string; expires: number }>();
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private readonly storage: AccountStorage;

  constructor(storage: AccountStorage | string) {
    // A bare path still works, so a caller that only wants a file can say so.
    this.storage =
      typeof storage === 'string' ? new FileAccountStorage(storage) : storage;
  }

  get label(): string {
    return this.storage.label;
  }

  /**
   * Did the accounts actually load? If the store could not be read we must
   * NOT carry on as though there were no accounts: the first write would
   * then overwrite real rows with an empty set, and creating the admin again
   * would replace a chosen password with the placeholder. Instead everything
   * to do with accounts refuses politely and the game itself plays on.
   */
  private healthy = false;

  get usable(): boolean {
    return this.healthy;
  }

  async load(): Promise<void> {
    try {
      for (const account of await this.storage.loadAll()) {
        this.byId.set(account.id, account);
      }
      this.healthy = true;
    } catch (err) {
      this.healthy = false;
      console.error('[domino] could not read the accounts store:', (err as Error).message);
    }
  }

  private requireUsable(): void {
    if (!this.healthy) {
      throw new AccountError('accounts are unavailable right now — you can still play as a guest');
    }
  }

  /**
   * Save one changed account.
   *
   * Errors are NOT swallowed. A password change that does not reach storage
   * would work until the next restart and then lock its owner out, which is
   * far worse than being told the save failed.
   */
  private persist(account: Account): Promise<void> {
    return this.storage.put(account, [...this.byId.values()]);
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
    this.requireUsable();
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
    try {
      await this.persist(account);
    } catch (err) {
      // Keep memory and storage in step: an account that did not save must
      // not look as though it exists until the next restart.
      this.byId.delete(id);
      throw err;
    }
    return account;
  }

  /**
   * Check a password. Returns null for both "no such account" and "wrong
   * password" so a caller cannot use the difference to find out which names
   * exist.
   */
  async authenticate(username: unknown, password: unknown): Promise<Account | null> {
    this.requireUsable();
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
    this.requireUsable();
    const pass = checkPassword(next);
    const before = {
      salt: account.salt,
      hash: account.hash,
      mustChangePassword: account.mustChangePassword,
    };
    const salt = randomBytes(SALT_BYTES);
    account.salt = salt.toString('base64');
    account.hash = await this.hash(pass, salt);
    // An admin reset is a temporary password; the owner is told to replace it.
    account.mustChangePassword = byAdmin;
    try {
      await this.persist(account);
    } catch (err) {
      // Put the old password back. Telling someone their password changed
      // when it did not would lock them out at the next restart.
      Object.assign(account, before);
      throw err;
    }
    // Only now: anyone holding an old session was authenticated under the old
    // password, and there is no point revoking for a change that did not land.
    this.revokeAll(account.id);
  }

  async changeOwnPassword(account: Account, current: unknown, next: unknown): Promise<void> {
    if (!(await this.verify(account, String(current ?? '')))) {
      throw new AccountError('that is not your current password');
    }
    await this.setPassword(account, next, false);
  }

  /** Credit a win to each named account, and a match played to all of them. */
  async recordResult(winners: readonly string[], played: readonly string[]): Promise<void> {
    const touched = new Set<Account>();
    for (const name of played) {
      const account = this.get(name);
      if (account === null) continue;
      account.matches += 1;
      touched.add(account);
    }
    for (const name of winners) {
      const account = this.get(name);
      if (account === null) continue;
      account.wins += 1;
      touched.add(account);
    }
    for (const account of touched) await this.persist(account);
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
    await this.persist(account);
  }

  async setAdmin(account: Account, isAdmin: boolean): Promise<void> {
    account.isAdmin = isAdmin;
    await this.persist(account);
  }

  async remove(account: Account): Promise<void> {
    this.requireUsable();
    this.byId.delete(account.id);
    this.revokeAll(account.id);
    // Not persist(): that upserts the row straight back. The file store hid
    // this, because it rewrites the whole file from memory and the account
    // was already gone from there.
    await this.storage.remove(account.id, [...this.byId.values()]);
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

/**
 * Accounts in Supabase, so they survive the container being rebuilt.
 *
 * Only the service role can reach this table — see
 * `supabase/migrations/0002_accounts.sql`, where row level security is on with
 * no policies at all and the grants are revoked. The hashes in it are not
 * readable by a signed-in player, let alone an anonymous one.
 */
export class SupabaseAccountStorage implements AccountStorage {
  readonly label = 'Supabase';

  constructor(private readonly supabase: SupabaseAccountApi) {}

  async loadAll(): Promise<Account[]> {
    const rows = await this.supabase.loadAccounts();
    return rows.map((row) => ({
      id: row.id,
      display: row.display,
      salt: row.salt,
      hash: row.hash,
      isAdmin: row.is_admin,
      wins: row.wins,
      matches: row.matches,
      createdAt: row.created_at,
      mustChangePassword: row.must_change_password,
    }));
  }

  async put(account: Account): Promise<void> {
    await this.supabase.putAccount({
      id: account.id,
      display: account.display,
      salt: account.salt,
      hash: account.hash,
      is_admin: account.isAdmin,
      wins: account.wins,
      matches: account.matches,
      must_change_password: account.mustChangePassword,
      created_at: account.createdAt,
    });
  }

  async remove(id: string): Promise<void> {
    await this.supabase.deleteAccount(id);
  }
}

/** Just the part of the Supabase client this file needs. */
export interface SupabaseAccountApi {
  loadAccounts(): Promise<
    readonly {
      id: string;
      display: string;
      salt: string;
      hash: string;
      is_admin: boolean;
      wins: number;
      matches: number;
      must_change_password: boolean;
      created_at: string;
    }[]
  >;
  putAccount(row: {
    id: string;
    display: string;
    salt: string;
    hash: string;
    is_admin: boolean;
    wins: number;
    matches: number;
    must_change_password: boolean;
    created_at: string;
  }): Promise<void>;
  deleteAccount(id: string): Promise<void>;
}
