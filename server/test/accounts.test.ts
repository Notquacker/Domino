/**
 * Accounts and the leaderboard.
 *
 * The first block is about what must never happen — a password reaching the
 * disk, a wrong guess being accepted, one player's session surviving another
 * player's password change. Those are checked before any of the counting is.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccountError, Accounts, SupabaseAccountStorage } from '../dist/accounts.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'domino-accounts-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A store of its own, so one test cannot disturb another. */
async function freshStore(name: string): Promise<{ store: Accounts; path: string }> {
  const path = join(dir, name);
  const store = new Accounts(path);
  await store.load();
  return { store, path: join(path, 'accounts.json') };
}

describe('what a password store must never do', () => {
  it('never writes the password itself to disk', async () => {
    const { store, path } = await freshStore('plaintext');
    await store.register('Xay', 'qwerty');
    await store.register('Pico', 'correct horse battery');
    // Let the chained write settle.
    await store.register('Yae', 'another-one');

    const onDisk = await readFile(path, 'utf8');
    assert.ok(!onDisk.includes('qwerty'), 'the admin password was written in the clear');
    assert.ok(!onDisk.includes('correct horse battery'), 'a password was written in the clear');
    assert.ok(!onDisk.includes('another-one'), 'a password was written in the clear');
    assert.ok(onDisk.includes('"hash"') && onDisk.includes('"salt"'), 'expected a salted hash');
  });

  it('gives two accounts with the same password different hashes', async () => {
    const { store } = await freshStore('salted');
    const a = await store.register('Ana', 'samepass');
    const b = await store.register('Bo', 'samepass');
    assert.notEqual(a.salt, b.salt, 'each account needs its own salt');
    assert.notEqual(a.hash, b.hash, 'identical passwords must not produce identical hashes');
  });

  it('refuses a wrong password, and an unknown name, the same way', async () => {
    const { store } = await freshStore('wrong');
    await store.register('Ana', 'rightpass');
    assert.equal(await store.authenticate('Ana', 'wrongpass'), null);
    assert.equal(await store.authenticate('Ana', 'rightpas'), null);
    assert.equal(await store.authenticate('Ana', ''), null);
    assert.equal(await store.authenticate('nobody', 'rightpass'), null);
    assert.notEqual(await store.authenticate('Ana', 'rightpass'), null, 'the right one works');
  });

  it('matches the name whatever case it is typed in', async () => {
    const { store } = await freshStore('case');
    await store.register('Xay', 'qwerty');
    assert.notEqual(await store.authenticate('xay', 'qwerty'), null);
    assert.notEqual(await store.authenticate('  XAY  ', 'qwerty'), null);
    await assert.rejects(() => store.register('XAY', 'other'), AccountError);
  });

  it('stops answering after a run of wrong guesses', async () => {
    const { store } = await freshStore('bruteforce');
    await store.register('Ana', 'rightpass');
    for (let i = 0; i < 8; i++) await store.authenticate('Ana', `guess${i}`);
    // Even the correct password is refused once the limit is hit.
    await assert.rejects(() => store.authenticate('Ana', 'rightpass'), /too many tries/);
  });

  it('throws away every session when a password changes', async () => {
    const { store } = await freshStore('sessions');
    const ana = await store.register('Ana', 'rightpass');
    const phone = store.startSession(ana);
    const tablet = store.startSession(ana);
    assert.notEqual(store.fromSession(phone), null);

    await store.changeOwnPassword(ana, 'rightpass', 'brandnew');
    assert.equal(store.fromSession(phone), null, 'an old session must not survive');
    assert.equal(store.fromSession(tablet), null, 'nor any other');
    assert.equal(await store.authenticate('Ana', 'rightpass'), null, 'the old password is dead');
    assert.notEqual(await store.authenticate('Ana', 'brandnew'), null);
  });

  it('refuses to change a password without the current one', async () => {
    const { store } = await freshStore('needcurrent');
    const ana = await store.register('Ana', 'rightpass');
    await assert.rejects(
      () => store.changeOwnPassword(ana, 'notit', 'brandnew'),
      /not your current password/,
    );
    assert.notEqual(await store.authenticate('Ana', 'rightpass'), null, 'unchanged');
  });

  it('never hands a hash or a salt to the public view', async () => {
    const { store } = await freshStore('publicview');
    const ana = await store.register('Ana', 'rightpass');
    const shown = JSON.stringify(store.publicOf(ana));
    assert.ok(!shown.includes('hash'), shown);
    assert.ok(!shown.includes('salt'), shown);
    assert.ok(!shown.includes('rightpass'), shown);
  });

  it('holds the line on names and passwords it will accept', async () => {
    const { store } = await freshStore('validation');
    await assert.rejects(() => store.register('A', 'rightpass'), /at least 2/);
    await assert.rejects(() => store.register('a'.repeat(17), 'rightpass'), /at most 16/);
    await assert.rejects(() => store.register('bad<name>', 'rightpass'), /letters, numbers/);
    await assert.rejects(() => store.register('Ana', 'abc'), /at least 4/);
    await assert.rejects(() => store.register('Ana', 'x'.repeat(201)), /too long/);
  });
});

describe('counting wins', () => {
  it('gives a point to both players on the winning team', async () => {
    // Exactly the example this was built from: Xay wins with Pico, then wins
    // again with Yae, so Xay has 2 and the other two have 1 each.
    const { store } = await freshStore('counting');
    for (const name of ['Xay', 'Pico', 'Yae', 'Dee']) await store.register(name, 'rightpass');

    await store.recordResult(['xay', 'pico'], ['xay', 'pico', 'yae', 'dee']);
    await store.recordResult(['xay', 'yae'], ['xay', 'yae', 'pico', 'dee']);

    const board = store.leaderboard();
    assert.deepEqual(
      board.map((r) => [r.username, r.wins]),
      [
        ['Xay', 2],
        ['Pico', 1],
        ['Yae', 1],
        ['Dee', 0],
      ],
    );
    assert.deepEqual(board.map((r) => r.rank), [1, 2, 3, 4]);
    assert.equal(store.get('dee')!.matches, 2, 'a loser still played two matches');
  });

  it('breaks a tie on fewer matches played', async () => {
    const { store } = await freshStore('tiebreak');
    await store.register('Busy', 'rightpass');
    await store.register('Sharp', 'rightpass');
    // Both on two wins, but Sharp needed fewer games to get them.
    await store.recordResult(['busy'], ['busy']);
    await store.recordResult(['busy'], ['busy']);
    await store.recordResult([], ['busy']);
    await store.recordResult(['sharp'], ['sharp']);
    await store.recordResult(['sharp'], ['sharp']);
    assert.deepEqual(
      store.leaderboard().map((r) => r.username),
      ['Sharp', 'Busy'],
    );
  });

  it('ignores a name that has no account', async () => {
    const { store } = await freshStore('guests');
    await store.register('Ana', 'rightpass');
    await store.recordResult(['ana', 'a-guest'], ['ana', 'a-guest']);
    assert.equal(store.get('ana')!.wins, 1);
    assert.equal(store.leaderboard().length, 1, 'the guest is not on the board');
  });

  it('counts a drawn match as played by everyone and won by nobody', async () => {
    const { store } = await freshStore('drawn');
    await store.register('Ana', 'rightpass');
    await store.recordResult([], ['ana']);
    assert.equal(store.get('ana')!.wins, 0);
    assert.equal(store.get('ana')!.matches, 1);
  });
});

describe('the admin', () => {
  it('is created on first boot and can reset anyone else’s password', async () => {
    const { store } = await freshStore('admin');
    const made = await store.ensureAdmin('Xay', 'qwerty');
    assert.equal(made.created, true);
    const xay = store.get('Xay')!;
    assert.equal(xay.isAdmin, true);
    assert.notEqual(await store.authenticate('Xay', 'qwerty'), null);

    const pico = await store.register('Pico', 'forgotten');
    await store.setPassword(pico, 'temppass', true);
    assert.equal(await store.authenticate('Pico', 'forgotten'), null, 'the old one is dead');
    assert.notEqual(await store.authenticate('Pico', 'temppass'), null);
    assert.equal(
      store.get('pico')!.mustChangePassword,
      true,
      'an admin reset should ask the owner to pick their own',
    );
  });

  it('does not make a second admin or change the password on a later boot', async () => {
    const { store } = await freshStore('reboot');
    await store.ensureAdmin('Xay', 'qwerty');
    await store.changeOwnPassword(store.get('Xay')!, 'qwerty', 'muchbetter');
    const again = await store.ensureAdmin('Xay', 'qwerty');
    assert.equal(again.created, false);
    assert.equal(
      await store.authenticate('Xay', 'qwerty'),
      null,
      'rebooting must not put the placeholder password back',
    );
    assert.notEqual(await store.authenticate('Xay', 'muchbetter'), null);
  });

  it('survives a restart with the accounts intact', async () => {
    const path = join(dir, 'restart');
    const first = new Accounts(path);
    await first.load();
    await first.register('Ana', 'rightpass');
    await first.recordResult(['ana'], ['ana']);
    // Give the chained write a moment to land before reading it back.
    await new Promise((r) => setTimeout(r, 60));

    const second = new Accounts(path);
    await second.load();
    assert.notEqual(await second.authenticate('Ana', 'rightpass'), null, 'password survived');
    assert.equal(second.get('ana')!.wins, 1, 'the win survived');
  });

  it('starts empty rather than refusing to boot on a corrupt file', async () => {
    const path = join(dir, 'corrupt');
    const store = new Accounts(path);
    await store.load();
    await store.register('Ana', 'rightpass');
    await new Promise((r) => setTimeout(r, 60));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(path, 'accounts.json'), '{ not json at all', 'utf8');

    const after = new Accounts(path);
    await after.load();
    assert.equal(after.count(), 0, 'a broken file must not stop the server starting');
  });
});

describe('accounts kept in Supabase', () => {
  /** A stand-in for the table, so the adapter is exercised for real. */
  function fakeApi() {
    const rows = new Map<string, Record<string, unknown>>();
    let failNext: string | null = null;
    return {
      rows,
      /** Make the next call of this kind fail, to test what happens then. */
      breakOn(kind: 'load' | 'put' | 'delete' | null): void {
        failNext = kind;
      },
      loadAccounts: async () => {
        if (failNext === 'load') throw new Error('accounts store returned 503');
        return [...rows.values()] as never;
      },
      putAccount: async (row: { id: string }) => {
        if (failNext === 'put') {
          failNext = null;
          throw new Error('accounts store returned 500');
        }
        rows.set(row.id, { ...row });
      },
      deleteAccount: async (id: string) => {
        if (failNext === 'delete') throw new Error('accounts store returned 500');
        rows.delete(id);
      },
    };
  }

  it('writes a hash to the table and never the password', async () => {
    const api = fakeApi();
    const store = new Accounts(new SupabaseAccountStorage(api));
    await store.load();
    await store.register('Xay', 'qwerty', true);

    const row = api.rows.get('xay') as Record<string, unknown>;
    assert.ok(row, 'the account reached the table');
    assert.equal(row['display'], 'Xay');
    assert.equal(row['is_admin'], true);
    assert.ok(!JSON.stringify(row).includes('qwerty'), 'the password reached the table');
    assert.ok(typeof row['hash'] === 'string' && (row['hash'] as string).length > 20);
    assert.ok(typeof row['salt'] === 'string');
  });

  it('comes back after a restart with passwords and wins intact', async () => {
    const api = fakeApi();
    const first = new Accounts(new SupabaseAccountStorage(api));
    await first.load();
    await first.register('Pico', 'picopass');
    await first.recordResult(['pico'], ['pico']);

    // A new process, same table.
    const second = new Accounts(new SupabaseAccountStorage(api));
    await second.load();
    assert.notEqual(await second.authenticate('Pico', 'picopass'), null, 'password survived');
    assert.equal(second.get('pico')!.wins, 1, 'the win survived');
    assert.equal(second.leaderboard()[0]!.username, 'Pico');
  });

  it('refuses to sign anyone in when the table cannot be read', async () => {
    const api = fakeApi();
    api.breakOn('load');
    const store = new Accounts(new SupabaseAccountStorage(api));
    await store.load();

    assert.equal(store.usable, false, 'the store knows it did not load');
    // Crucially it must NOT behave as though there are simply no accounts,
    // which would let the next write wipe the real ones.
    await assert.rejects(() => store.authenticate('Xay', 'qwerty'), /unavailable/);
    await assert.rejects(() => store.register('Xay', 'qwerty'), /unavailable/);
    assert.equal(api.rows.size, 0, 'nothing was written over the top');
  });

  it('does not pretend a password changed when the write failed', async () => {
    const api = fakeApi();
    const store = new Accounts(new SupabaseAccountStorage(api));
    await store.load();
    const pico = await store.register('Pico', 'picopass');
    const session = store.startSession(pico);

    api.breakOn('put');
    await assert.rejects(() => store.setPassword(pico, 'brandnew', false), /500/);

    // The old password must still work, in memory and on the next restart.
    assert.notEqual(await store.authenticate('Pico', 'picopass'), null, 'old password kept');
    assert.equal(await store.authenticate('Pico', 'brandnew'), null, 'new one never took');
    assert.notEqual(store.fromSession(session), null, 'a session was not revoked for nothing');

    const again = new Accounts(new SupabaseAccountStorage(api));
    await again.load();
    assert.notEqual(await again.authenticate('Pico', 'picopass'), null, 'and after a restart');
  });

  it('does not leave an account that failed to save looking real', async () => {
    const api = fakeApi();
    const store = new Accounts(new SupabaseAccountStorage(api));
    await store.load();
    api.breakOn('put');
    await assert.rejects(() => store.register('Ghost', 'ghostpass'), /500/);
    assert.equal(store.get('ghost'), null, 'it must not linger in memory either');
    assert.equal(api.rows.size, 0);
    // And the name is free to try again with.
    await store.register('Ghost', 'ghostpass');
    assert.notEqual(store.get('ghost'), null);
  });

  it('deletes an account from the table', async () => {
    const api = fakeApi();
    const store = new Accounts(new SupabaseAccountStorage(api));
    await store.load();
    const gone = await store.register('Temp', 'temppass');
    assert.equal(api.rows.size, 1);
    await store.remove(gone);
    assert.equal(api.rows.size, 0, 'the row went too, not just the memory');
  });
});
