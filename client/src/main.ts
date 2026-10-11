/**
 * Domino client.
 *
 * Holds no game rules of its own: it renders whatever `PlayerView` the server
 * sends. It is deliberately not told which moves are legal — spotting what you
 * can play is part of the game — so it offers every tile and lets the server
 * accept or refuse. Every action is validated server-side regardless, so a
 * tampered client can cheat nobody.
 */

import type {
  AccountInfo,
  Dir,
  End,
  HouseRules,
  LeaderRow,
  PlayerView,
  Seat,
  ServerMessage,
  TileId,
} from '@domino/shared';
import {
  TEAM_NAMES,
  // The geometry lives in the engine now, so the server and every client
  // agree on where a tile lands. `layout` is imported under another name
  // because this file already has a `layout` of its own.
  layout as layoutBoard,
  laidTiles,
  openerIndexOf,
  slotsFor,
  teamOf,
} from '@domino/shared';
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
/** True while the accuse panel is open, so a stray tap cannot cost a round. */
let accusing = false;

// --- leaderboard accounts (username + password, no email) -----------------
let myAccount: AccountInfo | null = null;
/** The session token, kept so a reload does not sign you out. */
let accountToken: string = recall('domino.session') ?? '';
let leaders: LeaderRow[] = [];
let adminUsers: AccountInfo[] = [];
let showAdmin = false;
let accountNotice = '';
/**
 * The server answers both "list the players" and "that change is done" with
 * the same frame, so the client remembers whether it actually asked for a
 * change. Without this, simply opening the panel reported "Saved."
 */
let awaitingAdminChange = false;
/** Set while a password change is in flight, so success is reported once the
 *  server has actually accepted it rather than the moment it was asked. */
let awaitingPasswordChange = false;
/** Whether the change-password panel is open. Held here because any redraw
 *  rebuilds the <details> element, which would otherwise snap it shut
 *  mid-edit — including on the redraw that reports a mistyped password. */
let passwordPanelOpen = false;
/** Typed-in values, kept across re-renders so a redraw cannot eat them. */
const signIn = { username: recall('domino.lastuser') ?? '', password: '' };
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
/** The slot the finger is currently nearest, so it can be shown lighting up. */
let dragOver: { end: End; dir: Dir } | null = null;
let dragGhost: HTMLElement | null = null;
let muted = recall('domino.muted') === '1';
/** How the chain is drawn. A local taste, not a table rule. */
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
function sfx(kind: 'place' | 'pass' | 'wrong' | 'round' | 'win' | 'smash' | 'yours'): void {
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
      // Your turn: two quick rising notes, so it is not mistaken for the
      // thud of somebody laying a tile.
      yours: [520, 0.14, 'triangle'],
    };
    const [freq, dur, type] = notes[kind];
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audio.currentTime);
    if (kind === 'win') osc.frequency.exponentialRampToValueAtTime(freq * 2, audio.currentTime + dur);
    if (kind === 'yours') {
      osc.frequency.setValueAtTime(freq * 1.5, audio.currentTime + dur / 2);
    }
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

/**
 * Say something when the turn comes round to you.
 *
 * A phone face-up on the table between hands is not being watched, and the
 * table carries on without you until the clock runs out. A short note and a
 * buzz carry across a room in a way a gold border does not. Both ride the
 * same mute switch, so one tap turns off every interruption.
 */
let wasMyTurn = false;
function noteTurn(): void {
  const now = myTurn();
  if (now && !wasMyTurn) {
    sfx('yours');
    if (!muted) {
      try {
        navigator.vibrate?.([0, 45, 70, 45]);
      } catch {
        /* no vibration here; the sound and the gold edge still carry it */
      }
    }
  }
  wasMyTurn = now;
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
  // Sign back in and refresh the board on every (re)connect, so a dropped
  // connection does not quietly leave you signed out.
  if (accountToken !== '') net.send({ t: 'restore', token: accountToken });
  net.send({ t: 'leaderboard' });
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
      noteTurn();
      break;
    case 'state':
      // Our move landed, so there is nothing outstanding to blame a refusal on.
      pending = null;
      view = msg.view;
      noteTurn();
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
        // A refused command is not a saved one.
        awaitingAdminChange = false;
        awaitingPasswordChange = false;
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
    case 'account': {
      myAccount = msg.account;
      if (msg.token !== undefined) {
        accountToken = msg.token;
        remember('domino.session', accountToken);
      }
      if (msg.account === null) {
        accountToken = '';
        remember('domino.session', '');
        showAdmin = false;
      } else {
        remember('domino.lastuser', msg.account.username);
        signIn.password = '';
        if (awaitingPasswordChange) {
          accountNotice = 'Password changed.';
          awaitingPasswordChange = false;
        }
        // Keep the board honest the moment anything about you changes.
        net.send({ t: 'leaderboard' });
        if (msg.account.isAdmin && showAdmin) net.send({ t: 'adminUsers' });
      }
      render();
      break;
    }
    case 'leaders':
      leaders = [...msg.rows];
      render();
      break;
    case 'adminUsers':
      adminUsers = [...msg.users];
      if (awaitingAdminChange) {
        accountNotice = 'Saved.';
        awaitingAdminChange = false;
        // A change here can move the standings, so refresh them too rather
        // than leaving a board on screen that no longer matches.
        net.send({ t: 'leaderboard' });
      }
      render();
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
function play(tile: TileId, end: End, dir?: Dir): void {
  pending = { tile, end };
  selected = null;
  sfx('place');
  net.send({
    t: 'move',
    move: { kind: 'play', tile, end, ...(dir === undefined ? {} : { dir }) },
  });
}

/**
 * The slot nearest this point, if it is near enough to have been meant.
 *
 * Nobody can hit a small target with a thumb on a moving board, so rather
 * than asking the finger to land inside a box, the nearest slot wins. The
 * cut-off is generous but not unlimited: let go somewhere unrelated and the
 * tile goes back to your hand rather than landing somewhere you did not pick.
 */
function slotAt(x: number, y: number): { end: End; dir: Dir } | null {
  let best: { end: End; dir: Dir } | null = null;
  let bestDistance = Infinity;
  for (const node of document.querySelectorAll('.slot')) {
    const r = node.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const distance = Math.hypot(x - cx, y - cy);
    // Within a tile-and-a-half of the middle of a slot counts as aiming at it.
    const reach = Math.max(r.width, r.height) * 1.5;
    if (distance < bestDistance && distance <= reach) {
      bestDistance = distance;
      const el = node as HTMLElement;
      best = {
        end: el.dataset['end'] === 'left' ? 'left' : 'right',
        dir: Number(el.dataset['dir'] ?? 0) as Dir,
      };
    }
  }
  return best;
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
    const over = slotAt(e.clientX, e.clientY);
    const changed =
      (over === null) !== (dragOver === null) ||
      (over !== null && dragOver !== null && (over.end !== dragOver.end || over.dir !== dragOver.dir));
    if (changed) {
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
    const slot = slotAt(e.clientX, e.clientY);
    clearDrag();
    if (slot !== null) play(id, slot.end, slot.dir);
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
/**
 * Read a form field straight from the page.
 *
 * Not from our own copy of it: a browser filling in a saved password sets the
 * element's value directly, without firing an `input` event, so the copy stays
 * empty while the field visibly shows the password. Reading the element is
 * right however the value got there — typed, pasted, autofilled, or restored
 * when the page came back from the background.
 */
function fieldValue(id: string): string {
  const node = document.getElementById(id);
  return node instanceof HTMLInputElement ? node.value : '';
}

/** A labelled text input that keeps what you typed across a redraw. */
function field(
  id: string,
  label: string,
  type: 'text' | 'password',
  value: string,
  onInput: (v: string) => void,
): HTMLElement {
  const row = el('label', 'formrow');
  row.appendChild(el('span', 'grow', label));
  const input = el('input') as HTMLInputElement;
  input.id = id;
  input.type = type;
  input.value = value;
  input.autocomplete = type === 'password' ? 'current-password' : 'username';
  input.addEventListener('input', () => onInput(input.value));
  row.appendChild(input);
  return row;
}

/** Sign in, or make an account. Username and password only — no email. */
function renderSignInCard(): HTMLElement {
  const card = el('div', 'card');
  card.appendChild(el('h2', undefined, myAccount === null ? 'Players' : 'Your account'));

  if (accountNotice !== '') {
    card.appendChild(el('p', 'hint ok', accountNotice));
  }

  if (myAccount === null) {
    card.appendChild(
      el('p', 'hint', 'Sign in to have your wins counted on the leaderboard. Playing as a guest works too — it just is not counted.'),
    );
    card.appendChild(
      field('acctuser', 'Name', 'text', signIn.username, (v) => {
        signIn.username = v;
      }),
    );
    card.appendChild(
      field('acctpass', 'Password', 'password', signIn.password, (v) => {
        signIn.password = v;
      }),
    );
    /** Shared by both buttons: read the page, and refuse an empty form here
     *  rather than letting the server answer "wrong name or password", which
     *  sends people hunting for a typo that is not there. */
    const credentials = (): { username: string; password: string } | null => {
      const username = fieldValue('acctuser').trim();
      const password = fieldValue('acctpass');
      if (username === '' || password === '') {
        error = 'Fill in both your name and a password.';
        render();
        return null;
      }
      return { username, password };
    };

    const submit = (): void => {
      const creds = credentials();
      if (creds === null) return;
      accountNotice = '';
      error = '';
      net.send({ t: 'login', ...creds });
    };
    // On a phone the keyboard's own Go key is the obvious way to submit, and
    // these fields are not in a <form>, so nothing would happen without this.
    const pass = card.querySelector('#acctpass');
    if (pass instanceof HTMLInputElement) {
      pass.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key === 'Enter') {
          ev.preventDefault();
          submit();
        }
      });
    }

    const row = el('div', 'btnrow');
    const go = el('button', 'gold', 'Sign in') as HTMLButtonElement;
    go.addEventListener('click', submit);
    row.appendChild(go);
    const make = el('button', 'ghost', 'Create account') as HTMLButtonElement;
    make.addEventListener('click', () => {
      const creds = credentials();
      if (creds === null) return;
      accountNotice = '';
      error = '';
      net.send({ t: 'register', ...creds });
    });
    row.appendChild(make);
    card.appendChild(row);
    return card;
  }

  const me = myAccount;
  const line = el('p', 'signedin');
  line.appendChild(el('b', undefined, me.username));
  if (me.isAdmin) line.appendChild(el('span', 'tag now', 'ADMIN'));
  card.appendChild(line);
  card.appendChild(
    el('p', 'hint', `${me.wins} ${me.wins === 1 ? 'win' : 'wins'} from ${me.matches} ${me.matches === 1 ? 'match' : 'matches'}.`),
  );
  if (me.mustChangePassword) {
    card.appendChild(
      el('p', 'warn', 'An admin set this password for you. Pick your own below.'),
    );
  }

  // Changing your own password: both fields, so a shoulder-surfer cannot
  // change it from an unlocked phone without knowing the old one.
  const details = el('details') as HTMLDetailsElement;
  // Opened already when an admin has just reset it, so the prompt is not
  // hidden behind a tap the player has no reason to make.
  details.open = passwordPanelOpen || me.mustChangePassword;
  details.addEventListener('toggle', () => {
    passwordPanelOpen = details.open;
  });
  details.appendChild(el('summary', undefined, 'Change my password'));
  details.appendChild(field('curpass', 'Current', 'password', '', () => {}));
  details.appendChild(field('newpass', 'New', 'password', '', () => {}));
  const save = el('button', 'gold', 'Save password') as HTMLButtonElement;
  save.style.width = '100%';
  save.addEventListener('click', () => {
    const current = fieldValue('curpass');
    const next = fieldValue('newpass');
    if (current === '' || next === '') {
      error = 'Fill in both your current password and the new one.';
      render();
      return;
    }
    accountNotice = '';
    error = '';
    // Not "Password changed." yet — the server has not answered. Saying so
    // here would claim success for a change that may be about to be refused.
    awaitingPasswordChange = true;
    net.send({ t: 'changePassword', current, next });
  });
  details.appendChild(save);
  card.appendChild(details);

  const row = el('div', 'btnrow');
  if (me.isAdmin) {
    const manage = el('button', 'ghost', showAdmin ? 'Hide players' : 'Manage players') as HTMLButtonElement;
    manage.addEventListener('click', () => {
      showAdmin = !showAdmin;
      accountNotice = '';
      if (showAdmin) net.send({ t: 'adminUsers' });
      render();
    });
    row.appendChild(manage);
  }
  const out = el('button', 'ghost', 'Sign out') as HTMLButtonElement;
  out.addEventListener('click', () => {
    accountNotice = '';
    net.send({ t: 'logout' });
  });
  row.appendChild(out);
  card.appendChild(row);
  return card;
}

function renderLeaderboard(): HTMLElement {
  const card = el('div', 'card');
  card.appendChild(el('h2', undefined, 'Leaderboard'));
  if (leaders.length === 0) {
    card.appendChild(el('p', 'hint', 'No finished matches yet. Win one and it shows up here.'));
    return card;
  }
  const table = el('div', 'leaders');
  for (const row of leaders) {
    const line = el('div', `leaderrow${myAccount?.username === row.username ? ' me' : ''}`);
    line.appendChild(el('span', 'rank', String(row.rank)));
    line.appendChild(el('span', 'who', row.username));
    line.appendChild(el('span', 'wins', `${row.wins}`));
    line.appendChild(el('span', 'played', `of ${row.matches}`));
    table.appendChild(line);
  }
  card.appendChild(table);
  card.appendChild(el('p', 'hint', 'Wins · matches played. Both partners on a winning team get a win.'));
  return card;
}

/** Admin only: the server refuses every one of these from anyone else. */
function renderAdminCard(): HTMLElement | null {
  if (myAccount === null || !myAccount.isAdmin || !showAdmin) return null;
  const card = el('div', 'card');
  card.appendChild(el('h2', undefined, 'Manage players'));
  for (const user of adminUsers) {
    const box = el('div', 'adminrow');
    const head = el('div', 'name');
    head.appendChild(el('b', undefined, user.username));
    if (user.isAdmin) head.appendChild(el('span', 'tag now', 'ADMIN'));
    head.appendChild(el('span', 'sub', `${user.wins} wins · ${user.matches} played`));
    box.appendChild(head);

    const row = el('div', 'btnrow');
    const input = el('input') as HTMLInputElement;
    input.id = `set-${user.username}`;
    input.type = 'text';
    input.placeholder = 'new password';
    row.appendChild(input);
    const set = el('button', 'ghost small', 'Reset') as HTMLButtonElement;
    set.addEventListener('click', () => {
      const next = fieldValue(input.id);
      if (next === '') {
        error = 'Type the new password first.';
        render();
        return;
      }
      accountNotice = '';
      error = '';
      awaitingAdminChange = true;
      net.send({ t: 'adminSetPassword', username: user.username, next });
    });
    row.appendChild(set);
    box.appendChild(row);

    const row2 = el('div', 'btnrow');
    const wins = el('input') as HTMLInputElement;
    wins.id = `wins-${user.username}`;
    wins.type = 'number';
    wins.min = '0';
    wins.value = String(user.wins);
    row2.appendChild(wins);
    const setWins = el('button', 'ghost small', 'Set wins') as HTMLButtonElement;
    setWins.addEventListener('click', () => {
      accountNotice = '';
      awaitingAdminChange = true;
      net.send({ t: 'adminSetWins', username: user.username, wins: Number(fieldValue(wins.id)) });
    });
    row2.appendChild(setWins);
    const toggle = el('button', 'ghost small', user.isAdmin ? 'Drop admin' : 'Make admin') as HTMLButtonElement;
    toggle.addEventListener('click', () => {
      accountNotice = '';
      awaitingAdminChange = true;
      net.send({ t: 'adminSetAdmin', username: user.username, isAdmin: !user.isAdmin });
    });
    row2.appendChild(toggle);
    if (user.username !== myAccount.username) {
      const del = el('button', 'ghost small danger', 'Delete') as HTMLButtonElement;
      del.addEventListener('click', () => {
        if (!confirm(`Delete ${user.username}? Their wins go too.`)) return;
        accountNotice = '';
        awaitingAdminChange = true;
      net.send({ t: 'adminDelete', username: user.username });
      });
      row2.appendChild(del);
    }
    box.appendChild(row2);
    card.appendChild(box);
  }
  return card;
}

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
  nameInput.id = 'yourname';
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

  // How long a player gets before the server plays for them. A table of
  // family on the sofa usually wants no clock at all; a table spread across
  // phones usually wants one, or somebody who wanders off stalls everyone.
  const clockLabel = el('label');
  clockLabel.appendChild(el('span', 'grow', 'Turn clock'));
  const clockPick = document.createElement('select');
  clockPick.id = 'turnclock';
  for (const [value, text] of [
    ['60', '60 seconds'],
    ['30', '30 seconds'],
    ['120', '2 minutes'],
    ['off', 'No limit'],
    ['custom', 'Custom…'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    if (value === '60') option.selected = true;
    clockPick.appendChild(option);
  }
  clockLabel.appendChild(clockPick);
  rulesBox.appendChild(clockLabel);

  const customRow = el('label');
  customRow.appendChild(el('span', 'grow', 'Seconds per turn'));
  const customSecs = el('input') as HTMLInputElement;
  customSecs.id = 'turnsecs';
  customSecs.type = 'number';
  customSecs.min = '10';
  customSecs.max = '600';
  customSecs.value = '90';
  customSecs.style.width = '80px';
  customRow.appendChild(customSecs);
  customRow.hidden = true;
  rulesBox.appendChild(customRow);
  clockPick.addEventListener('change', () => {
    customRow.hidden = clockPick.value !== 'custom';
  });
  rulesBox.appendChild(
    el('p', 'note', 'With no limit the table simply waits. With a clock, a player who runs out has a tile played for them, so one person wandering off cannot stall the game.'),
  );

  /** Seconds per turn, or null for no clock. */
  const chosenClock = (): number | null => {
    if (clockPick.value === 'off') return null;
    if (clockPick.value === 'custom') {
      const n = Math.round(Number(customSecs.value));
      return Number.isFinite(n) ? Math.min(600, Math.max(10, n)) : 60;
    }
    return Number(clockPick.value);
  };

  const sixEvery = el('label');
  const sixEveryBox = el('input') as HTMLInputElement;
  sixEveryBox.type = 'checkbox';
  sixEveryBox.id = 'sixevery';
  sixEveryBox.checked = true;
  sixEveryBox.style.width = 'auto';
  sixEvery.appendChild(sixEveryBox);
  sixEvery.appendChild(el('span', 'grow', 'The 6-6 opens every round'));
  rulesBox.appendChild(sixEvery);
  rulesBox.appendChild(
    el('p', 'note', 'Whoever is dealt the 6-6 leads, every round. Turn this off and the 6-6 only opens the match, after which the previous round\u2019s winner leads.'),
  );

  const noFive = el('label');
  const noFiveBox = el('input') as HTMLInputElement;
  noFiveBox.type = 'checkbox';
  noFiveBox.id = 'nofivedoubles';
  noFiveBox.checked = true;
  noFiveBox.style.width = 'auto';
  noFive.appendChild(noFiveBox);
  noFive.appendChild(el('span', 'grow', 'Deal again if anyone gets 5 doubles'));
  rulesBox.appendChild(noFive);
  rulesBox.appendChild(
    el('p', 'note', 'Five of the seven doubles in one hand is barely playable — each only ever answers one number. It happens in about one deal in sixty-five; this shuffles and deals again.'),
  );

  const blockLow = el('label');
  const blockLowBox = el('input') as HTMLInputElement;
  blockLowBox.type = 'checkbox';
  blockLowBox.id = 'blocklow';
  blockLowBox.checked = true;
  blockLowBox.style.width = 'auto';
  blockLow.appendChild(blockLowBox);
  blockLow.appendChild(el('span', 'grow', 'A locked round goes to the lightest hand'));
  rulesBox.appendChild(blockLow);
  rulesBox.appendChild(
    el('p', 'note', 'When nobody can play and everyone still holds tiles, the round goes to the team with the single lightest hand — not the lower two-hand total.'),
  );

  const anyDouble = el('label');
  const anyDoubleBox = el('input') as HTMLInputElement;
  anyDoubleBox.type = 'checkbox';
  anyDoubleBox.id = 'anydouble';
  anyDoubleBox.checked = true;
  anyDoubleBox.style.width = 'auto';
  anyDouble.appendChild(anyDoubleBox);
  anyDouble.appendChild(el('span', 'grow', 'The 6-6 holder may open with any double'));
  rulesBox.appendChild(anyDouble);
  rulesBox.appendChild(
    el('p', 'note', 'Whoever holds the 6-6 still leads the first round. Turn this off and they must lay the 6-6 itself; leave it on and they may open with whichever double they like.'),
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
        openWithAnyDouble: anyDoubleBox.checked,
        blockedByLowestPlayer: blockLowBox.checked,
        maxDoublesInHand: noFiveBox.checked ? 4 : null,
        doubleSixOpensEveryRound: sixEveryBox.checked,
        turnSeconds: chosenClock(),
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
  codeInput.id = 'tablecode';
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

  wrap.appendChild(renderSignInCard());
  const adminCard = renderAdminCard();
  if (adminCard !== null) wrap.appendChild(adminCard);
  wrap.appendChild(renderLeaderboard());

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
        el(
          'span',
          'who',
          info.name + (v.you === seat ? ' (you)' : info.bot ? ' · computer' : ''),
        ),
      );
      if (info.bot && v.isHost) {
        const drop = el('button', 'ghost small', 'Remove') as HTMLButtonElement;
        drop.addEventListener('click', () => net.send({ t: 'removeBot', seat }));
        row.appendChild(drop);
      }
    }
    list.appendChild(row);
  }
  seatCard.appendChild(list);
  seatCard.appendChild(
    el('p', 'hint', 'Partners sit opposite: Team A takes seats 1 and 3, Team B takes 2 and 4.'),
  );
  wrap.appendChild(seatCard);

  const seated = v.seats.filter((s) => s !== null).length;
  if (v.isHost && seated < 4) {
    const fill = el('div', 'seatfill');
    const addOne = el('button', 'ghost small', 'Add a computer player') as HTMLButtonElement;
    addOne.addEventListener('click', () => net.send({ t: 'addBot' }));
    fill.appendChild(addOne);
    const fillAll = el('button', 'ghost small', `Fill the table (${4 - seated})`) as HTMLButtonElement;
    fillAll.addEventListener('click', () => {
      for (let i = seated; i < 4; i++) net.send({ t: 'addBot' });
    });
    fill.appendChild(fillAll);
    seatCard.appendChild(fill);
    seatCard.appendChild(
      el('p', 'hint', 'Computer players fill the empty seats so you can try a table on your own.'),
    );
  }

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

  const sound = el('button', 'iconbtn', muted ? '🔇' : '🔊') as HTMLButtonElement;
  // The buzz when your turn comes round rides this switch too, so one tap
  // turns off every interruption rather than leaving half of them on.
  sound.title = muted ? 'Sound and buzz off' : 'Sound and buzz on';
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

/** Play goes round the table one seat at a time, so the next is simply +1. */
function nextSeat(seat: Seat): Seat {
  return ((seat + 1) % 4) as Seat;
}

function renderOpponents(v: PlayerView): HTMLElement {
  const wrap = el('div', 'opponents');
  // Start from the seat after yours so the order matches play order.
  const base = v.you ?? 0;
  const upNext = v.turn === null ? null : nextSeat(v.turn);
  for (let i = 1; i <= 3; i++) {
    const seat = ((base + i) % 4) as Seat;
    const info = v.seats[seat] ?? null;
    const onTurn = v.turn === seat;
    const next = !onTurn && upNext === seat;
    const card = el(
      'div',
      `opp ${teamClass(seat)}${onTurn ? ' turn' : ''}${next ? ' next' : ''}`,
    );
    const nameRow = el('div', 'name');
    if (info !== null) nameRow.appendChild(el('span', `dot${info.connected ? '' : ' off'}`));
    nameRow.appendChild(el('span', undefined, info?.name ?? 'Empty'));
    card.appendChild(nameRow);

    // The state goes on the second line rather than beside the name. Next to
    // it, a badge and three cards do not fit across a narrow phone without
    // cutting the very names they are labelling — and down here the word fits
    // in full. Said in words as well as colour: a tinted border is easy to
    // miss on a phone, and colour alone is no use to everyone.
    //
    // It takes the place of "Opponent" or "Your partner" on the one card it
    // applies to. Whose side they are on is still there in the coloured edge,
    // and in the seating: your partner is always the middle card.
    const relation = seat === ((base + 2) % 4) ? 'Your partner' : 'Opponent';
    const state = onTurn ? 'PLAYING' : next ? 'Next' : relation;
    const sub = el('div', `sub${onTurn ? ' now' : next ? ' soon' : ''}`);
    sub.appendChild(el('span', 'state', state));
    sub.appendChild(el('span', undefined, ` · ${info?.tiles ?? 0} tiles`));
    card.appendChild(sub);
    card.appendChild(tileBacks(info?.tiles ?? 0));
    wrap.appendChild(card);
  }
  return wrap;
}

/** Base tile dimensions in CSS pixels, matching the stylesheet. */
const TILE_SHORT = 40;
const TILE_GAP = 3;

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


/**
 * The stand-in used to work out how much room to keep around the board.
 *
 * Any ordinary tile will do: only its length and whether it is a double
 * matter, never which tile it is or who holds it.
 */
const ROOM_FOR: TileId = '0-1';

function renderTable(v: PlayerView): HTMLElement {
  const box = el('div', 'table');
  const chain = el('div', `chain${messy ? ' messy' : ''}`);
  const playing = v.youMayMove;

  if (v.board.length === 0) {
    // The lead has no ends to choose between, so the whole table is one
    // target. Without this a dragged tile has nowhere to land and the opener
    // is left wondering why nothing happens.
    const leading = dragTile ?? selected;
    const showLead = leading !== null && playing;

    // Both of these sit in the middle of the table, so showing them together
    // prints one straight over the other.
    if (!showLead) {
      chain.appendChild(
        el(
          'div',
          'empty-table',
          playing ? 'Your lead — lay a tile down.' : 'Waiting for the opening tile…',
        ),
      );
    }
    box.appendChild(chain);

    if (showLead) {
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

  // The shape of the chain is the table's doing, not this client's: every
  // tile carries the direction it was laid in. All that happens here is
  // scaling grid units to pixels.
  const openerAt = openerIndexOf(v.board, v.openerTile);
  const tiles = laidTiles(v.board);
  const aiming = dragTile ?? selected;
  const slots = aiming === null ? [] : slotsFor(tiles, openerAt, aiming);

  // Shrink until the chain — and anywhere the held tile could go — fits.
  const roomW = Math.max(160, Math.min(window.innerWidth, 920) - 28);
  const roomH = Math.max(150, Math.min(430, window.innerHeight - 380));
  const plan = layoutBoard(tiles, openerAt);

  // A spot can sit outside the tiles already down, so the frame has to cover
  // both or the spots would be drawn outside it and clipped.
  //
  // The room is kept whether or not a tile is in hand. Measuring it only
  // while one is held made the whole board shrink the moment you picked a
  // tile up — about a fifth — so a drag that began on the board moved the
  // board out from under the finger that started it. An ordinary tile stands
  // in for whatever is held: it is the longest thing that can go in a spot,
  // and it says nothing about anybody's hand, since where a tile fits is
  // decided by the shape on the table and whether the tile is a double.
  let minX = 0;
  let minY = 0;
  let maxX = plan.width;
  let maxY = plan.height;
  for (const slot of [...slotsFor(tiles, openerAt, ROOM_FOR), ...slots]) {
    minX = Math.min(minX, slot.x);
    minY = Math.min(minY, slot.y);
    maxX = Math.max(maxX, slot.x + slot.w);
    maxY = Math.max(maxY, slot.y + slot.h);
  }
  const unitsW = Math.max(maxX - minX, 1);
  const unitsH = Math.max(maxY - minY, 1);

  // A tile is SHORT (2) units across, so a unit is half a tile's short side.
  const base = TILE_SHORT / 2;
  let scale = chainScale(v.board.length);
  scale = Math.min(scale, roomW / (unitsW * base), roomH / (unitsH * base));
  const unit = base * scale;
  chain.style.setProperty('--tile-scale', String(scale));

  const pitch = el('div', 'pitch');
  pitch.style.width = `${unitsW * unit}px`;
  pitch.style.height = `${unitsH * unit}px`;

  for (const spot of plan.placements) {
    const tile = v.board[spot.index] as PlayerView['board'][number];
    const node = boardTile(tile, tile.id === freshId, spot.flipped, spot.vertical);
    node.style.left = `${(spot.x - minX) * unit}px`;
    node.style.top = `${(spot.y - minY) * unit}px`;
    node.style.width = `${spot.w * unit}px`;
    node.style.height = `${spot.h * unit}px`;
    if (tile.id === v.openerTile) node.classList.add('opener');
    if (messy) applyMess(node, tile.id);
    pitch.appendChild(node);
  }

  // Everywhere the held tile could go: above, beside or below an end. Drag it
  // to the one you want — the nearest wins, so a thumb does not have to be
  // precise — or tap one.
  for (const slot of slots) {
    const lit = dragOver !== null && dragOver.end === slot.end && dragOver.dir === slot.dir;
    const tappable = dragTile === null;
    const node = el(
      tappable ? 'button' : 'div',
      `slot${lit ? ' over' : ''}${tappable ? ' tappable' : ''}`,
    );
    node.dataset['end'] = slot.end;
    node.dataset['dir'] = String(slot.dir);
    node.style.left = `${(slot.x - minX) * unit}px`;
    node.style.top = `${(slot.y - minY) * unit}px`;
    node.style.width = `${slot.w * unit}px`;
    node.style.height = `${slot.h * unit}px`;
    if (tappable && aiming !== null) {
      node.setAttribute('aria-label', `Lay it here, on the ${slot.end} end`);
      node.addEventListener('click', () => play(aiming, slot.end, slot.dir));
    }
    pitch.appendChild(node);
  }

  chain.appendChild(pitch);
  box.appendChild(chain);
  lastBoard = ids;
  return box;
}

/**
 * Whose turn it is, said plainly.
 *
 * Four people round a table on four phones cannot see each other's screens,
 * so the one thing the page has to answer at a glance is "is it me?". It is
 * a badge rather than a line of prose, and it keeps its size whichever
 * answer it is giving: a banner that grew on your turn would shunt the board
 * up and down all game.
 */
function renderStatus(v: PlayerView): HTMLElement {
  const status = el('div', 'status');
  if (v.you === null) {
    status.appendChild(el('span', undefined, 'You are watching this table.'));
    return status;
  }

  const mine = myTurn();
  const team = v.turn === null ? '' : ` ${teamClass(v.turn)}`;
  // `whoseturn`, not `turn`: an opponent's card already answers to `turn`,
  // and a bare `.turn` rule here reshaped the card of the very player it was
  // meant to point at.
  const banner = el('div', `whoseturn ${mine ? 'mine' : 'theirs'}${team}`);

  const who = v.turn === null ? null : v.seats[v.turn];
  if (mine) {
    // Still no hint about whether anything fits — that is yours to work out.
    banner.appendChild(el('span', 'label', 'YOUR TURN'));
  } else {
    banner.appendChild(el('span', 'label', 'Waiting for'));
    banner.appendChild(el('span', 'name', who?.name ?? '…'));
  }
  // The words are spaced by the layout, not by the text, so read aloud they
  // would run together. Say it once more in a whole sentence, and let a
  // screen reader announce it when the turn moves.
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.setAttribute(
    'aria-label',
    mine ? 'Your turn' : `Waiting for ${who?.name ?? 'the next player'}`,
  );
  if (v.turnDeadline !== null) {
    const clock = el('span', 'clock', '');
    clock.id = 'clock';
    banner.appendChild(clock);
  }
  status.appendChild(banner);

  // Who follows, so nobody has to count seats round the table. Always drawn,
  // empty if there is nothing to say, so the line below never moves.
  const after = v.turn === null ? null : nextSeat(v.turn);
  const label =
    after === null ? '' : after === v.you ? 'you' : (v.seats[after]?.name ?? `seat ${after + 1}`);
  status.appendChild(el('div', 'upnext', label === '' ? '' : `then ${label}`));
  return status;
}

function renderHand(v: PlayerView): HTMLElement {
  // Your own hand is where your eyes already are, so it carries the loudest
  // part of the answer: on your turn its edge goes gold and the whole shelf
  // lifts. The class only changes colours and shadows — nothing that would
  // change its height and shunt the board around every turn.
  const zone = el('div', `handzone${myTurn() ? ' mine' : ''}`);

  // The turn clock, draining along the top of the shelf. A number alone does
  // not read at arm's length, and watching someone else's time run down is
  // half of knowing whose turn it is. Always drawn — it doubles as the gold
  // edge on your turn, and a bar that came and went would move everything
  // below it. With no clock at this table it simply stays full.
  const track = el('div', 'clockbar');
  const fill = el('i');
  fill.id = 'clockfill';
  track.appendChild(fill);
  zone.appendChild(track);

  const hand = el('div', 'hand');

  if (v.hand.length === 0) {
    hand.appendChild(el('div', 'empty-table', v.you === null ? 'Spectating.' : 'Your hand is empty.'));
  }

  for (const id of v.hand) {
    // Every tile is offered. Whether it fits is for you to work out.
    const state = selected === id ? 'sel' : 'playable';
    const node = handTile(id, state);
    // The tile is in the air under your finger, so the hand shows the socket
    // it came out of rather than a second copy of it. The slot stays the same
    // size: collapsing it would shuffle the other tiles around mid-drag.
    if (dragTile === id) node.classList.add('lifted');
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
      bar.appendChild(el('span', 'hint', 'Now tap one of the spots.'));
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
            : 'Drag a tile where you want it — or tap it, then tap a spot.',
        ),
      );
    }
    // Passing is always allowed — and always a risk, since passing on a tile
    // you could have played loses your team the whole round.
    const passBtn = el('button', 'ghost small', 'Pass') as HTMLButtonElement;
    passBtn.addEventListener('click', pass);
    bar.appendChild(passBtn);
  }

  // Calling someone out does not wait for your turn: you say it the moment
  // you work it out.
  if (v.phase === 'playing' && v.you !== null) {
    const suspects = v.passedSeats.filter((seat) => teamOf(seat) !== teamOf(v.you as Seat));
    if (suspects.length > 0) {
      const callBtn = el('button', 'ghost small danger', 'Catch a pass') as HTMLButtonElement;
      callBtn.addEventListener('click', () => {
        accusing = !accusing;
        render();
      });
      bar.appendChild(callBtn);
    }
  }
  if (bar.childNodes.length > 0) zone.appendChild(bar);

  if (accusing && v.phase === 'playing' && v.you !== null) {
    const panel = el('div', 'accuse');
    panel.appendChild(
      el('p', 'hint', 'Who passed when they could have played? Get it right and they lose the round. Get it wrong and YOUR team does.'),
    );
    const row = el('div', 'accuserow');
    for (const seat of v.passedSeats) {
      if (teamOf(seat) === teamOf(v.you)) continue;
      const name = v.seats[seat]?.name ?? `Seat ${seat + 1}`;
      const btn = el('button', 'ghost small', name) as HTMLButtonElement;
      btn.addEventListener('click', () => {
        accusing = false;
        net.send({ t: 'callOut', seat });
      });
      row.appendChild(btn);
    }
    panel.appendChild(row);
    const cancel = el('button', 'ghost small', 'Never mind') as HTMLButtonElement;
    cancel.addEventListener('click', () => {
      accusing = false;
      render();
    });
    panel.appendChild(cancel);
    zone.appendChild(panel);
  }
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
    sheet.appendChild(
      el('h2', undefined, result?.kind === 'calledOut' ? 'Called out' : 'Round over'),
    );
    if (result !== null) {
      const mineTeam = v.you === null ? null : teamOf(v.you);
      const gained = mineTeam === null ? 0 : result.awarded[mineTeam];
      sheet.appendChild(el('div', 'big num', gained > 0 ? `+${gained}` : '0'));

      const nameOf = (seat: Seat): string => v.seats[seat]?.name ?? `Seat ${seat + 1}`;
      // A locked round goes to the single lightest hand, so name whose it was.
      const lightestSeat = (remaining: readonly number[]): Seat => {
        let best: Seat = 0;
        for (const seat of [1, 2, 3] as Seat[]) {
          if ((remaining[seat] ?? 0) < (remaining[best] ?? 0)) best = seat;
        }
        return best;
      };
      const call = result.calledOut;
      const who =
        call !== null
          ? call.correct
            ? `${nameOf(call.by)} called out ${nameOf(call.accused)} — and was right.`
            : `${nameOf(call.by)} called out ${nameOf(call.accused)} — and was wrong.`
          : result.kind === 'tie'
            ? 'Blocked and level — no point for the round.'
            : result.kind === 'blocked'
              ? // When the lightest hand belongs to a team that forfeited, saying
                // they "take the round" would contradict the forfeit line below.
                `Blocked. ${nameOf(lightestSeat(result.remaining))} held the fewest pips` +
                (result.winningTeam !== null && result.forfeited.includes(result.winningTeam)
                  ? '.'
                  : `, so ${TEAM_NAMES[result.winningTeam ?? 0]} takes the round.`)
              : `${nameOf(result.dominoedBy ?? 0)} went out${result.capicu ? ' with a capicú!' : '.'}`;
      sheet.appendChild(el('p', undefined, who));

      // Spell out the forfeit: losing the round despite going out is the one
      // thing a player will not believe unless it is said plainly.
      for (const team of result.forfeited) {
        const line = el('p', 'forfeit');
        const wentOut = result.dominoedBy !== null && teamOf(result.dominoedBy) === team;
        const wouldHaveWon = result.winningTeam === team && result.kind === 'blocked';
        line.textContent =
          `${TEAM_NAMES[team]} passed on a tile they could have played, so they lose the round` +
          (wentOut
            ? ' — even though they went out first.'
            : wouldHaveWon
              ? ' — even though they held the lightest hand.'
              : '.');
        sheet.appendChild(line);
      }

      // Name anyone caught passing on a tile they could have played.
      if (result.falsePasses.length > 0) {
        const box = el('div', 'penaltybox');
        box.appendChild(el('h3', undefined, 'Caught passing'));
        for (const fp of result.falsePasses) {
          const row = el('div');
          row.appendChild(el('span', undefined, `${nameOf(fp.seat)} had a tile that fitted`));
          row.appendChild(el('span', 'cost', TEAM_NAMES[teamOf(fp.seat)]));
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

  // A practice game against the computer can be binned at any point. A table
  // of real people cannot: walking out of a match you are losing is not a
  // feature, so there is no button for it.
  const againstBots = v.seats.some((seat) => seat?.bot === true);
  if (againstBots && v.isHost) {
    const row = el('div', 'cancelrow');
    const stop = el('button', 'ghost small danger', 'Cancel this game') as HTMLButtonElement;
    stop.addEventListener('click', () => {
      if (!confirm('Cancel this game? The scores for it are thrown away.')) return;
      error = '';
      net.send({ t: 'abandon' });
    });
    row.appendChild(stop);
    wrap.appendChild(row);
  }

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
  // Rebuilding the page destroys whatever input had focus, and on a phone a
  // lost focus closes the keyboard mid-word. Note where the caret was and put
  // it back afterwards.
  const active = document.activeElement;
  const keep =
    active instanceof HTMLInputElement && active.id !== ''
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
      : null;

  const v = view;
  root.replaceChildren(
    v === null ? renderLanding() : v.phase === 'lobby' ? renderLobby(v) : renderGame(v),
  );

  if (keep !== null) {
    const again = document.getElementById(keep.id);
    if (again instanceof HTMLInputElement) {
      again.focus({ preventScroll: true });
      try {
        again.setSelectionRange(keep.start ?? again.value.length, keep.end ?? again.value.length);
      } catch {
        // Some input types refuse a selection range; focus alone is enough.
      }
    }
  }
  tickClock();
}

/** The turn clock updates on its own so a re-render never drops a selection. */
function tickClock(): void {
  const deadline = view?.turnDeadline ?? null;
  const total = view?.rules.turnSeconds ?? null;
  const node = document.getElementById('clock');
  const fill = document.getElementById('clockfill');
  if (deadline === null) {
    // No clock at this table: leave the bar full rather than empty, which
    // would read as time already up.
    if (fill !== null) fill.style.width = '100%';
    return;
  }
  const left = Math.max(0, (deadline - Date.now()) / 1000);
  if (node !== null) {
    node.textContent = `${Math.ceil(left)}s`;
    node.className = left <= 10 ? 'clock low' : 'clock';
  }
  if (fill !== null && total !== null && total > 0) {
    fill.style.width = `${Math.max(0, Math.min(100, (left / total) * 100))}%`;
    fill.className = left <= 10 ? 'low' : '';
  }
}

let resizeTimer: number | null = null;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  // On a phone, opening the on-screen keyboard fires a resize: the window
  // gets shorter. Re-rendering on that tears out the very field being typed
  // into, which closes the keyboard, which fires another resize. Only a
  // change in WIDTH — a rotation, or a desktop window being dragged — needs
  // the board laid out again.
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
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
