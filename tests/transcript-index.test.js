const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshot, createIndex } = require('../goal/transcript-index.js');

const video = { bvid: 'BV1234567890', cid: 88, page: 1 };
const cue = (text, start, end) => ({ text, start, end });
const snapshot = (cues, changes = {}) => createSnapshot({ video, language: 'zh-CN', sourceType: 'manual', cues, ...changes });

test('Chinese keywords and character bigrams retrieve original evidence', async () => {
  const source = await snapshot([cue('使用梯度下降来优化损失函数。', 1.25, 4.75), cue('下面介绍视频剪辑。', 8, 10)]);
  const index = createIndex(source);
  const found = index.search('如何优化损失函数');
  assert.equal(found.status, 'matched');
  assert.equal(found.results.length, 1);
  const hit = found.results[0];
  assert.equal(hit.text, source.cues[0].text);
  assert.deepEqual([hit.start, hit.end], [1.25, 4.75]);
  assert.deepEqual(index.getEvidence(hit.segmentId), [source.cues[0]]);
  assert.deepEqual(index.getEvidence(hit.cueIds[0]), [source.cues[0]]);
  assert.match(found.notice, /未匹配不代表/);
});

test('English terms, acronyms, numbers, and technical punctuation', async () => {
  const index = createIndex(await snapshot([
    cue('Node.js uses HTTP/2 and OAuth2 with TLS 1.3.', 0, 3),
    cue('C++ and C# are different languages.', 10, 13),
    cue('这是不相关的内容。', 20, 22),
  ]));
  for (const query of ['NODE.js', 'http/2', 'oauth2', 'TLS', '1.3', 'C++', 'C#']) {
    const hits = index.search(query).results;
    assert.equal(hits.length, 1, query);
    assert.match(hits[0].text, /Node.js|C\+\+/);
  }
  assert.equal(index.search('HTTP').results.length, 1);
});

test('adjacent hits merge with real cue boundaries, never character interpolation', async () => {
  const source = await snapshot([
    cue('索引保存每条字幕的时间。', 0.125, 3.375),
    cue('索引支持检索并追溯证据。', 4.125, 7.625),
    cue('这里没有关键词。', 8, 9),
    cue('索引也可以重建。', 10, 12),
  ]);
  const index = createIndex(source);
  const hits = index.search('索引').results;
  const merged = hits.find(hit => hit.cueIds.length === 2);
  assert.ok(merged);
  assert.equal(merged.text, source.cues.slice(0, 2).map(c => c.text).join('\n'));
  assert.deepEqual([merged.start, merged.end], [0.125, 7.625]);
  assert.deepEqual(index.getEvidence(merged.segmentId), source.cues.slice(0, 2));
  assert.equal(hits.length, 2);
});

test('repeated subtitles are deduplicated without losing independent locations', async () => {
  const source = await snapshot([
    cue('缓存需要失效策略。', 1, 3), cue('其他内容。', 5, 7),
    cue('缓存需要失效策略。', 101, 104),
  ]);
  const index = createIndex(source);
  const hits = index.search('缓存').results;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].occurrences.length, 2);
  assert.notEqual(source.cues[0].cueId, source.cues[2].cueId);
  assert.deepEqual(hits[0].occurrences.map(item => [item.start, item.end]), [[1, 3], [101, 104]]);
  for (const occurrence of hits[0].occurrences) {
    assert.equal(index.getEvidence(occurrence.segmentId)[0].start, occurrence.start);
  }
});

test('BVID, CID, page and evidence IDs are isolated', async () => {
  const cues = [cue('隔离检索', 0, 2)];
  const snapshots = await Promise.all([
    snapshot(cues),
    snapshot(cues, { video: { ...video, bvid: 'BV0987654321' } }),
    snapshot(cues, { video: { ...video, cid: 99 } }),
    snapshot(cues, { video: { ...video, page: 2 } }),
  ]);
  assert.equal(new Set(snapshots.map(s => s.transcriptHash)).size, 4);
  const first = createIndex(snapshots[0]);
  for (const other of snapshots.slice(1)) assert.deepEqual(first.getEvidence(other.segments[0].segmentId), []);
});

test('near-duplicate wording groups occurrences but distinct numbers remain separate', async () => {
  const index = createIndex(await snapshot([
    cue('缓存失效需要结合实际访问情况进行判断。', 0, 3),
    cue('缓存失效需要结合实际访问情况进行判断！', 100, 103),
    cue('缓存的有效时间设置为100秒。', 200, 203),
    cue('缓存的有效时间设置为200秒。', 300, 303),
  ]));
  const hits = index.search('缓存').results;
  assert.equal(hits.length, 3);
  assert.equal(hits.find(hit => hit.start === 0).occurrences.length, 2);
});

test('SHA-256 hash is deterministic and changes with content, time, language or source', async () => {
  const cues = [cue('字幕', 1, 2)];
  const initial = await snapshot(cues);
  assert.match(initial.transcriptHash, /^[a-f0-9]{64}$/);
  assert.equal((await snapshot(cues)).transcriptHash, initial.transcriptHash);
  for (const other of [
    await snapshot([cue('新字幕', 1, 2)]), await snapshot([cue('字幕', 1, 2.1)]),
    await snapshot(cues, { language: 'en' }), await snapshot(cues, { sourceType: 'bilibili-ai' }),
  ]) assert.notEqual(other.transcriptHash, initial.transcriptHash);
});

test('no matches and empty input return explicit empty results', async () => {
  for (const cues of [[], [cue('视频讨论机器学习。', 0, 2)]]) {
    const index = createIndex(await snapshot(cues));
    for (const query of ['', '   ', '火山喷发', 'quantumxyz']) {
      const result = index.search(query);
      assert.equal(result.status, 'no_match');
      assert.deepEqual(result.results, []);
    }
  }
});

test('default top 5, configurable 3–8, ranked by lexical relevance', async () => {
  const cues = Array.from({ length: 12 }, (_, i) => cue(`缓存设计方案${i}`, i * 100, i * 100 + 2));
  const index = createIndex(await snapshot(cues));
  assert.equal(index.search('缓存').results.length, 5);
  assert.equal(index.search('缓存', { limit: 8 }).results.length, 8);
  assert.equal(index.search('缓存', { limit: 3 }).results.length, 3);
  assert.throws(() => index.search('缓存', { limit: 9 }));
  const result = index.search('缓存设计方案7');
  assert.equal(result.results[0].start, 700);
});

test('reject invalid or missing evidence boundaries; preserve raw text and zero durations', async () => {
  for (const invalid of [cue('bad', -1, 2), cue('bad', 3, 2), cue('bad', NaN, 2), { text: 'bad', start: 1 }]) {
    await assert.rejects(snapshot([invalid]));
  }
  const source = await snapshot([cue(' 原始  文本 ', 2.25, 2.25)]);
  assert.equal(source.cues[0].text, ' 原始  文本 ');
  assert.ok(Object.isFrozen(source.cues[0]));
  assert.equal(createIndex(source).getSnapshot(), source);
});

test('pure snapshot/index/search/evidence pipeline never makes a network or AI request', async () => {
  const previous = global.fetch;
  let requests = 0;
  global.fetch = () => { requests++; throw new Error('Network forbidden'); };
  try {
    const index = createIndex(await snapshot([cue('纯本地搜索', 0, 1)]));
    const hit = index.search('搜索').results[0];
    assert.equal(index.getEvidence(hit.segmentId).length, 1);
    assert.equal(requests, 0);
  } finally { global.fetch = previous; }
});
