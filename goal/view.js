/* GoalClip side-panel presentation. MIT; see ../LICENSE for upstream notices. */
(function (root) {
  'use strict';
  const ROLES = Object.freeze({ direct_answer: '直接回答', prerequisite: '必要前提', method: '操作方法', example: '示例', limitation: '限制' });
  const COVERAGE = Object.freeze({ covered: '已覆盖', partial: '部分覆盖', not_found: '未找到支持证据', uncertain: '无法判断' });
  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return '时间未知';
    const ms = Math.round(value * 1000);
    const fraction = ms % 1000;
    return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${fraction ? '.' + String(fraction).padStart(3, '0').replace(/0+$/, '') : ''}`;
  }
  function orderedSegments(response) {
    const result = response?.result;
    if (!Array.isArray(result?.watchOrder) || !Array.isArray(result?.recommendedSegments)) return [];
    const byId = new Map(result.recommendedSegments.map(segment => [segment.segmentId, segment]));
    return [...new Set(result.watchOrder)].map(id => byId.get(id)).filter(Boolean);
  }
  function safeSearchUrl(keyword) {
    return `https://search.bilibili.com/all?keyword=${encodeURIComponent(String(keyword || ''))}`;
  }
  function mount({ document: doc, onSubmit, onClear, onSettings, onSeek, getChapters }) {
    const byId = id => doc.getElementById(id);
    const input = byId('goalInput');
    const form = byId('goalForm');
    if (!input || !form) throw new Error('Goal panel markup is missing');
    let composing = false;
    let busy = false;
    let lastGoalRendered;
    const node = (tag, className, text) => {
      const element = doc.createElement(tag);
      if (className) element.className = className;
      if (text != null) element.textContent = String(text);
      return element;
    };
    const replace = (id, children = []) => byId(id).replaceChildren(...children);
    const paragraph = value => node('p', 'goal-caption', value);
    const growInput = () => { input.style.height = 'auto'; input.style.height = Math.max(112, input.scrollHeight) + 'px'; };
    input.addEventListener('input', () => {
      input.setAttribute('aria-invalid', 'false');
      byId('goalClear').disabled = busy || !input.value;
      growInput();
    });
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (composing || busy) return;
      const goal = input.value.trim();
      if (!goal || goal.length > 1000) {
        input.setAttribute('aria-invalid', 'true');
        byId('goalStatus').textContent = '请输入 1–1000 字的问题或学习目标，再生成观看路径。';
        input.focus();
        return;
      }
      onSubmit(goal);
    });
    byId('goalClear').addEventListener('click', () => {
      if (busy) return;
      input.value = '';
      input.setAttribute('aria-invalid', 'false');
      growInput();
      onClear();
      input.focus();
    });
    byId('goalSettings').addEventListener('click', () => onSettings());

    function seekButton(segment, label) {
      const button = node('button', 'enhance-btn goal-seek', label || `跳转并定位字幕 · ${formatTime(segment.start)}–${formatTime(segment.end)}`);
      button.type = 'button';
      button.addEventListener('click', () => onSeek(segment));
      return button;
    }
    function card(segment, number, titles, local) {
      const article = node('article', 'goal-card');
      const header = node('div', 'goal-card-header');
      header.append(node('span', 'goal-card-number', String(number).padStart(2, '0')));
      const topic = !local && Array.isArray(segment.subgoalIds)
        ? segment.subgoalIds.map(id => titles.get(id)).filter(Boolean).join(' · ') : '';
      const fallback = String(segment.text || '').slice(0, 46);
      header.append(node('h3', 'goal-card-title', topic || fallback || '相关字幕片段'));
      article.append(header, node('span', 'goal-role', local ? '关键词匹配' : ROLES[segment.role] || '相关证据'));
      article.append(node('p', 'goal-reason', local ? '按词法相关性检索；尚未判断其在学习路径中的作用。' : segment.reason || ''));
      article.append(seekButton(segment));
      const details = node('details', 'goal-disclosure');
      details.append(node('summary', '', '查看原始字幕证据'));
      details.append(node('blockquote', 'goal-evidence', segment.text || ''));
      if (Array.isArray(segment.occurrences) && segment.occurrences.length > 1) {
        details.append(paragraph(`相同或近似内容共有 ${segment.occurrences.length} 处，位置分别保留：`));
        const occurrences = node('div', 'goal-occurrences');
        segment.occurrences.forEach(occurrence => occurrences.append(seekButton(occurrence, `${formatTime(occurrence.start)}–${formatTime(occurrence.end)}`)));
        details.append(occurrences);
      }
      article.append(details);
      return article;
    }
    function renderDebug(diagnostics) {
      if (!diagnostics) { replace('goalDebug', [paragraph('尚未提交目标。')]); return; }
      const actualNumber = value => Number.isFinite(value) && value >= 0 ? String(value) : '未知';
      const bool = value => value === true ? '是' : value === false ? '否' : '未知';
      const usage = diagnostics.usage || {};
      const values = [
        ['耗时', Number.isFinite(diagnostics.elapsedMs) ? `${Math.round(diagnostics.elapsedMs)} ms` : '未知'],
        ['缓存命中', bool(diagnostics.cacheHit)], ['发生模型请求', bool(diagnostics.modelRequested)],
        ['输入 Token', actualNumber(diagnostics.inputTokens ?? usage.prompt_tokens)],
        ['输出 Token', actualNumber(diagnostics.outputTokens ?? usage.completion_tokens)],
      ];
      if (diagnostics.errorCode) values.push(['错误类型', diagnostics.errorCode]);
      const dl = node('dl', 'goal-debug-list');
      values.forEach(([label, value]) => dl.append(node('dt', '', label), node('dd', '', value)));
      replace('goalDebug', [dl, paragraph('Token 仅显示模型实际返回的 usage；未知不会估算。调试信息仅保留当前页面状态。')]);
    }
    function renderStructure(chapters, duration) {
      if (!Array.isArray(chapters) || !chapters.length) {
        replace('goalStructure', [paragraph('尚未生成完整 AI 章节。目标分析不会为此额外调用模型。')]);
        return;
      }
      const ordered = chapters.filter(c => typeof c?.title === 'string' && Number.isFinite(c.timestampSeconds) && c.timestampSeconds >= 0).slice().sort((a, b) => a.timestampSeconds - b.timestampSeconds);
      if (!ordered.length) { replace('goalStructure', [paragraph('已有章节缓存不可用；未额外发起模型请求。')]); return; }
      const items = [paragraph('已有 AI 章节建议，未验证全片覆盖。区间终点按下一章起点或视频时长推定，并非精确字幕边界。')];
      ordered.forEach((chapter, i) => {
        const end = ordered[i + 1]?.timestampSeconds ?? duration;
        const item = node('div', 'goal-structure-item');
        item.append(node('h3', '', chapter.title));
        item.append(paragraph(`${formatTime(chapter.timestampSeconds)}–${Number.isFinite(end) && end >= chapter.timestampSeconds ? formatTime(end) : '结束时间未知'}`));
        if (chapter.summary) item.append(paragraph(chapter.summary));
        items.push(item);
      });
      replace('goalStructure', items);
    }
    function render(state = {}) {
      busy = state.phase === 'loading';
      if (typeof state.goal === 'string' && state.goal !== lastGoalRendered) input.value = state.goal;
      if (typeof state.goal === 'string') lastGoalRendered = state.goal;
      input.disabled = busy;
      form.setAttribute('aria-busy', String(busy));
      input.setAttribute('aria-invalid', String(state.phase === 'error' && state.diagnostics?.errorCode === 'INVALID_GOAL'));
      byId('goalSubmit').disabled = busy;
      byId('goalClear').disabled = busy || !input.value;
      byId('goalSubmit').textContent = busy ? '正在生成…' : state.phase === 'error' ? '重新尝试' : '生成观看路径';
      byId('goalVideoTitle').textContent = state.title || '当前视频名称暂不可用';
      byId('goalStatus').textContent = state.message || (busy ? '正在准备字幕证据并分析，请稍候。' : '');
      byId('goalStatus').dataset.tone = state.phase === 'error' ? 'error' : 'neutral';
      byId('goalKeyNotice').hidden = state.hasKey !== false;
      const ai = state.phase === 'ai' && state.response?.result;
      const results = ai ? orderedSegments(state.response) : Array.isArray(state.localResults) ? state.localResults : [];
      const titles = new Map((ai ? state.response.result.subgoals : []).map(g => [g.id, g.title]));
      byId('goalPathHeading').textContent = ai ? '推荐观看路径' : state.phase === 'local' || results.length ? '关键词相关片段' : '推荐观看路径';
      const scope = state.response?.scope;
      byId('goalScope').textContent = ai
        ? `${scope?.allCuesIncluded ? '已提供全部字幕作为候选证据。' : '仅基于部分字幕候选证据。'}未找到支持证据不代表完整视频没有相关内容。`
        : results.length ? '以下按关键词相关性排列，不是 AI 生成的学习顺序。' : '';
      if (results.length) replace('goalPath', results.map((segment, i) => card(segment, i + 1, titles, !ai)));
      else replace('goalPath', [node('p', 'goal-empty', busy ? '结果将在分析完成后显示。' : ['ai', 'local'].includes(state.phase) ? '未找到相关片段。可以换用更具体的术语或缩小目标；这不表示视频一定没有讨论。' : '输入目标后，相关片段会显示在这里。')]);
      byId('goalCoverageSection').hidden = !ai;
      byId('goalGapsSection').hidden = !ai;
      byId('goalLimitsSection').hidden = !ai;
      replace('goalCoverage'); replace('goalGaps'); replace('goalSearches'); replace('goalLimits');
      if (ai) {
        state.response.result.coverage.forEach(coverage => {
          const item = node('div', 'goal-coverage-item');
          item.append(node('h3', '', titles.get(coverage.subgoalId) || coverage.subgoalId));
          item.append(node('span', 'goal-coverage-status', COVERAGE[coverage.status] || '无法判断'));
          item.append(paragraph(coverage.reason));
          byId('goalCoverage').append(item);
        });
        const gaps = state.response.result.gaps || [];
        if (!gaps.length) byId('goalGaps').append(paragraph('当前分析没有提出补充项，不代表已验证目标完全覆盖。'));
        gaps.forEach(gap => byId('goalGaps').append(paragraph(gap.description)));
        (state.response.result.searchKeywords || []).forEach(item => {
          const link = node('a', 'goal-search-link', `搜索：${item.keyword}`);
          link.href = safeSearchUrl(item.keyword);
          link.target = '_blank'; link.rel = 'noopener noreferrer';
          byId('goalSearches').append(link);
        });
        (state.response.result.limitations || []).forEach(item => byId('goalLimits').append(paragraph(item)));
      }
      renderDebug(state.diagnostics);
      if (getChapters) {
        const cached = getChapters();
        renderStructure(Array.isArray(cached) ? cached : cached?.chapters, cached?.duration);
      }
      growInput();
    }
    function highlight(snapshot, segments = []) {
      const valid = new Set((snapshot?.cues || []).map(c => c.cueId));
      const recommended = new Set();
      segments.forEach(segment => {
        const occurrences = Array.isArray(segment.occurrences) ? segment.occurrences : [segment];
        occurrences.forEach(item => (item.cueIds || []).forEach(id => { if (valid.has(id)) recommended.add(id); }));
      });
      doc.querySelectorAll('#transcriptList .transcript-entry').forEach(row => {
        let ids = [];
        try { ids = JSON.parse(row.dataset.cueIds || '[]'); } catch { /* Unmapped rows remain unmarked. */ }
        const matches = Array.isArray(ids) && ids.some(id => recommended.has(id));
        row.classList.toggle('goal-recommended', matches);
        const oldBadge = row.querySelector('.goal-cue-badge');
        if (matches && !oldBadge) row.append(node('span', 'goal-cue-badge', '目标推荐'));
        if (!matches && oldBadge) oldBadge.remove();
        // Deliberately never touch active-playback or auto-scroll state.
      });
    }
    return Object.freeze({ render, renderStructure, highlight });
  }
  const api = Object.freeze({ mount, orderedSegments, formatTime, safeSearchUrl, ROLES, COVERAGE });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GoalPanelView = api;
})(globalThis);
