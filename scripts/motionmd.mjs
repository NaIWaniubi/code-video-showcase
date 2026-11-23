#!/usr/bin/env node
/**
 * motionmd.mjs — G10/S3-4 spec⇄Motion.md 互转（builder 第三棒，2026-11-24）。
 *
 *   node scripts/motionmd.mjs <spec.json> [--out Motion.md]   spec → 五维 markdown
 *   node scripts/motionmd.mjs --parse <Motion.md> [--json]    markdown → spec patch 建议
 *
 * 五维（hook / shot / pacing / type / sound）借 OpenMotion rubric 的名目，模板文本
 * **自写**（不引入其实现、零新依赖）：每个字段都从现有 spec 已归一字段派生；给了
 * plan.json（outDir 下能找到）就加 shot 明细与 stats，找不到只用 spec。
 *
 * --parse 只产**建议**（[{path,value,reason,source}]），绝不写回 spec——
 * 导入 = 人（或 agent）拿着建议去改 spec，改完仍走 lint/plan 门禁。
 * 非法值（motion 不在四档、accent 不是 #hex、数值非有限）进 warnings 不进建议。
 *
 * 退出码：0 ok；2 用法/未知旗标；10 spec/md 不可读。
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSpec, specDuration } from '../templates/spec.mjs';
import { MOTION_LEVELS, deriveMotionProfile } from '../templates/motion-profile.mjs';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';

const PROG = 'node scripts/motionmd.mjs';
const DIMS = ['hook', 'shot', 'pacing', 'type', 'sound'];

/** bullet key → spec 路径 + 值类型（parse 的映射表，单一真值）。 */
const KEY_MAP = {
  'hook.opening': { path: 'structure.opening', kind: 'number', reason: 'Motion.md hook.opening → 开场秒数' },
  'pacing.total': { path: 'format.duration', kind: 'number', reason: 'Motion.md pacing.total → 目标总时长（秒）' },
  'pacing.bpm': { path: 'audio.bpm', kind: 'number', reason: 'Motion.md pacing.bpm → 拍速' },
  'type.theme': { path: 'look.theme', kind: 'string', reason: 'Motion.md type.theme → 主题 id' },
  'type.motion': { path: 'look.motion', kind: 'motion', reason: 'Motion.md type.motion → 动效档位' },
  'type.accent': { path: 'look.accentOverride', kind: 'hex', reason: 'Motion.md type.accent → 强调色覆盖' },
  'sound.mood': { path: 'audio.mood', kind: 'string', reason: 'Motion.md sound.mood → 配乐情绪' },
};

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? +n.toFixed(3) : null;
}

/**
 * spec → 五维 Motion.md 文本（纯函数；plan 可选，来自 buildPlanFromSpec().plan
 * 或 out/plan.json 的原样对象，只用其 stats/segments 现成字段）。
 */
export function specToMotionMarkdown(rawSpec, { plan = null } = {}) {
  const spec = normalizeSpec(rawSpec);
  const duration = num(specDuration(spec)) ?? specDuration(spec);
  const motion = MOTION_LEVELS.includes(spec.look?.motion)
    ? spec.look.motion
    : deriveMotionProfile({ kind: spec.meta?.kind, style: spec.look?.style });
  const accent = spec.look?.accentOverride
    ? (typeof spec.look.accentOverride === 'string' ? spec.look.accentOverride : JSON.stringify(spec.look.accentOverride))
    : 'none';
  const flash = spec.structure?.flash || {};
  const vo = Array.isArray(spec.audio?.vo) ? spec.audio.vo : [];
  const L = [];
  L.push(`# Motion.md — ${spec.meta?.name || 'untitled'}`);
  L.push('');
  L.push('> 由 `cvs motionmd` 从 project.spec.json 派生（五维 rubric：hook/shot/pacing/type/sound，模板自写）。');
  L.push('> 这是**文档视图**，不是第二真相源：改片仍改 spec；`cvs motionmd --parse` 读本文件产出的是 spec patch 建议，不直改。');
  L.push('');
  L.push('## hook（开场钩子）');
  L.push(`- opening: ${spec.structure?.opening}`);
  L.push(`- headline: "${String(spec.meta?.title || spec.opening?.title || '').trim()}"`);
  L.push(`- cta: "${String(spec.meta?.cta || '').trim()}"`);
  L.push(`- brand: "${String(spec.meta?.brand || '').trim()}"`);
  L.push('');
  L.push('## shot（镜头结构）');
  L.push(`- rounds: ${spec.rounds.length}`);
  L.push(`- card: ${spec.structure?.card}`);
  L.push(`- round: ${spec.structure?.round}`);
  L.push(`- ending: ${spec.structure?.ending}`);
  L.push(`- transition: ${spec.render?.transition || 'cut'}`);
  if (plan && Array.isArray(plan.segments)) {
    L.push(`- segments: ${plan.segments.length}`);
    for (const s of plan.segments) {
      const fps = Number(plan.meta?.fps) || 30;
      L.push(`- shot ${s.id}: kind=${s.kind} start=${num((s.startFrame || 0) / fps)}s dur=${num((s.frames || 0) / fps)}s`);
    }
  }
  L.push('');
  L.push('## pacing（节奏）');
  L.push(`- total: ${duration}`);
  L.push(`- bpm: ${spec.audio?.bpm}`);
  L.push(`- flash: ${flash.count || 0} x ${flash.each || 0}s`);
  if (plan && plan.stats && Number.isFinite(plan.stats.duration) && spec.rounds.length) {
    const avg = plan.stats.duration / spec.rounds.length;
    L.push(`- avg-round: ${num(avg)}s`);
  }
  L.push('');
  L.push('## type（字体与画面）');
  L.push(`- theme: ${spec.look?.theme}`);
  L.push(`- style: ${spec.look?.style ?? 'none'}`);
  L.push(`- motion: ${motion}`);
  L.push(`- accent: ${accent}`);
  L.push('');
  L.push('## sound（声音）');
  L.push(`- mood: ${spec.audio?.mood}`);
  L.push(`- vo: ${vo.length} lines`);
  L.push(`- captions: ${vo.some((v) => v && Array.isArray(v.words) && v.words.length) ? 'word-level' : 'none'}`);
  L.push('');
  return L.join('\n');
}

/**
 * Motion.md → spec patch 建议（纯函数，绝不触碰 spec）。
 * @returns {{suggestions: Array<{path,value,reason,source}>, warnings: string[], ignored: string[]}}
 */
export function parseMotionMarkdown(md) {
  const suggestions = [];
  const warnings = [];
  const ignored = [];
  let section = null;
  for (const rawLine of String(md || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const h = line.match(/^##\s+([A-Za-z][\w-]*)/);
    if (h) {
      section = h[1].toLowerCase();
      if (!DIMS.includes(section)) { ignored.push(`section:${section}`); section = null; }
      continue;
    }
    if (!section) continue;
    const b = line.match(/^-\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!b) continue;
    const key = `${section}.${b[1]}`;
    const rawVal = b[2].trim().replace(/^"(.*)"$/, '$1');
    const map = KEY_MAP[key];
    if (!map) { ignored.push(key); continue; }
    if (rawVal === '' ) { warnings.push(`${key}: 空值，跳过`); continue; }
    if (map.kind === 'number') {
      const n = Number(rawVal);
      if (!Number.isFinite(n)) { warnings.push(`${key}: "${rawVal}" 不是有限数，不产建议`); continue; }
      suggestions.push({ path: map.path, value: n, reason: map.reason, source: key });
    } else if (map.kind === 'motion') {
      if (rawVal === 'none' || rawVal === 'null') continue;   // 显式回退推导：无需建议
      if (!MOTION_LEVELS.includes(rawVal)) { warnings.push(`${key}: "${rawVal}" 不在 ${MOTION_LEVELS.join('|')}，不产建议`); continue; }
      suggestions.push({ path: map.path, value: rawVal, reason: map.reason, source: key });
    } else if (map.kind === 'hex') {
      if (rawVal === 'none' || rawVal === 'null') continue;
      if (!HEX_RE.test(rawVal)) { warnings.push(`${key}: "${rawVal}" 不是 #hex，不产建议`); continue; }
      suggestions.push({ path: map.path, value: rawVal, reason: map.reason, source: key });
    } else {
      if (rawVal === 'none' || rawVal === 'null') continue;
      suggestions.push({ path: map.path, value: rawVal, reason: map.reason, source: key });
    }
  }
  return { suggestions, warnings, ignored };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const KNOWN = new Set(['out', 'json', 'parse', 'root', 'help']);

function main() {
  const { args, unknown } = parseStrict(process.argv.slice(2), KNOWN);
  if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);
  if (args.help) {
    console.log(`Usage: node scripts/motionmd.mjs <spec.json> [--out Motion.md] [options]
  <spec.json>           project spec（五维从其现有字段派生）
  --out <f.md>          写文件（缺省打印到 stdout）
  --parse <Motion.md>   反向：markdown → spec patch **建议**（只读，不写 spec）
  --root <dir>          找 plan.json 富化 shot 明细的根（默认 cwd；找不到只用 spec）
  --json                parse 模式输出一行 JSON {suggestions,warnings,ignored}
  退出码：0 ok；2 用法；10 输入不可读`);
    process.exit(0);
  }
  if (args.parse) {
    const mdPath = path.resolve(String(args.parse));
    let md;
    try { md = fs.readFileSync(mdPath, 'utf8'); }
    catch (e) { console.error(`[error] [E_READ] cannot read Motion.md ${mdPath}: ${e.message}`); process.exit(10); }
    const { suggestions, warnings, ignored } = parseMotionMarkdown(md);
    if (args.json) { process.stdout.write(JSON.stringify({ file: mdPath, suggestions, warnings, ignored }) + '\n'); return; }
    console.error(`[motionmd] ${mdPath} → ${suggestions.length} 条建议（不写 spec；确认后再改）`);
    for (const s of suggestions) console.log(`  ${s.path} = ${JSON.stringify(s.value)}   (${s.source})`);
    for (const w of warnings) console.error(`[warn] ${w}`);
    if (ignored.length) console.error(`[info] 未映射: ${ignored.join(', ')}`);
    return;
  }
  // spec = 第一个非 -- 且不属于已消耗旗标值的裸参数。
  const specArg = (() => {
    const argvRaw = process.argv.slice(2);
    for (let i = 0; i < argvRaw.length; i++) {
      const t = String(argvRaw[i]);
      if (t.startsWith('--')) {
        if (['--out', '--parse', '--root'].includes(t)) i++;   // 跳过其值
        continue;
      }
      return t;
    }
    return null;
  })();
  if (!specArg) {
    console.error('usage: node scripts/motionmd.mjs <spec.json> [--out f.md] | --parse <f.md> [--json]  (see --help)');
    process.exit(2);
  }
  const specPath = path.resolve(String(specArg));
  let raw;
  try { raw = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
  catch (e) { console.error(`[error] [E_READ] cannot read/parse spec ${specPath}: ${e.message}`); process.exit(10); }
  let plan = null;
  try {
    const root = path.resolve(String(args.root || process.cwd()));
    const spec0 = normalizeSpec(raw);
    const planPath = path.join(root, spec0.render?.outDir || 'out', 'plan.json');
    if (fs.existsSync(planPath)) plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch { /* plan 是富化，不是必需 */ }
  const md = specToMotionMarkdown(raw, { plan });
  if (args.out) {
    const outPath = path.resolve(String(args.out));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, md);
    console.error(`[motionmd] ${specPath} → ${outPath}（五维：${DIMS.join('/')}）${plan ? '' : '；未找到 plan.json，仅 spec 派生'}`);
  } else {
    process.stdout.write(md);
  }
}

const invokedDirectly = process.argv[1] && path.basename(process.argv[1]) === 'motionmd.mjs';
if (invokedDirectly) {
  try { main(); } catch (e) { console.error('[fatal]', e.stack || e); process.exit(1); }
}
