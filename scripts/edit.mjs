#!/usr/bin/env node
/**
 * edit.mjs — `cvs edit <spec> [actions]`：agent 向的终端剪辑入口（R15）。
 *
 *   cvs edit project.spec.json                       # 看当前结构摘要
 *   cvs edit project.spec.json --split-at=10         # 在第 10s 拆分所在轮（a/b）
 *   cvs edit project.spec.json --drop=r01            # 丢一轮
 *   cvs edit project.spec.json --move=r02:1          # r02 移到第 1 位
 *   cvs edit project.spec.json --trim=35             # 全片重拟合到 35s
 *   cvs edit ... --dry-run                           # 只验证不落盘（默认安全行为）
 *   cvs edit ... --apply                             # 确实改盘
 *   cvs edit ... --edl out.edl --otio out.json       # 导出行业交换格式（人读+机读同源）
 *
 * 为什么 agent 适配：OpenTimelineIO 把时间线做成数据，任何工具都能读写——本入口
 * 的每次输出仍是闭合结构的 spec；EDL/OTIO 让外部剪辑软件也能打开这条时间线。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import {
  splitAtSeconds, dropRound, moveRound, trimToSeconds, layoutSeconds, suggestedCuts,
} from './lib/spec-edit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROG = 'node scripts/edit.mjs';
const KNOWN = new Set(['spec', 'split-at', 'drop', 'move', 'trim', 'edl',
  'otio', 'dry-run', 'apply', 'json', 'suggest', 'help']);
// --key=value 与 --key value 两种写法都收（agent 从 shell 直接拼参数最顺手）。
const argv = process.argv.slice(2).map((a) => {
  const m = /^--([A-Za-z0-9-]+)=(.*)$/.exec(a);
  return m ? [`--${m[1]}`, m[2]] : a;
}).flat();
const positional = argv.filter((a) => !String(a).startsWith('--'));
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);

if (args.help || !positional.length) {
  console.log(`Usage: node scripts/edit.mjs <spec.json> [options]
  <spec.json>            project spec
  --split-at=<sec>       split the round containing that second into a/b
  --drop=<roundId>       drop that round entirely
  --move=<roundId>:<pos> move it to position (1-based)
  --trim=<sec>           refit the whole film to that length
  --dry-run              verify without writing (default; write with --apply)
  --edl <file>           export an EDL (CMX interchange) timeline
  --otio <file>          export an OpenTimelineIO JSON timeline
  --suggest              print the suggested cut points (same as /frames/api/suggestions)
  --json                 one-line JSON on stdout, human text to stderr`);
  process.exit(args.help ? 0 : 2);
}

const specPath = path.resolve(process.cwd(), String(positional[0]));
let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
catch (e) { console.error(`[error] [E_READ] cannot read/parse spec ${specPath}: ${e.message}`); process.exit(10); }

let result;
try {
  if (args['split-at'] != null) spec = splitAtSeconds(spec, Number(args['split-at']));
  if (args.drop != null) spec = dropRound(spec, String(args.drop));
  if (args['move'] != null) {
    const m = /^([^:]+):(\d+)$/.exec(String(args.move));
    if (!m) throw new Error(`move: --move expects roundId:position, got "${args.move}"`);
    spec = moveRound(spec, m[1], Number(m[2]));
  }
  if (args.trim != null) spec = trimToSeconds(spec, Number(args.trim));
  result = { applied: Boolean(args['split-at'] != null || args.drop || args['move'] || args.trim) };
} catch (e) {
  // 参数类错误（轮 id 不存在/时刻越界/目标过短）→ 2 usage；其余结构异常 → 13。
  // agent 据退出码即可判断「改参数重试」还是「换路线」，不靠解析人读文本。
  const msg = String(e.message || e);
  const usage = /^(split|drop|move|trim):/.test(msg);
  console.error(`[error] [${usage ? 'E_EDIT_USAGE' : 'E_EDIT'}] ${msg}`);
  process.exit(usage ? 2 : 13);
}

// ── 摘要 ────────────────────────────────────────────────────
const lay = layoutSeconds(spec);
console.error(`# ${spec.meta?.title || spec.meta?.name || path.basename(specPath)} · D=${lay.total.toFixed(1)}s @ ${spec.format?.fps || 30}fps`);
for (const row of lay.rows) {
  const mark = row.kind === 'flash' ? '*' : ' ';
  console.error(`${mark} ${row.id.padEnd(16)} ${(row.start).toFixed(2).padStart(6)}–${(row.end).toFixed(2).padStart(6)}  ${row.kind}${row.note ? ` · ${row.note}` : ''}`);
}

// R17-W：agent 建议层（与 GET /frames/api/suggestions 同口径——内核单一真值 suggestedCuts）。
let cuts = [];
if (args.suggest) {
  cuts = suggestedCuts(spec).cuts;
  console.error('suggested cuts:');
  for (const c of cuts) {
    console.error(`  ${c.at.toFixed(2).padStart(6)}s  ${c.after} → ${c.before}  (${c.kind})`);
  }
}

// ── 交换格式导出 ──────────────────────────────────────────
const tc = (sec, fps) => {
  const f = Math.min(fps - 1, Math.max(0, Math.round((sec % 1) * fps)));
  const tot = Math.floor(sec);
  const h = Math.floor(tot / 3600), m = Math.floor((tot % 3600) / 60), s = tot % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
};
if (args.edl) {
  const lines = [`TITLE: ${spec.meta?.name || path.basename(specPath)}`, 'FCM: NON-DROP-frame', ''];
  let ev = 1;
  for (const row of lay.rows) {
    lines.push(`${String(ev++).padStart(3, '0')}  AX       V     C        ${tc(row.start, spec.format?.fps || 30)} ${tc(row.end, spec.format?.fps || 30)} ${tc(row.start, spec.format?.fps || 30)} ${tc(row.end, spec.format?.fps || 30)}`);
  }
  const out = path.resolve(process.cwd(), String(args.edl));
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.error(`[export] EDL ${lay.rows.length} events -> ${out}`);
}
if (args.otio) {
  const otio = {
    OTIO_VERSION: '0.15.0',
    metadata: { title: spec.meta?.title || spec.meta?.name || null, source: 'code-video-showcase' },
    name: path.basename(specPath),
    tracks: [{
      name: 'Video', kind: 'Video',
      children: lay.rows.map((row) => ({
        schema_name: 'Clip',
        name: row.id,
        source_range: { start_time: row.start, duration: row.end - row.start },
        target_range: null,
        metadata: { frame_rate: spec.format?.fps || 30, kind: row.kind },
      })),
    }],
  };
  const out = path.resolve(process.cwd(), String(args.otio));
  fs.writeFileSync(out, JSON.stringify(otio, null, 2) + '\n');
  console.error(`[export] OpenTimelineIO ${lay.rows.length} clips -> ${out}`);
}

// ── 验证与落盘 ────────────────────────────────────────────
const apply = !!args.apply;
let lintExit = null;
if (result.applied) {
  // dry-run（默认）：临时文件过 lint 子进程，只验证不落盘；--apply：同目录临时件过
  // lint 后原子改名写回原文件（v4.2.1 审查发现：旧版写到固定名 project.spec.json，
  // 原文件原地未动，--apply 名存实亡）。
  const dir = apply ? path.dirname(specPath) : fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-edit-'));
  const tmpName = `spec-${process.pid}.tmp`;
  const tmp = path.join(dir, tmpName);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(spec, null, 2));
  const lr = spawnSync(process.execPath, ['bin/cvs.mjs', 'lint', tmp, '--root', ROOT],
    { cwd: ROOT, encoding: 'utf8' });
  lintExit = lr.status ?? 1;
  if (lintExit !== 0) {
    console.error(`[edit] ✗ lint 未过（exit ${lr.status}）——改动已撤销，不落盘`);
    console.error([...(lr.stderr || '').split('\n'), ...(lr.stdout || '').split('\n')].filter((l) => /\S/.test(l)).slice(0, 8).join('\n'));
    try { fs.rmSync(tmp); } catch { /* ignore */ }
    process.exit(13);
  }
  console.error('[edit] ✓ lint 通过');
  if (!apply) { try { fs.rmSync(tmp); } catch { /* ignore */ } }
  else {
    // R18-W：写回安全——先备份原 spec（失败即中止，E_BACKUP），再临时件原子改名覆盖。
    if (fs.existsSync(specPath)) {
      const bak = specPath + '.bak';
      try { fs.copyFileSync(specPath, bak); }
      catch (e) {
        console.error(`[error] [E_BACKUP] 无法备份原 spec（${bak}）：${e.message}——已中止写回`);
        process.exit(13);
      }
      console.error(`[edit] 原 spec 已备份 → ${bak}`);
    }
    try {
      fs.writeFileSync(tmp, JSON.stringify(spec, null, 2));
      fs.renameSync(tmp, specPath);
    } catch (e) {
      console.error(`[edit] ✗ 写回失败：${e.message}（原文件与备份完好）`);
      process.exit(13);
    }
    console.error(`[edit] ✓ 已写回 ${specPath}`);
  }
}

if (args.json) {
  const out = { ok: lintExit !== 1, edited: result.applied, applied: apply,
    duration: lay.total, rows: lay.rows.length, lintExit };
  if (args.suggest) out.suggestions = cuts;
  process.stdout.write(JSON.stringify(out) + '\n');
}
process.exit(lintExit === 1 ? 13 : 0);