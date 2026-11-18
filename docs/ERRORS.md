# 错误码与退出码

> 由 `node scripts/errors.mjs --write` 从 `schema/errors.json` 生成。
> 修改错误码请改注册表，不要手改本文件。

## 退出码

| 退出码 | 阶段 | 用法 |
|---|---|---|
| 0 | ok | ok |
| 2 | usage | usage / unknown command |
| 10 | spec | spec (spec.json / lint / plan) |
| 11 | render | render (segment render) |
| 12 | concat | concat (ffmpeg concat / encode) |
| 13 | qa | qa (qa-video / qa-audio) |
| 14 | env | env (missing binary / python / audio synthesis) |

脚本可以用退出码做粗分流，用 `--json` / `error.json` 的 `code` 做精确重试。

## 已注册错误码（153）

| 错误码 | 阶段 | 退出码 | 含义 | 唯一动作 |
|---|---|---|---|---|
| `E_COMMAND` | usage | 2 | 未知子命令 | cvs --help |
| `E_PLAN_INCOMPLETE` | usage | 2 | qa-audio 的 --plan 是合法 JSON 但缺 audio.bpm/cues（旧行为直接 KeyError 崩溃，脚本无法路由） | 重新跑 `cvs plan` 生成完整 plan；残缺 plan 下 cue/tempo/HF 门禁无法执行 |
| `E_PLAN_MISSING` | usage | 2 | qa-audio 的 --plan 指向不存在的文件（旧行为静默丢掉 cue/HF 门禁假绿） | 先跑 `cvs plan` 生成 plan.json，或修正 --plan 路径 |
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
| `E_EXCEPTION` | spec | 10 | E_EXCEPTION：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FLASH` | spec | 10 | flash 参数非法 | count ≥ 0 且 each > 0 |
| `E_FLASH_MAX` | spec | 10 | flash.count 超过 256 | 减少闪帧 |
| `E_FPS` | spec | 10 | fps 非法 | 1..120 的整数 |
| `E_JSON` | spec | 10 | JSON 解析失败 | 检查 JSON 语法或改用 --json 获取机器可读错误 |
| `E_JSON_PARSE` | spec | 10 | spec JSON 语法错误 | 修正 JSON |
| `E_MOOD` | spec | 10 | mood 非法 | electronic|restrained|epic|upbeat|guofeng |
| `E_MOTION` | spec | 10 | motion 档位非法 | calm|standard|dynamic|maximal |
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
| `E_VO_ENTRY` | spec | 10 | audio.vo[i] 条目不合法（缺 text / start 为负 / duration 非正） | 按报错 path 修对应字段；duration 省略则按字数估速 |
| `E_VO_TYPE` | spec | 10 | spec.audio.vo 不是 {text,start,duration} 条目数组 | 改成数组；每条含非空 text（start/duration 可缺省） |
| `E_RENDER` | render | 11 | 段渲染失败 | 看 failedSegments + render-manifest.json，修该段后重跑 |
| `E_CONCAT` | concat | 12 | 拼接/转码失败 | 看 segments.txt 与 ffmpeg 输出 |
| `E_BURN_SUBTITLES` | qa | 13 | 字幕烧录失败 | 检查 ffmpeg 是否带 libass/subtitles 滤镜 |
| `E_COVER` | qa | 13 | 封面渲染失败 | 看 image 日志；用 --no-cover 或修 card 页 |
| `E_DELIVER` | qa | 13 | delivery.json 生成失败 | 检查 outDir 写权限与 master.mp4 |
| `E_ENV_MISMATCH` | qa | 13 | 渲染环境（Chrome/字体）与 committed golden 不一致 | 用 --selfcheck 在本机重建基线，或换同一镜像 |
| `E_NO_MASTER` | qa | 13 | 快照要求 master.mp4 存在 | 先跑 cvs build |
| `E_NO_OUTPUT` | qa | 13 | deliver 找不到成片 | 先 `cvs build` |
| `E_QA_AUDIO` | qa | 13 | 音频质检失败 | 看 out/qa/qa-audio.json 的 cue alignment |
| `E_QA_VIDEO` | qa | 13 | 视频质检失败 | 看 out/qa/qa-video.json 的 FAIL 项 |
| `E_ROLLBACK_HASH` | qa | 13 | 回滚后 master 哈希与记录不一致 | 检查磁盘写入；不要手工改 versions/ |
| `E_SNAPSHOT_TAMPERED` | qa | 13 | 快照文件与记录的 sha256 不符，拒绝回滚 | cvs verify <v> 定位文件；从备份恢复 |
| `E_SUBTITLES_MISSING` | qa | 13 | 要烧字幕但 master.srt 不存在 | 去掉 --no-deliver，或去掉 --burn-subtitles |
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
| `E_BAD_REQUEST` | preview | 0 | 帧 API 请求参数缺失/非法 | 补齐 id/n 查询参数 |
| `E_BRAND` | brand | 10 | E_BRAND：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_BRAND_ACCENT_APCA` | brand | 10 | E_BRAND_ACCENT_APCA：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_BRAND_SCHEMA` | brand | 10 | E_BRAND_SCHEMA：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_COPY_LEN` | ui | 2 | E_COPY_LEN：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_DUP_ID` | ui | 2 | E_DUP_ID：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_DUP_ROW` | ui | 2 | E_DUP_ROW：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_EMPTY_EDL` | ingest | 15 | E_EMPTY_EDL：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_EMPTY_UPLOAD` | preview | 0 | 上传的参考片为空 | 换一个有实际内容的文件 |
| `E_FFMPEG` | ingest | 15 | E_FFMPEG：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FFPROBE` | ingest | 15 | E_FFPROBE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FFPROBE_JSON` | ingest | 15 | E_FFPROBE_JSON：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FORBIDDEN_WORD` | brand | 10 | E_FORBIDDEN_WORD：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_FRAME` | preview | 0 | 帧请求非法（越界/非整数） | 帧号取 0..frames-1 的整数 |
| `E_INGEST` | ingest | 15 | E_INGEST：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_LOGO_MISSING` | brand | 10 | E_LOGO_MISSING：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_BOUNDARY` | preview | 0 | multipart 请求没有 boundary | 确认 Content-Type 为 multipart/form-data |
| `E_NO_FFMPEG` | ingest | 15 | E_NO_FFMPEG：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_FFPROBE` | ingest | 15 | E_NO_FFPROBE：该模块的校验/运行错误（自动登记） | 按报错位置修正；无法判断时运行 `cvs doctor` 并附 out/error.json |
| `E_NO_FILE_PART` | preview | 0 | multipart 里没有带 filename 的文件分段 | 用 fetch FormData 附加 File |
| `E_PATH` | preview | 0 | 预览路径非法（穿越/隐藏目录） | 路径必须落在仓库根内 |
| `E_PAYLOAD_TOO_LARGE` | preview | 413 | 反代请求体超过 1MB 上限（源头掐断，不向上游灌数据） | 缩小提交体：拆小 spec 或分次评论 |
| `E_READ_ERROR` | preview | 0 | 读取上传数据出错（连接中断或超限已断） | 重试；大文件建议先裁剪 |
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

- 代码中出现的 `E_*`：153
- 已注册且被使用：153
- 未注册：0

- 已注册但当前未使用：0
