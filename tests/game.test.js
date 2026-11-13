const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const G = require('../js/game.js');
const words = require('../data/words.json');

test('parseAsk takes the first Q or GUESS line', () => {
  assert.deepEqual(G.parseAsk('Q: Is it alive?'), { kind: 'Q', text: 'Is it alive?' });
  assert.deepEqual(G.parseAsk('guess:  Penguin '), { kind: 'GUESS', text: 'Penguin' });
  assert.deepEqual(G.parseAsk('Thinking...\n**Q:** Is it big?'), { kind: 'Q', text: 'Is it big?' });
  assert.equal(G.parseAsk('GUESS: owl\nQ: Is it?').kind, 'GUESS');
  assert.equal(G.parseAsk('Is it an animal?').kind, 'invalid');
  assert.equal(G.parseAsk('x'.repeat(300)).text.length, 200);
});

test('parseAnswer accepts one leading word only', () => {
  assert.equal(G.parseAnswer('Yes.'), 'yes');
  assert.equal(G.parseAnswer(' yes, it is'), 'yes');
  assert.equal(G.parseAnswer('No'), 'no');
  assert.equal(G.parseAnswer('unclear'), 'unclear');
  assert.equal(G.parseAnswer('maybe'), 'invalid');
  assert.equal(G.parseAnswer('The answer is yes'), 'invalid');
  assert.equal(G.parseAnswer('yesterday'), 'invalid');
});

test('judge: articles, case, plurals, hyphens, aliases, diacritics; near misses lose', () => {
  assert.ok(G.judge('The Penguin', 'penguin'));
  assert.ok(G.judge('penguins', 'penguin'));
  assert.ok(G.judge('light-house', 'lighthouse'));
  assert.ok(G.judge('volcanoes', 'volcano'));
  assert.ok(G.judge('a bike', 'bicycle', ['bike']));
  assert.ok(G.judge('pìano', 'piano'));
  assert.ok(G.judge('compass', 'compass'));
  assert.ok(!G.judge('pen', 'penguin'));
  assert.ok(!G.judge('king penguin', 'penguin'));
  assert.ok(!G.judge('', 'penguin'));
});

test('classify truth table', () => {
  assert.equal(G.classify('yes', 'yes'), 'agreed');
  assert.equal(G.classify('no', 'no'), 'agreed');
  assert.equal(G.classify('yes', 'unclear'), 'unclear');
  assert.equal(G.classify('invalid', 'no'), 'unclear');
  assert.equal(G.classify('yes', 'no', 'yes'), 'split');
  assert.equal(G.classify('yes', 'no', 'unclear'), 'split');
  assert.equal(G.classify('yes', 'no', 'no'), 'flagged');
});

// Scripted seats: the Asker says lines from a list, the Keeper and Referee answer by a function.
function seats(lines, keep, ref, recheck, log) {
  const say = (raw) => Promise.resolve({ raw });
  return {
    ask: (m, i) => { log && log.push(['ask', m]); return say(lines[i] || 'Q: Is it big?'); },
    keep: (m, i) => { log && log.push(['keep', m]); return say(keep(m, i)); },
    ref: (m, i) => { log && log.push(['ref', m]); return say(ref ? ref(m, i) : keep(m, i)); },
    recheck: (m, i) => { log && log.push(['recheck', m]); return say(recheck ? recheck(m, i) : 'yes'); }
  };
}

test('engine: solved on turn k, a wrong guess spends a turn without a Keeper call', async () => {
  const log = [];
  const g = await G.play('owl', [], seats(['Q: Is it alive?', 'GUESS: eagle', 'GUESS: owls'], () => 'yes', null, null, log));
  assert.equal(g.end, 'solved'); assert.equal(g.solvedAt, 3);
  assert.equal(log.filter((x) => x[0] === 'keep').length, 1);
  const lastAsk = log.filter((x) => x[0] === 'ask').pop()[1];
  assert.equal(lastAsk.at(-1).content, 'Wrong guess. Turn 3 of 20.');
  assert.equal(lastAsk.at(-2).content, 'GUESS: eagle');
});

test('engine: 20 turns unsolved, last-turn warning, invalid lines spend a turn', async () => {
  const log = [];
  const g = await G.play('owl', [], seats(['hello'], () => 'no', null, null, log));
  assert.equal(g.end, 'unsolved'); assert.equal(g.turns.length, 20);
  assert.equal(g.turns[0].q.kind, 'invalid');
  const asks = log.filter((x) => x[0] === 'ask');
  assert.equal(asks.length, 20);
  assert.match(asks[1][1].at(-1).content, /^Invalid format/);
  assert.match(asks[19][1].at(-1).content, /Turn 20 of 20\. This is your last turn: make a GUESS\.$/);
});

test('engine: recheck only on a yes/no split; flagged needs both checks against the Keeper', async () => {
  const log = [];
  const g = await G.play('owl', [], seats(['Q: a?', 'Q: b?', 'Q: c?', 'GUESS: owl'],
    (m, i) => ['yes', 'yes', 'yes'][i], (m, i) => ['yes', 'no', 'no'][i], (m, i) => ['-', 'yes', 'no'][i], log));
  assert.deepEqual(g.turns.slice(0, 3).map((t) => t.verdict), ['agreed', 'split', 'flagged']);
  assert.equal(log.filter((x) => x[0] === 'recheck').length, 2);
  // Referee and recheck get the Keeper prompt and that one question, nothing else.
  for (const [role, m] of log.filter((x) => x[0] === 'ref' || x[0] === 'recheck')) {
    assert.equal(m.length, 2, role); assert.equal(m[0].content, G.keeperSystem('owl'));
  }
});

test('engine: the secret never reaches the Asker; a cap or error ends the game before more calls', async () => {
  const log = [];
  await G.play('owl', [], seats(['Q: Is it an owl?', 'GUESS: owl'], () => 'yes owl', null, null, log));
  const askerText = log.filter((x) => x[0] === 'ask').pop()[1].map((x) => x.content).join('\n');
  assert.ok(!askerText.includes('yes owl'));
  let n = 0;
  const capped = await G.play('owl', [], { ask: async () => (n++ ? { capped: true } : { raw: 'GUESS: cat' }), keep: async () => ({ raw: 'no' }), ref: async () => ({ raw: 'no' }), recheck: async () => ({ raw: 'no' }) });
  assert.equal(capped.end, 'cap'); assert.equal(capped.turns.length, 2);
  const err = await G.play('owl', [], { ask: async () => ({ raw: 'Q: big?' }), keep: async () => ({ error: 'HTTP 500' }), ref: async () => ({ raw: 'no' }), recheck: async () => ({ raw: 'no' }) });
  assert.equal(err.end, 'error'); assert.equal(err.turns.length, 1);
});

test('commit vector, words list, schedule', () => {
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  assert.equal(sha('00:owl'), 'ce3f940dde8b70e799574f9639d41878873f371e18ddfb3e629af8a857bab406');
  assert.notEqual(sha('00:owl'), sha('00:owls'));
  const seen = new Set();
  for (const w of words) for (const x of [w.word, ...w.aliases]) { const n = G.norm(x); assert.ok(!seen.has(n), x); seen.add(n); }
  assert.equal(words.length, 24);
  const s = G.schedule(['a', 'b', 'c', 'd'], 8);
  assert.equal(s.length, 32);
  for (const m of ['a', 'b', 'c', 'd']) {
    assert.deepEqual(s.filter((x) => x.asker === m).map((x) => x.word).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(s.filter((x) => x.keeper === m).map((x) => x.word).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  }
});

test('stats on a small fixture', () => {
  const games = [
    { keeper: 'k', asker: 'a', end: 'solved', solvedAt: 4, turns: [{ q: { kind: 'Q' }, k: 'yes', verdict: 'agreed' }, { q: { kind: 'GUESS' } }, { q: { kind: 'invalid' } }, { q: { kind: 'GUESS' }, right: true }] },
    { keeper: 'k', asker: 'a', end: 'unsolved', solvedAt: null, turns: [{ q: { kind: 'Q' }, k: 'no', verdict: 'flagged' }] }
  ];
  const s = G.stats(games);
  assert.deepEqual([s.asker.a.games, s.asker.a.solved, s.asker.a.turns, s.asker.a.wrong, s.asker.a.invalid], [2, 1, 4, 1, 1]);
  assert.deepEqual([s.keeper.k.answers, s.keeper.k.agreed, s.keeper.k.flagged], [2, 1, 1]);
  assert.equal(s.pair['k|a'].solved, 1);
});
