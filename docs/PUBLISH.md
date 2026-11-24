# PUBLISH · 发版与分发 runbook（G11）

> 2026-11-24 制定。对外动作（push/建仓/release）逐节独立，**每节执行前需操作者点头**。
> 三端格局：origin=Moessif（无写权，PR#1 卡 action_required，只作留档）；fork=NaIWaniubi（CI/runner 全在这）；gitee=c666666chen（国内镜像）。
> 转正新仓=NaIWaniubi/cvs-verifiable-video（单提交干净历史，符合「旧全史库留档、新仓对外」偏好）。

## 1. 版本号与标签

1. 四方同步由 `test-version-sync` 钉死（package.json / SKILL.md frontmatter / cvs --version / CHANGELOG 头）。发版只改前三处 + CHANGELOG 新节。
2. `git tag v<X.Y.Z>`；**sync-releases.yml 以 `git tag --list` 为唯一驱动**，CHANGELOG 有节无 tag = 该版本对外不存在。
3. 补历史账：v4.2.0–v4.6.0 在 CHANGELOG 有节但无 tag（审计 G11/F8）——补打前先 `git log --oneline` 找到各节对应 feat 提交，逐个 tag（宁缺勿错，找不到锚点的在 CHANGELOG 节头标 `(untagged)`，不硬造）。

## 2. 推送序列（本机）

```bash
# 先 unset 代理（面板只吃 TUN；github 推送走系统直连/梯子由 TUN 决定）
git push fork main --follow-tags          # 触发 fork 上的 4 条 workflow
git push gitee main --follow-tags         # 国内镜像；gitee 偶发拒绝大 tag 集合时分批：git push gitee --tags
```
- 验证 CI：`gh run list -R NaIWaniubi/code-video-showcase --limit 6`；compiler 绿 + render-smoke 走到 Video QA 步 = 门禁首次全活（G1 修复的判定点）。
- **首跑校准项**：render-smoke 各步在 ubuntu runner 的耗时、`perf --quick`（BROWSER 组）是否 900s 内完成、nightly `--video` determinism 探针首绿。红则按 KNOWN_RED 台账逐条销，不放宽阈值换绿。

## 3. 转正：全新单提交公开仓

```bash
cd code-video-showcase
git checkout --orphan ship-main
git add -A                     # .gitignore 已排除 out//.team/.cluster；assets/demos、assets/catalog 为显式豁免的对外证据
git commit -m "CVS v<X.Y.Z> — pure-code deterministic video compiler (verifiable reproducibility)"
git remote add ship https://github.com/NaIWaniubi/cvs-verifiable-video.git
git push -u ship ship-main:main
```
1. 新仓用 `gh repo create NaIWaniubi/cvs-verifiable-video --public`（描述含 "same input, same video — with receipts"）。
2. 把 `.github/workflows/` 原样带入（fork 上验证过的四条），新仓首跑作为最终验收。
3. README 门面（clone 地址/徽章/release badge/CANONICAL-URL 锚点）切到新仓；旧 fork 与 Moessif 线留档不动。
4. gitee 镜像同步新仓内容（保持单一对外源：gitee 跟 ship 不跟 fork）。
5. **转正后每次发版的固定再同步（实测教训）**：新仓与 main 无共同历史，增量 push 必被 non-fast-forward 拒——一律重建孤儿单提交并强推：
   `git checkout --orphan shipN && git add -A && git commit -m "CVS v<ver> — …" && git push -f <ship-url> shipN:main && git tag -f v<ver> && git push -f <ship-url> v<ver> && git checkout main && git branch -d shipN`；
   fork/gitee 的 tag 也要 `git tag -f + push -f` 对齐同一发布点（否则 release/CI 指着的树仍带旧缺陷——v4.13.0 首夜两连击：ubuntu 缺 numpy → windows 也缺，tag 两次追补）。

## 4. Release 正文

- sync-releases.yml 已改 `^## \[<tag>\]` 行首精确锚（G1-7）；推 tag 即自动同步 CHANGELOG 对应节到 GitHub Release，正文含 `attestation` 样例链接（assets/demos/showcase-360.attestation.json）。

## 5. skills.sh 上架（需人工登录一步）

1. 新仓根保留 `SKILL.md`（路由主文 ≤6KB）+ `references/skill-*.md`——skills.sh 抓 `SKILL.md` frontmatter 建索引。
2. 提交渠道：`npx skills add <owner>/<repo>` 即装；上架清单走 skills.sh 的收录 PR 流程（**登录/点确认由本人操作**，agent 展示页面后人过）。
3. 版本对齐纪律：skill 随 **tag** 安装而非 main HEAD——README/skill 文档统一写 `npx skills add owner/repo@v<X.Y.Z>` 形态。

## 6. 体积与 LFS 决策

- demo=640×360/24fps/41s ≈ 2–6MB、目录 27×PNG ≈ 10MB 量级，**远低于 GitHub 单文件 100MB / 仓库软上限，不引入 Git LFS**（LFS 会污染 clone-by-agent 体验：`git clone` 即得全部证据是「可验证」叙事的一部分）。
- 若未来上 1080p 母带 demo：放 GitHub Release **附件**（release asset），仓库内只留 360p + 证书 + `cvs verify` 复现说明。

## 7. 发版检查单（照抄执行）

```
[ ] test:all UNIT 全绿（46+套）
[ ] test:all --browser 绿（golden/frames/api/…；perf 允许 timing-warn 不许 correctness 红）
[ ] e2e: mini-41s --strict 出片 + attest→verify 四层 match
[ ] theme-audit --strict exit 0（极性修复后摘除 render-smoke 的 continue-on-error）
[ ] errors.mjs --check coverage 100% / version-sync 4 处一致
[ ] CHANGELOG 新节 + KNOWN_RED 增删如实
[ ] tag + push fork/gitee(+ship) → CI 首跑读表 → release 自动同步
[ ] 擂台文 docs/WHY-VERIFIABLE.md 数字与本版实测一致
```
