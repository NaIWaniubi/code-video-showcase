# ROADMAP-OVERTAKE · 全面超越长任务规划

> **进度标记（2026-11-21 深夜）**：S0=✅v4.7.1 · S1 taste+豁免+可读性(部分)=✅v4.8.0 · S2 教义 27/27=WARN 闸已入，`cvs style new`/三档 override/音色打通未完 · S4-1 词级字幕=✅v4.9.0 · **计划外抓到并修复 v2.9.0 内容错位回归=✅v4.9.1，并制度化为 URL 溯源闸=✅v4.9.2** · S1b 页面契约 `__textsAt`/`__ev`、S3 复刻闭环(diff/seam/Motion.md)、S5 subframe 运动模糊/cost-gate、S6 实拍消费、S7 编排+SKILL 拆分+安全审计 未动 · 新增待办：①recipe 页 `?title=` 消耗矩阵（datarace/blueprint 等仍显示内建标题）②score pacing 指标对混合节奏宣传片的再标定③QA 从「验 URL」再进一步「验像素文本」（依赖 __textsAt）。三端（fork/Gitee）已同步至 v4.9.2。

> 2026-11-21 制定。依据：四组外部调研（`E:\myzcode\_research_22\notes\G1–G4.md`，星数均经 GitHub 页内嵌 JSON 直证）+ CVS 内审 13 条缺陷（5 条高危已行级复验，见 `E:\myzcode\_research_22\CVS-BASELINE.md`）。
> 一句话总纲：**不在对手的主场作战。对手的共性短板是"不可验证"——我们用"可复现证据链"吃掉他们的能力面，把"像不像/好不好看/读不读得完"从祈祷变成闸。**

---

## 0. 目标形态（做完后 CVS 是什么）

同类唯一同时持有以下五件的：
1. **强类型 IR**（JSON Schema spec）+ 段级内容寻址增量编译（warm 1.9–3.2s）；
2. **位级确定性证据**（预览帧==成片帧 meanDiff=0、golden 基线、determinism-check）；
3. **可执行审美闸**（`cvs taste`：规则带 assert、豁免带理由、发现带帧号+hash）；
4. **可验证复刻**（`cvs ref video --diff-report`：对参考片的帧级吻合率数字，而非"99% fidelity"话术）；
5. **零网络零生成模型**的完整音画链路（含真词级字幕、60fps 运动模糊、多语配音——全部确定性装配）。

心智目标：526★ → 靠"可验证"叙事与分发补课（见 §4 分发线），不与 87k/131k/329k 打消耗战。

## 1. 22 项兼容/改装判定矩阵

分级：**A=可直接吸收（含代码级借鉴）** · **B=只借结构/契约，禁文本或代码** · **C=子进程/协议隔离调用** · **D=拒（不进产品，只作情报）**

| # | 项目 | 真实身份 | ★(直证) | 许可证 | 级 | 改装动作（详见 notes/） |
|---|---|---|---|---|---|---|
| 1 | Concat | jub0t/Concat 本地 NLE | 19,260 | AGPL-3.0 | **C** | `cvs caption` spawn headless MCP 只取词级时间戳 JSON；0..1 归一化坐标系进 cvs edit/frames；schema→MCP inputSchema 生成器。**禁搬代码** |
| 2 | MotionGit | .motion 开放格式 rc.1 | 站点真 | 逐模板 | **A(格式)** | `cvs ship --emit-motion`（纯打包）；theme 变体层=safe 维 token presets。**占位窗口期** |
| 3/21 | OpenMotion ≡ OpenDesign Motion（清单重复） | nexu-io/openmotion（引擎=HF pinned） | 9.5–14k | Apache-2.0 | **A** | spec⇄**Motion.md** 互转；五维 rubric 进 ref 拆解；Keep/Replace/Generate 三分进反推产物；revision-check 乐观锁进 edit/build |
| 4 | SkillVideo | workbuddy/skills **不存在**（三条路径核验） | — | — | **D** | 删除；需求并入 #10 的 shader-transitions/media-treatment/captions 组合 |
| 5 | Lemo-Opuscar | 99 风格×12 维教义（清单写66错） | 19k | 代码MIT/**文档CC-BY-NC** | **B** | `content/style-doctrine.json` 抄 style.json **字段结构**禁抄文本；`window.__ev/__textsAt` 页面契约→QA 可读性闸；三档可变性→lint（我们加机器闸它没有） |
| 6 | Awesome Opus 5.5 Videos | videos.json 703条/13字段（418=remake子集） | 16k | MIT但**prompt归作者** | **B** | `cvs bench`：703 条本地评测（new→lint→plan 结构合法率/风格命中率），**绝不进发行物** |
| 7 | PDoomVideo | 156s 水彩 MV+并行施工指南 | 3k | **无LICENSE** | **B(思路)** | shots 层进 spec；cast 注册表+E_CAST_MISSING；**每帧预算 cost-gate**（frameBudgetMs）；safe() 字幕带；PARALLEL-EDIT 纪律 |
| 8 | Opus Video Prompts | 9路线/54案例/6段骨架 | 1.2k | **无LICENSE** | **B(思路)** | route-map.json；**Banned 反模板味**→cliché 元数据+E_CLICHE_FORBIDDEN(premium)；**subframe+tmix 60fps 运动模糊**（最大画质弹药）；cvs cost 查表 |
| 9 | Taste Skill | 发牌+GATE状态机+waivers | 119,421 | MIT | **A** | GATE/waivers.json 模式整体吸收；检查 ID 命名法→spec-lint；CVS 版发牌按画风不按行业重建 |
| 10 | HyperFrames | **头号对手**：HTML→MP4 契约12条/9skills/diff闭环 | 87,541 | Apache-2.0 | **A(概念)** | 契约 4/7/9/11 条→lint 规则；`cvs diff`（成片vs参考）+`measure cuts`；**skills 版本对齐安装**；safe-box 90/80 叠加层；registry→templates 可查询索引 |
| 11 | Agent Desktop | OS 无障碍树协议 snapshot-ref-verify | 26k(shields) | Apache-2.0 | **A(纪律)** | Web E2E 用已有 playwright-core 抄协议不抄实现；只做结构断言 |
| 12 | Hallmark | 58 编号 slop 门+genre 豁免+stamp-lies | 59k | MIT | **A** | 12+ 可判定门→spec-lint；APCA 双档口径合并；audit 分组输出格式→cvs audit；genre scope 是防误判根基 |
| 13 | Impeccable | **62 确定性规则 Rust 检测器**，三层引擎/exit0-1-2/豁免四件套 | 114k | Apache-2.0 | **A(蓝本)** | `cvs taste`/`cvs audit` 工程形态全抄概念：finding schema、severity 分层、advisory 永不拦、--report-unused-ignores、/20 评级带 |
| 14 | T3 Code | 事件溯源控制平面 | 68,200 | MIT | **A(模式)** | awaiting_approval(默认关)+per-job SSE+"ack=意图提交"+方法级授权；手机批准更廉价的获得=跑在编排器里 |
| 15 | Orca | 多agent worktree 编排IDE，**官方支持ZCode** | 131,212 | MIT | **A(外部)** | 外置编排跑 CVS MCP；**成片回收走 artifacts 拷贝不走 merge**；api.mjs 加 dependsOn 任务图边；夜间 demo 全量 build+qa |
| 16 | Matt Pocock Skills | user/model-invoked 双轴+薄指针 | 329,113 | MIT | **A** | **SKILL.md 35KB→≤6KB 路由**，§3-§12 移 references/；与 MCP 同动词表 |
| 17 | CF Security Audit | 三判决+覆盖账本+验证者≠发现者 | 76,375 | MIT | **A** | 对 CVS 真审一轮→references/security-audit.md：ledger 单元=攻击面×(lint|qa)覆盖声明，审计产出 lint 补丁清单 |
| 18 | VoiceStudio | 20 TTS/9 ASR 工作台+MCP :3900 files模式 | 115,545 | AGPL+**权重CC-BY-NC** | **C** | `cvs voice --backend auto|voicestudio|piper|synth`：探测→缺失自动降级零回归；cache-key 沿用 ai-lane；产物元数据记 model+license；**默认权重禁商用** |
| 19 | Prompt Optimizer | 迭代优化闭环+变量模板+Arena | 42k | AGPL-3.0 | **D→B(概念)** | `cvs new` 槽位化 brief+空槽追问；`--variants 3` 全过 lint 才并排。**LLM 循环不进 spec 冻结后** |
| 20 | Three.js 案例库 | 9,216视频/1,495prompt/10类/保真四级；Elo盲投 | 站真 | 自定义 | **B(元数据)** | taste-corpus.json 挂真实参照；`cvs duel` A/B 盲投只当趋势报表。**Elo 绝不进硬闸** |
| 21 | (=#3) | — | — | — | — | — |
| 22 | 合集项 | 即 9–18 的再打包 | — | — | — | 无增量 |

**清单纠错**：#4 不存在、#3=#21、#5 是 99 风格非 66、#6 是 703 prompt（418=remake 子集）。
**明确不做**（写进对外文档防误解）：实时预览 NLE、多轨 GUI、生成模型进主链、wgpu shader 运行时、TTS 云端 API、自研编排引擎。

## 2. 阶段规划（每片独立可验收）

### S0 可信度修复（P0，先行，1 天）——「假绿不复发」
已行级坐实的 5 高危 + 口径修复。**验收：新增命名测试逐条钉死；`npm run test:all` 含 golden+perf。**
- S0-1 `mcp/server.mjs:182` planPath 改 `--plan` 传参；`qa.mjs` 实现 help 承诺的 `./out/plan.json` 缺省 + plan 缺失时 QA 显式 WARN `W_NO_PLAN`；测试 test-mcp-server 断言 `cvs_qa` 子进程 argv 含 `--plan`。
- S0-2 `plan.mjs toolchainFingerprint` 纳入 Chrome/Edge 版本（与 golden.mjs 同口径）；首建缓存自然失效一次，CHANGELOG 声明。
- S0-3 `film.mjs` 把 ovMap 真正传入 `writeFilmProject→buildFilmHtml({overridesByClip})`；测试断言 film.html 出现 `overrides=`。
- S0-4 `templates/spec.mjs`/lint：页面内 **bare import 直接 E_PAGE_BARE**（零依赖是卖点，升级为硬闸而非支持之）。
- S0-5 test-golden/test-render-perf 注册进 test-all（perf 走 `--quick` 档防 CI 超时）；`npm run gate` 纳入 determinism。
- S0-6 ingest→渲染断层（F4）：`spec.assets[kind=video]` 尚无渲染消费者 → 本阶段先 **lint 拒绝 video 资产 + README 边界声明**（半成品不留），真消费层放 S6。
- S0-7 口径钉：schema↔spec.mjs 三处不一致修齐（audio.vo/flash.count/id 正则）；score 缺 --plan 的 exit13 修复+叙事维真判（读 copy 非 id）；docs 计数全量对账（27 画风/159 码/17 主题表）+ version-sync 正则修复。

### S1 审美裁判机（P0，~3 天）——「好不好看变成闸」
蓝本=impeccable 工程形态 + hallmark 58 门可判定子集 + taste 的 waivers。
- S1-1 `schema/taste-rules.json` v1 **18 条**（12 spec 级：字体≤3/spacing刻度/no-gradient-text/italic-display/accent≤5%/chroma≥0.005/APCA Lc≥60/45 双档/黑压黑/占位词/编造数字 regex/转场多样性≥2；6 帧级：主色距 token/暗底光晕/空白帧能量/字占比/爆帧/效果连续N段），每条 `{id,from,severity,input,assert,genres,waivable}`。
- S1-2 `cvs taste <spec> [--frames] [--json] [--sarif]`：exit 0/1/2；finding 带 `frame+segmentHash+value+threshold`；`.cvs/waivers.json` 豁免（理由必填）+ `--report-unused-waivers` 过期即 FAIL；advisory 永不拦。
- S1-3 页面契约扩展：可选 `window.__ev`、`window.__textsAt(t)→[{id,text,x0,y0,x1,y1}]`；进 segmentHash 参数面；golden 页先行。
- S1-4 QA 可读性闸：文本停留≥max(1.8s,speech+0.6s)、包围盒重叠、越 safe()（safe() 补字幕带，PDoom 启示）；test-type-tokens 扩断言。
- **验收断言**：同 spec 双跑 taste 分必相等（确定性）；fixtures 金样 18 规则各 1 正 1 反；waiver 生命周期（加→用→过期 FAIL）测试过；`cvs build` 默认不拦、`--strict` 拦 error。

### S2 画风升维 + 反模板味（P0–P1，~3 天）
- S2-1 `content/style-doctrine.json`：现有 27 画风×12 维（**自写文本**，结构借 opuscar style.json 字段命名：essence/notStyles/material/colourLogic/typeRules/motionQuality/cameraGrammar/soundPalette/nativeMoves/pitfalls/engine/variationSpace + uses/aliases/mutable 三档）；`E_DOCTRINE_MISSING` 闸；build-combos 消费 uses[]。
- S2-2 三档可变性 lint：look.overrides 只许动 safe 维；碰 core 维 WARN `W_DOCTRINE_CORE_TOUCHED`；全改 can't → style 应改名。
- S2-3 `cvs style new <一句话>`：五步（plan→summary→单帧→demo→keep），产物=recipe 页骨架+doctrine 条目+style-pages 加行+golden 入册。
- S2-4 cliché 治理：26 效果标 `cliche:true` 元数据（不删）；nl2spec 降权；`--profile premium` 命中 E_CLICHE_FORBIDDEN；score 第六维"模板味"反查。
- S2-5 sound palette 打通：synth_audio.py 读 doctrine.soundPalette（兑现"画风=音色"宣称）。
- **验收**：27 画风 doctrine 全覆盖 lint 过；cvs demo 全量出片回归 golden；改 safe 维只重渲 dirty 段、改 core 维 WARN。

### S3 复刻闭环（P1，~1 周）——「像不像变成数字」
- S3-1 `cvs ref video` 升级：BPM 自相关保留 + **cut 级对齐**（ffmpeg scene+audio onset，确定性）+ 五维拆解视图（hook/shot/pacing/type/sound，借 OpenMotion rubric 自写）+ Keep/Replace/Generate 意图字段。
- S3-2 `cvs diff <ref.mp4> <mine.mp4> [--report]`（impeccable-diff/HF diff 概念）：切点误差分布、逐秒色彩距离、**帧级吻合率 verdict**；进 MCP `cvs_diff`。
- S3-3 **seam gate**：motion-doctrine 向量账本静态化——plan 生成时校验相邻段 exit/entry 方向一致（本机资产，纯静态零依赖）。
- S3-4 格式桥：`--emit-motion`（.motion rc.1 包）+ `spec⇄Motion.md`（导入=五维段落解析成 rounds 建议）。
- **验收**：对 fixtures 参考片 diff 报告吻合率可复现（双跑同分）；emit-motion 过其 conformance 样例结构校验；真实片反推→emit-spec→build 全链 e2e 绿。

### S4 真字幕与声音（P1，~1 周）
- S4-1 本机优先 ASR：`cvs caption` 默认走**已装 faster-whisper**（python 子进程，词级戳 JSON 落盘为 spec 输入→进哈希保确定性）；Concat MCP 作可选高质量后端（AGPL 隔离带，文档写明）。
- S4-2 `cvs voice --backend auto`：探测 VoiceStudio :3900（MCP files 模式）→piper→内置合成三级降级；产物元数据 model+license；缺省零新依赖。
- S4-3 词级对齐：vo.words 字段+QA「词高亮 vs 旁白偏差≤120ms」；`--burn-subtitles` 走 safe() 字幕带。
- S4-4 多语出片：variants×翻译（VoiceStudio dubbing 三段式思想，自有实现）；646 语言宣传语**必须标注依赖外部引擎**。
- **验收**：41s fixture 全链（caption→voice→build→qa）在纯净 Windows 机一次通过；无外部后端时与现状字节级一致（降级零回归）。

### S5 画质与吞吐（P1，~3 天）
- S5-1 `--subframes 3` + tmix：**60fps 真运动模糊**（opusprompts 技巧；默认关，参数进 segmentHash）。
- S5-2 cost-gate：render-farm 汇总 ms/frame，p95>frameBudgetMs 报 WARN→FAIL 两档（PDoom 预算纪律）。
- S5-3 grain 纪律：颗粒交 ffmpeg 不进页面（它省 3× 体积）；效果卡预览图 `cvs image --effects`。
- S5-4 空载重测冷/warm 基线（本轮 835s 数据作废），写进 README 实测表。

### S6 实拍与外部时间线（P2，~1 周，含 S0-6 的正面解）
- `<video>` 消费层：asset kind=video 真进画面（drawImage+seek 契约 `frame(t)` 语义），EDL/OTIO 回填、shots 层（PDoom）、cast 注册表。
- **验收**：真实素材 20s 卡点片一条命令出；无素材路径位级不变。

### S7 编排、安全与分发（P1–P2，贯穿）
- S7-1 安全：对 CVS 真审一轮（CF 方法论：三判决/覆盖账本/验证者≠发现者）→ references/security-audit.md；api.mjs 方法级授权+SSE 事件流+awaiting_approval（默认关）。
- S7-2 编排：Orca 外置跑批量 spec（worktree 并发、artifacts 回收不 merge）；dependsOn 边进队列。
- S7-3 SKILL 拆分：35KB→≤6KB 路由+references/；与 MCP 同动词。
- S7-4 **分发线（与 S0 并行启动，最高 ROI）**：
  - 推 48 提交 + 发 v4.7/v4.8 release + CI badge（workflow 文件推上去即有）；
  - `cvs bench`/`cvs taste`/`cvs diff` 各配 **一条 demo 成片入库**（仓库至今无成片——README:163 自认）；
  - 模板详情页：每画风静态页（预览帧+参数+prompt 一键复制）；
  - 对标叙事文：《HyperFrames 说 same input same video，我们出示哈希》；ChatGPT/Claude 插件市场三端分发学 HF；
  - skills 版本对齐安装（随 tag 不随 main）。

## 3. 依赖与顺序
S0 → (S1 ∥ S7 分发) → S2 → S3；S4/S5 可与 S2/S3 并行（不同文件域）；S6 最后（依赖 cost-gate 与 shots 层）。
冲突热区（一次只开一个 builder）：`spec.mjs/schema/plan.mjs`；`qa*.mjs`；`style-pages/combos/COVERAGE`。

## 4. 风险登记表
| 风险 | 缓解 |
|---|---|
| CC-BY-NC/AGPL 文本污染（opuscar/promptopt） | 只进字段名与枚举事实；PR 禁 copy-paste 外部仓文本；THIRD-PARTY 增"协议隔离后端"节 |
| ASR/TTS 非确定破坏卖点 | 输出落盘为 spec 输入进哈希；降级路径字节级不变测试 |
| 审美规则误判烧信任 | 三层 severity+genre scope+waivers 生命周期+「误判必附复现帧入 fixtures」流程 |
| Elo/主观分被当硬闸 | 只出趋势报表，代码级禁止进 exit code |
| worktree×N 磁盘（本机仅 20GB） | 编排文档标并发上限；缓存目录共享实测 |
| 无 LICENSE 项目（pdoom/prompts） | 思想用自己的话进 docs，不引原文 |
