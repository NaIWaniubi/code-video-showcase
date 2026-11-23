> 自 SKILL.md §11 + §12（文件地图与 timeline v1 快速启动）拆出，2026-11-24。

## 11. 文件地图（关键入口）

| 你要改什么 | 去哪里 |
|---|---|
| spec 模型 / plan / 深度校验 | `templates/spec.mjs`、`templates/plan.mjs`、`templates/spec-check.mjs` |
| 渲染 / 合成 / 质检 | `templates/render-segment.mjs`、`render-farm.mjs`、`cdp.mjs`、`concat-and-encode.sh`、`synth_audio.py`、`scripts/qa-video.mjs`、`qa-audio.py` |
| CLI / again / deliver / 版本 | `bin/cvs.mjs`、`scripts/again.mjs`、`scripts/deliver.mjs`、`scripts/versions.mjs` |
| 错误码 / 离线 / 完整目录树 | `schema/errors.json`→`docs/ERRORS.md`、`docs/OFFLINE.md`、`references/repo-map.md` |

参考样片：61.013 s / 1080p30 / 1830 帧 / 60 切点。完整拆解（镜头表/锚点/音频/配色/频谱）见 `references/reference-film-analysis.md`，图片在 `assets/`。


---

## 12. 快速启动（v2 · 仅限 timeline v1 旧项目）

> **新项目请走 §0.5 的 spec 主线。** 这条路生成的 `timeline.json` 没有 `segmentHash`，增量缓存 / 单段动效 / 品牌色覆盖会静默失效；只为兼容存量项目保留。

```bash
node scripts/doctor.mjs                                                  # 体检
node scripts/new-project.mjs --out ../my-film --theme cyber-neon --styles 11    # 脚手架
node templates/timeline.mjs --spec timeline.json --out out/plan.json --concat out/segments.txt  # 计划
node templates/render-farm.mjs --plan out/plan.json --concurrency 4 --resume    # 并行渲染
python templates/synth_audio.py --plan out/plan.json --out audio/mix.wav
bash templates/concat-and-encode.sh --platform master out/segments.txt audio/mix.wav out/master.mp4 61 30
node scripts/qa-video.mjs out/master.mp4 --plan out/plan.json && node scripts/theme-audit.mjs --strict
```

写任务书直接复制 `references/original-brief.txt` 替换品牌词/风格/文案；主题按 `references/intake.md` 锁定；结构与渲染全由 plan 驱动。
