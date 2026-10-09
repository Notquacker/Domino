/**
 * Domino client.
 *
 * Holds no game rules of its own: it renders whatever `PlayerView` the server
 * sends and offers only the moves the server listed as legal. Every action is
 * re-validated server-side, so a tampered client can cheat nobody.
 */

import type { End, HouseRules, PlayerView, Seat, ServerMessage, TileId } from '@domino/shared';
import { TEAM_NAMES, teamOf } from '@domino/shared';
import { Net } from './net.js';
import {
  type Account,
  type Stats,
  accountsEnabled,
  accessToken,
  claimAccount,
  currentAccount,
  ensureSession,
  fetchStats,
} from './auth.js';
import { boardTile, el, handTile, tileBacks } from './tiles.js';

const root = document.getElementById('app') as HTMLElement;

/** How long to wait on Supabase before falling back to guest play. */
const AUTH_TIMEOUT_MS = 4000;

const STORE = {
  name: 'domino.name',
  token: 'domino.token',
  code: 'domino.code',
} as const;

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — the session simply will not survive a reload */
  }
}
function recall(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function forget(): void {
  for (const key of Object.values(STORE)) {
    if (key === STORE.name) continue;
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

type Intent = { kind: 'idle' } | { kind: 'create'; rules: Partial<HouseRules> } | { kind: 'join'; code: string };

let view: PlayerView | null = null;
let selected: TileId | null = null;
let error = '';
let online = false;
let intent: Intent = { kind: 'idle' };
let chats: { from: string; text: string }[] = [];
let name = recall(STORE.name);
let formCode = new URL(location.href).searchParams.get('code')?.toUpperCase() ?? '';
let lastBoard: readonly string[] = [];
let tableScroll = 0;
let account: Account | null = null;
let stats: Stats | null = null;
/** 'unavailable' means Supabase is configured but we could not reach it. */
let accountState: 'pending' | 'ready' | 'unavailable' = 'pending';
/** Reset on every connect: the token must be presented once per socket. */
let authSent = false;
let claimNotice = '';

let lastPhase: string | null = null;

const net = new Net(onMessage, onStatus, onReady);

function onStatus(up: boolean): void {
  online = up;
  render();
}

/**
 * Present the Supabase token, once per connection and before anything else, so
 * the room the server builds for us is attached to the right account. A guest
 * has no token and simply skips this.
 */
/** Give up on a promise after `ms` and carry on without it. */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => window.setTimeout(() => resolve(fallback), ms)),
  ]);
}

async function ensureAuthSent(): Promise<void> {
  if (!accountsEnabled || authSent) return;
  // Signing in must never hold up a game. If Supabase is slow or unreachable,
  // we play on as a guest rather than leaving the player staring at a button.
  await withTimeout(ensureSession(name), AUTH_TIMEOUT_MS, undefined);
  const jwt = await withTimeout(accessToken(), AUTH_TIMEOUT_MS, null);
  if (jwt !== null && !authSent) {
    net.send({ t: 'auth', jwt });
    authSent = true;
  }
}

/** Runs on every (re)connect: resume a seat if we hold a token, else idle. */
function onReady(): void {
  authSent = false;
  void (async () => {
    await ensureAuthSent();
    const token = recall(STORE.token);
    const code = recall(STORE.code);
    if (token && code) {
      net.send({ t: 'resume', code, token });
    } else if (intent.kind === 'create') {
      net.send({ t: 'create', name, rules: intent.rules });
    } else if (intent.kind === 'join') {
      net.send({ t: 'join', code: intent.code, name });
    }
  })();
}

/** Pull the latest account and record, then repaint. */
async function refreshAccount(): Promise<void> {
  if (!accountsEnabled) return;
  account = await withTimeout(currentAccount(), AUTH_TIMEOUT_MS, null);
  accountState = account === null ? 'unavailable' : 'ready';
  stats = account === null ? null : await withTimeout(fetchStats(), AUTH_TIMEOUT_MS, null);
  render();
}

function onMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'welcome':
      remember(STORE.token, msg.token);
      remember(STORE.code, msg.code);
      intent = { kind: 'idle' };
      error = '';
      view = msg.view;
      break;
    case 'state':
      view = msg.view;
      break;
    case 'chat':
      chats.push({ from: msg.from, text: msg.text });
      if (chats.length > 40) chats = chats.slice(-40);
      break;
    case 'error':
      error = msg.message;
      // A dead token would otherwise loop on every reconnect.
      if (/no longer available|no table/i.test(msg.message)) {
        forget();
        view = null;
        intent = { kind: 'idle' };
      }
      break;
    case 'authed':
      if (msg.ok) void refreshAccount();
      break;
    case 'pong':
      return;
  }
  // A finished match has just been written server-side, so the record moved.
  if (msg.t === 'state' && msg.view.phase === 'matchOver' && lastPhase !== 'matchOver') {
    void refreshAccount();
  }
  lastPhase = view?.phase ?? null;
  render();
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

function endsFor(tile: TileId): End[] {
  const out: End[] = [];
  for (const move of view?.legal ?? []) {
    if (move.kind === 'play' && move.tile === tile) out.push(move.end);
  }
  return out;
}

function playableTiles(): Set<TileId> {
  const set = new Set<TileId>();
  for (const move of view?.legal ?? []) if (move.kind === 'play') set.add(move.tile);
  return set;
}

function canPass(): boolean {
  return (view?.legal ?? []).some((m) => m.kind === 'pass');
}

function myTurn(): boolean {
  return view !== null && view.you !== null && view.turn === view.you;
}

function teamClass(seat: Seat): string {
  return teamOf(seat) === 0 ? 'teamA' : 'teamB';
}

function play(tile: TileId, end: End): void {
  selected = null;
  net.send({ t: 'move', move: { kind: 'play', tile, end } });
}

// ---------------------------------------------------------------------------
// Landing screen
// ---------------------------------------------------------------------------

/**
 * The account panel. Absent entirely when the server has no Supabase project
 * configured, so a guest-only deployment shows no dead UI.
 */
function renderAccountCard(): HTMLElement | null {
  if (!accountsEnabled) return null;

  const card = el('div', 'card');
  card.appendChild(el('h2', undefined, 'Your record'));

  if (account === null) {
    card.appendChild(
      el(
        'p',
        'hint',
        accountState === 'unavailable'
          ? 'Could not reach the account service — you can still play, but this match will not be saved.'
          : 'Setting up your player…',
      ),
    );
    return card;
  }

  if (stats === null || stats.played === 0) {
    card.appendChild(el('p', 'hint', 'No finished matches yet — play one and it lands here.'));
  } else {
    const row = el('div', 'statrow');
    const add = (value: string, label: string): void => {
      const cell = el('div', 'stat');
      cell.appendChild(el('b', undefined, value));
      cell.appendChild(el('span', undefined, label));
      row.appendChild(cell);
    };
    add(String(stats.played), stats.played === 1 ? 'match' : 'matches');
    add(String(stats.won), 'won');
    add(`${Math.round(stats.winPercent)}%`, 'win rate');
    card.appendChild(row);
  }

  if (claimNotice) card.appendChild(el('p', 'hint', claimNotice));

  if (account.anonymous) {
    card.appendChild(
      el('p', 'hint', 'You are playing as a guest. Add an email to keep this record.'),
    );
    const row = el('div', 'row');
    const email = el('input') as HTMLInputElement;
    email.type = 'email';
    email.placeholder = 'you@example.com';
    const save = el('button', 'small', 'Save') as HTMLButtonElement;
    const claim = (): void => {
      const value = email.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(value)) {
        claimNotice = 'That does not look like an email address.';
        render();
        return;
      }
      save.disabled = true;
      void claimAccount(value).then((result) => {
        claimNotice = result.message;
        void refreshAccount();
      });
    };
    save.addEventListener('click', claim);
    email.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') claim();
    });
    row.appendChild(email);
    row.appendChild(save);
    card.appendChild(row);
  } else {
    card.appendChild(el('p', 'hint', `Signed in as ${account.email ?? 'your account'}.`));
  }

  return card;
}

function renderLanding(): HTMLElement {
  const wrap = el('div', 'center');

  const brand = el('div', 'brand');
  brand.appendChild(el('h1', undefined, 'Domino'));
  brand.appendChild(el('p', undefined, 'Curaçao style · two against two'));
  wrap.appendChild(brand);

  if (error) wrap.appendChild(el('div', 'err', error));

  const nameCard = el('div', 'card');
  nameCard.appendChild(el('h2', undefined, 'Your name'));
  const nameInput = el('input') as HTMLInputElement;
  nameInput.placeholder = 'e.g. Shon Pedro';
  nameInput.maxLength = 20;
  nameInput.value = name;
  nameInput.addEventListener('input', () => {
    name = nameInput.value;
    remember(STORE.name, name);
  });
  nameCard.appendChild(nameInput);
  wrap.appendChild(nameCard);

  // --- create -------------------------------------------------------------
  const createCard = el('div', 'card');
  createCard.appendChild(el('h2', undefined, 'Open a table'));

  const details = el('details');
  const summary = el('summary', undefined, 'Table rules');
  summary.style.cssText = 'cursor:pointer;color:var(--muted);font-size:13px;margin-bottom:8px';
  details.appendChild(summary);

  const rulesBox = el('div', 'rules');

  const targetLabel = el('label');
  targetLabel.appendChild(el('span', 'grow', 'Play to'));
  const target = document.createElement('select');
  for (const value of [100, 150, 200]) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value} points`;
    if (value === 150) option.selected = true;
    target.appendChild(option);
  }
  targetLabel.appendChild(target);
  rulesBox.appendChild(targetLabel);

  const capicu = el('label');
  const capicuBox = el('input') as HTMLInputElement;
  capicuBox.type = 'checkbox';
  capicuBox.style.width = 'auto';
  capicu.appendChild(capicuBox);
  capicu.appendChild(el('span', undefined, 'Capicú bonus (+25)'));
  rulesBox.appendChild(capicu);

  const countAll = el('label');
  const countAllBox = el('input') as HTMLInputElement;
  countAllBox.type = 'checkbox';
  countAllBox.style.width = 'auto';
  countAll.appendChild(countAllBox);
  countAll.appendChild(el('span', undefined, 'Count every unplayed tile'));
  rulesBox.appendChild(countAll);
  rulesBox.appendChild(
    el('p', 'note', 'Off by default: the winning team scores only the opponents’ pips.'),
  );

  details.appendChild(rulesBox);
  createCard.appendChild(details);

  const createBtn = el('button', 'gold', 'Create table') as HTMLButtonElement;
  createBtn.style.width = '100%';
  createBtn.style.marginTop = '12px';
  createBtn.addEventListener('click', () => {
    error = '';
    intent = {
      kind: 'create',
      rules: {
        targetScore: Number(target.value),
        capicuBonus: capicuBox.checked ? 25 : 0,
        countAllRemaining: countAllBox.checked,
      },
    };
    const rules = (intent as { rules: Partial<HouseRules> }).rules;
    void (async () => {
      await ensureAuthSent();
      net.send({ t: 'create', name, rules });
    })();
    render();
  });
  createCard.appendChild(createBtn);
  wrap.appendChild(createCard);

  // --- join ---------------------------------------------------------------
  const joinCard = el('div', 'card');
  joinCard.appendChild(el('h2', undefined, 'Join a table'));
  const joinRow = el('div', 'row');
  const codeInput = el('input', 'code-input') as HTMLInputElement;
  codeInput.placeholder = 'CODE';
  codeInput.maxLength = 4;
  codeInput.value = formCode;
  codeInput.addEventListener('input', () => {
    formCode = codeInput.value.toUpperCase();
    codeInput.value = formCode;
  });
  const joinBtn = el('button', undefined, 'Join') as HTMLButtonElement;
  const doJoin = (): void => {
    if (formCode.trim().length < 4) {
      error = 'A table code is four characters.';
      render();
      return;
    }
    error = '';
    const code = formCode.trim();
    intent = { kind: 'join', code };
    void (async () => {
      await ensureAuthSent();
      net.send({ t: 'join', code, name });
    })();
    render();
  };
  joinBtn.addEventListener('click', doJoin);
  codeInput.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') doJoin();
  });
  joinRow.appendChild(codeInput);
  joinRow.appendChild(joinBtn);
  joinCard.appendChild(joinRow);
  wrap.appendChild(joinCard);

  const accountCard = renderAccountCard();
  if (accountCard !== null) wrap.appendChild(accountCard);

  if (!online) wrap.appendChild(el('p', 'hint', 'Connecting…'));
  return wrap;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function renderLobby(v: PlayerView): HTMLElement {
  const wrap = el('div', 'center');
  const brand = el('div', 'brand');
  brand.appendChild(el('h1', undefined, 'Domino'));
  brand.appendChild(el('p', undefined, `Play to ${v.rules.targetScore} · two against two`));
  wrap.appendChild(brand);

  if (error) wrap.appendChild(el('div', 'err', error));

  const codeCard = el('div', 'card');
  codeCard.appendChild(el('h2', undefined, 'Table code'));
  codeCard.appendChild(el('div', 'roomcode', v.code));
  codeCard.appendChild(el('p', 'hint', 'Share this code — or the link — with three friends.'));
  const share = el('button', 'ghost small', 'Copy invite link') as HTMLButtonElement;
  share.style.cssText = 'width:100%;margin-top:10px';
  share.addEventListener('click', () => {
    const link = `${location.origin}${location.pathname}?code=${v.code}`;
    navigator.clipboard?.writeText(link).then(
      () => {
        share.textContent = 'Link copied';
        window.setTimeout(() => (share.textContent = 'Copy invite link'), 1800);
      },
      () => {
        share.textContent = link;
      },
    );
  });
  codeCard.appendChild(share);
  wrap.appendChild(codeCard);

  const seatCard = el('div', 'card');
  seatCard.appendChild(el('h2', undefined, 'Seats'));
  const list = el('div', 'seatlist');
  for (const seat of [0, 1, 2, 3] as Seat[]) {
    const info = v.seats[seat] ?? null;
    const row = el('div', `seat ${teamClass(seat)}${v.you === seat ? ' you' : ''}`);
    row.appendChild(el('span', 'pill', TEAM_NAMES[teamOf(seat)]));
    if (info === null) {
      row.appendChild(el('span', 'who empty', 'Open seat'));
      const take = el('button', 'ghost small', 'Sit here') as HTMLButtonElement;
      take.addEventListener('click', () => net.send({ t: 'sit', seat }));
      row.appendChild(take);
    } else {
      row.appendChild(el('span', `dot${info.connected ? '' : ' off'}`));
      row.appendChild(
        el('span', 'who', info.name + (v.you === seat ? ' (you)' : '')),
      );
    }
    list.appendChild(row);
  }
  seatCard.appendChild(list);
  seatCard.appendChild(
    el('p', 'hint', 'Partners sit opposite: Team A takes seats 1 and 3, Team B takes 2 and 4.'),
  );
  wrap.appendChild(seatCard);

  const seated = v.seats.filter((s) => s !== null).length;
  const actions = el('div', 'card');
  if (v.isHost) {
    const start = el('button', 'gold', seated === 4 ? 'Start the match' : `Waiting for ${4 - seated} more`) as HTMLButtonElement;
    start.style.width = '100%';
    start.disabled = seated !== 4;
    start.addEventListener('click', () => net.send({ t: 'start' }));
    actions.appendChild(start);
  } else {
    actions.appendChild(
      el('p', 'hint', seated === 4 ? 'Waiting for the host to start…' : `Waiting for ${4 - seated} more player${seated === 3 ? '' : 's'}…`),
    );
  }
  const leave = el('button', 'ghost small', 'Leave table') as HTMLButtonElement;
  leave.style.cssText = 'width:100%;margin-top:10px';
  leave.addEventListener('click', () => {
    forget();
    view = null;
    net.close();
    net.connect();
    render();
  });
  actions.appendChild(leave);
  wrap.appendChild(actions);

  return wrap;
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

function renderTopbar(v: PlayerView): HTMLElement {
  const bar = el('div', 'topbar');
  const score = el('div', 'score');
  const a = el('span', 'tA');
  a.appendChild(el('b', undefined, String(v.scores[0])));
  const b = el('span', 'tB');
  b.appendChild(el('b', undefined, String(v.scores[1])));
  score.appendChild(a);
  score.appendChild(el('span', undefined, '–'));
  score.appendChild(b);
  score.appendChild(el('span', undefined, ` to ${v.rules.targetScore}`));
  bar.appendChild(score);

  const meta = el('div', 'meta');
  meta.appendChild(el('div', 'code', v.code));
  meta.appendChild(el('div', undefined, `Round ${v.roundNumber}${online ? '' : ' · offline'}`));
  bar.appendChild(meta);
  return bar;
}

function renderOpponents(v: PlayerView): HTMLElement {
  const wrap = el('div', 'opponents');
  // Start from the seat after yours so the order matches play order.
  const base = v.you ?? 0;
  for (let i = 1; i <= 3; i++) {
    const seat = ((base + i) % 4) as Seat;
    const info = v.seats[seat] ?? null;
    const card = el('div', `opp ${teamClass(seat)}${v.turn === seat ? ' turn' : ''}`);
    const nameRow = el('div', 'name');
    if (info !== null) nameRow.appendChild(el('span', `dot${info.connected ? '' : ' off'}`));
    nameRow.appendChild(el('span', undefined, info?.name ?? 'Empty'));
    card.appendChild(nameRow);
    const relation = seat === ((base + 2) % 4) ? 'Your partner' : 'Opponent';
    card.appendChild(el('div', 'sub', `${relation} · ${info?.tiles ?? 0} tiles`));
    card.appendChild(tileBacks(info?.tiles ?? 0));
    wrap.appendChild(card);
  }
  return wrap;
}

function endSlot(v: PlayerView, end: End): HTMLElement {
  const pip = end === 'left' ? v.ends?.left : v.ends?.right;
  const live = selected !== null && endsFor(selected).includes(end);
  const slot = el('button', `endslot${live ? ' live' : ''}`, live ? '+' : String(pip ?? ''));
  slot.setAttribute('aria-label', `Play on the ${end} end`);
  slot.addEventListener('click', () => {
    if (selected !== null && endsFor(selected).includes(end)) play(selected, end);
  });
  return slot;
}

function renderTable(v: PlayerView): HTMLElement {
  const table = el('div', 'table');
  const chain = el('div', 'chain');

  if (v.board.length === 0) {
    chain.appendChild(
      el('div', 'empty-table', myTurn() ? 'Your lead — pick a tile.' : 'Waiting for the opening tile…'),
    );
  } else {
    if (myTurn()) chain.appendChild(endSlot(v, 'left'));
    for (const placed of v.board) chain.appendChild(boardTile(placed));
    if (myTurn()) chain.appendChild(endSlot(v, 'right'));
  }

  table.appendChild(chain);

  // Keep the end that just changed in view, and otherwise hold position.
  const ids = v.board.map((b) => b.id);
  const grewRight = ids.length > lastBoard.length && ids[0] === lastBoard[0];
  const grewLeft = ids.length > lastBoard.length && !grewRight;
  requestAnimationFrame(() => {
    if (grewRight) table.scrollLeft = table.scrollWidth;
    else if (grewLeft) table.scrollLeft = 0;
    else table.scrollLeft = tableScroll;
  });
  table.addEventListener('scroll', () => {
    tableScroll = table.scrollLeft;
  });
  lastBoard = ids;
  return table;
}

function renderStatus(v: PlayerView): HTMLElement {
  const status = el('div', 'status');
  if (v.you === null) {
    status.appendChild(el('span', undefined, 'You are watching this table.'));
    return status;
  }
  if (myTurn()) {
    const label = canPass() ? 'Your turn — nothing fits, you must pass.' : 'Your turn.';
    status.appendChild(el('span', 'turnme', label));
  } else {
    const who = v.turn === null ? null : v.seats[v.turn];
    status.appendChild(el('span', undefined, who ? `Waiting for ${who.name}…` : 'Waiting…'));
  }
  if (v.turnDeadline !== null) {
    const clock = el('span', 'clock', '');
    clock.id = 'clock';
    status.appendChild(el('span', undefined, ' '));
    status.appendChild(clock);
  }
  return status;
}

function renderHand(v: PlayerView): HTMLElement {
  const zone = el('div', 'handzone');
  const hand = el('div', 'hand');
  const playable = playableTiles();

  if (v.hand.length === 0) {
    hand.appendChild(el('div', 'empty-table', v.you === null ? 'Spectating.' : 'Your hand is empty.'));
  }

  for (const id of v.hand) {
    const state = selected === id ? 'sel' : playable.has(id) ? 'playable' : 'dead';
    const node = handTile(id, state);
    if (state !== 'dead') {
      const activate = (): void => {
        const ends = endsFor(id);
        if (ends.length === 0) return;
        if (ends.length === 1) play(id, ends[0] as End);
        else {
          selected = selected === id ? null : id;
          render();
        }
      };
      node.addEventListener('click', activate);
      node.addEventListener('keydown', (ev) => {
        const key = (ev as KeyboardEvent).key;
        if (key === 'Enter' || key === ' ') {
          ev.preventDefault();
          activate();
        }
      });
    }
    hand.appendChild(node);
  }
  zone.appendChild(hand);

  const bar = el('div', 'handbar');
  if (myTurn() && canPass()) {
    const pass = el('button', 'gold', 'Pass') as HTMLButtonElement;
    pass.addEventListener('click', () => net.send({ t: 'move', move: { kind: 'pass' } }));
    bar.appendChild(pass);
  }
  if (selected !== null) {
    bar.appendChild(el('span', 'hint', 'Now tap an end of the chain.'));
    const cancel = el('button', 'ghost small', 'Cancel') as HTMLButtonElement;
    cancel.addEventListener('click', () => {
      selected = null;
      render();
    });
    bar.appendChild(cancel);
  }
  if (bar.childNodes.length > 0) zone.appendChild(bar);
  return zone;
}

function renderLog(v: PlayerView): HTMLElement {
  const zone = el('div', 'logzone');
  const details = el('details');
  details.appendChild(el('summary', undefined, 'Game log & table talk'));
  const log = el('div', 'log');
  for (const line of v.log.slice(-30)) log.appendChild(el('div', undefined, line));
  for (const chat of chats.slice(-12)) {
    const row = el('div', 'chat');
    row.appendChild(el('b', undefined, `${chat.from}: `));
    row.appendChild(document.createTextNode(chat.text));
    log.appendChild(row);
  }
  details.appendChild(log);

  const row = el('div', 'chatrow');
  const input = el('input') as HTMLInputElement;
  input.placeholder = 'Say something…';
  input.maxLength = 300;
  const send = el('button', 'small', 'Send') as HTMLButtonElement;
  const fire = (): void => {
    const text = input.value.trim();
    if (text.length === 0) return;
    net.send({ t: 'chat', text });
    input.value = '';
  };
  send.addEventListener('click', fire);
  input.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Enter') fire();
  });
  row.appendChild(input);
  row.appendChild(send);
  details.appendChild(row);

  zone.appendChild(details);
  return zone;
}

function renderOverlay(v: PlayerView): HTMLElement | null {
  if (v.phase !== 'roundOver' && v.phase !== 'matchOver') return null;
  const result = v.lastResult;
  const overlay = el('div', 'overlay');
  const sheet = el('div', 'sheet');

  if (v.phase === 'matchOver' && v.winner !== null) {
    const mine = v.you !== null && teamOf(v.you) === v.winner;
    sheet.appendChild(el('h2', undefined, mine ? 'You win the match!' : 'Match over'));
    sheet.appendChild(el('div', 'big', `${v.scores[0]} – ${v.scores[1]}`));
    sheet.appendChild(el('p', undefined, `${TEAM_NAMES[v.winner]} reached ${v.rules.targetScore}.`));
  } else {
    sheet.appendChild(el('h2', undefined, 'Round over'));
    if (result !== null) {
      sheet.appendChild(el('div', 'big', result.points > 0 ? `+${result.points}` : '0'));
      const who =
        result.kind === 'tie'
          ? 'Blocked and level — nobody scores.'
          : result.kind === 'blocked'
            ? `Blocked. ${TEAM_NAMES[result.winningTeam ?? 0]} had the fewer pips.`
            : `${v.seats[result.dominoedBy ?? 0]?.name ?? 'A player'} went out${result.capicu ? ' with a capicú!' : '.'}`;
      sheet.appendChild(el('p', undefined, who));

      const breakdown = el('div', 'breakdown');
      for (const seat of [0, 1, 2, 3] as Seat[]) {
        const row = el('div');
        row.appendChild(
          el('span', 'k', `${v.seats[seat]?.name ?? `Seat ${seat + 1}`} (${TEAM_NAMES[teamOf(seat)]})`),
        );
        row.appendChild(el('span', undefined, `${result.remaining[seat] ?? 0} pips left`));
        breakdown.appendChild(row);
      }
      sheet.appendChild(breakdown);
    }
    sheet.appendChild(el('p', undefined, `Score: ${v.scores[0]} – ${v.scores[1]}`));
  }

  const actions = el('div', 'actions');
  if (v.phase === 'roundOver' && v.you !== null) {
    const next = el('button', 'gold', 'Deal the next round') as HTMLButtonElement;
    next.addEventListener('click', () => net.send({ t: 'nextRound' }));
    actions.appendChild(next);
  }
  if (v.phase === 'matchOver' && v.isHost) {
    const again = el('button', 'gold', 'Play again') as HTMLButtonElement;
    again.addEventListener('click', () => net.send({ t: 'rematch' }));
    actions.appendChild(again);
  }
  if (v.phase === 'matchOver') {
    const leave = el('button', 'ghost', 'Leave table') as HTMLButtonElement;
    leave.addEventListener('click', () => {
      forget();
      view = null;
      net.close();
      net.connect();
      render();
    });
    actions.appendChild(leave);
  }
  sheet.appendChild(actions);
  overlay.appendChild(sheet);
  return overlay;
}

function renderGame(v: PlayerView): HTMLElement {
  const wrap = el('div', 'game');
  wrap.appendChild(renderTopbar(v));
  wrap.appendChild(renderOpponents(v));
  wrap.appendChild(renderTable(v));
  wrap.appendChild(renderStatus(v));
  if (error) {
    const box = el('div', 'err', error);
    box.style.margin = '0 14px 8px';
    wrap.appendChild(box);
  }
  wrap.appendChild(renderHand(v));
  wrap.appendChild(renderLog(v));
  const overlay = renderOverlay(v);
  if (overlay !== null) wrap.appendChild(overlay);
  return wrap;
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function render(): void {
  const v = view;
  root.replaceChildren(
    v === null ? renderLanding() : v.phase === 'lobby' ? renderLobby(v) : renderGame(v),
  );
  tickClock();
}

/** The turn clock updates on its own so a re-render never drops a selection. */
function tickClock(): void {
  const node = document.getElementById('clock');
  const deadline = view?.turnDeadline ?? null;
  if (node === null || deadline === null) return;
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  node.textContent = `${left}s`;
  node.className = left <= 10 ? 'clock low' : 'clock';
}

window.setInterval(tickClock, 500);
window.addEventListener('online', () => render());

// Clear a stale error after a few seconds so it does not linger forever.
window.setInterval(() => {
  if (error) {
    error = '';
    render();
  }
}, 6000);

render();
net.connect();

if (accountsEnabled) {
  void ensureSession(name).then(refreshAccount);
}
