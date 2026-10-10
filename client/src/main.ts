/**
 * Domino client.
 *
 * Holds no game rules of its own: it renders whatever `PlayerView` the server
 * sends. It is deliberately not told which moves are legal — spotting what you
 * can play is part of the game — so it offers every tile and lets the server
 * accept or refuse. Every action is validated server-side regardless, so a
 * tampered client can cheat nobody.
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
let account: Account | null = null;
let stats: Stats | null = null;
/** 'unavailable' means Supabase is configured but we could not reach it. */
let accountState: 'pending' | 'ready' | 'unavailable' = 'pending';
/** Reset on every connect: the token must be presented once per socket. */
let authSent = false;
let connectAttempts = 0;
/** The move awaiting the server's verdict, so a refusal can point at it. */
let pending: { tile: TileId; end: End } | null = null;
/** Tile to shake because the server just refused it. */
let rejected: TileId | null = null;
/** Tile currently being dragged out of the hand, if any. */
let dragTile: TileId | null = null;
/** Which drop zone the finger is over while dragging. */
let dragOver: End | null = null;
let dragGhost: HTMLElement | null = null;
let muted = recall('domino.muted') === '1';
/** How the chain is drawn. A local taste, not a table rule. */
let layout: Layout = recall('domino.layout') === 'square' ? 'square' : 'snake';
/** True once somebody has slammed this table; cleared on the next deal. */
let messy = false;
let claimNotice = '';

let lastPhase: string | null = null;
/** Who just slammed the table, shown briefly as a banner. */
let smashedBy: string | null = null;

/**
 * Small synthesised blips. No audio files to ship, and nothing plays until
 * the viewer has interacted, which browsers require anyway.
 */
let audio: AudioContext | null = null;
function sfx(kind: 'place' | 'pass' | 'wrong' | 'round' | 'win' | 'smash'): void {
  if (muted) return;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    if (audio.state === 'suspended') void audio.resume();

    const notes: Record<typeof kind, [number, number, OscillatorType]> = {
      place: [220, 0.07, 'triangle'],
      pass: [150, 0.1, 'sine'],
      wrong: [90, 0.18, 'sawtooth'],
      round: [440, 0.16, 'triangle'],
      win: [660, 0.3, 'triangle'],
      smash: [70, 0.45, 'square'],
    };
    const [freq, dur, type] = notes[kind];
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audio.currentTime);
    if (kind === 'win') osc.frequency.exponentialRampToValueAtTime(freq * 2, audio.currentTime + dur);
    // A slam drops in pitch like something heavy landing.
    if (kind === 'smash') {
      osc.frequency.exponentialRampToValueAtTime(28, audio.currentTime + dur);
    }
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(kind === 'smash' ? 0.42 : 0.18, audio.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + dur + 0.02);
  } catch {
    /* audio is a nicety; never let it break a turn */
  }
}

const net = new Net(onMessage, onStatus, onReady);

function onStatus(up: boolean, attempts: number): void {
  online = up;
  connectAttempts = attempts;
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
      // Our move landed, so there is nothing outstanding to blame a refusal on.
      pending = null;
      view = msg.view;
      break;
    case 'chat':
      chats.push({ from: msg.from, text: msg.text });
      if (chats.length > 40) chats = chats.slice(-40);
      break;
    case 'error':
      // Refusing a placement is normal here: you guessed, it did not fit.
      if (pending !== null && /does not match|illegal move|not your turn/i.test(msg.message)) {
        rejected = pending.tile;
        error = 'That tile does not fit there.';
        sfx('wrong');
        window.setTimeout(() => {
          rejected = null;
          render();
        }, 600);
      } else {
        error = msg.message;
      }
      pending = null;
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
    case 'smashed':
      messy = true;
      sfx('smash');
      document.body.classList.add('shaking');
      window.setTimeout(() => document.body.classList.remove('shaking'), 650);
      smashedBy = msg.name;
      window.setTimeout(() => {
        smashedBy = null;
        render();
      }, 2600);
      break;
    case 'pong':
      return;
  }
  if (msg.t === 'state' && msg.view.phase === 'playing' && lastPhase !== 'playing') {
    messy = false;
    clearDrag();
  }
  if (msg.t === 'state' && msg.view.phase !== lastPhase) {
    if (msg.view.phase === 'matchOver') {
      sfx('win');
      void refreshAccount();
    } else if (msg.view.phase === 'roundOver') {
      sfx('round');
    }
  }
  lastPhase = view?.phase ?? null;
  render();
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

function myTurn(): boolean {
  return view?.youMayMove === true;
}

function teamClass(seat: Seat): string {
  return teamOf(seat) === 0 ? 'teamA' : 'teamB';
}

/**
 * Knock a tile askew. Derived from the tile's own id so the mess holds still
 * between renders instead of twitching on every state update.
 */
function applyMess(node: HTMLElement, id: TileId): void {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const angle = ((hash % 29) - 14) * 1.15;
  const dx = (((hash >> 5) % 17) - 8) * 0.9;
  const dy = (((hash >> 9) % 13) - 6) * 0.9;
  node.style.transform = `translate(${dx}px, ${dy}px) rotate(${angle}deg)`;
  node.style.zIndex = String(hash % 7);
}

/**
 * Attempt a placement. The server decides whether it fits — the page is not
 * told in advance, because working that out is part of the game.
 */
function play(tile: TileId, end: End): void {
  pending = { tile, end };
  selected = null;
  sfx('place');
  net.send({ t: 'move', move: { kind: 'play', tile, end } });
}

/** Which drop zone, if any, is under this point. */
function zoneAt(x: number, y: number): End | null {
  for (const node of document.querySelectorAll('.dropzone')) {
    const r = node.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      return (node as HTMLElement).dataset['end'] === 'left' ? 'left' : 'right';
    }
  }
  return null;
}

function clearDrag(): void {
  dragTile = null;
  dragOver = null;
  dragGhost?.remove();
  dragGhost = null;
}

/**
 * Drag a tile out of the hand and drop it on an end.
 *
 * Pointer events cover touch and mouse together. A press that never travels
 * stays a tap, so the pick-a-tile-then-an-end flow still works for anyone who
 * prefers it, and for keyboards.
 */
function beginDrag(id: TileId, ev: PointerEvent, onTap: () => void): void {
  if (!myTurn() || ev.button > 0) return;
  const startX = ev.clientX;
  const startY = ev.clientY;
  let dragging = false;

  const move = (e: PointerEvent): void => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 8) return;
      dragging = true;
      dragTile = id;
      selected = null;
      dragGhost = handTile(id, 'sel');
      dragGhost.classList.add('ghost');
      dragGhost.setAttribute('aria-hidden', 'true');
      document.body.appendChild(dragGhost);
      render();
    }
    if (dragGhost !== null) {
      dragGhost.style.left = `${e.clientX}px`;
      dragGhost.style.top = `${e.clientY}px`;
    }
    const over = zoneAt(e.clientX, e.clientY);
    if (over !== dragOver) {
      dragOver = over;
      render();
    }
  };

  const finish = (e: PointerEvent): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    if (!dragging) {
      onTap();
      return;
    }
    const end = zoneAt(e.clientX, e.clientY);
    clearDrag();
    if (end !== null) play(id, end);
    else render();
  };

  const cancel = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', cancel);
    clearDrag();
    render();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', cancel);
}

function pass(): void {
  selected = null;
  sfx('pass');
  net.send({ t: 'move', move: { kind: 'pass' } });
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

  // How the match is scored. Round-by-round is the house default.
  const modeLabel = el('label');
  modeLabel.appendChild(el('span', 'grow', 'Scoring'));
  const mode = document.createElement('select');
  mode.id = 'scoring';
  for (const [value, text] of [
    ['rounds', 'Rounds won'],
    ['pips', 'Count pips'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    if (value === 'rounds') option.selected = true;
    mode.appendChild(option);
  }
  modeLabel.appendChild(mode);
  rulesBox.appendChild(modeLabel);

  const targetLabel = el('label');
  targetLabel.appendChild(el('span', 'grow', 'Play to'));
  const target = document.createElement('select');
  target.id = 'target';
  const fillTargets = (): void => {
    target.replaceChildren();
    const values = mode.value === 'pips' ? [100, 150, 200] : [7, 10, 12, 15];
    const preferred = mode.value === 'pips' ? 150 : 10;
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = mode.value === 'pips' ? `${value} points` : `${value} rounds`;
      if (value === preferred) option.selected = true;
      target.appendChild(option);
    }
  };
  fillTargets();
  targetLabel.appendChild(target);
  rulesBox.appendChild(targetLabel);

  const drawRow = el('label');
  const drawBox = el('input') as HTMLInputElement;
  drawBox.type = 'checkbox';
  drawBox.id = 'drawline';
  drawBox.checked = true;
  drawBox.style.width = 'auto';
  drawRow.appendChild(drawBox);
  drawRow.appendChild(el('span', 'grow', 'Draw once both teams reach 5'));
  rulesBox.appendChild(drawRow);
  rulesBox.appendChild(
    el('p', 'note', 'The moment both teams have 5 the match is drawn, 5-5 included. You only win by reaching the target while the other team is still under 5.'),
  );

  const penaltyRow = el('label');
  const penaltyBox = el('input') as HTMLInputElement;
  penaltyBox.type = 'checkbox';
  penaltyBox.id = 'falsepass';
  penaltyBox.checked = true;
  penaltyBox.style.width = 'auto';
  penaltyRow.appendChild(penaltyBox);
  penaltyRow.appendChild(el('span', 'grow', 'Point against a false pass'));
  rulesBox.appendChild(penaltyRow);
  rulesBox.appendChild(
    el('p', 'note', 'Passing is always allowed. Pass holding a tile you could have played and, once hands are shown, the other team scores.'),
  );

  const capicu = el('label');
  const capicuBox = el('input') as HTMLInputElement;
  capicuBox.type = 'checkbox';
  capicuBox.id = 'capicu';
  capicuBox.checked = true;
  capicuBox.style.width = 'auto';
  capicu.appendChild(capicuBox);
  const capicuText = el('span', 'grow', 'Capicú counts double');
  capicu.appendChild(capicuText);
  rulesBox.appendChild(capicu);
  rulesBox.appendChild(
    el('p', 'note', 'Go out on a tile that fits both open ends and the round is worth 2 instead of 1.'),
  );

  const countAll = el('label');
  const countAllBox = el('input') as HTMLInputElement;
  countAllBox.type = 'checkbox';
  countAllBox.id = 'countall';
  countAllBox.style.width = 'auto';
  countAll.appendChild(countAllBox);
  countAll.appendChild(el('span', 'grow', 'Count every unplayed tile'));
  rulesBox.appendChild(countAll);

  const toggleForMode = (): void => {
    const pips = mode.value === 'pips';
    countAll.hidden = !pips;
    drawRow.hidden = pips;
    capicuText.textContent = pips ? 'Capicú bonus (+25 pips)' : 'Capicú counts double';
  };
  toggleForMode();
  mode.addEventListener('change', () => {
    fillTargets();
    toggleForMode();
  });

  details.appendChild(rulesBox);
  createCard.appendChild(details);

  const createBtn = el('button', 'gold', 'Create table') as HTMLButtonElement;
  createBtn.style.width = '100%';
  createBtn.style.marginTop = '12px';
  createBtn.addEventListener('click', () => {
    error = '';
    const pips = mode.value === 'pips';
    intent = {
      kind: 'create',
      rules: {
        scoring: pips ? 'pips' : 'rounds',
        targetScore: Number(target.value),
        winBy: 1,
        drawAt: !pips && drawBox.checked ? 5 : null,
        falsePassPenalty: penaltyBox.checked ? 1 : 0,
        capicuPoints: capicuBox.checked ? (pips ? 25 : 2) : 0,
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

  if (!online) {
    // Free hosting sleeps when idle, so a cold start can take about a minute.
    // Say that rather than leaving someone staring at "Connecting…".
    wrap.appendChild(
      el(
        'p',
        'hint',
        connectAttempts >= 3
          ? 'Waking the server up — on free hosting this can take a minute. It will connect on its own.'
          : 'Connecting…',
      ),
    );
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function renderLobby(v: PlayerView): HTMLElement {
  const wrap = el('div', 'center');
  const brand = el('div', 'brand');
  brand.appendChild(el('h1', undefined, 'Domino'));
  const how =
    v.rules.scoring === 'rounds'
      ? `First to ${v.rules.targetScore}` +
        (v.rules.drawAt !== null ? ` · drawn once both reach ${v.rules.drawAt}` : '')
      : `Play to ${v.rules.targetScore} points`;
  brand.appendChild(el('p', undefined, `${how} · two against two`));
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

  const shape = el('button', 'iconbtn', layout === 'square' ? '⬛' : '〰️') as HTMLButtonElement;
  shape.title = layout === 'square' ? 'Square layout' : 'Snaking layout';
  shape.setAttribute('aria-label', 'Change how the chain is laid out');
  shape.addEventListener('click', () => {
    layout = layout === 'snake' ? 'square' : 'snake';
    remember('domino.layout', layout);
    render();
  });
  bar.appendChild(shape);

  const sound = el('button', 'iconbtn', muted ? '🔇' : '🔊') as HTMLButtonElement;
  sound.title = muted ? 'Sound off' : 'Sound on';
  sound.setAttribute('aria-label', muted ? 'Turn sound on' : 'Turn sound off');
  sound.addEventListener('click', () => {
    muted = !muted;
    remember('domino.muted', muted ? '1' : '0');
    if (!muted) sfx('place');
    render();
  });
  bar.appendChild(sound);

  const meta = el('div', 'meta');
  meta.appendChild(el('div', 'code', v.code));
  meta.appendChild(
    el('div', undefined, `Round ${v.roundNumber}${online ? '' : ' · reconnecting…'}`),
  );
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

/** Base tile dimensions in CSS pixels, matching the stylesheet. */
const TILE_SHORT = 40;
const TILE_LONG = 78;
const TILE_GAP = 3;

export type Layout = 'snake' | 'square';

/** Longest straight run before the chain has to turn a corner. */
const MAX_RUN = 7;

/**
 * Shrink the tiles as the chain grows so the whole board keeps fitting on
 * screen. Twenty-eight full-size tiles would be several screens wide.
 */
function chainScale(count: number): number {
  if (count <= 8) return 1;
  if (count <= 14) return 0.84;
  if (count <= 20) return 0.72;
  return 0.6;
}

type Placed = PlayerView['board'][number];

interface Spot {
  /** Position in the chain, so the tiles can be drawn in order. */
  readonly index: number;
  readonly tile: Placed;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** True when this stretch of the chain runs up or down the screen. */
  readonly vertical: boolean;
  /** True when the chain is travelling left or up, so the halves swap. */
  readonly flipped: boolean;
}

/** 0 right, 1 down, 2 left, 3 up. */
type Dir = 0 | 1 | 2 | 3;

/**
 * Lay the chain out as one continuous line of dominoes.
 *
 * Every tile is positioned from the point where the previous one ended, so
 * neighbours actually touch — the chain reads as a single connected line
 * rather than separate strips. It starts at the tile that opened the round and
 * grows both ways from it, the way a real chain spreads across a table, and
 * turns a corner once a straight run reaches MAX_RUN.
 */
function layoutChain(
  board: readonly Placed[],
  openerId: string | null,
  mode: Layout,
  scale: number,
): { spots: Spot[]; width: number; height: number } {
  const long = TILE_LONG * scale;
  const short = TILE_SHORT * scale;
  const spots: Spot[] = [];
  if (board.length === 0) return { spots, width: 0, height: 0 };

  const openerIndex = Math.max(
    0,
    openerId === null ? 0 : board.findIndex((t) => t.id === openerId),
  );

  /** How long a run may be before turning. Snake rows stack via a single
   * perpendicular corner tile; a square turns after a full run each time. */
  const runLimit = (dir: Dir): number =>
    mode === 'square' ? MAX_RUN : dir === 0 || dir === 2 ? MAX_RUN : 1;

  // The opener's row is shared by both arms, so each gets half of it. Without
  // this the middle row runs to MAX_RUN in each direction — a row of thirteen,
  // and a board so wide it has to be shrunk to stay on screen.
  const halfRun = Math.max(1, Math.floor((MAX_RUN - 1) / 2));

  const size = (tile: Placed, dir: Dir): { along: number; across: number } => {
    const isDouble = tile.left === tile.right;
    return isDouble ? { along: short, across: long } : { along: long, across: short };
  };

  /**
   * Place one tile so its near edge meets `cursor`, and return the far edge.
   *
   * `backward` says which way along the chain we are walking, and it decides
   * which half of the tile has to face the one already down. Walking forward,
   * a tile meets its neighbour by its LEFT half (board[i-1].right ===
   * board[i].left); walking back from the opener it meets by its RIGHT half.
   * Get this wrong and the board draws with mismatched pips touching.
   */
  const put = (
    tile: Placed,
    index: number,
    dir: Dir,
    cx: number,
    cy: number,
    backward = false,
  ): { x: number; y: number } => {
    const { along, across } = size(tile, dir);
    const vertical = dir === 1 || dir === 3;
    const w = vertical ? across : along;
    const h = vertical ? along : across;
    const x = dir === 2 ? cx - along : dir === 0 ? cx : cx - across / 2;
    const y = dir === 3 ? cy - along : dir === 1 ? cy : cy - across / 2;
    // A tile renders its first half at the top or left. Travelling left or up
    // puts the near end on the right or bottom, so the halves swap — and the
    // backward arm meets its neighbour by the other half, inverting it again.
    const nearIsSecondHalf = dir === 2 || dir === 3;
    spots.push({
      index,
      tile,
      x,
      y,
      w,
      h,
      vertical,
      flipped: backward ? !nearIsSecondHalf : nearIsSecondHalf,
    });
    return {
      x: cx + (dir === 0 ? along : dir === 2 ? -along : 0),
      y: cy + (dir === 1 ? along : dir === 3 ? -along : 0),
    };
  };

  // The opener sits at the origin, lying along the chain.
  let cursor = put(board[openerIndex] as Placed, openerIndex, 0, 0, 0);

  /**
   * A double lies across the chain rather than along it, so the chain cannot
   * turn immediately after one — the corner would fold back through a tile
   * that is already crosswise. When a turn falls there the run carries
   * straight on and turns at the next tile instead.
   */
  const isDouble = (tile: Placed | undefined): boolean =>
    tile !== undefined && tile.left === tile.right;

  // Forward arm: the right-hand end of the chain.
  let dir: Dir = 0;
  let run = 1;
  let limit = halfRun + 1;
  for (let i = openerIndex + 1; i < board.length; i++) {
    if (run >= limit && !isDouble(board[i - 1])) {
      dir = ((dir + 1) % 4) as Dir;
      run = 0;
      limit = runLimit(dir);
    }
    cursor = put(board[i] as Placed, i, dir, cursor.x, cursor.y);
    run++;
  }

  // Backward arm: the left-hand end, growing the other way from the opener.
  // It turns the same way round, so the two arms sweep out the loop together
  // and finish apart — the shape of a chain that has wrapped the table.
  let back: Dir = 2;
  let backRun = 1;
  let backLimit = MAX_RUN - halfRun;
  let backCursor = { x: 0, y: 0 };
  for (let i = openerIndex - 1; i >= 0; i--) {
    if (backRun >= backLimit && !isDouble(board[i + 1])) {
      back = ((back + 1) % 4) as Dir;
      backRun = 0;
      backLimit = runLimit(back);
    }
    backCursor = put(board[i] as Placed, i, back, backCursor.x, backCursor.y, true);
    backRun++;
  }

  // Shift everything positive and report the bounding box.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const spot of spots) {
    minX = Math.min(minX, spot.x);
    minY = Math.min(minY, spot.y);
    maxX = Math.max(maxX, spot.x + spot.w);
    maxY = Math.max(maxY, spot.y + spot.h);
  }
  // Draw in chain order, not the order the two arms were walked, so the DOM
  // reads along the chain like the tiles do.
  const shifted = spots
    .map((spot) => ({ ...spot, x: spot.x - minX, y: spot.y - minY }))
    .sort((a, b) => a.index - b.index);
  spots.length = 0;
  spots.push(...shifted);
  return { spots, width: maxX - minX, height: maxY - minY };
}

function renderTable(v: PlayerView): HTMLElement {
  const box = el('div', 'table');
  const chain = el('div', `chain${messy ? ' messy' : ''}`);
  const playing = v.youMayMove;

  if (v.board.length === 0) {
    chain.appendChild(
      el(
        'div',
        'empty-table',
        playing ? 'Your lead — lay a tile down.' : 'Waiting for the opening tile…',
      ),
    );
    box.appendChild(chain);

    // The lead has no ends to choose between, so the whole table is one
    // target. Without this a dragged tile has nowhere to land and the opener
    // is left wondering why nothing happens.
    const leading = dragTile ?? selected;
    if (leading !== null && playing) {
      const tappable = dragTile === null;
      const zone = el(
        tappable ? 'button' : 'div',
        `dropzone lead${dragOver !== null ? ' over' : ''}${tappable ? ' tappable' : ''}`,
      );
      zone.dataset['end'] = 'right';
      zone.appendChild(el('span', 'zonelabel', 'LAY IT DOWN'));
      if (tappable) {
        zone.setAttribute('aria-label', 'Lay the opening tile down');
        zone.addEventListener('click', () => play(leading, 'right'));
      }
      box.appendChild(zone);
    }

    lastBoard = [];
    return box;
  }

  const ids = v.board.map((b) => b.id);
  const grewRight = ids.length > lastBoard.length && ids[0] === lastBoard[0];
  const grewLeft = ids.length > lastBoard.length && !grewRight;
  const freshId = grewRight ? ids[ids.length - 1] : grewLeft ? ids[0] : null;

  // Shrink until the whole chain fits the space available.
  const roomW = Math.max(160, Math.min(window.innerWidth, 920) - 28);
  const roomH = Math.max(150, Math.min(430, window.innerHeight - 380));
  let scale = chainScale(v.board.length);
  let plan = layoutChain(v.board, v.openerTile, layout, scale);
  for (let guard = 0; guard < 8 && (plan.width > roomW || plan.height > roomH); guard++) {
    scale *= Math.min(roomW / plan.width, roomH / plan.height, 0.92);
    plan = layoutChain(v.board, v.openerTile, layout, scale);
  }
  chain.style.setProperty('--tile-scale', String(scale));

  const pitch = el('div', 'pitch');
  pitch.style.width = `${Math.max(plan.width, 1)}px`;
  pitch.style.height = `${Math.max(plan.height, 1)}px`;
  for (const spot of plan.spots) {
    const node = boardTile(spot.tile, spot.tile.id === freshId, spot.flipped, spot.vertical);
    node.style.left = `${spot.x}px`;
    node.style.top = `${spot.y}px`;
    node.style.width = `${spot.w}px`;
    node.style.height = `${spot.h}px`;
    if (spot.tile.id === v.openerTile) node.classList.add('opener');
    if (messy) applyMess(node, spot.tile.id);
    pitch.appendChild(node);
  }
  chain.appendChild(pitch);

  box.appendChild(chain);

  // Once a tile is in hand — dragged or tapped — the table becomes two
  // targets, each showing the pip you would be playing against. That is the
  // only place the open ends appear; there is no separate readout.
  const aiming = dragTile ?? selected;

  if (aiming !== null && v.ends !== null) {
    for (const end of ['left', 'right'] as End[]) {
      const pip = end === 'left' ? v.ends.left : v.ends.right;
      const tappable = dragTile === null;
      const zone = el(
        tappable ? 'button' : 'div',
        `dropzone ${end}${dragOver === end ? ' over' : ''}${tappable ? ' tappable' : ''}`,
      );
      zone.dataset['end'] = end;
      zone.appendChild(el('span', 'zonelabel', end === 'left' ? 'LEFT' : 'RIGHT'));
      zone.appendChild(el('span', 'zonepip', String(pip)));
      if (tappable) {
        zone.setAttribute('aria-label', `Play on the ${end} end, against a ${pip}`);
        zone.addEventListener('click', () => play(aiming, end));
      }
      box.appendChild(zone);
    }
  }
  lastBoard = ids;
  return box;
}

function renderStatus(v: PlayerView): HTMLElement {
  const status = el('div', 'status');
  if (v.you === null) {
    status.appendChild(el('span', undefined, 'You are watching this table.'));
    return status;
  }
  if (myTurn()) {
    // No hint about whether anything fits — that is the player's problem now.
    status.appendChild(el('span', 'turnme', 'Your turn.'));
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

  if (v.hand.length === 0) {
    hand.appendChild(el('div', 'empty-table', v.you === null ? 'Spectating.' : 'Your hand is empty.'));
  }

  for (const id of v.hand) {
    // Every tile is offered. Whether it fits is for you to work out.
    const state = selected === id ? 'sel' : 'playable';
    const node = handTile(id, state);
    if (rejected === id) node.classList.add('refused');
    if (myTurn()) {
      const activate = (): void => {
        selected = selected === id ? null : id;
        render();
      };
      // A drag plays the tile; a press that never moves is still a tap.
      node.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        beginDrag(id, ev as PointerEvent, activate);
      });
      node.addEventListener('keydown', (ev) => {
        const key = (ev as KeyboardEvent).key;
        if (key === 'Enter' || key === ' ') {
          ev.preventDefault();
          activate();
        }
      });
    } else {
      node.classList.add('waiting');
    }
    hand.appendChild(node);
  }
  zone.appendChild(hand);

  const bar = el('div', 'handbar');
  if (myTurn()) {
    if (selected !== null) {
      bar.appendChild(el('span', 'hint', 'Now tap the end you want.'));
      const cancel = el('button', 'ghost small', 'Cancel') as HTMLButtonElement;
      cancel.addEventListener('click', () => {
        selected = null;
        render();
      });
      bar.appendChild(cancel);
    } else {
      bar.appendChild(
        el(
          'span',
          'hint',
          v.board.length === 0
            ? 'Pick a tile, then lay it down.'
            : 'Drag a tile to an end — or tap it, then tap an end.',
        ),
      );
    }
    // Passing is always allowed — and always a risk, since passing on a tile
    // you could have played costs your team a point once hands are shown.
    const passBtn = el('button', 'ghost small', 'Pass') as HTMLButtonElement;
    passBtn.addEventListener('click', pass);
    bar.appendChild(passBtn);
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

  if (v.phase === 'matchOver' && v.drawn) {
    sheet.appendChild(el('h2', undefined, 'Match drawn'));
    sheet.appendChild(el('div', 'big num', `${v.scores[0]} – ${v.scores[1]}`));
    sheet.appendChild(
      el(
        'p',
        undefined,
        `Both teams reached ${v.rules.drawAt ?? 5}, so the match is level. Nobody takes it.`,
      ),
    );
  } else if (v.phase === 'matchOver' && v.winner !== null) {
    const mine = v.you !== null && teamOf(v.you) === v.winner;
    sheet.appendChild(el('h2', undefined, mine ? 'You win the match!' : 'Match over'));
    sheet.appendChild(el('div', 'big num', `${v.scores[0]} – ${v.scores[1]}`));
    sheet.appendChild(el('p', undefined, `${TEAM_NAMES[v.winner]} takes it.`));
  } else {
    sheet.appendChild(el('h2', undefined, 'Round over'));
    if (result !== null) {
      const mineTeam = v.you === null ? null : teamOf(v.you);
      const gained = mineTeam === null ? 0 : result.awarded[mineTeam];
      sheet.appendChild(el('div', 'big num', gained > 0 ? `+${gained}` : '0'));

      const who =
        result.kind === 'tie'
          ? 'Blocked and level — no point for the round.'
          : result.kind === 'blocked'
            ? `Blocked. ${TEAM_NAMES[result.winningTeam ?? 0]} had fewer pips and takes the round.`
            : `${v.seats[result.dominoedBy ?? 0]?.name ?? 'A player'} went out${result.capicu ? ' with a capicú!' : '.'}`;
      sheet.appendChild(el('p', undefined, who));

      // Name anyone caught passing on a tile they could have played.
      if (result.falsePasses.length > 0) {
        const box = el('div', 'penaltybox');
        box.appendChild(el('h3', undefined, 'Caught passing'));
        for (const fp of result.falsePasses) {
          const row = el('div');
          const name = v.seats[fp.seat]?.name ?? `Seat ${fp.seat + 1}`;
          row.appendChild(el('span', undefined, `${name} had a tile that fitted`));
          row.appendChild(el('span', 'cost', `+1 ${TEAM_NAMES[(1 - teamOf(fp.seat)) as 0 | 1]}`));
          box.appendChild(row);
        }
        sheet.appendChild(box);
      }

      const breakdown = el('div', 'breakdown');
      for (const seat of [0, 1, 2, 3] as Seat[]) {
        const row = el('div');
        row.appendChild(
          el('span', 'k', `${v.seats[seat]?.name ?? `Seat ${seat + 1}`} (${TEAM_NAMES[teamOf(seat)]})`),
        );
        row.appendChild(el('span', 'num', `${result.remaining[seat] ?? 0} pips left`));
        breakdown.appendChild(row);
      }
      sheet.appendChild(breakdown);
    }
    const line =
      v.rules.drawAt !== null ? `, drawn once both reach ${v.rules.drawAt}` : '';
    sheet.appendChild(
      el(
        'p',
        undefined,
        `Match: ${v.scores[0]} – ${v.scores[1]} (first to ${v.rules.targetScore}${line})`,
      ),
    );
  }

  const actions = el('div', 'actions');
  if (v.smashReady) {
    const smash = el('button', 'smashbtn', '💥  SMASH THE TABLE') as HTMLButtonElement;
    smash.addEventListener('click', () => {
      smash.disabled = true;
      net.send({ t: 'smash' });
    });
    actions.appendChild(smash);
    actions.appendChild(
      el('span', 'hint', 'You took it with a capicú. Slam the tiles and make a mess of them.'),
    );
  }
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
  if (smashedBy !== null) {
    wrap.appendChild(el('div', 'smashbanner', `💥  ${smashedBy} slammed the table!`));
  }
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
  // While the table is being slammed, get the result sheet out of the way so
  // everyone can actually watch the tiles scatter.
  const overlay = smashedBy === null ? renderOverlay(v) : null;
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

let resizeTimer: number | null = null;
window.addEventListener('resize', () => {
  if (resizeTimer !== null) window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeTimer = null;
    render();
  }, 150);
});

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
