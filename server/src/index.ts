/**
 * HTTP + WebSocket entry point.
 *
 * Serves the built client and upgrades `/ws` to a WebSocket. All game logic
 * lives behind `Room`; this file is transport, validation and routing only.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  type Account,
  AccountError,
  Accounts,
  FileAccountStorage,
  SupabaseAccountStorage,
} from './accounts.js';
import {
  type ClientMessage,
  type Move,
  type Seat,
  RuleError,
  SEATS,
} from '@domino/shared';
import { Room, RoomRegistry, sanitizeChat, sanitizeName, type Player } from './rooms.js';
import { Supabase, type AuthedUser } from './supabase.js';

import { parseMove, parseSeat } from './wire.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(HERE, '../../client/dist');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

/** Messages a single socket may send per window, to blunt spam. */
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 10_000;
const MAX_FRAME_BYTES = 4096;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// Socket bookkeeping
// ---------------------------------------------------------------------------

interface Session {
  room: Room | null;
  player: Player | null;
  /** Set once this connection presents a token the server could verify. */
  user: AuthedUser | null;
  /** The signed-in leaderboard account, if any. Never carries a hash. */
  account: Account | null;
  /** The session token minted at sign-in, so logout can revoke it. */
  accountToken: string | null;
  hits: number;
  windowStart: number;
}

const sessions = new Map<WebSocket, Session>();

function sendTo(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

/**
 * Accounts are optional. With no Supabase credentials configured this is a
 * no-op and every player is a guest, exactly as before.
 */
const supabase = Supabase.fromEnv();

/**
 * Where the leaderboard lives.
 *
 * Supabase when it is configured, because a container that restarts from its
 * image loses anything written to its own filesystem, and a leaderboard that
 * resets on every deploy is not a leaderboard. A plain JSON file otherwise,
 * which works anywhere and needs no setup.
 */
const accounts = new Accounts(
  supabase.enabled
    ? new SupabaseAccountStorage(supabase)
    : new FileAccountStorage(process.env['DATA_DIR'] ?? resolve(HERE, '../../data')),
);
const ADMIN_NAME = process.env['ADMIN_USERNAME'] ?? 'Xay';
const ADMIN_FALLBACK_PASSWORD = 'qwerty';

const registry = new RoomRegistry(
  (player, message) => {
    const socket = player.socket as WebSocket | null;
    if (socket !== null) sendTo(socket, message);
  },
  supabase,
  // Fire and forget: a leaderboard write must never hold up the table.
  (winners, played) => {
    void accounts.recordResult(winners, played);
  },
);

function fail(socket: WebSocket, message: string): void {
  sendTo(socket, { t: 'error', message });
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: registry.count() }));
    return;
  }

  // Resolve inside CLIENT_DIR only — never follow `..` out of the tree.
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const candidate = resolve(join(CLIENT_DIR, normalize(requested)));
  const target = candidate.startsWith(CLIENT_DIR) ? candidate : join(CLIENT_DIR, 'index.html');

  let file = target;
  try {
    const stat = await fs.stat(file);
    if (stat.isDirectory()) file = join(file, 'index.html');
    await fs.access(file);
  } catch {
    // Unknown path: fall back to the SPA shell if it exists.
    file = join(CLIENT_DIR, 'index.html');
    try {
      await fs.access(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Client not built. Run `npm run build` first.');
      return;
    }
  }

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const cacheable = file.includes('/assets/');
  res.writeHead(200, {
    'content-type': type,
    'cache-control': cacheable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const http = createServer((req, res) => {
  serveStatic(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error');
  });
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

function attach(session: Session, socket: WebSocket, room: Room, player: Player): void {
  // One socket per player: an older connection for the same token is dropped.
  const previous = player.socket as WebSocket | null;
  if (previous !== null && previous !== socket) {
    const old = sessions.get(previous);
    if (old) {
      old.player = null;
      old.room = null;
    }
    try {
      previous.close(4000, 'replaced by a newer connection');
    } catch {
      /* already gone */
    }
  }
  player.socket = socket;
  player.lastSeen = Date.now();
  // Reconnecting with a token keeps the seat, so re-tie it to whoever is
  // signed in on THIS connection rather than leaving a stale name on it.
  player.accountName = session.account?.id ?? null;
  session.room = room;
  session.player = player;
  room.touch();
}

/** The account as a client may see it: no hash, no salt, ever. */
function sendAccount(socket: WebSocket, session: Session, token?: string): void {
  const account = session.account;
  sendTo(socket, {
    t: 'account',
    account: account === null ? null : accounts.publicOf(account),
    ...(token !== undefined ? { token } : {}),
  });
}

/** Admin-only commands all start the same way. */
function requireAdmin(session: Session): Account {
  const account = session.account;
  if (account === null || !account.isAdmin) throw new RuleError('admins only');
  return account;
}

/** Look up the target of an admin command. */
function targetOf(username: unknown): Account {
  const target = accounts.get(String(username ?? ''));
  if (target === null) throw new RuleError('no such player');
  return target;
}

async function handleAccounts(
  socket: WebSocket,
  session: Session,
  msg: ClientMessage,
): Promise<boolean> {
  switch (msg.t) {
    case 'register': {
      const account = await accounts.register(msg.username, msg.password);
      session.account = account;
      session.accountToken = accounts.startSession(account);
      sendAccount(socket, session, session.accountToken);
      return true;
    }
    case 'login': {
      const account = await accounts.authenticate(msg.username, msg.password);
      // One message for both "no such name" and "wrong password": telling
      // them apart would let anyone map out who has an account.
      if (account === null) throw new RuleError('wrong name or password');
      session.account = account;
      session.accountToken = accounts.startSession(account);
      sendAccount(socket, session, session.accountToken);
      return true;
    }
    case 'restore': {
      const account = accounts.fromSession(msg.token);
      session.account = account;
      session.accountToken = account === null ? null : String(msg.token);
      sendAccount(socket, session);
      return true;
    }
    case 'logout': {
      if (session.accountToken !== null) accounts.endSession(session.accountToken);
      session.account = null;
      session.accountToken = null;
      sendAccount(socket, session);
      return true;
    }
    case 'changePassword': {
      const account = session.account;
      if (account === null) throw new RuleError('sign in first');
      await accounts.changeOwnPassword(account, msg.current, msg.next);
      // Changing the password drops every session, this one included, so the
      // client is handed a fresh token rather than being silently logged out.
      session.accountToken = accounts.startSession(account);
      sendAccount(socket, session, session.accountToken);
      return true;
    }
    case 'leaderboard':
      sendTo(socket, { t: 'leaders', rows: accounts.leaderboard() });
      return true;
    case 'adminUsers':
      requireAdmin(session);
      sendTo(socket, { t: 'adminUsers', users: accounts.everyone() });
      return true;
    case 'adminSetPassword': {
      requireAdmin(session);
      await accounts.setPassword(targetOf(msg.username), msg.next, true);
      sendTo(socket, { t: 'adminUsers', users: accounts.everyone() });
      return true;
    }
    case 'adminSetWins': {
      requireAdmin(session);
      await accounts.setWins(targetOf(msg.username), Number(msg.wins));
      sendTo(socket, { t: 'adminUsers', users: accounts.everyone() });
      return true;
    }
    case 'adminSetAdmin': {
      const me = requireAdmin(session);
      const target = targetOf(msg.username);
      // Removing your own admin rights could leave the table with none.
      if (target.id === me.id && !msg.isAdmin) {
        throw new RuleError('you cannot take away your own admin rights');
      }
      await accounts.setAdmin(target, Boolean(msg.isAdmin));
      sendTo(socket, { t: 'adminUsers', users: accounts.everyone() });
      return true;
    }
    case 'adminDelete': {
      const me = requireAdmin(session);
      const target = targetOf(msg.username);
      if (target.id === me.id) throw new RuleError('you cannot delete yourself');
      await accounts.remove(target);
      sendTo(socket, { t: 'adminUsers', users: accounts.everyone() });
      return true;
    }
    default:
      return false;
  }
}

async function handle(socket: WebSocket, session: Session, msg: ClientMessage): Promise<void> {
  if (msg.t === 'ping') {
    sendTo(socket, { t: 'pong' });
    return;
  }

  if (await handleAccounts(socket, session, msg)) return;

  if (msg.t === 'auth') {
    // A token that does not verify is not an error worth closing over — the
    // player simply stays a guest.
    const user = await supabase.verify(String(msg.jwt ?? ''));
    session.user = user;
    if (user !== null && session.player !== null) session.player.user = user;
    sendTo(socket, { t: 'authed', ok: user !== null, anonymous: user?.isAnonymous ?? false });
    if (user !== null && session.player !== null) {
      void supabase.upsertProfile(user, session.player.name);
      session.room?.broadcastState();
    }
    return;
  }

  if (msg.t === 'create') {
    const room = registry.create(msg.rules);
    const player = room.addPlayer(sanitizeName(msg.name), session.user);
    // Tie the seat to the signed-in account so a win can be credited.
    player.accountName = session.account?.id ?? null;
    attach(session, socket, room, player);
    if (session.user !== null) void supabase.upsertProfile(session.user, player.name);
    room.sit(player, 0);
    room.pushLog(`${player.name} opened the table.`);
    sendTo(socket, { t: 'welcome', code: room.code, token: player.id, view: room.viewFor(player) });
    room.broadcastState();
    return;
  }

  if (msg.t === 'join') {
    const room = registry.get(msg.code);
    if (room === null) {
      fail(socket, 'No table with that code. Check the letters and try again.');
      return;
    }
    const player = room.addPlayer(sanitizeName(msg.name), session.user);
    // Tie the seat to the signed-in account so a win can be credited.
    player.accountName = session.account?.id ?? null;
    attach(session, socket, room, player);
    if (session.user !== null) void supabase.upsertProfile(session.user, player.name);
    // Seat them automatically if there is room; otherwise they watch.
    const free = SEATS.find((s) => room.playerAtSeat(s) === null);
    if (free !== undefined && room.match === null) room.sit(player, free);
    room.pushLog(
      player.seat === null ? `${player.name} is watching.` : `${player.name} sat down.`,
    );
    sendTo(socket, { t: 'welcome', code: room.code, token: player.id, view: room.viewFor(player) });
    room.broadcastState();
    return;
  }

  if (msg.t === 'resume') {
    const room = registry.get(msg.code);
    const player = room?.players.get(String(msg.token ?? '')) ?? null;
    if (room === null || player === null) {
      fail(socket, 'That table is no longer available.');
      return;
    }
    attach(session, socket, room, player);
    // A resumed seat picks up whatever account this connection authenticated.
    if (session.user !== null) player.user = session.user;
    room.pushLog(`${player.name} reconnected.`);
    sendTo(socket, { t: 'welcome', code: room.code, token: player.id, view: room.viewFor(player) });
    room.broadcastState();
    return;
  }

  const room = session.room;
  const player = session.player;
  if (room === null || player === null) {
    fail(socket, 'Join a table first.');
    return;
  }
  player.lastSeen = Date.now();

  switch (msg.t) {
    case 'sit':
      room.sit(player, parseSeat(msg.seat));
      room.broadcastState();
      return;
    case 'stand':
      room.stand(player);
      room.broadcastState();
      return;
    case 'addBot':
      room.addBot(player);
      room.broadcastState();
      return;
    case 'removeBot':
      room.removeBot(player, parseSeat(msg.seat));
      room.broadcastState();
      return;
    case 'start':
      room.start(player);
      room.broadcastState();
      return;
    case 'move':
      room.move(player, parseMove(msg.move));
      room.broadcastState();
      return;
    case 'nextRound':
      room.nextRound(player);
      room.broadcastState();
      return;
    case 'rematch':
      room.rematch(player);
      room.broadcastState();
      return;
    case 'abandon':
      room.abandon(player);
      room.broadcastState();
      return;
    case 'callOut':
      room.callOut(player, parseSeat(msg.seat));
      room.broadcastState();
      return;
    case 'smash':
      room.smash(player);
      room.broadcastState();
      return;
    case 'chat': {
      const text = sanitizeChat(msg.text);
      if (text.length > 0) room.broadcastChat(player.name, text);
      return;
    }
    default:
      fail(socket, 'Unknown request.');
  }
}

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_FRAME_BYTES });

wss.on('connection', (socket: WebSocket) => {
  const session: Session = {
    room: null,
    player: null,
    user: null,
    account: null,
    accountToken: null,
    hits: 0,
    windowStart: Date.now(),
  };
  sessions.set(socket, session);

  socket.on('message', (data) => {
    const now = Date.now();
    if (now - session.windowStart > RATE_WINDOW_MS) {
      session.windowStart = now;
      session.hits = 0;
    }
    if (++session.hits > RATE_LIMIT) {
      fail(socket, 'Slow down.');
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(data)) as ClientMessage;
    } catch {
      fail(socket, 'Malformed message.');
      return;
    }

    handle(socket, session, msg).catch((err: unknown) => {
      if (err instanceof RuleError || err instanceof AccountError) {
        // Both are refusals the player should read, not server faults. An
        // AccountError never carries a password or a hash in its message.
        fail(socket, err.message);
      } else {
        console.error('[domino] handler error', err);
        fail(socket, 'Something went wrong on the server.');
      }
    });
  });

  socket.on('close', () => {
    const { room, player } = session;
    sessions.delete(socket);
    if (room === null || player === null) return;
    // Only clear the socket if it is still the live one for this player.
    if (player.socket === socket) player.socket = null;
    player.lastSeen = Date.now();
    // Before the match starts a leaver frees their seat; afterwards the seat is
    // held so they can resume, and the turn clock plays on their behalf.
    if (room.match === null) {
      room.removePlayer(player);
      room.pushLog(`${player.name} left.`);
    } else {
      room.pushLog(`${player.name} disconnected.`);
    }
    room.touch();
    room.broadcastState();
  });

  socket.on('error', () => {
    /* close handler does the cleanup */
  });
});

// Drop sockets that stop answering heartbeats.
const alive = new WeakSet<WebSocket>();
wss.on('connection', (socket: WebSocket) => {
  alive.add(socket);
  socket.on('pong', () => alive.add(socket));
});
setInterval(() => {
  for (const socket of wss.clients) {
    const ws = socket as WebSocket;
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 30_000).unref();

async function boot(): Promise<void> {
  await accounts.load();
  // Only seed the admin when the store actually read. Doing it blind after a
  // failed read would write the placeholder password over a real account.
  const admin = accounts.usable
    ? await accounts.ensureAdmin(ADMIN_NAME, ADMIN_FALLBACK_PASSWORD)
    : { created: false, usingFallback: false };

  http.listen(PORT, HOST, () => {
    console.log(`[domino] listening on http://${HOST}:${PORT}`);
    console.log(
      supabase.enabled
        ? '[domino] match history enabled'
        : '[domino] no Supabase configured — match history off',
    );
    if (accounts.usable) {
      console.log(`[domino] ${accounts.count()} account(s) loaded from ${accounts.label}`);
    } else {
      console.error(
        `[domino] accounts are OFF: ${accounts.label} could not be read. ` +
          'The game still plays; signing in does not.',
      );
    }
    if (!supabase.enabled) {
      console.warn(
        '[domino] accounts are in a local file — a host that rebuilds its ' +
          'container will lose them. Set SUPABASE_URL and ' +
          'SUPABASE_SERVICE_ROLE_KEY to keep them.',
      );
    }
    if (admin.usingFallback) {
      // Said plainly and every boot, because a known default password on a
      // public URL is exactly the thing that gets forgotten about.
      console.warn(
        `[domino] WARNING: admin "${ADMIN_NAME}" is using the placeholder password. ` +
          'Set ADMIN_PASSWORD in the environment, or change it from the app.',
      );
    }
  });
}

void boot();

function shutdown(): void {
  console.log('[domino] shutting down');
  for (const socket of wss.clients) (socket as WebSocket).close(1001, 'server shutting down');
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
