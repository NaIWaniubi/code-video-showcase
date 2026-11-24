> 自 SKILL.md §4（画面契约与公共库）拆出，2026-11-24。

## 4. 画面契约与公共库

`templates/common.js`（复制进项目，并已重新导出 `motion.js` / `color.js` 的 v2 API）提供：缓动（`ease.outExpo` 等）、种子随机 `mulberry32`（**禁止 `Math.random`**）、value noise + fbm、片段模式（解析 `?seg=&t0=&speed=&dur=` → `t = t0 + u*speed`）、标准角标 `drawCapsuleLabel / drawCountdown / drawStamp`、卡点冲击（白闪 0.12 s / 缩放 1.13→1 / 抖动 14 px / 之后推镜 1→1.05）。**禁止每个 HTML 自己 `requestAnimationFrame`**；渲染器每帧调 `renderFrame(t)`。

v2 动效/颜色 API：`spring / stagger / track / rateFunc / transitionParams / drawKineticText / drawGrain / drawRGBSplit / drawBloom / toOklch / derivePalette / apcaLc / readableInk` —— 签名与配方见 `references/motion-and-color.md`。

2D 片段骨架（`createSegment()` 读 URL 参数，`applyImpact2D` 做冲击变换，`drawFlash` 盖最上层）：

```js
window.renderFrame = (u) => {
  const { t, fx } = seg.sample(u);
  ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,W,H); ctx.save();
  applyImpact2D(ctx, fx);
  drawScene(ctx, t, u);               // 只依赖 t/u
  ctx.restore();
  drawFlash(ctx, fx.flash);
};
```

Three.js 片段：`renderer` 必须 `{ preserveDrawingBuffer: true }`；启动参数 `--use-angle=swiftshader --enable-webgl --ignore-gpu-blocklist --enable-unsafe-swiftshader`；镜头动画写 `camera.position`，禁 `Date.now`。

