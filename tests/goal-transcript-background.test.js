const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function harness({ empty = false, cid = 88, page = 1, modern = false } = {}) {
  const requests = [];
  const listeners = [];
  const event = { addListener() {} };
  const context = vm.createContext({
    console, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams,
    AbortController, setTimeout, clearTimeout,
    chrome: {
      storage: { local: {
        setAccessLevel: async () => {},
        get: async () => { throw new Error('Goal must not read keys'); },
      } },
      action: { onClicked: event },
      sidePanel: { setPanelBehavior() {} },
      tabs: { onUpdated: event, onActivated: event },
      runtime: { onInstalled: event, onMessage: { addListener(fn) { listeners.push(fn); } } },
    },
    fetch: async (url, options) => {
      requests.push({ url: String(url), method: options?.method || 'GET' });
      const json = data => ({ ok: true, status: 200, json: async () => data });
      if (url.includes('/x/web-interface/view')) return json({ code: 0, data: {
        bvid: 'BV1234567890', aid: 99, pages: [{ cid: 88 }, { cid: 99 }],
      } });
      if (url.includes('/x/player/wbi/v2')) return json({ code: 0, data: {
        bvid: 'BV1234567890', cid, subtitle: { subtitles: empty || modern ? [] : [
          { id: 7, lan: 'zh-CN', subtitle_url: 'https://subtitle.hdslb.com/test.json', type: 0 },
        ] },
      } });
      if (url.includes('/x/v2/subtitle/web/view')) {
        const body = { code: 0, data: { subtitles: empty ? [] : [
          { id: 8, lan: 'ai-zh', subtitle_url: 'https://subtitle.hdslb.com/test.json', type: 1 },
        ] } };
        return { ok: true, status: 200, headers: { get: () => 'application/json' },
          arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer };
      }
      if (url === 'https://subtitle.hdslb.com/test.json') return json({ body: [
        { from: 1.125, to: 3.875, content: '真实  字幕证据' },
      ] });
      throw new Error('Unexpected network/AI/ASR destination: ' + url);
    },
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  const send = (overrides = {}) => new Promise(resolve => {
    assert.equal(listeners[0]({ action: 'fetchGoalTranscript', bvid: 'BV1234567890', page, cid, ...overrides }, {}, resolve), true);
  });
  return { send, requests };
}

test('Goal background message returns original snapshot without reading keys or calling AI/ASR', async () => {
  const { send, requests } = harness();
  const result = await send();
  assert.equal(result.success, true);
  assert.equal(result.snapshot.video.cid, '88');
  assert.equal(result.snapshot.video.page, 1);
  assert.equal(result.snapshot.video.sourceType, 'manual');
  assert.deepEqual(Array.from(result.snapshot.cues, c => [c.start, c.end, c.text]), [[1.125, 3.875, '真实  字幕证据']]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(r => r.method === 'GET' && !/deepseek|aliyun|chat\/completions/.test(r.url)));
});

test('Goal modern subtitle fallback preserves source and exact evidence', async () => {
  const { send } = harness({ modern: true });
  const result = await send();
  assert.equal(result.success, true);
  assert.equal(result.snapshot.video.sourceType, 'bilibili-ai');
  assert.equal(result.snapshot.cues[0].end, 3.875);
});

test('Goal empty subtitles never fall back to ASR even without settings access', async () => {
  const { send, requests } = harness({ empty: true });
  const result = await send();
  assert.equal(result.success, false);
  assert.equal(result.error, 'NO_TRANSCRIPT');
  assert.equal(requests.length, 3);
});

test('Goal part 2 uses its own CID and rejects stale expected CID', async () => {
  const { send, requests } = harness({ cid: 99, page: 2 });
  const result = await send();
  assert.equal(result.success, true);
  assert.equal(result.snapshot.video.cid, '99');
  assert.equal(result.snapshot.video.page, 2);
  assert.ok(requests.some(r => r.url.includes('cid=99')));
  assert.equal((await send({ cid: 88 })).error, 'VIDEO_IDENTITY_MISMATCH');
});

test('Goal invalid part cannot silently receive part 1 evidence', async () => {
  const { send, requests } = harness({ page: 3 });
  const result = await send();
  assert.equal(result.success, false);
  assert.equal(requests.length, 1);
});

test('Goal rejects invalid explicit pages and conflicting URL part identity', async () => {
  const { send, requests } = harness({ cid: 99 });
  for (const page of [0, -1, 1.5, '2']) {
    assert.equal((await send({ page })).error, 'INVALID_VIDEO_PAGE');
  }
  assert.equal(requests.length, 0);
  const result = await send({ videoUrl: 'https://www.bilibili.com/video/BV1234567890?p=2' });
  assert.equal(result.error, 'VIDEO_IDENTITY_MISMATCH');
});
