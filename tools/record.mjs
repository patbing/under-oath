// Record real games for the no-sign-in replay.
//   POLLINATIONS_KEY=sk_... node tools/record.mjs pilot maxPollen   Luna <-> Llama on the first word -> recordings/pilot.json
//   POLLINATIONS_KEY=sk_... node tools/record.mjs full  maxPollen   4x4 Keeper x Asker, 2 words each -> recordings/games.json
// Messages are not stored: the engine rebuilds them on replay and messagesSha pins them. Verdicts are not stored either.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../js/game.js');

const KEY = process.env.POLLINATIONS_KEY;
if (!KEY) { console.error('Set POLLINATIONS_KEY'); process.exit(1); }
const [mode = 'pilot', maxArg, ...redoIds] = process.argv.slice(2);
const MAX = Number(maxArg || 0.05);
const API = 'https://gen.pollinations.ai';
const MATRIX = ['openai/gpt-6-luna', 'openai/gpt-oss-20b', 'meta/llama-3.3-70b-instruct', 'mistralai/mistral-large-3'];
const REFEREE = 'nvidia/nemotron-3.5-lightning', REFEREE_ALT = 'z-ai/glm-5.3-flash';

const words = JSON.parse(readFileSync(new URL('../data/words.json', import.meta.url), 'utf8'));
const list = (await (await fetch(API + '/v1/models')).json()).data;
const info = Object.fromEntries(list.map((m) => [m.id, m]));
for (const id of [...MATRIX, REFEREE, REFEREE_ALT]) {
  if (!info[id]) { console.error('unknown model: ' + id); process.exit(1); }
  if (info[id].paid_only) { console.error('paid-only model refused: ' + id); process.exit(1); }
}
const model = (id) => ({ id, effort: (info[id].supported_parameters || []).includes('reasoning_effort'), in: Number(info[id].pricing.promptTextTokens), out: Number(info[id].pricing.completionTextTokens) });
const sha = (s) => createHash('sha256').update(s).digest('hex');

let spent = 0, capped = false, calls = 0;
// Worst case for one call: a long history in, max_tokens out. Failed calls can still be billed.
const worst = (m) => 2500 * m.in + (m.effort ? 1500 : 100) * m.out;

async function call(m, messages) {
  if (spent + worst(m) > MAX) { capped = true; return { capped: true }; }
  const body = G.request(m, messages, Math.floor(Math.random() * 2 ** 31));
  const rec = { request: { model: m.id, max_tokens: body.max_tokens, seed: body.seed, reasoning_effort: body.reasoning_effort, messagesSha: sha(JSON.stringify(messages)) } };
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    calls++;
    try {
      const res = await fetch(API + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => null);
      rec.ms = Date.now() - t0;
      if (!res.ok) {
        spent += worst(m);
        if (attempt === 0 && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        rec.error = 'HTTP ' + res.status + (j?.error?.message ? ': ' + String(j.error.message).slice(0, 200) : '');
        return rec;
      }
      const u = j.usage || {};
      const cost = (u.prompt_tokens || 0) * m.in + (u.completion_tokens || 0) * m.out;
      spent += cost;
      rec.usage = { in: u.prompt_tokens, out: u.completion_tokens, reasoning: u.completion_tokens_details?.reasoning_tokens };
      rec.cost = Number(cost.toPrecision(3));
      const text = j.choices?.[0]?.message?.content || '';
      // An empty reply is the model's answer, not a failure: the engine counts it as a format fault.
      rec.raw = text;
      return rec;
    } catch (e) { if (attempt === 1) { rec.error = String(e.message || e); rec.ms = Date.now() - t0; return rec; } }
  }
  return rec;
}

async function record(keeperId, askerId, wi, id) {
  const w = words[wi], salt = randomBytes(16).toString('hex');
  const keeper = model(keeperId), asker = model(askerId), referee = model(keeperId === REFEREE ? REFEREE_ALT : REFEREE);
  const turns = [];
  const put = (role) => async (messages, i) => { const c = await call(role === 'ask' ? asker : role === 'ref' ? referee : keeper, messages); (turns[i] = turns[i] || {})[role] = c; return c; };
  const g = await G.play(w.word, w.aliases, { ask: put('ask'), keep: put('keep'), ref: put('ref'), recheck: put('recheck') });
  const out = { id, keeper: keeperId, asker: askerId, referee: referee.id, wordId: w.id, salt, commit: sha(salt + ':' + w.word), turns };
  if (g.end === 'error' || g.end === 'cap') out.end = g.end;
  console.log(`${id} keeper ${keeperId.split('/')[1].padEnd(22)} asker ${askerId.split('/')[1].padEnd(22)} ${w.word.padEnd(11)} ${g.end}${g.solvedAt ? ' @' + g.solvedAt : ''} | ${g.turns.map((t) => t.q ? (t.q.kind === 'Q' ? t.k?.[0] + (t.verdict === 'agreed' ? '' : '!') : t.q.kind[0]) : 'x').join('')}`);
  return out;
}

//   ... node tools/record.mjs redo maxPollen g09 g10 ...   re-records those games in recordings/games.json
const schedule = G.schedule(MATRIX, 8);
const jobs = mode === 'pilot'
  ? [{ keeper: MATRIX[0], asker: MATRIX[2], word: 0 }, { keeper: MATRIX[2], asker: MATRIX[0], word: 0 }]
  : mode === 'redo' ? redoIds.map((id) => ({ ...schedule[Number(id.slice(1)) - 1], id })) : schedule;
const games = [];
let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < jobs.length) {
    const n = next++, j = jobs[n];
    games[n] = await record(j.keeper, j.asker, j.word, j.id || 'g' + String(n + 1).padStart(2, '0'));
  }
}));

const out = {
  app: 'under-oath', kind: mode, recordedAt: new Date().toISOString(),
  promptSha: { keeper: sha(G.KEEPER), asker: sha(G.ASKER) },
  models: MATRIX.map((id) => ({ id, title: info[id].title || id, reasoning: model(id).effort })),
  referee: REFEREE, refereeAlt: REFEREE_ALT, games
};
const target = new URL(mode === 'pilot' ? '../recordings/pilot.json' : '../recordings/games.json', import.meta.url);
if (mode === 'redo') {
  const old = JSON.parse(readFileSync(target, 'utf8'));
  for (const g of games) old.games[old.games.findIndex((x) => x.id === g.id)] = g;
  old.redoneAt = out.recordedAt; old.redone = games.map((g) => g.id);
  writeFileSync(target, JSON.stringify(old) + '\n');
} else writeFileSync(target, JSON.stringify(out) + '\n');

const all = games.flatMap((g) => g.turns.flatMap((t) => Object.entries(t).map(([role, c]) => ({ role, ...c, model: c.request?.model }))));
for (const id of [...new Set(all.map((c) => c.model).filter(Boolean))]) {
  const mine = all.filter((c) => c.model === id), u = mine.filter((c) => c.usage);
  const avg = (f) => u.length ? Math.round(u.reduce((a, c) => a + (f(c) || 0), 0) / u.length) : '-';
  console.log(`${id.padEnd(32)} calls ${mine.length} | in ${avg((c) => c.usage.in)} out ${avg((c) => c.usage.out)} (reasoning ${avg((c) => c.usage.reasoning)}) | errors: ${[...new Set(mine.filter((c) => c.error).map((c) => c.error.slice(0, 60)))].join(' / ') || '-'}`);
}
console.log('HTTP calls', calls, '| total cost (Pollen, failures at worst case):', spent.toFixed(6), capped ? '(cap reached)' : '');
