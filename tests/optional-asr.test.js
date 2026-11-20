const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.join(__dirname, '..');
function fixture({ key = '', tracks = false } = {}) {
  const data = { ytd_settings: { aiApiKey: 'deepseek-test', asrApiKey: key } };
  const calls = [], listeners = [], stages = [], events = {};
  let cid = 88;
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const context = vm.createContext({ console, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams,
    AbortController, setTimeout, clearTimeout,
    chrome: {
      action: { onClicked: event('action') }, sidePanel: { setPanelBehavior() {}, setOptions: async () => {} },
      tabs: { onUpdated: event('updated'), onActivated: event('activated'), onRemoved: event('removed'), get: async () => ({ url: 'https://www.bilibili.com/video/BV1234567890' }) },
      storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: data[key] }), set: async value => Object.assign(data, value) } },
      runtime: { getURL: p => 'chrome-extension://test/' + p, onInstalled: event('installed'), onMessage: { addListener(fn) { listeners.push(fn); } }, sendMessage: async () => {} },
    },
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || 'GET' });
      const json = value => ({ ok: true, status: 200, json: async () => value });
      if (url.includes('/x/web-interface/view')) return json({ code: 0, data: { bvid: 'BV1234567890', aid: 99, pages: [{ cid }] } });
      if (url.includes('/x/player/wbi/v2')) return json({ code: 0, data: { bvid: 'BV1234567890', cid, subtitle: { subtitles: tracks ? [{ lan: 'ai-zh', type: 1, subtitle_url: 'https://sub/ai' }] : [] } } });
      if (url.includes('/x/v2/subtitle/web/view')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ code: 0, data: { subtitles: tracks ? [{ lan: 'zh-CN', type: 0, subtitle_url: 'https://sub/manual' }] : [] } })).buffer };
      if (url.startsWith('https://sub/')) return json({ body: [{ from: 1.25, to: 3.75, content: url.endsWith('manual') ? '人工字幕' : 'AI字幕' }] });
      if (url === 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription') return json({ output: { task_id: 'task1' } });
      throw Error('Unexpected destination');
    },
    __stages: stages,
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  vm.runInContext(`fetchBilibiliAudioBlob = async () => { __stages.push('download'); return {}; };
    uploadAudioToBailian = async () => { __stages.push('upload'); return 'oss://test'; };
    pollBailianAsrTask = async () => ({ sentences: [{ begin_time: 1125, end_time: 3875, text: '真实转写字幕' }] });`, context);
  const send = (message, sender = { url: 'chrome-extension://test/sidepanel.html' }) => new Promise(resolve => listeners[0](message, sender, resolve));
  const prepare = () => send({ action: 'prepareAsr', tabId: 7, bvid: 'BV1234567890', page: 1 });
  return { data, calls, stages, context, send, prepare, events, setCid: value => { cid = value; } };
}

test('saved key never automatically triggers ASR from legacy subtitle fetch', async () => {
  const f = fixture({ key: 'bailian-existing' });
  const result = await f.send({ action: 'fetchTranscript', videoId: 'BV1234567890', pageNumber: 1 });
  assert.equal(result.error, 'NO_TRANSCRIPT');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  assert.deepEqual(f.stages, []);
});

test('manual track from fallback is preferred to legacy AI track', async () => {
  const f = fixture({ tracks: true });
  const response = await f.send({ action: 'fetchTranscript', videoId: 'BV1234567890', pageNumber: 1 });
  assert.equal(response.sourceType, 'manual');
  assert.equal(response.transcript[0].text, '人工字幕');
});

test('prepare/disclosure/key-save are free; only separate Start downloads/uploads/calls ASR once', async () => {
  const f = fixture();
  const prepared = await f.prepare(); assert.equal(prepared.success, true);
  const token = prepared.token;
  assert.equal((await f.send({ action: 'startAsr', token })).error, 'ASR_CONFIRMATION_REQUIRED');
  assert.equal((await f.send({ action: 'confirmAsrDisclosure', token })).hasKey, false);
  const saved = await f.send({ action: 'saveAsrKey', token, key: 'bailian-test-key' });
  assert.equal(saved.hasKey, true);
  assert.equal(f.data.ytd_settings.aiApiKey, 'deepseek-test');
  assert.deepEqual(f.stages, []); assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  const [a, b] = await Promise.all([f.send({ action: 'startAsr', token }), f.send({ action: 'startAsr', token })]);
  assert.equal(a.success, true); assert.equal(b.success, true);
  assert.deepEqual(f.stages, ['download', 'upload']);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(a.snapshot.video.sourceType, 'asr');
  assert.equal(a.snapshot.cues[0].start, 1.125); assert.equal(a.snapshot.cues[0].end, 3.875);
  const fetched = await f.send({ action: 'fetchGoalTranscript', bvid: 'BV1234567890', page: 1, tabId: 7 });
  assert.equal(fetched.success, true); assert.equal(fetched.snapshot.transcriptHash, a.snapshot.transcriptHash);
  assert.equal(f.calls.filter(c => c.url.includes('deepseek')).length, 0);
});

test('existing Key is reused without disclosure, replacement, or starting being conflated', async () => {
  const f = fixture({ key: 'existing' }); const { token } = await f.prepare();
  const confirmed = await f.send({ action: 'confirmAsrDisclosure', token });
  assert.equal(confirmed.hasKey, true); assert.equal('key' in confirmed, false);
  assert.deepEqual(f.stages, []);
  await f.send({ action: 'saveAsrKey', token, key: 'replacement' });
  assert.equal(f.data.ytd_settings.asrApiKey, 'replacement'); assert.deepEqual(f.stages, []);
});

test('navigation or changed CID prevents Start before any audio handling', async () => {
  for (const mode of ['navigation', 'cid']) {
    const f = fixture({ key: 'existing' }); const { token } = await f.prepare();
    await f.send({ action: 'confirmAsrDisclosure', token });
    if (mode === 'navigation') f.events.updated(7, { status: 'loading' }); else f.setCid(99);
    assert.equal((await f.send({ action: 'startAsr', token })).error, 'STALE_VIDEO');
    assert.deepEqual(f.stages, []);
  }
});

test('ASR failure returns reason and is not retried by duplicate Start', async () => {
  const f = fixture({ key: 'existing' }); const { token } = await f.prepare();
  await f.send({ action: 'confirmAsrDisclosure', token });
  vm.runInContext(`fetchBilibiliAudioBlob = async () => { __stages.push('download'); throw Error('音轨下载失败'); }`, f.context);
  const result = await f.send({ action: 'startAsr', token });
  assert.equal(result.error, 'ASR_FAILED'); assert.match(result.message, /下载或上传失败/);
  await f.send({ action: 'startAsr', token }); assert.deepEqual(f.stages, ['download']);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('invalid ASR boundaries are rejected rather than synthesized', () => {
  const f = fixture();
  assert.throws(() => vm.runInContext(`normalizeBailianTranscript({sentences:[{text:'bad',begin_time:100}]})`, f.context), /时间戳/);
});

test('content script context cannot start or configure ASR', async () => {
  const f = fixture({ key: 'existing' });
  const result = await f.send({ action: 'prepareAsr', tabId: 7, bvid: 'BV1234567890', page: 1 }, { tab: { id: 7 }, url: 'https://www.bilibili.com/video/BV1234567890' });
  assert.equal(result.error, 'UNTRUSTED_CONTEXT'); assert.equal(f.calls.length, 0);
});

test('UI requires disclosure then separate Start; saving/changing Key never starts transcription', () => {
  const View = require('../goal/asr-view.js');
  const nodes = new Map(), calls = [];
  const doc = { activeElement: null, getElementById(id) {
    if (!nodes.has(id)) {
      const handlers = {};
      const node = { hidden: false, disabled: false, open: false, value: '', handlers,
        addEventListener(type, fn) { handlers[type] = fn; },
        setAttribute() {}, focus() { doc.activeElement = node; },
        showModal() { node.open = true; }, close() { node.open = false; handlers.close?.(); },
      }; nodes.set(id, node);
    }
    return nodes.get(id);
  } };
  let view;
  view = View.mount({ document: doc,
    onPrepare: () => { calls.push('prepare'); view.setState({ stage: 'consent', hasKey: false }); },
    onContinue: () => { calls.push('consent'); view.setState({ stage: 'config', hasKey: false }); },
    onSaveKey: key => { calls.push('save'); assert.equal(key, 'test-key'); view.setState({ stage: 'ready', hasKey: true }); },
    onStart: () => calls.push('start'),
  });
  const click = id => nodes.get(id).handlers.click();
  view.offer(true); click('generateSubtitlesBtn');
  assert.equal(nodes.get('asrConfiguration').hidden, true);
  click('asrStart'); assert.deepEqual(calls, ['prepare']);
  click('asrContinue'); assert.deepEqual(calls, ['prepare', 'consent']);
  nodes.get('asrKeyInput').value = 'test-key';
  nodes.get('asrKeyForm').handlers.submit({ preventDefault() {} });
  assert.deepEqual(calls, ['prepare', 'consent', 'save']);
  assert.equal(nodes.get('asrKeyInput').value, '');
  assert.equal(nodes.get('asrStart').hidden, false);
  click('asrStart'); click('asrStart');
  assert.deepEqual(calls, ['prepare', 'consent', 'save', 'start']);
});

test('cache quota failure preserves successful ASR evidence and does not suggest paid retry', async () => {
  const f = fixture({ key: 'existing' }); const { token } = await f.prepare();
  await f.send({ action: 'confirmAsrDisclosure', token });
  f.context.chrome.storage.local.set = async () => { throw Error('quota'); };
  const result = await f.send({ action: 'startAsr', token });
  assert.equal(result.success, true); assert.equal(result.cacheSaved, false);
  assert.match(result.cacheWarning, /请勿因此重复转写/);
  const fetched = await f.send({ action: 'fetchGoalTranscript', bvid: 'BV1234567890', page: 1, tabId: 7 });
  assert.equal(fetched.success, true);
  assert.equal(fetched.snapshot.transcriptHash, result.snapshot.transcriptHash);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});
