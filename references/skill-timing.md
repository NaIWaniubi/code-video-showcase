> 自 SKILL.md §3（时间结构通用公式）拆出，2026-11-24。

## 3. 时间结构（通用公式）

设风格数 `N`，每轮 `R = 4s`（大字卡 1s = 2 拍，风格展示 3s = 6 拍）：

```
0 ── opening (O=8s) ── 8 ── N 轮 ×4s ── 大字卡"还有更多?"(1s) ── 八连闪(2s) ── 结尾 (E=6s)
```

- 总时长 = `O + N*R + 1 + 2 + E`。
- 展示段第一帧就是「啪」的卡点：`t0` 是场景内偏移（0–0.9），`t = t0 + u*speed` 把 3 s 加速到 6 拍。
- 帧边界由 `timeline.mjs` 吸附（`startFrame=round(t*fps)`），全片合计必须等于 `plan.stats.frames`；不要手写 `round(duration*30)`。
- 61 s 参考剪辑表（含每轮文案/强调色/t0/speed 实测值）见 `references/reference-film-analysis.md` 末节。

