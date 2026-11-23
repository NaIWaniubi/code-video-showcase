> 自 SKILL.md §9（渲染管线）拆出，2026-11-24。

## 9. 渲染管线（v2）

主线：`spec → plan`（`templates/timeline.mjs`，**plan 是唯一真源**）→ 并行渲染（`render-farm.mjs --concurrency N --resume`，缓存按 `segmentHash`）→ 合成（`concat-and-encode.sh --platform …`，CRF 终编 + loudnorm −14 LUFS / −1 dBTP + bt709）→ 质检（§10）→ 交付（`cvs deliver`）。

要点：
- 浏览器：Playwright（若装）或系统 Chrome/Edge **原生 CDP**（`templates/cdp.mjs`，零 npm 依赖）；等 `document.fonts.ready` + `window.__ready` 再取帧。单 canvas 用 `toDataURL()`（快 30–50%），DOM/WebGL 回退 `Page.captureScreenshot({optimizeForSpeed:true})`。
- 中间片 `-crf 12 -preset veryfast`、yuv420p、bt709 四元标签、timescale 90000。
- 帧直接进 ffmpeg stdin 不落盘；进程退出调 `server.closeAllConnections()`，避免 5 s keep-alive 拖尾。
- Three.js 必须 `preserveDrawingBuffer:true`、`setPixelRatio(1)`、`renderer.compile()`、关自动动画循环；Canvas 2D 不要每帧 `ctx.filter=blur()`。
- WSL 下 ffmpeg 放 Linux 侧、取帧留 Windows 侧；Chrome 路径用 `CHROME_EXE`。

完整施工说明、故障排查与平台预设见 `references/render-pipeline.md`、`references/qa.md`、`references/platform-presets.md`。

