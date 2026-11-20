# G2.3 真机问题修复：模式、跳转、生命周期恢复

## 根因与实际验证边界

1. 原controller在AI认证/服务失败时保留localResults，view仍以“关键词相关片段”渲染。
   这使失败状态容易被误认为AI成功结果。后台与设置页都使用chrome.storage.local中的
   ytd_settings；Mock证明有Key会进入analyzeGoal、真实HTTP401分支映射UNAUTHORIZED。
   不能据此断定用户那次测试一定401：本轮没有访问用户Chrome配置或验证真实Key。
2. handleFrontTabUrl无条件setContext(null)，onUpdated的loading、同tab重复激活、过期集合
   链接触发的导航消息都会清空快照。后台也在普通loading时删除注册快照。随后跳转被判过期。
   另有CID网络失败与真实CID错配统一报STALE_VIDEO、DOM分P与URL分P口径不一致的问题。
3. 草稿和界面只存在内存，setContext每次增代次并清结果。现有GoalCache保存分析，但没有
   “当前视频最近一次状态”的关联记录和恢复入口，无法恢复未提交草稿或中断状态。

## 修复

- 同tab+BVID+page的setContext幂等；普通窗口/页面事件不失效，真正换tab/BV/分P才挂起旧状态。
- 内容脚本导航消息以chrome.tabs.get的实际URL为准，不再把过期集合DOM链接当权威身份。
- 分P在所有跳转身份层按URL一致识别：有效p参数优先，没有p为P1，集合序号不充当分P。
- view明确标记“本地关键词检索”“AI观看路径”“AI分析失败”；失败卡片只标本地参考。
- checkConfig无Key保留免费检索；配置读取失败不冒充无Key。401显示认证错误，不自动重试。
- jump不再因失败清空有效分析；返回安全错误码和拒绝层，保留严格证据/页面/CID检查。
- 后台worker丢失快照时，controller可仅重取字幕、核对完整hash后重新注册跳转；不调AI/ASR。

## 安全诊断

调试区显示配置读取是否成功、后台是否检测到Key、模型请求标志、实际usage（没有为未知）、
错误码及跳转层。没有Key值、完整目标、字幕或远程鉴权URL的持久调试日志。

跳转代码包括：SEEK_CONTEXT_MISSING、SEEK_SNAPSHOT_UNAVAILABLE、SEEK_SNAPSHOT_MISMATCH、
SEEK_INVALID_EVIDENCE、SEEK_VIDEO_MISMATCH、SEEK_CID_MISMATCH、SEEK_NETWORK_ERROR、
SEEK_VIDEO_INFO_ERROR、SEEK_CONTENT_UNAVAILABLE及content返回的播放器/分P/时间错误。
网络失败不会被解释成视频身份变化。错误后保留原结果，可检查网络后再点击跳转；无自动模型重试。

## 持久化与恢复

新增goal/session-state.js，元数据与GoalCache分开：

- 元数据：按BVID+page关联draft、lastGoal、完整字幕身份、当前模式、分析缓存键、标签页、
  滚动与展开项。输入350ms去抖，隐藏/pagehide/上下文切换时flush。最多20条、7天、128KB预算。
- AI结果：仍放在GoalCache，按身份/hash/目标/模型/分析版本引用，不逐字重写字幕和结果。
- 重开识别当前视频后获取字幕，重建快照核对CID/hash，恢复本地结果或严格重建AI缓存引用。
- hash变化只保留草稿，拒绝旧证据并提示手动分析。缓存过期不自动请求模型。
- 上次phase=loading显示“上次分析中断，请手动重试”。恢复路径没有analyzeGoal、LLM或ASR调用。
- 当前目标清除只移除该视频状态记录，保留其他视频和分析缓存；不会自动恢复已清除目标。
- 同视频切到另一个tab再返回会恢复，但每次显示/跳转仍绑定当前tab和经过核对的身份/requestId。

恢复时对用户新编辑/主动提交也有代次保护：旧恢复流程不得覆盖新草稿、重取快照干扰新分析。

## 文件

新增goal/session-state.js、tests/sidepanel-lifecycle.test.js和本文档。
修改goal/controller.js、goal/view.js、sidepanel.js/html、background.js、content.js及对应测试。
DESIGN.md/PRIVACY.md同步说明草稿本地保存。没有改变Provider、Key配置、提示词或推荐算法。
工作区原有ASR交互变更保持，不在本轮新增ASR能力，不进入G3。

## 自动验证

```sh
node --test tests/*.test.js
node scripts/test-subtitle-provider.js
```

78项Node测试通过，0失败；旧字幕脚本通过。包含：同视频普通事件/重复激活、BV/P切换、
P1/P2 DOM冲突、无Key、有KeyAI成功、401、网络与CID不同错误码、面板重建、草稿、UI元数据
合并、有效缓存零新调用、跨视频隔离、hash变化、清除、中断、恢复跳转及旧恢复/新提交竞态。

额外在Chromium+模拟Chrome API中渲染实际HTML/CSS/JS：无Key、AI路径、缓存、错误、草稿、
同视频loading/激活、重建controller恢复等通过；280/360px无横向溢出，无页面异常。
这是Mock DOM集成测试，**不是实际Chrome扩展窗口最小化/销毁生命周期验收**。
没有读取真实Key或消耗真实模型/ASR额度。

## 本地人工复验

1. 在chrome://extensions/重新加载当前目录，刷新B站视频；确认新增session-state.js完整加载。
2. 无Key输入目标：标题为“本地关键词检索”，不得出现AI覆盖/路径判断。点击片段应跳至真实cue
   起点，字幕“目标推荐”和播放高亮共存。
3. 配有效DeepSeek Key，提交原Codex/Obsidian目标。应显示“AI观看路径”或明确AI错误；查看调试
   中配置读取、检测Key、模型请求及错误码。若UNAUTHORIZED，检查Key及账户权限，不能把本地
   参考当成AI成功。可以脱敏记录错误码，勿导出Authorization或完整请求体。
4. 有效结果后连续点击跳转，播放、暂停、切清晰度、产生分享/追踪参数等同视频事件后再点击。
   如果失败，记录错误码/拒绝层、Chrome版本和脱敏视频身份；网络错误应为SEEK_NETWORK_ERROR，
   而不是声称视频已变化。
5. 保留已生成路径，修改输入为未提交草稿，展开证据，选择目标标签、滚动到中部。
   最小化/恢复Chrome；关闭侧边栏再重开；确认草稿、路径、顺序、高亮、标签、展开项和近似滚动
   恢复。恢复过程不应出现新的DeepSeek POST或ASR请求。
6. 切另一个tab再返回：原状态恢复。切BV或同BV的P2：只显示对应状态；返回P1恢复P1。
   旧卡片不得跳到新视频。页内字幕更新后重新打开/提交检查新hash，拒绝复用旧证据。
7. 在模型仍等待时关闭侧边栏再打开：显示中断、只允许手动重试，不自动发第二个POST。
   已发送的远端请求可能仍计费；本轮不承诺撤回已经发送的请求。
8. 清除当前目标后重开：不恢复该目标，其他视频状态及缓存仍在。
9. 回归字幕、手动概览、笔记、翻译、划词解释、ASR既有按需入口；不测试新ASR能力。

## 仍需注意

- 实际Chrome最小化/面板销毁、B站播放器与真实DeepSeek认证/输出尚待上述人工复验。
- 完全关机前不足350ms的最后输入若浏览器未派发隐藏/pagehide，仍有丢失风险；已有状态不会
  因普通窗口事件被主动清空。存储满时浏览器也可能无法保存，恢复不是云端同步保证。
- 全片字幕的静默服务器修改只能在重取字幕时识别，未新增持续轮询。恢复和主动提交会重取校验。
- 缓存淘汰后只恢复草稿并提示手动重新分析。模型真实判断质量仍需验证；未调整召回/推荐算法。
