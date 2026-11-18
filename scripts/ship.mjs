#!/usr/bin/env node
/**
 * ship.mjs — `cvs ship <spec> [--out zip|dir]`：把一次交付物打成开箱即用的包。
 *
 *   cvs ship project.spec.json                  # → out/ship-<name>/<name>.zip
 *   cvs ship project.spec.json --out dir        # 同内容落目录（不解 zip）
 *   cvs ship project.spec.json --json           # stdout 一行 JSON
 *
 * 包内结构（竞赛「作品四件套」与日常交付同形）：
 *   <basename>/
 *     project.spec.json     设计稿（唯一入口，重编译必需）
 *     master.mp4            母版成片（若已 build）
 *     delivery.json        交付清单（含每件 sha256）
 *     master.srt/.vtt       字幕（如有）
 *     README.md             自动生成：环境要求 + 三步复现命令 + 目录说明
 * 前置：spec 应已 build 过（产物在 spec.render.outDir）——没 build 就如实报缺件，
 * 不静默出一个没有成片的「交付包」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { writeZip } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROG = 'node scripts/ship.mjs';
const KNOWN = new Set(['spec', 'out', 'json', 'help']);
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !String(a).startsWith('--'));
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);

if (args.help || positional.length < 1) {
  console.log(`Usage: node scripts/ship.mjs <spec.json> [options]
  <spec.json>         项目 spec（应先 cvs build 过，产物按 spec.render.outDir）
  --out <zip|dir>     zip 打包（默认）或解到目录 <stem>-ship/
  --json              one-line JSON on stdout, human text to stderr`);
  process.exit(args.help ? 0 : 2);
}

const specPath = path.resolve(process.cwd(), String(positional[0]));
let raw;
try { raw = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
catch (e) { console.error(`[error] [E_READ] cannot read/parse spec ${specPath}: ${e.message}`); process.exit(10); }

const outDirRaw = path.resolve(process.cwd(), String(raw.render?.outDir || 'out'));
const stem = path.basename(specPath).replace(/\.[^.]+$/, '');
const deliverableDir = outDirRaw;
const files = new Map();
const missing = [];
const addIf = (relName, absPath) => {
  if (!fs.existsSync(absPath)) { missing.push(relName); return; }
  const base = path.basename(absPath);
  files.set(`${stem}/${relName}/${base}`, fs.readFileSync(absPath));
};

// ── 必收：spec / master / 清单 ──────────────────────────────
files.set(`${stem}/project.spec.json`, fs.readFileSync(specPath));
addIf('master', path.join(deliverableDir, 'master.mp4'));
addIf('delivery', path.join(deliverableDir, 'delivery.json'));
addIf('subtitles-srt', path.join(deliverableDir, 'master.srt'));
addIf('subtitles-vtt', path.join(deliverableDir, 'master.vtt'));
// plan 与封面：一并打包重编译/再投放所需
addIf('plan', path.join(deliverableDir, 'plan.json'));

if (missing.length) {
  // 成片缺席是最常见的前置缺失——说清楚，而不是安静出空壳
  console.error(`[warn] 以下产物未找到（确认已 cvs build 过）：${missing.join(', ')}`);
}

// ── 自生成 README ──────────────────────────────────────────
const title = String(raw.meta?.title || raw.meta?.name || stem);
const brand = String(raw.meta?.brand || '');
const readme = `# ${title}${brand ? ` · ${brand}` : ''}

## 这是什么

由 \`code-video-showcase\` 编译交付的纯代码视频作品：画面是逐帧确定性渲染的函数，
不是生成模型。包内所有文件可追溯到 \`project.spec.json\` 这一份设计稿。

## 目录

| 文件 | 说明 |
|---|---|
| \`project.spec.json\` | 设计稿（唯一入口；改它 = 改这部片子） |
| \`master.mp4\` | 母版成片（H.264，bt709，字幕外挂） |
| \`master.srt\` / \`master.vtt\` | 字幕（如已交付） |
| \`plan.json\` | 分段时间表（质检 / 再剪辑用） |
| \`delivery.json\` | 交付清单（每件字节数 + sha256） |

## 环境要求

- Node.js ≥ 22
- FFmpeg（含 libx264 / AAC）；Chrome 或 Playwright Chromium（仅重新编译时需要）

## 从零复现（三步）

\`\`\`bash
bash install.sh                                   # Windows: powershell -ExecutionPolicy Bypass -File install.ps1
node bin/cvs.mjs lint project.spec.json --root .
node bin/cvs.mjs build project.spec.json           # 产物按 spec 的 render.outDir
\`\`\`

## 质检

\`\`\`bash
node bin/cvs.mjs qa                                # 对最近一次 build 的产物跑全部闸门
\`\`\`

## 许可

本作品画面管线为 MIT 许可的 code-video-showcase 构建；素材与文案版权归项目所有者。
`;
files.set(`${stem}/README.md`, Buffer.from(readme, 'utf8'));

// ── 输出 ────────────────────────────────────────────────────
const mode = args.out === 'dir' ? 'dir' : 'zip';
const stamp = new Date().toISOString().slice(0, 10);
const stemFull = `${stem}-${stamp}`.replace(/[^A-Za-z0-9._-]/g, '-');
if (mode === 'dir') {
  const dest = path.resolve(process.cwd(), `${stemFull}/`);
  fs.mkdirSync(dest, { recursive: true });
  for (const [rel, buf] of files) {
    const p = path.join(dest, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
  console.error(`[ship]  ${files.size} 件 -> ${dest}（目录模式）`);
} else {
  const zipPath = path.resolve(process.cwd(), path.join(outDirRaw, `${stemFull}.zip`));
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, writeZip(files));
  console.error(`[ship]  ${files.size} 件（zip ${fs.statSync(zipPath).size} B）-> ${zipPath}`);
}

const archiveName = mode === 'zip' ? `${stemFull}.zip` : null;
const result = { ok: true, stem, entries: files.size, mode, archive: archiveName, missing };
if (args.json) process.stdout.write(JSON.stringify(result) + '\n');

// 缺成片不算失败（清单如实标注），但要留痕给自动化判断
if (missing.includes('master.mp4')) {
  console.error('[warn] 包内没有 master.mp4——这不是完整交付（先 cvs build）');
}
process.exit(missing.includes('master.mp4') ? 13 : 0);