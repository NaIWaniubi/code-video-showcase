> 自 SKILL.md §5（主题系统：17 配色 × 12 材质）拆出，2026-11-24。

## 5. 主题系统（17 套配色 × 12 种材质 + OKLCH/APCA）

主题 = **角色色板 + 材质 + HUD 规格 + 点缀色**四层一起换。数据唯一来源 `templates/themes.js`；材质画法、token 阈值、推荐矩阵、加主题步骤见 `references/themes.md`。

| id | 明暗 | 一句话 |
|---|---|---|
| `coral-noir` | dark | **默认**，原版逐值一致（珊瑚 + 胶片颗粒） |
| `claude-light` | light | 暖纸 + 陶土橙，品牌/知识 |
| `aqua-morandi` | light | 雾面水色 + 淡绿/淡粉，品牌/生活方式 |
| `amber-noir` | dark | 近黑 + 旧金，高端/电影感 |
| `blueprint-stone` | light | 石色纸 + 钴蓝，工程/数据 |
| `graphite-signal` | dark | 石墨灰 + 安全橙，开发者/硬件 |
| `celadon-paper` | light | 单色青 + 宋体，东方/文化 |
| `crimson-theater` | dark | 近黑 + 绯红，时尚/艺术 |
| `cyber-neon` | dark | 近黑 + 电光青，科技/游戏/预告 |
| `paper-journal` | light | 米白 + 赭红，知识/教程/生活 |
| `dark-gold-cinema` | dark | 近黑 + 旧金，高端/电影感 |
| `ice-minimal` | light | 冷白 + 钴蓝，SaaS/数据/医疗 |
| `pop-acid` | dark | 近黑 + 酸性黄绿，潮流/音乐/社交 |
| `terminal-phosphor` | dark | 墨绿 CRT 扫描线 + 磷光绿，开发者/CLI |
| `solar-dusk` | light | 奶油暮色 + 陶土落日，旅行/美食/户外 |
| `abyss-teal` | dark | 深水藏青 + 天蓝焦散，医疗/海洋/深科技 |
| `sand-linen` | light | 本色亚麻织纹 + 靛蓝，出版/教育/人文 |

不传 `theme` 时行为与旧版逐值一致；页面按 URL 选主题，接受中英文别名（`?theme=aqua-morandi`、`?theme=水蓝白`）。页面 API（`themeFromURL / drawThemeBackground / chrome / cardColors / drawGlassPanel`）见 `references/themes.md`。

**铁律**
- 浅色主题的胶囊/倒计时/水印必须用 `chrome(theme)`（深墨实体胶囊）；每套主题（含浅色）都有 `cardDark`，大字卡 layout 2/3 仍是深色卡。
- 大字卡字体固定 Noto Sans SC 900（卡是节拍器）；主题 `type` 字体只用于片头/结尾/风格段。
- 用户只给品牌色时用 `accentOverride` 改 4 个值并校验对比度，不自创第 18 套主题。
- 改完主题必须 `node scripts/theme-audit.mjs --strict` 全绿；暗底细字用 APCA（正文 ≥60 Lc、小字 ≥75、大字 ≥45）；新增主题优先 `derivePalette({mode, accent})` 生成 14 角色，不手调十几个 hex。
- 新增主题必须同步 4 处真值：`templates/themes.js`、`scripts/nl2spec.mjs` 的 `THEME_IDS`、`content/combos.json`（`node scripts/build-combos.mjs` 重生成）、`content/presets.json`（如需首屏预设）；`test-core.mjs` 会交叉校验前三者。

调性与禁忌、按内容类型选主题的矩阵见 `references/themes.md`；预览图在 `assets/theme-previews/`。

