> 自 SKILL.md §0 + §1（适用/不适用与交付物硬约束（渲染契约））拆出，2026-11-24。

## 0. 适用与不适用

**适用**：30–90 s 多美术风格切换的「风格展示 / 产品宣传」短片；120 BPM 强节拍 + 大字卡与风格段交替的卡点结构；同一内容要换品牌气质（17 套主题，见 §5）；明确要求纯代码、可复现、逐帧确定性渲染。

**不适用**：写实镜头/真人/复杂叙事长视频；需要调用文生视频/图/音乐模型的场景（本技能明确禁止）。

---

## 1. 交付物与硬约束

| 项目 | 默认值 |
|---|---|
| 画幅/帧率 | 1920×1080，30 fps |
| 时长 | 61.0 s = 1830 帧（按 §3 公式改） |
| 音频 | 48 kHz 立体声 AAC 192–320 kbps，EBU R128 −14 LUFS |
| 视频 | H.264 High，yuv420p，bt709，CRF 21（母版）/22–24（平台），maxrate 限峰，+faststart |
| 节拍 | 120 BPM：1 拍 = 0.5 s，1 小节 = 2 s |
| 主题配色 | 17 选 1，默认 `coral-noir`（原版：珊瑚 `#d97757` + 深底 `#0e0e0d`）；OKLCH token + APCA/WCAG 审计（含上屏组合矩阵），见 §5、`references/themes.md` |
| 字体 | 分发的 7 个 OFL 字族（Noto Sans/Serif CJK SC、ZCOOL KuaiLe、JetBrains Mono、Inter、Orbitron、Playfair Display）；另 4 个（马善政/Long Cang/ZCOOL QingKe/Press Start 2P）文档曾列但未随包分发，`paper-journal` 的 `Ma Shan Zheng` 会回退系统字体。集合与许可见 `references/themes.md`、`THIRD-PARTY-NOTICES.md` |
| 字幕 | 不要底部字幕；信息都做成画面内的胶囊/HUD/注释 |
| 确定性 | 画面是 `t` 的纯函数，禁止 CSS transition/animation、rAF、Date.now、Math.random |

**每个片段必须满足**（渲染契约，Playwright 与零依赖 CDP 共用）：`window.DURATION`（秒）、`window.renderFrame(t)`（只依赖 t 和常量；禁止时间/随机副作用）、`window.__ready`（资源就绪置 true）、`window.__bootError`（初始化失败写错误串，渲染器立即报错）、`window.__capture`（可选 `'canvas'`/`'cdp'`）。单 canvas 默认 `toDataURL()`（快 30–50%），有 DOM 叠加自动回退 `Page.captureScreenshot`；WebGL 必须 `preserveDrawingBuffer:true` 或设 `__capture='cdp'`。

