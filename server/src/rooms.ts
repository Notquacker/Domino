/**
 * Room and match lifecycle.
 *
 * One `Room` per game, addressed by a short code players can read aloud. The
 * room holds the only authoritative `MatchState`; sockets receive redacted
 * per-player views. Players are identified by a token rather than a socket, so
 * a dropped connection can resume the same seat.
 */

import { randomBytes, randomInt } from 'node:crypto';
import {
  type HouseRules,
  type MatchState,
  type Move,
  type PlayerView,
  type RoundResult,
  type Seat,
  type SeatInfo,
  DEFAULT_RULES,
  PROTOCOL_VERSION,
  RuleError,
  SEATS,
  applyMove,
  describeResult,
  legalMoves,
  newMatch,
  openEnds,
  seededRng,
  startNextRound,
  teamName,
} from '@domino/shared';

/** Seconds a player has to move before the server plays for them. */
export const TURN_SECONDS = 60;
/** A room with no connected players is reclaimed after this long. */
export const ROOM_IDLE_MS = 30 * 60 * 1000;
const MAX_LOG = 60;
const MAX_NAME = 20;
const MAX_CHAT = 300;

/** Unambiguous alphabet: no O/0, I/1, or similar look-alikes. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface Player {
  readonly id: string;
  name: string;
  seat: Seat | null;
  socket: unknown | null;
  lastSeen: number;
}

export type Broadcast = (player: Player, message: unknown) => void;

function cryptoRng(): () => number {
  // Seed the shuffle from a real CSPRNG so hands are not predictable.
  return seededRng(randomInt(0, 2 ** 31 - 1));
}

export function sanitizeName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  const cleaned = text.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return cleaned.length > 0 ? cleaned : 'Player';
}

export function sanitizeChat(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT);
}

function mergeRules(partial: Partial<HouseRules> | undefined): HouseRules {
  if (!partial) return DEFAULT_RULES;
  const target = [100, 150, 200].includes(Number(partial.targetScore))
    ? Number(partial.targetScore)
    : DEFAULT_RULES.targetScore;
  const bonus = Number(partial.capicuBonus);
  return {
    targetScore: target,
    mustOpenDoubleSix:
      typeof partial.mustOpenDoubleSix === 'boolean'
        ? partial.mustOpenDoubleSix
        : DEFAULT_RULES.mustOpenDoubleSix,
    countAllRemaining:
      typeof partial.countAllRemaining === 'boolean'
        ? partial.countAllRemaining
        : DEFAULT_RULES.countAllRemaining,
    capicuBonus: Number.isFinite(bonus) && bonus >= 0 && bonus <= 50 ? Math.floor(bonus) : 0,
  };
}

export class Room {
  readonly code: string;
  readonly players = new Map<string, Player>();
  rules: HouseRules;
  hostId: string | null = null;
  match: MatchState | null = null;
  log: string[] = [];
  turnDeadline: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private emptySince: number | null = Date.now();

  constructor(code: string, rules: Partial<HouseRules> | undefined, private send: Broadcast) {
    this.code = code;
    this.rules = mergeRules(rules);
  }

  // -- membership ----------------------------------------------------------

  addPlayer(name: string): Player {
    const player: Player = {
      id: randomBytes(16).toString('hex'),
      name: sanitizeName(name),
      seat: null,
      socket: null,
      lastSeen: Date.now(),
    };
    this.players.set(player.id, player);
    if (this.hostId === null) this.hostId = player.id;
    return player;
  }

  playerAtSeat(seat: Seat): Player | null {
    for (const p of this.players.values()) if (p.seat === seat) return p;
    return null;
  }

  seatedCount(): number {
    return SEATS.filter((s) => this.playerAtSeat(s) !== null).length;
  }

  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.socket !== null) n++;
    return n;
  }

  /** Called whenever a socket attaches or detaches, to drive room reclamation. */
  touch(): void {
    this.emptySince = this.connectedCount() === 0 ? Date.now() : null;
  }

  isReclaimable(now: number): boolean {
    return this.emptySince !== null && now - this.emptySince > ROOM_IDLE_MS;
  }

  sit(player: Player, seat: Seat): void {
    if (!SEATS.includes(seat)) throw new RuleError('no such seat');
    if (this.match !== null) throw new RuleError('the match has already started');
    const occupant = this.playerAtSeat(seat);
    if (occupant !== null && occupant.id !== player.id) throw new RuleError('seat is taken');
    player.seat = seat;
  }

  stand(player: Player): void {
    if (this.match !== null) throw new RuleError('cannot leave a seat mid-match');
    player.seat = null;
  }

  /** Drop a player entirely. Only safe in the lobby; mid-match seats persist. */
  removePlayer(player: Player): void {
    if (this.match === null) {
      this.players.delete(player.id);
      if (this.hostId === player.id) {
        const next = this.players.values().next();
        this.hostId = next.done ? null : next.value.id;
      }
    }
  }

  // -- match flow ----------------------------------------------------------

  start(player: Player): void {
    if (this.hostId !== player.id) throw new RuleError('only the host can start the match');
    if (this.match !== null) throw new RuleError('already started');
    if (this.seatedCount() !== 4) {
      throw new RuleError('all four seats must be filled — this game is played two against two');
    }
    this.match = newMatch(this.rules, cryptoRng());
    this.pushLog(
      `Match to ${this.rules.targetScore}. ${this.seatLabel(this.match.round?.turn ?? 0)} opens.`,
    );
    this.armTimer();
  }

  move(player: Player, move: Move): void {
    const match = this.match;
    if (match === null) throw new RuleError('the match has not started');
    if (player.seat === null) throw new RuleError('you are watching, not playing');
    const outcome = applyMove(match, player.seat, move);
    this.match = outcome.match;
    this.pushLog(this.describeMove(player, move));
    if (outcome.result !== null) this.pushLog(this.describeRoundResult(outcome.result));
    this.armTimer();
  }

  nextRound(player: Player): void {
    const match = this.match;
    if (match === null) throw new RuleError('the match has not started');
    if (match.phase !== 'roundOver') throw new RuleError('the round is still going');
    if (player.seat === null) throw new RuleError('only players can deal');
    this.match = startNextRound(match, cryptoRng());
    this.pushLog(
      `Round ${this.match.roundNumber}. ${this.seatLabel(this.match.round?.turn ?? 0)} opens.`,
    );
    this.armTimer();
  }

  rematch(player: Player): void {
    if (this.hostId !== player.id) throw new RuleError('only the host can start a rematch');
    if (this.match === null || this.match.phase !== 'matchOver') {
      throw new RuleError('the match is not finished');
    }
    this.match = newMatch(this.rules, cryptoRng());
    this.log = [];
    this.pushLog(`Rematch to ${this.rules.targetScore}.`);
    this.armTimer();
  }

  /**
   * Keep the game moving when someone stalls or drops: play their first legal
   * move, or pass when they have none.
   */
  private autoPlay(): void {
    const match = this.match;
    if (match === null || match.phase !== 'playing' || match.round === null) return;
    const seat = match.round.turn;
    const moves = legalMoves(match.round, seat);
    const choice: Move = moves[0] ?? { kind: 'pass' };
    try {
      const outcome = applyMove(match, seat, choice);
      this.match = outcome.match;
      this.pushLog(
        choice.kind === 'pass'
          ? `${this.seatLabel(seat)} ran out of time and passed.`
          : `${this.seatLabel(seat)} ran out of time — played ${choice.tile} automatically.`,
      );
      if (outcome.result !== null) this.pushLog(this.describeRoundResult(outcome.result));
    } catch {
      // A rules error here would mean a bug rather than bad input; stop the
      // clock instead of looping on it.
      this.turnDeadline = null;
      return;
    }
    this.armTimer();
    this.broadcastState();
  }

  private armTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.match === null || this.match.phase !== 'playing') {
      this.turnDeadline = null;
      return;
    }
    this.turnDeadline = Date.now() + TURN_SECONDS * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.autoPlay();
    }, TURN_SECONDS * 1000);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  // -- logging & views -----------------------------------------------------

  seatLabel(seat: Seat): string {
    const p = this.playerAtSeat(seat);
    return p?.name ?? `Seat ${seat + 1}`;
  }

  pushLog(line: string): void {
    this.log.push(line);
    if (this.log.length > MAX_LOG) this.log = this.log.slice(-MAX_LOG);
  }

  private describeMove(player: Player, move: Move): string {
    if (move.kind === 'pass') return `${player.name} passed.`;
    return `${player.name} played ${move.tile}.`;
  }

  private describeRoundResult(r: RoundResult): string {
    if (r.kind === 'tie') return describeResult(r);
    const team = r.winningTeam === null ? '' : teamName(r.winningTeam);
    if (r.kind === 'domino' && r.dominoedBy !== null) {
      const capicu = r.capicu ? ' (capicu!)' : '';
      return `${this.seatLabel(r.dominoedBy)} went out${capicu} — ${team} scores ${r.points}.`;
    }
    return `Blocked — ${team} had the fewer pips and scores ${r.points}.`;
  }

  viewFor(player: Player): PlayerView {
    const match = this.match;
    const round = match?.round ?? null;
    const seat = player.seat;

    const seats: (SeatInfo | null)[] = SEATS.map((s) => {
      const p = this.playerAtSeat(s);
      if (p === null) return null;
      return {
        name: p.name,
        connected: p.socket !== null,
        tiles: round === null ? 0 : (round.hands[s] ?? []).length,
      };
    });

    const hand = seat !== null && round !== null ? (round.hands[seat] ?? []) : [];
    const canAct = seat !== null && round !== null && match?.phase === 'playing';

    let spectators = 0;
    for (const p of this.players.values()) if (p.seat === null) spectators++;

    return {
      v: PROTOCOL_VERSION,
      code: this.code,
      phase: match === null ? 'lobby' : match.phase,
      rules: this.rules,
      you: seat,
      isHost: this.hostId === player.id,
      seats,
      hand,
      board: round?.board ?? [],
      ends: round === null ? null : openEnds(round.board),
      turn: match?.phase === 'playing' ? (round?.turn ?? null) : null,
      scores: match?.scores ?? [0, 0],
      roundNumber: match?.roundNumber ?? 0,
      legal: canAct ? legalMoves(round, seat) : [],
      lastResult: match?.lastResult ?? null,
      winner: match?.winner ?? null,
      log: this.log,
      turnDeadline: match?.phase === 'playing' ? this.turnDeadline : null,
      spectators,
    };
  }

  broadcastState(): void {
    for (const p of this.players.values()) {
      if (p.socket === null) continue;
      this.send(p, { t: 'state', view: this.viewFor(p) });
    }
  }

  broadcastChat(from: string, text: string): void {
    const payload = { t: 'chat', from, text, at: Date.now() };
    for (const p of this.players.values()) {
      if (p.socket === null) continue;
      this.send(p, payload);
    }
  }
}

export class RoomRegistry {
  private rooms = new Map<string, Room>();

  constructor(private send: Broadcast) {
    setInterval(() => this.reap(), 60_000).unref();
  }

  private freshCode(): string {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = '';
      for (let i = 0; i < 4; i++) {
        code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('could not allocate a room code');
  }

  create(rules: Partial<HouseRules> | undefined): Room {
    const room = new Room(this.freshCode(), rules, this.send);
    this.rooms.set(room.code, room);
    return room;
  }

  get(code: string): Room | null {
    return this.rooms.get(String(code ?? '').toUpperCase().trim()) ?? null;
  }

  count(): number {
    return this.rooms.size;
  }

  private reap(): void {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.isReclaimable(now)) {
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }
}
