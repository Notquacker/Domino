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

/**
 * An open end you can aim at. It shows the pip value — public information —
 * but never whether your selected tile would actually fit.
 */
function endSlot(v: PlayerView, end: End): HTMLElement {
  const pip = end === 'left' ? v.ends?.left : v.ends?.right;
  const armed = selected !== null;
  const slot = el('button', `endslot${armed ? ' armed' : ''}`, String(pip ?? '')) as HTMLButtonElement;
  slot.setAttribute('aria-label', `Play your tile on the ${end} end, showing ${pip}`);
  slot.disabled = !armed;
  slot.addEventListener('click', () => {
    if (selected !== null) play(selected, end);
  });
  return slot;
}

/** Base tile dimensions in CSS pixels, matching the stylesheet. */
const TILE_SHORT = 40;
const TILE_LONG = 78;
const TILE_GAP = 3;

export type Layout = 'snake' | 'square';

/**
 * Shrink the tiles as the chain grows so the whole board keeps fitting on
 * screen. Twenty-eight full-size tiles would be several screens wide.
 */
function chainScale(count: number): number {
  if (count <= 8) return 1;
  if (count <= 14) return 0.84;
  if (count <= 20) return 0.7;
  return 0.58;
}

/** Roughly how much height the board area has, for the square layout. */
function boardHeight(): number {
  return Math.max(170, Math.min(520, window.innerHeight - 350));
}

type Placed = PlayerView['board'][number];

/**
 * Fold the chain into rows that fit the screen, each running the opposite way
 * to the one above — the way a real chain snakes back across a table.
 */
function foldChain(board: readonly Placed[], scale: number, available: number): Placed[][] {
  const short = TILE_SHORT * scale + TILE_GAP;
  const long = TILE_LONG * scale + TILE_GAP;
  const rows: Placed[][] = [[]];
  let used = 0;
  for (const placed of board) {
    const width = placed.left === placed.right ? short : long;
    const row = rows[rows.length - 1] as Placed[];
    if (used + width > available && row.length > 0) {
      rows.push([]);
      used = 0;
    }
    (rows[rows.length - 1] as Placed[]).push(placed);
    used += width;
  }
  return rows;
}

interface Spot {
  readonly tile: Placed;
  readonly x: number;
  readonly y: number;
  readonly vertical: boolean;
  readonly flipped: boolean;
}

/**
 * Walk the chain around a rectangle: right along the top, down the side, back
 * along the bottom, up the other side, turning inward if it runs the whole way
 * round. The same path a long chain takes on a real table.
 */
function squareChain(
  board: readonly Placed[],
  scale: number,
  width: number,
  height: number,
): { spots: Spot[]; width: number; height: number } {
  const short = TILE_SHORT * scale;
  const long = TILE_LONG * scale;
  const step = TILE_GAP;

  const spots: Spot[] = [];
  // 0 right, 1 down, 2 left, 3 up.
  let dir = 0;
  let x = 0;
  let y = 0;
  let bound = { left: 0, top: 0, right: width, bottom: height };
  let maxX = 0;
  let maxY = 0;

  for (const placed of board) {
    const isDouble = placed.left === placed.right;
    const vertical = dir === 1 || dir === 3;
    const along = isDouble ? short : long;
    const across = isDouble ? long : short;
    const w = vertical ? across : along;
    const h = vertical ? along : across;

    // Turn a corner when this tile would leave the box.
    for (let turns = 0; turns < 4; turns++) {
      const fitsHere =
        dir === 0
          ? x + w <= bound.right
          : dir === 1
            ? y + h <= bound.bottom
            : dir === 2
              ? x >= bound.left
              : y >= bound.top;
      if (fitsHere) break;
      dir = (dir + 1) % 4;
      if (dir === 0) {
        // A full lap: step inward so the chain spirals rather than overlapping.
        bound = {
          left: bound.left + long * 0.9,
          top: bound.top + long * 0.9,
          right: bound.right - long * 0.9,
          bottom: bound.bottom - long * 0.9,
        };
        x = bound.left;
        y = bound.top;
      }
    }

    const vNow = dir === 1 || dir === 3;
    const aw = vNow ? (isDouble ? long : short) : isDouble ? short : long;
    const ah = vNow ? (isDouble ? short : long) : isDouble ? long : short;
    if (dir === 2) x -= aw;
    if (dir === 3) y -= ah;

    // Running down the right side or back along the bottom, the cursor sits
    // wherever the previous leg left it, which can hang outside the box. Keep
    // every tile inside its bounds; a slight overlap at a corner is far better
    // than a tile sliced off at the edge of the screen.
    const px = Math.min(Math.max(x, bound.left), Math.max(bound.left, bound.right - aw));
    const py = Math.min(Math.max(y, bound.top), Math.max(bound.top, bound.bottom - ah));
    x = px;
    y = py;

    spots.push({ tile: placed, x, y, vertical: vNow, flipped: dir === 2 || dir === 3 });
    maxX = Math.max(maxX, x + aw);
    maxY = Math.max(maxY, y + ah);

    if (dir === 0) x += aw + step;
    else if (dir === 1) y += ah + step;
    else if (dir === 2) x -= step;
    else y -= step;
  }

  return { spots, width: maxX, height: maxY };
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
        playing ? 'Your lead — tap a tile to lay it down.' : 'Waiting for the opening tile…',
      ),
    );
    box.appendChild(chain);
    lastBoard = [];
    return box;
  }

  const scale = chainScale(v.board.length);
  chain.style.setProperty('--tile-scale', String(scale));

  const gutter = 32;
  // In the square layout the end slots sit on their own row beneath the ring,
  // so they do not eat into the width the chain can use.
  const slots = playing && layout === 'snake' ? 2 * (34 * scale + TILE_GAP) : 0;
  const available = Math.max(140, Math.min(window.innerWidth, 920) - gutter - slots);

  const ids = v.board.map((b) => b.id);
  const grewRight = ids.length > lastBoard.length && ids[0] === lastBoard[0];
  const grewLeft = ids.length > lastBoard.length && !grewRight;
  const freshId = grewRight ? ids[ids.length - 1] : grewLeft ? ids[0] : null;

  if (layout === 'square') {
    // Keep it roughly square rather than a tall thin loop.
    const side = Math.min(available, boardHeight());
    const plan = squareChain(v.board, scale, available, side);
    const pitch = el('div', 'pitch');
    pitch.style.width = `${Math.max(plan.width, 1)}px`;
    pitch.style.height = `${Math.max(plan.height, 1)}px`;
    for (const spot of plan.spots) {
      const node = boardTile(spot.tile, spot.tile.id === freshId, spot.flipped, spot.vertical);
      node.style.left = `${spot.x}px`;
      node.style.top = `${spot.y}px`;
      if (messy) applyMess(node, spot.tile.id);
      pitch.appendChild(node);
    }
    chain.appendChild(pitch);
    if (playing) {
      const ends = el('div', 'endrow');
      ends.appendChild(endSlot(v, 'left'));
      ends.appendChild(el('span', 'endlabel', 'open ends'));
      ends.appendChild(endSlot(v, 'right'));
      chain.appendChild(ends);
    }
    box.appendChild(chain);
    lastBoard = ids;
    return box;
  }

  const rows = foldChain(v.board, scale, available);
  rows.forEach((tiles, index) => {
    const reversed = index % 2 === 1;
    const row = el('div', `chainrow${reversed ? ' reverse' : ''}`);
    if (index === 0 && playing) row.appendChild(endSlot(v, 'left'));
    for (const placed of tiles) {
      const node = boardTile(placed, placed.id === freshId, reversed);
      if (messy) applyMess(node, placed.id);
      row.appendChild(node);
    }
    if (index === rows.length - 1 && playing) row.appendChild(endSlot(v, 'right'));
    chain.appendChild(row);
  });

  box.appendChild(chain);
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
        // Opening lead: there is only one place a tile can go, so one tap
        // puts it down. Nothing is revealed — the server still decides.
        if (v.board.length === 0) {
          play(id, 'right');
          return;
        }
        selected = selected === id ? null : id;
        render();
      };
      node.addEventListener('click', activate);
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
      bar.appendChild(el('span', 'hint', 'Tap the end of the chain you want.'));
      const cancel = el('button', 'ghost small', 'Cancel') as HTMLButtonElement;
      cancel.addEventListener('click', () => {
        selected = null;
        render();
      });
      bar.appendChild(cancel);
    } else {
      bar.appendChild(
        el('span', 'hint', v.board.length === 0 ? 'Tap a tile to lead.' : 'Pick a tile, then an end.'),
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
