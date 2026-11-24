---
name: code-video-showcase
version: 4.13.0   # 与 package.json 同值（test-version-sync 钉死）
description: |
  用纯代码（HTML/Canvas/SVG/Three.js 逐帧渲染 + Python numpy/scipy 合成配乐 + FFmpeg 合成）制作 30–90 秒卡点风格展示视频的完整技能。
  适用于：复刻/仿制《Opus 5.5 视频风格展示》或 DeepSeek V4.1-Flash 61s 风格样片、多风格切换卡点视频、纯代码视频、程序化视频；要求不使用任何视频/图像/音乐生成模型。
  包含：需求采集与主题选择、17 套主题 × 12 材质（OKLCH + APCA）、spec.json（IR）/ plan / 增量渲染、并行渲染农场、风格配方、大字卡、120BPM 配乐合成、CDP/Playwright 渲染管线、视频/音频质检、平台交付与封面、可选 AI 素材 lane。详见 references/。
  当用户提到「卡点视频」「风格展示视频」「纯代码做视频」「类似 Opus 5.5 / DeepSeek 风格展示」「逐帧渲染」「用代码做视频」
  「HTML Canvas 视频」「程序化视频」「30 秒产品宣传片」「竖屏短视频成片」「多平台导出（抖音/B站/小红书）」「封面图」「批量变体」
  「主题配色」「换配色」「配色主题」「卡点时间轴」「并行渲染」「视频质检」时必须触发。
  不用于：AE/PR 时间轴操作、文生视频/图生视频、需要真人素材与多轨混音的整片剪辑。
license: MIT
metadata:
  domain: video-production
  version: 4.10.1
  reference: Opus 5.5 / DeepSeek V4.1-Flash 61s style showcase
compatibility: Node 22+ (raw CDP needs global WebSocket) / Chrome or Edge (Playwright optional) / FFmpeg (libx264+AAC, libvmaf optional) / Python 3.10+ (numpy, scipy; matplotlib optional) / bash. Windows (Git Bash) and WSL/Linux. No external video/image/music generation models; fonts are open-source, served locally.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# 纯代码卡点视频导演技能

> 目标：不调用任何视频/图像/音乐生成模型，用**代码**逐帧画出画面、用 **numpy/scipy** 合成配乐，最后 FFmpeg 合成 MP4。
> 唯一入口 `project.spec.json` → `cvs lint` → `cvs build`；唯一产物 `<outDir>/master.mp4`。完成定义（五判据）、报错→动作表（143 码）、退出码见 `references/skill-compiler-entry.md`。

## 动词路由表（全量以 `cvs --help` 为准；→ 列见文末指针）

| 动词 | 做什么（一行） | → |
|---|---|---|
| `new` | 自然语言 → spec（确定性规则） | E |
| `ref` | 参考图 → 主题/强调色/密度；`ref video <mp4>` → 反推结构/BPM/主题 patch | E |
| `lint` | 页面/主题/APCA/占位品牌/标题 闸 | E |
| `plan` | spec → plan.json（每段哈希） | E |
| `build` | 校验→plan→增量渲染→concat(xfade)→qa | E |
| `again` | 改上次 spec、只重编译 dirty 段 | D |
| `deliver` | 产出 delivery.json + master.srt/.vtt + 封面 | D |
| `ship` | 交付物打包（spec+成片+字幕+清单+README，可 `--check` 预过双闸） | D |
| `snapshot`/`history`/`verify`/`rollback` | 版本闭环（回滚先校验再写盘） | E |
| `variant` | 笛卡尔批量变体 + manifest | E |
| `ingest` | 实拍素材 → EDL + spec 草稿（需人工审） | E |
| `brand` | 品牌套件 apply/check/list（门禁 error 级） | E |
| `motion` | 动效档位 list/show/derive/matrix | E |
| `image` | spec → 图集（cover/card/poster/story，带 image-manifest.json） | E |
| `demo` | 一键排演示片（六导演演示集 + `all` 批量 + manifest） | E |
| `edit` | agent 级结构剪辑（split/drop/move/trim，D 闭合，默认 dry-run） | E |
| `film` | 导出 OpenFilm-IR 时间线（overrides 非破坏层） | E |
| `api`/`ui`/`wizard`/`canvas`/`script`/`versions`/`review`/`frames` | HTTP 服务与六界面（5180–5190，frames 5186） | M |
| `golden` | 静帧位级回归基线（`--selfcheck`/`--update`） | Q |
| `health` | 一键全身体检：doctor + 错误码矩阵 + combos + golden + fixture-lint | Q |
| `score` | 五维主观质量评分（A-D 档） | Q |
| `taste` | 确定性审美闸（规则表，error/warning/advisory） | Q |
| `attest` | 产物哈希证书 + 跨机重放验证器（新员） | Q |
| `qa` | 视频+音频双闸（新员 qa 聚合） | Q |
| `gc` | 回收内容寻址段缓存（只删 `.cache` 下 mp4+json 对，护栏，新员） | M |
| `doctor` | 环境体检（含编码器能力探测） | M |
| `errors` | 错误码注册表 / docs/ERRORS.md（`--check` 覆盖率） | M |
| `test` | 跑全部套件（`--browser` 加浏览器套件） | M |

指针映射：E=`references/skill-compiler-entry.md` · D=`references/skill-deliverables.md` · Q=`references/skill-qa.md` · M=`references/skill-filemap-legacy.md`

## 机器闸三件套（交付前全绿）

- **`cvs qa <master.mp4> --plan out/plan.json`** — 视频+音频一次跑完，任一 FAIL 即整体 exit 13；三档：FAIL 拦 / WARN `--strict` 拦 / ADVISORY 永不拦。阈值与「常见失败→动作」见 `references/skill-qa.md`、`references/qa.md`。
- **`cvs taste <spec>`** — 14 条确定性审美规则：error 硬拦 / warning 扣分（100−Σw）/ advisory 永不拦；数据 `schema/taste-rules.json` × 实现 `scripts/taste.mjs`；豁免 `.cvs/waivers.json`（error 不可豁免）。`build --strict` 语境下是 ship 前置闸。
- **`cvs attest <out.mp4> [--verify]`** — 四层哈希证书（容器 sha + 逐帧 framemd5 + 工具链 + 段哈希），digest 无时间戳可跨机重算；`--verify` 离线分层复核：帧同容器异 = mux 抖动，帧异 = 真像素漂移 FAIL。

## 章节去向（原 §0.0–§12 逐字节迁移，正文只留指针）

§0.0+§0.5 → `skill-compiler-entry.md` · §0+§1 → `skill-deliverables.md` · §2 → `skill-workflow.md` · §3 → `skill-timing.md` · §4 → `skill-canvas-contract.md` · §5 → `skill-themes.md` · §6 → `skill-big-card.md` · §7 → `skill-style-recipes.md` · §8 → `skill-audio.md` · §9 → `skill-pipeline.md` · §10 → `skill-qa.md` · §11+§12 → `skill-filemap-legacy.md`。
