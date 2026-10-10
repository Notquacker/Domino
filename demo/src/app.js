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
      strictPassing: false,
      falsePassPenalty: 1,
      countAllRemaining: false,
      capicuPoints: 2
    },
    match: null,
    solo: false,
    selected: null,
    refused: null
  };

  var root = document.getElementById('app');
  var lastBoard = [];
  var tableScroll = 0;
  /* Which end the chain last grew at, so the end you can actually play on
     stays on screen across re-renders — not just the one that caused it. */
  var anchor = null;
  var userScrolled = false;

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
  function boardTile(p, fresh) {
    return tileNode(p.left, p.right, p.left === p.right, 'board' + (fresh ? ' fresh' : ''));
  }
  function handTile(id, state) {
    var t = D.parseTile(id), n = tileNode(t.low, t.high, true, 'inhand ' + state);
    if (state !== 'dead') { n.tabIndex = 0; n.setAttribute('role', 'button'); }
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
  function play(id, end) {
    try {
      S.match = D.applyMove(S.match, turn(), { kind: 'play', tile: id, end: end }).match;
      afterMove();
    } catch (e) {
      S.refused = id;
      S.selected = null;
      render();
      setTimeout(function () { S.refused = null; render(); }, 600);
    }
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
  function deal() {
    S.match = D.newMatch(S.rules, Math.random);
    lastBoard = [];
    S.selected = null;
    S.screen = S.solo ? 'table' : 'handoff';
    render();
  }
  function nextRound() {
    S.match = D.startNextRound(S.match, Math.random);
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
    toggle('drawline', 'Draw if both teams reach 5', 'drawAt', 5);
    toggle('falsepass', 'Point against a false pass', 'falsePassPenalty', 1);
    toggle('capicu', 'Capicú counts double', 'capicuPoints', 2);
    toggle('double6', 'First round opens with the 6-6', 'mustOpenDoubleSix');

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
      var card = el('div', 'opp ' + teamCls(seat));
      card.appendChild(el('div', 'nm', S.names[seat] || 'Seat ' + (seat + 1)));
      var tiles = round().hands[seat].length;
      var rel = seat === (me + 2) % 4 ? 'Your partner' : 'Opponent';
      card.appendChild(el('div', 'sub', rel + ' · ' + tiles + ' tiles'));
      card.appendChild(backs(tiles));
      wrap.appendChild(card);
    }
    return wrap;
  }

  function endSlot(end) {
    var ends = D.openEnds(round().board);
    var armed = !!S.selected;
    var pip = end === 'left' ? ends.left : ends.right;
    var b = el('button', 'endslot' + (armed ? ' armed' : ''), String(pip));
    b.setAttribute('aria-label', 'Play your tile on the ' + end + ' end, showing ' + pip);
    b.disabled = !armed;
    b.addEventListener('click', function () { if (S.selected) play(S.selected, end); });
    return b;
  }

  function renderTable() {
    var box = el('div', 'table');
    var chain = el('div', 'chain');
    var board = round().board;
    var playing = S.match.phase === 'playing';

    if (!board.length) {
      chain.appendChild(el('div', 'blank', playing ? 'Your lead — tap a tile to lay it down.' : 'No tiles down yet.'));
    } else {
      if (playing) chain.appendChild(endSlot('left'));
      var ids0 = board.map(function (b) { return b.id; });
      // Whichever end grew holds the tile that just landed.
      var freshId = ids0.length > lastBoard.length
        ? (ids0[0] === lastBoard[0] ? ids0[ids0.length - 1] : ids0[0])
        : null;
      board.forEach(function (p) { chain.appendChild(boardTile(p, p.id === freshId)); });
      if (playing) chain.appendChild(endSlot('right'));
    }
    box.appendChild(chain);

    var ids = board.map(function (b) { return b.id; });
    if (ids.length > lastBoard.length) {
      anchor = ids[0] === lastBoard[0] ? 'right' : 'left';
      userScrolled = false;
    }
    if (!ids.length) { anchor = null; userScrolled = false; }

    // Two frames: the first lets the chain lay out (web fonts can still be
    // settling), the second measures a width that is actually final.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var max = Math.max(0, box.scrollWidth - box.clientWidth);
        var target = userScrolled ? Math.min(tableScroll, max)
          : anchor === 'right' ? max
          : anchor === 'left' ? 0
          : Math.min(tableScroll, max);
        programmatic = true;
        box.scrollLeft = target;
        tableScroll = target;
        requestAnimationFrame(function () { programmatic = false; });
      });
    });
    var programmatic = false;
    box.addEventListener('scroll', function () {
      tableScroll = box.scrollLeft;
      if (!programmatic) userScrolled = true;   // respect a deliberate look elsewhere
    });
    lastBoard = ids;
    return box;
  }

  function renderStatus() {
    var s = el('div', 'status');
    if (S.match.phase !== 'playing') return s;
    var name = S.names[turn()] || 'Seat ' + (turn() + 1);
    // No hint about whether anything fits — that is the player's problem.
    s.appendChild(el('span', 'me', name + ' to play.'));
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
      if (S.refused === id) node.className += ' refused';
      var act = function () {
        // Opening lead: only one place it can go, so one tap lays it down.
        if (round().board.length === 0) { play(id, 'right'); return; }
        S.selected = S.selected === id ? null : id;
        render();
      };
      node.addEventListener('click', act);
      node.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); }
      });
      hand.appendChild(node);
    });
    zone.appendChild(hand);

    var bar = el('div', 'handbar');
    if (playing()) {
      bar.appendChild(el('span', 'hint',
        round().board.length === 0 ? 'Tap a tile to lead.'
          : S.selected ? 'Tap the end you want.' : 'Pick a tile, then an end.'));
      if (S.selected) {
        var c = el('button', 'ghost small', 'Cancel');
        c.addEventListener('click', function () { S.selected = null; render(); });
        bar.appendChild(c);
      }
      var p = el('button', 'ghost small', 'Pass');
      if (S.refused === 'pass') p.className += ' refused';
      p.addEventListener('click', pass);
      bar.appendChild(p);
    }
    if (bar.childNodes.length) zone.appendChild(bar);
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
      var head = r.kind === 'tie' ? 'Blocked, and level'
        : r.kind === 'blocked' ? 'Blocked' : (S.names[r.dominoedBy] || 'A player') + ' went out';
      card.appendChild(el('h2', null, head + (r.capicu ? ' — capicú!' : '')));
      card.appendChild(el('div', 'big num', r.points > 0 ? '+' + r.points : '0'));
      var why = r.kind === 'tie' ? 'The teams held equal pips, so nobody takes the round.'
        : r.kind === 'blocked' ? TEAMS[r.winningTeam] + ' held fewer pips and takes the round.'
        : TEAMS[r.winningTeam] + ' takes the round.';
      card.appendChild(el('p', null, why));

      // Anyone who passed holding a tile that would have fitted.
      if (r.falsePasses && r.falsePasses.length) {
        var box = el('div', 'penaltybox');
        box.appendChild(el('h3', null, 'Caught passing'));
        r.falsePasses.forEach(function (fp) {
          var row = el('div');
          row.appendChild(el('span', null,
            (S.names[fp.seat] || 'Seat ' + (fp.seat + 1)) + ' had a tile that fitted'));
          row.appendChild(el('span', 'cost', '+1 ' + TEAMS[1 - D.teamOf(fp.seat)]));
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
    root.replaceChildren();
    if (S.screen === 'setup' || !S.match) { root.appendChild(renderSetup()); return; }

    root.appendChild(renderTop());
    root.appendChild(renderOpps());
    root.appendChild(renderTable());
    root.appendChild(renderStatus());
    root.appendChild(renderHand());

    var result = renderResult();
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
  if (window.claude && window.claude.hot) {
    window.claude.hot.snapshot(function () { return { S: S }; });
  }
  if (window.claude && window.claude.hot && window.claude.hot.ready) {
    window.claude.hot.ready(start);
  } else {
    start((window.claude && window.claude.hot && window.claude.hot.data) || {});
  }
})();
