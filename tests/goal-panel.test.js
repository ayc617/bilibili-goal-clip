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
async function fixture({ hasKey = false, modelResult, snapshot: given, store: givenStore, guard } = {}) {
  const snapshot = given || await E.createSnapshot({ video: { bvid: 'BV1234567890', cid: 88, page: 1 }, language: 'zh-CN', sourceType: 'manual',
    cues: [{ start: 1.125, end: 4.875, text: '缓存的操作方法是使用过期时间。' }, { start: 100, end: 108, text: '缓存前提是理解一致性。' }] });
  const calls = [], states = [], jumps = [], store = givenStore || storage();
  let active = true, id = 0;
  const controller = UI.createController({ storage: store, onChange: s => states.push(s), isCurrent: guard || (async () => active),
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
  const saved = Object.entries(f.store.data).find(([key]) => key.startsWith(C.PREFIX))[1];
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

test('same video/window restoration is idempotent and preserves current results and jump', async () => {
  const f = await fixture(); await f.controller.submit('缓存');
  const state = f.controller.getState();
  assert.equal(f.controller.setContext({ ...f.context }), false);
  assert.equal(f.controller.getState().phase, 'local');
  assert.deepEqual(f.controller.getState().localResults, state.localResults);
  assert.equal(await f.controller.jump(state.localResults[0]), true);
  assert.equal(aiCount(f), 0);
});

test('panel recreation restores AI order, evidence and UI state without a model call', async () => {
  const first = await fixture({ hasKey: true }); await first.controller.submit('缓存');
  first.controller.setUi({ selectedTab:'goal', scrollTop:240, expanded:['evidence-1'] }); await first.controller.flush();
  const reopened = await fixture({ hasKey:true,store:first.store }); await reopened.controller.restore();
  assert.equal(reopened.controller.getState().phase, 'ai');
  assert.deepEqual(View.orderedSegments(reopened.controller.getState().response).map(s=>s.start),[100,1.125]);
  assert.equal(aiCount(reopened),0);
  assert.equal(reopened.controller.getUi().scrollTop,240);
  assert.deepEqual(reopened.controller.getUi().expanded,['evidence-1']);
  assert.equal(await reopened.controller.jump(View.orderedSegments(reopened.controller.getState().response)[0]),true);
});

test('unsubmitted draft restores independently without saving transcript or calling AI', async () => {
  const f = await fixture(); f.controller.updateDraft('尚未提交的研究目标'); await f.controller.flush();
  const saved = Object.entries(f.store.data).find(([k])=>k.startsWith('goal_state_'))[1];
  assert.equal('snapshot' in saved,false); assert.equal('result' in saved,false); assert.equal('aiApiKey' in saved,false);
  const reopened = await fixture({store:f.store}); await reopened.controller.restore();
  assert.equal(reopened.controller.getState().goal,'尚未提交的研究目标');
  assert.equal(reopened.controller.getState().phase,'idle'); assert.equal(aiCount(reopened),0);
});

test('switch away and back restores video state; another BV/page cannot receive it', async () => {
  const f = await fixture(); await f.controller.submit('缓存'); await f.controller.flush();
  f.controller.setContext({ ...f.context,bvid:'BV0987654321',page:2 }); await f.controller.restore();
  assert.equal(f.controller.getState().goal,''); assert.equal(f.controller.getState().response,null);
  f.controller.setContext(f.context); await f.controller.restore();
  assert.equal(f.controller.getState().phase,'local'); assert.ok(f.controller.getState().localResults.length);
  assert.equal(aiCount(f),0);
});

test('changed transcript hash invalidates evidence but preserves draft', async () => {
  const f = await fixture({hasKey:true}); await f.controller.submit('缓存'); await f.controller.flush();
  const changed = await E.createSnapshot({ video:f.snapshot.video,cues:[{start:0,end:2,text:'新的缓存字幕'}] });
  const reopened = await fixture({hasKey:true,store:f.store,snapshot:changed}); await reopened.controller.restore();
  assert.equal(reopened.controller.getState().goal,'缓存'); assert.equal(reopened.controller.getState().response,null);
  assert.equal(reopened.controller.getState().diagnostics.errorCode,'SNAPSHOT_CHANGED'); assert.equal(aiCount(reopened),0);
});

test('explicit clear removes only this video state and prevents automatic restoration', async () => {
  const f = await fixture({hasKey:true}); await f.controller.submit('缓存');
  f.store.data['goal_state_BV0987654321@p1']={other:true};
  await f.controller.clear();
  const reopened=await fixture({hasKey:true,store:f.store}); await reopened.controller.restore();
  assert.equal(reopened.controller.getState().goal,''); assert.equal(reopened.controller.getState().response,null);
  assert.ok(f.store.data['goal_state_BV0987654321@p1']);
  assert.ok(Object.keys(f.store.data).some(k=>k.startsWith(C.PREFIX)));
});

test('interrupted pending analysis restores interruption message with zero new model calls', async () => {
  let release;
  const gate = new Promise(resolve=>{release=resolve});
  const first = await fixture({hasKey:true,modelResult:async()=>{await gate;return {success:false,error:'TIMEOUT'}}});
  const pending = first.controller.submit('缓存');
  while(!aiCount(first)) await new Promise(resolve=>setImmediate(resolve));
  await first.controller.flush();
  const reopened = await fixture({hasKey:true,store:first.store}); await reopened.controller.restore();
  assert.match(reopened.controller.getState().message,/上次分析中断/);
  assert.equal(aiCount(reopened),0); release(); await pending;
});

test('401 stays explicitly failed while retaining only labelled local reference; no retry', async () => {
  const f=await fixture({hasKey:true,modelResult:async()=>({success:false,error:'UNAUTHORIZED',diagnostics:{modelRequested:true}})});
  await f.controller.submit('缓存'); const state=f.controller.getState();
  assert.equal(state.phase,'error'); assert.match(state.message,/API Key 无效/);
  assert.equal(state.diagnostics.errorCode,'UNAUTHORIZED'); assert.equal(state.response,null); assert.equal(aiCount(f),1);
});

test('jump rejection exposes safe layer code without clearing a valid analysis', async () => {
  const f=await fixture({hasKey:true}); await f.controller.submit('缓存');
  f.setActive(false); await f.controller.jump(f.controller.getState().response.result.recommendedSegments[0]);
  const state=f.controller.getState(); assert.equal(state.phase,'ai'); assert.equal(state.diagnostics.seekStage,'controller');
  assert.match(state.message,/STALE_VIDEO/); assert.ok(state.response.result);
});

test('old restore waiting for tab validation cannot interrupt a new explicit submission', async () => {
  const first=await fixture();await first.controller.submit('缓存');await first.controller.flush();
  let checks=0,release;
  const gate=new Promise(resolve=>{release=resolve});
  const next=await fixture({hasKey:true,store:first.store,guard:async()=>{checks++;if(checks===1)await gate;return true}});
  const restoring=next.controller.restore();
  while(checks<1)await new Promise(resolve=>setImmediate(resolve));
  await next.controller.submit('一致性');release();await restoring;
  assert.equal(next.controller.getState().goal,'一致性');assert.equal(next.controller.getState().phase,'ai');
  assert.equal(aiCount(next),1);assert.equal(next.calls.filter(m=>m.action==='fetchGoalTranscript').length,1);
});

test('independent scroll, tab and disclosure updates merge instead of overwriting each other', async () => {
  const f=await fixture();
  f.controller.setUi({selectedTab:'notes',scrollTop:30});
  f.controller.setUi({expanded:['debug']});
  f.controller.setUi({scrollTop:99});
  assert.deepEqual(f.controller.getUi(),{selectedTab:'notes',scrollTop:99,expanded:['debug']});
  await f.controller.flush();
});

test('UI metadata retention is bounded and does not evict analysis/settings data', async () => {
  const S=require('../goal/session-state.js'), store=storage();
  store.data.ytd_settings={aiApiKey:'test-only'};store.data.goal_result_keep={result:true};
  const states=S.createStore(store);
  for(let page=1;page<=25;page++)await states.save({bvid:'BV1234567890',page},{draft:'draft',ui:{}});
  assert.equal(Object.keys(store.data).filter(k=>k.startsWith(S.PREFIX)).length,20);
  assert.equal(store.data.ytd_settings.aiApiKey,'test-only');assert.ok(store.data.goal_result_keep);
});

test('completed valid cache restores even if panel closed before loading metadata was finalized', async () => {
  const f=await fixture({hasKey:true});await f.controller.submit('缓存');await f.controller.flush();
  const entry=Object.entries(f.store.data).find(([key])=>key.startsWith('goal_state_'))[1];entry.phase='loading';
  const reopened=await fixture({hasKey:true,store:f.store});await reopened.controller.restore();
  assert.equal(reopened.controller.getState().phase,'ai');assert.equal(aiCount(reopened),0);
});
