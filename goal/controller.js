/* GoalClip UI-independent interaction state. MIT; see ../LICENSE. */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const E = isNode ? require('./transcript-index.js') : root.GoalTranscriptIndex;
  const N = isNode ? require('./navigator.js') : root.GoalNavigator;
  const C = isNode ? require('./cache.js') : root.GoalCache;
  const S = isNode ? require('./session-state.js') : root.GoalSessionState;
  const ERRORS = {
    NO_TRANSCRIPT: '当前视频没有可用 B站字幕。可更换视频或登录后重试；不会启动 ASR。',
    SUBTITLE_AUTH_REQUIRED: '字幕需要登录或当前账号没有权限。请登录 B站并刷新视频。',
    SUBTITLE_API_ERROR: '字幕接口请求失败。请检查网络、刷新视频后重试。',
    STALE_VIDEO: '视频、分 P 或字幕已变化。旧结果已丢弃，请重新提交。',
    VIDEO_IDENTITY_MISMATCH: '视频身份不匹配，请刷新视频后重试。',
    CONFIG_READ_FAILED: '无法读取后台 API 配置，请重新加载扩展后重试。',
    SEEK_NETWORK_ERROR: '视频信息网络请求失败，证据未被判定失效。',
    SEEK_CONTEXT_MISSING: '当前字幕快照未就绪，请重新打开当前视频。',
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
    let analysisKey = null, restored = false, restoreTask = null, persistTimer = null, editVersion = 0;
    let state = { phase: 'idle', title: '', hasKey: false, goal: '', message: '输入问题或学习目标，查找当前视频中的真实字幕。' };
    const cache = C.createCache(storage);
    const sessions = S.createStore(storage, now);
    function flush() {
      clearTimeout(persistTimer);
      if (!context) return sessions.drain().catch(() => {});
      return sessions.save(context, { draft: (state.goal || '').slice(0,1000), lastGoal,
        phase: state.phase, identity: snapshot ? N.identity(snapshot) : null,
        analysisKey, requestId: state.response?.requestId || null, hasKey: !!state.hasKey,
        errorCode: state.diagnostics?.errorCode || null, ui: state.ui || {} }).catch(() => {});
    }
    function updateDraft(value) {
      state = { ...state, goal: String(value).slice(0,1000) }; editVersion++;
      clearTimeout(persistTimer); persistTimer = setTimeout(flush, 350);
    }
    function setUi(ui) {
      ui = { ...state.ui, ...ui };
      state.ui = { selectedTab: ['goal','transcript','overview','notes'].includes(ui.selectedTab) ? ui.selectedTab : 'goal',
        scrollTop: Number.isFinite(ui.scrollTop) ? Math.max(0, Math.min(ui.scrollTop, 10000000)) : 0,
        expanded: Array.isArray(ui.expanded) ? ui.expanded.filter(s => typeof s === 'string').slice(0,32).map(s => s.slice(0,120)) : [] };
      clearTimeout(persistTimer); persistTimer = setTimeout(flush, 350);
    }
    const sendBounded = (message, timeoutMs = 25000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(error('TIMEOUT')), timeoutMs);
      Promise.resolve().then(() => send(message)).then(resolve, reject).finally(() => clearTimeout(timer));
    });
    const emit = patch => { state = { ...state, restored:false, ...patch }; onChange(state); };
    const current = async (token, target) => {
      if (token !== generation || context !== target) return false;
      const valid = await isCurrent(target);
      return valid && token === generation && context === target;
    };
    const ensureCurrent = async (token, target) => { if (!await current(token, target)) throw error('STALE_VIDEO'); };
    function setContext(next) {
      if (context && next && context.tabId === next.tabId && context.bvid === next.bvid && context.page === next.page) {
        context.title = next.title; state.title = next.title || state.title; onChange(state); return false;
      }
      flush();
      generation++; context = next; snapshot = null; pending = null;
      restored = false; restoreTask = null; analysisKey = null; lastGoal = ''; editVersion++;
      emit({ contextKey: next ? `${next.bvid}@p${next.page}` : '', restored:false, phase: 'idle', title: next?.title || '无法识别当前视频', goal: '', ui: {},
        message: next ? '输入问题或学习目标，查找当前视频中的真实字幕。' : '请打开一条 B站普通视频。',
        response: null, localResults: [], diagnostics: null });
      return true;
    }
    async function restore() {
      if (!context || restored) return;
      if (restoreTask) return restoreTask;
      const token = generation, target = context, edit = editVersion;
      restoreTask = (async () => {
        const saved = await sessions.get(target);
        if (token !== generation || context !== target || edit !== editVersion) return;
        restored = true;
        if (!saved) return;
        lastGoal = typeof saved.lastGoal === 'string' ? saved.lastGoal.slice(0,1000) : '';
        analysisKey = saved.analysisKey;
        emit({ restored:true, goal: saved.draft, ui: saved.ui || {}, hasKey: saved.hasKey,
          message: '已恢复目标草稿，正在校验字幕版本…' });
        try {
          await ensureCurrent(token, target);
          if (edit !== editVersion) return;
          const fetched = await sendBounded({ action:'fetchGoalTranscript', tabId:target.tabId, bvid:target.bvid, page:target.page });
          await ensureCurrent(token, target);
          if (!fetched?.success) throw error(fetched?.error);
          const checked = await E.createSnapshot({ video:fetched.snapshot.video, cues:fetched.snapshot.cues });
          await ensureCurrent(token, target);
          if (edit !== editVersion) return;
          if (checked.transcriptHash !== fetched.snapshot.transcriptHash || checked.video.bvid !== target.bvid || checked.video.page !== target.page) throw error('STALE_VIDEO');
          snapshot = checked;
          if (saved.identity && !N.sameIdentity(saved.identity, N.identity(checked))) {
            emit({ restored:true, phase:'error', response:null, localResults:[], message:'字幕版本已变化，已恢复草稿但不复用旧证据，请手动重新分析。', diagnostics:{errorCode:'SNAPSHOT_CHANGED',modelRequested:false} });
            return;
          }
          const localResults = lastGoal ? E.createIndex(checked).search(lastGoal).results : [];
          if (saved.phase === 'loading' && !analysisKey) {
            emit({ restored:true, phase:'error', localResults, message:'上次分析中断，请手动重试。不会自动调用模型。', diagnostics:{errorCode:'ANALYSIS_INTERRUPTED',modelRequested:false} }); return;
          }
          if (['ai', 'loading'].includes(saved.phase) && analysisKey) {
            const cached = await cache.get(analysisKey);
            await ensureCurrent(token,target);
            if (edit !== editVersion) return;
            if (cached.response) {
              const response = validateResponse(cached.response, checked, lastGoal);
              emit({ restored:true, phase:'ai', response:{...response,requestId:uuid(),tabId:target.tabId}, localResults, message:'已恢复 AI 观看路径，未重新调用模型。',
                diagnostics:{cacheHit:true,modelRequested:false,inputTokens:null,outputTokens:null} }); return;
            }
            emit({ restored:true, phase:'error', localResults, message:saved.phase === 'loading' ? '上次分析中断，请手动重试。不会自动调用模型。' : '分析缓存已失效。草稿已恢复，请手动重新分析。', diagnostics:{errorCode:saved.phase === 'loading' ? 'ANALYSIS_INTERRUPTED' : 'CACHE_EXPIRED',modelRequested:false} }); return;
          }
          emit({ restored:true, phase: saved.phase === 'local' ? 'local' : saved.phase === 'error' ? 'error' : 'idle', localResults,
            message: saved.phase === 'local' ? '已恢复本地关键词检索。配置 API Key 后可主动生成 AI 观看路径。' : saved.phase === 'error' ? (ERRORS[saved.errorCode] || '上次分析未完成，请检查错误后手动重试。') : '已恢复尚未提交的目标草稿。',
            diagnostics:{modelRequested:false,errorCode:saved.errorCode} });
        } catch(failure) {
          if (token === generation && context === target && edit === editVersion) emit({ restored:true,phase:'error',response:null,localResults:[],message:ERRORS[failure.code] || '恢复时无法读取字幕。请检查网络后手动重试。',diagnostics:{errorCode:failure.code || 'RESTORE_NETWORK_ERROR',modelRequested:false}});
        }
      })();
      try { await restoreTask; } finally { if (token === generation) restoreTask = null; }
    }

    async function submit(goal) {
      if (pending) return pending;
      if (!context) { emit({ phase: 'error', message: '无法识别当前视频，请刷新视频后重试。' }); return; }
      if (typeof goal !== 'string' || !goal.trim() || goal.length > 1000) {
        emit({ phase: 'error', message: '请输入 1–1000 字的问题或学习目标。' }); return;
      }
      const target = context, token = generation, startedAt = now();
      lastGoal = goal.trim(); restored = true; editVersion++; analysisKey = null;
      const requestId = uuid();
      emit({ phase: 'loading', goal: lastGoal, message: '正在读取字幕并查找相关证据…',
        response: null, localResults: [], diagnostics: null });
      flush();
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
          diagnostics = {...diagnostics, configRead: !config?.error, keyPresent: typeof config?.hasAiKey === 'boolean' ? config.hasAiKey : null, provider:'deepseek-byok'};
          const localResults = E.createIndex(snapshot).search(lastGoal).results;
          emit({ localResults, hasKey: !!config?.hasAiKey });
          if (config?.error || typeof config?.hasAiKey !== 'boolean') throw error('CONFIG_READ_FAILED');
          if (!config.hasAiKey) {
            emit({ phase: 'local', message: '当前显示的是关键词检索结果。配置 API Key 后，可以获得 AI 生成的观看顺序与内容缺口分析。',
              diagnostics: { ...diagnostics, elapsedMs: now() - startedAt } });
            return;
          }
          const key = await C.keyFor(snapshot, lastGoal, config.aiModel);
          await ensureCurrent(token, target);
          analysisKey = key; flush();
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
      try { await task; } finally { if (pending === task) pending = null; if (token === generation && context === target) await flush(); }
    }
    async function jump(segment) {
      const token = generation, target = context, captured = snapshot;
      try {
        if (!target || !captured) throw error('SEEK_CONTEXT_MISSING');
        await ensureCurrent(token, target);
        const source = new Map(captured.cues.map(c => [c.cueId, c]));
        const cues = segment.cueIds?.map(id => source.get(id));
        if (!cues?.length || cues.some(c => !c) || segment.start !== Math.min(...cues.map(c => c.start))) throw error('INVALID_EVIDENCE');
        let result = await seek({ tabId: target.tabId, identity: N.identity(captured), seconds: segment.start });
        await ensureCurrent(token, target);
        if (result?.error === 'SEEK_SNAPSHOT_UNAVAILABLE') {
          const refreshed = await sendBounded({action:'fetchGoalTranscript',tabId:target.tabId,bvid:captured.video.bvid,page:captured.video.page,cid:captured.video.cid});
          await ensureCurrent(token,target);
          if (!refreshed?.success || !N.sameIdentity(N.identity(refreshed.snapshot),N.identity(captured))) throw error('SEEK_SNAPSHOT_MISMATCH');
          result = await seek({tabId:target.tabId,identity:N.identity(captured),seconds:segment.start});
          await ensureCurrent(token,target);
        }
        if (!result?.success) { const failure = error(result?.error || 'SEEK_FAILED'); failure.stage = result?.diagnostics?.stage || 'background'; throw failure; }
        return true;
      } catch (failure) { if (token === generation) emit({ message: `跳转失败：${ERRORS[failure.code] || '请检查当前视频和网络后重试。'} [${failure.code || 'SEEK_NETWORK_ERROR'}]`, diagnostics: {...state.diagnostics,errorCode:failure.code || 'SEEK_NETWORK_ERROR',seekStage:failure.stage || 'controller'} }); return false; }
    }
    return { setContext, restore, submit, jump, updateDraft, setUi, getUi: () => state.ui || {}, flush,
      getState: () => state, getSnapshot: () => snapshot,
      async clear() { generation++; pending = null; lastGoal = ''; snapshot = null; analysisKey = null;
        clearTimeout(persistTimer); restored = true; editVersion++;
        emit({ phase: 'idle', goal: '', ui:{}, message: '已清除当前视频的目标状态。', response: null, localResults: [], diagnostics: null });
        if (context) await sessions.remove(context);
      } };
  }

  const api = { createController, validateResponse, ERRORS };
  if (isNode) module.exports = api; else root.GoalPanelController = api;
})(globalThis);
