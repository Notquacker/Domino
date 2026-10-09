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
  type ClientMessage,
  type Move,
  type Seat,
  RuleError,
  SEATS,
} from '@domino/shared';
import { Room, RoomRegistry, sanitizeChat, sanitizeName, type Player } from './rooms.js';

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
  hits: number;
  windowStart: number;
}

const sessions = new Map<WebSocket, Session>();

function sendTo(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

const registry = new RoomRegistry((player, message) => {
  const socket = player.socket as WebSocket | null;
  if (socket !== null) sendTo(socket, message);
});

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

function parseSeat(value: unknown): Seat {
  const n = Number(value);
  if (!SEATS.includes(n as Seat)) throw new RuleError('no such seat');
  return n as Seat;
}

function parseMove(value: unknown): Move {
  if (typeof value !== 'object' || value === null) throw new RuleError('malformed move');
  const raw = value as { kind?: unknown; tile?: unknown; end?: unknown };
  if (raw.kind === 'pass') return { kind: 'pass' };
  if (raw.kind === 'play') {
    if (typeof raw.tile !== 'string') throw new RuleError('malformed move');
    if (raw.end !== 'left' && raw.end !== 'right') throw new RuleError('malformed move');
    return { kind: 'play', tile: raw.tile, end: raw.end };
  }
  throw new RuleError('malformed move');
}

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
  session.room = room;
  session.player = player;
  room.touch();
}

function handle(socket: WebSocket, session: Session, msg: ClientMessage): void {
  if (msg.t === 'ping') {
    sendTo(socket, { t: 'pong' });
    return;
  }

  if (msg.t === 'create') {
    const room = registry.create(msg.rules);
    const player = room.addPlayer(sanitizeName(msg.name));
    attach(session, socket, room, player);
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
    const player = room.addPlayer(sanitizeName(msg.name));
    attach(session, socket, room, player);
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
  const session: Session = { room: null, player: null, hits: 0, windowStart: Date.now() };
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

    try {
      handle(socket, session, msg);
    } catch (err) {
      if (err instanceof RuleError) {
        fail(socket, err.message);
      } else {
        console.error('[domino] handler error', err);
        fail(socket, 'Something went wrong on the server.');
      }
    }
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

http.listen(PORT, HOST, () => {
  console.log(`[domino] listening on http://${HOST}:${PORT}`);
});

function shutdown(): void {
  console.log('[domino] shutting down');
  for (const socket of wss.clients) (socket as WebSocket).close(1001, 'server shutting down');
  http.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
