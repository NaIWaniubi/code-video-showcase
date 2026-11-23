# 为什么「可验证」是唯一的护城河
### —— 对标 HyperFrames / OpenFilm 的《same input, same video》：话术 vs 哈希

> 2026-11-24 发布口径定稿。本文所有数字来自本仓库当轮实测（提交 `1c2a904`，v4.12.0+），命令可逐条复跑。

## 1. 赛道现状：人人都说确定性，没人出示证据

2026-11 的 code-first 视频渲染赛道里，"deterministic" 已经从差异点降成了品类关键词：

| 项目 | 星数（GitHub API 直查 2026-11-23） | 它的「确定性」说法 | 它出示什么 |
|---|---|---|---|
| HyperFrames | 88,518 | "same input same video" | README 话术；hash 用于**文件完整性**，不是像素 |
| OpenFilm | 9,052（建库仅 7 周） | "always the same picture for the same t, renders the same on any machine" | README 话术 |
| Remotion | 75,055 | 无此主打 | — |
| Pellicule / vueseq / beatframe | <800 | 项目名/简介直接叫 deterministic | 无证据链 |

全赛道检索未发现任何一家发布过**产物哈希证书 + 跨机重放验证器**。所有"确定性"声明目前都不可反驳、也因此不可确认。

## 2. 我们自己也不信自己——直到把三颗雷排掉

诚实是这篇文能存在的前提。本仓 11-23 的六路审计（61 条 finding）先扒了自己的皮：

1. **门禁薛定谔**：主 CI 测试步骤 `| tee` 吞退出码，`ok:false` 时步骤照样绿——我们差点用假绿去指控别人没证据。修：pipefail + `tallySuite` 聚合强一致（`failed:0` 与 `ok:false` 同屏这种谎报被回归钉死）。
2. **S8 冷重跑像素漂移**：同参三连跑逐帧互异。定案：病灶不是玄学的 GPU 调度，是捕获模式启发式把页面误踢进 CDP 合成器截图链（实测 raw/canvas 各 3/3 逐字节同、cdp 6 次 2 偏）。修后复现配置三连跑**容器层+解码帧层全同**。
3. **缓存混拼**：`capture/format/crf` 等旋钮不进段哈希，非默认参数产物会毒化「同内容同缓存」承诺。修：knobs 折进缓存键+manifest 记账，全默认不失效 warm 缓存。

**没有这一段，第 3 节的证书就是空口白话。** 竞品若认真做审计，大概率也会挖出同族问题——区别只是他们还没人公开挖。

## 3. 我们出示的东西：`cvs attest` / `cvs verify`

```
cvs build spec.json --strict          → QA 全闸（帧数/色彩标签/响度/TruePeek/WCAG flash-rate/冻结帧…）
cvs attest out/master.mp4             → attestation.json：四层证据分开封存
    container  = sha256(成片字节)
    frames     = framemd5 逐帧摘要聚合（丢容器耦合项，1230/1230 帧）+ 首漂移帧定位
    toolchain  = node|ffmpeg|浏览器 指纹（复用段缓存同款 toolchainFingerprint）
    plan       = 23 段 segmentHash + ENGINE_VERSION 绑定
    digest     = 四层规范化 JSON 的 sha256 —— 生成时间/路径不进 digest，故跨机可重算可比
cvs verify out/master.mp4 --verify attestation.json
    verdict ∈ { pass, pass-with-note(容器异帧同=mux 抖动), fail(帧层异/段绑定断裂) }，exit 码进 CI
```

三条与话术的本质区别：
- **离线复核**：第二台机器不需要构建能力，只要 ffmpeg + 这份证书。
- **分层归因**：不同在哪一层说得出口（mux？编码器？像素？），而不是笼统"不一致"。
- **闸进交付链**：taste/qa 已接 `ship`，verify 可进 CI——不是给人看的规则文档，是带退出码的判决。

## 4. 实测证据（本机，全部可复跑）

- 幂等：`determinism-check --video --runs 3`（640×360 cyber-neon，当年漂移复现配置）→ 容器+帧层逐字节同。
- 全链：mini-41s `--strict` e2e → QA 18 PASS/0 FAIL → attest `digest=40dcac32…` → verify 四层全 match。
- 负例（防自证）：篡改 attestation 帧摘要 / 重编码像素变体 → verify 必红且指认到层与帧号（`test-attest` B4/C 组固化）。
- 回归网：UNIT 46 套 / 611 断言 / 0 红；golden 位级基线 12 静帧每次 CI 对账。

## 5. 我们不强辩什么（边界即信用）

- **静帧级幂等是硬承诺；视频级"一次成像"**：交付物出片时即封存证书，此后任何非同 toolchain 重放都属于"另一支片子"——这是渲染管线（浏览器光栅化）的物理边界，我们把它写进证书语义而不是藏进脚注。
- 音频层不在 attest v1 范围（合成器链确定性另行验证）；跨**大版本** ffmpeg/Chrome 的字节级一致不作为承诺，证书会如实标 toolchain diff。
- 赛道竞品没有"错"——他们只是没把可验证当产品主张。若他们明天跟进，本文的对照表欢迎更新。

## 6. 复现包（给懂行追问的人）

```bash
git clone <canonical-repo> && cd code-video-showcase
npm run test:all -- --json            # 46 套 611 断言
node scripts/determinism-check.mjs --video --runs 3 --width 640 --height 360 --fps 24 \
     --page "templates/segment.html?theme=cyber-neon" --duration 2
node bin/cvs.mjs build fixtures/mini-41s/spec.json --platform douyin --strict
node bin/cvs.mjs attest out/mini-41s/master.mp4 --out out/mini-41s/attestation.json
node bin/cvs.mjs attest out/mini-41s/master.mp4 --verify out/mini-41s/attestation.json
```

**HyperFrames 说 same input same video。我们出示哈希。**
