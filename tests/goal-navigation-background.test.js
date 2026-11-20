const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../goal/transcript-index.js');
const N = require('../goal/navigator.js');
const root = path.join(__dirname, '..');
async function harness({ timeout = false } = {}) {
  const snapshot = await E.createSnapshot({ video: { bvid: 'BV1234567890', cid: 88, page: 1 },
    language: 'zh-CN', sourceType: 'manual', provider: 'bilibili-player-wbi',
    cues: [{ start: 1.125, end: 5.875, text: 'Agent 记忆需要持久化存储。' }] });
  const messages = [], events = {}, requests = [], errors = [];
  const data = { ytd_settings: { aiApiKey: 'sk-test-only' },
    'digest_BV1234567890@p1': { transcript: [{ start: 1, duration: 5, text: 'Agent 记忆需要持久化存储。' }] } };
  let url = 'https://www.bilibili.com/video/BV1234567890';
  let reply = null;
  const event = name => ({ addListener(fn) { events[name] = fn; } });
  const context = vm.createContext({ console: { ...console, error: (...args) => errors.push(args) },
    crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController,
    setTimeout: timeout ? (fn, ms) => setTimeout(fn, Math.min(ms, 5)) : setTimeout, clearTimeout,
    chrome: {
      storage: { local: { setAccessLevel: async () => {}, get: async key => ({ [key]: data[key] }), set: async value => Object.assign(data, value) } },
      action: { onClicked: event('action') }, sidePanel: { setPanelBehavior() {}, setOptions: async () => {} },
      tabs: { onUpdated: event('updated'), onActivated: event('activated'), onRemoved: event('removed'), get: async () => ({ url }) },
      runtime: { onInstalled: event('installed'), onMessage: { addListener(fn) { messages.push(fn); } }, getURL: file => `extension://${file}`, sendMessage: async () => {} },
    },
    fetch: async (destination, options) => {
      requests.push({ destination, options });
      if (String(destination).startsWith('extension://')) return { ok: true, text: async () => fs.readFileSync(path.join(root, destination.slice(12)), 'utf8') };
      const json = value => ({ ok: true, status: 200, json: async () => value });
      if (destination.includes('/x/web-interface/view')) return json({ code: 0, data: { bvid: 'BV1234567890', aid: 99, pages: [{ cid: 88 }] } });
      if (destination.includes('/x/player/wbi/v2')) return json({ code: 0, data: { bvid: 'BV1234567890', cid: 88, subtitle: { subtitles: [{ id: 1, lan: 'zh-CN', subtitle_url: 'https://subtitle.hdslb.com/test', type: 0 }] } } });
      if (destination === 'https://subtitle.hdslb.com/test') return json({ body: [{ from: 1.125, to: 5.875, content: 'Agent 记忆需要持久化存储。' }] });
      assert.equal(destination, 'https://api.deepseek.com/chat/completions');
      if (timeout) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      const body = JSON.parse(options.body);
      let value;
      if (reply) value = await reply(body);
      else {
        const input = JSON.parse(body.messages[1].content);
        const id = input.candidates[0].segmentId;
        value = { schemaVersion: 1, goalType: 'task', subgoals: [{ id: 'g1', title: '建立记忆' }],
          recommendedSegments: [{ segmentId: id, subgoalIds: ['g1'], role: 'prerequisite', reason: '先理解存储。' }],
          watchOrder: [id], coverage: [{ subgoalId: 'g1', status: 'partial', segmentIds: [id], reason: '仅提供前提。' }],
          gaps: [], searchKeywords: [], limitations: [] };
      }
      return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 321, completion_tokens: 123 }, choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }) };
    },
  });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  context.__snapshot = snapshot;
  vm.runInContext('goalSnapshots.set(7, __snapshot)', context);
  const send = message => new Promise(resolve => assert.equal(messages[0](message, {}, resolve), true));
  const goalMessage = { action: 'analyzeGoal', tabId: 7, requestId: 'test_1', goal: '如何实现 Agent 长期记忆', expectedIdentity: N.identity(snapshot) };
  return { send, requests, errors, events, goalMessage, context,
    setReply: fn => { reply = fn; }, setUrl: value => { url = value; },
    aiCalls: () => requests.filter(r => r.options?.method === 'POST') };
}

test('actual background/provider/prompt chain makes exactly one POST and deduplicates requestId', async () => {
  const h = await harness();
  const [a, b] = await Promise.all([h.send(h.goalMessage), h.send(h.goalMessage)]);
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.equal(h.aiCalls().length, 1);
  assert.equal(JSON.parse(h.aiCalls()[0].options.body).max_tokens, 4096);
  assert.equal(a.result.recommendedSegments[0].start, 1.125);
  assert.equal(h.errors.length, 0);
  assert.equal(a.diagnostics.modelRequested, true);
  assert.equal(a.diagnostics.inputTokens, 321);
  assert.equal(a.diagnostics.outputTokens, 123);
  assert.equal((await h.send({ ...h.goalMessage, goal: '其他目标' })).error, 'REQUEST_ID_REUSED');
  h.setUrl('https://www.bilibili.com/video/BV0987654321');
  assert.equal((await h.send(h.goalMessage)).error, 'STALE_VIDEO');
  assert.equal(h.aiCalls().length, 1);
});

test('fetchGoalTranscript registers the actual snapshot for subsequent analyzeGoal', async () => {
  const h = await harness();
  const fetched = await h.send({ action: 'fetchGoalTranscript', tabId: 7, bvid: 'BV1234567890', page: 1, cid: 88 });
  assert.equal(fetched.success, true);
  const analyzed = await h.send({ ...h.goalMessage, expectedIdentity: N.identity(fetched.snapshot) });
  assert.equal(analyzed.success, true);
  assert.equal(h.aiCalls().length, 1);
});

test('existing request timeout aborts Goal HTTP request without retrying', async () => {
  const h = await harness({ timeout: true });
  const result = await h.send(h.goalMessage);
  assert.equal(result.error, 'TIMEOUT');
  assert.equal(h.aiCalls().length, 1);
  assert.equal(h.errors.length, 0);
});

test('parse failure is cached as failure, not retried automatically', async () => {
  const h = await harness(); h.setReply(async () => 'not json');
  assert.equal((await h.send(h.goalMessage)).error, 'INVALID_JSON');
  assert.equal((await h.send(h.goalMessage)).error, 'INVALID_JSON');
  assert.equal(h.aiCalls().length, 1);
});

test('navigation while model is pending invalidates the late result', async () => {
  const h = await harness();
  h.setReply(async () => {
    h.events.updated(7, { url: 'https://www.bilibili.com/video/BV0987654321' });
    return '{}';
  });
  assert.equal((await h.send(h.goalMessage)).error, 'STALE_VIDEO');
  assert.equal(h.aiCalls().length, 1);
});

test('legacy overview, explanation, notes retrieval and translation still use existing handlers', async () => {
  const h = await harness();
  h.setReply(async body => {
    if (body.messages[0].content.includes('self-contained note')) return { text: 'Agent 记忆需要持久化存储。' };
    if (body.messages[0].content.includes('章节')) return { chapters: [{ title: '概览', summary: '摘要', timestampSeconds: 1 }], keyQuotes: [], keyMoments: [1] };
    const user = body.messages[1].content;
    if (user.startsWith('{')) return { segments: [{ id: 's1', text: '这是用于验证翻译功能的中文句子。' }] };
    return '持久化是在程序退出后保留数据。';
  });
  const overview = await h.send({ action: 'analyzeTranscript', transcriptText: '[0:01] Agent 记忆需要持久化存储。', videoTitle: '测试', videoDuration: 10 });
  assert.equal(overview.success, true);
  assert.equal(overview.analysis.chapters[0].timestampSeconds, 1);
  assert.equal((await h.send({ action: 'explainSelection', selectedText: '持久化', transcriptContext: '保存用户偏好', videoTitle: '测试' })).success, true);
  assert.equal((await h.send({ action: 'getNotes', videoId: 'BV1234567890@p1' })).success, true);
  const note = await h.send({ action: 'saveNote', videoId: 'BV1234567890@p1', timestamp: 2, videoTitle: '测试', channelName: '测试' });
  assert.equal(note.success, true);
  assert.equal(note.note.timestampSeconds, 2);
  assert.equal((await h.send({ action: 'getNotes', videoId: 'BV1234567890@p1' })).notes.length, 1);
  const translated = await h.send({ action: 'translateContent', contentType: 'transcriptBatch', targetLanguage: 'zh', videoTitle: '测试', content: { segments: [{ id: 's1', text: 'Persist preferences in a durable data store.' }] } });
  assert.equal(translated.success, true);
  assert.equal(translated.translatedContent.segments[0].id, 's1');
});

test('Goal seek uses registered evidence, explicit tab and live CID without any AI request', async () => {
  const h = await harness();
  const jumps = [];
  h.context.chrome.tabs.sendMessage = async (tabId, message) => { jumps.push({ tabId, message }); return { success: true }; };
  const target = { action: 'goalSeek', tabId: 7, identity: h.goalMessage.expectedIdentity, seconds: 1.125 };
  assert.equal((await h.send(target)).success, true);
  assert.equal(jumps[0].tabId, 7);
  assert.equal(jumps[0].message.seconds, 1.125);
  assert.equal((await h.send({ ...target, seconds: 9999 })).success, false);
  assert.equal((await h.send({ ...target, tabId: 8 })).success, false);
  const baseFetch = h.context.fetch;
  h.context.fetch = async (url, options) => url.includes('/x/web-interface/view')
    ? { ok: true, json: async () => ({ code: 0, data: { pages: [{ cid: 99 }] } }) } : baseFetch(url, options);
  assert.equal((await h.send(target)).success, false);
  assert.equal(jumps.length, 1);
  assert.equal(h.aiCalls().length, 0);
});

test('ordinary same-video events preserve registered snapshot and network rejection is distinct from CID mismatch', async () => {
  const h = await harness();
  const target = {action:'goalSeek',tabId:7,identity:h.goalMessage.expectedIdentity,seconds:1.125};
  h.context.chrome.tabs.sendMessage = async () => ({success:true});
  h.events.updated(7,{status:'loading'});
  h.events.updated(7,{url:'https://www.bilibili.com/video/BV1234567890?share_source=test'});
  assert.equal((await h.send(target)).success,true);
  const original=h.context.fetch;
  h.context.fetch=async url=>{if(url.includes('/x/web-interface/view'))throw Error('network unavailable');return original(url)};
  let rejected=await h.send(target);
  assert.equal(rejected.error,'SEEK_NETWORK_ERROR');assert.equal(rejected.diagnostics.stage,'cid_fetch');
  h.context.fetch=async url=>url.includes('/x/web-interface/view')?{ok:true,json:async()=>({code:0,data:{pages:[{cid:99}]}})}:original(url);
  rejected=await h.send(target);assert.equal(rejected.error,'SEEK_CID_MISMATCH');assert.equal(rejected.diagnostics.stage,'cid');
});

test('Background reads configured key but actual HTTP 401 returns explicit authentication failure once', async () => {
  const h=await harness();
  const config=await h.send({action:'checkConfig'});
  assert.equal(config.hasAiKey,true);assert.equal('aiApiKey' in config,false);
  const original=h.context.fetch;let posts=0;
  h.context.fetch=async(url,options)=>{
    if(url==='https://api.deepseek.com/chat/completions'){posts++;return{ok:false,status:401,json:async()=>({error:{message:'Unauthorized'}})}}
    return original(url,options);
  };
  const result=await h.send(h.goalMessage);
  assert.equal(result.error,'UNAUTHORIZED');assert.equal(result.success,false);
  assert.equal(result.diagnostics.modelRequested,true);assert.equal(posts,1);
});
