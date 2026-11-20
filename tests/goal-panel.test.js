const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../goal/transcript-index.js');
const N = require('../goal/navigator.js');
const C = require('../goal/cache.js');
const UI = require('../goal/controller.js');
const View = require('../goal/view.js');
function storage() {
  const data = {};
  return { data, get: async key => key == null ? { ...data } : { [key]: data[key] },
    set: async value => Object.assign(data, value), remove: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(key => delete data[key]) };
}
async function fixture({ hasKey = false, modelResult, snapshot: given } = {}) {
  const snapshot = given || await E.createSnapshot({ video: { bvid: 'BV1234567890', cid: 88, page: 1 }, language: 'zh-CN', sourceType: 'manual',
    cues: [{ start: 1.125, end: 4.875, text: '缓存的操作方法是使用过期时间。' }, { start: 100, end: 108, text: '缓存前提是理解一致性。' }] });
  const calls = [], states = [], jumps = [], store = storage();
  let active = true, id = 0;
  const controller = UI.createController({ storage: store, onChange: s => states.push(s), isCurrent: async () => active,
    uuid: () => `request_${++id}`, seek: async payload => { jumps.push(payload); return { success: true }; },
    send: async message => {
      calls.push(message);
      if (message.action === 'fetchGoalTranscript') return { success: true, snapshot };
      if (message.action === 'checkConfig') return { hasAiKey: hasKey, aiModel: 'test-model' };
      if (modelResult) return modelResult(message);
      const recall = N.recall(snapshot, message.goal), candidates = recall.candidates;
      const ids = candidates.map(c => c.segmentId);
      const raw = { schemaVersion: 1, goalType: 'task', subgoals: [{ id: 'g1', title: '缓存操作' }],
        recommendedSegments: ids.map(segmentId => ({ segmentId, subgoalIds: ['g1'], role: 'method', reason: '提供方法。' })),
        watchOrder: [...ids].reverse(), coverage: [{ subgoalId: 'g1', status: 'partial', segmentIds: ids, reason: '当前证据仅覆盖部分。' }],
        gaps: [], searchKeywords: [{ subgoalId: 'g1', keyword: '缓存 一致性' }], limitations: [] };
      return { success: true, status: 'analyzed', requestId: message.requestId, identity: message.expectedIdentity,
        scope: recall.scope, result: N.validateResult(raw, candidates, recall.scope),
        diagnostics: { modelRequested: true, inputTokens: 123, outputTokens: 45 } };
    } });
  const context = { tabId: 7, bvid: snapshot.video.bvid, page: snapshot.video.page, title: '视频' };
  controller.setContext(context);
  return { controller, context, calls, states, jumps, store, snapshot, setActive: value => { active = value; } };
}
const aiCount = f => f.calls.filter(m => m.action === 'analyzeGoal').length;

test('no Key permits keyword retrieval and true-evidence jump with zero AI calls', async () => {
  const f = await fixture();
  await f.controller.submit('缓存');
  const state = f.controller.getState();
  assert.equal(state.phase, 'local'); assert.equal(aiCount(f), 0);
  assert.match(state.message, /关键词检索结果/);
  const segment = state.localResults[0];
  assert.equal(await f.controller.jump(segment), true);
  assert.equal(f.jumps[0].seconds, segment.start);
  assert.equal(f.jumps[0].identity.cid, '88');
  assert.ok(f.snapshot.cues.some(c => c.start === f.jumps[0].seconds));
});

test('Key mode calls analyzeGoal and renders watchOrder rather than chronological order', async () => {
  const f = await fixture({ hasKey: true });
  await f.controller.submit('缓存');
  assert.equal(aiCount(f), 1);
  const state = f.controller.getState();
  assert.equal(state.phase, 'ai');
  assert.deepEqual(View.orderedSegments(state.response).map(s => s.start), [100, 1.125]);
  assert.equal(state.diagnostics.inputTokens, 123);
  assert.equal(state.diagnostics.outputTokens, 45);
});

test('concurrent repeated clicks share pending operation, cache hit makes no new AI call', async () => {
  const f = await fixture({ hasKey: true });
  await Promise.all([f.controller.submit('缓存'), f.controller.submit('缓存')]);
  assert.equal(aiCount(f), 1);
  await f.controller.submit('缓存');
  assert.equal(aiCount(f), 1);
  assert.equal(f.controller.getState().diagnostics.cacheHit, true);
  assert.equal(f.controller.getState().diagnostics.modelRequested, false);
  assert.equal(f.controller.getState().diagnostics.inputTokens, null);
  assert.ok(Object.keys(f.store.data).every(key => !key.includes('缓存')));
});

test('late model result cannot render on another video or after clear', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ hasKey: true, modelResult: async message => { await gate; return { success: false, error: 'TIMEOUT', requestId: message.requestId }; } });
  const pending = f.controller.submit('缓存');
  while (!aiCount(f)) await new Promise(resolve => setImmediate(resolve));
  f.controller.setContext({ ...f.context, tabId: 8, bvid: 'BV0987654321' });
  release(); await pending;
  assert.equal(f.controller.getState().phase, 'idle');
  assert.equal(f.controller.getState().response, null);
  assert.equal(f.controller.getSnapshot(), null);
});

test('invalid and empty model results show recoverable feedback without auto-retry', async () => {
  for (const value of [{ success: true, status: 'analyzed', result: {} }, { success: false, error: 'INVALID_EVIDENCE' }, { success: false, error: 'EMPTY_RESPONSE' }]) {
    const f = await fixture({ hasKey: true, modelResult: async () => value });
    await f.controller.submit('缓存');
    assert.equal(f.controller.getState().phase, 'error'); assert.equal(aiCount(f), 1);
  }
});

test('local no-match is explicit; stale target cannot seek another tab', async () => {
  const f = await fixture();
  await f.controller.submit('火山喷发');
  assert.deepEqual(f.controller.getState().localResults, []);
  await f.controller.submit('缓存');
  f.setActive(false);
  assert.equal(await f.controller.jump(f.controller.getState().localResults[0]), false);
  assert.equal(f.jumps.length, 0);
});

test('cache key includes target/hash/model/analysis version and expires explicitly', async () => {
  const f = await fixture();
  const base = await C.keyFor(f.snapshot, '缓存', 'a');
  assert.notEqual(base, await C.keyFor(f.snapshot, '一致性', 'a'));
  assert.notEqual(base, await C.keyFor(f.snapshot, '缓存', 'b'));
  assert.notEqual(base, await C.keyFor({ ...f.snapshot, transcriptHash: 'changed' }, '缓存', 'a'));
  let time = 100;
  const cache = C.createCache(f.store, () => time);
  await cache.set(base, { success: true });
  time += C.TTL + 1;
  const result = await cache.get(base);
  assert.equal(result.invalidated, true); assert.equal(result.response, null);
});

test('corrupted cached evidence is revalidated and never adopted', async () => {
  const f = await fixture({ hasKey: true });
  await f.controller.submit('缓存');
  const saved = Object.values(f.store.data)[0];
  saved.response.result.recommendedSegments[0].start = 99999;
  await f.controller.submit('缓存');
  assert.equal(aiCount(f), 1); // local reconstruction replaces cached display fields
  assert.equal(View.orderedSegments(f.controller.getState().response)[1].start, 1.125);
  saved.response.result.recommendedSegments[0].segmentId = 'nonexistent';
  await f.controller.submit('缓存');
  assert.equal(aiCount(f), 2);
});

test('highlight coexists with active playback and only uses raw cue IDs', () => {
  const classes = new Set(['transcript-entry', 'active-playback']);
  const badge = { remove() {} };
  const row = { dataset: { cueIds: JSON.stringify(['cue1']) }, classList: {
    toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
    add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, contains: name => classes.has(name),
  }, querySelector: () => null, append() {}, appendChild() {} };
  const elements = new Map();
  function element() { return { style: {}, addEventListener() {}, setAttribute() {}, replaceChildren() {}, append() {}, value: '', disabled: false, querySelector: () => null }; }
  const doc = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement: () => ({ ...element(), remove() {}, textContent: '' }), querySelectorAll: () => [row] };
  const view = View.mount({ document: doc, onSubmit() {}, onClear() {}, onSettings() {}, onSeek() {} });
  view.highlight({ cues: [{ cueId: 'cue1' }] }, [{ cueIds: ['cue1'] }]);
  assert.ok(classes.has('active-playback')); assert.ok(classes.has('goal-recommended'));
  view.highlight(null, []);
  assert.ok(classes.has('active-playback')); assert.equal(classes.has('goal-recommended'), false);
});

test('context switching during asynchronous current-tab validation cannot pass the old guard', async () => {
  const f = await fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const states = [];
  const controller = UI.createController({ send: async () => { throw Error('Must not send'); }, storage: storage(),
    onChange: s => states.push(s), isCurrent: async () => { await gate; return true; }, seek: async () => ({ success: true }) });
  controller.setContext(f.context);
  const old = controller.submit('缓存');
  controller.setContext({ ...f.context, tabId: 8 });
  release(); await old;
  assert.equal(controller.getState().phase, 'idle');
  assert.equal(controller.getState().response, null);
});
