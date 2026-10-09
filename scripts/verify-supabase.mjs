#!/usr/bin/env node
/**
 * Verifies a Supabase project is correctly set up for Domino — and, more
 * importantly, that its security actually holds rather than merely being
 * written down in a migration file.
 *
 * It proves the things the SQL only claims:
 *   - a client holding the public anon key cannot insert match rows
 *   - it cannot call record_match() either
 *   - a signed-in player cannot read a match they did not play in
 *
 * Run it after applying the migration:  npm run verify:supabase
 *
 * It creates one throwaway match row and deletes it again. It touches nothing
 * else, and never prints a key.
 */

import { Supabase } from '../server/dist/supabase.js';

const URL_ = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '';

const PASS = '\u001b[32m  PASS\u001b[0m';
const FAIL = '\u001b[31m  FAIL\u001b[0m';
const SKIP = '\u001b[33m  SKIP\u001b[0m';

let failures = 0;
let skipped = 0;

function pass(label, detail = '') {
  console.log(`${PASS}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label, detail = '') {
  failures++;
  console.log(`${FAIL}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function skip(label, why) {
  skipped++;
  console.log(`${SKIP}  ${label} — ${why}`);
}

/** A PostgREST/GoTrue call that never throws, so one failure does not end the run. */
async function call(path, { key, token, method = 'GET', body, headers = {} } = {}) {
  try {
    const res = await fetch(`${URL_}${path}`, {
      method,
      headers: {
        apikey: key,
        authorization: `Bearer ${token ?? key}`,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    return { status: res.status, ok: res.ok, text, json };
  } catch (err) {
    return { status: 0, ok: false, text: String(err?.message ?? err), json: null };
  }
}

console.log('\nChecking your Supabase project for Domino\n');

// ---------------------------------------------------------------------------
// 0. Configuration
// ---------------------------------------------------------------------------

if (!URL_ || !SERVICE_KEY) {
  console.error(
    'Missing configuration. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY\n' +
      '(and SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY for the security checks).\n' +
      '\nSee supabase/README.md. Never paste these into a chat or commit them.\n',
  );
  process.exit(2);
}
console.log(`  project: ${URL_}\n`);

// ---------------------------------------------------------------------------
// 1. Is the schema applied?
// ---------------------------------------------------------------------------

for (const table of ['profiles', 'matches', 'match_players', 'player_stats']) {
  const res = await call(`/rest/v1/${table}?limit=1`, { key: SERVICE_KEY });
  if (res.ok) pass(`table/view "${table}" exists`);
  else fail(`table/view "${table}" missing`, `${res.status} — run supabase/migrations/0001_init.sql`);
}

// ---------------------------------------------------------------------------
// 2. Is anonymous sign-in switched on? (off by default)
// ---------------------------------------------------------------------------

let anonSession = null;
if (!ANON_KEY) {
  skip('anonymous sign-in', 'no anon key set, so the client-side checks cannot run');
} else {
  const res = await call('/auth/v1/signup', {
    key: ANON_KEY,
    method: 'POST',
    body: { data: { display_name: 'Verification' } },
  });
  if (res.ok && res.json?.access_token) {
    anonSession = res.json;
    pass('anonymous sign-in is enabled');
  } else {
    const why = res.json?.msg ?? res.json?.error_description ?? res.text.slice(0, 120);
    fail(
      'anonymous sign-in is disabled',
      `${why} — turn it on under Authentication → Providers`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Does the game server accept a token from this project end to end?
// ---------------------------------------------------------------------------

if (anonSession === null) {
  skip('server accepts a real token', 'needs an anonymous session');
} else {
  const supabase = new Supabase({
    url: URL_,
    serviceRoleKey: SERVICE_KEY,
    jwtSecret: process.env.SUPABASE_JWT_SECRET,
  });
  const user = await supabase.verify(anonSession.access_token);
  if (user === null) {
    fail(
      'server accepts a real token',
      'verification failed — if this is a legacy project, set SUPABASE_JWT_SECRET',
    );
  } else {
    pass('server accepts a real token', `user ${user.id.slice(0, 8)}…, anonymous=${user.isAnonymous}`);
  }
}

// ---------------------------------------------------------------------------
// 4. The security claims: a client must not be able to write
// ---------------------------------------------------------------------------

const asPlayer = anonSession?.access_token ?? null;

if (!ANON_KEY) {
  skip('clients cannot write match rows', 'no anon key set');
} else {
  const insert = await call('/rest/v1/matches', {
    key: ANON_KEY,
    token: asPlayer,
    method: 'POST',
    body: {
      room_code: 'HACK',
      rules: {},
      target_score: 150,
      winning_team: 0,
      score_a: 999,
      score_b: 0,
      rounds_played: 1,
      started_at: new Date().toISOString(),
    },
  });
  if (insert.ok) fail('clients cannot insert into "matches"', 'the insert SUCCEEDED — RLS is not protecting this table');
  else pass('clients cannot insert into "matches"', `refused with ${insert.status}`);

  const seat = await call('/rest/v1/match_players', {
    key: ANON_KEY,
    token: asPlayer,
    method: 'POST',
    body: { match_id: crypto.randomUUID(), seat: 0, display_name: 'Cheat', team: 0, won: true },
  });
  if (seat.ok) fail('clients cannot insert into "match_players"', 'the insert SUCCEEDED');
  else pass('clients cannot insert into "match_players"', `refused with ${seat.status}`);

  const rpc = await call('/rest/v1/rpc/record_match', {
    key: ANON_KEY,
    token: asPlayer,
    method: 'POST',
    body: { payload: { room_code: 'HACK', target_score: 150, players: [] } },
  });
  if (rpc.ok) fail('clients cannot call record_match()', 'the call SUCCEEDED — revoke it from anon/authenticated');
  else pass('clients cannot call record_match()', `refused with ${rpc.status}`);
}

// ---------------------------------------------------------------------------
// 5. The server's write path must work
// ---------------------------------------------------------------------------

let recordedId = null;
const recorded = await call('/rest/v1/rpc/record_match', {
  key: SERVICE_KEY,
  method: 'POST',
  body: {
    payload: {
      room_code: '__VERIFY__',
      rules: { targetScore: 150 },
      target_score: 150,
      winning_team: 0,
      score_a: 150,
      score_b: 40,
      rounds_played: 3,
      started_at: new Date().toISOString(),
      players: [
        { seat: 0, player_id: null, display_name: 'Check A', team: 0, won: true, pips_left: 0 },
        { seat: 1, player_id: null, display_name: 'Check B', team: 1, won: false, pips_left: 9 },
        { seat: 2, player_id: null, display_name: 'Check C', team: 0, won: true, pips_left: 4 },
        { seat: 3, player_id: null, display_name: 'Check D', team: 1, won: false, pips_left: 7 },
      ],
    },
  },
});
if (recorded.ok && typeof recorded.json === 'string') {
  recordedId = recorded.json;
  pass('the server can record a match', `wrote ${recordedId.slice(0, 8)}…`);
} else {
  fail('the server can record a match', `${recorded.status} ${recorded.text.slice(0, 160)}`);
}

// ---------------------------------------------------------------------------
// 6. A player must not see a match they did not play in
// ---------------------------------------------------------------------------

if (recordedId === null || asPlayer === null) {
  skip('players cannot read other people’s matches', 'needs a recorded match and a session');
} else {
  const peek = await call(`/rest/v1/matches?id=eq.${recordedId}`, {
    key: ANON_KEY,
    token: asPlayer,
  });
  const rows = Array.isArray(peek.json) ? peek.json : [];
  if (rows.length > 0) {
    fail('players cannot read other people’s matches', 'the row was visible to an unrelated player');
  } else {
    pass('players cannot read other people’s matches', 'row correctly hidden by RLS');
  }
}

// ---------------------------------------------------------------------------
// 7. Clean up after ourselves
// ---------------------------------------------------------------------------

if (recordedId !== null) {
  const removed = await call(`/rest/v1/matches?id=eq.${recordedId}`, {
    key: SERVICE_KEY,
    method: 'DELETE',
  });
  if (removed.ok) pass('cleaned up the test match');
  else fail('cleaned up the test match', `left ${recordedId} behind (${removed.status})`);
}

// ---------------------------------------------------------------------------

console.log('');
if (failures > 0) {
  console.log(`\u001b[31m${failures} check(s) failed.\u001b[0m${skipped ? ` ${skipped} skipped.` : ''}\n`);
  process.exit(1);
}
console.log(
  `\u001b[32mAll checks passed.\u001b[0m${skipped ? ` ${skipped} skipped.` : ''} Accounts and history are ready.\n`,
);
