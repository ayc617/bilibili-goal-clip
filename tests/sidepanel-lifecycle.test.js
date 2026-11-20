const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../sidepanel.js'), 'utf8');
function lifecycle() {
  const events = {}, contexts = [], refreshes = [];
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const context = vm.createContext({
    youtubeTabId: 7, currentVideoId: 'BV1234567890@p1', panelWindowId: 1,
    asrUiGeneration: 0, panelCheckGeneration: 0, digestGeneration: 0, translationGeneration: 0,
    asrView: { close() {}, offer() {} },
    goalController: { setContext(value) { contexts.push(value); }, flush: async () => {} },
    panelIsShowingResults: () => true, scheduleDigestRefresh: () => refreshes.push(true),
    extractVideoId: url => { try { const u = new URL(url); const id = u.pathname.match(/\/video\/(BV[A-Za-z0-9]{10})/)?.[1]; return id ? `${id}@p${Number(u.searchParams.get('p')) || 1}` : null; } catch { return null; } },
    chrome: { tabs: { onUpdated: event('updated'), onActivated: event('activated'), get: async id => ({ id, active: true, windowId: 1, url: 'https://www.bilibili.com/video/BV1234567890' }) } },
    window: { close() {} }, Promise, URL,
  });
  const block = source.slice(source.indexOf('function suspendGoalContext()'), source.indexOf('\nfunction setupEventListeners()'));
  vm.runInContext(block, context);
  return { context, contexts, refreshes, events };
}

test('same-video query changes, loading and metadata events do not invalidate Goal context', () => {
  const h = lifecycle();
  h.events.updated(7, { status: 'loading' }, { active: true, windowId: 1 });
  h.events.updated(7, { title: 'new title' }, { active: true, windowId: 1 });
  h.events.updated(7, { url: 'https://www.bilibili.com/video/BV1234567890?spm_id_from=tracking' }, { active: true, windowId: 1 });
  assert.equal(h.contexts.length, 0);
  assert.equal(h.refreshes.length, 0);
  assert.equal(h.context.digestGeneration, 0);
});

test('restore activation of same target tab preserves results and request generation', async () => {
  const h = lifecycle();
  await h.events.activated({ tabId: 7, windowId: 1 });
  vm.runInContext("handleFrontTabUrl('https://www.bilibili.com/video/BV1234567890', 7)", h.context);
  assert.equal(h.contexts.length, 0);
  assert.equal(h.context.panelCheckGeneration, 0);
  assert.equal(h.context.digestGeneration, 0);
});

test('real BV or part change invalidates the old context and schedules fresh identity detection', () => {
  for (const url of ['https://www.bilibili.com/video/BV0987654321', 'https://www.bilibili.com/video/BV1234567890?p=2']) {
    const h = lifecycle();
    h.events.updated(7, { url }, { active: true, windowId: 1 });
    assert.deepEqual(h.contexts, [null]);
    assert.equal(h.refreshes.length, 1);
    assert.equal(h.context.digestGeneration, 1);
  }
});

test('events from another browser window do not affect this panel', async () => {
  const h = lifecycle();
  await h.events.activated({ tabId: 8, windowId: 2 });
  h.events.updated(8, { url: 'https://www.bilibili.com/video/BV0987654321' }, { active: true, windowId: 2 });
  assert.equal(h.contexts.length, 0);
});

const content = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
function contentHarness(url, activeHref) {
  let listener;
  const replies = [];
  const video = { duration: 180, currentTime: 0, paused: false };
  const active = { matches: () => true, getAttribute: () => activeHref };
  const location = new URL(url);
  const context = vm.createContext({ URL, location, window: { location },
    document: { querySelector: selector => selector === 'video' ? video : active },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
  });
  vm.runInContext(content.slice(content.indexOf('function getActiveBilibiliPart()'), content.indexOf('\nfunction getBilibiliNavigationUrl()')), context);
  const start = content.indexOf('chrome.runtime.onMessage.addListener(');
  const end = content.indexOf('// DIGEST BUTTON INJECTION', start);
  vm.runInContext(content.slice(start, end), context);
  return { context, video, seek(message) { listener({ action: 'goalSeek', ...message }, {}, response => replies.push(response)); return replies.at(-1); } };
}

test('explicit URL part wins over stale DOM active part and real cue seek works', () => {
  const h = contentHarness('https://www.bilibili.com/video/BV1234567890?p=2', '/video/BV1234567890?p=1');
  assert.equal(vm.runInContext('getActiveBilibiliPart()', h.context), 2);
  assert.equal(h.seek({ bvid: 'BV1234567890', page: 2, seconds: 3.875 }).success, true);
  assert.equal(h.video.currentTime, 3.875);
  assert.equal(h.seek({ bvid: 'BV1234567890', page: 1, seconds: 3.875 }).error, 'SEEK_CONTENT_PART_MISMATCH');
});

test('collection card index or unrelated BV link cannot invent a part number', () => {
  const h = contentHarness('https://www.bilibili.com/video/BV1234567890', '/video/BV0987654321?p=9');
  assert.equal(vm.runInContext('getActiveBilibiliPart()', h.context), 1);
  assert.equal(h.seek({ bvid: 'BV0987654321', page: 1, seconds: 1 }).error, 'SEEK_CONTENT_BVID_MISMATCH');
});


test('missing URL p stays P1 even if a stale same-BV DOM link points to P2', () => {
  const h = contentHarness('https://www.bilibili.com/video/BV1234567890', '/video/BV1234567890?p=2');
  assert.equal(vm.runInContext('getActiveBilibiliPart()', h.context), 1);
  assert.equal(h.seek({ bvid: 'BV1234567890', page: 1, seconds: 1.125 }).success, true);
});
