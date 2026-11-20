# G2.1 本地字幕证据与检索

无依赖、无网络、无 AI。`transcript-index.js` 可通过 CommonJS 使用，也可通过
`importScripts` / 外部 script 加载，浏览器全局名为 `GoalTranscriptIndex`。
本阶段没有最终 UI，也没有修改原有设置入口。

## Node 调试入口

从仓库根目录运行：

```sh
node --test tests/*.test.js
node scripts/test-subtitle-provider.js
```

```js
const { createSnapshot, createIndex } = require('./goal/transcript-index.js');
const snapshot = await createSnapshot({
  video: { bvid: 'BV1234567890', cid: 88, page: 1 },
  language: 'zh-CN', sourceType: 'manual', provider: 'bilibili-player-wbi',
  cues: [{ start: 1.125, end: 3.875, text: '缓存失效需要制定策略。' }],
});
const index = createIndex(snapshot);
const result = index.search('缓存策略'); // 默认 limit=5，支持 3–8
const hit = result.results[0];
console.log(hit, index.getEvidence(hit.segmentId));
```

上例使用顶层 await，需在 Node REPL 中执行，或放在 async 函数中。

## 后续 Goal Navigator 接口

扩展可信上下文（例如侧边栏）的调试控制台可调用：

```js
const response = await chrome.runtime.sendMessage({
  action: 'fetchGoalTranscript',
  bvid: 'BV1234567890', // 替换为当前视频的实际 BVID
  page: 1,            // 实际分 P，整数
  // cid: '12345',    // 可选：传入预期 CID，拒绝过期或错配结果
});
```

这会经现有 B 站字幕接口获取指定视频/分 P 的快照，不会自动选择活动标签页，
也不读取 AI Key、不调用 LLM、不进入 ASR。调用者负责提供当前页面身份，并在
结果到达时核对页面仍为同一视频。未找到字幕返回 `NO_TRANSCRIPT`，身份不符返回
`VIDEO_IDENTITY_MISMATCH`；其他错误沿用字幕接口错误格式。

成功返回 `{ success: true, snapshot }`。当前可在侧边栏调试控制台加载模块；
未来 Goal Navigator 可改为静态 script 引用：

```js
await import(chrome.runtime.getURL('goal/transcript-index.js'));
if (!response.success) throw new Error(response.error);
const index = GoalTranscriptIndex.createIndex(response.snapshot);
const snapshot = index.getSnapshot();
const matches = index.search('用户问题或学习目标', { limit: 5 });
const cues = index.getEvidence(matches.results[0]?.segmentId);
```

`snapshot` 包含 `schemaVersion`、SHA-256 `transcriptHash`、`video`、`cues`、
`segments`。`video` 包含 BVID、字符串 CID、分 P、语言、来源和 Provider。
hash 覆盖身份、来源、语言、原始文本、顺序和时间；相同输入稳定，变化后失效。
空字幕数组可建空索引；缺少/非法时间拒绝建快照，不估算或补造时间。

原始 segment 与 cue 一一对应；检索后只合并连续命中的 cue，间隔最多 3 秒、
总跨度最多 60 秒、合并文本最多 800 字符。单条原始长 cue 不拆分或估算时间。
合并文本使用换行连接原文，start/end 为所含真实 cue 的最小/最大边界。
重复文本归组到 `occurrences`，其中保留每次独立出现的 segmentId/cueIds/时间/原文。
可逐个调用 `getEvidence(occurrence.segmentId)`；原始 cueId 也可查询。
合并 segment 的查询映射保留到下一次 search；需要长期保留时保存结果的 cueIds，
这些 cueId 在整个快照生命周期都可查询。不存在或属于其他快照的 ID 返回 `[]`。

## 评分与边界

采用 NFKC/大小写归一化、中文字符二元组、英文与数字技术 token、
BM25 类词频/逆文档频率和长度评分、查询词覆盖加权、完整短语加权。
复合术语保留整体及组成 token。结果按分数排序，近重复采用字符二元组
Jaccard >= 0.9 归组（短文本只归组合并规范化后相同的文本，数字差异不归组）。
结果不足 3 条时返回实际命中数，不填充。`status: 'no_match'` 表示未匹配，
不表示视频没有讲过。分数不是概率或语义置信度，不支持同义推理。

索引仅存在内存中，不写入原有 digest 缓存。当前是全量线性扫描，长视频和大量
重复命中的去重成本仍需实测；本阶段不承诺任意长度字幕的固定响应时间。
浏览器结构化克隆后的快照需视为只读数据。不要把来源不明或模型生成的文本
作为原始 cue 输入；本地模型只能保证引用可追溯，不能证明字幕本身准确。

## 验收限制

Node/VM 测试覆盖真实数值边界的保留、证据反查、身份隔离、检索、hash 和
禁止 AI/ASR 的请求路径。它们不验证 B 站实时接口、登录态或播放器实际跳转。
当前云环境的 Chromium 管理策略阻止加载未打包扩展，真实浏览器验收尚未完成。
