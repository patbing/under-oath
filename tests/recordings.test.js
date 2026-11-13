const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const G = require('../js/game.js');
const words = require('../data/words.json');

const file = path.join(__dirname, '../recordings/games.json');
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('recordings match the prompts, verify their seals and replay request by request', { skip: !existsSync(file) && 'no recordings yet' }, async () => {
  const text = readFileSync(file, 'utf8');
  assert.ok(!/sk_[A-Za-z0-9]{6,}/.test(text), 'a secret key in the recording');
  const rec = JSON.parse(text);
  assert.equal(rec.promptSha.keeper, sha(G.KEEPER));
  assert.equal(rec.promptSha.asker, sha(G.ASKER));
  assert.ok(rec.games.length >= 16);
  const seeds = new Set(), mismatches = [];
  for (const r of rec.games) {
    const w = words.find((x) => x.id === r.wordId);
    assert.ok(w, r.id);
    assert.equal(r.commit, sha(r.salt + ':' + w.word), r.id + ' seal');
    for (const t of r.turns) for (const c of Object.values(t)) {
      assert.ok(typeof c.raw === 'string' || c.error, r.id + ' call without raw or error');
      assert.ok(!seeds.has(c.request.seed), 'repeated seed'); seeds.add(c.request.seed);
    }
    const g = await G.play(w.word, w.aliases, G.recordedSeats(r, (m) => sha(JSON.stringify(m)), mismatches));
    // Every stored call is used by the replay, and nothing the replay needs is missing.
    const used = g.turns.reduce((n, t) => n + ['ask', 'keep', 'ref', 'recheck'].filter((k) => t[k]).length, 0);
    const stored = r.turns.reduce((n, t) => n + Object.keys(t).length, 0);
    assert.equal(used, stored, r.id + ' calls used');
    if (r.end) assert.equal(g.end, r.end, r.id + ' end');
    else assert.ok(g.end === 'solved' || g.end === 'unsolved', r.id + ' ' + g.end);
  }
  assert.deepEqual(mismatches, []);
});
