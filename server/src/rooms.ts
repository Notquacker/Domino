/**
 * Room and match lifecycle.
 *
 * One `Room` per game, addressed by a short code players can read aloud. The
 * room holds the only authoritative `MatchState`; sockets receive redacted
 * per-player views. Players are identified by a token rather than a socket, so
 * a dropped connection can resume the same seat.
 */

import { randomBytes, randomInt } from 'node:crypto';
import type { AuthedUser, MatchPlayerRecord, MatchRecord, Supabase } from './supabase.js';
import { type BotContext, BOT_NAMES, chooseMove, provenFalsePass, shouldCallOut } from './bot.js';
import {
  type HouseRules,
  type MatchState,
  type Move,
  type Pip,
  type PlayerView,
  type RoundResult,
  type ScoringMode,
  type Seat,
  type SeatInfo,
  DEFAULT_RULES,
  PIP_RULES,
  PROTOCOL_VERSION,
  RuleError,
  SEATS,
  applyMove,
  callOut,
  describeResult,
  legalMoves,
  newMatch,
  openEnds,
  seatsThatPassed,
  seededRng,
  startNextRound,
  teamName,
  teamOf,
  tileHas,
} from '@domino/shared';

/** Default seconds a player has to move. A table can set its own, or none. */
export const TURN_SECONDS = 60;

/** How long a computer player appears to think before it plays. */
export const BOT_THINK_MS = 900;
/** A room with no connected players is reclaimed after this long. */
export const ROOM_IDLE_MS = 30 * 60 * 1000;
const MAX_LOG = 60;
const MAX_NAME = 20;
const MAX_CHAT = 300;

/** Unambiguous alphabet: no O/0, I/1, or similar look-alikes. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface Player {
  /** Room-scoped session token, used to resume a seat. Not an account id. */
  readonly id: string;
  name: string;
  seat: Seat | null;
  socket: unknown | null;
  lastSeen: number;
  /** Supabase account, when the connection presented a valid token. */
  user: AuthedUser | null;
  /** A computer player: it holds a seat but never has a socket. */
  readonly isBot: boolean;
  /** Leaderboard account signed in on this connection, if any. */
  accountName: string | null;
}

export type Broadcast = (player: Player, message: unknown) => void;

/**
 * Called once when a match finishes, with the usernames to credit. Separate
 * from the Supabase history write because the leaderboard has to work whether
 * or not Supabase is configured.
 */
export type OnFinished = (winners: readonly string[], played: readonly string[]) => void;

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

function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Build a trusted rule set from whatever the client asked for. Anything
 * missing or out of range falls back to the default rather than being
 * rejected, so an old or odd client cannot wedge table creation.
 */
function mergeRules(partial: Partial<HouseRules> | undefined): HouseRules {
  if (!partial) return DEFAULT_RULES;

  const scoring: ScoringMode = partial.scoring === 'pips' ? 'pips' : 'rounds';
  const base = scoring === 'pips' ? PIP_RULES : DEFAULT_RULES;

  // Round scoring runs to a small number; pip scoring to a big one.
  const target =
    scoring === 'pips'
      ? [100, 150, 200].includes(Number(partial.targetScore))
        ? Number(partial.targetScore)
        : base.targetScore
      : clampInt(partial.targetScore, 1, 21, base.targetScore);

  // A drawn line at or above the target could never be reached sensibly, so
  // anything out of range simply turns the rule off.
  const rawDraw = partial.drawAt;
  const drawAt =
    rawDraw === null || rawDraw === undefined
      ? rawDraw === null
        ? null
        : base.drawAt
      : Number.isFinite(Number(rawDraw)) && Number(rawDraw) >= 1 && Number(rawDraw) < target
        ? Math.floor(Number(rawDraw))
        : null;

  return {
    scoring,
    targetScore: target,
    winBy: clampInt(partial.winBy, 1, 5, base.winBy),
    drawAt,
    // null means "deal whatever falls", so it is a choice, not an absence.
    maxDoublesInHand:
      partial.maxDoublesInHand === undefined
        ? base.maxDoublesInHand
        : partial.maxDoublesInHand === null
          ? null
          : clampInt(partial.maxDoublesInHand, 1, 7, base.maxDoublesInHand ?? 4),
    blockedByLowestPlayer: bool(partial.blockedByLowestPlayer, base.blockedByLowestPlayer),
    // null is a real choice here (no clock at all), so it has to be told
    // apart from the field simply being absent.
    turnSeconds:
      partial.turnSeconds === undefined
        ? base.turnSeconds
        : partial.turnSeconds === null
          ? null
          : clampInt(partial.turnSeconds, 10, 600, base.turnSeconds ?? TURN_SECONDS),
    mustOpenDoubleSix: bool(partial.mustOpenDoubleSix, base.mustOpenDoubleSix),
    doubleSixOpensEveryRound: bool(
      partial.doubleSixOpensEveryRound,
      base.doubleSixOpensEveryRound,
    ),
    openWithAnyDouble: bool(partial.openWithAnyDouble, base.openWithAnyDouble),
    strictPassing: bool(partial.strictPassing, base.strictPassing),
    falsePassPenalty: clampInt(partial.falsePassPenalty, 0, 10, base.falsePassPenalty),
    falsePassForfeits: bool(partial.falsePassForfeits, base.falsePassForfeits),
    countAllRemaining: bool(partial.countAllRemaining, base.countAllRemaining),
    capicuPoints: clampInt(partial.capicuPoints, 0, 50, base.capicuPoints),
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
  private startedAt: Date | null = null;
  /** Set once the capicú winners have slammed the table this round. */
  private smashedThisRound = false;
  /** Guards against writing the same finished match more than once. */
  private recorded = false;
  /**
   * Pips each seat has publicly shown they cannot match, from the passes made
   * this round. Rebuilt every round. This is open information — the ends were
   * on the table when the pass was made — and it is what lets a computer
   * player read the game instead of guessing.
   */
  private voids: Pip[][] = [[], [], [], []];
  /**
   * Seats proven to have passed on a playable tile, from public play alone:
   * they passed while a pip was on an end, then later laid a tile carrying
   * that pip. With the whole set dealt and no boneyard, they must have been
   * holding it at the time.
   */
  private caught = new Set<Seat>();
  private botTimer: NodeJS.Timeout | null = null;

  constructor(
    code: string,
    rules: Partial<HouseRules> | undefined,
    private send: Broadcast,
    private supabase: Supabase | null = null,
    /** Overridable so tests do not have to sit through the thinking pause. */
    private thinkMs: number = BOT_THINK_MS,
    private onFinished: OnFinished | null = null,
  ) {
    this.code = code;
    this.rules = mergeRules(rules);
  }

  // -- membership ----------------------------------------------------------

  addPlayer(name: string, user: AuthedUser | null = null): Player {
    const player: Player = {
      id: randomBytes(16).toString('hex'),
      name: sanitizeName(name),
      seat: null,
      socket: null,
      lastSeen: Date.now(),
      user,
      isBot: false,
      accountName: null,
    };
    this.players.set(player.id, player);
    if (this.hostId === null) this.hostId = player.id;
    return player;
  }

  /**
   * Seat a computer player. Lobby only, host only, and never as the host
   * itself: a room whose host is a bot could never be started or dealt.
   */
  addBot(by: Player): Player {
    if (this.hostId !== by.id) throw new RuleError('only the host can add a computer player');
    if (this.match !== null) throw new RuleError('the match has already started');
    const seat = SEATS.find((s) => this.playerAtSeat(s) === null);
    if (seat === undefined) throw new RuleError('every seat is taken');
    const taken = new Set([...this.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${seat + 1}`;
    const bot: Player = {
      id: randomBytes(16).toString('hex'),
      name,
      seat,
      socket: null,
      lastSeen: Date.now(),
      user: null,
      isBot: true,
      accountName: null,
    };
    this.players.set(bot.id, bot);
    return bot;
  }

  removeBot(by: Player, seat: Seat): void {
    if (this.hostId !== by.id) throw new RuleError('only the host can remove a computer player');
    if (this.match !== null) throw new RuleError('cannot change seats mid-match');
    const sitting = this.playerAtSeat(seat);
    if (sitting === null || !sitting.isBot) throw new RuleError('no computer player there');
    this.players.delete(sitting.id);
  }

  /** Is a computer player sitting in this seat? */
  private botAt(seat: Seat): Player | null {
    const p = this.playerAtSeat(seat);
    return p !== null && p.isBot ? p : null;
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
    this.startedAt = new Date();
    this.recorded = false;
    this.pushLog(
      `Match to ${this.rules.targetScore}. ${this.seatLabel(this.match.round?.turn ?? 0)} opens.`,
    );
    this.voids = [[], [], [], []];
    this.caught.clear();
    this.armTimer();
    this.scheduleBot();
  }

  move(player: Player, move: Move): void {
    const match = this.match;
    if (match === null) throw new RuleError('the match has not started');
    if (player.seat === null) throw new RuleError('you are watching, not playing');
    this.noteMove(player.seat, move);
    const outcome = applyMove(match, player.seat, move);
    this.match = outcome.match;
    if (outcome.result !== null) this.smashedThisRound = false;
    this.pushLog(this.describeMove(player, move));
    if (outcome.result !== null) this.pushLog(this.describeRoundResult(outcome.result));
    this.armTimer();
    this.maybeRecord();
    this.scheduleBot();
  }

  nextRound(player: Player): void {
    const match = this.match;
    if (match === null) throw new RuleError('the match has not started');
    if (match.phase !== 'roundOver') throw new RuleError('the round is still going');
    if (player.seat === null) throw new RuleError('only players can deal');
    this.smashedThisRound = false;
    this.match = startNextRound(match, cryptoRng());
    this.pushLog(
      `Round ${this.match.roundNumber}. ${this.seatLabel(this.match.round?.turn ?? 0)} opens.`,
    );
    this.voids = [[], [], [], []];
    this.caught.clear();
    this.armTimer();
    this.scheduleBot();
  }

  rematch(player: Player): void {
    if (this.hostId !== player.id) throw new RuleError('only the host can start a rematch');
    if (this.match === null || this.match.phase !== 'matchOver') {
      throw new RuleError('the match is not finished');
    }
    this.match = newMatch(this.rules, cryptoRng());
    this.startedAt = new Date();
    this.recorded = false;
    this.smashedThisRound = false;
    this.log = [];
    this.pushLog(`Rematch to ${this.rules.targetScore}.`);
    this.voids = [[], [], [], []];
    this.caught.clear();
    this.armTimer();
    this.scheduleBot();
  }

  /** May this seat slam the table right now? */
  private maySmash(seat: Seat | null): boolean {
    const match = this.match;
    if (seat === null || match === null || this.smashedThisRound) return false;
    const result = match.lastResult;
    if (result === null || !result.capicu) return false;
    if (match.phase !== 'roundOver' && match.phase !== 'matchOver') return false;
    return result.winningTeam === teamOf(seat);
  }

  /** Slam the table. Earned only by taking the round with a capicú. */
  /**
   * Throw the match away and go back to the lobby.
   *
   * Only on a table with a computer player at it. Abandoning a game that real
   * people are in the middle of would be a way to wipe a losing scoreboard,
   * so a human table has to be played out or left seat by seat.
   */
  abandon(player: Player): void {
    if (this.hostId !== player.id) throw new RuleError('only the host can cancel the game');
    if (this.match === null) throw new RuleError('no game to cancel');
    if (!SEATS.some((s) => this.botAt(s) !== null)) {
      throw new RuleError('a table of real players has to be played out');
    }
    if (this.botTimer !== null) clearTimeout(this.botTimer);
    this.botTimer = null;
    this.match = null;
    this.recorded = false;
    this.smashedThisRound = false;
    this.voids = [[], [], [], []];
    this.caught.clear();
    this.startedAt = null;
    this.log = [];
    this.pushLog(`${player.name} cancelled the game.`);
    this.armTimer();
  }

  /** Accuse an opponent of passing on a playable tile. Ends the round. */
  callOut(player: Player, accused: Seat): void {
    const match = this.match;
    if (match === null) throw new RuleError('the match has not started');
    if (player.seat === null) throw new RuleError('you are watching, not playing');
    const outcome = callOut(match, player.seat, accused);
    this.match = outcome.match;
    this.smashedThisRound = false;
    this.pushLog(
      `${player.name} called out ${this.seatLabel(accused)} — ` +
        `${outcome.result?.calledOut?.correct ? 'and was right!' : 'and was wrong.'}`,
    );
    if (outcome.result !== null) this.pushLog(this.describeRoundResult(outcome.result));
    this.armTimer();
    this.scheduleBot();
    this.maybeRecord();
  }

  smash(player: Player): void {
    if (!this.maySmash(player.seat)) {
      throw new RuleError('a smash is earned by taking the round with a capicú');
    }
    this.smashedThisRound = true;
    this.pushLog(`${player.name} slammed the table!`);
    const payload = { t: 'smashed', by: player.seat, name: player.name };
    for (const p of this.players.values()) {
      if (p.socket !== null) this.send(p, payload);
    }
  }

  /**
   * Record what a pass gives away, BEFORE it is applied: at that moment the
   * open ends are still the ones the player failed to match, so everyone at
   * the table learns they hold neither pip.
   */
  private noteMove(seat: Seat, move: Move): void {
    const known = this.voids[seat] as Pip[];
    if (move.kind === 'pass') {
      const ends = openEnds(this.match?.round?.board ?? []);
      if (ends === null) return;
      for (const pip of [ends.left, ends.right]) if (!known.includes(pip)) known.push(pip);
      return;
    }
    // They are laying a tile they claimed not to have. Caught in the open.
    if (provenFalsePass(move.tile, known)) {
      this.caught.add(seat);
      // The void was a lie, so stop reasoning from it.
      this.voids[seat] = known.filter((pip) => !tileHas(move.tile, pip));
    }
  }

  /**
   * Hand a computer player only what someone sitting in that seat could see:
   * its own tiles, the board, the public tile counts, and what the passes
   * have revealed. The round itself never goes across this line, so a bot
   * cannot read another hand even by mistake.
   */
  private contextFor(seat: Seat): BotContext | null {
    const round = this.match?.round ?? null;
    if (round === null) return null;
    return {
      seat,
      hand: round.hands[seat] ?? [],
      board: round.board,
      openerTile: round.openerTile,
      ends: openEnds(round.board),
      tilesLeft: SEATS.map((s) => (round.hands[s] ?? []).length),
      voids: this.voids.map((v) => [...v]),
      caught: [...this.caught],
      rules: this.rules,
    };
  }

  /**
   * Let the computer players take their turns. Runs on a timer so the table
   * reads like a game rather than a transcript, and re-arms itself so a run
   * of bot turns plays out one after another.
   */
  private scheduleBot(): void {
    if (this.botTimer !== null) clearTimeout(this.botTimer);
    this.botTimer = null;
    const match = this.match;
    if (match === null) return;

    if (match.phase === 'playing' && match.round !== null) {
      if (this.botAt(match.round.turn) === null) return;
      this.botTimer = setTimeout(() => {
        this.botTimer = null;
        this.playBotTurn();
      }, this.thinkMs);
      return;
    }

    // A table of nothing but computer players has nobody to click "deal", so
    // it deals itself. With a human seated the round waits for them.
    if (match.phase === 'roundOver' && SEATS.every((s) => this.botAt(s) !== null)) {
      this.botTimer = setTimeout(() => {
        this.botTimer = null;
        const bot = this.playerAtSeat(0);
        if (bot === null) return;
        try {
          this.nextRound(bot);
        } catch {
          return;
        }
        this.broadcastState();
      }, this.thinkMs * 2);
    }
  }

  private playBotTurn(): void {
    const match = this.match;
    if (match === null || match.phase !== 'playing' || match.round === null) return;
    const seat = match.round.turn;
    const bot = this.botAt(seat);
    if (bot === null) return;

    const ctx = this.contextFor(seat);
    if (ctx === null) return;

    const accuse = shouldCallOut(ctx);
    if (accuse !== null) {
      try {
        this.callOut(bot, accuse);
      } catch {
        return;
      }
      this.broadcastState();
      return;
    }
    // legalMoves reads only this seat's own hand, so its result carries
    // nothing the bot is not already entitled to.
    const choice = chooseMove(legalMoves(match.round, seat), ctx, 1.5);
    try {
      this.noteMove(seat, choice);
      const outcome = applyMove(match, seat, choice);
      this.match = outcome.match;
      if (outcome.result !== null) this.smashedThisRound = false;
      this.pushLog(this.describeMove(bot, choice));
      if (outcome.result !== null) this.pushLog(this.describeRoundResult(outcome.result));
      this.maybeRecord();
    } catch {
      // A rules error here is a bug, not bad input. Stop rather than spin.
      return;
    }
    this.armTimer();
    this.scheduleBot();
    this.broadcastState();
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
      this.noteMove(seat, choice);
      const outcome = applyMove(match, seat, choice);
      this.match = outcome.match;
      this.pushLog(
        choice.kind === 'pass'
          ? `${this.seatLabel(seat)} ran out of time and passed.`
          : `${this.seatLabel(seat)} ran out of time — played ${choice.tile} automatically.`,
      );
      if (outcome.result !== null) this.pushLog(this.describeRoundResult(outcome.result));
      this.maybeRecord();
    } catch {
      // A rules error here would mean a bug rather than bad input; stop the
      // clock instead of looping on it.
      this.turnDeadline = null;
      return;
    }
    this.armTimer();
    this.scheduleBot();
    this.broadcastState();
  }

  /**
   * Persist a finished match, once. Fire-and-forget: the write must never
   * delay the table, and a failure is logged inside the Supabase client
   * rather than surfaced to players.
   */
  /**
   * Credit the leaderboard. Everyone signed in gets a match played; everyone
   * on the winning team also gets a win, so a pair who win together both go
   * up by one and keep their own totals across whoever they partner next.
   */
  private creditLeaderboard(match: MatchState): void {
    if (this.onFinished === null) return;
    const played: string[] = [];
    const winners: string[] = [];
    for (const seat of SEATS) {
      const p = this.playerAtSeat(seat);
      if (p === null || p.accountName === null) continue;
      played.push(p.accountName);
      // A drawn match counts as played by everyone and won by nobody.
      if (match.winner !== null && teamOf(seat) === match.winner) winners.push(p.accountName);
    }
    if (played.length > 0) this.onFinished(winners, played);
  }

  private maybeRecord(): void {
    const match = this.match;
    if (this.recorded || match === null || match.phase !== 'matchOver') return;
    this.recorded = true;

    // A table with a computer player at it is practice, not a real match.
    // Counting it would quietly inflate everybody's record.
    if (SEATS.some((s) => this.botAt(s) !== null)) return;

    this.creditLeaderboard(match);

    if (this.supabase === null || !this.supabase.enabled) return;

    const remaining = match.lastResult?.remaining ?? [0, 0, 0, 0];
    const players: MatchPlayerRecord[] = SEATS.flatMap((seat) => {
      const p = this.playerAtSeat(seat);
      if (p === null) return [];
      return [
        {
          seat,
          player_id: p.user?.id ?? null,
          display_name: p.name,
          team: teamOf(seat),
          won: match.winner === teamOf(seat),
          pips_left: remaining[seat] ?? 0,
        },
      ];
    });

    const record: MatchRecord = {
      room_code: this.code,
      rules: this.rules,
      target_score: this.rules.targetScore,
      winning_team: match.winner,
      score_a: match.scores[0],
      score_b: match.scores[1],
      rounds_played: match.roundNumber,
      started_at: (this.startedAt ?? new Date()).toISOString(),
      players,
    };

    void this.supabase.recordMatch(record);
  }

  private armTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.match === null || this.match.phase !== 'playing') {
      this.turnDeadline = null;
      return;
    }
    const limit = this.rules.turnSeconds;
    if (limit === null) {
      // No clock: the table waits. Nobody gets played for.
      this.turnDeadline = null;
      return;
    }
    this.turnDeadline = Date.now() + limit * 1000;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.autoPlay();
    }, limit * 1000);
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.botTimer !== null) clearTimeout(this.botTimer);
    this.botTimer = null;
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
        // A bot is never "disconnected": it has no socket by design.
        connected: p.isBot || p.socket !== null,
        tiles: round === null ? 0 : (round.hands[s] ?? []).length,
        bot: p.isBot,
      };
    });

    const hand = seat !== null && round !== null ? (round.hands[seat] ?? []) : [];
    const canAct =
      seat !== null && round !== null && match?.phase === 'playing' && round.turn === seat;

    let spectators = 0;
    for (const p of this.players.values()) if (p.seat === null && !p.isBot) spectators++;

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
      openerTile: round?.openerTile ?? null,
      ends: round === null ? null : openEnds(round.board),
      turn: match?.phase === 'playing' ? (round?.turn ?? null) : null,
      passedSeats: round === null ? [] : seatsThatPassed(round),
      scores: match?.scores ?? [0, 0],
      roundNumber: match?.roundNumber ?? 0,
      youMayMove: canAct,
      lastResult: match?.lastResult ?? null,
      winner: match?.winner ?? null,
      drawn: match?.drawn ?? false,
      smashReady: this.maySmash(seat),
      log: this.log,
      turnDeadline: match?.phase === 'playing' ? this.turnDeadline : null,
      spectators,
      authed: player.user !== null,
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

  constructor(
    private send: Broadcast,
    private supabase: Supabase | null = null,
    private onFinished: OnFinished | null = null,
  ) {
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
    const room = new Room(
      this.freshCode(),
      rules,
      this.send,
      this.supabase,
      BOT_THINK_MS,
      this.onFinished,
    );
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
