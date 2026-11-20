/* GoalClip UI-independent interaction state. MIT; see ../LICENSE. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const E = isNode ? require('./transcript-index.js') : root.GoalTranscriptIndex;
  const N = isNode ? require('./navigator.js') : root.GoalNavigator;
  const C = isNode ? require('./cache.js') : root.GoalCache;
  const ERRORS = {
    NO_TRANSCRIPT: '当前视频没有可用 B站字幕。可更换视频或登录后重试；不会启动 ASR。',
    SUBTITLE_AUTH_REQUIRED: '字幕需要登录或当前账号没有权限。请登录 B站并刷新视频。',
    SUBTITLE_API_ERROR: '字幕接口请求失败。请检查网络、刷新视频后重试。',
    STALE_VIDEO: '视频、分 P 或字幕已变化。旧结果已丢弃，请重新提交。',
    VIDEO_IDENTITY_MISMATCH: '视频身份不匹配，请刷新视频后重试。',
    NO_AI_KEY: '未配置 API Key，可先使用本地关键词检索，或前往 API 设置。',
    UNAUTHORIZED: 'DeepSeek API Key 无效或没有权限，请检查 API 设置。',
    TIMEOUT: '模型请求超时。请点击“重新尝试”手动重试。',
    RATE_LIMITED: 'DeepSeek 请求限流。请稍后点击“重新尝试”。',
    INVALID_EVIDENCE: 'AI 返回了无效字幕引用，结果未展示。可手动重试。',
    INVALID_RESULT: 'AI 返回结构不合法，结果未展示。可手动重试。',
    INVALID_JSON: 'AI 返回了无法解析的结果，未自动重试。',
    EMPTY_RESPONSE: '模型返回空响应，可手动重试。',
    INPUT_TOO_LARGE: '本次字幕内容超过分析预算，可缩小目标或更换视频。',
    PROVIDER_ERROR: '模型网络或服务异常。请检查网络后手动重试。',
  };
  function error(code) { return Object.assign(new Error(ERRORS[code] || '请求失败，请检查网络或视频状态后手动重试。'), { code }); }
  function validateResponse(response, snapshot, goal) {
    if (!response?.success || response.status !== 'analyzed' || !response.result ||
        !N.sameIdentity(response.identity, N.identity(snapshot))) throw error('INVALID_RESULT');
    const r = response.result;
    const raw = {
      schemaVersion: r.schemaVersion, goalType: r.goalType, subgoals: r.subgoals,
      recommendedSegments: r.recommendedSegments.map(s => ({ segmentId: s.segmentId,
        subgoalIds: s.subgoalIds, role: s.role, reason: s.reason })), watchOrder: r.watchOrder,
      coverage: r.coverage.map(c => ({ subgoalId: c.subgoalId, status: c.status, segmentIds: c.segmentIds, reason: c.reason })),
      gaps: r.gaps.map(g => ({ subgoalId: g.subgoalId, description: g.description })),
      searchKeywords: r.searchKeywords.map(k => ({ subgoalId: k.subgoalId, keyword: k.keyword })),
      limitations: r.limitations.slice(0, 8),
    };
    const recalled = N.recall(snapshot, goal);
    return { ...response, scope: recalled.scope, result: N.validateResult(raw, recalled.candidates, recalled.scope) };
  }
  function createController({ send, storage, onChange, isCurrent, seek, now = Date.now, uuid = () => crypto.randomUUID() }) {
    let generation = 0, context = null, snapshot = null, pending = null, lastGoal = '';
    let state = { phase: 'idle', title: '', hasKey: false, goal: '', message: '输入问题或学习目标，查找当前视频中的真实字幕。' };
    const cache = C.createCache(storage);
    const sendBounded = (message, timeoutMs = 25000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(error('TIMEOUT')), timeoutMs);
      Promise.resolve().then(() => send(message)).then(resolve, reject).finally(() => clearTimeout(timer));
    });
    const emit = patch => { state = { ...state, ...patch }; onChange(state); };
    const current = async (token, target) => {
      if (token !== generation || context !== target) return false;
      const valid = await isCurrent(target);
      return valid && token === generation && context === target;
    };
    const ensureCurrent = async (token, target) => { if (!await current(token, target)) throw error('STALE_VIDEO'); };
    function setContext(next) {
      generation++; context = next; snapshot = null; pending = null;
      emit({ phase: 'idle', title: next?.title || '无法识别当前视频', goal: lastGoal,
        message: next ? '输入问题或学习目标，查找当前视频中的真实字幕。' : '请打开一条 B站普通视频。',
        response: null, localResults: [], diagnostics: null });
    }
    async function submit(goal) {
      if (pending) return pending;
      if (!context) { emit({ phase: 'error', message: '无法识别当前视频，请刷新视频后重试。' }); return; }
      if (typeof goal !== 'string' || !goal.trim() || goal.length > 1000) {
        emit({ phase: 'error', message: '请输入 1–1000 字的问题或学习目标。' }); return;
      }
      const target = context, token = generation, startedAt = now();
      lastGoal = goal.trim();
      const requestId = uuid();
      emit({ phase: 'loading', goal: lastGoal, message: '正在读取字幕并查找相关证据…',
        response: null, localResults: [], diagnostics: null });
      const task = (async () => {
        let diagnostics = { cacheHit: false, modelRequested: false, inputTokens: null, outputTokens: null };
        try {
          await ensureCurrent(token, target);
          const fetched = await sendBounded({ action: 'fetchGoalTranscript', tabId: target.tabId, bvid: target.bvid, page: target.page });
          await ensureCurrent(token, target);
          if (!fetched?.success) throw error(fetched?.error);
          const capturedSnapshot = await E.createSnapshot({ video: fetched.snapshot.video, cues: fetched.snapshot.cues });
          await ensureCurrent(token, target);
          if (capturedSnapshot.transcriptHash !== fetched.snapshot.transcriptHash || capturedSnapshot.video.bvid !== target.bvid || capturedSnapshot.video.page !== target.page) throw error('STALE_VIDEO');
          snapshot = capturedSnapshot;
          const config = await sendBounded({ action: 'checkConfig' });
          await ensureCurrent(token, target);
          const localResults = E.createIndex(snapshot).search(lastGoal).results;
          emit({ localResults, hasKey: !!config?.hasAiKey });
          if (!config?.hasAiKey) {
            emit({ phase: 'local', message: '当前显示的是关键词检索结果。配置 API Key 后，可以获得 AI 生成的观看顺序与内容缺口分析。',
              diagnostics: { ...diagnostics, elapsedMs: now() - startedAt } });
            return;
          }
          const key = await C.keyFor(snapshot, lastGoal, config.aiModel);
          let saved = { response: null, invalidated: false };
          try { saved = await cache.get(key); } catch { /* Cache failure must not block analysis. */ }
          await ensureCurrent(token, target);
          if (saved.response) {
            try {
              const checked = validateResponse(saved.response, snapshot, lastGoal);
              diagnostics = { ...diagnostics, cacheHit: true, elapsedMs: now() - startedAt };
              emit({ phase: 'ai', response: { ...checked, requestId, tabId: target.tabId }, message: '已加载有效的本地分析缓存。', diagnostics });
              return;
            } catch { saved.invalidated = true; try { await cache.remove(key); } catch {} }
          }
          emit({ message: saved.invalidated ? '旧缓存已失效，正在生成新的观看路径…' : '正在生成观看路径，每次提交最多一次 AI 请求…' });
          // A transport failure cannot establish whether the provider received the request.
          diagnostics.modelRequested = null;
          const response = await sendBounded({ action: 'analyzeGoal', tabId: target.tabId, requestId, goal: lastGoal, expectedIdentity: N.identity(snapshot) }, 135000);
          await ensureCurrent(token, target);
          diagnostics = { ...diagnostics, ...response?.diagnostics, cacheHit: false, elapsedMs: now() - startedAt };
          if (!response?.success) throw error(response?.error);
          if (response.requestId !== requestId || !N.sameIdentity(response.identity, N.identity(snapshot))) throw error('STALE_VIDEO');
          if (response.status === 'insufficient_evidence') {
            emit({ phase: 'ai', response, message: '没有足够字幕证据生成路径；不代表完整视频没有相关内容。', diagnostics }); return;
          }
          const checked = validateResponse(response, snapshot, lastGoal);
          let cacheSaved = true;
          try { cacheSaved = await cache.set(key, checked); } catch { cacheSaved = false; }
          await ensureCurrent(token, target);
          emit({ phase: 'ai', response: { ...checked, tabId: target.tabId }, diagnostics,
            message: cacheSaved ? '观看路径已生成，仅依据提供的字幕证据。' : '观看路径已生成，但本地缓存保存失败。' });
        } catch (failure) {
          if (token !== generation || context !== target) return;
          emit({ phase: 'error', response: null, message: ERRORS[failure.code] || error().message,
            diagnostics: { ...diagnostics, errorCode: failure.code || 'NETWORK_ERROR', elapsedMs: now() - startedAt } });
        }
      })();
      pending = task;
      try { await task; } finally { if (pending === task) pending = null; }
    }
    async function jump(segment) {
      const token = generation, target = context, captured = snapshot;
      try {
        if (!target || !captured) throw error('STALE_VIDEO');
        await ensureCurrent(token, target);
        const source = new Map(captured.cues.map(c => [c.cueId, c]));
        const cues = segment.cueIds?.map(id => source.get(id));
        if (!cues?.length || cues.some(c => !c) || segment.start !== Math.min(...cues.map(c => c.start))) throw error('INVALID_EVIDENCE');
        const result = await seek({ tabId: target.tabId, identity: N.identity(captured), seconds: segment.start });
        await ensureCurrent(token, target);
        if (!result?.success) throw error(result?.error || 'STALE_VIDEO');
        return true;
      } catch (failure) { if (token === generation) emit({ phase: 'error', message: ERRORS[failure.code] || error().message }); return false; }
    }
    return { setContext, submit, jump, getState: () => state, getSnapshot: () => snapshot,
      clear() { generation++; pending = null; lastGoal = ''; snapshot = null;
        emit({ phase: 'idle', goal: '', message: '输入问题或学习目标，查找当前视频中的真实字幕。', response: null, localResults: [], diagnostics: null }); } };
  }
  const api = { createController, validateResponse, ERRORS };
  if (isNode) module.exports = api; else root.GoalPanelController = api;
})(globalThis);
