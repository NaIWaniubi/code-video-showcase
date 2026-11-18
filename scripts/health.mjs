#!/usr/bin/env node
/**
 * health.mjs — `cvs health`：一次性全身体检，输出健康 JSON。
 *
 *   cvs health                    # doctor + gate + golden selfcheck（快速子集）
 *   cvs health --json             # stdout 一行 JSON（人读在 stderr）
 *
 * 为什么单独一个命令：发布前的「机器状态」分散在四条命令里；本入口把
 * 环境 / 矩阵 / 文档门禁 / 位级基线串成一份带时间戳的健康报告，CI 与维护者同用。
 * 用法约束：只做只读检查，不改仓库（golden selfcheck 会渲染到 out/golden，属构建产物）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROG = 'node scripts/health.mjs';
const KNOWN = new Set(['json', 'help']);
const argv = process.argv.slice(2);
const { args, unknown } = parseArgs(argv);
if (unknown.length) reject(PROG, unknown);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[k.slice(2)] = true;
    else { out[k.slice(2)] = next; i++; }
  }
  const unk = [];
  for (const k of Object.keys(out)) if (!KNOWN.has(k)) unk.push(k);
  return { args: out, unknown: unk };
}
function reject(prog, unknown) {
  console.error(`[error] [E_USAGE] unknown flag ${unknown[0]}`);
  console.error(`run "${prog} --help"`);
  process.exit(2);
}

if (args.help) {
  console.log(`Usage: node scripts/health.mjs [options]
  (无参直接跑全身体检)
  --json              one-line JSON on stdout, human text to stderr`);
  process.exit(0);
}

const checks = [];
const run = (label, script, extraEnv = {}) => {
  const t0 = Date.now();
  // script 是 ['scripts/x.mjs', '--check']——不能整体 path.join（flag 会被拼进路径）。
const r = spawnSync(process.execPath,
    // 绝对路径脚本（fixture-lint）直接使用；相对路径按 ROOT 解析
    [path.isAbsolute(script[0]) ? script[0] : path.join(ROOT, script[0]), ...script.slice(1)],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...extraEnv },
      timeout: 15 * 60 * 1000 });
  checks.push({
    name: label,
    exitCode: r.status ?? null,
    ok: r.status === 0,
    ms: Date.now() - t0,
    tail: String(r.stdout || r.stderr || '').trim().split(/\r?\n/).slice(-1)[0].slice(0, 160),
  });
};

run('doctor', ['scripts/doctor.mjs']);
run('errors-registry', ['scripts/errors.mjs', '--check']);
run('combos-matrix', ['scripts/build-combos.mjs', '--check']);
run('golden-selfcheck', ['scripts/golden.mjs']);
// R12-W3：golden 与 fixture 的黄金样例双检（矩阵里的最小可编译样片）
run('fixture-lint',
  [path.join(ROOT, 'scripts/spec-lint.mjs'), '--spec', path.join(ROOT, 'fixtures/mini-41s/spec.json'), '--root', ROOT]);

// ── 汇总 ─────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.ok);
const report = {
  ok: failed.length === 0,
  generatedAt: new Date().toISOString(),
  version: versionOf(),
  checks,
  summary: { total: checks.length, ok: checks.length - failed.length, failed: failed.length },
};
if (args.json) process.stdout.write(JSON.stringify(report) + '\n');

console.error('\n[cvs health]  摘要');
for (const c of checks) {
  console.error(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(16)} ${c.ms}ms` +
    (c.ok ? '' : `  (${c.tail})`));
}
console.error(`\n${report.summary.ok}/${report.summary.total} 通过 · ${versionOf()}` +
  (failed.length ? '  ✗ 存在失败项' : '  ✓ 全身体检通过'));
process.exit(failed.length ? 13 : 0);

/** package.json 的版本号（与 cvs --version 同源）。 */
function versionOf() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch { return null; }
}
