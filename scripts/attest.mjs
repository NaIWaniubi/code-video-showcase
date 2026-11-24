#!/usr/bin/env node
/**
 * attest.mjs — G9 产物哈希证书 + 跨机重放验证器。
 *
 *   cvs attest <out.mp4> [--verify <attestation.json>] [--manifest render-manifest.json]
 *                [--plan plan.json] [--out <attestation.json>] [--json]
 *
 * 为什么这跟别家的「hash」不是一回事：HyperFrames/OpenFilm 的哈希都是
 * 「文件完整性」（下载没被篡改），不是「像素可复现证明」。本证书把四层证据
 * 分开封存，离线复核时逐层归因（references/reproducibility.md）：
 *   1. container  — 成片 mp4 本体 sha256 + 字节数（文件完整性层）
 *   2. frames     — ffmpeg -f framemd5 的逐帧 md5 序列（解码像素层，与容器/
 *                   时间戳解耦：只取每行最后一列 32-hex，dts/size 一律丢弃——
 *                   比 determinism-check 的整段 stdout 聚合更强的 mux 无关性）
 *   3. toolchain  — Node / ffmpeg / 浏览器版本（templates/plan.mjs 的
 *                   toolchainFingerprint，同一口径拆成可比字段）
 *   4. plan       — render-manifest/plan 的段哈希列表（按时间轴顺序，R2-17 键序
 *                   纪律）+ ENGINE_VERSION（产证书工具的引擎版）
 *
 * digest = sha256(canonicalJson(layers))。canonicalJson 递归键排序 + 数组顺序
 * 保留：被哈希核心里没有生成时间、没有路径、没有文件系统元数据——同一产物在
 * 另一台机重算 digest 才可比。归属信息（生成时间/源路径）单独进 meta，不在
 * digest 覆盖范围内。
 *
 * verify 的分层 verdict（诚实区分两种「不同」）：
 *   frames 同 + container 不同  → pass-with-note（mux 抖动，像素仍复现，exit 0）
 *   frames 不同 / 帧数不一致     → fail（真像素漂移，exit 13 = E_ATTEST_DRIFT）
 *   toolchain 不同（帧仍同）     → 信息非失败：不同 ffmpeg 产字节本就不同，进
 *                                  notes 并要求看帧层定夺（帧同则 pass-with-note）
 *   plan 段哈希不一致            → fail（证书与产物绑定关系断裂）
 *   plan 缺绑定证据（任一侧无 manifest/plan）→ unavailable：未检 ≠ 通过，也 ≠ 失败
 *
 * 退出码：0 pass/pass-with-note · 2 用法/输入（E_ATTEST_INPUT）·
 *         14 ffmpeg 缺失或 framemd5 提取失败（E_ATTEST_FRAMES）·
 *         13 分层复核判红（E_ATTEST_DRIFT）。零网络、零新依赖。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { toolchainFingerprint } from '../templates/plan.mjs';
import { ENGINE_VERSION } from '../templates/spec.mjs';

export const ATTEST_SCHEMA = 'cvs-attestation/v1';
export const FRAME_ALGORITHM = 'framemd5-md5column-v1';
const EXIT_USAGE = 2, EXIT_FRAMES = 14, EXIT_DRIFT = 13;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FFMPEG = process.env.FFMPEG_EXE || 'ffmpeg';

// ── 核心：canonical JSON 与 digest ──────────────────────────────────────────
/** 递归键排序、数组顺序保留的稳定序列化（R2-17 键序纪律的机器化）。 */
export function canonicalJson(v) {
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
/** 被哈希核心 = layers 本体；meta（时间/路径）不参与。 */
export function digestOf(layers) {
  return crypto.createHash('sha256').update(canonicalJson(layers)).digest('hex');
}
export function buildCertificate({ layers, meta }) {
  return { schema: ATTEST_SCHEMA, layers, digest: digestOf(layers), meta };
}

// ── 四层取证 ────────────────────────────────────────────────────────────────
export function containerLayerFromFile(p) {
  const buf = fs.readFileSync(p);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

/**
 * 解码帧层：ffmpeg -f framemd5 → 逐帧取每行最后一个 32-hex 字段（md5 列），
 * 丢掉 stream_index/dts/duration/size——像素内容寻址与时间戳、容器彻底解耦。
 * digest = sha256(md5 列逐行拼接)。失败抛 code=E_ATTEST_FRAMES。
 */
export function frameLayerFromVideo(mp4, ffmpegBin = FFMPEG) {
  const r = spawnSync(ffmpegBin,
    ['-v', 'error', '-i', mp4, '-map', '0:v:0', '-f', 'framemd5', '-'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) {
    const why = r.error ? `ffmpeg 不可用（${r.error.code || r.error.message}）` : `framemd5 提取失败：${String(r.stderr || '').trim().slice(-300)}`;
    const e = new Error(`E_ATTEST_FRAMES: ${why}（${mp4}；可设 FFMPEG_EXE 指定二进制）`);
    e.code = 'E_ATTEST_FRAMES';
    throw e;
  }
  const perFrame = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const cols = line.split(',').map((s) => s.trim()).filter(Boolean);
    if (!cols.length) continue;
    const last = cols[cols.length - 1];
    if (/^[0-9a-fA-F]{32}$/.test(last)) perFrame.push(last.toLowerCase());
  }
  if (!perFrame.length) {
    const e = new Error(`E_ATTEST_FRAMES: framemd5 未产出任何解码帧（${mp4} 无视频流或已损坏）`);
    e.code = 'E_ATTEST_FRAMES';
    throw e;
  }
  return {
    algorithm: FRAME_ALGORITHM,
    count: perFrame.length,
    digest: crypto.createHash('sha256').update(perFrame.join('\n')).digest('hex'),
    perFrame,
  };
}

export function toolchainLayer(fp = toolchainFingerprint()) {
  const m = /^node([^|]*)\|ffmpeg([^|]*)\|([\s\S]*)$/.exec(String(fp));
  return { fingerprint: String(fp), node: m ? m[1] : '', ffmpeg: m ? m[2] : '', browser: m ? m[3] : '' };
}

/**
 * 段哈希绑定层。时间轴顺序：plan.segments 优先（唯一权威顺序），manifest 键序
 * 兜底（render-batch R2-17 已保证 = 完成顺序 → 时间轴序）。status 记账来自
 * manifest，仅作记录不参与 verdict（缓存命中 vs 重渲不改像素语义）。
 */
export function planLayerFromDocs({ plan, manifest }) {
  if (!plan && !manifest) {
    return { planVersion: null, engineVersion: null, toolEngineVersion: ENGINE_VERSION, segments: [], statuses: [] };
  }
  const order = [];
  const byId = new Map();
  const push = (id) => { if (!byId.has(id)) { order.push(id); byId.set(id, { id, hash: null, frames: null }); } };
  if (plan && Array.isArray(plan.segments)) {
    for (const s of plan.segments) {
      if (!s || typeof s.id !== 'string') continue;
      push(s.id);
      const rec = byId.get(s.id);
      if (s.hash) rec.hash = String(s.hash);
      if (Number.isFinite(s.frames)) rec.frames = s.frames;
    }
  }
  if (manifest && manifest.segments && typeof manifest.segments === 'object') {
    for (const [id, rec] of Object.entries(manifest.segments)) {   // Object.entries 保键序（时间轴）
      push(id);
      const cur = byId.get(id);
      if (cur.hash == null && rec && rec.hash) cur.hash = String(rec.hash);
      if (cur.frames == null && rec && Number.isFinite(rec.expected)) cur.frames = rec.expected;
    }
  }
  const statuses = (manifest && manifest.segments)
    ? order.filter((id) => manifest.segments[id] && manifest.segments[id].status)
        .map((id) => ({ id, status: String(manifest.segments[id].status) }))
    : [];
  return {
    planVersion: plan && Number.isFinite(plan.version) ? plan.version : null,
    engineVersion: plan && plan.spec && plan.spec.engine != null ? plan.spec.engine : null,
    toolEngineVersion: ENGINE_VERSION,
    segments: order.map((id) => byId.get(id)),
    statuses,
  };
}

// ── 分层复核 ────────────────────────────────────────────────────────────────
/** @returns {{verdict, exitCode, layers, notes}} verdict: pass|pass-with-note|fail */
export function compareLayers(certLayers, freshLayers) {
  const notes = [];
  const a = certLayers || {}, b = freshLayers || {};

  const container = { status: 'unavailable', expected: null, actual: null };
  if (a.container && b.container) {
    container.expected = a.container.sha256; container.actual = b.container.sha256;
    container.bytesExpected = a.container.bytes; container.bytesActual = b.container.bytes;
    container.status = a.container.sha256 === b.container.sha256 ? 'match' : 'differ';
  }

  const frames = { status: 'unavailable', expectedCount: null, actualCount: null };
  const fa = a.frames, fb = b.frames;
  if (fa && fb) {
    frames.expectedDigest = fa.digest; frames.actualDigest = fb.digest;
    frames.expectedCount = fa.count; frames.actualCount = fb.count;
    const arrA = Array.isArray(fa.perFrame) ? fa.perFrame : null;
    const arrB = Array.isArray(fb.perFrame) ? fb.perFrame : null;
    const perEq = arrA && arrB ? (arrA.length === arrB.length && arrA.every((x, i) => x === arrB[i])) : null;
    if (fa.count !== fb.count) frames.status = 'count-mismatch';
    else if (fa.digest !== fb.digest) frames.status = 'differ';
    else if (perEq === false) { frames.status = 'differ'; notes.push('帧聚合摘要相同但逐帧 md5 序列不一致（证书帧层被局部篡改）'); }
    else frames.status = 'match';
    if (frames.status !== 'match' && arrA && arrB) {
      const n = Math.min(arrA.length, arrB.length);
      for (let i = 0; i < n; i++) {
        if (arrA[i] !== arrB[i]) { frames.firstDivergentFrame = i; break; }
      }
    }
  }

  const toolchain = { status: 'unavailable', parts: null };
  if (a.toolchain && b.toolchain) {
    const parts = {
      node: a.toolchain.node === b.toolchain.node ? 'equal' : 'differ',
      ffmpeg: a.toolchain.ffmpeg === b.toolchain.ffmpeg ? 'equal' : 'differ',
      browser: a.toolchain.browser === b.toolchain.browser ? 'equal' : 'differ',
    };
    toolchain.parts = parts;
    toolchain.status = Object.values(parts).every((s) => s === 'equal') ? 'equal' : 'differ';
    toolchain.expectedFingerprint = a.toolchain.fingerprint;
    toolchain.actualFingerprint = b.toolchain.fingerprint;
  }

  const plan = { status: 'unavailable' };
  if (a.plan && b.plan && (a.plan.segments || []).length && (b.plan.segments || []).length) {
    const sa = a.plan.segments || [], sb = b.plan.segments || [];
    const same = canonicalJson(sa) === canonicalJson(sb);
    plan.expectedSegments = sa.length; plan.actualSegments = sb.length;
    if (same) plan.status = 'match';
    else {
      plan.status = 'differ';
      const ids = new Set([...sa.map((s) => s.id), ...sb.map((s) => s.id)]);
      const ma = new Map(sa.map((s) => [s.id, s])), mb = new Map(sb.map((s) => [s.id, s]));
      plan.differingSegments = [...ids].filter((id) => canonicalJson(ma.get(id)) !== canonicalJson(mb.get(id)));
      const sameContents = canonicalJson([...sa].sort((x, y) => String(x.id).localeCompare(String(y.id))))
        === canonicalJson([...sb].sort((x, y) => String(x.id).localeCompare(String(y.id))));
      if (sameContents) plan.note = '段集合相同但时间轴顺序不一致';
    }
    if (a.plan.engineVersion != null && b.plan.engineVersion != null && a.plan.engineVersion !== b.plan.engineVersion) {
      notes.push(`plan.spec.engine 不同：证书 ${a.plan.engineVersion} vs 本机 ${b.plan.engineVersion}`);
    }
  } else {
    notes.push('plan 绑定证据不全（任一侧缺 render-manifest.json/plan.json）：段哈希未复核 —— 未检 ≠ 通过');
  }

  const fail = frames.status === 'differ' || frames.status === 'count-mismatch'
    || plan.status === 'differ' || frames.status === 'unavailable';
  const noted = container.status === 'differ' || toolchain.status === 'differ' || plan.status === 'unavailable';
  if (container.status === 'differ' && frames.status === 'match') {
    notes.push('mux 抖动：容器字节不同而解码帧全同 → 像素可复现成立，文件完整性层不等价');
  }
  if (toolchain.status === 'differ') {
    notes.push('跨机工具链不同（node/ffmpeg/browser 见 parts）：不同编码器产字节本就不同——这是信息；只有帧层同时变化才是失败');
  }
  const verdict = fail ? 'fail' : noted ? 'pass-with-note' : 'pass';
  return { verdict, exitCode: fail ? EXIT_DRIFT : 0, layers: { container, frames, toolchain, plan }, notes };
}

// ── 组装（CLI 与未来 MCP 内核直调共用） ─────────────────────────────────────
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function cvsVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
}

/**
 * 产证书。opts: { manifestPath?, planPath?, ffmpegBin? }；manifest/plan 缺省时
 * 自动找 <mp4 目录>/render-manifest.json、<mp4 目录>/plan.json。
 * @returns {{cert, warnings: string[]}}
 */
export function attestVideo(mp4, opts = {}) {
  const warnings = [];
  const dir = path.dirname(path.resolve(mp4));
  const manifestPath = opts.manifestPath || (fs.existsSync(path.join(dir, 'render-manifest.json')) ? path.join(dir, 'render-manifest.json') : null);
  const planPath = opts.planPath || (fs.existsSync(path.join(dir, 'plan.json')) ? path.join(dir, 'plan.json') : null);
  const manifest = manifestPath ? readJsonSafe(manifestPath) : null;
  const plan = planPath ? readJsonSafe(planPath) : null;
  if (!manifest && !plan) warnings.push('未找到 render-manifest.json/plan.json：证书不含段哈希绑定（verify 端 plan 层将记 unavailable）');
  if (manifestPath && !manifest) warnings.push(`manifest 不可解析，忽略：${manifestPath}`);
  if (planPath && !plan) warnings.push(`plan 不可解析，忽略：${planPath}`);
  const layers = {
    container: containerLayerFromFile(mp4),
    frames: frameLayerFromVideo(mp4, opts.ffmpegBin || FFMPEG),
    toolchain: toolchainLayer(),
    plan: planLayerFromDocs({ plan, manifest }),
  };
  const cert = buildCertificate({
    layers,
    meta: {
      generatedAt: new Date().toISOString(),
      cvsVersion: cvsVersion(),
      source: {
        mp4: path.resolve(mp4),
        manifest: manifestPath || null,
        plan: planPath || null,
      },
    },
  });
  return { cert, warnings, manifestPath, planPath };
}

/** 复核：cert 为已解析 attestation 文档（会先做自摘要校验）。 */
export function verifyVideo(mp4, cert, opts = {}) {
  const fresh = attestVideo(mp4, opts).cert;
  const report = compareLayers(cert.layers, fresh.layers);
  report.selfDigestOk = typeof cert.digest === 'string' && cert.digest === digestOf(cert.layers);
  if (!report.selfDigestOk) {
    report.verdict = 'fail';
    report.exitCode = EXIT_DRIFT;
    report.notes.unshift('attestation 自摘要校验失败：layers 与 digest 不一致（证书本体被篡改或字段损坏）');
  }
  return { report, fresh };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const HELP = `cvs attest — 产物哈希证书 + 跨机重放验证器（G9）

usage: node scripts/attest.mjs <out.mp4> [options]
       node scripts/attest.mjs <out.mp4> --verify <attestation.json> [options]

产证书（默认）：读段级 render-manifest.json（自动找 <mp4 目录>/，--manifest 覆盖）
  + plan.json（--plan 覆盖），连同容器 sha256、framemd5 逐帧摘要、toolchain 指纹
  封成内容寻址 attestation.json；核心 digest 不含时间戳/路径，跨机重算可比。
复核（--verify）：对另一台机/另一份成片离线逐层比对，输出分层 verdict。

options:
  --verify <file>     已有 attestation.json → 复核模式（分层 verdict）
  --manifest <file>   指定 render-manifest.json（段哈希/状态来源）
  --plan <file>       指定 plan.json（段哈希权威顺序）
  --out <file>        证书输出路径（默认 <mp4 同名>.attestation.json）
  --json              仅向 stdout 输出机器可读 JSON（人机信息 → stderr）
  --help              本帮助

verdict 语义：pass（四层全同）· pass-with-note（帧同但容器/工具链不同或绑定证据
  不全——mux 抖动像素仍复现）· fail（帧层漂移 / 帧数不一致 / plan 段哈希不一致 /
  证书自摘要损坏）。
退出码：0 pass|pass-with-note · 2 用法/输入 E_ATTEST_INPUT · 14 ffmpeg E_ATTEST_FRAMES ·
  13 复核判红 E_ATTEST_DRIFT。环境变量 FFMPEG_EXE 指定 ffmpeg。`;

const VALUE_FLAGS = new Set(['verify', 'manifest', 'plan', 'out']);
function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(t.slice(2)) && next !== undefined && !next.startsWith('--')) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

function usageFail(msg) {
  console.error(`[error] [E_ATTEST_INPUT] ${msg}`);
  process.exit(EXIT_USAGE);
}

function main() {
  const argv = process.argv.slice(2);
  const { args, unknown } = parseStrict(argv, new Set([...VALUE_FLAGS, 'json', 'help']));
  if (unknown.length) rejectUnknown('cvs attest', unknown, new Set([...VALUE_FLAGS, 'json', 'help']));
  if (args.help) { console.log(HELP); process.exit(0); }

  const pos = positionals(argv);
  if (pos.length !== 1) usageFail(`需要且仅需要一个成片路径：cvs attest <out.mp4> [--verify <attestation.json>]（--help）`);
  const mp4 = pos[0];
  let st = null;
  try { st = fs.statSync(mp4); } catch { /* null */ }
  if (!st || !st.isFile()) usageFail(`成片文件不存在或不可读：${mp4}`);

  const opts = {};
  if (args.manifest) {
    if (!fs.existsSync(String(args.manifest))) usageFail(`--manifest 不存在：${args.manifest}`);
    opts.manifestPath = String(args.manifest);
  }
  if (args.plan) {
    if (!fs.existsSync(String(args.plan))) usageFail(`--plan 不存在：${args.plan}`);
    opts.planPath = String(args.plan);
  }

  try {
    if (args.verify) {
      const certPath = String(args.verify);
      const cert = readJsonSafe(certPath);
      if (!cert || !cert.layers || typeof cert.layers !== 'object') usageFail(`--verify 不是可解析的 attestation.json：${certPath}`);
      if (cert.schema !== ATTEST_SCHEMA) usageFail(`attestation schema 不识别：${cert.schema}（期望 ${ATTEST_SCHEMA}）`);
      const { report } = verifyVideo(mp4, cert, opts);
      if (args.json) {
        process.stdout.write(`${JSON.stringify({ ok: report.verdict !== 'fail', mode: 'verify', ...report, mp4: path.resolve(mp4), cert: path.resolve(certPath) })}\n`);
      } else {
        console.log(`[attest] verify ${path.resolve(mp4)}  vs  ${certPath}`);
        const L = report.layers;
        console.log(`  container  ${L.container.status}${L.container.status === 'differ' ? '（字节级完整性不同）' : ''}`);
        console.log(`  frames     ${L.frames.status}  期望 ${L.frames.expectedCount} 帧 / 实测 ${L.frames.actualCount} 帧${L.frames.firstDivergentFrame != null ? ` / 首个漂移帧 #${L.frames.firstDivergentFrame}` : ''}`);
        console.log(`  toolchain  ${L.toolchain.status}${L.toolchain.parts ? `  node=${L.toolchain.parts.node} ffmpeg=${L.toolchain.parts.ffmpeg} browser=${L.toolchain.parts.browser}` : ''}`);
        console.log(`  plan       ${L.plan.status}${L.plan.differingSegments ? `  不一致段：${L.plan.differingSegments.join(',')}` : ''}`);
        for (const n of report.notes) console.log(`  note: ${n}`);
        console.log(`[attest] verdict=${report.verdict} exit=${report.exitCode}${report.selfDigestOk ? '' : '  [证书自摘要校验失败]'}`);
      }
      process.exit(report.exitCode);
    }

    const { cert, warnings } = attestVideo(mp4, opts);
    const outPath = args.out
      ? path.resolve(String(args.out))
      : path.join(path.dirname(path.resolve(mp4)), `${path.basename(mp4, path.extname(mp4))}.attestation.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(cert, null, 2)}\n`);
    if (args.json) {
      process.stdout.write(`${JSON.stringify({
        ok: true, mode: 'attest', schema: ATTEST_SCHEMA, digest: cert.digest, outPath,
        layers: {
          container: cert.layers.container.sha256,
          frames: { count: cert.layers.frames.count, digest: cert.layers.frames.digest, algorithm: cert.layers.frames.algorithm },
          toolchain: cert.layers.toolchain.fingerprint,
          plan: { segments: cert.layers.plan.segments.length, engineVersion: cert.layers.plan.engineVersion, toolEngineVersion: cert.layers.plan.toolEngineVersion },
        },
        warnings,
      })}\n`);
    } else {
      const L = cert.layers;
      console.log(`[attest] ${path.resolve(mp4)}`);
      console.log(`  container  sha256=${L.container.sha256.slice(0, 16)}…  ${(L.container.bytes / 1024).toFixed(1)} KB`);
      console.log(`  frames     ${L.frames.count} 帧  ${L.frames.algorithm}  digest=${L.frames.digest.slice(0, 16)}…`);
      console.log(`  toolchain  ${L.toolchain.fingerprint}`);
      console.log(`  plan       ${L.plan.segments.length ? `${L.plan.segments.length} 段绑定（engine ${L.plan.engineVersion ?? '?'}，工具引擎 v${L.plan.toolEngineVersion}）` : `未绑定（仅记工具引擎 v${L.plan.toolEngineVersion}）`}`);
      console.log(`  digest     ${cert.digest}`);
      for (const w of warnings) console.error(`[warn] ${w}`);
      console.log(`[attest] 证书已写入 ${outPath}`);
    }
    process.exit(0);
  } catch (e) {
    if (e.code === 'E_ATTEST_FRAMES') { console.error(`[error] [E_ATTEST_FRAMES] ${e.message.replace(/^E_ATTEST_FRAMES:\s*/, '')}`); process.exit(EXIT_FRAMES); }
    // 与 plan.mjs 同口径：未归类的写盘/权限等异常是崩溃（exit 1），不得伪装成 ffmpeg 取证失败。
    console.error('[fatal]', e.stack || e);
    process.exit(1);
  }
}

// 与 templates/plan.mjs 同款防呆：被 import（MCP/测试）时不得跑 CLI。
const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === 'attest.mjs';
if (invokedDirectly) main();
