# 错误码与退出码

> 由 `node scripts/errors.mjs --write` 从 `schema/errors.json` 生成。
> 修改错误码请改注册表，不要手改本文件。

## 退出码

| 退出码 | 阶段 | 用法 |
|---|---|---|
| 0 | ok | ok |
| 1 | taste | taste gate verdict blocking（cvs taste；G3-9 对齐 0/1/2 承诺。13 仍归 qa 族） |
| 2 | usage | usage / unknown command |
| 10 | spec | spec (spec.json / lint / plan) |
| 11 | render | render (segment render) |
| 12 | concat | concat (ffmpeg concat / encode) |
| 13 | qa | qa (qa-video / qa-audio) |
| 14 | env | env (missing binary / python / audio synthesis) |

脚本可以用退出码做粗分流，用 `--json` / `error.json` 的 `code` 做精确重试。

## 已注册错误码（188）

| 错误码 | 阶段 | 退出码 | 含义 | 唯一动作 |
|---|---|---|---|---|
| `E_COMMAND` | usage | 2 | 未知子命令 | cvs --help |
| `E_DEMO_ONLY` | usage | 2 | --only 里的演示风格名不在导演演示集六件内 | 用 wireframe|skeleton|fractal|firework|terrain|network 之一 |
| `E_PLAN_INCOMPLETE` | usage | 2 | qa-audio 的 --plan 是合法 JSON 但缺 audio.bpm/cues（旧行为直接 KeyError 崩溃，脚本无法路由） | 重新跑 `cvs plan` 生成完整 plan；残缺 plan 下 cue/tempo/HF 门禁无法执行 |
| `E_PLAN_MISSING` | usage | 2 | qa-audio 的 --plan 指向不存在的文件（旧行为静默丢掉 cue/HF 门禁假绿） | 先跑 `cvs plan` 生成 plan.json，或修正 --plan 路径 |
| `E_SET_UNSAFE_PATH` | usage | 2 | G5-5：`cvs again --set` 的路径含危险段（__proto__/constructor/prototype 原型污染）或数组索引超上限 65535（无界内存 DoS） | 只用 spec 声明过的字段路径（meta/look/format/rounds.… 等）；索引给真实段号 |
| `E_UNKNOWN_COMMAND` | usage | 2 | 未知子命令 | 运行 `cvs --help` |
| `E_UNKNOWN_FLAG` | usage | 2 | 未知命令行 flag（拼错的 --strict 等不再被静默忽略） | 按报错里的 did-you-mean 修正；`cvs <cmd> --help` 看全表 |
| `E_UNKNOWN_STYLE` | usage | 2 | demo 命令的风格 id 不在 STYLE_IDS 词表内 | 用 cvs --help 列出的风格 id，或 cvs motion list 看目录 |
| `E_USAGE` | usage | 2 | 命令行参数错误 | 查看 `cvs <cmd> --help` |
| `E_ACCENT` | spec | 10 | accentOverride 非法 | #rgb/#rrggbb 或 {accent,accentInk,accentSoft} |
| `E_APCA` | spec | 10 | 主题对比度不足 | 换主题或设置 look.accentOverride |
| `E_ARG` | spec | 10 | E_ARG：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_BPM` | spec | 10 | bpm ≤ 0 | 改成 > 0 |
| `E_BRAND_CHECK` | spec | 10 | 品牌检查有 error（禁用词/logo/对比度） | 按提示改文案或 brand kit；brand apply 也会返回 1 |
| `E_BRAND_MISSING` | spec | 10 | meta.brand 为空 | 填品牌名 |
| `E_BRAND_PLACEHOLDER` | spec | 10 | 品牌还是 {{BRAND}} 占位符 | 填 meta.brand 或跑 `cvs brand apply` |
| `E_CARD_GE_ROUND` | spec | 10 | card 时长 ≥ round | card 必须小于 round |
| `E_CONCURRENCY` | spec | 10 | 并发数非法 | 1..16 |
| `E_COPY` | spec | 10 | style.copy 结构错误 | 只写 title/subtitle/caption 字符串 |
| `E_DESCRIPTION` | spec | 10 | description 不是字符串 | 改成字符串 |
| `E_DURATION` | spec | 10 | format.duration 与结构公式不一致 | 删掉 duration 让工具算，或改 structure |
| `E_DURATION_MAX` | spec | 10 | 总帧数超过 18000 | 缩短时长或降低 fps |
| `E_EMIT_SPEC` | spec | 13 | 参考片结构拟合失败，无法 --emit-spec 展开成可编译新片 | 换一个更长的参考片（≥6s）或人工校 structure 后重试 |
| `E_EXCEPTION` | spec | 10 | E_EXCEPTION：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FLASH` | spec | 10 | flash 参数非法 | count ≥ 0 且 each > 0 |
| `E_FLASH_MAX` | spec | 10 | flash.count 超过 256 | 减少闪帧 |
| `E_FLASH_WORDS` | spec | 10 | flash.words 非法：不是字符串数组，或某项为空/纯空白（经 query() 会被丢弃 → 页面回落内建「想做」，S9 病根），或码点 >8（超出 big-card 单屏容量），或项数 >MAX_FLASH_COUNT | 每个词 trim 后非空、≤8 码点（[...s].length，不劈代理对）；总数 ≤ structure.flash.count 上限；删掉空串或补上真实快闪文案 |
| `E_FPS` | spec | 10 | fps 非法 | 1..120 的整数 |
| `E_JSON` | spec | 10 | JSON 解析失败 | 检查 JSON 语法或改用 --json 获取机器可读错误 |
| `E_JSON_PARSE` | spec | 10 | spec JSON 语法错误 | 修正 JSON |
| `E_MOOD` | spec | 10 | mood 非法 | electronic|restrained|epic|upbeat|guofeng |
| `E_MOTION` | spec | 10 | motion 档位非法 | calm|standard|dynamic|maximal |
| `E_MOTION_BLUR` | spec | 10 | render.motionBlur 非法值：只认 weak|normal|strong|false（权重表单一真值 templates/plan.mjs BLUR_WEIGHTS） | 写 weak|normal|strong，或删除该字段保持关 |
| `E_NO_AAC` | spec | 10 | E_NO_AAC：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_BASH` | spec | 10 | E_NO_BASH：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_CHROME` | spec | 10 | E_NO_CHROME：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_FONTS` | spec | 10 | E_NO_FONTS：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_FONTS_CSS` | spec | 10 | E_NO_FONTS_CSS：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_LOUDNORM` | spec | 10 | E_NO_LOUDNORM：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_NUMPY` | spec | 10 | E_NO_NUMPY：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_PYTHON` | spec | 10 | E_NO_PYTHON：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_QA_FILTERS` | spec | 10 | E_NO_QA_FILTERS：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_WEBSOCKET` | spec | 10 | E_NO_WEBSOCKET：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_X264` | spec | 10 | E_NO_X264：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NODE` | spec | 10 | E_NODE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NORMALIZE` | spec | 10 | E_NORMALIZE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NOT_DIR` | spec | 10 | E_NOT_DIR：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NOT_FILE` | spec | 10 | E_NOT_FILE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NOT_FOUND` | spec | 10 | E_NOT_FOUND：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_OUTDIR` | spec | 10 | render.outDir 越出项目根 | 改为不带 .. 的相对路径 |
| `E_PAGE_ABS` | spec | 10 | 页面用了绝对路径 | 改成相对项目根的路径 |
| `E_PAGE_EXT` | spec | 10 | 页面不是 .html/.htm 文件，渲染器无法打开 | page 必须指向 HTML 文档；模板/依赖文件不要填进 page |
| `E_PAGE_MISSING` | spec | 10 | 页面文件不存在 | 检查 --root 与 page 路径；报错回显解析用的 root 绝对路径 |
| `E_PAGE_REMOTE` | spec | 10 | 远程页面被禁止（SSRF） | 改用本地页面；只有 CLI 显式放行才允许远程 |
| `E_PAGE_TRAVERSAL` | spec | 10 | 页面路径含 .. 段，越出项目根（文件存在性 oracle / 越界读） | 改成不含 .. 的项目根内相对路径 |
| `E_PRESET` | spec | 10 | render.preset 非法 | bilibili|douyin|youtube|wechat|weixin|xiaohongshu|master|square |
| `E_READ` | spec | 10 | spec 文件读不到 | 检查 --spec 路径 |
| `E_REF_PATCH` | spec | 10 | 参考片反推 patch 不可读、缺 specPatch 或结构冲突 | 用 `cvs ref video <片> --apply <spec>` 生成合规补丁；结构不一致会被 E_DURATION 如实拦下 |
| `E_RENDERER` | spec | 10 | E_RENDERER：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ROUND_COUNT` | spec | 10 | E_ROUND_COUNT：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ROUND_ID` | spec | 10 | round.id 非法/重复 | 只用字母数字-_，≤64 字符 |
| `E_ROUND_NAME` | spec | 10 | E_ROUND_NAME：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ROUND_TOTAL` | spec | 10 | E_ROUND_TOTAL：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ROUNDS` | spec | 10 | rounds[] 为空 | 至少写一轮 |
| `E_ROUNDS_MAX` | spec | 10 | rounds 超过 24 | 拆成两条片 |
| `E_SEGMENT_PATCH` | spec | 10 | 帧工作台导出的段表 patch 不可读、格式不对或索引越界 | 确认 patch 是 cvs.segment-patch/v1 结构（patch 数组带合法 index），重新导出 |
| `E_SHOT` | spec | 10 | E_SHOT：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_SIZE` | spec | 10 | 宽高非法 | 使用偶数正数 |
| `E_SPEC` | spec | 10 | spec 结构不合法 | 按 issues[] 修正 |
| `E_SPEED` | spec | 10 | speed ≤ 0 | 改成 > 0 |
| `E_STRUCTURE` | spec | 10 | structure 字段 ≤ 0 | 所有时长必须 > 0 |
| `E_STRUCTURE_MAX` | spec | 10 | 单段超过 600s | 缩短该段 |
| `E_STYLE_PAGE` | spec | 10 | style 缺 page/recipe | 补 style.page 或 style.recipe |
| `E_THEME` | spec | 10 | 缺 look.theme | 填主题 id |
| `E_THEME_UNKNOWN` | spec | 10 | 主题 id 不存在 | 从报错列出的主题 id 中选（当前 17 个） |
| `E_TITLE_MISSING` | spec | 10 | 片名为空/untitled | 填 meta.title |
| `E_TRANSITION` | spec | 10 | render.transition / --transition 名字非法 | 见 templates/transitions.mjs TRANSITIONS（fade/dissolve/wipeleft/slideleft/circleopen/zoomin…），或 none 关闭 |
| `E_TRANSITION_DURATION` | spec | 10 | 转场时长非法 | render.transitionDuration / --transition-duration 取 (0,2] 秒 |
| `E_UNKNOWN_FIELD` | spec | 10 | style/copy 出现未知字段 | 删除拼错的字段；自定义参数放 style.params |
| `E_UNSUPPORTED` | spec | 10 | E_UNSUPPORTED：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_VALIDATOR` | spec | 10 | E_VALIDATOR：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_VERSION` | spec | 10 | specVersion 不受支持 | 使用 specVersion=1，或先迁移 timeline v1 |
| `E_VO_CONFLICT` | spec | 10 | cvs caption --into：spec.audio.vo 已有内容，拒绝静默覆盖 | 确认替换旁白行请加 --replace-vo（旧行会随 .bak 保留） |
| `E_VO_ENTRY` | spec | 10 | audio.vo[i] 条目不合法（缺 text / start 为负 / duration 非正） | 按报错 path 修对应字段；duration 省略则按字数估速 |
| `E_VO_TYPE` | spec | 10 | spec.audio.vo 不是 {text,start,duration} 条目数组 | 改成数组；每条含非空 text（start/duration 可缺省） |
| `E_VO_WORDS` | spec | 10 | audio.vo[].words 形状不合法：每个词须 {w:string, t0<=t1 finite} | 用 cvs caption 产词级时间戳，或按秒（三位小数）手工对齐 |
| `W_COPY_CAPTION_UNCONSUMED` | spec | 0 | style.copy.caption 有内容但全仓无页面消费 ?caption=（死文案，历史上静默丢值）；plan 已停发该参数 | 改用 style.copy.subtitle（各 recipe 页已接通 ?sub=）或 opening.capsule；确要保留 caption 字段则忽略此警告 |
| `W_FLASH_DEAD` | spec | 0 | structure.flash.count=0 但提供了 flash.words：没有任何快闪段消费这些词（死配置） | 把 count 提到 ≥1，或删除 flash.words |
| `W_FLASH_WORDS_REUSE` | spec | 0 | flash.words 数量 < structure.flash.count：取词会从头循环复用（w[i % len]），同一片子里有重复快闪词 | 补齐到 count 个不重复词，或把 count 降到 words 数量（确认是刻意的可忽略） |
| `W_FLASH_WORDS_UNUSED` | spec | 0 | flash.words 数量 > structure.flash.count：多出的词没有对应段，被静默截断 | 提高 count 或删除多余 words（确认是刻意的可忽略） |
| `E_ASR_ENV` | render | 14 | 词级 ASR 环境缺失：python 无 faster-whisper 或模型不可得（在线首拉失败/离线无 HF_HOME 缓存） | pip install faster-whisper；离线机预置 huggingface 缓存（Systran/faster-whisper-large-v3）后用 --model 指本地目录 |
| `E_ASR_RUN` | render | 13 | 词级 ASR 运行失败（设备/解码/超时） | 看 stderr python 侧原因；CPU 慢可 --device cpu 显式避免探测超时 |
| `E_BLUR` | render | 11 | cvs build --motion-blur：tmix 后置 pass 失败（ffmpeg 非零 / 权重串非法 / 权重数不足 2） | 确认 ffmpeg 带 tmix（7.x 自带）；spec 里只填三档名 |
| `E_RENDER` | render | 11 | 段渲染失败 | 看 failedSegments + render-manifest.json，修该段后重跑 |
| `E_CONCAT` | concat | 12 | 拼接/转码失败 | 看 segments.txt 与 ffmpeg 输出 |
| `E_ASR_PARSE` | qa | 2 | captions JSON 不可读/缺 segments[]（--apply 注入侧同样触发） | caption JSON 必须由 cvs caption 产出；手改保持 {segments:[{start,end,text,words[]}]} 结构 |
| `E_BURN_SUBTITLES` | qa | 13 | 字幕烧录失败 | 检查 ffmpeg 是否带 libass/subtitles 滤镜 |
| `E_CAPTION_MEDIA` | qa | 2 | cvs caption：输入媒体文件不存在 | 传音频/视频路径（mp3/wav/m4a/mp4 均可，whisper 自己抽轨） |
| `E_COVER` | qa | 13 | 封面渲染失败 | 看 image 日志；用 --no-cover 或修 card 页 |
| `E_DELIVER` | qa | 13 | delivery.json 生成失败 | 检查 outDir 写权限与 master.mp4 |
| `E_ENV_MISMATCH` | qa | 13 | 渲染环境（Chrome/字体）与 committed golden 不一致 | 用 --selfcheck 在本机重建基线，或换同一镜像 |
| `E_NO_MASTER` | qa | 13 | 快照要求 master.mp4 存在 | 先跑 cvs build |
| `E_NO_OUTPUT` | qa | 13 | deliver 找不到成片 | 先 `cvs build` |
| `E_QA_AUDIO` | qa | 13 | 音频质检失败 | 看 out/qa/qa-audio.json 的 cue alignment |
| `E_QA_VIDEO` | qa | 13 | 视频质检失败 | 看 out/qa/qa-video.json 的 FAIL 项 |
| `E_ROLLBACK_HASH` | qa | 13 | 回滚后 master 哈希与记录不一致 | 检查磁盘写入；不要手工改 versions/ |
| `E_SCORE` | qa | 13 | cvs score：评分报告写出失败（磁盘/权限/路径）。plan 缺失不再触发本码——相应维度标 skipped 照常出分 | 换 --out 目录或检查磁盘；其余维度证据看 stderr 各行 |
| `E_SNAPSHOT_TAMPERED` | qa | 13 | 快照文件与记录的 sha256 不符，拒绝回滚 | cvs verify <v> 定位文件；从备份恢复 |
| `E_SUBTITLES_MISSING` | qa | 13 | 要烧字幕但 master.srt 不存在 | 去掉 --no-deliver，或去掉 --burn-subtitles |
| `E_TASTE_ASSERT` | qa | 2 | cvs taste：规则目录某条缺 assert 或 assert 非法（缺失/类型错/regex 不可编译/id 重复/severity 非法）。判决阈值唯一真值破损时启动即错，绝不静默回退硬编码（G3-6） | 补全该条 assert 的必需字段后重跑；各条目形状见 schema/taste-rules.json 与 scripts/taste.mjs ASSERT_OK |
| `E_TASTE_FAIL` | qa | 1 | cvs taste 审美闸判决阻断（G3-9 退出码 0/1/2：1=error/broken/expired-waiver/strict-warning 任一存在）。逐条判决见 out/qa/taste.json（evidence 带实测值）；帧级规则 input=frames 显式 skip 并计数，不参与判决 | 按 findings 修 spec/主题 token；确属误判走 .cvs/waivers.json 豁免（rule+reason+date，date=有效期止），**绝不为过闸改规则阈值**（阈值唯一真值在 schema/taste-rules.json 的 assert） |
| `E_TASTE_READ` | qa | 2 | cvs taste：spec.json 或规则目录不可读/非法 JSON | 确认路径存在且为 JSON；规则目录缺省 schema/taste-rules.json（--rules 可指） |
| `E_TASTE_WAIVER` | qa | 2 | cvs taste：.cvs/waivers.json 结构非法（既不是数组也不是 {waivers:[...]}，或条目不是对象） | 按 {waivers:[{rule,reason,date}]} 形状修文件 |
| `E_TASTE_WAIVER_DATE` | qa | 2 | cvs taste：豁免条目 date 不是 YYYY-MM-DD（无法判过期即启动错，不许拿『永不过期』兜底） | 改成 YYYY-MM-DD；该值是豁免有效期止 |
| `E_TASTE_WAIVER_EXPIRED` | qa | 1 | cvs taste：豁免已过有效期（date < 今天；时钟可 --today 注入）——该条 fail 不再被豁免并计入 blocking（G3-7） | 重新评审：修 spec、续期（换新 date 并留新 reason）或删条目 |
| `E_TASTE_WAIVER_REASON` | qa | 2 | cvs taste：豁免条目缺 reason 或 reason 为空白——豁免是留痕承诺不是过闸开关（G3-7） | 写明为什么这条审美判定对本片不适用 |
| `E_TASTE_WAIVER_RULE` | qa | 2 | cvs taste：豁免条目的 rule 不在规则目录（拼错或已删除的规则不许静默放行，G3-7） | 对照 schema/taste-rules.json 修 rule id，或删掉该豁免 |
| `E_TASTE_WAIVER_UNUSED` | qa | 1 | cvs taste：--report-unused-waivers 下存在从未命中的豁免——失效豁免留在仓库里是债务（G3-7） | 删掉不再触发的豁免条目，或去掉该旗标退回只列示 |
| `E_TASTE_WRITE` | qa | 0 | cvs taste：--sarif 报告写盘失败（warn 级，不掩判决） | 检查 --out 目录权限 |
| `E_VERSION_UNKNOWN` | qa | 13 | 指定的版本快照不存在 | cvs history 查看可用版本 |
| `E_AUDIO_NOT_FOUND` | env | 14 | --audio 文件不存在 | 检查路径 |
| `E_AUDIO_REQUIRED` | env | 14 | 没有音轨且未显式豁免 | 装 Python numpy/scipy 自动合成，或传 --audio，或 --no-audio |
| `E_DEMO_FAILED` | env | 14 | 演示片编译链失败（compile 返回非 0） | 看下方 compile 的 [error] 明细；python/ffmpeg 缺失会先报环境码 |
| `E_JOB` | env | 14 | job 失败但没有 error.json（旧 job 或非编译失败） | 看 build.log 与 job.error |
| `E_NO_FONT_LOCK` | env | 14 | 缺少 shared/fonts.lock.json 或与磁盘不一致 | node scripts/bundle-fonts.mjs --lock-only |
| `E_SPAWN` | env | 127 | 子进程启动失败 | 检查脚本路径与权限 |
| `E_VO_FAILED` | env | 14 | 旁白合成失败（synth_voice 退出非 0 或产物缺失） | 检查 spec.audio.vo 文案与行 JSON；或删除该字段退回纯音乐 |
| `E_AUTH` | api | 401 | 缺 Bearer token | 带 Authorization: Bearer <token> |
| `E_BODY_TOO_LARGE` | api | 400 | E_BODY_TOO_LARGE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_CONTENT_TYPE` | api | 415 | POST 不是 application/json | 设置 Content-Type: application/json |
| `E_HOST` | api | 403 | Host 不是回环 | 用 127.0.0.1/localhost 访问 |
| `E_HTTP` | api | 400 | E_HTTP：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_INTERNAL` | api | 400 | E_INTERNAL：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_JOB_ID` | api | 400 | job id 非法 | 使用服务返回的 id |
| `E_METHOD` | api | 405 | HTTP 方法不允许 | 查 server/api.mjs 路由表 |
| `E_ORIGIN` | api | 403 | 跨源写请求被拒 | 用同源页面，或启动时 --cors <origin> |
| `E_QUEUE_FULL` | api | 429 | 队列已满（32） | 稍后重试或提高并发 |
| `E_URL` | api | 400 | URL 非法 | 检查路径编码 |
| `E_API_UNREACHABLE` | preview | 502 | 评审页 /jobs 反代到编译 API 失败（不可达或 8s 超时） | 确认 `cvs api` 已启动；目标地址可经 REVIEW_API/--api-target 覆盖 |
| `E_ASR_BAD_JSON` | ingest | 15 | E_ASR_BAD_JSON：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ASR_FAILED` | ingest | 15 | E_ASR_FAILED：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ASR_NO_OUTPUT` | ingest | 15 | E_ASR_NO_OUTPUT：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ASSET` | asset | 10 | E_ASSET：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ASSET_ENTRY` | asset | 10 | E_ASSET_ENTRY：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ASSET_HASH` | asset | 10 | E_ASSET_HASH：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ASSET_MISSING` | asset | 10 | E_ASSET_MISSING：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ASSET_PATH` | asset | 10 | E_ASSET_PATH：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ASSET_REMOTE` | asset | 10 | E_ASSET_REMOTE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_ASSETS_TYPE` | asset | 10 | E_ASSETS_TYPE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_BACKUP` | edit | 13 | --apply 写回前备份原 spec 失败（磁盘只读/权限等）——已中止写回，原文件未动 | 修复磁盘/权限后重试；dry-run 验证不涉及备份 |
| `E_BAD_REQUEST` | preview | 0 | 帧 API 请求参数缺失/非法 | 补齐 id/n 查询参数 |
| `E_BRAND` | brand | 10 | E_BRAND：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_BRAND_ACCENT_APCA` | brand | 10 | E_BRAND_ACCENT_APCA：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_BRAND_SCHEMA` | brand | 10 | E_BRAND_SCHEMA：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_COPY_LEN` | ui | 2 | E_COPY_LEN：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_DUP_ID` | ui | 2 | E_DUP_ID：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_DUP_ROW` | ui | 2 | E_DUP_ROW：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_EDIT` | edit | 13 | edit 结构异常（reflow 无法闭合 D 公式等） | 检查 structure 字段与 flash/count 是否自洽；dry-run 会先过 lint 再落盘 |
| `E_EDIT_USAGE` | edit | 2 | edit 参数类错误（轮 id 不存在/时刻越界/目标时长过短/move 写法） | 改参数重试：--split-at 秒须落在轮区间；--drop/--move 用 rounds[].id；--trim ≥0.6s |
| `E_EMPTY_EDL` | ingest | 15 | E_EMPTY_EDL：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_EMPTY_UPLOAD` | preview | 0 | 上传的参考片为空 | 换一个有实际内容的文件 |
| `E_FFMPEG` | ingest | 15 | E_FFMPEG：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FFPROBE` | ingest | 15 | E_FFPROBE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FFPROBE_JSON` | ingest | 15 | E_FFPROBE_JSON：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FILM` | film | 10 | cvs film：spec 读取/解析失败或 OpenFilm IR 导出异常（含 --overrides 文件坏 JSON） | 确认 <spec.json> 可读且过 lint；overrides 文件须是 [{clipId, overrides}] 或其 {overrides:[…]} 包装 |
| `E_FORBIDDEN_WORD` | brand | 10 | E_FORBIDDEN_WORD：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FRAME` | preview | 0 | 帧请求非法（越界/非整数） | 帧号取 0..frames-1 的整数 |
| `E_INGEST` | ingest | 15 | E_INGEST：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_LOGO_MISSING` | brand | 10 | E_LOGO_MISSING：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_BOUNDARY` | preview | 0 | multipart 请求没有 boundary | 确认 Content-Type 为 multipart/form-data |
| `E_NO_FFMPEG` | ingest | 15 | E_NO_FFMPEG：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_FFPROBE` | ingest | 15 | E_NO_FFPROBE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_FILE_PART` | preview | 0 | multipart 里没有带 filename 的文件分段 | 用 fetch FormData 附加 File |
| `E_OUTPATH_ESCAPE` | mcp | 2 | G5-2：cvs_new 的 outPath 逃逸项目根（../ 穿越、绝对路径或 symlink 解析后落在 ROOT 之外），写盘被拒 | 把 outPath 指到仓库内路径（相对项目根或仓库内绝对路径）；需要写仓库外请显式换用文件系统工具 |
| `E_PAGE_BARE` | plan | 10 | 页面（或其递归依赖）import 了 bare 模块说明符（node_modules/CDN 包名）。它不进 segmentHash：库一升级缓存就命中旧画面且 build 报成功——正是 plan.mjs 注释点名要防的假绿。CVS 是零依赖产品，第三方渲染库必须自实现或走页面内联脚本 | 把该 import 换成仓内相对路径（./、templates/、shared/、assets/、content/）或内联实现；确需外部库时写进 docs/DECISIONS.md 并经 --allow-remote-pages 之外的显式评审 |
| `E_PATH` | preview | 0 | 预览路径非法（穿越/隐藏目录） | 路径必须落在仓库根内 |
| `E_PAYLOAD_TOO_LARGE` | preview | 413 | 反代请求体超过 1MB 上限（源头掐断，不向上游灌数据） | 缩小提交体：拆小 spec 或分次评论 |
| `E_READ_ERROR` | preview | 0 | 读取上传数据出错（连接中断或超限已断） | 重试；大文件建议先裁剪 |
| `E_REF_BUSY` | preview | 429 | G5-4：wizard 的 /api/analyze-ref 并发已满（每路上传都要吃 400MB 预算 + 一路 ffmpeg 反推链） | 等当前参考片分析完成后重试；向导页收到 429 会提示稍后再传 |
| `E_REF_VIDEO_FAILED` | ingest | 15 | 参考片反推失败（CLI 退出非 0：读不了/解码错/python 或 ffmpeg 不可用） | 检查文件与编码；FFMPEG/PYTHON 可用环境变量覆盖 |
| `E_REF_VIDEO_TYPE` | preview | 0 | 参考片扩展名不在接受清单（mp4/webm/mov/mkv） | 转成 mp4/webm 再传 |
| `E_REF_VIDEO_UNPARSEABLE` | preview | 0 | 反推脚本输出不是合法 JSON | 重试或换短一点的参考片 |
| `E_REF_VIDEO_UNREADABLE` | ingest | 15 | 参考片反推无法读取（路径不存在或 ffmpeg 不可用） | 检查文件路径；FFMPEG/FFPROBE/PYTHON 可用环境变量覆盖 |
| `E_ROUTE` | preview | 0 | 未知帧 API 路由 | 见 app/frames/README.md 的 API 表 |
| `E_SCRIPT_COVER` | ui | 2 | E_SCRIPT_COVER：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_SCRIPT_GAP` | ui | 2 | E_SCRIPT_GAP：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_SCRIPT_T` | ui | 2 | E_SCRIPT_T：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_SOURCE` | preview | 0 | 帧源打开失败（路径越界/文件缺失/校验失败） | 按报错指引检查路径；视频先 cvs build |

## 覆盖情况

- 代码中出现的 `E_*`：183
- 已注册且被使用：183
- 未注册：0

- 已注册但当前未使用：5（E_OUTPATH_ESCAPE, W_COPY_CAPTION_UNCONSUMED, W_FLASH_DEAD, W_FLASH_WORDS_REUSE, W_FLASH_WORDS_UNUSED）
