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
import { spawnSync } from 'node:child_process';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { writeZip } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROG = 'node scripts/ship.mjs';
const KNOWN = new Set(['spec', 'out', 'json', 'check', 'force', 'strict', 'emit-motion', 'help']);
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !String(a).startsWith('--'));
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);

if (args.help || positional.length < 1) {
  console.log(`Usage: node scripts/ship.mjs <spec.json> [options]
  <spec.json>         项目 spec（应先 cvs build 过，产物按 spec.render.outDir）
  --out <zip|dir>     zip 打包（默认）或解到目录 <stem>-ship/
  --check             打包前对 master.mp4 跑双闸 QA + 审美闸 taste（FAIL 时默认拒绝打包，--force 可强出）
  --strict            传给 taste：warning 级也拦（error 级永远拦）
  --force             QA 未过也照常打包（如实标注）
  --emit-motion       附带 .motion rc.1 打包档：motion/manifest.json + motion/shots.json
                      （纯打包：从 out/plan.json 的 segments 映射 meta+shots，零新依赖；
                      plan.json 缺席时如实跳过）
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

// ── G10/S3-4：--emit-motion 纯打包 .motion rc.1 目录档 ────────────────────
// 从 plan.segments 映射 meta + shots 列表；零新依赖（writeZip 已在用，json 手搓）。
// 语义诚实：这是 CVS plan 到 .motion 目录结构的**打包档**，只做结构映射
// （startFrame/frames → startSec/durationSec），不重跑渲染、不声称字节等价。
// plan.json 缺席时如实降级（不伪造 motion/ 目录）。
let emitMotion = false;
if (args['emit-motion']) {
  emitMotion = true;
  const planFile = path.join(deliverableDir, 'plan.json');
  if (fs.existsSync(planFile)) {
    try {
      const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
      const fps = Number(plan.meta?.fps) || 30;
      const manifest = {
        format: 'motion/rc.1',
        generatedBy: 'code-video-showcase ship --emit-motion',
        meta: {
          name: String(raw.meta?.name || stem),
          title: String(raw.meta?.title || raw.meta?.name || stem),
          fps,
          width: Number(plan.meta?.width) || null,
          height: Number(plan.meta?.height) || null,
          durationSec: Number(plan.stats?.duration ?? null),
          theme: plan.meta?.theme || null,
          motion: plan.meta?.motion || null,
        },
      };
      const shots = (Array.isArray(plan.segments) ? plan.segments : []).map((s) => ({
        id: s.id ?? null,
        kind: s.kind ?? null,
        label: s.label ?? null,
        startSec: Number(((s.startFrame || 0) / fps).toFixed(4)),
        durationSec: Number(((s.frames || 0) / fps).toFixed(4)),
        startFrame: s.startFrame ?? null,
        frames: s.frames ?? null,
        page: s.page ?? null,
        hash: s.hash ?? null,
      }));
      files.set(`${stem}/motion/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'));
      files.set(`${stem}/motion/shots.json`, Buffer.from(JSON.stringify({ shots }, null, 2) + '\n', 'utf8'));
      console.error(`[ship]  --emit-motion: motion/manifest.json + motion/shots.json（${shots.length} shots，纯打包自 plan.segments）`);
    } catch (e) {
      console.error(`[warn] --emit-motion 解析 plan.json 失败，未生成 motion/：${String(e.message || e)}`);
    }
  } else {
    console.error('[warn] --emit-motion 需要 out/plan.json（先 cvs plan/build），未生成 motion/ 目录');
  }
}

// ── R11-W1：打包前双闸 QA ──────────────────────────────────
let qaStatus = null;
let tasteStatus = null;
if (args.check && files.has(`${stem}/master/master.mp4`) && !args.force) {
  const py = process.env.PYTHON || 'python';
  const masterAbs = path.join(deliverableDir, 'master.mp4');
  console.error('[ship]  pre-package QA…');
  const planArg = fs.existsSync(path.join(deliverableDir, 'plan.json'))
    ? ['--plan', path.join(deliverableDir, 'plan.json')] : [];
  const qr = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/qa.mjs'), masterAbs, ...planArg,
  ], { cwd: ROOT, stdio: 'inherit' });
  qaStatus = qr.status ?? 1;
  if (qr.status !== 0) {
    console.error(`[ship]  ✗ 预检未过（exit ${qr.status}）——交付物不合规，拒绝打包。` +
      `确认无误要强出？加 --force（清单里会标注 unvalidated）`);
    process.exit(13);
  }
  console.error('[ship]  ✓ 预检通过');
  // G3-2：审美闸 taste（SKILL 承诺的「error 拦」从话术变事实）。与 qa 同级 spawn：
  // error 级 finding 恒拦、ship --strict 时 warning 也拦；退出码 0/1/2 原样透传。
  console.error('[ship]  pre-package taste…');
  const tr = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/taste.mjs'), specPath, '--root', ROOT,
    ...(args.strict ? ['--strict'] : []),
  ], { cwd: ROOT, stdio: 'inherit' });
  tasteStatus = tr.status ?? 2;
  if (tasteStatus !== 0) {
    console.error(`[ship]  ✗ taste 审美闸不过（exit ${tasteStatus}）——拒绝打包。` +
      `确认无误要强出？加 --force；确属误判走 .cvs/waivers.json（rule+reason+date）`);
    process.exit(tasteStatus);
  }
  console.error('[ship]  ✓ taste 通过');
  // R12-W1：QA 报告一并入库——交付包自带质检凭据，接收方不用重跑就能看到当时的结论
  for (const qpath of [
    path.join(deliverableDir, '..', 'qa/qa-video.json'),
    path.join(deliverableDir, '..', 'qa/qa-audio.json'),
    path.join(ROOT, 'out', 'qa', 'taste.json'),
  ]) {
    if (fs.existsSync(qpath)) files.set(`${stem}/qa-reports/${path.basename(qpath)}`, fs.readFileSync(qpath));
  }
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
const result = { ok: true, stem, entries: files.size, mode, archive: archiveName,
  emitMotion,
  missing, qaChecked: !!args.check, qaPass: args.check ? qaStatus === 0 : null,
  tasteChecked: args.check ? tasteStatus !== null : false,
  tastePass: tasteStatus === null ? null : tasteStatus === 0, tasteExit: tasteStatus };
if (args.json) process.stdout.write(JSON.stringify(result) + '\n');

// 缺成片不算失败（清单如实标注），但要留痕给自动化判断
// G10 回归：addIf 登记的是 relName（'master'），旧判断查 'master.mp4' 恒 false，
// 「缺 master 退 13」这条留痕从未生效。两种拼写都认，行为回到文件头注释的口径。
const masterMissing = missing.some((m) => m === 'master' || m === 'master.mp4');
if (masterMissing) {
  console.error('[warn] 包内没有 master.mp4——这不是完整交付（先 cvs build）');
}
process.exit(masterMissing ? 13 : 0);