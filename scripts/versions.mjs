#!/usr/bin/env node
/**
 * versions.mjs — 版本快照 / 校验 / 回滚（v2.4 / P1-13）。
 *
 * 审片闭环缺的不是评论框，而是「评论针对的那一版还能找回来」：
 * 每次出片把 master / spec / plan / 清单 / 字幕 / QA 存进 `<outDir>/versions/vNNN/`，
 * 记录每个文件的 sha256；回滚时先逐文件校验，再恢复 master 与 spec。
 *
 *   node scripts/versions.mjs snapshot --spec project.spec.json [--label 初版]
 *   node scripts/versions.mjs list [--json]
 *   node scripts/versions.mjs verify v001
 *   node scripts/versions.mjs rollback v001 [--spec project.spec.json]
 *   node scripts/versions.mjs --help
 *
 * 退出码：0 ok；2 用法；13 产物缺失/校验失败/版本不存在。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';

const PROG = 'node scripts/versions.mjs';
// R3-审计（RT-04 #1）：宽容解析曾让 `--labell 初版` 静默照跑。
const KNOWN_FLAGS = new Set(['spec', 'outdir', 'root', 'label', 'json', 'help']);
const parsed = parseStrict(process.argv.slice(2), KNOWN_FLAGS);
if (parsed.unknown.length) rejectUnknown(PROG, parsed.unknown, KNOWN_FLAGS);
// 位置参数（子命令与版本号）单独收进 args._，保持既有消费点不变。
const args = { ...parsed.args, _: process.argv.slice(2).filter((a) => !String(a).startsWith('--')) };
const cmd = args._[0] || null;
const ROOT = path.resolve(String(args.root || process.cwd()));
const USAGE = `Usage:
  node scripts/versions.mjs snapshot --spec <spec.json> [--outdir <dir>] [--label <name>] [--root <dir>]
  node scripts/versions.mjs list [--spec <spec.json>] [--outdir <dir>] [--json]
  node scripts/versions.mjs verify <version> [--spec <spec.json>] [--outdir <dir>]
  node scripts/versions.mjs rollback <version> [--spec <spec.json>] [--outdir <dir>]

Artifacts: <outDir>/versions/versions.json + vNNN/{master.mp4,project.spec.json,plan.json,...}
Exit codes: 0 ok · 2 usage · 13 missing artifact / hash mismatch / unknown version.`;

if (args.help || !cmd) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 2);
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bytes = (file) => fs.statSync(file).size;
const toPosix = (p) => String(p).split(path.sep).join('/');
const nowIso = () => new Date().toISOString();

function readSpec(file) {
  const abs = path.resolve(ROOT, String(file));
  try {
    return { spec: JSON.parse(fs.readFileSync(abs, 'utf8')), path: abs };
  } catch (e) {
    console.error(`[error] [E_SPEC] cannot read ${abs}: ${e.message}`);
    process.exit(10);
  }
}

function resolveOutDir(spec, explicit) {
  const raw = String(explicit || spec?.render?.outDir || 'out');
  // R3-审计（RT-07 P1-1）：snapshot/rollback 不经 validateSpec，`../..` outDir
  // 曾能把 master/spec 全量复制到仓库外。与 compile errorDir 同款闸门。
  if (/^(?:[/\\]|[A-Za-z]:)/.test(raw) || raw.split(/[\\/]+/).includes('..') || /[\x00-\x1f]/.test(raw)) {
    return path.join(ROOT, 'out');
  }
  const dir = path.resolve(ROOT, raw);
  const rel = path.relative(ROOT, dir);
  return (rel.startsWith('..') || path.isAbsolute(rel)) ? path.join(ROOT, 'out') : dir;
}

function indexPath(outDir) { return path.join(outDir, 'versions', 'versions.json'); }

function readIndex(outDir) {
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(outDir), 'utf8'));
    if (j && Array.isArray(j.versions)) return j;
  } catch { /* first snapshot */ }
  return { schema: 'cvs.versions/v1', versions: [] };
}

function writeIndex(outDir, index) {
  const file = indexPath(outDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function slug(label) {
  return String(label || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** 快照要收的文件：交付与追责所需，不含平台大文件（需要时另行拷贝）。 */
const SNAPSHOT_FILES = [
  'master.mp4', 'delivery.json', 'plan.json', 'render-manifest.json',
  'master.srt', 'master.vtt', 'qa/qa-video.json', 'qa/qa-audio.json', 'review.json',
];

function snapshot() {
  if (!args.spec) {
    console.error('[error] [E_SPEC] snapshot needs --spec <project.spec.json>');
    process.exit(2);
  }
  const { spec, path: specPath } = readSpec(args.spec);
  const outDir = resolveOutDir(spec, args.outdir);
  const master = path.join(outDir, 'master.mp4');
  if (!fs.existsSync(master)) {
    console.error(`[error] [E_NO_MASTER] ${master} not found; run \`cvs build\` first`);
    process.exit(13);
  }
  const index = readIndex(outDir);
  const n = index.versions.length + 1;
  const version = `v${String(n).padStart(3, '0')}`;
  const label = slug(args.label);
  const dirName = label ? `${version}-${label}` : version;
  const dir = path.join(outDir, 'versions', dirName);
  fs.mkdirSync(dir, { recursive: true });

  const files = {};
  for (const rel of SNAPSHOT_FILES) {
    const src = path.join(outDir, rel);
    if (!fs.existsSync(src)) {
      if (rel === 'review.json') {
        const review = { schema: 'cvs.review/v1', version, comments: [] };
        fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(review, null, 2) + '\n');
        files['review.json'] = { sha256: sha256(path.join(dir, 'review.json')), bytes: bytes(path.join(dir, 'review.json')) };
      }
      continue;
    }
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    files[toPosix(rel)] = { sha256: sha256(dst), bytes: bytes(dst) };
  }
  // spec 一起进快照：没有它，回滚出来的 master 无法再编译。
  fs.copyFileSync(specPath, path.join(dir, 'project.spec.json'));
  files['project.spec.json'] = { sha256: sha256(path.join(dir, 'project.spec.json')), bytes: bytes(path.join(dir, 'project.spec.json')) };

  const entry = {
    version: dirName,
    label: String(args.label || ''),
    createdAt: nowIso(),
    specHash: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 12),
    masterSha256: files['master.mp4'] ? files['master.mp4'].sha256 : null,
    sourceOutDir: toPosix(path.relative(ROOT, outDir)),
    files,
  };
  index.versions.push(entry);
  writeIndex(outDir, index);

  console.log(`✓ snapshot ${dirName} · ${Object.keys(files).length} files · master ${entry.masterSha256.slice(0, 12)}`);
  console.log(`  ${toPosix(path.relative(ROOT, dir))}`);
  for (const [f, meta] of Object.entries(files)) console.log(`  ${f.padEnd(26)} ${meta.sha256.slice(0, 12)}  ${meta.bytes} B`);
}

/** 快照文件清单的回滚白名单（R3-审计 RT-07 P2-6）：防止被改写的索引条目
 *  把 verify/rollback 引到项目外路径。只收 SNAPSHOT_FILES 里的名与 spec。 */
const ROLLBACK_FILES = ['master.mp4', 'delivery.json', 'plan.json', 'master.srt', 'master.vtt'];
/** 条目名必须是根内相对路径（无绝对、无反斜杠、无 `..`/`.` 段）；
 * 嵌套目录（qa/qa-video.json）是合法快照内容，放行。 */
const isSafeRel = (rel) => {
  const s = String(rel || '');
  if (!s || s.length > 200 || path.isAbsolute(s)) return false;
  if (/[\\]/.test(s) || /[\x00-\x1f]/.test(s)) return false;
  return !s.split('/').some((p) => p === '..' || p === '.');
};
function loadEntry(outDir, version) {
  const index = readIndex(outDir);
  const entry = index.versions.find((v) => v.version === version || v.version.startsWith(`${version}-`));
  if (!entry) {
    console.error(`[error] [E_VERSION_UNKNOWN] ${version} not found in ${toPosix(path.relative(ROOT, indexPath(outDir)))}`);
    process.exit(13);
  }
  // R3-审计（RT-07 P2-6）：entry.version 直接进 join——索引被改写后可把
  // rollback 的复制源引到项目外。按穿越语义拦截（分隔符/../ 前缀），不按
  // 字符集——合法 label 可以是中文（v001-初版）。
  const nameOk = typeof entry.version === 'string' && entry.version.length < 200 &&
    !/[\\/]/.test(entry.version) && entry.version !== '.' && entry.version !== '..' &&
    !entry.version.startsWith('..') && !path.isAbsolute(entry.version);
  if (nameOk) {
    return { index, entry, dir: path.join(outDir, 'versions', entry.version) };
  }
  console.error(`[error] [E_SNAPSHOT_TAMPERED] ${version}: versions.json 条目名非法 (${String(entry.version).slice(0, 80)})`);
  process.exit(13);
}

function verifyEntry(entry, dir) {
  const bad = [];
  for (const [rel, meta] of Object.entries(entry.files || {})) {
    // R3-审计（RT-07 P2-6）：条目名直接进 join，索引被改写时可读项目外文件并
    // 报 mismatch 误导排障。无分隔/无 ../ 的单段名才放行。
    if (!isSafeRel(rel)) { bad.push(`${String(rel).slice(0, 80)}: unsafe entry name`); continue; }
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) { bad.push(`${rel}: missing`); continue; }
    if (sha256(file) !== meta.sha256) bad.push(`${rel}: sha256 mismatch`);
    if (bytes(file) !== meta.bytes) bad.push(`${rel}: size mismatch`);
  }
  return bad;
}

function verify() {
  const version = args._[1];
  if (!version) { console.error('[error] [E_VERSION] verify needs <version>'); process.exit(2); }
  // 与 snapshot/rollback 一致：--spec 也能定位 outDir。以前只认 --outdir，
  // 于是 `cvs verify v001 --spec X` 会静默跑去 out/ 找，报 E_VERSION_UNKNOWN。
  const specHint = args.spec ? readSpec(args.spec).spec : null;
  const outDir = resolveOutDir(specHint, args.outdir);
  const { entry, dir } = loadEntry(outDir, version);
  const bad = verifyEntry(entry, dir);
  if (bad.length) {
    console.error(`✗ ${entry.version}: ${bad.length} problem(s)`);
    for (const b of bad) console.error(`  ${b}`);
    process.exit(13);
  }
  console.log(`✓ ${entry.version}: ${Object.keys(entry.files).length} files match the recorded sha256`);
}

function list() {
  const specHint = args.spec ? readSpec(args.spec).spec : null;
  const outDir = resolveOutDir(specHint, args.outdir);
  const index = readIndex(outDir);
  if (args.json) {
    console.log(JSON.stringify(index, null, 2));
    return;
  }
  if (!index.versions.length) {
    console.log(`(no snapshots in ${toPosix(path.relative(ROOT, outDir))}/versions)`);
    return;
  }
  for (const v of index.versions) {
    console.log(`${v.version.padEnd(28)} ${v.createdAt}  master=${String(v.masterSha256 || '').slice(0, 12)}  ${v.label || ''}`);
  }
}

function rollback() {
  const version = args._[1];
  if (!version) { console.error('[error] [E_VERSION] rollback needs <version>'); process.exit(2); }
  const specHint = args.spec ? readSpec(args.spec).spec : null;
  const outDir = resolveOutDir(specHint, args.outdir);
  const { entry, dir } = loadEntry(outDir, version);

  // 先校验收回的对象没被动过：回滚到被篡改的版本比不回滚更危险。
  const bad = verifyEntry(entry, dir);
  if (bad.length) {
    console.error(`[error] [E_SNAPSHOT_TAMPERED] ${entry.version} failed verification:`);
    for (const b of bad) console.error(`  ${b}`);
    process.exit(13);
  }

  const restored = [];
  for (const rel of ROLLBACK_FILES) {
    // R3-审计（RT-07 P2-6 / RT-04 #11）：恢复集收敛到白名单；恢复后逐件复核
    // sha256——快照集与恢复集以前不对称（只复验 master），审计口径有洞。
    const src = path.join(dir, rel);
    if (!fs.existsSync(src)) continue;
    if (!isSafeRel(rel)) { console.error(`[error] [E_SNAPSHOT_TAMPERED] 条目文件名非法：${rel}`); process.exit(13); }
    if (!(entry.files || {})[rel]) { console.error(`[error] [E_SNAPSHOT_TAMPERED] versions.json 未登记该文件：${rel}`); process.exit(13); }
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.rollback-${process.pid}`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dst);
    restored.push(rel);
  }
  // spec：优先回滚到 --spec 指定的位置，否则放一份 project.spec.json 供下次 build。
  const specDst = args.spec ? path.resolve(ROOT, String(args.spec)) : path.join(outDir, 'project.spec.json');
  fs.mkdirSync(path.dirname(specDst), { recursive: true });
  fs.copyFileSync(path.join(dir, 'project.spec.json'), specDst);
  restored.push(toPosix(path.relative(ROOT, specDst)));

  const master = path.join(outDir, 'master.mp4');
  const got = fs.existsSync(master) ? sha256(master) : null;
  if (got !== entry.masterSha256) {
    console.error(`[error] [E_ROLLBACK_HASH] restored master sha ${got} != recorded ${entry.masterSha256}`);
    process.exit(13);
  }
  const receipt = {
    schema: 'cvs.rollback/v1',
    at: nowIso(),
    version: entry.version,
    label: entry.label,
    restored,
    masterSha256: got,
  };
  fs.writeFileSync(path.join(outDir, 'rollback.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`✓ rolled back to ${entry.version} (${restored.length} files) · master sha ${got.slice(0, 12)}`);
  console.log(`  receipt: ${toPosix(path.relative(ROOT, path.join(outDir, 'rollback.json')))}`);
}

switch (cmd) {
  case 'snapshot': snapshot(); break;
  case 'list': list(); break;
  case 'verify': verify(); break;
  case 'rollback': rollback(); break;
  default:
    console.error(`[error] [E_COMMAND] unknown command "${cmd}"\n\n${USAGE}`);
    process.exit(2);
}
