/* GoalClip single-call navigation engine. MIT; see ../LICENSE. */
(function (root) {
  'use strict';
  const Evidence = typeof module !== 'undefined' && module.exports
    ? require('./transcript-index.js') : root.GoalTranscriptIndex;
  const LIMITS = Object.freeze({ goalChars: 1000, candidateCount: 20, textChars: 18000,
    inputChars: 28000, outputChars: 48000, maxOutputTokens: 4096,
    snapshotChars: 2000000, snapshotCues: 50000 });
  const ROLES = ['direct_answer', 'prerequisite', 'method', 'example', 'limitation'];
  const STATES = ['covered', 'partial', 'not_found', 'uncertain'];
  function fail(code, message) { throw Object.assign(new Error(message), { code }); }
  function identity(snapshot) { return { ...snapshot.video, transcriptHash: snapshot.transcriptHash }; }
  function sameIdentity(a, b) {
    return !!a && !!b && ['bvid', 'cid', 'page', 'language', 'sourceType', 'provider', 'transcriptHash']
      .every(key => String(a[key]) === String(b[key]));
  }
  function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) {
      fail('INVALID_RESULT', '模型结果结构不合法。');
    }
  }
  function text(value, max = 600) {
    if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_RESULT', '模型字段缺失或超长。');
    return value.trim();
  }
  function array(value, max, min = 0) {
    if (!Array.isArray(value) || value.length > max || value.length < min) fail('INVALID_RESULT', '模型数组不合法。');
    return value;
  }
  function unique(values) {
    if (new Set(values).size !== values.length) fail('INVALID_RESULT', '模型引用重复。');
    return values;
  }
  async function verifiedSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.cues) || snapshot.cues.length > LIMITS.snapshotCues ||
        snapshot.cues.reduce((sum, cue) => sum + (typeof cue.text === 'string' ? cue.text.length : LIMITS.snapshotChars + 1), 0) > LIMITS.snapshotChars) {
      fail('INVALID_SNAPSHOT', '字幕快照缺失或超过处理上限。');
    }
    let rebuilt;
    try { rebuilt = await Evidence.createSnapshot({ video: snapshot.video, cues: snapshot.cues }); }
    catch { fail('INVALID_SNAPSHOT', '字幕快照数据不合法。'); }
    if (snapshot.schemaVersion !== rebuilt.schemaVersion || snapshot.transcriptHash !== rebuilt.transcriptHash) {
      fail('INVALID_SNAPSHOT', '字幕快照版本或 hash 不匹配。');
    }
    return rebuilt; // Do not trust caller-supplied segment IDs/text mappings.
  }

  function recall(snapshot, goal) {
    const index = Evidence.createIndex(snapshot);
    const positions = new Map(snapshot.cues.map((cue, i) => [cue.cueId, i]));
    const ranks = new Map();
    // Deterministic query facets, not AI query expansion. Keep original technical terms.
    const facets = [...new Set([goal, ...(goal.match(/[A-Za-z][A-Za-z0-9.+#_/-]*|[\p{Script=Han}]{2,12}/gu) || [])])].slice(0, 9);
    for (const facet of facets) {
      const hits = index.search(facet, { limit: 8 }).results;
      hits.forEach((hit, rank) => {
        for (const occurrence of hit.occurrences) for (const cueId of occurrence.cueIds) {
          const i = positions.get(cueId);
          ranks.set(i, (ranks.get(i) || 0) + 1 / (rank + 1));
        }
      });
    }
    const ordered = [...ranks.keys()].sort((a, b) => ranks.get(b) - ranks.get(a) || a - b);
    const seeds = [];
    const seenText = new Set();
    const add = i => {
      if (i == null || !snapshot.cues[i] || seeds.includes(i)) return;
      const signature = snapshot.cues[i].text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
      if (seenText.has(signature)) return;
      seenText.add(signature); seeds.push(i);
    };
    if (snapshot.cues.length <= 20) snapshot.cues.forEach((_, i) => add(i));
    else {
      // Strongest lexical evidence first, then one match from each temporal band.
      ordered.slice(0, 6).forEach(add);
      for (let band = 0; band < 8; band++) add(ordered.find(i => Math.floor(i * 8 / snapshot.cues.length) === band));
      ordered.forEach(i => { if (seeds.length < 16) add(i); });
      // Modest distributed sampling can expose relevant prerequisites without a lexical hit.
      for (let band = 0; band < 4; band++) add(Math.floor((band + 0.5) * snapshot.cues.length / 4));
    }
    const candidates = [];
    const used = new Set();
    let textChars = 0;
    for (const seed of seeds) {
      if (candidates.length >= LIMITS.candidateCount || used.has(seed)) continue;
      const indices = [seed];
      // One original cue of nearby context on either side; never interpolate boundaries.
      for (const i of [seed - 1, seed + 1]) {
        if (i < 0 || i >= snapshot.cues.length || used.has(i)) continue;
        const a = snapshot.cues[Math.min(i, seed)], b = snapshot.cues[Math.max(i, seed)];
        if (b.start >= a.start && b.start - a.end <= 5 &&
            snapshot.cues[i].text.length + snapshot.cues[seed].text.length <= 1800) indices.push(i);
      }
      indices.sort((a, b) => a - b);
      let cues = indices.map(i => snapshot.cues[i]);
      let content = cues.map(c => c.text).join('\n');
      if (content.length > 2400 || textChars + content.length > LIMITS.textChars) {
        cues = [snapshot.cues[seed]]; content = cues[0].text;
      }
      if (content.length > 2400 || textChars + content.length > LIMITS.textChars) continue;
      const cueIds = cues.map(c => c.cueId);
      cues.forEach(c => used.add(positions.get(c.cueId)));
      textChars += content.length;
      candidates.push({ segmentId: `goal:${snapshot.transcriptHash}:${seed}`, cueIds,
        start: Math.min(...cues.map(c => c.start)), end: Math.max(...cues.map(c => c.end)),
        text: content, recallScore: ranks.get(seed) || 0 });
    }
    return { candidates, scope: { type: 'retrieved_candidates', totalCues: snapshot.cues.length,
      suppliedCues: used.size, allCuesIncluded: used.size === snapshot.cues.length,
      textChars, missingEvidenceIsNotAbsence: true } };
  }

  function validate(parsed, candidates, scope) {
    // Conservative rejection of common absolute-absence claims. Scope metadata remains mandatory.
    if (/(?:整个视频|完整视频|全片|本视频|该视频|视频中).{0,16}(?:没有|未提|未讲|不包含)|(?:entire|whole) video.{0,40}(?:does not|never|no coverage)/i.test(JSON.stringify(parsed))) {
      fail('INVALID_RESULT', '不能从候选字幕推断完整视频绝对缺失。');
    }
    object(parsed, ['schemaVersion', 'goalType', 'subgoals', 'recommendedSegments', 'watchOrder', 'coverage', 'gaps', 'searchKeywords', 'limitations']);
    if (parsed.schemaVersion !== 1 || !['question', 'task'].includes(parsed.goalType)) fail('INVALID_RESULT', '目标类型或版本不合法。');
    const subgoals = array(parsed.subgoals, 5, 1).map(g => {
      object(g, ['id', 'title']);
      const id = text(g.id, 16);
      if (!/^g[1-5]$/.test(id)) fail('INVALID_RESULT', '子目标 ID 不合法。');
      return { id, title: text(g.title, 200) };
    });
    const goalIds = new Set(unique(subgoals.map(g => g.id)));
    const checkGoal = id => { if (!goalIds.has(id)) fail('INVALID_RESULT', '子目标引用不存在。'); return id; };
    const evidence = new Map(candidates.map(c => [c.segmentId, c]));
    const recommendedSegments = array(parsed.recommendedSegments, 8).map(item => {
      object(item, ['segmentId', 'subgoalIds', 'role', 'reason']);
      const source = evidence.get(item.segmentId);
      if (!source) fail('INVALID_EVIDENCE', '模型引用了未提供的字幕片段。');
      if (!ROLES.includes(item.role)) fail('INVALID_RESULT', '片段角色不合法。');
      return { segmentId: source.segmentId, subgoalIds: unique(array(item.subgoalIds, 5, 1).map(checkGoal)),
        role: item.role, reason: text(item.reason),
        cueIds: [...source.cueIds], start: source.start, end: source.end, text: source.text };
    });
    const selected = new Map(recommendedSegments.map(s => [s.segmentId, s]));
    unique(recommendedSegments.map(s => s.segmentId));
    const watchOrder = unique(array(parsed.watchOrder, 8));
    if (watchOrder.length !== selected.size || watchOrder.some(id => !selected.has(id))) fail('INVALID_RESULT', '观看顺序必须恰好覆盖推荐片段。');
    const coverage = array(parsed.coverage, 5, 1).map(item => {
      object(item, ['subgoalId', 'status', 'segmentIds', 'reason']);
      checkGoal(item.subgoalId);
      if (!STATES.includes(item.status)) fail('INVALID_RESULT', '覆盖状态不合法。');
      const segmentIds = unique(array(item.segmentIds, 8));
      if (segmentIds.some(id => !selected.has(id) || !selected.get(id).subgoalIds.includes(item.subgoalId))) fail('INVALID_EVIDENCE', '覆盖证据不支持该子目标引用。');
      if (['covered', 'partial'].includes(item.status) && !segmentIds.length) fail('INVALID_EVIDENCE', '覆盖判断缺少字幕证据。');
      // Full coverage must cite an answer/method, not just prerequisites or names in examples.
      if (item.status === 'covered' && !segmentIds.some(id => ['direct_answer', 'method'].includes(selected.get(id).role))) fail('INVALID_EVIDENCE', '完整覆盖缺少直接答案或方法证据。');
      if (item.status === 'not_found' && segmentIds.length) fail('INVALID_RESULT', '未找到状态不能带支持证据。');
      return { subgoalId: item.subgoalId, status: item.status, segmentIds, reason: text(item.reason),
        scope: 'provided_candidates' };
    });
    if (unique(coverage.map(c => c.subgoalId)).length !== subgoals.length) fail('INVALID_RESULT', '必须逐项判断所有子目标。');
    const gaps = array(parsed.gaps, 5).map(g => {
      object(g, ['subgoalId', 'description']);
      return { subgoalId: checkGoal(g.subgoalId), description: text(g.description), scope: 'provided_candidates' };
    });
    const searchKeywords = array(parsed.searchKeywords, 5).map(item => {
      object(item, ['subgoalId', 'keyword']);
      const keyword = text(item.keyword, 120);
      if (/:\/\/|www\.|[\x00-\x1f]/i.test(keyword)) fail('INVALID_RESULT', '搜索建议只能包含关键词。');
      return { subgoalId: checkGoal(item.subgoalId), keyword,
        url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`, verified: false };
    });
    const limitations = array(parsed.limitations, 8).map(s => text(s, 400));
    limitations.push('仅分析所提供的字幕证据；未找到匹配不代表完整视频未讨论，字幕也可能不准确。');
    if (!scope.allCuesIncluded) limitations.push('当前只提供了部分字幕，不能据此判断完整视频缺少某项内容。');
    return { schemaVersion: 1, goalType: parsed.goalType, subgoals, recommendedSegments,
      watchOrder, coverage, gaps, searchKeywords, limitations };
  }

  function createNavigator({ provider, loadSystemPrompt }) {
    return Object.freeze({
      async analyze({ goal, snapshot: input, requestId, expectedIdentity, getCurrentIdentity }) {
        if (typeof goal !== 'string' || !goal.trim() || goal.length > LIMITS.goalChars) fail('INVALID_GOAL', '目标须为1–1000字符。');
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) fail('INVALID_REQUEST', 'requestId 不合法。');
        const snapshot = await verifiedSnapshot(input);
        const captured = identity(snapshot);
        if (!sameIdentity(captured, expectedIdentity) || typeof getCurrentIdentity !== 'function') fail('STALE_VIDEO', '当前视频快照身份不匹配。');
        const assertCurrent = async () => {
          if (!sameIdentity(captured, await getCurrentIdentity())) fail('STALE_VIDEO', '视频或字幕已变化，请重新提交。');
        };
        await assertCurrent();
        const { candidates, scope } = recall(snapshot, goal);
        const base = { requestId, identity: captured, scope };
        if (!candidates.length) return { ...base, status: 'insufficient_evidence', result: null,
          limitations: ['没有可提供的字幕证据；不表示完整视频没有相关内容。'] };
        const system = await loadSystemPrompt();
        const user = JSON.stringify({ goal: goal.trim(), scope,
          candidates: candidates.map(({ segmentId, text }) => ({ segmentId, text })) });
        if (typeof system !== 'string' || system.length + user.length > LIMITS.inputChars) fail('INPUT_TOO_LARGE', '模型输入超过字符预算。');
        await assertCurrent();
        // Exactly one automatic provider invocation. No parse repair or feature side effects.
        const response = await provider.complete({ task: 'goal-navigation', requestId, identity: captured,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          maxOutputTokens: LIMITS.maxOutputTokens, outputSchemaVersion: 1 });
        await assertCurrent();
        if (response.requestId !== requestId || !sameIdentity(response.identity, captured)) fail('STALE_VIDEO', '服务返回的请求身份不匹配。');
        if (typeof response.text !== 'string' || !response.text.trim()) fail('EMPTY_RESPONSE', '模型返回空响应。');
        if (response.text.length > LIMITS.outputChars) fail('INVALID_RESULT', '模型输出超过字符上限。');
        let parsed;
        try { parsed = JSON.parse(response.text); } catch { fail('INVALID_JSON', '模型返回非法 JSON；未自动重试。'); }
        return { ...base, status: 'analyzed', result: validate(parsed, candidates, scope) };
      },
    });
  }
  const api = Object.freeze({ LIMITS, identity, sameIdentity, recall, validateResult: validate, createNavigator });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoalNavigator = api;
})(globalThis);
