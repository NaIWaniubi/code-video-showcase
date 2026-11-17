#!/usr/bin/env bash
# install.sh — 一条命令把本仓库准备到「能跑 cvs build」的状态（v2.4 / P1-11）。
#
#   bash install.sh
#
# 做什么：检查 Node 22+ → npm ci（无 lock 时 npm install）→ 生成字体 shared/fonts → doctor 环境探测 → 打印下一步。
# 不做什么：不装 Chrome/FFmpeg/Python（操作系统级依赖，doctor 会告诉你缺什么）。
# R3-审计（RT-01）：以前不建字体——全新 clone 缺 shared/fonts 时 doctor 报 E_NO_FONTS
# 却被 `|| true` 吞掉、install.sh 以 0 收尾；且 doctor 给的修复命令 bundle-fonts 本身是
# 死路（它要求先有 build-fonts）。现在字体在安装期生成，doctor 的退出码原样透传。
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  say "✗ 没有找到 Node.js。"
  say "  安装 Node.js 22 LTS：https://nodejs.org/ （或 nvm install 22）"
  say "  装好后重新执行：bash install.sh"
  exit 14
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  say "✗ Node.js $(node -v) 太旧；本项目需要 >=22（raw CDP 使用全局 WebSocket）。"
  say "  nvm install 22 && nvm use 22"
  exit 14
fi
say "✓ Node.js $(node -v)"

if [ -f package-lock.json ]; then
  say "→ npm ci"
  npm ci
else
  say "→ npm install（没有 package-lock.json）"
  npm install
fi

say ""
say "→ 生成字体 shared/fonts（CJK 版式与 golden 预览一致的前提）"
if node scripts/build-fonts.mjs; then
  say "✓ 字体已就位"
else
  FONT_RC=$?
  say "✗ 字体构建失败（exit ${FONT_RC}）。确认 npm ci 已成功；离线环境见 docs/OFFLINE.md。"
  exit 14
fi

say ""
say "→ 环境探测（doctor）"
DOC_RC=0
node scripts/doctor.mjs || DOC_RC=$?

say ""
if [ "$DOC_RC" -ne 0 ]; then
  say "⚠ doctor 有未通过项（上面 ✗ 的 required 条目）：按 fix 命令补齐后重跑本脚本。"
else
  say "✓ 环境就绪"
fi

say ""
say "下一步："
say "  node bin/cvs.mjs ui                # 打开工作台 http://127.0.0.1:5180/app/  ← 推荐入口"
say "  node bin/cvs.mjs new \"做一条 20 秒国风宣传片\" --out project.spec.json"
say "  node bin/cvs.mjs build project.spec.json --platform douyin --strict"
say ""
say "只想要向导页：node bin/cvs.mjs wizard  # http://127.0.0.1:5181/app/wizard/"
say "只想要图片：node bin/cvs.mjs image --spec project.spec.json"
say ""
say "说明：本仓库的 cvs 命令统一写成 node bin/cvs.mjs <命令>；若已 npm link（package.json bin），可直接写 cvs <命令>。"

# 与 install.ps1 同语义：doctor 未过就非 0 退出，自动化判断「装好了没」不再歧义。
exit "$DOC_RC"
