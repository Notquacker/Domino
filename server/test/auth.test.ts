/**
 * Supabase token verification.
 *
 * This is the hinge of the whole account feature: a token that verifies means
 * the server trusts a user id, which is what match history is attributed to.
 * So it is tested against a real JWKS endpoint and real signatures rather than
 * mocked out — including every way a token should be rejected.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { Supabase } from '../dist/supabase.js';

const PORT = 8241;
const ISSUER_BASE = `http://127.0.0.1:${PORT}`;

let keys: { privateKey: CryptoKey; publicKey: CryptoKey };
let otherKeys: { privateKey: CryptoKey; publicKey: CryptoKey };
let jwksServer: Server;
/** Requests the fake PostgREST endpoint received, for payload assertions. */
const rpcCalls: { fn: string; body: unknown; auth: string | undefined }[] = [];

function makeSupabase(jwtSecret?: string): Supabase {
  return new Supabase({
    url: ISSUER_BASE,
    serviceRoleKey: 'test-service-role-key',
    jwtSecret,
  });
}

async function sign(
  payload: Record<string, unknown>,
  options: { issuer?: string; audience?: string; expiresIn?: string; key?: CryptoKey } = {},
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuedAt()
    .setIssuer(options.issuer ?? `${ISSUER_BASE}/auth/v1`)
    .setAudience(options.audience ?? 'authenticated')
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(options.key ?? keys.privateKey);
}

before(async () => {
  keys = await generateKeyPair('ES256');
  otherKeys = await generateKeyPair('ES256');
  const jwk: JWK = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'ES256' };

  jwksServer = createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url?.startsWith('/rest/v1/rpc/')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        rpcCalls.push({
          fn: req.url!.replace('/rest/v1/rpc/', ''),
          body: JSON.parse(body || '{}'),
          auth: req.headers.authorization,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('null');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => jwksServer.listen(PORT, '127.0.0.1', resolve));
});

after(() => {
  jwksServer?.close();
});

describe('verifying a Supabase token', () => {
  it('accepts a properly signed token and reports the user', async () => {
    const supabase = makeSupabase();
    const jwt = await sign({ sub: 'user-abc', is_anonymous: false });
    const user = await supabase.verify(jwt);
    assert.deepEqual(user, { id: 'user-abc', isAnonymous: false });
  });

  it('flags an anonymous session', async () => {
    const supabase = makeSupabase();
    const user = await supabase.verify(await sign({ sub: 'anon-1', is_anonymous: true }));
    assert.equal(user?.isAnonymous, true);
  });

  it('treats a missing is_anonymous claim as a real account', async () => {
    const supabase = makeSupabase();
    const user = await supabase.verify(await sign({ sub: 'user-xyz' }));
    assert.equal(user?.isAnonymous, false);
  });

  it('rejects a token signed by a key it does not trust', async () => {
    const supabase = makeSupabase();
    const jwt = await sign({ sub: 'intruder' }, { key: otherKeys.privateKey });
    assert.equal(await supabase.verify(jwt), null);
  });

  it('rejects a tampered payload', async () => {
    const supabase = makeSupabase();
    const jwt = await sign({ sub: 'user-abc' });
    const [header, , signature] = jwt.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else' })).toString('base64url');
    assert.equal(await supabase.verify(`${header}.${forged}.${signature}`), null);
  });

  it('rejects an expired token', async () => {
    const supabase = makeSupabase();
    const jwt = await sign({ sub: 'user-abc' }, { expiresIn: '-5m' });
    assert.equal(await supabase.verify(jwt), null);
  });

  it('rejects a token minted for another project', async () => {
    const supabase = makeSupabase();
    const jwt = await sign({ sub: 'user-abc' }, { issuer: 'https://evil.example/auth/v1' });
    assert.equal(await supabase.verify(jwt), null);
  });

  it('rejects a token for the wrong audience', async () => {
    const supabase = makeSupabase();
    const jwt = await sign({ sub: 'user-abc' }, { audience: 'service_role' });
    assert.equal(await supabase.verify(jwt), null);
  });

  it('rejects a token with no subject', async () => {
    const supabase = makeSupabase();
    assert.equal(await supabase.verify(await sign({ is_anonymous: true })), null);
  });

  it('rejects junk without throwing', async () => {
    const supabase = makeSupabase();
    for (const junk of ['', 'not-a-jwt', 'a.b.c', '....']) {
      assert.equal(await supabase.verify(junk), null, `should reject ${JSON.stringify(junk)}`);
    }
  });

  it('verifies legacy HS256 tokens when a shared secret is configured', async () => {
    const secret = 'a-very-long-legacy-supabase-jwt-secret-value-0123456789';
    const supabase = makeSupabase(secret);
    const jwt = await new SignJWT({ sub: 'legacy-user', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(`${ISSUER_BASE}/auth/v1`)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));
    assert.deepEqual(await supabase.verify(jwt), { id: 'legacy-user', isAnonymous: false });

    // And must not accept one signed with a different secret.
    const forged = await new SignJWT({ sub: 'legacy-user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(`${ISSUER_BASE}/auth/v1`)
      .setAudience('authenticated')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('the-wrong-secret-the-wrong-secret-the-wrong'));
    assert.equal(await supabase.verify(forged), null);
  });
});

describe('when Supabase is not configured', () => {
  it('is disabled and verifies nothing', async () => {
    const supabase = Supabase.fromEnv({});
    assert.equal(supabase.enabled, false);
    assert.equal(await supabase.verify('anything'), null);
  });

  it('builds from the environment only when both values are present', () => {
    assert.equal(Supabase.fromEnv({ SUPABASE_URL: 'https://x.supabase.co' }).enabled, false);
    assert.equal(Supabase.fromEnv({ SUPABASE_SERVICE_ROLE_KEY: 'k' }).enabled, false);
    assert.equal(
      Supabase.fromEnv({
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'k',
      }).enabled,
      true,
    );
  });

  it('silently does nothing when asked to record a match', async () => {
    const supabase = Supabase.fromEnv({});
    const before = rpcCalls.length;
    await supabase.recordMatch({
      room_code: 'TEST',
      rules: {},
      target_score: 150,
      winning_team: 0,
      score_a: 150,
      score_b: 20,
      rounds_played: 4,
      started_at: new Date().toISOString(),
      players: [],
    });
    assert.equal(rpcCalls.length, before, 'should not have called out');
  });
});

describe('writing match history', () => {
  it('posts the match through record_match with the service role key', async () => {
    const supabase = makeSupabase();
    rpcCalls.length = 0;
    const startedAt = new Date().toISOString();

    await supabase.recordMatch({
      room_code: 'KQ7F',
      rules: { targetScore: 150 },
      target_score: 150,
      winning_team: 1,
      score_a: 95,
      score_b: 151,
      rounds_played: 6,
      started_at: startedAt,
      players: [
        { seat: 0, player_id: 'u0', display_name: 'Ana', team: 0, won: false, pips_left: 12 },
        { seat: 1, player_id: null, display_name: 'Bo', team: 1, won: true, pips_left: 0 },
        { seat: 2, player_id: 'u2', display_name: 'Cyd', team: 0, won: false, pips_left: 7 },
        { seat: 3, player_id: 'u3', display_name: 'Dee', team: 1, won: true, pips_left: 3 },
      ],
    });

    assert.equal(rpcCalls.length, 1);
    const call = rpcCalls[0]!;
    assert.equal(call.fn, 'record_match');
    assert.equal(call.auth, 'Bearer test-service-role-key');
    const payload = (call.body as { payload: Record<string, unknown> }).payload;
    assert.equal(payload['room_code'], 'KQ7F');
    assert.equal(payload['winning_team'], 1);
    assert.equal((payload['players'] as unknown[]).length, 4);
    // A guest seat is recorded with a null account but keeps its name.
    const guest = (payload['players'] as Record<string, unknown>[])[1]!;
    assert.equal(guest['player_id'], null);
    assert.equal(guest['display_name'], 'Bo');
  });

  it('upserts a profile under the player’s account', async () => {
    const supabase = makeSupabase();
    rpcCalls.length = 0;
    await supabase.upsertProfile({ id: 'u9', isAnonymous: true }, 'Shon Pedro');
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0]!.fn, 'upsert_profile');
    assert.deepEqual(rpcCalls[0]!.body, {
      p_id: 'u9',
      p_name: 'Shon Pedro',
      p_anonymous: true,
    });
  });

  it('survives the database being unreachable', async () => {
    const dead = new Supabase({
      url: 'http://127.0.0.1:9',
      serviceRoleKey: 'k',
    });
    // Must resolve rather than throw: a failed write cannot break a game.
    await dead.upsertProfile({ id: 'u1', isAnonymous: false }, 'Ana');
  });
});
