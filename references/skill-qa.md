> 自 SKILL.md §10（质检清单）拆出，2026-11-24。

## 10. 质检清单（自动 + 人工）

**一条命令**
```bash
node scripts/qa-video.mjs out/master.mp4 --plan out/plan.json  # 三档：FAIL 拦 / WARN strict 拦 / ADVISORY 永不拦（含检查齐全性断言与 GOP 间距）
python scripts/qa-audio.py out/audio/mix.wav --plan out/plan.json --strict  # 音频件是 build 产物在 out/audio/mix.wav；也可直测成片 mp4
node scripts/theme-audit.mjs --strict
node scripts/determinism-check.mjs --page "segments/01.html?theme=coral-noir" --t 0.5  # 静帧位级；--video 加跑整段 mp4（全编码链幂等）
```
自动覆盖（工具强制，阈值表见 `references/qa.md`）：帧数/尺寸/fps/bt709 四元标签；黑帧、冻结、静音；−14 ±1 LUFS / TP ≤ −1 dBTP / LRA ≤ 14；cue 对齐 ≥80% ±30 ms、BPM 误差 ≤2、网格命中 ≥70%；高频克制 ≥6 dB；17 套主题 WCAG 全绿。

**人工看片（仍必须）**
- [ ] 浏览器 console 无错误/404；CJK 字体 `document.fonts.check()` 全 true；
- [ ] 每个风格段抽 5–6 帧接触表；无 CSS 动画/rAF/Date.now/Math.random；无逐帧大范围 `filter blur`/`shadowBlur`；
- [ ] 浅色主题胶囊/倒计时/水印是深墨实体；大字卡 4 版式明暗节奏成立；
- [ ] 默认主题「不传 theme」与旧版基线像素对比仍一致；
- [ ] 切掉 <200 Hz 听一遍不应只剩「叮叮叮」；抽帧出封面 + 一页参数说明。

