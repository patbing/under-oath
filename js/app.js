/* Under Oath: the page. Model text is only ever inserted with textContent. */
(function () {
  'use strict';
  var C = window.UO.config, G = window.UO.game, N = window.UO.net;
  var STORE = 'under-oath-v1';
  var VERDICT = {
    agreed: 'the referee agreed', unclear: 'unchecked: an unclear or unparseable answer, or the referee call failed',
    split: 'split: the referee disagreed, and the Keeper\'s own model asked fresh did not back the referee',
    flagged: 'flagged: the referee and the Keeper\'s own model asked fresh both answered the other way'
  };
  var END = { solved: 'solved', unsolved: 'not solved in 20 turns', error: 'ended by an error', cap: 'stopped at the spend limit', stopped: 'stopped' };

  var app = {
    words: [], rec: null, played: [], cur: null, notice: '',
    key: null, models: [], byId: {}, keeper: C.DEFAULT_KEEPER, asker: C.DEFAULT_ASKER, wordPick: '',
    busy: false, stopAsked: false, ctrl: null, spent: 0, capSpent: 0
  };

  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmtP(x) { return (x < 0.001 ? x.toFixed(5) : x.toFixed(4)) + ' P'; }
  function short(id) { var m = app.byId[id] || (app.rec && app.rec.models.filter(function (x) { return x.id === id; })[0]); return (m && m.title) || id; }
  function wordOf(id) { return app.words.filter(function (w) { return w.id === id; })[0]; }
  function store() { try { return JSON.parse(localStorage.getItem(STORE)) || { seen: [], races: 0, you: 0, asker: 0, neither: 0 }; } catch (e) { return { seen: [], races: 0, you: 0, asker: 0, neither: 0 }; } }
  function save(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); } catch (e) { /* private mode: nothing kept */ } }
  async function sha256(s) {
    var b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function randomHex(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }

  // ---------- recorded games ----------
  function getJSON(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error(url + ': HTTP ' + r.status); return r.json(); }); }

  // Replays a recorded game through the same engine, keeping each rebuilt request's messages for "the actual request".
  async function replay(r) {
    var w = wordOf(r.wordId), seats = G.recordedSeats(r, null, []), msgs = [];
    function keep(role) { return function (m, i) { (msgs[i] = msgs[i] || {})[role] = m; return seats[role](m, i); }; }
    var g = await G.play(w.word, w.aliases, { ask: keep('ask'), keep: keep('keep'), ref: keep('ref'), recheck: keep('recheck') });
    g.turns.forEach(function (t, i) { t.msgs = msgs[i]; });
    return { id: r.id, keeper: r.keeper, asker: r.asker, referee: r.referee, word: w, salt: r.salt, commit: r.commit, end: g.end, solvedAt: g.solvedAt, turns: g.turns, recorded: true };
  }

  function load() {
    return Promise.all([getJSON('data/words.json'), getJSON('recordings/games.json').catch(function (e) { return { error: e.message }; })]).then(async function (x) {
      app.words = x[0];
      if (x[1].error) { app.notice = 'No recorded games yet (' + x[1].error + '). Sign in to play a live one.'; return; }
      app.rec = x[1];
      for (var i = 0; i < app.rec.games.length; i++) app.played.push(await replay(app.rec.games[i]));
      // ?game=g27 opens one recorded game (a link to share a particular game).
      var want = /[?&]game=(g\d+)/.exec(location.search), linked = want && app.played.filter(function (g) { return g.id === want[1]; })[0];
      if (linked) start(linked); else deal();
    }).catch(function (e) { app.notice = 'Could not load the games: ' + e.message; });
  }

  // Unseen games first, so a returning visitor races on a word they haven't watched.
  function deal() {
    var s = store(), fresh = app.played.filter(function (g) { return s.seen.indexOf(g.id) < 0; });
    var pool = fresh.length ? fresh : app.played;
    start(pool[Math.floor(Math.random() * pool.length)]);
  }

  function start(g) {
    app.cur = { g: g, shown: 0, guesses: [], youAt: null, revealed: false, verified: null, race: g.recorded || g.race };
    render();
  }

  // ---------- the race ----------
  function askerWonAt(c) { return c.g.end === 'solved' && c.shown >= c.g.solvedAt ? c.g.solvedAt : null; }
  function over(c) { return c.g.recorded ? c.shown >= c.g.turns.length : !app.busy && c.shown >= c.g.turns.length; }

  function nextTurn(ev) {
    var c = app.cur; if (!ev.isTrusted || !c || c.revealed || !c.g.recorded || c.shown >= c.g.turns.length) return;
    c.shown++;
    if (over(c)) reveal();
    render();
  }

  function guess(ev) {
    ev.preventDefault();
    var c = app.cur, box = $('guessbox'), v = box.value.trim();
    if (!ev.isTrusted || !c || c.revealed || !c.race || !v || c.youAt != null || c.guesses.length >= 3 || askerWonAt(c)) return;
    var right = G.judge(v, c.g.word.word, c.g.word.aliases);
    c.guesses.push({ text: v, right: right, at: c.shown });
    if (right) c.youAt = c.shown;
    box.value = '';
    if (right && c.g.recorded) { c.shown = c.g.turns.length; reveal(); }
    render();
  }

  function forfeit(ev) { var c = app.cur; if (!ev.isTrusted || !c || c.revealed || (!c.g.recorded && app.busy)) return; c.forfeit = true; if (c.g.recorded) c.shown = c.g.turns.length; reveal(); render(); }

  function reveal() {
    var c = app.cur; if (c.revealed) return;
    c.revealed = true;
    sha256(c.g.salt + ':' + c.g.word.word).then(function (x) { c.verified = x === c.g.commit; render(); });
    if (!c.race || c.counted) return;
    c.counted = true;
    var s = store();
    if (c.g.recorded && s.seen.indexOf(c.g.id) < 0) s.seen.push(c.g.id);
    if (!c.forfeit) {
      s.races++;
      var a = c.g.end === 'solved' ? c.g.solvedAt : Infinity, y = c.youAt != null ? c.youAt : Infinity;
      if (y === Infinity && a === Infinity) s.neither++; else if (y < a) s.you++; else s.asker++;
    }
    save(s);
  }

  // ---------- rendering the game ----------
  function renderGame() {
    var c = app.cur, box = $('game');
    $('play').hidden = !c;
    if (!c) return;
    var g = c.g;
    $('gamemeta').textContent = (g.recorded ? g.id + ' · ' : '') + 'Keeper: ' + short(g.keeper) + ' · Asker: ' + short(g.asker) + ' · Referee: ' + short(g.referee) + (g.recorded ? ' · recorded ' + (app.rec.recordedAt || '').slice(0, 10) : ' · live, just now');
    $('commit').textContent = 'Sealed word: sha256(salt + ":" + word) = ' + g.commit;
    box.textContent = '';
    g.turns.slice(0, c.shown).forEach(function (t, i) {
      var li = h('li', 'turn' + (t.right ? ' won' : ''));
      li.appendChild(h('span', 'tn', String(i + 1)));
      var body = h('div', 'tb');
      var line = h('p', 'tq');
      if (!t.q) line.textContent = '— ' + (t.ask && (t.ask.error || (t.ask.capped ? 'spend limit' : 'stopped')));
      else if (t.q.kind === 'invalid') { line.appendChild(h('span', 'bad', 'not a Q or GUESS line: ')); line.appendChild(document.createTextNode(t.q.text)); }
      else { line.appendChild(h('span', 'tag', t.q.kind === 'Q' ? 'Q' : 'GUESS')); line.appendChild(document.createTextNode(' ' + t.q.text)); }
      body.appendChild(line);
      var a = h('p', 'ta');
      if (t.q && t.q.kind === 'GUESS') a.appendChild(h('span', t.right ? 'ans yes' : 'ans no', t.right ? 'right' : 'wrong guess'));
      else if (t.keep && t.keep.error) a.appendChild(h('span', 'ans bad', t.keep.error));
      else if (t.k) {
        a.appendChild(h('span', 'ans ' + t.k, t.k === 'invalid' ? 'no valid answer' : t.k));
        if (c.revealed && t.verdict) { var chip = h('span', 'chip ' + t.verdict, (t.verdict === 'unclear' ? 'unchecked' : t.verdict) + (t.verdict === 'agreed' ? '' : ' · referee ' + t.r + (t.rc ? ' · fresh ' + t.rc : ''))); chip.title = VERDICT[t.verdict]; a.appendChild(chip); }
      }
      if (a.childNodes.length) body.appendChild(a);
      if (c.revealed) body.appendChild(requestDetails(t));
      li.appendChild(body);
      box.appendChild(li);
    });
    if (!g.recorded && app.busy) box.appendChild(h('li', 'turn waiting', 'Turn ' + (g.turns.length + 1) + '…'));

    var won = askerWonAt(c);
    $('nextturn').hidden = !g.recorded || c.revealed;
    $('nextturn').disabled = c.shown >= g.turns.length;
    $('nextturn').textContent = c.shown === g.turns.length - 1 ? 'Last turn · reveals the word' : 'Next turn';
    var canGuess = c.race && !c.revealed && c.youAt == null && c.guesses.length < 3 && !won;
    $('guessform').hidden = !c.race || c.revealed;
    $('guessbox').disabled = $('guessbtn').disabled = !canGuess;
    $('forfeit').hidden = c.revealed;
    $('guesses').textContent = c.race && !c.revealed ? (c.guesses.length ? 'Your guesses: ' + c.guesses.map(function (x) { return x.text + (x.right ? ' ✓' : ' ✗') + ' (after turn ' + x.at + ')'; }).join(', ') + ' · ' : '') + (3 - c.guesses.length) + ' left' + (won ? ' · the Asker got there first' : '') : '';
    $('racehint').textContent = c.revealed ? '' : c.race ? 'Race the Asker: read its questions and the Keeper\'s answers, and guess the word before its winning GUESS shows up. Three guesses, judged by the same code.' : 'You picked the word, so this one is not a race.';

    var out = $('outcome'); out.textContent = '';
    if (c.revealed) {
      var p = h('p', 'big');
      p.appendChild(document.createTextNode('The word was "' + g.word.word + '". '));
      p.appendChild(h('span', g.end === 'solved' ? 'ok' : 'no', 'Asker: ' + END[g.end] + (g.solvedAt ? ' on turn ' + g.solvedAt : '') + '.'));
      if (c.race && !c.forfeit) p.appendChild(h('span', c.youAt != null ? 'ok' : 'no', ' You: ' + (c.youAt != null ? 'right after ' + c.youAt + ' turn' + (c.youAt === 1 ? '' : 's') + (g.solvedAt == null || c.youAt < g.solvedAt ? ', ahead of the Asker.' : '.') : 'not found.')));
      out.appendChild(p);
      out.appendChild(h('p', c.verified === false ? 'no' : 'fine', 'Salt ' + g.salt + ' · hash recomputed in your browser: ' + (c.verified == null ? 'checking…' : c.verified ? 'matches the sealed hash' : 'DOES NOT MATCH') + '. The hash shows the word did not change after turn 1; on a static page you could still have peeked at the files.'));
      var k = g.turns.filter(function (t) { return t.verdict; }), n = function (v) { return k.filter(function (t) { return t.verdict === v; }).length; };
      if (k.length) out.appendChild(h('p', null, 'The Keeper\'s ' + k.length + ' answers, each re-asked without history: ' + n('agreed') + ' agreed, ' + n('split') + ' split, ' + n('flagged') + ' flagged, ' + n('unclear') + ' unchecked.'));
      var again = h('button', 'primary', app.played.length ? 'Another recorded game' : 'Close'); again.type = 'button';
      again.addEventListener('click', function () { if (app.played.length) deal(); });
      out.appendChild(again);
    }
  }

  function requestDetails(t) {
    var d = h('details', 'req'); d.appendChild(h('summary', null, 'requests'));
    ['ask', 'keep', 'ref', 'recheck'].forEach(function (role) {
      var call = t[role]; if (!call || !call.request) return;
      var r = call.request, u = call.usage || {};
      var lines = ['# ' + { ask: 'Asker', keep: 'Keeper', ref: 'Referee (Keeper prompt, this question only)', recheck: 'Keeper\'s model asked fresh' }[role] + ' · ' + r.model,
        'max_tokens ' + r.max_tokens + (r.reasoning_effort ? ' · reasoning_effort ' + r.reasoning_effort : '') + ' · seed ' + r.seed + (r.messagesSha ? ' · messages sha256 ' + r.messagesSha.slice(0, 16) + '…' : '')];
      if (call.usage) lines.push('tokens: ' + (u.in != null ? u.in : u.prompt_tokens) + ' in, ' + (u.out != null ? u.out : u.completion_tokens) + ' out' + (u.reasoning ? ' (' + u.reasoning + ' reasoning)' : '') + (call.cost ? ' · ' + fmtP(call.cost) : '') + (call.ms ? ' · ' + (call.ms / 1000).toFixed(1) + ' s' : ''));
      var msgs = (t.msgs && t.msgs[role]) || r.messages;
      if (msgs) { var last = msgs[msgs.length - 1]; lines.push('last message (' + msgs.length + ' in all): ' + last.role + ': ' + last.content); }
      lines.push('reply: ' + (call.error ? 'ERROR ' + call.error : JSON.stringify(call.raw)));
      d.appendChild(h('pre', 'prompt', lines.join('\n')));
    });
    return d;
  }

  // ---------- results ----------
  function renderResults() {
    var box = $('results'); box.textContent = '';
    if (!app.played.length) { box.appendChild(h('p', 'hint', 'No recorded games loaded.')); return; }
    var S = G.stats(app.played), ids = app.rec.models.map(function (m) { return m.id; });
    var t = h('table', 'grid'), hd = h('tr');
    hd.appendChild(h('th', null, 'Keeper ↓ · Asker →'));
    ids.forEach(function (a) { hd.appendChild(h('th', null, short(a))); });
    t.appendChild(hd);
    ids.forEach(function (k) {
      var tr = h('tr'); tr.appendChild(h('th', null, short(k)));
      ids.forEach(function (a) { var r = S.pair[k + '|' + a]; tr.appendChild(h('td', r && r.solved ? 'hit' : '', r ? r.solved + '/' + r.games : '–')); });
      t.appendChild(tr);
    });
    box.appendChild(h('h3', null, 'Words solved, Keeper × Asker'));
    box.appendChild(t);

    var ta = h('table', 'stats'), ha = h('tr');
    ['Asker', 'solved', 'mean turns when solved', 'wrong guesses', 'format faults'].forEach(function (x) { ha.appendChild(h('th', null, x)); });
    ta.appendChild(ha);
    ids.forEach(function (a) {
      var r = S.asker[a]; if (!r) return;
      var tr = h('tr');
      [short(a) + (modelInfo(a).reasoning ? ' (reasoning)' : ''), r.solved + '/' + r.games, r.solved ? (r.turns / r.solved).toFixed(1) : '–', r.wrong, r.invalid].forEach(function (x) { tr.appendChild(h('td', null, String(x))); });
      ta.appendChild(tr);
    });
    box.appendChild(h('h3', null, 'Askers'));
    box.appendChild(ta);

    var tk = h('table', 'stats'), hk = h('tr');
    ['Keeper', 'answers', 'agreed', 'split', 'flagged', 'unchecked', 'unparseable'].forEach(function (x) { hk.appendChild(h('th', null, x)); });
    tk.appendChild(hk);
    ids.forEach(function (k) {
      var r = S.keeper[k]; if (!r) return;
      var tr = h('tr');
      [short(k), r.answers, r.agreed, r.split, r.flagged, r.unclear, r.badAnswers].forEach(function (x, i) { tr.appendChild(h('td', i === 4 && x ? 'flag' : null, String(x))); });
      tk.appendChild(tr);
    });
    box.appendChild(h('h3', null, 'Keepers, every answer re-asked without history'));
    box.appendChild(tk);
    box.appendChild(h('p', 'fine', 'Recomputed in your browser from ' + app.played.length + ' recorded games (' + app.played.filter(function (g) { return g.end === 'error' || g.end === 'cap'; }).length + ' ended by an error). "Flagged" means two independent checks went the other way, not that the Keeper lied; some questions really can go either way. Open a game to see each one.'));
    var s = store();
    if (s.races) box.appendChild(h('p', null, 'You against the Asker in this browser: ' + s.races + ' race' + (s.races === 1 ? '' : 's') + ', you first ' + s.you + ', the Asker first ' + s.asker + ', neither ' + s.neither + '.'));
  }
  function modelInfo(id) { return (app.rec && app.rec.models.filter(function (m) { return m.id === id; })[0]) || app.byId[id] || {}; }

  // ---------- sign-in and live games ----------
  function readKey(c, e) {
    var k = (c && c.apiKey) || (e && e.detail && (e.detail.apiKey || e.detail.key)) || null;
    return typeof k === 'string' && k ? k : null;
  }
  function wireConnect() {
    var c = $('connect');
    c.setAttribute('app-key', C.APP_KEY);
    Promise.race([customElements.whenDefined('polli-connect'), new Promise(function (r) { setTimeout(r, 8000); })]).then(function () {
      if (!customElements.get('polli-connect')) { c.hidden = true; $('connect-fallback').hidden = false; }
      onKey(readKey(c));
    });
    c.addEventListener('change', function (e) { onKey(readKey(c, e)); });
  }
  function onKey(k) {
    if (k === app.key) return;
    app.key = k;
    if (!k && app.ctrl) { app.stopAsked = true; app.ctrl.abort(); }
    render();
  }
  function loadModels() {
    return N.listModels().then(function (list) {
      app.models = list.filter(function (m) { return !m.paidOnly; });
      app.byId = {}; list.forEach(function (m) { app.byId[m.id] = m; });
    }).catch(function (e) { app.modelsError = e.message; });
  }

  function worst(m, maxTokens) { return C.WORST_IN_TOKENS * m.inPrice + maxTokens * m.outPrice; }

  function liveSeat(m, game, role) {
    return function (messages, i) {
      if (app.stopAsked) return Promise.resolve({ cancelled: true });
      var maxT = m.effort ? 1500 : 100;
      if (app.capSpent + worst(m, maxT) > C.MAX_SPEND) return Promise.resolve({ capped: true });
      // Reserve the worst case while the call runs; settle to the real cost after.
      app.capSpent += worst(m, maxT);
      return N.ask(app.key, m, messages, app.ctrl.signal).then(function (r) {
        app.capSpent -= worst(m, maxT);
        app.capSpent += r.cost != null ? r.cost : worst(m, maxT);
        if (r.cost) app.spent += r.cost;
        if (r.status === 402) app.notice = 'Out of Pollen: ' + r.error;
        var call = { request: r.request, usage: r.usage && { in: r.usage.prompt_tokens, out: r.usage.completion_tokens, reasoning: r.usage.completion_tokens_details && r.usage.completion_tokens_details.reasoning_tokens }, cost: r.cost, ms: r.ms };
        if (r.cancelled) call.cancelled = true; else if (r.error) call.error = r.error; else call.raw = r.text;
        return call;
      });
    };
  }

  async function playLive(ev) {
    if (!ev.isTrusted || app.busy || !app.key) return;
    var keeper = app.byId[app.keeper], asker = app.byId[app.asker];
    if (!keeper || !asker || keeper.paidOnly || asker.paidOnly) return;
    var refId = app.keeper === C.REFEREE ? C.REFEREE_ALT : C.REFEREE, referee = app.byId[refId];
    if (!referee) { app.notice = 'The referee model ' + refId + ' is not available right now.'; render(); return; }
    var w = app.wordPick ? wordOf(app.wordPick) : app.words[Math.floor(Math.random() * app.words.length)];
    var salt = randomHex(16);
    var g = { id: 'live', keeper: keeper.id, asker: asker.id, referee: referee.id, word: w, salt: salt, commit: await sha256(salt + ':' + w.word), turns: [], end: null, solvedAt: null, recorded: false, race: !app.wordPick };
    app.busy = true; app.stopAsked = false; app.ctrl = new AbortController(); app.capSpent = 0; app.notice = '';
    start(g);
    var seats = { ask: liveSeat(asker, g, 'ask'), keep: liveSeat(keeper, g, 'keep'), ref: liveSeat(referee, g, 'ref'), recheck: liveSeat(keeper, g, 'recheck') };
    var msgs = [];
    function keepMsgs(role) { return function (m, i) { (msgs[i] = msgs[i] || {})[role] = m; return seats[role](m, i); }; }
    var res = await G.play(w.word, w.aliases, { ask: keepMsgs('ask'), keep: keepMsgs('keep'), ref: keepMsgs('ref'), recheck: keepMsgs('recheck') }, function (t, game) {
      t.msgs = msgs[game.turns.length - 1];
      g.turns = game.turns.slice(); app.cur.shown = g.turns.length; render();
    });
    res.turns.forEach(function (t, i) { t.msgs = msgs[i]; });
    g.turns = res.turns; g.end = res.end; g.solvedAt = res.solvedAt;
    app.busy = false; app.ctrl = null;
    if (app.cur && app.cur.g === g) { app.cur.shown = g.turns.length; reveal(); }
    if (res.end === 'cap' && !app.notice) app.notice = 'Stopped before a call that could take this game past ' + C.MAX_SPEND + ' Pollen.';
    render();
  }

  function stop(ev) { if (!ev.isTrusted || !app.busy) return; app.stopAsked = true; if (app.ctrl) app.ctrl.abort(); }

  function select(label, value, onChange, options) {
    var wrap = h('label', 'field'); wrap.appendChild(h('span', null, label));
    var s = h('select'); s.disabled = app.busy;
    options.forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; op.selected = o[0] === value; s.appendChild(op); });
    s.addEventListener('change', function () { onChange(s.value); render(); });
    wrap.appendChild(s); return wrap;
  }

  function renderLive() {
    var box = $('livebody'); box.textContent = '';
    if (!app.key) { box.appendChild(h('p', 'hint', 'Sign in with Pollinations to seat any two free models and play a new game, paid with your own Pollen: about 0.004 Pollen a game, and it stops itself at ' + C.MAX_SPEND + '.')); return; }
    if (!app.models.length) { box.appendChild(h('p', app.modelsError ? 'hint warn' : 'hint', app.modelsError ? 'Could not load the model list: ' + app.modelsError : 'Loading the model list…')); return; }
    // A default that is down today falls back to the first free model, so Play never silently does nothing.
    if (!app.byId[app.keeper] || app.byId[app.keeper].paidOnly) app.keeper = app.models[0].id;
    if (!app.byId[app.asker] || app.byId[app.asker].paidOnly) app.asker = app.models[0].id;
    var opts = app.models.map(function (m) { return [m.id, m.title + (m.effort ? ' (reasoning)' : '')]; });
    var row = h('div', 'liverow');
    row.appendChild(select('Keeper', app.keeper, function (v) { app.keeper = v; }, opts));
    row.appendChild(select('Asker', app.asker, function (v) { app.asker = v; }, opts));
    row.appendChild(select('Word', app.wordPick, function (v) { app.wordPick = v; }, [['', 'Surprise me (you race the Asker)']].concat(app.words.map(function (w) { return [w.id, w.word]; }))));
    box.appendChild(row);
    var go = h('div', 'liverow');
    if (app.busy) { var sb = h('button', 'stop', 'Stop'); sb.type = 'button'; sb.addEventListener('click', stop); go.appendChild(sb); }
    else { var b = h('button', 'primary', 'Play a live game · up to 20 turns'); b.type = 'button'; b.addEventListener('click', playLive); go.appendChild(b); }
    box.appendChild(go);
    box.appendChild(h('p', 'fine', 'Each turn is one Asker call, then the Keeper and the referee (' + short(C.REFEREE) + ') in parallel, plus one fresh call to the Keeper\'s model when they split. A failed Asker or Keeper call ends the game with its real error; a failed referee call leaves that answer unchecked. A 20-turn game takes a few minutes.'));
  }

  function renderStatic() {
    $('prompts').textContent = 'Keeper (also the referee and the fresh re-ask, with only the one question):\n' + G.KEEPER + '\n\nAsker:\n' + G.ASKER;
    $('src').href = C.REPO_URL;
  }

  function render() {
    $('facts').textContent = app.rec ? app.played.length + ' recorded games · ' + app.rec.models.length + ' free models as Keeper and Asker · recorded ' + app.rec.recordedAt.slice(0, 10) + ' · replays cost nothing' : '';
    $('notice').textContent = app.notice;
    var sp = $('spent'); sp.hidden = !app.spent; sp.textContent = 'spent ' + fmtP(app.spent);
    renderGame(); renderResults(); renderLive();
  }

  $('nextturn').addEventListener('click', nextTurn);
  $('guessform').addEventListener('submit', guess);
  $('forfeit').addEventListener('click', forfeit);
  renderStatic();
  wireConnect();
  render();
  load().then(render);
  loadModels().then(render);
})();
