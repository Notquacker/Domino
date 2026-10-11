/* Domino Curaçao — pass-and-play.
   The rules come from the same engine the multiplayer server runs; nothing
   about the game is re-decided here. This file is screens and taps only. */
(function () {
  var D = window.DominoRules;
  var TEAMS = ['Team A', 'Team B'];
  var PIPS = { 0: [], 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

  var S = {
    screen: 'setup',
    names: ['Ana', 'Bo', 'Cyd', 'Dee'],
    rules: {
      scoring: 'rounds',
      targetScore: 10,
      winBy: 1,
      drawAt: 5,
      mustOpenDoubleSix: true,
      doubleSixOpensEveryRound: true,
      openWithAnyDouble: true,
      strictPassing: false,
      maxDoublesInHand: 4,
      blockedByLowestPlayer: true,
      falsePassPenalty: 2,
      falsePassForfeits: true,
      countAllRemaining: false,
      capicuPoints: 2
    },
    match: null,
    solo: false,
    selected: null,
    refused: null,
    dragTile: null,
    dragOver: null,
    messy: false,
    accusing: false,
    smashed: false,
    banner: null
  };

  var root = document.getElementById('app');
  var lastBoard = [];
  var dragGhost = null;

  /** A low thump for the slam. No audio files. */
  function sfx() {
    try {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      var ctx = sfx.ctx || (sfx.ctx = new Ctor());
      if (ctx.state === 'suspended') ctx.resume();
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(70, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(28, ctx.currentTime + 0.45);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.42, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) { /* sound is a nicety */ }
  }

  /* ---------- tiny DOM helpers ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function half(v) {
    var f = el('span', 'half'), on = PIPS[v] || [];
    for (var i = 1; i <= 9; i++) f.appendChild(el('span', on.indexOf(i) >= 0 ? 'pip' : null));
    return f;
  }
  function tileNode(a, b, vertical, extra) {
    var n = el('div', 'tile ' + (vertical ? 'v' : 'h') + (extra ? ' ' + extra : ''));
    n.appendChild(half(a));
    n.appendChild(half(b));
    n.setAttribute('aria-label', a + ' ' + b);
    return n;
  }
  /**
   * `flipped` swaps the halves for rows that run right to left, so the pips
   * read continuously along the snake. Swapping beats mirroring with a
   * transform, which would fight the drop animation.
   */
  function boardTile(p, fresh, flipped, runsVertically) {
    var near = flipped ? p.right : p.left;
    var far = flipped ? p.left : p.right;
    var isDouble = p.left === p.right;
    // A tile lies across the run; a double lies along it. Turning the chain
    // swaps both, which is exactly XOR.
    var node = tileNode(near, far, isDouble !== !!runsVertically, 'board' + (fresh ? ' fresh' : ''));
    // The board is in front of everyone, so naming the tiles on it gives
    // nothing away — and it lets a check read where each one ended up.
    node.setAttribute('data-tile', p.id);
    return node;
  }

  /** Knock a tile askew, deterministically so the mess holds still. */
  function applyMess(node, id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    node.style.transform = 'translate(' + ((((h >> 5) % 17) - 8) * 0.9) + 'px,' +
      ((((h >> 9) % 13) - 6) * 0.9) + 'px) rotate(' + (((h % 29) - 14) * 1.15) + 'deg)';
    node.style.zIndex = String(h % 7);
  }

  function handTile(id, state) {
    var t = D.parseTile(id), n = tileNode(t.low, t.high, true, 'inhand ' + state);
    if (state !== 'dead') { n.tabIndex = 0; n.setAttribute('role', 'button'); }
    // Everyone shares this screen, so naming the tile hides nothing — and it
    // lets a check follow one particular tile from a hand onto the table.
    n.setAttribute('data-tile', id);
    return n;
  }
  function backs(n) {
    var w = el('div', 'backs');
    for (var i = 0; i < Math.min(n, 7); i++) w.appendChild(el('span', 'back'));
    return w;
  }
  function teamCls(seat) { return D.teamOf(seat) === 0 ? 'a' : 'b'; }

  /* ---------- derived ---------- */
  function round() { return S.match && S.match.round; }
  function turn() { var r = round(); return r ? r.turn : 0; }
  function playing() { return S.match && S.match.phase === 'playing'; }

  /* ---------- actions ---------- */
  function afterMove() {
    S.selected = null;
    if (S.match.phase === 'playing' && !S.solo) S.screen = 'handoff';
    render();
  }
  /**
   * Try a placement. Nothing told you whether it fits — that is the game — so
   * a refusal is ordinary and just shakes the tile.
   */
  function play(id, end, dir) {
    try {
      var move = { kind: 'play', tile: id, end: end };
      if (dir !== undefined && dir !== null) move.dir = dir;
      S.match = D.applyMove(S.match, turn(), move).match;
      afterMove();
    } catch (e) {
      S.refused = id;
      S.selected = null;
      render();
      setTimeout(function () { S.refused = null; render(); }, 600);
    }
  }
  /**
   * The spot nearest this point, if it is near enough to have been meant.
   *
   * Nobody hits a small target with a thumb, so the nearest spot wins rather
   * than asking the finger to land inside a box. The reach is generous but
   * not unlimited: let go somewhere unrelated and the tile goes back.
   */
  function slotAt(x, y) {
    var nodes = document.querySelectorAll('.slot, .dropzone');
    var best = null, bestDistance = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var r = nodes[i].getBoundingClientRect();
      var dx = x - (r.left + r.width / 2);
      var dy = y - (r.top + r.height / 2);
      var distance = Math.hypot(dx, dy);
      var reach = Math.max(r.width, r.height) * 1.5;
      if (distance < bestDistance && distance <= reach) {
        bestDistance = distance;
        var dir = nodes[i].getAttribute('data-dir');
        best = {
          end: nodes[i].getAttribute('data-end') === 'left' ? 'left' : 'right',
          dir: dir === null ? null : Number(dir)
        };
      }
    }
    return best;
  }

  /** Is this the spot the finger is currently over? */
  function sameSlot(a, b) {
    if (a === null || b === null) return a === b;
    return a.end === b.end && a.dir === b.dir;
  }

  function clearDrag() {
    S.dragTile = null;
    S.dragOver = null;
    if (dragGhost) { dragGhost.remove(); dragGhost = null; }
  }

  /**
   * Drag a tile out of the hand and drop it on an end. A press that never
   * travels stays a tap, so the pick-then-tap flow still works.
   */
  function beginDrag(id, ev, onTap) {
    if (!playing() || ev.button > 0) return;
    var startX = ev.clientX, startY = ev.clientY, dragging = false;
    function move(e) {
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 8) return;
        dragging = true;
        S.dragTile = id;
        S.selected = null;
        dragGhost = handTile(id, 'sel');
        dragGhost.className += ' ghost';
        dragGhost.setAttribute('aria-hidden', 'true');
        document.body.appendChild(dragGhost);
        render();
      }
      if (dragGhost) { dragGhost.style.left = e.clientX + 'px'; dragGhost.style.top = e.clientY + 'px'; }
      var over = slotAt(e.clientX, e.clientY);
      if (!sameSlot(over, S.dragOver)) { S.dragOver = over; render(); }
    }
    function finish(e) {
      detach();
      if (!dragging) { onTap(); return; }
      var spot = slotAt(e.clientX, e.clientY);
      clearDrag();
      if (spot) play(id, spot.end, spot.dir); else render();
    }
    function cancel() { detach(); clearDrag(); render(); }
    function detach() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
  }

  function pass() {
    try {
      S.match = D.applyMove(S.match, turn(), { kind: 'pass' }).match;
      afterMove();
    } catch (e) {
      // Only happens on the opening lead, where somebody must put a tile down.
      S.refused = 'pass';
      render();
      setTimeout(function () { S.refused = null; render(); }, 600);
    }
  }
  /** Accuse an opponent of having passed on a playable tile. Ends the round. */
  function accuse(by, seat) {
    try {
      S.match = D.callOut(S.match, by, seat).match;
      afterMove();
    } catch (e) {
      S.accusing = false;
      render();
    }
  }

  function deal() {
    clearDrag();
    S.accusing = false;
    S.match = D.newMatch(S.rules, Math.random);
    S.messy = false;
    S.smashed = false;
    S.banner = null;
    lastBoard = [];
    S.selected = null;
    S.screen = S.solo ? 'table' : 'handoff';
    render();
  }
  function nextRound() {
    clearDrag();
    S.match = D.startNextRound(S.match, Math.random);
    S.messy = false;
    S.smashed = false;
    lastBoard = [];
    S.selected = null;
    S.screen = S.solo ? 'table' : 'handoff';
    render();
  }

  /* ---------- setup screen ---------- */
  function renderSetup() {
    var wrap = el('div', 'sheetwrap');
    var mark = el('div', 'wordmark');
    mark.appendChild(el('h1', null, 'Domino Curaçao'));
    mark.appendChild(el('p', null, 'Two against two, on one device'));
    wrap.appendChild(mark);

    var who = el('div', 'panel');
    who.appendChild(el('h2', null, 'Who is playing'));
    var grid = el('div', 'grid');
    [0, 1, 2, 3].forEach(function (seat) {
      var row = el('div', 'seatfield');
      row.appendChild(el('span', 'chip ' + teamCls(seat), TEAMS[D.teamOf(seat)]));
      var input = el('input');
      input.id = 'name-' + seat;
      input.value = S.names[seat];
      input.maxLength = 14;
      input.setAttribute('aria-label', 'Name for seat ' + (seat + 1));
      input.addEventListener('input', function () { S.names[seat] = input.value; });
      row.appendChild(input);
      grid.appendChild(row);
    });
    who.appendChild(grid);
    who.appendChild(el('p', 'note', 'Partners sit opposite each other, so seats 1 and 3 play seats 2 and 4.'));
    wrap.appendChild(who);

    var opts = el('div', 'panel');
    opts.appendChild(el('h2', null, 'Table rules'));
    var og = el('div', 'grid');

    var r1 = el('label', 'optrow');
    r1.appendChild(el('span', 'grow', 'Play to'));
    var sel = document.createElement('select');
    sel.id = 'target';
    [7, 10, 12, 15].forEach(function (v) {
      var o = document.createElement('option');
      o.value = String(v); o.textContent = v + ' rounds';
      if (v === S.rules.targetScore) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { S.rules.targetScore = Number(sel.value); });
    r1.appendChild(sel);
    og.appendChild(r1);

    function toggle(id, label, key, onValue) {
      var row = el('label', 'optrow');
      var box = el('input');
      box.type = 'checkbox'; box.id = id;
      box.checked = onValue ? S.rules[key] === onValue : !!S.rules[key];
      box.addEventListener('change', function () {
        if (!onValue) { S.rules[key] = box.checked; return; }
        // The drawn line is off when absent, not when zero.
        S.rules[key] = box.checked ? onValue : (key === 'drawAt' ? null : 0);
      });
      row.appendChild(box);
      row.appendChild(el('span', 'grow', label));
      og.appendChild(row);
      return box;
    }
    toggle('drawline', 'Draw once both teams reach 5', 'drawAt', 5);
    toggle('falsepass', 'Punish a false pass', 'falsePassPenalty', 2);
    toggle('forfeit', 'A false pass loses the whole round', 'falsePassForfeits');
    toggle('blocklow', 'A locked round goes to the single lightest hand', 'blockedByLowestPlayer');
    toggle('nofivedoubles', 'Deal again if anyone gets 5 doubles', 'maxDoublesInHand', 4);
    toggle('capicu', 'Capicú counts double', 'capicuPoints', 2);
    toggle('double6', 'The 6-6 decides who opens', 'mustOpenDoubleSix');
    toggle('six-every', 'The 6-6 opens every round, not just the first', 'doubleSixOpensEveryRound');
    toggle('anydouble', 'The 6-6 holder may open with any double', 'openWithAnyDouble');

    var soloRow = el('label', 'optrow');
    var soloBox = el('input');
    soloBox.type = 'checkbox'; soloBox.id = 'solo'; soloBox.checked = S.solo;
    soloBox.addEventListener('change', function () { S.solo = soloBox.checked; });
    soloRow.appendChild(soloBox);
    soloRow.appendChild(el('span', 'grow', 'Skip the hand-off screen'));
    og.appendChild(soloRow);

    opts.appendChild(og);
    opts.appendChild(el('p', 'note', 'Turn the hand-off screen off to play all four seats yourself and check the rules.'));
    wrap.appendChild(opts);

    var ref = el('div', 'panel');
    var det = el('details', 'rules');
    det.appendChild(el('summary', null, 'What these rules mean'));
    var ul = el('ul', 'ruleslist');
    [
      'All 28 tiles are dealt, seven each — there is no boneyard to draw from.',
      'Whoever is dealt the 6-6 opens every round, and may lead with any double they hold — winning a round does not win you the next lead.',
      'If nothing fits either open end you pass. If something fits, you must play it.',
      'A round ends when someone plays their last tile, or when all four are stuck.',
      'The winning team scores the pips left in the opponents’ hands.',
      'A blocked round goes to the team with fewer pips; dead level scores nothing.'
    ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
    det.appendChild(ul);
    ref.appendChild(det);
    wrap.appendChild(ref);

    var go = el('button', 'gold', 'Deal the first hand');
    go.style.width = '100%';
    go.style.marginTop = '13px';
    go.addEventListener('click', deal);
    wrap.appendChild(go);
    return wrap;
  }

  /* ---------- hand-off ---------- */
  function renderHandoff() {
    var seat = turn();
    var ov = el('div', 'overlay');
    var card = el('div', 'card handoff');
    card.appendChild(el('span', 'badge ' + teamCls(seat), TEAMS[D.teamOf(seat)]));
    card.appendChild(el('div', 'big', S.names[seat] || 'Seat ' + (seat + 1)));
    card.appendChild(el('p', null, 'Pass the device over, then tap below. Nobody else should be looking.'));
    var actions = el('div', 'actions');
    var go = el('button', 'gold', 'I am ' + (S.names[seat] || 'Seat ' + (seat + 1)) + ' — show my hand');
    go.addEventListener('click', function () { S.screen = 'table'; render(); });
    actions.appendChild(go);
    card.appendChild(actions);
    ov.appendChild(card);
    return ov;
  }

  /* ---------- table ---------- */
  function renderTop() {
    var bar = el('div', 'topbar');
    var line = el('div', 'scoreline');
    var a = el('b', 'a num', String(S.match.scores[0]));
    var b = el('b', 'b num', String(S.match.scores[1]));
    line.appendChild(a);
    line.appendChild(el('span', null, '–'));
    line.appendChild(b);
    line.appendChild(el('small', null, 'to ' + S.rules.targetScore));
    bar.appendChild(line);

    var right = el('div', 'right');
    right.appendChild(el('div', null, 'Round ' + S.match.roundNumber));
    bar.appendChild(right);
    return bar;
  }

  function renderOpps() {
    var wrap = el('div', 'opps');
    var me = turn();
    for (var i = 1; i <= 3; i++) {
      var seat = (me + i) % 4;
      // Play goes round one seat at a time, so the seat after the one on turn
      // is next. Said in words as well as colour: a tinted border is easy to
      // miss on a phone, and colour alone is no use to everyone.
      var isNext = seat === (me + 1) % 4;
      var card = el('div', 'opp ' + teamCls(seat) + (isNext ? ' next' : ''));
      var nm = el('div', 'nm');
      nm.appendChild(el('span', null, S.names[seat] || 'Seat ' + (seat + 1)));
      if (isNext) nm.appendChild(el('span', 'tag soon', 'NEXT'));
      card.appendChild(nm);
      var tiles = round().hands[seat].length;
      var rel = seat === (me + 2) % 4 ? 'Your partner' : 'Opponent';
      card.appendChild(el('div', 'sub', rel + ' · ' + tiles + ' tiles'));
      card.appendChild(backs(tiles));
      wrap.appendChild(card);
    }
    return wrap;
  }

  var TILE_SHORT = 39, TILE_LONG = 76, TILE_GAP = 3;

  /** Shrink tiles as the chain grows so the whole board keeps fitting. */
  function chainScale(count) {
    if (count <= 8) return 1;
    if (count <= 14) return 0.84;
    if (count <= 20) return 0.7;
    return 0.58;
  }


  /* Any ordinary tile will do to measure the room a spot needs: only its
     length and whether it is a double matter, never who holds it. */
  var ROOM_FOR = '0-1';

  function renderTable() {
    var box = el('div', 'table');
    var chain = el('div', 'chain' + (S.messy ? ' messy' : ''));
    var board = round().board;
    var isPlaying = playing();

    if (!board.length) {
      // The lead has no ends to choose between, so the whole table is one
      // target; otherwise a dragged tile has nowhere to land.
      var leading = S.dragTile || S.selected;
      var showLead = leading && isPlaying;
      // Both pieces of text sit in the middle of the table, so showing them
      // together prints one straight over the other.
      if (!showLead) {
        chain.appendChild(el('div', 'blank',
          isPlaying ? 'Your lead — lay a tile down.' : 'No tiles down yet.'));
      }
      box.appendChild(chain);

      if (showLead) {
        var leadTap = !S.dragTile;
        var lead = el(leadTap ? 'button' : 'div',
          'dropzone lead' + (S.dragOver ? ' over' : '') + (leadTap ? ' tappable' : ''));
        lead.setAttribute('data-end', 'right');
        lead.appendChild(el('span', 'zonelabel', 'LAY IT DOWN'));
        if (leadTap) {
          lead.setAttribute('aria-label', 'Lay the opening tile down');
          lead.addEventListener('click', function () { play(leading, 'right'); });
        }
        box.appendChild(lead);
      }

      lastBoard = [];
      return box;
    }

    var ids = board.map(function (b) { return b.id; });
    var grewRight = ids.length > lastBoard.length && ids[0] === lastBoard[0];
    var grewLeft = ids.length > lastBoard.length && !grewRight;
    var freshId = grewRight ? ids[ids.length - 1] : (grewLeft ? ids[0] : null);

    // The shape of the chain is the players' doing: every tile carries the
    // direction it was laid in, so all this does is scale grid units to
    // pixels. The same walker the server and the online client use.
    var openerAt = D.openerIndexOf(board, round().openerTile);
    var tiles = D.laidTiles(board);
    var aiming = (S.dragTile || S.selected);
    var slots = aiming && isPlaying ? D.slotsFor(tiles, openerAt, aiming) : [];
    var plan = D.layout(tiles, openerAt);

    // A spot can sit outside the tiles already down, so the frame has to
    // cover both or the spots would be drawn outside it and clipped.
    //
    // The room is kept whether or not a tile is in hand. Measuring it only
    // while one is held made the whole board shrink the moment you picked a
    // tile up, so a drag that began on the board moved the board out from
    // under the finger that started it. ROOM_FOR stands in for whatever is
    // held: it is the longest thing that can go in a spot.
    var minX = 0, minY = 0, maxX = plan.width, maxY = plan.height;
    D.slotsFor(tiles, openerAt, ROOM_FOR).concat(slots).forEach(function (sp) {
      minX = Math.min(minX, sp.x); minY = Math.min(minY, sp.y);
      maxX = Math.max(maxX, sp.x + sp.w); maxY = Math.max(maxY, sp.y + sp.h);
    });
    var unitsW = Math.max(maxX - minX, 1), unitsH = Math.max(maxY - minY, 1);

    var roomW = Math.max(160, Math.min(window.innerWidth, 920) - 28);
    var roomH = Math.max(150, Math.min(430, window.innerHeight - 380));
    // A tile is SHORT (2) units across, so a unit is half its short side.
    var base = TILE_SHORT / 2;
    var scale = Math.min(chainScale(board.length),
      roomW / (unitsW * base), roomH / (unitsH * base));
    var unit = base * scale;
    chain.style.setProperty('--tile-scale', String(scale));

    var pitch = el('div', 'pitch');
    pitch.style.width = (unitsW * unit) + 'px';
    pitch.style.height = (unitsH * unit) + 'px';
    plan.placements.forEach(function (sp) {
      var tile = board[sp.index];
      var node = boardTile(tile, tile.id === freshId, sp.flipped, sp.vertical);
      node.style.left = ((sp.x - minX) * unit) + 'px';
      node.style.top = ((sp.y - minY) * unit) + 'px';
      node.style.width = (sp.w * unit) + 'px';
      node.style.height = (sp.h * unit) + 'px';
      if (tile.id === round().openerTile) node.className += ' opener';
      if (S.messy) applyMess(node, tile.id);
      pitch.appendChild(node);
    });

    // Everywhere the held tile could go: straight on, or round a corner
    // above or below an end. Drag it to the one you want — the nearest
    // wins, so a thumb need not be precise — or tap one.
    slots.forEach(function (sp) {
      var lit = sameSlot(S.dragOver, { end: sp.end, dir: sp.dir });
      var tappable = !S.dragTile;
      var node = el(tappable ? 'button' : 'div',
        'slot' + (lit ? ' over' : '') + (tappable ? ' tappable' : ''));
      node.setAttribute('data-end', sp.end);
      node.setAttribute('data-dir', String(sp.dir));
      node.style.left = ((sp.x - minX) * unit) + 'px';
      node.style.top = ((sp.y - minY) * unit) + 'px';
      node.style.width = (sp.w * unit) + 'px';
      node.style.height = (sp.h * unit) + 'px';
      if (tappable) {
        node.setAttribute('aria-label', 'Lay it here, on the ' + sp.end + ' end');
        node.addEventListener('click', function () { play(aiming, sp.end, sp.dir); });
      }
      pitch.appendChild(node);
    });

    chain.appendChild(pitch);
    box.appendChild(chain);

    lastBoard = ids;
    return box;
  }

  function renderStatus() {
    var s = el('div', 'status');
    if (S.match.phase !== 'playing') return s;
    var name = S.names[turn()] || 'Seat ' + (turn() + 1);
    // No hint about whether anything fits — that is the player's problem.
    s.appendChild(el('span', 'me', name + ' to play'));
    var after = (turn() + 1) % 4;
    s.appendChild(el('span', 'upnext',
      ' · then ' + (S.names[after] || 'Seat ' + (after + 1))));
    return s;
  }

  function renderHand() {
    var zone = el('div', 'handzone');

    var hand = el('div', 'hand');
    var tiles = round().hands[turn()];

    if (!tiles.length) hand.appendChild(el('div', 'blank', 'Hand empty.'));
    tiles.forEach(function (id) {
      // Every tile looks the same: spotting what fits is the player's job.
      var node = handTile(id, S.selected === id ? 'sel' : 'playable');
      // The tile is in the air under your finger, so the hand shows the
      // socket it came out of rather than a second copy of it. The slot keeps
      // its size: collapsing it would shuffle the rest around mid-drag.
      if (S.dragTile === id) node.className += ' lifted';
      if (S.refused === id) node.className += ' refused';
      var act = function () {
        S.selected = S.selected === id ? null : id;
        render();
      };
      node.addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        beginDrag(id, ev, act);
      });
      node.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); }
      });
      hand.appendChild(node);
    });
    zone.appendChild(hand);

    var bar = el('div', 'handbar');
    if (playing()) {
      bar.appendChild(el('span', 'hint',
        round().board.length === 0 ? 'Pick a tile, then lay it down.'
          : S.selected ? 'Now tap one of the spots.'
          : 'Drag a tile where you want it — or tap it, then tap a spot.'));
      if (S.selected) {
        var c = el('button', 'ghost small', 'Cancel');
        c.addEventListener('click', function () { S.selected = null; render(); });
        bar.appendChild(c);
      }
      var p = el('button', 'ghost small', 'Pass');
      if (S.refused === 'pass') p.className += ' refused';
      p.addEventListener('click', pass);
      bar.appendChild(p);

      // Calling someone out does not wait for your turn.
      var me = turn();
      var suspects = D.seatsThatPassed(round()).filter(function (seat) {
        return D.teamOf(seat) !== D.teamOf(me);
      });
      if (suspects.length) {
        var cb = el('button', 'ghost small danger', 'Catch a pass');
        cb.addEventListener('click', function () { S.accusing = !S.accusing; render(); });
        bar.appendChild(cb);
      }
    }
    if (bar.childNodes.length) zone.appendChild(bar);

    if (S.accusing && playing()) {
      var me2 = turn();
      var panel = el('div', 'accuse');
      panel.appendChild(el('p', 'hint', 'Who passed when they could have played? Right and they lose the round. Wrong and YOUR team does.'));
      var row2 = el('div', 'accuserow');
      D.seatsThatPassed(round()).forEach(function (seat) {
        if (D.teamOf(seat) === D.teamOf(me2)) return;
        var b = el('button', 'ghost small', S.names[seat] || 'Seat ' + (seat + 1));
        b.addEventListener('click', function () { S.accusing = false; accuse(me2, seat); });
        row2.appendChild(b);
      });
      panel.appendChild(row2);
      var nv = el('button', 'ghost small', 'Never mind');
      nv.addEventListener('click', function () { S.accusing = false; render(); });
      panel.appendChild(nv);
      zone.appendChild(panel);
    }
    return zone;
  }

  /* ---------- result overlays ---------- */
  function renderResult() {
    var phase = S.match.phase;
    if (phase !== 'roundOver' && phase !== 'matchOver') return null;
    var r = S.match.lastResult;
    var ov = el('div', 'overlay');
    var card = el('div', 'card');

    if (phase === 'matchOver' && S.match.drawn) {
      card.appendChild(el('h2', null, 'Match drawn'));
      card.appendChild(el('div', 'big num', S.match.scores[0] + ' – ' + S.match.scores[1]));
      card.appendChild(el('p', null,
        'Both teams reached ' + (S.rules.drawAt || 5) + ', so the match is level. Nobody takes it.'));
    } else if (phase === 'matchOver') {
      card.appendChild(el('span', 'badge ' + (S.match.winner === 0 ? 'a' : 'b'), TEAMS[S.match.winner]));
      var names = (S.match.winner === 0 ? [0, 2] : [1, 3]).map(function (s) { return S.names[s]; }).join(' & ');
      card.appendChild(el('h2', null, names + ' take the match'));
      card.appendChild(el('div', 'big num', S.match.scores[0] + ' – ' + S.match.scores[1]));
    } else {
      var head = r.kind === 'calledOut' ? 'Called out'
        : r.kind === 'tie' ? 'Blocked, and level'
        : r.kind === 'blocked' ? 'Blocked' : (S.names[r.dominoedBy] || 'A player') + ' went out';
      card.appendChild(el('h2', null, head + (r.capicu ? ' — capicú!' : '')));
      // r.points is the total that moved across BOTH teams, which reads as a
      // nonsense score. Show what the round winner gained, then the split.
      var gotA = r.awarded ? r.awarded[0] : 0;
      var gotB = r.awarded ? r.awarded[1] : 0;
      var headline = r.winningTeam === null ? Math.max(gotA, gotB)
        : (r.winningTeam === 0 ? gotA : gotB);
      card.appendChild(el('div', 'big num', headline > 0 ? '+' + headline : '0'));
      if (gotA > 0 && gotB > 0) {
        card.appendChild(el('p', null, TEAMS[0] + ' +' + gotA + ' · ' + TEAMS[1] + ' +' + gotB));
      }
      var nameOf = function (seat) { return S.names[seat] || 'Seat ' + (seat + 1); };
      var lightestName = function (res) {
        var best = 0;
        res.remaining.forEach(function (pips, seat) { if (pips < res.remaining[best]) best = seat; });
        return nameOf(best);
      };
      var why;
      if (r.calledOut) {
        why = nameOf(r.calledOut.by) + ' called out ' + nameOf(r.calledOut.accused) +
          (r.calledOut.correct ? ' — and was right.' : ' — and was wrong.');
      } else {
        why = r.kind === 'tie' ? 'The teams held equal pips, so nobody takes the round.'
          : r.kind === 'blocked' ? lightestName(r) + ' held the fewest pips' +
              ((r.forfeited || []).indexOf(r.winningTeam) >= 0
                ? '.' : ', so ' + TEAMS[r.winningTeam] + ' takes the round.')
          : TEAMS[r.winningTeam] + ' takes the round.';
      }
      card.appendChild(el('p', null, why));

      (r.forfeited || []).forEach(function (team) {
        var wentOut = r.dominoedBy !== null && D.teamOf(r.dominoedBy) === team;
        var wouldHaveWon = r.winningTeam === team && r.kind === 'blocked';
        card.appendChild(el('p', 'forfeit', TEAMS[team] +
          ' passed on a tile they could have played, so they lose the round' +
          (wentOut ? ' — even though they went out first.'
            : wouldHaveWon ? ' — even though they held the lightest hand.' : '.')));
      });

      // Anyone who passed holding a tile that would have fitted.
      if (r.falsePasses && r.falsePasses.length) {
        var box = el('div', 'penaltybox');
        box.appendChild(el('h3', null, 'Caught passing'));
        r.falsePasses.forEach(function (fp) {
          var row = el('div');
          row.appendChild(el('span', null,
            (S.names[fp.seat] || 'Seat ' + (fp.seat + 1)) + ' had a tile that fitted'));
          row.appendChild(el('span', 'cost', TEAMS[D.teamOf(fp.seat)]));
          box.appendChild(row);
        });
        card.appendChild(box);
      }

      var led = el('div', 'ledger');
      [0, 1, 2, 3].forEach(function (seat) {
        var row = el('div');
        row.appendChild(el('span', 'k', (S.names[seat] || 'Seat ' + (seat + 1)) + ' · ' + TEAMS[D.teamOf(seat)]));
        row.appendChild(el('span', 'num', r.remaining[seat] + ' pips'));
        led.appendChild(row);
      });
      card.appendChild(led);
      var line = S.rules.drawAt ? ', drawn if both reach ' + S.rules.drawAt : '';
      card.appendChild(el('p', null, 'Match: ' + S.match.scores[0] + ' – ' + S.match.scores[1] +
        ' (first to ' + S.rules.targetScore + line + ')'));
    }

    var actions = el('div', 'actions');
    if (r && r.capicu && !S.smashed) {
      var smash = el('button', 'smashbtn', '💥  SMASH THE TABLE');
      smash.addEventListener('click', function () {
        S.smashed = true;
        S.messy = true;
        sfx();
        document.body.className += ' shaking';
        setTimeout(function () {
          document.body.className = document.body.className.replace(/ ?shaking/, '');
        }, 650);
        S.banner = (S.names[r.dominoedBy] || 'Someone') + ' slammed the table!';
        render();
        setTimeout(function () { S.banner = null; render(); }, 2600);
      });
      actions.appendChild(smash);
      actions.appendChild(el('span', 'hint', 'A capicú earns a slam. Make a mess of them.'));
    }
    if (phase === 'roundOver') {
      var next = el('button', 'gold', 'Deal the next round');
      next.addEventListener('click', nextRound);
      actions.appendChild(next);
    } else {
      var again = el('button', 'gold', 'Play again');
      again.addEventListener('click', deal);
      actions.appendChild(again);
      var back = el('button', 'ghost', 'Change players or rules');
      back.addEventListener('click', function () { S.screen = 'setup'; S.match = null; render(); });
      actions.appendChild(back);
    }
    card.appendChild(actions);
    ov.appendChild(card);
    return ov;
  }

  /* ---------- render ---------- */
  function render() {
    // Rebuilding the page throws away whatever input had focus, and on a
    // phone a lost focus shuts the keyboard mid-word. Remember where the
    // caret was and put it back once the new page is in place.
    var active = document.activeElement;
    var keep = (active && active.tagName === 'INPUT' && active.id)
      ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
      : null;
    renderInto();
    if (keep) {
      var again = document.getElementById(keep.id);
      if (again && again.tagName === 'INPUT') {
        again.focus({ preventScroll: true });
        try { again.setSelectionRange(keep.start, keep.end); } catch (e) { /* some types refuse */ }
      }
    }
  }

  function renderInto() {
    root.replaceChildren();
    if (S.screen === 'setup' || !S.match) { root.appendChild(renderSetup()); return; }

    root.appendChild(renderTop());
    if (S.banner) root.appendChild(el('div', 'smashbanner', '💥  ' + S.banner));
    root.appendChild(renderOpps());
    root.appendChild(renderTable());
    root.appendChild(renderStatus());
    root.appendChild(renderHand());

    // While the table is being slammed, get the sheet out of the way so the
    // mess is actually visible.
    var result = S.banner ? null : renderResult();
    if (result) { root.appendChild(result); return; }
    if (S.screen === 'handoff') root.appendChild(renderHandoff());
  }

  /* Keep the game across a republish rather than dropping it mid-round. */
  function start(saved) {
    if (saved && saved.S) {
      try {
        S.names = saved.S.names || S.names;
        S.rules = saved.S.rules || S.rules;
        S.solo = !!saved.S.solo;
        S.match = saved.S.match || null;
        S.screen = saved.S.screen || 'setup';
      } catch (e) { /* fall back to a fresh table */ }
    }
    render();
  }
  var resizeTimer = null;
  var lastWidth = window.innerWidth;
  window.addEventListener('resize', function () {
    // On a phone, opening the on-screen keyboard fires a resize: the window
    // just gets shorter. Re-rendering on that tears out the very field being
    // typed into, which closes the keyboard, which fires another resize — so
    // the keyboard flickers and nothing can be entered. Only a change in
    // WIDTH, a rotation, needs the board laid out again.
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resizeTimer = null; render(); }, 150);
  });

  if (window.claude && window.claude.hot) {
    window.claude.hot.snapshot(function () { return { S: S }; });
  }
  if (window.claude && window.claude.hot && window.claude.hot.ready) {
    window.claude.hot.ready(start);
  } else {
    start((window.claude && window.claude.hot && window.claude.hot.data) || {});
  }
})();
