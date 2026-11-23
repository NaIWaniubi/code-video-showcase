# ROADMAP-GAPS-2026-11 · 全面优化升级总规划

> 2026-11-23 制定。输入：六路并行深度审计（引擎确定性 14 finding / QA闸面 13 / ROADMAP对账 10+全量表 / CI分发 15 / 安全 10 / 生态增量 13），
> 全部带 path:line 与本地复现。基线 v4.10.1（`11dd73c`）。本文取代 ROADMAP-OVERTAKE.md 的进度标记；那份文件的 §1 矩阵与 §2 切片设计仍然有效，
> 本文只做三件事：①宣布 S8 破案与修复路线 ②把 61 条 finding 去重合并成 G 切片序列 ③矩阵增补第 23-24 行。
> 一句话总纲：**先让每一盏绿灯可信，再让每一句卖点有实物，最后才谈擂台。**

---

## 0. 本次调研的最大产出：S8 定案（不是 SwiftShader，是 CDP 回读链）

三层隔离实测（640×360 同页同参各三连跑，产物在 %TEMP%\cvs\s8\）：

| 捕获路径 | 结果 | 说明 |
|---|---|---|
| raw（recipe-flat 裸 canvas） | 3/3 逐字节同 | 正常 |
| canvas（--capture canvas 强制） | 3/3 逐字节同 | 正常 |
| **cdp（segment.html/big-card 默认 auto）** | **6 次里 2 次偏离**（PSNR≈73dB，LSB 级） | 病灶 |

机理：`visibleOverlay` 启发式（render-segment.mjs:596-599）把 canvas 的**布局父节点** `#stage` div 误判为「可见覆盖层」→ 强制走 `page.shot()` 合成器截图路径。该路径不仅非确定，还比 raw 慢 4×。
附带三处结构性失明：nightly 探针不吃 --capture/--width（复现配置无法表达）、判据只比整只 mp4 的 sha（无 framemd5 分层归因）、Chrome 参数注入面不存在（extraArgs 形参无人传）。

**裁定：修 forward，不降口径。** 修复后全部内建页回到确定性捕获路径，「同输入同字节」对外承诺保持满格；文档补一节「捕获层与幂等」把 raw/canvas/cdp 三径与哈希面讲透。

## 1. 兼容矩阵增补（接 ROADMAP-OVERTAKE §1）

| # | 项目 | ★/状态（11-23 直查） | 级 | 动作 |
|---|---|---|---|---|
| 23 | OpenFilm openfilm/openfilm | 9,052，建库 10-04，v0.4.1 | **A(概念)+威胁** | 撞定位语「same t same picture」+subframe+overrides 三件待办。反制=哈希证书实物化（G9）；film.html/overrides 既有实现做对位差异表 |
| 24 | 确定性赛道碎片化 | Pellicule 78★/vueseq/beatframe 等已用 "deterministic" 命名品类 | **A(叙事)** | 差异化从「这个词」前移到「这个证据链」：产物哈希证书 + 跨机重放验证器（全场 0 家做过）。**G9 落地前不发擂台文** |

其余增量裁定：HyperFrames 本地捆绑 GSAP→「零网络」降级为及格线，叙事让位给哈希证明；Remotion OTIO 标配化→S6/G10 的 OTIO 从 P2 提级；Motion Canvas/Revideo 停摆→对标文反面教材；skills.sh（HF 三件套 1.6M 安装）=CVS skill 上榜为 G11 分发首项；openfilm community 注册表逐文件 sha256 清单纪律→G11 吸收。

## 2. G 切片序列（每片独立可验收；热区一次一个 builder）

### G1 门禁可信（P0，一切的地基）· 文件域：.github/workflows/*、scripts/test-all.mjs、scripts/test-summary-parse.mjs、scripts/test-render-perf.mjs
- G1-1 compiler.yml:40 `| tee` 吃退出码（GitHub 默认 shell 无 pipefail，实测 ok:false 仍绿）→ `set -o pipefail` 或先跑后 tee。
- G1-2 test-all 聚合说谎：失败套件 `failed:null→0`（CI 报告 `"failed":0` 与 `"ok":false` 同屏）；summary-parse 只扫末尾 12 行漏掉 test-compiler-contract 的 5 条失败与新套件断言数。修法：套件 exit≠0 必计 failed≥1 且 `ok:false` 与 failed 计数强一致；解析器改全量扫。
- G1-3 test:perf 未注册 + 无 --quick 档；golden 只在 --browser 组。S0-5 验收补齐：perf 进 UNIT（--quick），golden 进 BROWSER 并由 render-smoke（G1-4 修好后）真跑。
- G1-4 render-smoke 卡 theme-audit（28 跑 18 败，其后 VMAF/真渲染从未执行）→ 根因在 G3-5（HUD 假数）与 G2 系列；修好后该线必须走到「Render 2s + Video QA」终点并产 artifact。
- G1-5 nightly Chrome 安装行 `apt install ./x.deb || apt -f && apt install x.deb` 优先级 bug（A||B&&C → 永远执行错误 C，exit 100）→ 拆行 + `--yes`；nightly 修好后 `--video` 探针摘掉 continue-on-error（前提=G2 把探针配置面修好）。
- G1-6 CI 无 `npm run gate` 执行点 → determinism 进 CI（静帧档每次 push，视频档 nightly）。
- **验收**：故意注入一个红套件 → 三条流水线红；test-all JSON `failed` 与真实失败数一致；CHANGELOG 断言总数可被机器复算。

### G2 S8 修复与捕获层收口（P0）· 文件域：templates/render-segment.mjs、cdp.mjs、render-batch/farm.mjs、scripts/determinism-check.mjs、plan.mjs(哈希面)
- G2-1 `visibleOverlay` 改判：忽略 canvas 的祖先节点；仅当非祖先可见元素与 canvas 包围盒重叠且自绘（有背景/文字/图片）才升 cdp。
- G2-2 capture 实测模式落盘：renderVideo 已 return page.mode → manifest/segment 记录 `capture`+后端(playwright|cdp)；进 toolchainFingerprint 展示面（哈希 key 的处置见 G2-4）。
- G2-3 determinism-check --video 修配置面：透传 --width/--height/--fps/--capture/--theme + 判据分层（容器 sha / framemd5 / 编码参数三分离，复刻 R2-11 三层法）。
- G2-4 哈希面 allowlist：capture/format/quality/crf/preset/tune/warmup/bpm/子帧倍率 等改像素/改字节的旋钮集中一处声明，plan 生成 segmentHash 时**由声明自动生成**（消灭「手挑字段」结构缺口）；非确定输入（--format jpeg）命中缓存 → 直接拒用缓存或 WARN 升 FAIL。
- G2-5 blur/preview 一致性：motionBlur 开档时 `cvs image`/golden 输出加 `blur=n/a under motion-blur` 告警并写进 manifest.env（不假装一致）。
- **验收**：640×360 cyber-neon 8s ×3 连跑 framemd5 全同（cdp 例外需显式声明）；`--format jpeg`/`--capture` 变更后缓存必失效；nightly --video 在有 Chrome 的 runner 上产出可判读分层报告。

### G3 闸 truthfulness（P0）· 文件域：scripts/qa.mjs、taste.mjs、schema/taste-rules.json、theme-audit.mjs、test-taste.mjs
- G3-1 `cvs qa --strict` 转发 --strict 到 qa-video/qa-audio 子闸（现在算了不用）。
- G3-2 taste 接入交付链：`build --strict` 与 `ship` spawn taste（error 拦、advisory 不拦；waived 计数入报告）。SKILL.md 该句从「承诺」变「事实」。
- G3-3 transition-variety 读真实转场源（render.transition/段表派生）；不再读 schema 不存在的字段；拆掉 test-taste 里那条「基线噪音」豁免。
- G3-4 taste 对比度规则套 accentOverride（与 spec-check:57 同尺；黑压黑同查）。
- G3-5 theme-audit HUD 行 apcaLc 用**合成后**前景色（现在拿未合成 rgba 算出 39 万 Lc 永不拦）。
- G3-6 单一真值：taste 判决阈值/正则从 schema/taste-rules.json 读（EVALS 硬编码退役），改表即改判；placeholder regex（nexus 分支）等两处漂移一并收敛。
- G3-7 豁免生命周期真闸：reason 非空必填、date 过期参与 exit、rule id 不在目录 → 启动即错；`--report-unused-waivers` 进 blocking。
- G3-8 beat-grid 首尾段判定用索引非秒数相等（同输入两种判决 bug）。
- G3-9 帧级 6 条规则 + `--sarif` + 退出码 0/1/2 对齐（或明确改口径并全文档同步「14+4 条」）。
- **验收**：fixtures 金样正反例 18/18；同 spec 双跑 taste 同分进 CI；`build --strict` 对违例 spec 出片必拦。

### G4 flash/S9/卡点真闭环（P0-P1）· 文件域：templates/spec.mjs、timeline-core.mjs、big-card.html、plan.mjs、schema、test-style-pages.mjs、test-accent-route.mjs
按引擎审计 FINDING 8 的 8 点清单执行：
- G4-1 spec.flash.words（schema 专属 definition + FLASH_KEYS 白名单 + E_FLASH_WORDS 校验：非空串/≤8 码点/≤MAX；`deriveFromScript` flash case 消费 b.copy；new-project 默认页 words 消费）。
- G4-2 timeline-core flash 段 URL 下发 first/keyword/layout/index/total/seconds/brandParams；words<count 取模+W_REUSE，>count W_UNUSED。
- G4-3 big-card 时钟读 ?seconds（现在硬编 1.0s → 0.5s flash 全是半截动画）；flash 段 item 真生效（layout 轮转 i%4 已支持，补 index/total 上屏差异 → 同一支片子放 4 遍的病根除）。
- G4-4 **bpm 进 URL + 进哈希**（现在 90BPM 片子逐字仍按 120 跳、且缓存全命中）；generative 页 ?bpm 消费接通。
- G4-5 ?sub 补漏 editorial(DECK)/inkwash(POEM)；矩阵测试正则从 `const SUB` 改「URL 参数→页面读取」双向对账（漏网根因=命名盲区）；?caption 消费或停发（二选一，不留死参数）。
- G4-6 logo 进哈希面：brand.mjs 把 logo.path 并入 spec.assets 或 payload 加 brandLogoHash；localRefs 抽取补 JS 赋值形态；card/more/flash URL 补 brandParams。
- **验收**：矩阵测试新增「flash URL 必带 first 且 ∈words」「每页每个下发参数至少一处消费」两条闸；同片两改 flash.words 必出脏段重渲；bpm 变更段哈希必变。

### G5 安全旁路收口（P1）· 文件域：scripts/lib/film-export.mjs、mcp/server.mjs、server/api.mjs、app/wizard/serve.mjs、scripts/again.mjs、deliver.mjs、templates/concat-and-encode.sh（+render-segment.mjs IPv6 一条随 G2 做）
- G5-1 film 导出入口过 validateSpec；page/id 过 esc()；内联 script 禁裸拼接。
- G5-2 cvs_new outPath `isInside(ROOT)`（或并入 dry-run 默认）。
- G5-3 api.mjs ALLOWED_ORIGINS/AUTH_TOKEN 收进 createJobServer 闭包。
- G5-4 wizard analyze-ref：Origin 校验 + `fs.mkdtemp`/`'wx'` 拒 symlink + 上传限并发与总字节 + `split(/\r?\n/)` 正则修正。
- G5-5 again --set：键段跳 `__proto__/constructor/prototype` + 数组索引上限。
- G5-6 deliver VTT/SRT 文案 `[\r\n]+→空格`；spec copy 字段加控制字符闸。
- G5-7 concat-and-encode.sh：DURATION/FPS 入口数字断言。
- G5-8 每条补旁路回归测试（与 test-spec-security 等尺），产出 `references/security-audit.md`（含覆盖账本，S7-1 交付物）。
- **验收**：安全审计的 10 条复现命令全部失效；`errors.mjs --check` 仍 100%。

### G6 blur/吞吐/资源（P1）· 文件域：scripts/compile.mjs、render-segment.mjs、spec.mjs(上限)、ship.mjs
- G6-1 `--motion-blur off` CLI 关闭档（isMotionBlurOff 对齐 --transition none 先例）。
- G6-2 tmix pass 补 -tune/与主编码参数同构；双代有损写进文档+manifest（或 pass1 改无损中间层，权衡体积后定）。
- G6-3 MAX_TOTAL_FRAMES 校验乘子帧倍率；strong 档顶格前出真实字节量告警。
- G6-4 缓存 GC：`cvs gc [--keep N]` 清 out/.cache 与探针残渣（磁盘现况：out/=21GB vs E 盘空闲 8.4GB，P1 运维风险）；写进 README/doctor。
- **验收**：blur off/none/false 全 CLI 可用；`cvs gc --dry` 报告与磁盘实况一致。

### G7 页面契约+像素文本+可读性闸（P1，ROADMAP S1b/S1-4 余项③的正解）· 文件域：templates/common.js、核心段页、qa-video.mjs
- G7-1 `window.__textsAt(t)` / `window.__ev` 契约进 common.js，golden 四页先行 → 31 页分批；契约函数输出进 segmentHash 参数面（防「有 DOM 无文本」）。
- G7-2 QA 从「验 URL」升「验像素文本」：抽样帧跑 __textsAt，断言 spec.copy 全量上屏、占位兜底不出现（sentinel 硬编码 '结构图示'/'播放量竞速' 这类进 FAIL 名单）。
- G7-3 可读性闸：文本停留≥max(1.8s, speech+0.6s)、包围盒重叠、越 safe() 字幕带；flash 豁免窗口保留但词长上限（G4-1 已含 ≤8 码点）。
- **验收**：造「页不吃 ?title 但内建文案上屏」的注入样例，QA 必红（v2.9.0/v4.10.1 病根类第一次有像素级抗体）。

### G8 本地门禁复绿 + 基线重定（P0，随 G2 后立刻做）
- G8-1 修完 G2 后 `npm run golden:update` 重定基线（当前基线停 v4.8.0，本机 test:golden 12/12 真红已复现）；CHANGELOG 记「像素波未重定基线」违纪一次。
- G8-2 纪律制度化：CI 检查「改 templates/*.html 或 content/style-doctrine.json 的 PR 必须携带 fixtures/golden/manifest.json 更新」，或 golden:update 生成 diff 供人审。
- G8-3 ROADMAP-OVERTAKE 头部标记按对账表全量刷新（含「S3 diff 已存在=--compare、S5-1 已落、S0 ✅ 部分不实」10 条），旧文档头部加「进度以本文+GAPS 为准」指针。
- G8-4 docs 计数对账 159→172（IMPLEMENTATION-STATUS:54、ROADMAP:63）；SKILL.md 拆分（S7-3：35834B→≤6KB 路由 + references/）——放 G11 前做，避免后续文档大改期间双份维护。

### G9 哈希证书与跨机重放验证器（对外护城河，G1-G3/G8 全绿后启动）
- `cvs attest <out.mp4> [--verify]`：manifest+段哈希+toolchainFingerprint+解码帧 framemd5 摘要封成 attestation.json（内容寻址）；`--verify` 在**另一台机/另一份 out** 上离线复核，输出逐层 verdict（容器/帧/编码参数）。
- README 新增「可验证交付」章节 + 对 OpenFilm/HF 话术的对位差异表；擂台文《same input same video：话术 vs 哈希》此时才发。
- **验收**：本机 attest+verify 闭环绿；故意换 --format jpeg 的文件 verify 必红且指认到层。

### G10 S3/S6 补课（P1-P2，按对账修正后的实际差集）
- S3：diff 已有(--compare) → 只补 MCP `cvs_diff` 包装、seam gate、--emit-motion 纯打包、Motion.md 导入导出。
- S6 提级：kind=video 渲染消费者（drawImage+frame(t) 契约）；**先兑现 S0-6 假承诺**（lint 拒 video 或真消费，不留「过 lint 却永不进画面」的暗雷）；EDL/OTIO 已有 → 补 shots 层与 cast 注册表。

### G11 分发实物（P1，与 G9 同窗）
- 仓库转正：按既定偏好建全新单提交公开仓（干净历史），README 安装/徽章/clone 全指新仓；旧 Moessif 线保持 fork PR 留档不等待；gitee 镜像同步。
- v4.2–v4.6 补 tag（sync-releases 改 `^## \[tag\]` 精确锚点，防子串张冠李戴）。
- 成片入库：解 .gitignore 吞 mp4 的静默陷阱（显式 `!assets/demos/*.mp4` + 小体积 360p 样片或 Git LFS 二选一）；bench/taste/diff 各配一条 demo；每画风模板静态详情页；README CI 徽章行。
- skills.sh 上榜 + skill 随 tag 版本对齐安装；references 发布带逐文件 sha256 清单（吸收 openfilm community 纪律，本身就是叙事素材）。

## 3. 依赖与顺序（G12 为 2026-11-24 新立案，插于此处属 §2 切片序列尾部）

### G12（2026-11-24 新立案，ship-demo 实战首猎）小横屏画幅排版专项
现象：`cvs build` 直接指定非 1080p 横屏画幅（如 640×360）时，segment.html 系页面的 HUD 与设计常量
继承 1920×1080 画布（`drawCountdown` 默认 x=1824 直接出画、大标题字号不随画幅缩放压进胶囊区），
qa-text 像素层当场抓包（96 重叠/倒计时出画）。1080p 母带 + ffmpeg 平台派生路径无恙，但「画幅=任意」
的对外话术要成立，排版必须参数化。
方案：引入 `K = min(W/1920, H/1080)` 字号/坐标缩放常量，逐页替换硬编码（big-card 已有 ?seconds 先例）；
每页改完用 qa-text overlap/band + determinism 双跑回归；验收=任意 320×180~1920×1080 档 build strict 全绿。
过渡纪律：ship-demo/README 一律「原生 1080p 母带 → 确定性下采样」，不直渲小横屏（已在 ship-demo.mjs 注释钉死）。

G1 ∥ G3 ∥ G5 可先行互不踩；G2 独立热区（render-segment/plan）由主线做；G4 依赖 G2 的哈希 allowlist 骨架；G8 严格在 G2 后；G7 依赖 G4（文案闭环）与 G2（哈希面）；G9 依赖 G1/G2/G3/G8 全绿；G11 的擂台文依赖 G9。
冲突热区登记：`plan.mjs/spec.mjs/timeline-core.mjs`（G2→G4 串行）、`compile.mjs`（G6 独占）、`workflows/*`（G1 独占）。

## 4. 风险登记（新增三条）
| 风险 | 缓解 |
|---|---|
| S8 修复后 golden 全量重定，旧基线失去追溯 | 重定前打 tag `golden-base-v4.10.1` 存档 manifest；CHANGELOG 记录漂移原因 |
| 门禁复绿会暴露一批「一直红着没人看」的存量红 | G1 落地时先冻结为 KNOWN_RED 清单（进 test-all --json），逐片销账，禁静默跳过 |
| E 盘 8.4GB：golden 重定+回归渲染并发可能爆盘 | G6-4 gc 先行一半（只删 out/_audit* 与探针类可再生物），构建期间 du 监控 |
