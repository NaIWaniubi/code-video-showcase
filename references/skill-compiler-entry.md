> 自 SKILL.md §0.0 + §0.5（AGENT 执行契约与编译器入口细节）拆出，2026-11-24。

## 0.0 AGENT 执行契约（先读这 30 行）

**唯一入口**：`project.spec.json` + `cvs lint → cvs build`。不要走 §12 的 timeline 快速启动——那是 timeline v1 兼容路线，plan 没有 `segmentHash`，增量、单段动效、品牌色覆盖会**静默失效**。
**唯一产物**：`<outDir>/master.mp4`（`final.mp4` 已废弃）。母版永远按 master 预设出 1920×1080；`--platform` 是**附加**文件。

**完成定义（缺一不可，禁止「看起来对」）**：① `out/master.mp4` 存在且 `ffprobe` 含音频流（或已显式 `--no-audio`）；② `qa/qa-video.json` `summary.fail==0` 且无 `placeholder pages` FAIL；③ `qa/qa-audio.json` `summary.fail==0`（有音轨时）；④ `render-manifest.json` 无 `failed`/`frame-mismatch`；⑤ plan 与成片参数不含 `{{BRAND}}`、`风格段标题`、`替换 drawScene()`。

**四条硬断言**：`build` 自动合成 `spec.audio`（无音轨必须显式 `--no-audio`，不静默出默片）；`--resume` 同时校验帧数 + manifest hash（`cache hit` 才代表内容没变）；`--root` 默认 **cwd**（`E_PAGE_MISSING` 多半是 root 错了）；交付态加 `--strict`（QA warning 也算失败），迭代态可不加但要知道自己在迭代。

**报错 → 唯一动作**（完整表 143 码见 `docs/ERRORS.md`）：

| 前缀 | 唯一动作 |
|---|---|
| `E_PAGE_*` | 检查 `--root`；远程页默认禁止 |
| `E_THEME_*` / `E_APCA` / `E_ACCENT` | 换主题，或改 `look.accentOverride` |
| `E_BRAND_*` / `E_TITLE_*` / `E_FORBIDDEN_WORD` | 填真实品牌/标题/文案，不要留占位符 |
| `E_UNKNOWN_FIELD` / `E_COPY` | 删拼错的字段；自定义参数放 `style.params` |
| `E_DURATION*` / `E_STRUCTURE*` / `E_ROUND_*` | 改 `structure` / `rounds`，不要手改 plan |
| `E_AUDIO_*` | 装 numpy/scipy，或传 `--audio`，或 `--no-audio` |
| `E_RENDER` / `E_CONCAT` / `E_QA_*` | 看 `error.json.failedSegments` 或 `out/qa/*.json` 的 FAIL 项 |
| `E_ASSET_PATH` / `E_ASSET_MISSING` / `E_LOGO_MISSING` | 素材/logo 必须在项目根内且真实存在 |
| `E_BURN_SUBTITLES` / `E_COVER` | 换 ffmpeg（需 libass），或去掉该开关 |
| `E_SNAPSHOT_TAMPERED` / `E_ROLLBACK_HASH` / `E_ENV_MISMATCH` | 快照被动过 / 环境与基线不同：`cvs verify`、`golden --selfcheck` |

**退出码**：0 ok · 2 用法/配置错 · 10 spec · 11 render · 12 concat · 13 qa · 14 env。`cvs taste` 单列：0 无拦截发现 · 1 有 error 级拦截发现（或 `--strict` 下 warning 计数超阈）· 2 用法/规则表/豁免表配置错（E_TASTE_ASSERT 等启动即错，绝不误当"干净")。

## 0.5 编译器入口（新项目优先）

新项目不再从 timeline.json 起步，而是从 `project.spec.json`（IR）起步：

```bash
node bin/cvs.mjs lint  project.spec.json --root .            # 页面/主题/APCA/占位品牌/标题
node bin/cvs.mjs plan  project.spec.json --root . --print
node bin/cvs.mjs build project.spec.json --root . --platform douyin --strict
```

- **spec 是唯一真相**：文字、画风、主题、时长、剧本都改 spec；不要手改 `plan.json` 或段 mp4。
- **音频**：`spec.audio` 存在时 `build` 自动合成并 mux；不要音轨须显式 `--no-audio`。
- **平台版**：`spec.render.preset`（或 `--platform`）额外产出 `<outDir>/<platform>.mp4`，master 始终保留。
- **再来一版**：`cvs again --set look.theme=amber-noir` 读上次 spec、只重编译 dirty 段。
- **交付清单**：`cvs deliver` 产出 `delivery.json` + `master.srt/.vtt`。
- **增量**：每段 `segmentHash` 含页面及依赖内容哈希；`render-farm` 先查 `<outDir>/.cache/<hash>.mp4`；改页面/模板也失效。
- **内容参数**：`meta.title/description`、`opening.title/sub`、`style.copy{title,subtitle,caption}` 由 plan 下发到段 URL；页面不回退占位文案。
- **单段动效**：`rounds[].style.motion` 覆盖全局档位；未知字段报 `E_UNKNOWN_FIELD`。
- **品牌门禁**：`brand apply` 写入 `meta.brandKit`；`build`/`lint` 对禁用词/logo/品牌色对比度 error 级拦截。没有 `brandKit` 不做品牌检查。
- **字幕与封面**：`build --burn-subtitles` 只给投放版加硬字幕（母版永远干净）；`build --cover` 用 `cvs image` 出 card 版式封面；都如实记进 `delivery.json`。
- **版本闭环**：`cvs snapshot --label 首版` → `history` → `verify v001` → `rollback v001`；回滚**先校验再写盘**，快照被改过 exit 13。
- **母版契约**：`master.mp4` 永远 1920×1080（master 预设）；`--platform` 是附加文件，QA 量的始终是母版。
- **排版 token**：`templates/tokens.mjs` = 4 级字阶 + 唯一安全区 `safe()`；新页面必须 import 并写 `window.__typeProbe`，否则 `test-type-tokens.mjs` 红。
- **页面编辑契约（D3）**：编辑入口只有 `__patch` / `__patchMany`；`SPEC.params` 是 patch 的合并基座；空文本不注册命中区。细则见 `docs/DECISIONS.md` D3。
- **占位文案**：beat 缺 `copy` 时填内置缺省值并发 `W_COPY_DEFAULT`（warn）——看到就补 `beats[].copy[]`。
- **渲染器恢复**：`--timeout`(120s) 与 `--launch-timeout`(30s) 独立；页面抛错杀 ffmpeg + 浏览器进程树，重启换全新 profile——失败不挂住、不留孤儿。
- **失败对象**：`logPath` 恒指构建日志；`detailPath` 是阶段诊断产物（render/concat/deliver 各自的清单或日志）。
- **确定性检测**：`golden` manifest 记 Chrome/Node/字体指纹；环境不一致跳过哈希比对并告警（`--strict-env` 改失败）。跨机可比前提 = 同一镜像 + 同一字体锁。
- **统一入口**：`node bin/cvs.mjs`（34 个子命令，`cvs --help` 全列）。`cvs ui` 一个端口起齐六个界面（5180，`/app/` 是首页）。
- **参考图/参考片**：`cvs ref poster.jpg`（图：色板/强调色/密度与 top-3 主题候选，不复制像素）；
  **`cvs ref video demo.mp4`（片，旗舰反推）**：ffprobe+切点+逐秒采样+k-means 主题匹配+BPM 自相关
  → 结构模型（opening/rounds/card/flash…）+ spec patch，`--apply` 直接并入既有 spec（不毁用户内容）。
  启发式结果带 confidence/notes/残差，**不承诺像素级还原**。
- **动效档位**：`look.motion` 选 `calm|standard|dynamic|maximal`，不写按「类型 × 画风」推导；换档位改变画面并触发重渲染（进段哈希），写 `standard` 与旧成片逐像素一致。
- **画风 → 页面**：`templates/style-pages.mjs` 是唯一真值（20 画风 → 渲染页）；生成端按表填 `style.page`，未知画风回落通用场景页，新增配方页只加一行。
- **强调色覆盖**：`look.accentOverride` 展开成段 URL 的 `?accent=/accentInk=/accentSoft=`，进 `segmentHash`（换品牌色必重渲染）；没有覆盖时 URL 不变。
- **代码生图**：`cvs image --spec project.spec.json` 用同一 spec 出图集（cover/card/poster/story，`--list` 全部；默认画风段 78% 处），产物带 `image-manifest.json`（每张 sha256）。
- **逐帧实时预览**：`cvs frames [--spec f|--plan f|--video f|--dir d]` 打开 `app/frames/`（5186）。帧号是唯一时间轴（`t = n/fps`，段内 `i/fps`，与渲染器同一量化）；spec 源在 iframe 里直接 `renderFrame`（~1ms/帧，不读回像素），视频源用 ffmpeg 逐帧解码，图片源按目录翻页。`scripts/test-frames.mjs` 断言 live 画布与服务端 PNG **逐像素相等**。
- **spec 是不可信输入**：id 匹配 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`；页面路径禁绝对 URL/路径/`..`/编码穿越；`flash.count`≤256、单段≤600s、总帧≤18000；outDir 钉在根内；API 默认同源、错误信息抹本机路径。
- **界面**：`cvs ui`(5180) 一个端口挂齐六个界面（`app/index.html` 是首页）；也可单独 `app/wizard/`(5181)、`app/canvas/`(5182)、`app/script/`(5183)、`app/versions/`(5184)、`app/review/`(5185)、`app/frames/`(5186)、`server/api.mjs`(5190)。
- **旧项目**：timeline v1 仍完全可用，`spec.mjs` 自动迁移；`render-farm` 默认 batch 模式（一个 worker 一个浏览器跑一个 shard），`--legacy` 回退逐段进程。页面按视口自适应（横/竖/方真重排），16:9 输出位级不变。
- **质量闸门**：`npm run test:all`（纯 Node）、`npm run test:browser`、`npm run golden`（静帧位级回归）、`npm run brand -- check …`。
- **配方页**：21 种画风中 19 种有专属页（`templates/recipe-*.html` + `cyber-pixel.html`，含 v3.1 的 generative），映射单一真值 `templates/style-pages.mjs`；**实拍素材** `cvs ingest` 出 EDL + spec 草稿（启发式，需人工审）。
- **覆盖扩展（v2.5）**：段间转场 35 种（`--transition`，xfade 在拼接层做，默认关闭逐字节不变）、确定性效果库 26 个（`templates/effects.mjs`）、风格 20 种、领域 24 种。
- **程序化生成画风（v3.1）**：第 21 风格 `generative`——`templates/generative.mjs` 四族纯核（流场群游/轨道环系/脉冲波/弹跳字）+ `recipe-generative.html`，关键词「生成式/程序化/procedural/粒子」即命中；向导与 combos 矩阵同步 17×21。
- **导演演示集 + 一键出片（v3.2+）**：六个颠覆性演示风格 `wireframe`(白模线框)
  `skeleton`(骨骼动画·走 cycle 闭式关节链) `fractal`(L-system 分形生长)
  `firework`(弹道粒子喷泉) `terrain`(marching squares 等高线测绘)
  `network`(图拓扑脉冲流量)；`cvs demo <style> [--seconds n] [--platform gif|webm|mp4]`
  直接排片出成品，`cvs demo all` 批量出片 + manifest。
  v3.3：frames 工作台「导出段表」→ `cvs build --segment-patch` 剪辑闭环；
  反推 `--max-seconds` 长片上限 + contact-sheet 证据图；向导向加演示集入口。
  v3.4：`demo all --concurrency`（钳 ≤2）/`--retries` 重试；向导新增参考片上传
  （拖一条成片 → 服务端反推 → 一键套用主题/BPM/时长）；帧工作台导出加 copyPatch
  文案回填（split 后各片段各自成卡）；golden 位级基线新增 demo-skeleton。
  v3.5：上传带字节级进度与取消；参考素材入口合并（图/片按类型自动分流）；
  `demo --only a,b,c` 子集批量（任何批量都留 manifest 凭据）；
  frames「段表」——时间→标题可视化内联编辑，直接进导出。
  v3.6：`cvs ship <spec>` 交付物打包（自研 ZIP，spec+成片+字幕+清单+自动 README，
  竞赛四件套同形；缺成片如实退 13）；`cvs qa` 双闸聚合（视频+音频一次跑，任一 FAIL 即整体 FAIL）；
  doctor 加编码器能力探测（VP9/MP3lame/Opus/subtitles）；npm run gate 发布门禁。
  v3.7：`ship --check` 打包前先跑双闸（未过拒打包，`--force` 可强出）；新增 `cvs health`
  一键全身体检（doctor+错误码矩阵+golden 位级基线，出健康 JSON）；参考反推 top-3 主题
  候选做成可点小色块；SKILL/package/CLI/CHANGELOG 四方版本号由钉子锁死同步。
  v3.8：ship 交付包自带 QA 报告（--check 时质检结论入库，接收方免重跑）；
  `cvs build --ref-patch <反推补丁>` 把参考片结论（主题/BPM/结构）直接并入再编译；
  health 增至五项（+fixture lint）。
  v3.9：`cvs ref video <片> --emit-spec new.spec.json` 一步把反推结构展开成
  可直接编译的新片 spec（精确闭合；参考片→新片的终极闭环）。
  v4.0：agent 向剪辑 `cvs edit <spec>`——结构四件套（split/drop/move/trim）默认 dry-run、
  lint 验证后再落盘，D 公式恒闭合；导出 EDL/OTIO 行业交换格式；
  帧工作台建议层（GET /frames/api/suggestions → ruler 虚线切点可点套用）；修复 v3.1 起
  undoEdit 未定义导致工作台加载即崩、attach 内 m 未定义导致控件集体失灵的潜伏缺陷族。
  v4.1：预览帧 == 成片帧的位级硬证据——frames 服务端取帧可连入同进程浏览器
  （rendererEndpoint），实测 meanDiff=0；根因修复 withSegmentParams 在预览路径上剥掉
  theme/layout 等查询（服务端与 live iframe 渲染的根本不是同一页面）。
  v4.1.1：D7 位级钉修复——基线改「解码像素灰度摘要」（Chrome JPEG 编码器非确定，
  R2-11 老定论）；内容形态经 --keep-page-params 恢复真保护；reflow-pages 双连跑 55/55。
  v4.2：工作区编辑历史指针式化（撤销/重做全往返，Ctrl+Shift+Z / Ctrl+Y）；
  `cvs edit <spec> --suggest` CLI 建议层（与 HTTP 端点同口径）。
  v4.2.1：审查修复——`--apply` 名存实亡（旧版写到固定名 project.spec.json、原文件未动），
  现原子写回原文件并自动 `.bak`；建议切点口径收敛内核单一真值。
  v4.3：剪辑闭环索引空间修复——frames 导出的段表与 rounds 错位（旧版静默错轮合并）；
  compile 按 roundId 定位 + id 对齐校验，frames 导出只回填文案进 copyPatch，
  结构改动记 notes 如实告知（成片结构改动请用 cvs edit）。
  v4.4：新增 MCP stdio 接口（npm run mcp）——任意 agent（Claude Desktop/Cursor/
  Claude Code/ZCode…）一行 command 接入，10 工具覆盖全链路；写盘工具默认 dry-run。
  v4.5：MCP 接口实测打磨——补 cvs_image 出图工具；修正 build 的 apply/seconds 语义；
  cvs_build 支持 concurrency 与 outPath。
  v4.6：对标 OpenFilm 生态补「复刻度量」（ref video --compare：切点对齐/节奏/
  色彩/色板四维评分）；nl2spec 题材专属画风优先 + ≥10s 双轮结构；QA 音轨闸
  以母版为准。
  v4.7：补 OpenFilm 对标强项——cvs film 导出 OpenFilm IR 时间线（overrides 非破坏层 +
  locked/hidden 轨道语义，回 spec 可重编译）；cvs score 五维主观质量评分。
  v4.7.1：可信度修复——cvs_qa(MCP) 显式 --plan（假绿灭）·段缓存指纹含渲染浏览器·
  film --overrides 真正落片·E_PAGE_BARE 硬闸·score 缺 plan 不炸且标题读真文本·
  gate 纳入 determinism 与 golden。
  v4.8：**cvs taste 审美裁判机**——`schema/taste-rules.json`（数据）× `scripts/taste.mjs`
  EVALS（数值断言实现）14 条规则；error 硬闸 / warning 扣分（100−Σw）/ advisory 永不拦；
  对比度口径单一真值消费模板层 auditApca；`.cvs/waivers.json` 豁免生命周期（error 不可
  豁免、过期豁免点名）；上线首猎修掉 4 项主题对比度缺陷（crimson accent 19.4→#d63f3f，
  ENGINE_VERSION 2→3，golden 已刷新）。`cvs build --strict` 语境下 taste 是 ship 前置闸。
  
- **派生导出格式（v3.1）**：`--platform webm|gif|mp3` 从 master/音轨直接转码（不经 shell 的 mp4+AAC 链），交付清单按扩展名入列。覆盖矩阵单一真值 `docs/COVERAGE.md`。
- **禁止**：让 LLM 直接生成 HTML/CSS/JS，或绕过 spec 直接改像素。模型只填枚举与文案。
