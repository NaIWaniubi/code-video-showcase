#!/usr/bin/env node
/**
 * timeline.mjs — one declarative timeline → validated plan → render commands.
 *
 * The timeline JSON is the single source of truth for structure, durations,
 * frame counts, cue points and output paths. The renderer, audio QA and concat
 * step all read the generated plan instead of re-deriving the 8 + 11×4 + 1 + 2 + 6
 * formula in five different scripts (a class of bug Remotion/Editly solve with a
 * composition + render plan).
 *
 *   node templates/timeline.mjs --spec timeline.json \
 *        --out out/plan.json --concat out/segments.txt --print
 *
 *   node templates/timeline.mjs --spec timeline.json --check    # CI gate
 *
 * Segment mode is preserved: every style segment still renders through
 * render-segment.mjs with ?seg=1&t0=&speed=&dur= appended.
 *
 * Schema (all durations in seconds):
 * {
 *   "version": 1,
 *   "meta": { "title": "...", "brand": "{{BRAND}}", "theme": "coral-noir",
 *             "bpm": 120, "fps": 30, "width": 1920, "height": 1080,
 *             "outDir": "out" },
 *   "structure": { "opening": 8, "round": 4, "card": 1, "ending": 6,
 *                  "moreCard": 1, "flash": { "count": 8, "each": 0.25 } },
 *   "opening": { "page": "segments/00-opening.html" },
 *   "rounds": [{ "id": "r01", "name": "扁平插画科普",
 *                "card":  { "page": "segments/big-card.html", "layout": 0, "first": "想做", "keyword": "科普视频？", "color": "#ffcf5c" },
 *                "style": { "page": "segments/01.html", "t0": 0.35, "speed": 1.4 } }],
 *   "moreCard": { "page": "segments/big-card.html", "first": "还有", "keyword": "更多？" },
 *   "flash":    { "page": "segments/flash.html" },
 *   "ending":   { "page": "segments/99-ending.html" }
 * }
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildPlan, validateComposition, totalDuration, formatPlan } from './timeline-core.mjs';

// 纯函数（query / buildPlan / formatPlan …）在 timeline-core.mjs：浏览器可以直接
// import spec.mjs，这条链不会碰到 node:fs / node:path。本文件只留 Node 侧：
// concat 清单（需要 path 解析）与 CLI。
export * from './timeline-core.mjs';

/**
 * concat-demuxer 文本。
 *
 * 默认写绝对路径（便于任意 cwd 手动调试）；`baseDir` 指定时改写为相对该目录的
 * 安全路径，配合 `ffmpeg -f concat -safe 1` 使用：没有绝对路径、没有 `..`、
 * 没有盘符/UNC，清单里的一行无法把 ffmpeg 引到项目外。
 */
export function concatList(plan, { absolute = true, baseDir = null } = {}) {
  const root = plan.meta.root;
  return plan.segments.map((s) => {
    if (baseDir) {
      const abs = path.resolve(root, s.out);
      let rel = path.relative(path.resolve(baseDir), abs);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error(`concatList: segment ${s.id} is outside baseDir (${abs})`);
      }
      rel = rel.split(path.sep).join('/');
      if (rel.includes("'") || rel.includes('\n') || rel.includes('\r') || /^[A-Za-z]:/.test(rel)) {
        throw new Error(`concatList: unsafe segment path for concat: ${rel}`);
      }
      return `file '${rel}'`;
    }
    const f = absolute ? path.resolve(root, s.out).replace(/\\/g, '/') : s.out;
    // 绝对模式也要挡换行：否则 s.out 里的 \n 会往 concat 清单注入额外行。
    if (/[\n\r]/.test(f)) throw new Error(`concatList: segment path contains a newline: ${s.id}`);
    return `file '${f.replace(/'/g, "'\\''")}'`;
  }).join('\n') + '\n';
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) a[k.slice(2)] = true;
    else { a[k.slice(2)] = next; i++; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.spec) {
    console.log(`Usage: node templates/timeline.mjs --spec <timeline.json> [options]
  --out <plan.json>      write the render plan (default: <outDir>/plan.json)
  --concat <list.txt>    write the ffmpeg concat list (default: <outDir>/segments.txt)
  --root <dir>           project root used to resolve pages/outputs (default: spec dir or cwd)
  --outdir <dir>         override meta.outDir
  --check                validate only; exit 1 on errors
  --print                print the segment table
  --json                 print the plan JSON to stdout`);
    process.exit(args.help ? 0 : 1);
  }

  const specPath = path.resolve(String(args.spec));
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const root = path.resolve(String(args.root || spec.meta?.root || process.cwd()));
  const outDir = args.outdir ? String(args.outdir) : spec.meta?.outDir;

  if (args.check) {
    const { errors, warnings } = validateComposition(spec);
    for (const w of warnings) console.log(`[warn] ${w}`);
    for (const e of errors) console.error(`[error] ${e}`);
    if (errors.length) process.exit(1);
    const total = totalDuration(spec);
    console.log(`✓ timeline valid: ${spec.rounds.length} rounds, ${total}s @ ${spec.meta?.fps ?? 30}fps`);
    return;
  }

  let plan;
  try {
    plan = buildPlan(spec, { root, outDir });
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  for (const w of validateComposition(spec).warnings) console.error(`[warn] ${w}`);

  const planPath = path.resolve(String(args.out || path.join(root, plan.meta.outDir, 'plan.json')));
  const concatPath = path.resolve(String(args.concat || path.join(root, plan.meta.outDir, 'segments.txt')));
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.mkdirSync(path.dirname(concatPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  fs.writeFileSync(concatPath, concatList(plan));

  if (args.print) console.log(formatPlan(plan));
  if (args.json) console.log(JSON.stringify(plan, null, 2));
  console.log(`[plan]  ${planPath}`);
  console.log(`[concat] ${concatPath}`);
  console.log(`[stats] ${plan.stats.duration.toFixed(3)}s / ${plan.stats.frames} frames / ${plan.stats.segments} segments`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('timeline.mjs')) {
  main().catch((e) => { console.error('[fatal]', e.stack || e); process.exit(1); });
}
