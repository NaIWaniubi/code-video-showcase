# Changelog / 更新历史

本项目的版本更新记录。版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
每个版本同时发布在 [GitHub Releases](https://github.com/Moessif/code-video-showcase/releases)。

## [v3.7.0] - 2026-11-18 — ship --check · cvs health · 主题候选可视化 · 版本一致性钉子

### R11-W1 ship --check：打包前质检
- `cvs ship <spec> --check`：打包前对 master.mp4 跑双闸（带 outDir 内 plan.json），
  未过拒绝打包并指引 --force；--force 可强出，结果字段 qaChecked/qaPass 如实标注。
- 实测：对合规成片预检通过 → 正常出包。

### R11-W2 cvs health：一键全身体检
- `scripts/health.mjs`：doctor + 错误码注册表覆盖 + combos 矩阵 + golden 位级自检，
  四项串成一份带时间戳的健康报告（--json 出机器可读版）；任一失败退出 13。
- 实测四项全绿（本机版本 3.6.0→3.7.0）。实施中自查出并堵掉 path.join 把 CLI flag 拼进路径的同款坑。

### R11-W3 向导主题候选可视化
- 参考片反推报告里的 top-3 主题候选渲染为可点小色块（bg×accent 渐变 swatch）：
  点谁切谁——换气质不必重新分析整片；combos avoid 由 chip 同款自愈逻辑兜底。

### R11-W4 版本一致性钉子
- 新 `scripts/test-version-sync.mjs`：package.json / SKILL.md frontmatter /
  cvs --version / CHANGELOG 最新条目头四方必须同值；SKILL 补齐缺失的 version 字段。

## [v3.6.0] - 2026-11-18 — cvs ship 交付打包 · cvs qa 双闸聚合 · doctor 编码器探测 · npm run gate

### R10-W1 cvs ship：开箱即用的交付包
- 新 scripts/ship.mjs + 自研 ZIP 写入器 scripts/lib/zip.mjs（CRC32 标准向量实现、
  STORE/DEFLATE 双档、小文件不压、路径注入拒绝——零新依赖，不给纯代码工具引 npm zip 包）。
- cvs ship project.spec.json → <stem>-<日期>.zip（或 --out dir 目录模式），包内：
  spec / master.mp4 / 字幕 / plan.json / delivery.json / 自生成 README（环境要求 + 三步复现）；
- 前置缺失如实报：没 build 过会点名缺件并退 13，不静默出空壳。
- 实测：zip 经 Python zipfile 校验完整性 OK、7 件结构正确；dir 模式落盘验证过。

### R10-W2 doctor 编码器能力探测
- libvpx-vp9（--platform webm）/ libmp3lame（--platform mp3）/ libopus / subtitles filter
  （--burn-subtitles）四项 optional 检查——导出平台前先让 doctor 告诉用户环境差什么。

### R10-W3 cvs qa 双闸聚合
- cvs qa <video> 一次跑视频闸 + 音频闸，任一 FAIL 即整体退出 13 并给汇总行；
  音频源缺省取视频本身（量交付流而非合成 wav）；--json 出汇总。
- 实测：对旧竖屏母版正确判 video=FAIL · audio=PASS，行为与文档一致。

### R10-W4 npm run gate 发布门禁
- gate script：errors --check（覆盖率）+ combos --check（矩阵）+ fixture lint + plan --check，
  发布前四项一键全查（本机实测通过）。

## [v3.5.0] - 2026-11-18 — 上传进度取消 · --only 子集 · 段表可视化 · 双通道合并 · 骨架降耗

### R9-W1 `cvs demo --only a,b,c` 子集批量
- 批量子集选择：`demo all --only skeleton,fractal` 只出这两个；非法风格名
  E_DEMO_ONLY exit 2（不静默吞，也不把错名当风格跑）。
- 单路子集同样生效 `--platform`（判定改为 styles.length===1，与来源无关）。
- 任何批量（含单子集）都写 manifest 凭据——「跑了什么、成败如何」有落盘记录。

### R9-W2 参考片上传进度与取消
- XHR 上传替代裸 fetch：`xhr.upload.onprogress` 报字节级百分比（MB 数随进度走）；
  15 分钟超时预算；「取消」按钮随分析出现（AbortController abort），中断后如实显示已取消。

### R9-W3 向导参考素材双通道合并
- 「有参考图？」「有参考片？」两个面板合一为「参考素材」——一个 drop zone 按文件
  MIME/扩展名自动分流（image/* → 配色提取；video/* 或 mp4/webm/mov/mkv → 服务端反推）；
  不可识别的类型把提示摆出来而不是静默丢。

### R9-W4 frames 段表可视化（R9 命名 W4）
- 侧栏新增「段表」卡片：每段一行（时间区间 + 标题 input），双击改标题、回车/失焦保存，
  Escape 还原；改动直接绑 state.meta.segments，导出时差异进 copyPatch（所见即所得）。

### R9-W5 骨架页绘制量优化
- 四肢中点 tick 的循环内 save/restore 对删除（直写，×4 次/帧）；
  golden 重基线复验相符。

## [v3.4.0] - 2026-11-18 — 并行重试 · 向导参考片 · 文案回填 · golden 演示基线

### cvs demo 并行与重试（R8-W1）
- 批量模式 worker 池（异步 spawn）：`--concurrency <n>` 钳 ≤2（SwiftShader 软件光栅
  饱和 CPU，与 render-farm cap 同口径），`--retries <n>` 对瞬时渲染失败整条重跑。
- manifest 行新增 attempts / retried（如实报账，不静默）。

### 向导演示集参考片上传（R8-W2）
- 向导向 serve 新增 POST /api/analyze-ref：multipart 上传 → 落临时文件 → CLI 全链
  反推 → 报告 JSON（带 boundary 双形态兼容、大小 400MB 闸、临时文件用完即清）。
- UI：面板「有参考片？」——拖入/点选即分析，成功后一键套用主题（置信度低的如实
  不套）、BPM、按结构拟合调时长（5–90s 且相差 ≥2s 才动），失败把错误原文摆出来。

### frames 导出 copyPatch 文案回填（R8-W3）
- exportSegments 的导出物新增 copyPatch 数组：分割后的片段各自回填标题
  （原题 + 片段序号），下游重编译不再出现「同一行字每块都挂」。
- compile --segment-patch 按 index 把 copyPatch 合并进轮记录的 style.copy
  （真值通道）与 round 级 copy（兼容通道），缺省字段不动。

### golden 位级基线扩展（R8-W4）
- fixtures/golden/demo-skeleton/spec.json：以骨骼演示页为主风格的小夹具，
  golden 自检实测入册（4 specs / 12 stills 相符）。
## [v3.3.0] - 2026-11-18 — 批量出片 · 编辑闭环 · 长片反推上限 · 向导演示集入口

### cvs demo all 批量出片
- `demo.mjs` 重写为批量模式：`cvs demo all` 六个演示风格依次出片，任一失败如实记录进
  out/demo-all/manifest.json（schema cvs.demomanifest/v1：每风格行含 exitCode/master/theme），
  全部跑完再汇总退出码——单个失败不吞账也不中断整批。
- dry-run 下实测 6/6 通过（terrain 默认主题曾踩 graphite-signal 的 APCA 45 门，
  已换 blueprint-stone，nl2spec 与组合器两处同步）。

### 帧工作台编辑 → spec patch → 编译闭环（R7-W2）
- frames 新增「导出段表」：只导出与原始 spec 有差异的轮记录，下载为
  cvs.segment-patch/v1 JSON（schema/sourceFrames/patch）。
- compile 新增 `--segment-patch <patch.json>`：按 index 深合并覆盖 rounds，
  坏文件/缺 patch 数组/索引越界一律 E_SEGMENT_PATCH exit 10。
- 编辑→导出→套用的完整链路在 test-demo-spec 有两条钉子（合法套用 + 坏 schema）。

### 反推引擎长片上限 + 证据图（R7-W3）
- `--max-seconds`（默认 300）：超长片只取前 N 秒做视觉统计（切片不再整部解码），
  报告 visualTruncatedTo 如实标注截断口径；结构仍按全长拟合。
- contact-sheet.jpg 证据图落盘（每秒一帧 tile 8×8），人眼复核用；
  生成失败如实进 evidence 而不是静默丢。

### 向导演示集入口（R7-W4）
- 向导向新增「导演演示集」面板：六张卡点选即套用风格+推荐主题（复用 style chip
  同款流程，含 avoid 自愈与重新生成）。

## [v3.2.0] - 2026-11-18 — 导演演示集六件 + 一键出片（cvs demo）

### 颠覆性演示风格（六件套，全部闭式确定、逐帧可复现）
- `wireframe` 白模线框：线框球体经纬 + 双螺旋圆环结，闭式旋转矩阵透视公转，白盒检具感。
- `skeleton` 骨骼动画：骨盆起伏/髋摆/膝屈/对侧臂摆的走 cycle 关节链，步幅轨迹弧 + 中点测量刻度。
- `fractal` 分形生长：L-system 递归分叉，品牌哈希种子（换 brand 换树但每帧确定），前沿层按生长进度截短。
- `firework` 粒子喷泉：150 粒闭式弹道喷泉 φ=(t−t_launch) mod (飞行+暂停)，彗尾按 φ−δ 闭式求值，过顶一次性爆环。
- `terrain` 地形测绘：解析高度场 + marching squares 等高线（启动时一次生成），扫描平面逐圈增亮 + 测绘角标。
- `network` 网络脉冲：枢纽+双环图拓扑，包脉冲沿链路以 frac(ωt+φ) 行进，三段尾迹 + 节点呼吸。

### cvs demo 一键出片
- 新 `scripts/demo.mjs` + 纯核 `scripts/lib/demo-spec.mjs`：`cvs demo skeleton` / `--seconds` / `--theme` / `--platform gif|webm|mp3|…` / `--dry-run`。
- 组合器生成闭合结构 spec（D 公式与 format.duration 严格一致，不硬凑；card<round 闸保留；时长 4–30s，短片单轮长片双轮）→ compile 同款全链（validate→plan→render→QA）。
- 错误码：E_UNKNOWN_STYLE（usage/2）、E_DEMO_FAILED（env/14）。

### 工程面
- 注册链全通：style-pages / nl2spec 四表（含关键词规则）/ build-combos（combos 重生成 **17×27=459**）/ 向导选项 / domains+style-pages 交叉测试全绿。
- 六页冒烟渲染实测通过（修复过程中自查出并堵掉 6 处「rgba 再包一层 rgba」的色值双重包装坑）。
- test-demo-spec 5 项（闭合公式/结构闸/页映射/未知码/dry-run e2e）；错误码 143→145 覆盖 100%；npm script `demo`。

## [v3.1.0] - 2026-11-18 — 第 21 画风 generative · 派生导出格式 webm/gif/mp3 · 帧工作台段级剪辑

在 v3.0.0 三件套之上继续补齐「完整产品面」：画风词表、平台交付与工作台交互。

### W5 · generative 成为第 21 个正式画风
- `scripts/nl2spec.mjs` 四表（STYLE_IDS/LABEL/DEFAULT_THEME/RULES 关键词）注册 `generative`；
- `scripts/build-combos.mjs` 补族归属（tech：暗底 recommended / 亮底 ok）+ 中文标签「生成式画面」；
- combos 矩阵重生成 **17×21=357**（幂等，preset 全 recommended）；
- 新配方页 `templates/recipe-generative.html`：swarm 氛围层 + 轨道环系主视觉锚点 + 脉冲波传播 + 弹跳字标题（BPM 落拍反弹）+ 标准 HUD；冒烟渲染 30 帧 raw 通过；
- `style-pages.mjs` STYLE_PAGES/RECIPE_IDS 同步（测试交叉校验键集合一致）；
- COVERAGE 矩阵补行与列（tutorial/changelog 推荐 generative）。

### W6 · 派生导出格式（--platform webm / gif / mp3）
- compile：`DERIVED_FORMATS`/`PLATFORM_EXT`——master 与音轨就位后直接 ffmpeg 转码（webm=VP9 1.6M/Opus、gif=480 宽 15fps 两阶段调色板、mp3=192k），不经 shell 的 mp4+AAC 链；无音轨的 mp3 如实跳过并告警。
- deliver：PLATFORMS 按扩展名入列（webm/gif/mp3）。
- qa-video：`--format` 感知——webm 预期 VP9、gif 无 pix_fmt 概念（advisory）、按**实际流帧率**重算帧数期望、gif 缩宽尺寸降为 advisory；无音轨的 gif 跳过音频 QA（如实 warn 而非崩栈）。
- **平台校验提前到 spec 之后、plan 之前**：未知 `--platform` 不再走到编码阶段才报（旧版 `--dry-run` 完全绕开门禁一路假成功）；常量随之上移解决 TDZ。
- platform-presets 文档补 archive 与派生格式两节。

### W7 · 帧工作台段级剪辑（分割/撤销）
- 新纯核 `app/shared/segment-edit.mjs`：`splitSegmentAt(segments, n, fps)`——中点切分、帧数守恒断言、贴边拒绝（段起点/两端各 <1 帧）、reason 可判读；`EditStack` 撤销栈（深拷贝快照、超限丢最旧）。
- frames UI：live 源专属「分割段」「撤销」按钮 + Ctrl/Cmd+Z；编辑后重建 ruler/strip/HUD，按钮可用态随模式与栈长度联动；attach/clearSource 重置栈。
- 单测 5 项（含帧数守恒、深拷贝契约、超限语义）。

### 工程面
- test-all UNIT +1（test-segment-edit）；SKILL/README/COVERAGE/style-recipes 口径同步 21 画风。
- gif 全链 e2e 实测：出片 → 转码 → 视频 QA 按容器预期全绿（无音轨音频 QA 如实跳过）。

## [v3.0.0] - 2026-11-18 — 断层领先三件套：参考片反推 / 旁白声道 / 程序化生成画面

在 v2.9.0（十视角审计收口）之上，一次性交付三个竞品没有的能力。

### 旗舰一 · 参考片反推引擎（`cvs ref video <mp4>`）
- 新模块 `scripts/lib/ref-video-core.mjs`（结构拟合纯函数）+ `scripts/ref-video.mjs`（CLI）。
- 管线：ffprobe 元数据 → showinfo 场景切点 → 逐秒像素采样（96×96 area）→ k-means/主题匹配（复用 ref-core）→ numpy BPM 自相关（八度折叠）→ 结构拟合 → 规范报告。
- 结构模型把典型卡点模板（opening → rounds(card+style) → more → flash 簇 → ending）拟合到实测切点：flash 簇按「连续 <0.6s 切点」自动检出；**BPM 在场时 flash.each 一拍派生**（R2-25 硬约束）；card<round、round 上下限等结构闸全部保留。
- 置信度三分量加权（如实混合不虚高）；拟合残差 >1.5s 必进 notes；退化输入（无卡点/无切点）走模板默认兜底，**绝不产 NaN 进 spec**。
- `--apply` 把 look/audio/bpm/structure patch 并入既有 spec，深合并不毁用户内容。
- e2e：合成片全链反推 + --apply 保内容回归均通过（test-ref-video 套件 7 项）。

### 旗舰二 · 旁白声道（VO）
- 新模块 `templates/synth_voice.py`：文案行 → 语音 + 词级时间戳 JSON；piper 在场优先真实 TTS，否则离线共振峰合成（四声调轮廓 + 三共振峰，机械音色如实标注为排版验证用）。
- compile 接线：`spec.audio.vo=[{text,start,duration}]` 自动合成 vo.wav 并 **sidechaincompress 闪避混音**（说话时音乐让位，广播标准做法），词级时间戳落 `vo-timings.json` 供字幕对齐消费；混音失败回落纯音乐并如实 warn，不毁整片。
- spec 校验：`E_VO_TYPE/E_VO_ENTRY` 让 lint 与 build 同尺；超长片外 start 有 W_VO_LONG 提醒。
- 实测：7 秒短片全链出片（vo.wav/mix-vo.wav/timings 齐全，QA 响度闭环 −14 LUFS）。

### 旗舰三 · 程序化生成画面引擎
- 新模块 `templates/generative.mjs`：swarm（curl-noise 流场粒子，固定步数闭式积分，同 t 同像素）/ orbitSystem（多层椭圆轨道相位独立）/ pulseRings（向外传播冲击环）/ bounceChars（逐字简谐弹道）四族纯核 + 画布包装（document 守卫，Node 可测）。
- 目录式注册 GENERATIVE + generativeProbe 自检；与 effects.mjs 同构铁律（禁随机源/日期/rAF，种子哈希闭式求解）。

### 工程面
- 错误码 139 → 143（E_REF_VIDEO_UNREADABLE / E_VO_*），registry 覆盖 100%。
- CLI：33 子命令（ref 升 verb：`cvs ref video|image`）；help 同步。
- 测试：test-ref-video（7）+ test-generative（5）进 test-all UNIT；bash -n 已含。
- 文档：README 旗舰段、SKILL §1/§5/音频章、themes/qa 口径同步。
- `.gitignore` 补 analysis/（反推产物目录）。

### 诚实边界（如实留账）
- 离线共振峰 VO 是机械音色——配音排版与混音验证够用，交付级请装 piper（代码已接 priority）。
- 反推是启发式：不承诺像素级还原，主题置信 <0.15 会明说 low-confidence。
- generative 四族暂未注册为独立配方页（复用走 import 直调）；帧工作台剪辑交互、平台新预设列为后续波次。

## [v2.9.0] - 2026-11-18 — 第三轮十视角集群审计收口：内容寻址缓存闭合 + 无障碍矩阵 + 用户链路断点清零

第三轮以 10 个只读审计员（新手全流程 / frames 深审 / 入口数据面 / CLI+增量 /
渲染确定性 / 音频质检 / 安全纵深 / 文档漂移 / 测试盲区 / 前端稳健性）对 v2.8.1
做全量审计，约 150 条 finding 去重后按 10 个波次落地。交叉印证规则不变：
≥2 视角独立命中 → 置信 ×2。

### 波1 用户可见断点
- **首页教的 `cvs qa …` 是死路**（实测 E_UNKNOWN_COMMAND）：bin/cvs.mjs 补 `qa`
  薄封装，沿 specArgs 同款默认值口径（仓库根有 out/master.mp4、out/plan.json 即自动带）。
- **剧本表格下载覆盖真 spec**：界面曾只能载入 fixtures 示例，「下载」会把示例片
  直接覆盖成 project.spec.json。现在新增「载入仓库根的 project.spec.json」按钮，
  来源是示例时下载前二次确认。
- **install 不建字体且吞 doctor 失败**：全新 clone 缺 shared/fonts 时 doctor 报
  E_NO_FONTS 被 `|| true` 吞掉、install.sh 以 0 收尾，且 doctor 给的修复命令本身是
  死路。现在安装期自动 build-fonts，doctor 退出码原样透传，两脚本同语义。
- EADDRINUSE 提示统一为可操作文案（ui/frames/review/canvas 补齐，修正过期示例端口）。

### 波2 serve 层收敛
- `/` 根路径 302 → `/app/`（此前裸 404，违反「一个端口跑齐」承诺）。
- 静态服务全部支持 HTTP Range/206（此前 `<video>` 拖动定位退化）；Range 解析抽成
  app/shared/range.mjs 共享助手。
- 缓存策略收敛到 app/shared/static-cache.mjs：fonts.css（约 1MB）此前被漏出短缓存、
  wizard/script/versions 单起时全资源 no-store——同一 URL 两套行为终结。
- /jobs 反代加固：8s 超时、客户端断连销毁上游、方法收窄 GET/HEAD/POST、请求体 1MB 上限、
  502 结构化错误码 E_API_UNREACHABLE。
- wizard 的 .well-known 白名单删除（与其余面口径不齐）。

### 波3 frames 工作台
- image-manifest 条目突破项目根（`../../任意路径` 可读仓库外文件）→ resolveUnderRoot 同款闸门。
- A-B 循环区间跨帧源泄漏 → clearSource 重置并隐藏区间条。
- 在途 iframe 被 LRU 逐出后 ensureLive 空等 26s 卡死串行预载队列 → 出池即快速失败。
- 驱逐后取帧的 404 文案给出出路；`?q=abc` 的 NaN 穿透 → 400；下载扩展名优先取源文件名。
- 换源/关页现在真的调 /frames/api/close 释放 ffmpeg 与帧缓存目录（此前磁盘无界增长）。
- 性能读数 interval 随 clearSource 停表，后台标签不每秒写 DOM。

### 波4 安全闸门
- versions snapshot/rollback 把 spec.render.outDir 当可信输入 → 仓库外任意目录写入；
  与 compile errorDir 同款闸门 + 索引条目名消毒。
- legacy timeline 入口缺 outDir/page 双闸门 → validateComposition 补三查，构建路径
  校验错误不再丢弃继续写盘。
- assets.mjs verify/add 绝对素材路径照单全收 → 三查对齐。
- allowRemotePages opt-in 后残余 SSRF：渲染器侧私网段硬拦；withSegmentParams 剥掉
  page 自带的其它查询参数。

### 波5 内容寻址缓存闭合（本轮核心能力升级）
- localRefs 补 CSS url() 与 <img src>：页面内嵌样式引用的素材换掉不再假绿命中旧字节。
- **素材字节重算**：segmentHash 不再只信 spec 自报 hash——声明与实测不符 → E_ASSET_HASH。
- **工具链指纹**（Node + ffmpeg 版本）进段哈希 payload：升级编码器后缓存自然失效。
- render-manifest cached 条目补齐 expected/framesVerified/seconds，legacy 与默认路径同构。

### 波6 CLI 契约
- 未知 flag 白名单推广到 plan / deliver / versions / render-farm（R2-16 只修了
  build|compile 一半，`--coer`/`--resum` 仍静默照跑 exit 0）——含 did-you-mean。
- `--concurrency abc` 传导为 NaN → 现在 usage exit 2。
- deliver：声明平台件缺席进 delivery.json.warnings；封面仓库根回退仅在 outDir=out 时启用。
- help 文案与真实 flag 对齐（build 行补 --concurrency/--resume/--no-qa/--json/--dry-run）。

### 波7 质检强化
- qa-video：**检查齐全性断言**（probe 失败整项缺席不再全绿）+ **GOP 间距检查**
  （keyint=2×fps，此前「GOP 全链路受控」无任何验证）。
- qa-audio：残缺 plan 从 traceback 崩成 E_PLAN_INCOMPLETE exit 2；EXTENSIBLE 头
  位深手工解 fmt 块（24-bit 不再全表错 18 dB）。
- theme-audit 落地 R2-28「上屏组合矩阵」：点缀色/HUD 印在底/表面的真实对比，
  双指标不可读按 FAIL（发现 8 处真实低对比，如实记录，设计调色留后续）。
- loudnorm 量测不可用从静默降级 → strict 下 exit 12。

### 波8 渲染确定性细节
- dom-overlay 无兜底：页面存在可见非 canvas DOM 而未标 data-dom-overlay 时整层丢像素
  且无告警 → 现自动走 CDP 或至少留 warn。
- raw POST 退避改指数 + 3s 超时；image2pipe（PNG 回退链）补 -s；xfade 中间层补 bitexact；
  muxer timescale 与段级同口径钉死 90000；无音轨平台重排补齐 keyint/level/色彩标签。

### 波9 测试体系
- CI 加 shell 语法门禁（bash -n install.sh arm.sh concat-and-encode.sh）。
- 新增 nightly + workflow_dispatch 的浏览器套件工作流（此前 CI 从不跑浏览器套件，逐像素
  验收与真实编译 e2e 全靠人肉）。
- 新钉子：strict-flags 单测（进 test-all）、clampConcurrency 边界、deliver SRT BOM/CRLF
  字节级、--no-subs/warnings 分支、golden envCompare 纯函数（probe-failed ≠ 相符）、
  launchRetry 重试语义。
- determinism-check 加 --video 整段 mp4 双跑（容器级幂等此前零覆盖）。
- fixture:e2e script（41s strict 全链可复跑入口）。
- 错误码注册表 136 → 139，覆盖率回到 100%。

### 波10 文档同步
README 主题数 13→17（中英一致）、字体清单订正（随包 7 个 OFL 字族）、Surfaces 补
frames/ui 两行、低级路线补脚手架提示；SKILL §1「13 选 1」→17、错误表 125→139、
配方页编号体系订正、qa-audio 路径订正；references/qa.md 按代码重写（新增 flash/GOP/
检查齐全性与 8× 过采样口径）；themes.md APCA 声明改如实口径；ARMED/CLUSTER-PLAN/
OFFLINE/Dockerfile/BACKLOG 幽灵码显式退役标注；IMPLEMENTATION-STATUS 加快照注记。

### 修复过程中自查出的回归（如实记录）
- fonts.css 索引再递归：把新增的 url() 引用面用到 fonts.css 上，1187 个 woff2 子集
  被逐页递归哈希（实测每页 +5s、全链 >2min）。命中 fonts.css 即早退、用 lock 指纹代表
  字体集合变更——原注释里警告过的坑，落地时自己踩了一次，已堵。
- plan.mjs CLI 解析误伤库进程：本模块被 compile 当库 import，顶层白名单解析会用
  compile 的 argv 拒掉 --dry-run 等（把 build 全链打红）。CLI 解析收进 main()。

### 测试
test:all 23 套件全绿（contract 32/32 含新增 5 组）；theme-audit --strict 转绿前提
是 8 处矩阵硬失败已如实暴露。版本 2.9.0。

## [v2.8.1] - 2026-11-15 — 审计尾巴清零 + 全链 e2e 实证

### P1 收尾（v2.8.0 遗留清单）
- 评审页 5xx 与「API 不可达」分文案：服务在跑但查询出错时显示「API 返回 HTTP xxx（服务在跑但查询出错）」，不再误导去重启服务。
- 帧预览：点击画面（iframe 获得焦点）后快捷键失效——首次聚焦时状态栏提示「点击页面空白处恢复 ←/→/空格」。
- 向导 24 个领域平铺改为「8 个常用 + 搜索框 + 更多领域」：搜索命中 label/id/hint，选中的领域永远可见；空命中给中文提示。
- npm 同名异义脚本归位：`new`→`scaffold`（项目脚手架，与 `cvs new` 文本生成 spec 区分）、`plan`→`plan:legacy`（legacy timeline 示例）；删除与 `api` 完全重复的 `dev:api`；`spec:lint` 补默认 `--spec project.spec.json`（无 spec 时退出码 10 而非裸 ENOENT 堆栈语义）。CLUSTER-PLAN 引用同步。

### 全链 e2e 实证（真实产物，非 mock）
`cvs new "做一个 20 秒国风宣传片，青瓷主题"` → lint（0 error 1 warn）→
`cvs build --outdir out/_e2e-run`（master.mp4 600 帧 + qa-video 18 pass / qa-audio 7 pass，
bilibili.mp4 附加）→ 帧预览：video 源 600 帧逐帧可看、plan live 源 600 帧实时渲染
（播放实测 28 fps @ 0.7ms/帧）→ **live 模式下载第 62 帧 PNG（1920×1080）成功** →
`cvs deliver`（delivery.json + master.srt/vtt 5 cues）。

### 测试
test:all 22 套件 / 450 通过。版本 2.8.1。

## [v2.8.0] - 2026-11-15 — 八视角集群审计：体验收口

用 8 个评审视角（新手 / 键盘可达性 / CLI 一致性 / 错误恢复 / 性能感知 / 窄屏 /
术语 / 视觉层级）对全部界面做只读审计，逐条带 `文件:行号` 证据回炉修复。

### P0（会卡住用户）
- **安装后入口自相矛盾**：install.sh / install.ps1 的「下一步」只指 5181 向导页，
  与 `cvs ui`(5180) 脱节。两个脚本第一行改为 `node bin/cvs.mjs ui → http://127.0.0.1:5180/app/`，
  并注明命令统一写法（`node bin/cvs.mjs <命令>`，npm link 后可短写）。
- **向导下载后断流**：下载/复制按钮灰着不说原因、下载完没有下一步。现在：禁用时显示
  原因（校验器加载中 / N 条错误），可用时亮出「放到仓库根 → lint → build」指引；
  实现细节（normalizeSpec/APCA）折叠进 details。
- **ffmpeg 缺失被吞**：spawn ENOENT 只在拖到第一帧时炸英文堆栈，且 meta 谎报
  「全部就绪」。现在 open 即抛中文指引（doctor 检查），`ready` 不随 `done` 虚报；
  `.done` 缓存标记但 0 帧时自动重建。
- **首页命令照抄报错**：`cvs new …` 在未 link 的机器上「找不到命令」。首页统一
  `node bin/cvs.mjs …` 写法 + hero 加「打开向导 →」主按钮。

### P1
- **错误中文化**：frames 打开失败（视频损坏/不存在/spec 校验失败/ffmpeg 缺失）统一
  中文可操作文案（serve 层包装，保留原始信息）；帧 API `api()` 加 8s 超时，
  「Failed to fetch」→「无法连接帧 API（服务没在跑？）」；live 段 `__bootError`
  只显示首行中文摘要；meta 轮询连续失败提示服务可能退出。
- **性能**：`execFileSync(ffprobe)` → 异步 `execFile`（原来冻结事件循环最长 20s）；
  帧读取 `readFileSync` → `fs.promises.readFile`；滑杆 input 事件 rAF 合并。
- **键盘与可达性**：画布加键盘选节点（PageUp/PageDown 或 `[` `]` 遍历 `__hit`）；
  帧预览段落条 div → button（可 Tab）；面板 label 补 `htmlFor`；canvas/frames
  status 补 `aria-live`；script/versions toast 补 `role="alert"`；stageMsg 错误切
  assertive；keyguard 补 SUMMARY/contentEditable；`--ink-faint` 提亮到 AA；
  `.usage` 行对比度修复；焦点 `:focus-visible` 全局补齐。
- **CLI 一致性**：`npm run qa`/`qa:audio` 指向不存在的 `out/final.mp4`/`audio/mix.wav`
  → `out/master.mp4`/`out/audio/mix.wav`（README 同步）；frames 的 5 个错误码登记进
  schema/errors.json（coverage 96.3% → 100%）；删除虚构退出码 15；`cvs brand` 用法
  错误退出 1 → 2（符合全局约定）；README 补中文三步上手。
- **术语统一**：spec=设计稿/规格/spec 三名并存 → 「spec（设计稿 / plan）」；
  master.mp4 vs final.mp4 → 统一 master.mp4；导出/下载动词统一；帧工作台 → 帧预览；
  术语表补 recipe / patches。
- **视觉层级**：HUD 与 meta 行双写的 TC/段信息去重；首页 h2 15px < 卡片 h3 16px
  倒挂 → h2 提到 17px；卡片加「打开 →」点击提示，命令降为次要信息。

### P2
- 窄屏：script 表格 sticky 首 two 列 + 滚动提示；首页网格/术语表小屏降为单列；
  向导 41s 档位改 45s（41 是示例片长度）；向导右上「集群计划」改为合理入口；
  评审空状态标题与连接失败状态解耦文案。

### 测试
- `test:all` 22 套件 / 450 通过；`test:frames` 73/73（含 live==服务端 PNG 逐像素）；
  `test:ui` 35/35。截图复验：out/ui-shots/（含 script-768.png 窄屏）。

## [v2.7.0] - 2026-11-15 — 逐帧实时预览工作台（app/frames，cvs frames）

按**帧号**预览正在制作的图 / 视频：`t = n/fps`，段内 `i/fps`，与
`render-segment.mjs` 的 `i/fps` 是同一量化。三种帧源统一成 `getFrame(n)`。

### 新增
- `app/frames/`（5186）+ `cvs frames [--spec|--plan|--video|--dir]`：
  - **spec / plan**：模板页放在同源 iframe 里，宿主直接 `renderFrame(段内帧号/fps)`。
    不读回像素 → 实测 **0.3–0.8 ms/帧**（p95 0.5 ms），拖动/播放真正实时。iframe 池（6 个）+
    相邻段预加载；URL 的 `seg/t0/speed/dur` 与 `withSegmentParams()` 逐字一致。
  - **video**：ffmpeg `-fps_mode passthrough` 逐帧解码到 `out/frames-cache/`，
    边解码边可看（`ready` 递增），按帧号索引；同一帧字节稳定。
  - **images**：目录 / `image-manifest.json`，一张一帧，自然排序。
- UI：逐帧步进（±1 / ±10 / 首末帧）、按 fps 播放（0.25–2×）、帧号滑杆与输入、
  时间码 `HH:MM:SS:FF`、段落分布条（点击跳段）、胶片条、循环入出点（I/O/L）、
  下载当前帧 PNG、实测 fps / 目标 fps / 单帧渲染耗时、键盘快捷键、全屏。
- HTTP API：`/frames/api/{health,candidates,open,meta,frame,close}`；
  帧响应带 `X-Frame-Index/Time/Timecode/Segment/Render-Ms`。路径限制在项目根内，
  拒绝 `..` 与点目录，只收 GET/HEAD。
- `scripts/test-frames.mjs`：**73 条断言**——帧号数学 / 视频与图片 API / 安全边界 /
  spec 两次独立渲染字节一致 / live 画布与服务端 PNG **逐像素相等（meanDiff=0，段首、
  段内 +1、跨段三处）** / UI 步进与播放。
- `npm run test:frames`、`npm run dev:frames`；README `app/frames/README.md`。

### 工作台与界面（用户视角收口）
- 新增 `cvs ui` / `app/ui/serve.mjs`：一个端口（5180）挂齐六个界面 + 帧 API + `/jobs` 评审反代；`/app/` 是统一首页（六张卡片 + 从零到成片 + 名词表），每个界面顶栏都有「← 工作台」。
- 移除界面里的内部编号（`入口 C1` / `C2-06` / `C2-07` / `D3 edit contract`），换成用户能懂的角色说明。
- 向导：运行前提折叠；**修复浏览器侧校验器**——`spec.mjs → timeline.mjs` 曾静态 `import node:fs`，整条链在浏览器加载失败，页面一直报「校验器未加载」。拆出 `templates/timeline-core.mjs`（纯函数，浏览器可导入），`spec.mjs` 改导入 core；`timeline.mjs` 保留 Node CLI + `concatList` 并 re-export，CLI 行为不变。
- 剧本表格：修复右侧「校验 / JSON 预览」面板重叠（flex 收缩导致内容溢出到下一个面板）；加默认示例说明与向导入口。
- 画布：默认停在画面稳定处（42% 时长），不再首屏空白/白闪；编辑契约默认折叠；「patches」改名「改动」。
- 帧预览：未打开帧源时隐藏 HUD、禁用控件并给三步引导；修复空 `<img>` 在舞台上显示破图图标；候选扫描从 1.1s 降到 ~0.2s。
- 评审：空状态改成三步可复制命令（`cvs api` → `POST /jobs` → `?job=`）。
- 测试：新增 `scripts/test-ui.mjs`（35 条：首页/六界面/API/反代/缓存/穿越/默认静态行为）；`test-all` 22 套件 / 450 通过。

### 关键实现记录
- 首版对每帧 `canvas.toDataURL` 再传给浏览器：软件渲染下 1920×1080 单帧编码
  **130–300 ms**（160×90 也要 ~130 ms），不可能实时。改为 iframe 直接显示同一张
  canvas 后，`renderFrame` 本身只要 ~1 ms。
- iframe 不能用 `display:none`：`innerWidth=0` 会让模板回退 1920×1080，预览布局
  与成片不一致。改用 `visibility:hidden`，并**先定 CSS 尺寸再设 src**。
- 多个后台 iframe 会互相拖慢（服务端一次渲染从 90 ms 掉到 6–14 s）；池限制 6 个、
  只保留一个可见，缩略图在 spec 模式改用帧号卡，避免服务端再起 Chrome 抢 CPU。
- 切段：预加载改为**排队串行**（并发 3 个 1920×1080 页面反而互相拖慢），
  静态资源给 2 分钟缓存（HTML 仍 no-store），载入期播放时钟冻结，不跳内容。
- 实测：步进 1.1–1.6 ms/次（点击→画面更新）；单段播放 HUD 按墙钟推进；
  视频源取帧 avg 4.6 ms（p95 7.7 ms），播放实测 30 fps；预加载后的段跳转 0–6 ms。

## [v2.6.1] - 2026-11-14 — 离线预览出图、静态材质烘焙、别名歧义清零

上一版留的三个缺口收口：预览图没出（CDP 起不来）、静态材质每帧重画、两处重复别名。

### 离线预览生成器（绕开 CDP）
- 新增 `scripts/theme-preview-offline.mjs` + `npm run theme:preview:offline`。走 Chrome `--headless=new --screenshot --virtual-time-budget`，**不依赖 CDP WebSocket / Playwright / npm 包**。本机实测 17 套单图 + 2 张拼版全部产出。
- 根因记录：首版脚本用 `spawnSync` 启动 Chrome，而静态 server 跑在**同一个 Node 进程**里 —— Node 事件循环被阻塞，Chrome 请求 HTML/字体时 server 无法响应，全部超时。改为异步 `spawn` 后立刻通过。
- `img.decode()` 在 `--virtual-time-budget` 下不 resolve（虚拟时钟不推进真实解码），导致拼版页卡死出全黑图。`theme-sheet.html` 加 `?noDecode=1` 开关（仅离线路径使用），探针确认 `PROBE:READY`。
- **默认不覆盖已有单图**：01–13 是 `test-assets`（sha256）与 `test-from-reference`（色板聚类）的固定基准。`--only-sheets` 只重建拼版，`--force` 才覆盖单图。首版误覆盖后两个套件红灯，恢复基准 + 重建拼版后清零。
- 视觉验收：4 套新皮肤逐张确认（扫描线 / 暮光带 / 焦散 / 织纹特征清晰，色板正确，`CONTRAST AUDIT 9/9 PASS`），17 套联系表 6+6+5 三行无裁切、页脚 `17 OF 17`。

### 静态材质离屏烘焙
- `templates/themes.js` 新增 `staticMaterialTile()`：`linen` / `dusk` / `scanline` 的静态层烘成**透明**离屏画布，逐帧一次 `drawImage`。透明度是关键 —— 保持「底色 → glow 呼吸 → 静态层 → 动态层 → 颗粒」的合成顺序（source-over 结合律），否则 glow 会被盖到静态层之后。
- 动态层（scanline 亮带、caustics 光脊、grain）不烘焙，仍按 `t` 绘制；`?noBake=1` 可强制回落逐层路径。
- 逐帧 canvas 操作数（`1920×1080` 实测）：`sand-linen` **1099 → 8**（−99.3%）、`terminal-phosphor` **299 → 21**（−93%）、`solar-dusk` **25 → 15**。
- 像素级等价验证（真实 Chrome 双路径截图逐像素比对）：最大差 **2/255**、平均 0.10–0.26，差值对称分布且散布全屏，属 canvas 8-bit 半透明合成舍入，无结构性差异。Golden 三套基准主题（`coral-noir` / `cyber-neon` / `aqua-morandi`）均不在烘焙集合，位级门禁不受影响。
- `test-core.mjs` 新增回归：验证烘焙路径存在 `drawImage`、操作数 < 40、两条路径都确定性、17 套在烘焙/非烘焙两模式下均不抛错。

### 别名歧义清零
- `getTheme()` 线性匹配别名，重复值让后注册主题永远解析不到。`gold`（`amber-noir` / `dark-gold-cinema`）与 `teal`（`celadon-paper` / `abyss-teal`）冲突：`dark-gold-cinema` 改用 `dark-gold`，`abyss-teal` 改用 `abyss` / `深海青`。
- 新增 `aliasConflicts()` 自检 + `test-core.mjs` 逐别名回指断言，新增主题不会静默埋雷。

### 测试
- `node scripts/test-all.mjs`：**21 套件 / 415 通过 / 0 失败**。
- `theme-audit --strict` 17 套 WCAG 全 PASS；`build-combos --check` 17×20 / 20 preset recommended。

## [v2.6.0] - 2026-11-14 — 4 套新皮肤 + 4 种新材质（主题系统 v3）

`templates/themes.js` 的 `THEME_SCHEMA_VERSION` 2 → 3，主题 13 → 17（9 深 8 浅），材质 8 → 12。
每套新皮肤都配一种**新材质 kind**，而不是换一组颜色；全部是 `t` 的纯函数、逐帧确定性。

### 新增皮肤
| id | 名称 | 明暗 | 新材质 | 场景 |
|---|---|---|---|---|
| `terminal-phosphor` | 终端磷光 | dark | `scanline` CRT 扫描线 + 慢移亮带 + 压角 | 开发者 / CLI / 开源发布 |
| `solar-dusk` | 落日暖丘 | light | `dusk` 底部 1/3 暖橙→暮紫色带 + 地平线细线 | 旅行 / 美食 / 户外 |
| `abyss-teal` | 深海青 | dark | `caustics` 三条天蓝正弦光脊 + 底部深水渐暗 | 医疗 / 海洋 / 深科技 |
| `sand-linen` | 亚麻宣纸 | light | `linen` 经纬双向 12/10px 细线 + 纸边压色 | 出版 / 教育 / 人文 |

- 4 套的 14 角色色板全部过 `theme-audit --strict`：**WCAG 全 PASS、APCA 零 WARN、HUD 胶囊达标**（全库 9 项 APCA 提醒仍全部来自旧 13 套）。
- `abyss-teal` 刻意用紫调藏青 + 天蓝而非青绿：`ref-core.mjs` 的参考图反推用 OKLab 色板距离，与 `cyber-neon` 太近会把 `09-cyber-neon.jpg` 的 top-1 认错；调色后 `test-from-reference` 29/29 全绿。
- 新增 4 组首屏预设（`devops-terminal` / `travel-solar-dusk` / `healthcare-abyss-teal` / `course-sand-linen`），16 → 20 组。

### 真值同步与门禁
- `scripts/nl2spec.mjs`：`THEME_IDS` 13 → 17，`THEME_RULES` 补 4 套中英文关键词。
- `scripts/build-combos.mjs`：新增主题行现在从 `combos._meta.families.styleFamily` 解析**全部 20 个**风格的族归属（旧版只认 8 个新风格，新主题行会拒绝写）；`_meta.families.themeMode` / `themeNames` 改为从 `themes.js` 派生，杜绝手写第二份真值。`content/combos.json` 重生成 17×20=340，20 组 preset 全 recommended，`--check` 绿。
- `scripts/test-core.mjs`：主题数断言 13 → 17，新增「材质 kind 必须登记」与「`nl2spec.THEME_IDS` / `combos` 行 / `themeMode` / `themeNames` 四处真值与 `themes.js` 逐项相等」交叉校验；`test-domains.mjs` 的 `>=13` 改为 `=== THEME_IDS.length`。
- `templates/theme-board.html` 底部主题条 17 套折成两行（9+8），`theme-sheet.html` 联系表 17 套用 6 列 3 行，避免压到页脚。
- `SKILL.md` / `README.md` / `ARMED.md` / `references/themes.md` / `intake.md` / `repo-map.md` / `style-recipes.md` / `big-card-and-typography.md` / `docs/ERRORS.md` / app README 等 13 → 17、8 → 12 全部对齐；`references/themes.md` 补 4 套逐项设计说明与 4 种材质表。

### 顺带修掉的真缺陷
- `scripts/test-script.mjs` 3 个断言把 `flash.count=8` 硬编码成 23 段 / `f08` / `-10` 偏移，与仓库里已改成 `flash.count=4` 的 fixture 漂移（上一轮遗留红灯）。改为从 `spec.structure.flash.count` 派生，不再随 fixture 改动失效。

### 测试
- `theme-audit --strict`：17 套 WCAG 全 PASS，新 4 套 APCA 零 WARN。
- `build-combos --check`：17×20 / 20 preset recommended。
- `node scripts/test-all.mjs`：**21 套件 / 414 通过 / 0 失败**（含 `test-from-reference` 29/29）。
- 4 种新材质用 Canvas 2D stub 独立验证：逐帧确定性、`t` 驱动行为正确（`linen` 静态，其余随 t 变化）、17 套主题全部无异常渲染。
- 预览图渲染在本机 CDP/Chrome 无法启动（`window.__ready` 超时，连原版 `coral-noir` 同样失败，属环境边界而非皮肤缺陷）；`assets/theme-previews/14…17` 需在可用 Chrome 的环境执行 `node scripts/theme-preview.mjs --root . --themes terminal-phosphor,solar-dusk,abyss-teal,sand-linen` 重建。

## [v2.5.2] - 2026-11-14 — 多视角集群审计加固：8 视角找真缺陷，逐项落地 + 回归

用 8 个并行只读审计视角（确定性/安全/集成/错误契约/性能/测试覆盖/音频/前端）对 v2.5 全面审查，
把找到的**真缺陷**逐项修复并各带回归。全套 **33 套件 / 821 通过 / 0 失败**，golden 9 静帧位级一致。

### 修复（CRITICAL / HIGH）
- **encode() 把启动失败当成功**（CRITICAL）：`c.status || 0` 在 bash/ffmpeg 缺失（status=null）时返回 0，
  编译器 exit 0 却没有 master.mp4。新增 `spawnStatus()` 把「没跑起来」归为 env/E_SPAWN。
- **有限溢出绕过资源闸门**（CRITICAL）：`flash.each=1e308` → duration=Infinity → plan.frames=null → 渲染死循环。
  flash.each 上限 MAX_SEGMENT_SECONDS、flash.count 必须整数、非有限 duration/structure 直接拒绝。
- **normalizeSpec 污染共享 DEFAULTS.format**（HIGH）：同进程多 spec 串时长，API 拒收合法 job。改为深拷贝 DEFAULTS。
- **segmentHash 漏 fps/width/height**（HIGH）：换画幅/帧率缓存假命中，横屏帧拷进「竖屏」成片。已补入哈希。
- **big-card 版式 2/3 背景条纹消耗模块级 RNG**（HIGH）：renderFrame 非 t 的纯函数（stills≠video、D3 重渲漂移）。
  改为每帧局部种子 RNG。
- **great-wall 缺 STYLE_DEFAULT_THEME**（HIGH）：显式选 great-wall 静默得 coral-noir + `theme=undefined` 注记。补 dark-gold-cinema。
- **cvs motion matrix 硬编码 8×12**（HIGH）：改为从 KIND_IDS/STYLE_IDS 导入（24×20）。
- **nl2spec 丢弃 weixin/xiaohongshu preset**（HIGH）：白名单补全 8 个；ASPECTS 补 3:4/6:7。
- **评审页跨源轮询被 CORS 拦**（HIGH）：review serve 同源反代 /jobs/* 与 /health，默认即可用。
- **测试汇总解析丢 failed**（HIGH）：reflow/assets/variants 的 bare 尾行把 failed 吞成 0；去掉冗余行 + 解析器支持中点/分数/反序格式。
- **xfade 内存上限无测试**（HIGH）：新增静态回归钉死两条拼接路径的线程/lookahead 旗标。
- **build-combos --check 永不失败**（HIGH）：先修补再查 → 门禁形同虚设。改为只读检测在前；加 --file 覆盖 + 幂等/漂移测试。
- **暗转场触发 QA 黑帧告警**（HIGH）：meta.transition.dark 的过渡窗黑帧豁免预算，strict/deliver 不再误红。

### 修复（MEDIUM / LOW）
- 安全：page 路径补 `..`/编码穿越（..%2f）/单反斜杠闸门；outDir 补单反斜杠/控制字符 + errorDir 收容；
  deepMerge 原型污染闸门；API job.error scrub + 失败兜底 logPath；concat 绝对模式挡换行 + timeline-v1 id 字符闸。
- 确定性：render-farm legacy 补 --width/--height；cyber-pixel 改 setupStage（D7 竖屏）；theme-sheet 颗粒重置种子；
  pageContentHash 折入 fonts.lock.json（换字体缓存失效）；模块加载失败快速失败（__pageException）不烧满 timeout。
- 音频：t=0 开场重音可测（STFT 前置静音 + 偏移还原）；HF key 窗与 synth 对齐、无 key 窗时产出 not-measurable advisory；
  死 kind 'start' 清理；qa-video true-peak 闸门对齐 -1.0。
- 集成：领域关键词消歧（游戏攻略→gaming、健身活动→fitness、新歌发布会→music 等）；wizard 3:4/6:7→xiaohongshu/weixin。
- 前端：wizard 参考图套主题补 avoid 守卫、参考图上传键盘可达、预设/风格计数动态化；script 表格键盘编辑；
  versions writeCurrent 配额守卫；评审页展示 errorCode/phase/失败段 + 诊断链接、specPath 不再猜路径。
- 测试：type-tokens 从 STYLE_PAGES 派生（补 6 新风格）+ Chrome 自动发现；style-pages-render 加竖屏 b2 确定性；
  wizard 测试改临时端口；contract 测试噪声脉冲改种子 LCG；swiss/blueprint 标题对齐字阶 token。
- 性能（位级不变）：drawDotGrid 烘离屏缓存；greatwall 标题字号启动算一次。

### 测试
- 新增 `test-hardening.mjs`（11）钉死上述 CRITICAL/HIGH/MEDIUM 修复；transitions 18、domains 11、summary-parse 15。
- 全套 33 套件 / 821 通过 / 0 失败；golden 3 spec / 9 静帧位级一致。

### 第二轮 9 视角集群补充（N01–N09：新手/设计/后期/Agent/安全/性能/混音/无障碍/验证官）

68 条 finding 去重为 P0×13 / P1×30，本轮再落地以下 distinct 项（台账 `docs/audit2/FINDINGS-ROUND2.md`）：

**交付契约（P0）**
- **master = 项目原生画幅**（R2-09）：旧版母版硬编 1920×1080，9:16 项目 + `--platform` 的 QA size 必红、从第一天出不了绿灯。母版改用 `spec.format` 原生尺寸 + master 预设高码率，平台版才是派生尺寸。3s 竖屏回归 qa-video 20/0/0。
- **每条交付件都过 QA**（R2-01）：旧 QA 只测 master，平台件裸奔——实测 douyin.mp4 +2.67 dBTP / 0.0 dBFS 削顶出闸仍记 qaPass:true。compile 现遍历 master + 各平台件分别跑 qa-video/qa-audio；qa-audio 支持 mp4 直读（内部抽流）。
- **true-peak 天花板**（R2-01）：concat 编码链 loudnorm 后接 **4× 过采样真峰限幅**（`aresample=192000,alimiter=limit=0.562,aresample=48000`）——采样峰限幅管不住 AAC inter-sample 过冲（实测平台 192k 件 +2.7dBTP 削顶），过采样域 -5dBFS 保守天花板留足余量，全件 post-AAC ≤ -1dBTP；qa-audio 峰值门改 **8× 过采样 dBTP**（旧版量采样峰是错的物理量）。
- **qa-audio 假绿堵口**（R2-02/03）：`--plan` 指向不存在文件 → exit 2（旧版静默丢 cue/HF 门禁仍全绿）；有 plan 时门禁完整性断言；24/32-bit 位深改读 `wave.getsampwidth()`（旧版按幅值猜，低电平 32-bit 全表错 18 dB）。

**编码链（P1）**
- **GOP/level 受控**（R2-21/22）：`keyint=2×fps`（≤2s，平台二转友好）+ 固定 `level 4.1`（>1080p→5.0），不再让 x264 按 CPB 反推出 master 5.0 / douyin 4.0 打架。
- **two-pass 参数对齐**（R2-23）：pass1 补齐 X264_PARAMS/COLOR_TAGS/level（旧版缺 AQ/cutree 统计自始错误）。
- **master.mp4 幂等（部分，根因已定位）**（R2-11）：编码链全段钉死 `threads=2:lookahead_threads=1:rc-lookahead=10` + `-fflags +bitexact -flags +bitexact`（render-segment 与 concat 一致）。实测音频/配方页/大字卡段逐字节一致；**残余非确定性定位到渲染层**——segment.html 通用开场的动画 arc/径向渐变在 swiftshader 软件光栅下有抗锯齿浮点微差（固定 t 的 golden 静帧稳定，连续视频帧微差），非编码层。真实项目用配方页（简单形状）时输出确定；通用开场段的逐帧幂等待确定性光栅方案。
- **并发钳制**（R2-10）：render-farm 上限按物理核估算（16 逻辑核→4 worker），超额请求钳并告警——实测 c8 在 16 核上 8/23 段 CDP 超时且负收益。

**像素（P0/P1，golden 已重定 + 目视对照）**
- **胶囊 HUD 文字对齐泄漏**（R2-06）：`drawCapsuleLabel` 显式 `textAlign='left'`——旧版继承场景的 center/right，文字溢出药丸框、浅色主题整条不可读（全主题全帧）。
- **胶囊兜底复读标题**（R2-29）：eyebrow 兜底改品牌而非 `TITLE.slice`（仅传 ?title= 时不再标题复读两遍）。
- **layout0 白字白底**（R2-05）：big-card/themes.js 字色按**实际底色**极性择色（候选含暗/亮两端，≥3:1）；timeline 不再硬编 #ffcf5c 黄底；readable 阈值 2.2→3.0（WCAG 大字 AA）。
- **八连闪 WCAG 2.3.1**（R2-04/25）：默认/fixture flash 8×0.25s（3.75Hz 全画面白闪，光敏风险）→ 4×0.5s（2Hz）；flash 间距默认由**拍**派生（60/bpm），任意 BPM 落拍网格；qa-video 新增 YAVG 闪烁率闸门（>3 对/秒 WARN，strict 红）。

**音频（P1）**
- **tempo 八度归一**（R2-26）：有 plan 时检出值折叠到目标八度（自相关天生八度歧义）；无节奏素材置信度地板 → tempo=None（旧版纯正弦报 90.81 还 PASS）。
- **synth LUFS 闭环**（R2-27）：master() 加 BS.1770 K-weighting 迭代到 -14 LUFS 再压峰值（旧版只峰值归一，响度随 BPM/时长漂 2.9 dB）；直出 wav 即交付级（实测 -14.03 LUFS / TP -2.52）。

**机器消费者 / 集成（P1）**
- **build --json**（R2-14）：stdout 单行结果 JSON，进度（含子进程）退 stderr；dry-run/成功/失败三态都 emit。
- **plan 退出码契约**（R2-15）：spec 错 exit 10、usage exit 2（旧版一律 1，agent 路由表无此支）。
- **flag allowlist + --set 字符串语义**（R2-16）：未知 flag exit 2 + did-you-mean（`--strik` 不再静默吞 strict）；`--set` 值默认字符串（`2024`/`007` 不再被强转 Number），`--set-json` 显式转型；顶层键拼写检查。
- **manifest 增量可校验**（R2-17）：cached 条目补 expected/framesVerified；段键按 plan 时间轴排序（旧版键序=worker 完成顺序，幂等比较每轮误判）。
- **API 并发尊重 spec + evict 清盘**（R2-19）：不再硬编 --concurrency 2；evictOldJobs 同步 fs.rm job 目录（旧版只删内存，长跑撑爆 outDir）。
- **wizard/surface --help**（R2-35）：只打用法+URL 即退出，不再起服务占端口。
- **brand 兜底漏检**（R2-36）：brand==title==name（cvs new 兜底）→ W_BRAND_FALLBACK（strict 升级 error）。
- **SRT BOM+CRLF / VTT Language / 字幕间隙**（R2-32/33）：SRT 带 UTF-8 BOM+CRLF（记事本/剪辑器不乱码）；VTT 加 Language 头；相邻 cue ≥0.1s 呼吸；more 段补 cue。
- **golden 探测失败≠相符**（R2-12）：Chrome 探测与渲染器同源（browserCandidates），probe-failed 判不匹配（旧版 actual:null 仍 match:true 假绿）。
- **combos 锚定渲染真值**（R2-41）：test-domains 断言 STYLE_PAGES==STYLE_IDS 且每主题×每风格全格覆盖。
- **install.ps1 CI 语法门禁**（R2-08）：windows-static job 用 PowerShell Parser 校验，防再次被剥光 `$`。

### 第二轮实测
- 纯 Node 全量 **409 通过 / 0 失败**（contract 31/31，+5 第二轮回归）；golden 3 spec / 9 静帧位级一致（chrome reason=equal）。
- **41s 全片 strict 全链路 BUILD_EXIT=0**（`--platform douyin --strict`，全量重渲）：
  master qa-video **20/0/0/0**（TP -3.15 dBTP）+ qa-audio 7/0/1 advisory；
  douyin qa-video **18/0/1 advisory/0**（TP -2.13 dBTP，letterbox 黑边=advisory）+ qa-audio 7/0/1 advisory。
  唯一 advisory 为 beat grid（非阻塞）；真峰全件 ≤ -1 dBTP，响度 -14±1 LUFS。
- 3s 竖屏 strict：qa-video 20/0/0（R2-09 原生画幅验证）。
- 非 120 BPM 矩阵（90/120/150）：cue alignment 全 PASS（R2-25 flash 拍派生 + duration 同源）；beat grid advisory 如实报告。
- synth 直出 41s：-14 LUFS 闭环（R2-27）。

## [v2.5.1] - 2026-11-14 — 音频质检归零：两个 ADVISORY 清零 + 频谱图去 matplotlib

收官后剩两条 advisory 与一条环境告警。本轮全部清零，41s 全片严格链路 **8 pass / 0 warn / 0 advisory / 0 fail**。

### 修复
- **beat grid 47.4%（ADVISORY）→ 76.7%（PASS）**：根因三层叠加——① flash 段每 0.25 s 一条 cue（8 连闪），qa 默认却按 1/1 网格量；② kick 从 250→52 Hz 的扫频在每拍后 ~70 ms 制造一个假 onset；③ 2.2 s 噪声混响把关键节点 crash 的尾巴拉成一片密集 flux 峰，每 85 ms 一个。修法：qa-audio 从 plan 的 **cue 最小间距推断**细分级（仍是声明式——细分写进报告，不在 1/2/4 里挑命中率最高的那个）；kick 扫频收敛（`f1` 200→110、`decay` 8→11）；混响 2.2 s→1.4 s、wet 0.18→0.14。
- **HF restraint −1.93 dB（ADVISORY）→ +9.26 dB（PASS）**：原合成床用「8 分音符高八度 epiano 琶音」铺底，把非关键段的 8–16 kHz 垫高，关键节点反而没有对比。按 `references/audio-recipes.md` §7 重写：非关键段 hat/snare **lowpass 5.5 kHz**；关键节点（卡片/片头/片尾）改用**音调型**高频点缀（triangle 3.5 kHz 起振 + 0.3 s 短 crash）；金属铃音全片严格 3 处（片头揭示 / 第一张卡 keyword / 片尾）。删除卡片窗口内的噪声爆裂——它自身就会产出 3–4 个随机 flux 峰。
- **频谱图去掉 matplotlib**：纯 numpy + stdlib `zlib` 直接写 PNG（log 频率轴、magma 近似色表、低频在下）。Anaconda/NumPy 2.x 的 ABI 冲突不再影响出图，也不再有任何可选依赖告警。
- `build` 的频谱图输出改到 `<outDir>/qa/spectrogram.png`（原先落在仓库根 `qa/`）。

### 实测
- 41s 全片 `build fixtures/mini-41s/spec.json --platform douyin --strict` **EXIT=0**：
  qa-video **19 pass / 0 warn / 0 advisory / 0 fail**；
  qa-audio **8 pass / 0 warn / 0 advisory / 0 fail**（beat grid 76.7%、HF +9.26 dB、cue 35/35 = 100%、peak −1.36 dBFS、−13.84 LUFS、TP −1.26 dBTP）。
- `npm run test:all` 20 套 **340 passed / 0 failed**；`test-compiler-contract` **26/26**（新增 2 项：细分推断、无 matplotlib 的 PNG 频谱图）。
- GitHub：本机凭证对上游仓只有 READ 权限 → 已 fork 到 NaIWaniubi 并开 PR #1（`Moessif/code-video-showcase#1`）。

## [v2.5.0] - 2026-11-13 — 覆盖领域 × 风格 × 效果 × 转场（研究背书）

对标 Remotion / Motion Canvas / editly / FFCreator / GSAP 与本地 motion-doctrine /
guizang / theme-factory / subtitled 等 skill，把编译器在四个维度上的覆盖补齐，
每一项都带回归测试与真机渲染。新增 `docs/COVERAGE.md` 作为覆盖矩阵单一真值投影。

### 新增
- **段间转场（35 种）**：`templates/transitions.mjs` 是单一真值——FFmpeg `xfade`，
  段 mp4 仍各自独立渲染（逐段确定性 / 缓存 / resume 不变），转场只在拼接阶段做。
  「段起点平移」数学同时驱动 plan / 字幕 cue / 配乐 / concat：N 段、转场 t、fps，
  第 i 段成片起点 = 原起点 − i·round(t·fps)，成片总帧 = 原总帧 − (N−1)·tf，
  xfade offset = 平移后段起点。**默认关闭逐字节不变**。CLI `--transition` /
  `--transition-duration`，spec `render.transition`。`schema/errors.json` 增
  `E_TRANSITION` / `E_TRANSITION_DURATION`。
- **共享确定性效果库（26 个）**：`templates/effects.mjs` 命名目录，5 类
  （text/particle/post/camera/audio）。纯核是 `(t,seed)` 纯函数（Node 可测确定性），
  canvas 包装复用 motion.js 的 grain/scanlines/RGBSplit/bloom/halation/kineticText。
  新增 scramble/splitFlap/typewriter、confetti/sparks/snow/bubbles/embers 粒子、
  vignette/halftone/dotGrid/lightLeak/crt/duotone 后期、kenBurns/shake/parallax 相机、
  beatPulse/spectrum 音频反应。探针页 `effects-probe.html`。
- **6 个新风格页 + 收编 kinetic（共 20 风格）**：swiss（瑞士网格）、editorial（报纸编辑）、
  brutalist（新粗野）、vaporwave（蒸汽波）、blueprint（工程蓝图）、risograph（孔版印刷），
  并把此前未注册的 `recipe-kinetic.html` 收编进 `STYLE_PAGES`。全部逐帧确定性、横竖屏真重排，
  注册进 style-pages / motion-profile / nl2spec 三处真值。
- **领域 8 → 24**：新增 tutorial/changelog/event/podcast/travel/food/fitness/realestate/
  fintech/healthcare/course/gaming/music/nonprofit/sports/localbiz 共 16 个垂直场景，
  各带默认风格/主题/mood/时长/CTA/文案与关键词识别。`content/presets.json` 首屏预设 8 → 16。

### 修复
- **xfade 拼接 OOM**（真缺陷）：N 路 xfade 同时解码 N 段，默认线程 + x264 lookahead
  在 Windows 耗尽 commit，表现为 `x264 malloc failed` / 伪 `decode_slice_header error`。
  shell 与 compile 两条路径都加内存上限：解码线程 2、滤镜图单线程、x264
  `rc-lookahead=8:sync-lookahead=0`。7 段实测从崩溃到稳定输出 66 帧。
- **xfade offset 二次平移**（真缺陷）：`plan.segments` 已被 timeline 平移，旧
  `xfadeOffsets` 内部又 `shiftSegments` 一次 → 负 offset → 成片塌缩成最后一段（18f 而非 66f）。
  现在 `xfade*` 接收**已平移**段、不再内部平移；`shiftSegments`/`totalFrames` 接收原始段。
  新增 plan 级回归测试钉死「offset 严格递增非负」。
- **转场长于最短段**：新增 plan 阶段闸门——转场时长 ≥ 最短段帧数时报
  `E_TRANSITION_DURATION`（否则该段被两侧重叠吃光、起点非单调）。
- **效果库 re-export 缺失**（真缺陷）：vaporwave/risograph 从 effects.mjs import
  `drawScanlines`/`drawGrain`，但 effects.mjs 只 import 未 re-export → 页面拿到 undefined →
  启动期 TypeError、`__ready` 永不置位。现在目录复用的 motion.js 原语一并 re-export；
  `test-effects.mjs` 加强为「每个 draw 目标必须由 effects.mjs 自己导出」。

### 测试
- 新增 `test-transitions.mjs`（14）、`test-effects.mjs`（14）、`test-effects-render.mjs`（5，真机）、
  `test-domains.mjs`（7），全部并入 `test-all.mjs`。
- 转场真机 e2e：7 段 + fade 0.4s → 成片 180f/6.0s（= 252 − 6×12），video QA 19/0、audio QA 6/0、BUILD=0。
- 新风格真机渲染 + 视觉验收（vaporwave/brutalist/swiss/risograph 逐项确认无缺陷）。

## [v2.4.0] - 2026-11-13 — 把 v2.3.4 台账里剩下的 11 项做完

内测台账 26 项在 v2.3.5 落地 15 项、部分 7 项、未做 4 项。本版把**全部 11 项缺口**补齐：
品牌合规进 build、失败契约机器可读、跨机确定性、字幕烧录、安全纵深、品牌视觉、封面版式、
排版 token、新手门槛、审片回滚。过程中 e2e 又抓到一个真缺陷（见「修复」第一条）。

### 修复
- **玻璃主题把用户副标题换成材质描述占位文案**（真缺陷，会污染成片）：`segment.html` 的 `eff()`
  从 `params.hud.sub` 取副标题，而该字段不存在（副标题在 `params.title.sub`），于是一路回退到
  `DEF.subText`——玻璃主题的 `DEF.subText` 是「半透明白 · 1px 高光边 · 淡绿/淡粉柔光只从玻璃里透出来」。
  非玻璃主题只是**碰巧**正确（常量恰好等于 URL 参数）。根因是 `mergePatches(..., {})` 不读 `SPEC.params`，
  让 params 变成装饰品、D3「SPEC 是唯一真相」失效。现在以 `{ ...SPEC.params.* }` 为合并基座，
  删掉玻璃占位文案；`big-card.html` 同一修法（值逐项相同，像素不变）。
- **失败页面让整条流水线空等 141.7s，且报错误导**（真缺陷，三个独立原因叠加）：
  ① 复用 persistent profile 时旧 `DevToolsActivePort` 没删，等待循环第一轮读到**上一轮的端口**，
  `connect()` 对着死 ws 重试满 timeout；② Windows 上 `proc.kill()` 只杀父进程，renderer/GPU 子进程
  活下来占住 profile 锁（实测留下 8 个孤儿 chrome）；③ 浏览器**启动**超时继承了页面 ready 的 120s 预算。
  现在启动超时独立（`--launch-timeout`，默认 30s）、`taskkill /T /F` 收整棵树、`close()` 等进程真的消失、
  `restart()` 换全新 profile 目录。实测 **141.7s → 27.3s**，重启从失败变成功，报错从
  `renderer is not running` 变成真实页面错误栈，孤儿进程 8 → 0。
- **抓帧失败时 ffmpeg 不死，进程挂住**：页面在 `renderFrame` 里抛错后 ffmpeg 仍持有 stdin 管道，
  `render-batch` 打印 `[batch] done` 却不退出。`launchFfmpeg` 暴露 `kill()`，catch 里先 kill 再消费掉
  必然 reject 的 `done`（否则成为未处理拒绝）。
- **失败的 WebSocket 从不关闭，进程打印完 done 也退不出去**（真缺陷）：`cdp.mjs` `connect()`
  的重试循环把失败的 `new WebSocket()` 直接丢掉，留在 CONNECTING/CLOSING 的 socket 一直持有
  事件循环句柄。症状是 `[batch] done: 2/3 ok, 1 failed` 已打印、错误也正确，但 farm/compile
  永远等下去，API job 卡在 `running` 直到 120s 超时。现在 catch 里 `close()`（+ `terminate` 若有），
  `Cdp.close()` 同理。实测失败渲染子进程 **11.8s 退出（status=1）**，API 套件 22/22。
- **成功构建顶着上一次的错误码**（假红）：`compile.mjs` 不清旧 `error.json`，`jobView` 也不看
  job 状态就投影失败字段。现在新构建一开始就作废旧记录，且 `status === 'done'` 时不投影失败字段。
- **`test-all` 的机器可读报告少报失败断言**（真缺陷，两处）：① `parseSummary` 用 `m.length===4`
  判断「有 total」，但 `N passed, M failed` 只有 2 个捕获组，于是 `failed` 被丢成 **0**、`total` 被读成
  passed——只看 JSON 会以为全绿；② 在整段尾部取**第一个**匹配，而测试用例名本身可能含汇总格式
  字符串，会把用例名当成汇总。现在每种格式显式标注语义、**从后往前逐行**找，并抽成纯模块
  `scripts/summary-parse.mjs` 以便单测（13 项）。
- **`cvs history` / `cvs verify` 静默忽略 `--spec`**：同一组版本命令里 `snapshot`/`rollback` 认
  `--spec`，`list`/`verify` 只认 `--outdir`，于是 `cvs verify v001 --spec X` 跑去 `out/` 找并报
  `E_VERSION_UNKNOWN`。现在四个命令一致（`--spec` 或 `--outdir` 都能定位）。默认 outDir 的用例
  抓不到这个错，回归特意用非默认 outDir。
- **重启后页面卡住时日志全静默**：`cdp waitFor` 现在超过 30s 先告警一次（`[wait] … still pending`），
  不再静默到 `--timeout`（120s）才报错——那种日志看起来像挂死，其实是在等页面 ready。
- **D3 宣告没有像素的编辑目标**：`addTextHit` / `addStampHit` 对空文本照样注册命中矩形，
  于是 `__hit` 里出现宽度 0 的「可编辑目标」，改它的颜色看不到任何变化。现在空文本直接返回，
  与 `recipes/util.js` `drawTopMeta` 的既有约定一致。
- **`cvs image --at` 在短段上失效**：cover 改用卡片段后，`at` 仍按正片时长算一次再套到所有图上，
  auto 与 `--at 1.0` 都被夹到同一帧。现在按**每张图自己的源**算时间并夹到该源时长内，
  清单逐图记 `at` / `atRequested` / `sourceDuration`。
- **失败对象 `logPath` 指向 manifest 而不是构建日志**：CLI 的 `logPath` 语义是「阶段诊断产物」，
  API 的 `logPath` 语义是「构建日志」，同名两义。现在 CLI 写 `detailPath`，`jobView.logPath` 恒指
  `build.log`、新增 `detailPath`（兼容旧 `error.json`）。
- **`test-all` 汇总少报总数**：`parseSummary` 强制要求 `Ran N tests:` 前缀，于是
  `34 tests: 32 passed, 2 failed` 落到通用模式，total 被读成 32。现在前缀可选，并加
  `total === passed + failed` 自洽兜底。
- **占位文案静默进成片**：`spec.mjs` 在 beat 缺 `copy` 时填「想做 / 视频？」。这不是用户内容，
  现在 `validateSpec` 发 `W_COPY_DEFAULT`（warn）把它暴露出来；两处回退共用 `CARD_COPY_DEFAULT` 常量。
- **带 `--platform` 时母版被污染**：`compile.mjs` 用同一个平台预设编 master 和平台版，
  `build --platform douyin` 出来的 `master.mp4` 是 1080×1920，随后 `qa-video` 的 `size`
  断言按 1920×1080 判 FAIL（e2e 实测 18 pass / 1 fail）。现在 master 永远按 `master` 预设编，
  平台版是附加产物。**这是「假绿」的镜像：假红——看起来像质检的问题，其实是母版被写错了。**
- **screencast 页加主标题后压到底部 HUD**：v2.4 引入 4 级字阶后，screencast 的主标题放在代码卡片
  下方，直接撞上 `drawHud` 的 `STYLE 21 / 23`。改为标题在卡片上方，并把标题高度从可用高度里先扣掉
  再计算代码字号。（看画面才发现的问题，静态断言查不出。）
- **`cvs image` 默认封面是带 HUD 的正片帧**：改为默认用第一条 `card` 段（大卡版式，无编号/倒计时），
  `--cover style` 可回退。同时不再每次清空输出目录：默认只替换本次请求的尺寸，`--force` 才整目录重出。
- **cyber-pixel 标题字阶**：页面标题是「街机大标题」，按 `display` 档（0.19 × 短边）而非 `title` 档；
  转换到低分辨率画布时按 `lh/H` 换算。
- **`deliver.mjs` 读不到封面**：现在依次找 `outDir`、`outDir/images`、`out/images`，
  支持 `--cover <file>` 显式指定；`delivery.json` 新增顶层 `cover` 与 `subtitles{ srt, vtt, cues, burnedInto }`。

### 新增
- **品牌合规进 build（P1-03）**：`brand apply` 把整包（colors/logo/fonts/voice）写进 `meta.brandKit`；
  `deepValidate()` 因此可在**没有 content/brands 的机器上**跑 `checkBrand`。检查面扩到
  `meta.title/description/tags`、`opening.title/sub`、`ending.*`、`style.copy.*`。
  build 命中禁用词/缺 logo/对比度不足 → exit 10；`brand apply` 有 error → exit 1（spec 仍写出，便于修）。
- **失败契约机器可读（P1-04）**：`GET /jobs/<id>` 新增 `errorCode / phase / failedSegment /
  failedSegments / logPath / detailPath / errorPath / artifactPath`，直接从 `<job>/error.json` 投影
  （`logPath` 恒指 `build.log`，`detailPath` 是阶段诊断产物）。
  `scripts/test-all.mjs` 统一 16 个测试脚本的四种汇总格式为 `{ok,suites,passed,failed,results[]}`，
  支持 `--json` / `--tap` / `--browser` / `--only`；`cvs test` 转为它的薄封装。
- **跨机确定性（P1-07 / P2-03）**：`golden.mjs` 的 manifest 记录 Chrome / Node / platform /
  字体集合哈希；`--check` 先比环境，不一致时**跳过哈希比对并告警**（`--strict-env` 改为失败），
  因为字体或 Chrome 变了，逐字节比对的结论没有意义。`--json` 输出单行报告。
  `scripts/bundle-fonts.mjs --lock-only` 生成可提交的 `shared/fonts.lock.json`（1187 个文件、
  set sha256），`doctor` 校验它。
- **字幕烧录（P1-08）**：`cvs build --burn-subtitles`（或 `spec.render.burnSubtitles`）。母版保持干净，
  硬字幕只进投放版；写 `<outDir>/.cvs/burned.json`，`delivery.json.subtitles.burnedInto` 如实标注。
- **封面（P2-02）**：`cvs build --cover`（或 `spec.render.cover`）复用 `cvs image` 出 card 版式封面到
  `<outDir>/images`，`delivery.json.cover` 自动引用。
- **版本快照/校验/回滚（P1-13）**：`scripts/versions.mjs` + `cvs snapshot|history|verify|rollback`。
  快照收 master/spec/plan/清单/字幕/QA/`review.json`，逐文件记 sha256+bytes；回滚**先校验再写盘**，
  回滚后核对 master 哈希并写 `rollback.json`；快照被改动则 exit 13 拒绝回滚。
- **排版 token（P1-06）**：`templates/tokens.mjs` —— 4 级字阶（display/title/body/caption，按短边归一）
  + 单一 `safe()` 安全区。13 个配方页全部 import 并写 `window.__typeProbe`；`util.js` 的 `safePad()`
  改为委托 `safe().x`。真机验收：13 页 titlePx 145..148（比值 1.021）、左右安全区逐页相等。
- **新手门槛（P1-11）**：`install.sh` / `install.ps1`（检查 Node ≥22 → `npm ci` → doctor → 下一步）；
  wizard 首屏加横幅明说「需要 Node 22+/Chrome/FFmpeg，这是本地开发页，没有托管版」。
- CLI 增 `snapshot` / `history` / `verify` / `rollback`；`--cover` / `--burn-subtitles` / `--no-deliver`。
- 错误码 112 → 125（新增 13 个本轮引入的码），注册表覆盖率 100%。

### 变更
- **安全纵深（P1-10）**：concat 清单不再用 `-safe 0`。`concatList(plan,{baseDir})` 只产出相对
  文件名并拒绝越界；`concat-and-encode.sh` 先把任意输入清单改写成安全清单再 `-safe 1`；
  `compile.mjs` 无音轨分支也在 `outDir` 内用 `-safe 1`。`assets[].path` 加根约束
  （绝对路径/盘符/UNC/`..`/远程 URL → `E_ASSET_PATH`），并补 `E_ASSET_MISSING` 磁盘检查。
- **品牌视觉进画面（P1-12）**：`meta.brandKit.logo.path` / `fonts.heading` 由 plan 展开成段 URL 的
  `?logo=` / `?brandFont=`；`segment.html` 与 `big-card.html` 右上角绘制 logo、标题用品牌字族。
  logo 加载失败写 `window.__bootError` → 渲染直接失败，不静默出片。不传参数时像素不变。
- **D7 16:9 基线重定（有意变更，不是回归）**：v2.3.5 删占位文案 + v2.4 排版 token 都**有意**改了
  16:9 像素。重定前验证过：① `git show HEAD:` 的旧页面仍逐字节复现旧哈希，说明漂移全部来自工作区的
  有意改动；② 本轮 D3 接线修复对基线**零像素漂移**。另补一组**带内容**的基线——旧基线渲染的是无
  `?title/?sub` 的页面，v2.3.5 之后那几乎只剩 HUD/背景，冻结它守不住标题排版。详见 `docs/DECISIONS.md` D7。
- **`--launch-timeout` 与 `--timeout` 分离**：页面 ready 预算（120s）不再被浏览器启动继承（30s）。
- **golden 基线重定 2/9 张（有意变更）**：`mixed/02`（aqua-morandi、无 `sub`）与 `mixed/03`
  （aqua-morandi、`sub=现在就试试`）因删掉玻璃占位副标题而改变像素。重定前**目视对照**了 HEAD 版
  与新版的渲染：02 的副标题从材质描述变为「无」（该段没给 sub），03 的副标题从材质描述变回用户
  真实的「现在就试试」；其余 7 张逐字节不变（含 big-card，证明接线修复零像素漂移）。
  重定后 `golden --check --json` **9/9 相符、环境四项全 match**。
- **浏览器测试启动加重试**：`cdp.mjs` 新增 `launchRetry()`（默认 2 次）。全套并发负载下 Chrome
  冷启动可能超过单次 30s 预算，`test-wizard-ref` 曾因此瞬时失败；与 `renderStill` 的两次尝试约定一致。
- `npm run test:all` 改走 `scripts/test-all.mjs`；新增 `test:all:browser`。

### 实测
- `node scripts/test-all.mjs --browser --json`（**17 套纯 Node + 11 套真实 Chrome = 28 套**）：
  **670 passed / 0 failed**（1018s，`ok:true`）。逐套：core 15、assets 20、variants 13、reflow 18、
  ref-core 11、from-reference 29、brand 28、motion 29、style-pages 14、spec-security 34、accent 19、
  contract 24、versioning 10、summary-parse 13、edl 22、inspect 55、wizard-ref 12、reflow-pages 55、
  recipes 92、style-pages-render 32、image 33、api 22、brand-visual 3、type-tokens 46、recovery 21。
- 3 秒 strict 全链路 `build --platform douyin --strict`（spec 内 `burnSubtitles`/`cover`）**BUILD=0**：
  master **1920×1080 / 90 帧**（干净）+ douyin **1080×1920 / 90 帧**（硬字幕）+ cover **1920×1080**
  → `qa-video` **19 pass / 0 warn / 0 fail**、`qa-audio` **5 pass / 0 warn / 3 advisory / 0 fail**
  → `delivery.json.cover` 指向封面、`subtitles.burnedInto` 只有 douyin（4 条 cue）
  → 成功构建后**无残留 `error.json`** → `cvs snapshot --label 终验` 收 **10 个文件**
  → `cvs history --spec` / `cvs verify v001 --spec` 全过（10 文件 sha256 相符）
- **41 秒全片 strict 全链路**（fixtures/mini-41s，v2.5.0 收官，2026-11-14）：`build --platform douyin --strict --concurrency 4` **EXIT=0**（425.4s；23 段 17 新渲 + 6 缓存命中）。
  `qa-video` **19 pass / 0 warn / 0 fail**（1230 帧 / 41.000s / bt709 / 黑帧·冻结·静音全零）；`qa-audio` **6 pass / 0 warn / 2 advisory / 0 fail**（cue 对齐 **97.1%** 34/35 ±30ms、BPM 120.01、−14.01 LUFS、峰值 −3.19 dBFS）。
  `cvs deliver` 出 master(34.1MB 1920×1080) + douyin(5.7MB 1080×1920) + master.srt/.vtt（14 cue）；`runs.jsonl` 记 `exit:0, qaPass:true, durationMs:425397`。
  → `cvs rollback v001 --spec` **EXIT=0**，恢复 6 文件、master sha `472aeca9e039` 与记录一致、写 `rollback.json` 回执。
- `golden --check --json`：chrome/fonts/node/platform 四项 match，3 specs / 9 stills 全等。
- `test-type-tokens`（真机 13 页 × 2 次）：46/46，titlePx 145..148，安全区左右逐页相等。
- `test-brand-visual`（真机）：3/3 —— logo+品牌字族改变同帧 sha256；logo 缺失必然渲染失败。
- `test-versioning`：**10/10**（含篡改拒绝、回滚后哈希核对、`--spec` 定位非默认 outDir）。
- `test-spec-security`：**34/34**（assets 闸门 3 项、concat 安全 3 项、`W_COPY_DEFAULT` 3 项）。
- `test-image`：**33/33**（封面版式与覆盖策略 4 项 + `--at` 按源算时 7 项）。
- `test-inspect`：**55/55**（新增玻璃主题副标题、scope 级 patch 覆盖 params、空文本不注册命中区、零宽矩形检查）。
- `test-reflow-pages`：**55/55**（D7 四条基线：无内容 + 带内容各两条；命中表审计带内容参数）。
- `server/test-api`：**22/22**（真实 4 秒渲染 + 失败契约 + 陈旧 error.json 不报假红 + 安全用例）。
- `test-renderer-recovery`：**21/21**（新增：陈旧端口文件、进程树回收、同 profile 重启、`restart()` 换目录、失败渲染限时退出）。
- `test-summary-parse`：**13/13**（五种历史汇总格式 + 用例名含格式样本 + 自洽兜底）。
- `test-compiler-contract`：**24/24**（新增汇总计数自洽断言）。

### 已知边界
- 13 个配方页的标题**字号**统一了，但**位置**仍由各页版式决定（竖排/横排/居中/靠左）。
  这是设计差异，不是遗漏；安全区与字阶才是可比较的部分。
- 封面默认用第一张 card 段，文案来自该段的 `first/keyword`。想用开场画面做封面用 `--cover style`。
- `--burn-subtitles` 需要 ffmpeg 带 `subtitles`（libass）滤镜；没有时 exit 13 `E_BURN_SUBTITLES`。
- 字体锁只记文件名/字节数/集合哈希，不记每个文件的 sha256（1187 行会拖大仓库）。
- **浏览器重启后的首个页面在负载下可能很慢**：实测一个 5 段、含失败段 3 次尝试 + 一次重启的 job
  独立跑约 75s，全套并发负载下会翻倍。渲染器会在 `--timeout`（默认 120s）后**安全失败**（不是挂死），
  且超过 30s 会先打 `[wait] … still pending` 告警。`test-api` 的失败 job 预算因此设为 300s。
  这条慢路径的根因（重启后新 Chrome 首个页面为何偶尔迟迟不 ready）**尚未定位**，只做到了「可观测 + 安全失败」。
- **D7 基线在 v2.4 重定过一次**：这是有意变更（删占位文案 + 排版 token），不是回归。重定前验证了
  HEAD 页面仍复现旧哈希、且本轮 D3 接线修复对基线零像素漂移。旧哈希保留在 `docs/DECISIONS.md` D7 作为历史。
- **41 秒全片 e2e 仍未跑**：配方页逐帧约 0.4 fps，41s/1230 帧约 50 分钟。本轮用 3s 等价样本跑完整严格链路，
  另用 `test-api` 的 4s 真实渲染、`test-recipes` 92 项与 golden 9 张静帧佐证管线。

## [v2.3.5] - 2026-11-12 — 交付契约：让「绿灯」真的代表对

内测集群（1 名 PM + 6 名异质内测者，76 条意见）汇总出三类「假绿」：
**占位内容上屏 / QA 只验容器 / 缓存成功返回旧画面**。本版把它们变成红灯，并补齐失败契约。

### 修复（内测 P0）
- **默认成片不再印开发者占位符**：`meta.title/description`、`opening.title/sub`、`style.copy{title,subtitle,caption}` 由 plan 下发到段 URL；`segment.html` 不再回退 `风格段标题` / `替换 drawScene()`；`big-card` 的 brand 缺省不再写 `{{BRAND}}`。`meta.brand` 为占位符、标题为空都是 **error**（原 `W_BRAND` 仅警告）。
- **`cvs build` 内置深度校验**：新增 `templates/spec-check.mjs`，`lint` 与 `build` 共用（页面/主题/APCA/占位品牌/标题）。以前主题拼错 `build` 静默出片。退出码分层：`10` spec · `11` render · `12` concat · `13` qa · `14` env，并写 `<outDir>/error.json`（含 `failedSegments`）。
- **音频不再静默丢失**：`build` 在 `spec.audio` 存在时自动合成配乐并 mux；没有音轨必须显式 `--no-audio`（`E_AUDIO_REQUIRED`）。`qa-audio` 纳入 build。
- **缓存感知页面内容**：`segmentHash` 新增 `pageHash`（页面 + 递归依赖的 sha256）；`ENGINE_VERSION` 1→2。改模板/配方页不再命中旧缓存。
- **`--resume` 双校验**：必须同时满足「帧数一致」且「上次 manifest 的 hash 一致」才跳过；不再把旧画面以新 hash 写回缓存。
- **QA 内容级断言**：`qa-video` 新增 `pages exist` / `placeholder pages` / `copy present`；`qa-audio` 的 cue 对齐分母改为**全部 cue**（不再排除未对齐项），拍网格改为声明式 `--subdiv`（不再自适应择优）。
- **音频质检量的是「要交付的那条音轨」**：合成器母版峰值 `-0.6 dBFS` 高于 `qa-audio` 的 `-1.0 dBFS` 门限，且质检跑的是未归一化的合成 `wav` 而不是成片音轨——自动配乐必然把 `--strict` 打成失败。现在 `master` 峰值收到 `-1.5 dB`，`build` 先用 ffmpeg 从 `master.mp4` 抽出音轨再质检（量到的是过完 `loudnorm` 的真音轨）。
- **质检三档语义，红门禁不再「永远红」**：原 `--strict` 把任何 `WARN` 变失败，于是「音乐好不好听」的提示（拍网格、HF 克制、BPM 识别、VMAF 没装、封面拼图）也会拦下交付——和假绿一样没用。现在分 `FAIL`（交付物是错的）/ `WARN`（交付物不合格，`--strict` 判失败）/ `ADVISORY`（诊断与听感提示，永不拦交付）三档。
- **平台交付真的接线**：`render.preset` / `--platform` 产出 `<outDir>/<platform>.mp4`（master 始终保留）；`render.outDir` 越出项目根报 `E_OUTDIR`。
- **变体不再互相覆盖**：每个变体有自己的 `render.outDir`；`specHash` 不含 outDir（内容寻址）；copy 轴同时改 `meta.title`。
- **API 安全收紧**：写操作校验 `Origin`/`Host`（`E_ORIGIN`/`E_HOST`）、只接受 `application/json`（`E_CONTENT_TYPE`）；HTTP 客户端**不能**自带 `allowRemotePages`（SSRF 闸门）；`--host` 非回环必须 `--token`；job 日志脱敏。
- **`--root` 默认改为 cwd**（原先与自身 help 矛盾），报错回显解析出的 root。

### 新增
- `cvs again [--set k=v]`：读上次 spec、改字段、只重编译 dirty 段。
- `cvs deliver`：`delivery.json`（平台/文件/sha256/时长/封面/标题）+ `master.srt` / `master.vtt`。
- `cvs errors`：`schema/errors.json` 注册表（112 码，100% 覆盖）+ 生成 `docs/ERRORS.md` + CI `--check`。
- `scripts/doctor.mjs` 重写：renderer 能力探测（不再被「装了 playwright-core」误报）、bash 检查、每行 `code`/`fix`、`--json` 带 `cliVersion`/`resolved`、`--strict` 真正严格。
- 离线分发：`scripts/vendor.mjs`、`scripts/bundle-fonts.mjs`、`docs/OFFLINE.md`、`docker/Dockerfile`、`.nvmrc`；`arm.sh --offline`；`build-fonts` 复制 OFL 文本 + `THIRD-PARTY-NOTICES.md`。
- 多画幅 `3:4` / `6:7`（小红书 / 视频号真重排，不再补黑边）。
- `scripts/test-compiler-contract.mjs`（16 项契约回归）；CI 增 `windows-static` job、`cache: npm`、移除 `|| npm install`。
- SPEC 文档：`meta.title/description/tags`、`style.motion/copy/reflow`、`pageBlock.title/sub/capsule`、平台枚举补 `xiaohongshu|weixin`。

### 变更
- `engines.node` `>=20` → `>=22`（raw CDP 依赖全局 WebSocket）。
- fixture `mini-41s` 迁移到真实配方页（原先 6 个风格段全指向占位页），并带上标题/品牌/每段文案。
- `SKILL.md` 新增 §0.0 Agent 执行契约（完成定义 / 硬断言 / 报错→动作 / 退出码）；文件地图移入 `references/repo-map.md`；§13 标注为 timeline v1 旧项目专用。

### 实测
- `npm run test:all` EXIT=0（含新增 16 项契约回归）。
- `node server/test-api.mjs` 20/20（真实 4 秒渲染 + 4 项新安全用例）。
- **3 秒契约片全链路 `build --platform douyin --strict` EXIT=0**（`out/e2e-3s/`）：render 5/5 → `master.mp4` + `douyin.mp4` → `qa-video` **19 pass / 0 warn / 0 fail** → `qa-audio` **6 pass / 0 warn / 2 advisory / 0 fail** → `cvs deliver` 出 `delivery.json`（master + douyin 两条，sha256 一致）。
- 失败记录可查：同一 `runs.jsonl` 里保留了两次 exit 13 的失败运行，与最终 `exit 0 / qaPass true` 并列（`out/e2e-3s/.cvs/runs.jsonl`）。
- 41 秒 fixture 全链路未在本轮跑完（配方页约 0.4 fps，全片需约 50 分钟）；改用上面的 3 秒等价样本 + `test-api` 的 4 秒真实渲染佐证管线。

## [v2.3.4] - 2026-11-12 — 长城页三处排版修正（看画面看出来的）

v2.3.3 出图后逐张放大检视，修掉三处只有看画面才会发现的问题：

- **强调线压字头 → 改为标题下划线**：金色强调线原本在 `titleY - titleSize*1.02`，4 字大标题下离字形顶部只剩 20 多像素，读起来像压在「万里」头上。现在放到标题**下方**（`titleY + subSize*0.62`），副题再下移一档。
- **下划线长度跟标题走**：固定 `0.16W` 在 4 字标题下只盖住前两个字，像没画完。改为 `min(ruleW, 标题实宽 × 0.62)`，居中版按标题宽度居中。
- **HUD 与中缝帧号撞车**：1080 宽画布上 `STYLE 24 · GREAT WALL` 的尾部与居中的 `CVS · FRAME 076 / 098` 重叠约 9px。窄画幅（`W < 1200`）把画风名收成 `WALL`，1920 仍用全名。**没有改共享 `drawHud`**——那会改动其他页面的字节基线。

### 实测
- `cover 1920×1080 / poster 1080×1350 / story 1080×1920` 三档重新出图并逐张核过：下划线居中且长度合理（poster 实测 325px，位于标题 61% 宽），HUD 三段留白清楚。
- `npm run test:all` EXIT=0；`test-style-pages-render` **32/32**（greatwall 16:9 / 9:16 / 确定性 / 真重排四项全过）。

## [v2.3.3] - 2026-11-12 — 新画风「长城 / GREAT WALL」+ 配方页 24

用"画一个长城"当验收题：从一句自然语言到成套图片，全程走产品入口，不改任何管线代码。

### 新增
- **配方页 24 `templates/recipe-greatwall.html`**：纯 Canvas 画出的长城晨昏景。
  - **四层山脊**：`makeHeight()` 用固定种子的分形正弦叠加（`mulberry32`，无噪声库、无 RNG），每层独立 seed/freq/octaves；远脊融进天空、近脊压成剪影（大气透视）。
  - **长城本体**：沿墙脊取样成中心线 → 受光顶边 + 阴影底边 + 梯形墙带；**垛口**按 x 均匀排布（不是按采样点，远端不会挤成一坨）；**敌楼**四个，台身梯形 + 出檐 + 两条箭窗；透视近大远小（`scale` 1 → 0.46）。
  - **晨昏天**：渐变 + 日轮 + 径向光晕，与 t 无关 → 启动时烘进离屏画布，逐帧只 `drawImage`。
  - **入场**：山脊自远及近显影 → 城墙自左向右建成 → 垛口/敌楼跟随抵达 → 标题逐字升起 → 底部压暗带就位。
  - 竖屏真重排（地平线抬高、山脊更陡、标题居中下移），不是把横屏压扁。
- **新画风 `great-wall`**：`STYLE_IDS` / `STYLE_LABEL`（长城）/ `STYLE_RULES` 关键词（长城 · 关隘 · 边塞 · 山海关 · 嘉峪关 · 万里长城 · great wall · fortress · rampart）/ `STYLE_PAGES` / `STYLE_RECIPE_IDS` / `STYLE_MOTION`（`dynamic`，雄浑壮阔走强档）。画风总数 12 → 13。
- `scripts/test-style-pages-render.mjs` 纳入 greatwall（真机 16:9 + 9:16 + 确定性 + 真重排）。

### 实测（一句话 → 一套图）
```bash
node scripts/nl2spec.mjs "画一条万里长城的品牌宣传片，主打雄浑壮阔" --out out/gw3/gw.spec.json
#   style: great-wall | motion: dynamic（由 promo × great-wall 推导）| page: templates/recipe-greatwall.html
node bin/cvs.mjs image --spec out/gw3/gw.spec.json --set cover,card,poster,story --out out/gw3/set
#   cover 480KB / card 342KB / poster 440KB / story 526KB，8.0s，四次运行哈希稳定
```
关键词「万里长城」直接命中 `great-wall`，无需 `--style`。

### 修复（本页自查出来的三处）
- **强调线横穿城墙**：标题原本放在 `0.755H`，正好切在墙脊上。改为压在**底部剪影带**内（`pad*2.2` 起算），强调线随之离开画面主体。
- **竖屏标题整体偏左**：`ctx.textAlign='center'` 与手算的居中起点 `W/2 - total/2` 叠加成双重居中。改为逐字手排一律 `textAlign='left'`，居中只由起点负责。
- **副题与底部 HUD 挤在一起**（4:5 / 9:16 明显）：标题块整体上移，留出 HUD 高度。

## [v2.3.2] - 2026-11-12 — 代码生图：`cvs image`（spec → 图片集）

把"代码逐帧画"的能力正式开到**图片**产品面。渲染管线本来就是 Chrome 抓帧出 PNG/JPEG（`render-segment --still`、golden 回归都在用），技术上早就通了；缺的是产品入口——没有命令、没有成套社媒尺寸、没有清单。这个版本补上。

### 新增
- **`cvs image` / `scripts/image.mjs`**：从**同一个 spec** 出一套图。
  ```bash
  cvs image --spec project.spec.json                    # cover/card/poster/story
  cvs image --spec project.spec.json --set cover,card --at 2.4
  cvs image --spec project.spec.json --from r02-style --out out/stills
  cvs image --page templates/recipe-guofeng.html --theme celadon-paper --set poster
  cvs image --list                                      # 列出全部预设
  ```
- **6 个尺寸预设**：`cover` 1920×1080（视频封面）、`wide` 2560×1080（头图）、`card` 1080×1080（方图）、`poster` 1080×1350（小红书/微博 4:5）、`story` 1080×1920（Story/竖屏封面）、`avatar` 800×800（小图）。默认集 `cover,card,poster,story`。
- **`--at auto`**：帧时间取段落时长的 **78%**（画面已稳、还没收尾），也能 `--at 2.4` 手定点。`heroTime()` 有上下界，永不超过片尾。
- **`image-manifest.json`**：每张图记 `preset / 尺寸 / 文件 / 字节 / sha256`，整份记 `at / format / page / segment / segmentKind / segmentHash / theme / motion / accent` —— 可以直接当资产清单或缓存键。
- **`scripts/test-image.mjs`**（24 断言，真机 Chrome）：预设表、`heroTime` 数学、`--list`、真出图（尺寸/非空帧/清单与磁盘逐项比对）、同参逐字节相同、换 `--at` 哈希必变、页面来自 plan 段 URL。

### 设计要点
- **图与视频同源**：走的是 **plan 里那条段的 URL**，所以 `?theme=` / `?mp=` / `?accent=` 与成片完全一致——不会出现"视频一套配色、图另一套"。`--from r02-style` 可指定段，默认取第一条 `style` 段（画风段最有画面）。
- **一个浏览器渲完所有尺寸**：`withRenderer()` + `ctx.stills()` 每尺寸开新 page（`newPage({width,height})` 改视口），不是每个尺寸起一次 Chrome。实测 4 张 16.5s。某尺寸失败会自动 `ctx.restart()` 重试一次。
- **确定性**：同 spec + 同 `--at` + 同尺寸 → 同一 sha256（已实测两次运行 4/4 逐字节相同），符合 `frame = f(t)` 的硬约束。
- **防呆**：低于 8 KB 的图判为疑似空帧，打印告警并以非 0 退出（1080p 纯色 PNG 通常 3–12 KB）。

### 实测
- 国风 spec：`cover 1920×1080 / card 1080×1080 / poster 1080×1350 / story 1080×1920`，740 / 439 / 521 / 672 KB，唯一色 215–258，最高频色占比 14–24%（真插画，非空帧）。
- 二次运行 4/4 sha256 相同；`--at 1.0` 与 `--at auto(2.548)` 的 cover 哈希不同。
- `node scripts/test-image.mjs` → 24 / 24 PASS。

## [v2.3.1] - 2026-11-12 — 画风真出片（F1）+ 全仓安全加固

一次以**审计**驱动的版本：v2.3 收尾时对全仓做了一轮检查，修掉一条产品级断链（F1）、一处主题配色不合规（F2），以及 7 类安全/健壮性问题（C/H/M/L）。

### 新增
- **画风 → 渲染页 单一真值** `templates/style-pages.mjs`：`STYLE_PAGES`（12 个画风 → 页面）、`STYLE_RECIPE_IDS`（`?recipe=` 页内提示）、`stylePageFor()` / `styleRecipeIdFor()` / `styleQueryFor()`。未知画风回落**通用场景页**，不再回落占位骨架。新增配方页只需在这里加一行。
- **7 个新配方页**（都实现 `window.renderFrame` + `__ready`，零非确定性 API）：
  - `recipe-glitch.html` — 切片位移 + RGB 通道分离 + 撕裂线 + 滚动扫描带；
  - `recipe-guofeng.html` — 宣纸纤维 + 云纹弧线 + 竖排标题 + 朱印（贴在末字左侧、带边界钳制）+ 金线；
  - `recipe-whiteboard.html` — 手绘矩形/箭头/圆圈/下划线，抖动由 `hash01` 驱动（无 RNG）；
  - `recipe-threed.html` — 等距投影 `project()`（`ISO_X=cos30°`），单位坐标 + 顶面高光扫掠 + 环绕光源；
  - `recipe-screencast.html` — 编辑器面板 + 逐 token 布局 + 打字计数 + 闪烁光标；
  - `recipe-flat.html` — 预排版扁平插画，色带贴合标题宽度，`ease.outBack` 落入；
  - `recipe-minimal.html` — `fade + 12px 上浮`，规则线擦除，说明文字留在 HUD 之下。
- **测试**：`scripts/test-style-pages.mjs`（14 断言，纯 Node：枚举对齐、文件存在、页面契约、无 RNG、回落、nl2spec 端到端、plan 通过）；`scripts/test-style-pages-render.mjs`（28 断言，真机 Chrome：7 页 × 16:9/9:16 双画幅、非空白、同参确定、竖屏真重排哈希不同）。
- **死导出审计** `scripts/audit-exports.mjs`：扫描每个 `export` 的生产调用点，输出死导出清单（v2.3.1 用它确认 `motion.js` 已 0 死导出）。
- **API 跨源白名单**：`node server/api.mjs --cors <origin[,origin]>`。

### 修复
- **F1（产品级断链）**：`?recipe=` 是死参数——`segment.html` 从不读它，于是 `cyber-glitch` / `ink-wash` / `guofeng` 等所有画风出片都是占位骨架（"替换 drawScene() 开始做真正的画面"）。现在 `nl2spec` / wizard 按 `style-pages.mjs` 填 `style.page`，且 `templates/spec.mjs` 会校验页面存在。已用一条国风片端到端复核：style 段渲染的是竖排标题 + 朱印 + 云纹的真实国风页。
- **F2（配色不合规）**：`aqua-morandi` / `graphite-signal` / `claude-light` / `crimson-theater` 四主题的 accent 过不了 APCA。修在 `content/combos.json` 的 `_meta.accentFix`（含每个颜色的取值理由），`nl2spec` 从数据读取而不是再抄一份硬编码表。
- **F3（产品级断链，比 F2 更严重）**：`look.accentOverride` **从来没有到达任何页面**——页面只读 `?theme=<id>`，`themeFromURL()` 也不认 accent。后果有两个：① F2 的 accentFix 只让 lint 闭嘴，画面仍是原配色；② `cvs brand apply` 写入的品牌色在成片里根本不出现。修法：`normalizeAccentOverride()` → `specToTimeline.meta.accent` → `buildPlan` 把 `?accent=` / `?accentInk=` / `?accentSoft=` 拼进**每一类段**的 URL（opening/card/style/more/flash/ending）→ `themeFromURL()` 读回并调用 `accentOverride()`。无覆盖时 URL 不变，旧成片逐像素不变。实测同一页带/不带 `?accent=#00d4ff`：**76.6% 像素不同**（背景/辉光/HUD 都派生自 accent），确认这条通路此前是彻底断的。
- **C-1 路径逃逸**：`rounds[].id` 直接变成段文件名与 ffmpeg concat 清单的一行，`../` 可写越 `outDir`。加 `SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`，非法报 `E_ROUND_ID`。
- **C-2 换行注入**：同一个闸门顺带挡掉 id 里的换行/引号/空格——它们会往 concat 清单里注入额外条目。
- **H-1 远程页面（SSRF）**：`*.page` 会被渲染器当 URL 直接 navigate，`http(s)://…` 可探测内网。现在默认拒绝（`E_PAGE_REMOTE`），要开须显式 `render.allowRemotePages: true`。
- **H-2 绝对路径逃逸**：`path.resolve(root, p)` 遇到 `/x` 或 `C:\x` 会忽略 root。抓 POSIX/盘符/UNC 三种形态，报 `E_PAGE_ABS`（纯正则实现，spec.mjs 可在浏览器跑）。
- **M-1 通配 CORS**：API 此前回 `Access-Control-Allow-Origin: *`，任何网页都能对 `127.0.0.1:5190` 灌任务、读 spec 与日志、下载成片。改为**默认同源**（不发 CORS 头），需要跨源用 `--cors <origin>` 白名单（带 `Vary: Origin`）；`OPTIONS` 预检只在白名单命中时回 CORS 头。
- **M-2/M-3 资源上限**：`MAX_QUEUE=32`（队满回 `429 E_QUEUE_FULL`）、`MAX_JOBS=200` + `evictOldJobs()`（只淘汰已结束的）；spec 侧 `MAX_FLASH_COUNT=256`（`E_FLASH_MAX`）、`MAX_SEGMENT_SECONDS=600`（`E_STRUCTURE_MAX`）、`MAX_TOTAL_FRAMES=18000`（`E_DURATION_MAX`）。此前 `flash.count=100000` 或 `structure.round=1e9` 能排出天文数字的段与帧。
- **M-4 绝对路径泄露**：错误响应里的本机目录替换成 `<path>`（`scrubMessage()`），既保住"是哪个文件"又不暴露目录结构。
- **L-1 点文件泄露**：`app/canvas/serve.mjs`、`app/script/serve.mjs`、`templates/render-segment.mjs` 三个静态服务器此前可 `GET /.git/config`。现在路径任一段以 `.` 开头即 404（`.` / `..` 仍放行给归一化处理）。
- **内部缺陷**：`server/api.mjs` 的 `416 Range Not Satisfiable` 分支把 `req` 传成了第 5 个参数（`{}` 占了 `req` 位），CORS 头在该分支失效。已修正实参顺序。

### 变更
- `templates/spec.mjs` 新增闸门常量导出（`MAX_FLASH_COUNT` / `MAX_SEGMENT_SECONDS` / `MAX_TOTAL_FRAMES`）、`normalizeAccentOverride()` 与 `render.allowRemotePages`（默认 `false`）。
- `templates/themes.js` 的 `themeFromURL()` 现在接受 `?accent=` / `?accentInk=` / `?accentSoft=`（只影响传入覆盖的页面；不传时逐字段原样返回）。
- `segmentHash` 加入 `accent`：换品牌色/换 accentFix 必然重渲染，缓存不会错误复用。
- **golden 基线**：`fixtures/golden/mixed` 的 2 张静帧（`02-t2.500` / `03-t4.250`）按新行为重生成——它是唯一带 `accentOverride` 的 fixture，此前那行配置被静默忽略。`card` / `cyber` 的 7 张哈希不变；`manifest.json` 里的 `page` 字段顺带补上了 v2.3 的 `?mp=standard`（元数据此前滞后，不影响哈希比对）。
- `bin/cvs.mjs` / `package.json` 测试清单加入 `test-style-pages.mjs`、`test-style-pages-render.mjs`、`test-spec-security.mjs`、`test-accent-route.mjs`。

### 实测
- **F1 端到端**：国风片编译通过，style 段帧里是真实国风画面（竖排标题 + 朱印 + 云纹），不是占位骨架。
- **F3 端到端**：同一页 `?theme=coral-noir` 与 `?theme=coral-noir&accent=%2300d4ff&accentInk=%23001016` 的静帧，**76.62% 像素不同**（`max channel-sum delta 478`），证明覆盖值真的进了渲染；`cvs brand apply` 的品牌色现在出现在每个段的 URL 与页面的 `THEME.colors.accent` 里。
- **golden**：`card` / `cyber` 7 张哈希不变，`mixed` 2 张按新行为更新（唯一带 accentOverride 的 fixture）；`npm run golden` 与 `--selfcheck` 均 9/9。
- **渲染一致性交叉验证**：同参下「静帧 PNG」与「视频帧」逐像素对齐——`coral-noir` 静帧 = 直渲视频帧 30（ink bbox `w=1600`）；`celadon-paper` 静帧 = `render-batch` 视频帧 30（`w=1552`），平均绝对差 `2.81`（x264 有损编码的正常振铃，锐边处最大 34，占比 0.004%）。批量 worker 路径与单进程路径产出一致。
- **测试**：画风页真机渲染 28 断言、画风契约 14 断言、spec 安全闸门 25 断言、强调色通路 19 断言、API 16 断言全过；`audit-exports` 确认 `motion.js` 死导出 0。

## [v2.3.0] - 2026-11-12 — 动效档位接入管线（motion profile → spec → plan → 页面）

### 新增
- **动效档位表** `templates/motion-profile.mjs`：4 档 `calm` / `standard` / `dynamic` / `maximal`，每档给出转场类型、主/次缓动、弹簧预设、stagger、动态文字模式、冲击/抖动/白闪/缓推倍率、颗粒与扫描线强度、模糊上限。档位是**乘数**，不是第二套实现。
- **自动推导**：按「视频类型 kind × 画风 style」推导档位（style 特例 > kind 默认 > 回落 standard），显式 `look.motion` 永远优先。赛博像素/赛博故障 → maximal，发布会/极简/水墨 → calm，知识科普 → standard。
- **传递管线**：`spec.look.motion` → `specToTimeline` 推导 → `meta.motion` → `buildPlan` → 每页 URL 的 `?mp=<level>`；页面按档位名自行展开参数（档位表改了旧 URL 也按新表解释）。
- **质感层上线**：`motion.js` 的 `drawGrain` / `drawScanlines` / `drawPaperTexture` 首次被生产页面调用（`segment.html` / `big-card.html`），只由档位驱动。
- **CLI**：`cvs motion list | show <level> | derive --kind --style | matrix`，可查档位与推导矩阵。
- **测试**：`scripts/test-motion-profile.mjs`（29 条）覆盖档位表结构、推导规则、URL 往返、spec 校验、plan 传递、段哈希含档位、standard 逐位等价 v2.2、nl2spec 推导。

### 变更
- **缓动统一为一份真值**：`templates/motion.js` 是唯一实现。此前 `common.js`、`recipes/util.js` 各抄了一份 `ease`（三份数值逐点相同）；现在两者都改为 re-export。`common.js` 与 `motion.js` 的 `ease` 现在是**同一个对象**。
- **spec**：`look.motion` 字段（`null` = 自动推导）；非法值报 `E_MOTION`。schema 同步。
- **段哈希**：`segmentHash` 加入 `motion`，换档位必然重渲染（缓存不会错误复用）。
- `createSegment` 的 `scale` 改写为与 v2.2 原式同构（`1.13 - 0.13 * impact * k`），避免最后一位浮点差。

### 修复
- `createSegment` 档位化后 `scale` 曾写成 `(1 + 0.13*impact) - ...`，与 v2.2 原式在最后一位不同（`1.1287850546264648` vs `...46`）。已改为同构写法，15005 个采样点逐位相同。

### 实测
- **零像素变化**：`segment.html` 与 `big-card.html` 的「无 query」与「`?mp=standard`」渲染 SHA-256 完全相同；D7 冻结基线仍成立（`test-reflow-pages` 51/51）；golden 9/9 静帧逐字节一致。
- **档位生效**：4 档在同一页产生 4 个不同哈希。
- **缓存正确性**：换档位后 5/5 段重渲染（`skipped=5`），缓存条目 5 → 10；同档位热编译 5/5 命中，1.62 s。
- **端到端**：`maximal` 档 5.5 s / 165 帧 / 1920×1080 / 30fps 编译成功。
- 测试：`npm run test:all` EXIT=0（新增 29 条）；画布 48、参考图上传 12、竖屏重排 51、配方 92、API 11 全部通过。

## [v2.2.0] - 2026-11-11 — 批渲染 / 竖屏重排 / 任务 API / 黄金回归 / 品牌包 / 配方 13–16

### 新增
- **批渲染 worker**：`templates/render-batch.mjs`；`render-farm` 默认把选中段按 shard 交给 N 个 worker，每个 worker 只付一次静态服务器 + 一次浏览器启动；`--legacy` 保留逐段进程模式；段缓存语义不变。
- **多画幅重排**：`big-card.html` / `segment.html` 按视口自适应（横 / 竖 / 方），竖屏是真正重排不是缩框；16:9 输出位级不变（基线哈希见 `docs/DECISIONS.md` D7）。`scripts/test-reflow-pages.mjs` 51 断言。
- **任务 API**：`server/api.mjs`（127.0.0.1:5190）：`POST /jobs` 校验并入队、`GET /jobs/<id>` 状态与日志尾、`GET /jobs/<id>/master.mp4`（Range）、`DELETE` 取消、`GET /health`；单队列 + 子进程编译 + `build.log`。
- **评审页**：`app/review/`（5185）播放成片、按时间码写帧级评论（localStorage）。
- **黄金视觉回归**：`fixtures/golden/`（card / cyber / mixed 三项目 × 3 帧）+ `scripts/golden.mjs`（`--update` 写基线、`--selfcheck` 同机双跑比对、默认校验）；CI 追加 `golden` job（自一致校验，避开跨机字体/Chrome 差异）。
- **品牌包**：`content/brand.schema.json`、`content/brands/{tech-dark,example}.json`、`scripts/brand.mjs`（`apply` / `check` / `list`；禁用词、accent APCA、logo 存在性与安全区）。28 测试。
- **配方 13–16**：`templates/recipe-{kinetic,datarace,inkwash,8bit}.html` + `templates/recipes/util.js`；每帧 0.5–2.6ms，92 断言。
- **测试**：`scripts/test-{brand,golden,recipes,reflow-pages,render-perf}.mjs`、`server/test-api.mjs`；`npm run test:all` 现在 206 条纯 Node 测试。

### 修复
- `render-farm` / `render-batch` 在 `outDir` 为绝对路径时与 root 二次拼接，缓存与 manifest 变成 `<root>/<root>/...`，产物与缓存写不出去（回归修复）。
- 批次 worker 的 shard 参数 `1/1` 在 0 基索引下选空段；改为 `0/1`。
- ink-wash 大幅半透明图层的非整数缩放造成帧间抗锯齿抖动；绘制几何取整（跨进程仍位级一致）。

### 实测
- **冷编译** 41s fixture（1230 帧，1080p30）：并发 4 为 **4m30s**，并发 2 为 **4m48s**（改造前逐段进程 9m34s，约 2.1×）；两者产物均 1230 帧、QA 0 fail。
- **缓存重编译**：**1.9–3.2s**，23/23 段命中（含 concat）。
- 黄金回归 9 张静帧（位级）；竖屏 51 断言；配方 92 断言；画布 48 断言；参考图上传 12 断言；纯 Node 206 测试。

## [v2.1.0] - 2026-11-11 — 编译器（spec IR / 段哈希 / 增量编译 / 画布圈选 / 入口）

### 新增
- **spec IR v1**：`schema/project.spec.schema.json` + `templates/spec.mjs`（normalize / validate / migrate / script→rounds），timeline v1 可无损迁移。所有入口只产出 spec。
- **plan 编译器**：`templates/plan.mjs` 在 timeline 帧对齐之上为每段生成 `segmentHash = sha256(plan/engine/page/frames/t0/speed/theme/brand/assets/patches)`，并输出 spec 摘要与 warnings。
- **内容寻址缓存**：`render-farm --cache`，命中 `<outDir>/.cache/<hash>.mp4` 直接复用；实测 23/23 命中时整片重编译 3.9 s。
- **一键编译**：`scripts/compile.mjs` = lint → plan → render → concat → qa；无音轨时走 video-only concat。
- **spec 闸门**：`scripts/spec-lint.mjs` 校验页面存在性、主题真实性、APCA（HUD/大字按实用阈值），并输出 JSON 报告。
- **入口**：`app/wizard/`（8 预设 + 七张卡 + 实时 spec + 下载）、`scripts/nl2spec.mjs`（确定性规则 NL→spec，20 条语料回归）、`content/presets.json`、`content/combos.json`（13×12 兼容矩阵）。
- **画布与编辑契约**：`templates/edit-bridge.mjs` + `__spec/__inspect/__inspectRect/__patch/__patchMany`；big-card 注册 6 个节点（文案/关键词/强调色/版式/编号/品牌），segment 注册 5 个（主副标题/HUD/倒计时/水印）。`app/canvas/` 支持 scrub、点选、Shift+拖拽框选、多选统一改色、schema 面板、patch 导出。48 条契约测试。
- **剧本与版本**：`app/script/` 表格编辑（就地改、超长标红、实时 JSON）、`app/versions/` localStorage 版本树 + 并排 diff + 恢复；30 条模型测试。
- **素材与批量**：`scripts/assets.mjs`（sha256 + ffprobe + 注册表）、`scripts/variants.mjs`（笛卡尔变体矩阵 + manifest）、`templates/reflow.mjs`（16:9→9:16/1:1 spec 级重排，非裁切）。
- **素材摄取**：`ingest/` 提供 ffprobe、场景切分、静音检测、可选 ASR 适配、打分选段、EDL、`edlToScript` 生成合法 spec；22 条纯函数测试。
- **第 12 套画风**：`templates/styles/cyber-pixel.js` + `templates/cyber-pixel.html`（量化/Bayer 抖动/扫描线/色差/CRT/辉光，全为 t 的纯函数）；`references/long-form.md` 41 s 单风格三幕编排规则。
- **参考图**：`scripts/from-reference.mjs`（ffmpeg 解码 + OKLab k-means + 主题色板最近邻 + APCA 闸门 + top-3 候选），支持 `--spec` 合并进 `look`；`scripts/ref-core.mjs` 抽出 Node/浏览器共用核心；Wizard 支持直接拖入/选择参考图，浏览器内采样并写 `meta.reference`。29 条真图 + 11 条核心 + 12 条端到端回归。
- **统一 CLI**：`bin/cvs.mjs`（new / ref / lint / plan / build / variant / ingest / wizard / canvas / script / versions / test / doctor），支持 `./project.spec.json` 默认值。
- **CI**：`.github/workflows/compiler.yml` 跑全部纯 Node 测试 + spec 闸门 + plan + CLI 冒烟。
- **测试入口**：`npm run test:all`（178 条零依赖测试）、`test:browser`（48 条画布契约 + 12 条参考图上传 + 赛博像素确定性）、`dev:wizard|canvas|script|versions`。

### 变更
- 默认流程仍是 timeline v1；spec v1 为新增编译层，旧项目不传 spec 时行为不变。
- `shared/fonts/`（32 MB 生成物）加入 `.gitignore`，由 `bash arm.sh` 重建。

### 实测
- 41 s fixture：1230 帧 / 1920×1080 / 30 fps；冷编译 9m34s@4（Chrome 启动争用 + 1 次瞬态 CDP 超时），缓存命中后重编译 3.9 s；QA 10 pass / 1 warn（无音轨）/ 0 fail。
- 赛博像素：3 张静帧同 t 两次渲染 PNG sha256 完全一致；1 s 段 30 帧。

## [v2.0.0] - 2026-11-11 — Studio 升级（时间轴 / 零依赖渲染 / 并行 / 质检 / OKLCH）

### 新增
- **时间轴单一真源**：`templates/timeline.mjs` 校验 `timeline.json`，按 `round(t×fps)` 吸附帧边界，生成 `out/plan.json` + `out/segments.txt` + cue sheet。30 fps 下 0.25 s 闪段自动变成 8/7/8/7 帧，11 轮示例精确 33 段 / 1830 帧 / 61.000 s。规范见 `references/timeline-schema.md`。
- **零依赖渲染回退**：`templates/cdp.mjs` 直接用 Node 内置 WebSocket 驱动系统 Chrome/Edge（`DevToolsActivePort` + flat CDP）；没有 Playwright 也能渲染。`render-segment.mjs` v2 自动选择 Playwright 或原生 CDP。
- **取帧提速**：单 canvas 全屏页面走 `canvas.toDataURL()`（快 30–50%）；DOM 叠加自动回退 `Page.captureScreenshot({optimizeForSpeed:true})`；`--capture auto|canvas|cdp`、`--format jpeg|png`、`--vars`。
- **色彩正确性**：中间片 `in_range=pc → tv`、`bt709/bt709/bt709/tv` 四元标签、`-video_track_timescale 90000`；v1 的色彩标记缺失问题修复。
- **并行渲染农场**：`templates/render-farm.mjs` 一进程/一浏览器/一段，`--concurrency`、`--retries`、`--resume`（ffprobe 帧数对账）、`--only/--kinds/--from/--to/--shard`，写入 `out/render-manifest.json`。
- **平台交付预设**：`concat-and-encode.sh` v2 支持 `master/youtube/bilibili/douyin/xiaohongshu/weixin/archive`，CRF 终编、两遍 `loudnorm`（−14 LUFS / −1 dBTP）、bt709、faststart，concat copy 失败自动归一化重编。见 `references/platform-presets.md`。
- **视频质检**：`scripts/qa-video.mjs` 检查 codec/pix_fmt/尺寸/fps/帧数/色彩/时长/黑帧/冻结（卡片/闪白白名单）/静音/LUFS/可选 VMAF+SSIM/接触表，输出 `qa/qa-video.json`。
- **音频质检**：`scripts/qa-audio.py` 用 numpy/scipy 计算峰值/削波/BS.1770 响度/自相关 BPM/拍网格相位（1/1、1/2、1/4 细分取最优）/cue ±30 ms 对齐（覆盖率计权）/8–16 kHz 高频克制/静音，输出 `qa/qa-audio.json` 与频谱图（matplotlib 可选）。
- **配乐对齐**：`templates/synth_audio.py --plan out/plan.json` 读取 `stats.duration` 与全部 `audio.cues`，生成全片长度并把每个 cue 落到鼓点上；61 s 实测 100% cue 命中 ±30 ms、BPM 120.01、网格命中 95.2%，合成耗时约 5.6 s。
- **OKLCH 色彩引擎**：`templates/color.js` 提供 sRGB↔OKLab↔OKLCH、gamut clamp、`mixOklch`、`derivePalette`、WCAG、APCA（Lc）、`readableInk`。
- **动效库**：`templates/motion.js` 提供闭式解弹簧、Manim 风格 rate function、stagger、keyframe track、`transitionParams`、CJK 避头尾排版、`fitText`、`drawKineticText`、grain/paper/scanlines/RGB split/bloom/halation。`common.js` 重新导出。
- **5 套新主题**：`cyber-neon`、`paper-journal`、`dark-gold-cinema`、`ice-minimal`、`pop-acid`，共 13 套；均通过 WCAG 审计，`theme-audit.mjs` 同时输出 APCA。
- **脚本工具**：`doctor.mjs` 环境体检、`new-project.mjs` 一键脚手架（含可渲染 segments/ timeline.json/ package.json）、`ai-lane.mjs` 可选 AI 素材校验/叠加命令、`test-core.mjs` 15 项纯函数回归测试、`determinism-check.mjs`（同一 t 两次全新浏览器渲染，字节级一致）。
- **文档**：`references/timeline-schema.md`、`motion-and-color.md`、`platform-presets.md`、`qa.md`、`ai-lane.md`；SKILL/README 全面更新。
- **CI**：`.github/workflows/render-smoke.yml` 用 Playwright 容器 + 静态 ffmpeg 渲染 2 s、合成并跑 QA。

### 变更
- `render-segment.mjs` 中间片默认 `CRF 12 / veryfast`（原 `CRF 16 / medium`），最终片由 `concat-and-encode.sh` 一次 CRF 终编，避免固定 3.4 Mbps 2-pass 的体积浪费。
- `concat-and-encode.sh` 默认 `master` 预设（CRF 21 + maxrate + loudnorm），不再固定 2-pass 3400 kbps；位置参数仍兼容。颗粒内容实测：CRF18≈31 Mbps、20≈21、22≈14、24≈9、26≈5.7，CRF24 对 CRF12 中间片 VMAF 96.4，故交付选 22–24。
- `theme-preview.mjs` 联系表按主题数量自适应网格（13 套 5×3），不再假定 4×2。
- `package.json` 升到 2.0.0，新增 `test/doctor/plan/render/qa/qa:audio/theme:audit/ai:init/new` 脚本；Playwright 变为可选。
- 默认主题 `coral-noir` 与 v1 逐值一致；不传 `?theme=` 的旧项目行为不变。

### 修复
- 修复 v1 分段 mp4 无 bt709 标记、播放器可能按 bt601 解释导致偏色。
- 主题颗粒强度从 `grain×3.2` 降到 `×1.5`：1080p 下旧值更像数字噪点，且把 CRF12 中间片推到 90 Mbps。
- 修复 0.25 s×8 闪段在 30 fps 下每段 `round` 造成 1834 帧的累计误差。
- 修复渲染器关闭时静态服务器 keep-alive 5 s 拖尾、Chrome 子进程/临时 profile 延迟退出。

## [v1.1.0] - 2026-10-28 — 主题配色系统（8 套主题 / 预览 / 对比度审计）

### 新增
- `templates/themes.js`：8 套主题的唯一数据源。一套主题 = 14 个角色 token + 主材质 + HUD 规格 + 4 个点缀色，另含片头/结尾/风格段排版提示。主题：`coral-noir` 珊瑚暗夜（默认）、`claude-light` 橙光白、`aqua-morandi` 水蓝白·莫兰迪、`amber-noir` 琥珀黑金、`blueprint-stone` 蓝图纸、`graphite-signal` 石墨信号、`celadon-paper` 青瓷白、`crimson-theater` 绯墨剧场。
- `templates/themes.js` API：`getTheme()`（接受 id / 别名 / 对象，未知值回退默认）、`themeFromURL()`（读 `?theme=` 或 `?t=`）、`chrome()`（胶囊 / 倒计时 / 水印 / 闪白）、`cardColors(theme, layout)`（4 版式大字卡配色）、`drawThemeBackground()` / `drawGlassPanel()`、`cssVars()` / `applyTheme()`、`accentOverride()`（用户品牌色覆盖：自动挑 `accentInk`、算 `accentSoft`、同步材质光晕与 HUD 编号）、`auditTheme()` / `contrastRatio()`。
- `templates/theme-board.html`：单主题预览板（`?theme=<id>`，1920×1080）。
- `scripts/theme-preview.mjs`：批量渲染 8 套主题预览、全集联系表与三拼对比图。
- `scripts/theme-audit.mjs`：主题对比度审计，`--strict` 有不合格项时 exit 1（可进 CI）；当前 8 套全部通过。
- `references/themes.md`：主题系统设计规范（四层结构、8 套速查与调性、14 个 token、8 种材质、HUD、大字卡映射、选型矩阵、`accentOverride`、design-taste 对齐、QA、新增主题、相关文件）。
- `references/intake.md`：调用技能前的需求采集与主题锁定流程（最多 2 轮、必问 4 项 + 默认值、`BRIEF.json` 模板、交接与常见误用）。
- `assets/theme-previews/`：交付给用户的主题预览图（三拼 `theme-three-up.jpg`、全集 `theme-contact-sheet.jpg`、单主题 `01-coral-noir.jpg`–`08-crimson-theater.jpg`）。
- `templates/big-card.html` / `templates/segment.html`：支持 `?theme=<id 或别名>`；不传时保留旧版硬编码路径。
- `references/style-recipes.md` 新增「主题 × 风格段：换色规则」；`references/big-card-and-typography.md` 新增大字卡主题化说明（`cardColors()` 字段、浅色主题的明暗节奏、字体固定）。
- README（中英双语）新增 Themes / 主题配色 章节与主题预览图；快速开始补第 0 步 intake 与主题预览步骤、渲染示例；仓库结构补主题相关文件。
- `SKILL.md` 补充主题章节（8 选 1、`?theme=` 契约、锁定主题后再渲染）。

### 变更
- 默认视觉不变：不传 `?theme=` 时渲染原版 `coral-noir`，与旧版逐值/逐像素一致，老项目无需改动。
- 大字卡、胶囊、倒计时、水印、片头片尾配色统一由 `templates/themes.js` 派生，页面不再写死 `#d97757`。

### 备注
- 主题预览图由 `scripts/theme-preview.mjs` 生成；成片效果仍需按具体项目逐段渲染验证（本仓库不附成品视频）。

## [v1.0.4] - 2026-10-25 — README 一键安装说明

### 新增
- README 顶部新增「一键安装 / Install in one sentence」区块：一段可直接发给 Agent 的中英文安装指令，包含 `git clone` 到 `~/.dsh/skills/`（Claude Code 为 `~/.claude/skills/`，通用 Agent 为 `.agents/skills/`）以及装好后读 `SKILL.md` 自检。

### 变更
- 无代码、模板与渲染管线变更。

## [v1.0.3] - 2026-10-25 — 更新历史与发布自动化

### 新增
- `CHANGELOG.md`（本文件）：从 v1.0.0 开始补齐版本更新记录。
- `.github/workflows/sync-releases.yml`：main 推送或手动触发时，自动把 `v*` 标签按 CHANGELOG 小节同步成 GitHub Release（使用内置 `GITHUB_TOKEN`，不需要额外密钥）。
- README 顶部新增 Latest release 徽章与「Changelog / 更新历史」入口。

### 变更
- 无画面、音频与渲染管线的功能变更。

## [v1.0.2] - 2026-10-25 — README: Star History

### 新增
- README 末尾新增本仓库的 Star History 折线图（`star-history.com` 嵌入），并附上生成与嵌入方法的中文教程出处。

### 变更
- 无代码与渲染管线变更。

## [v1.0.1] - 2026-10-25 — 配乐高频克制规范

### 新增
- `references/audio-recipes.md` 第 7 节「频率克制：铃音只在关键位置点缀」：金属点缀的定义、全片 ≤3 处的分配规则、删掉高频层后用 sub/pad/低 tom 补能量的做法、可量化验收（8–16 kHz 段能量、HF 瞬态密度、频谱判读、切低频听感）与 numpy 检测片段。
- `SKILL.md`：§7 新增「高频克制（必读）」与自检；§9 音频质检新增 3 条硬指标（铃音 ≤3 处、非点缀段比关键段低 ≥6 dB、切掉低频不应只剩「叮叮叮」）；十阶段工作流第 9 步要求做高频听感自检。
- `templates/synth_audio.py`：文件头补充 frequency-restraint 说明，指向 `audio-recipes.md` 第 7 节。

### 变更
- `.gitignore` 增加 `__pycache__/` 与 `*.pyc`。

### 依据
- 来自一版 24 s 发布片的实际返工：初版在每个统计拍点都叠 FM 铃/拨弦、用法段铺高八度琶音，听感「太吵、叮叮叮」；重混后蒙太奇段 8–16 kHz 降 6.9 dB、HF 瞬态密度降 44%，全片铃音 25 → 3 处，标题与结尾 impact 两个关键节点保留。

## [v1.0.0] - 2026-10-24 — 首个公开版本

### 新增
- `SKILL.md`：十阶段工作流、确定性约束、质检清单、安装与触发说明。
- 11 种风格配方：扁平插画科普、数学动画、极简发布会、手绘白板、赛博故障、水墨国风、数据可视化、8-bit 像素、代码录屏、Three.js 三维、竖屏短视频。
- 大字卡系统（4 种版式、12 张卡）、八连闪、电影感结尾。
- 120 BPM / A 小调纯 numpy/scipy 配乐方案、音色库与卡点对齐做法。
- Playwright → CDP → FFmpeg 逐帧渲染管线与 `render-segment.mjs`；`concat-and-encode.sh` 合成脚本；`qa-check.sh` 质检脚本；`analyze-reference.sh` 参考片分析脚本。
- 6 个可运行模板：段落页面、大字卡、风格场景、渲染器、合成脚本、配乐骨架。
- 双语 README、MIT License，以及 9 张参考片拆解素材（接触表、风格帧、大字卡、频谱、切点数据等）。

### 已知限制
- 仓库不附带成品视频、第三方素材与字体；模板中的珊瑚色 `#d97757` 与文案为占位示例。
