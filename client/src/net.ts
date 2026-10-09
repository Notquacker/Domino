/**
 * WebSocket plumbing: one connection, re-established with backoff, with any
 * message sent while offline queued until it is up again.
 */

import type { ClientMessage, ServerMessage } from '@domino/shared';

export type ServerHandler = (msg: ServerMessage) => void;
export type StatusHandler = (online: boolean) => void;

const MAX_BACKOFF_MS = 8000;

function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class Net {
  private socket: WebSocket | null = null;
  private queue: ClientMessage[] = [];
  private attempts = 0;
  private closedByUs = false;
  private heartbeat: number | null = null;

  constructor(
    private onMessage: ServerHandler,
    private onStatus: StatusHandler,
    /** Called on every (re)connect so the app can identify itself. */
    private onReady: () => void,
  ) {}

  connect(): void {
    this.closedByUs = false;
    const socket = new WebSocket(socketUrl());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.onStatus(true);
      this.onReady();
      const pending = this.queue;
      this.queue = [];
      for (const msg of pending) this.send(msg);
      this.heartbeat = window.setInterval(() => this.send({ t: 'ping' }), 25_000);
    });

    socket.addEventListener('message', (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.onMessage(msg);
    });

    socket.addEventListener('close', () => {
      if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.socket = null;
      this.onStatus(false);
      if (this.closedByUs) return;
      const delay = Math.min(MAX_BACKOFF_MS, 400 * 2 ** this.attempts++);
      window.setTimeout(() => this.connect(), delay);
    });

    socket.addEventListener('error', () => socket.close());
  }

  send(msg: ClientMessage): void {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
      return;
    }
    // Keep real intent, drop keepalives that are meaningless once offline.
    if (msg.t !== 'ping') this.queue.push(msg);
  }

  close(): void {
    this.closedByUs = true;
    this.socket?.close();
  }
}
