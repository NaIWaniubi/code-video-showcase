#!/usr/bin/env node
/**
 * test-all.mjs — 一个入口跑全套，并把结果收敛成机器可读报告。
 *
 *   node scripts/test-all.mjs                 # 人读：逐套输出 + 汇总表
 *   node scripts/test-all.mjs --json          # CI：stdout 只有一行 JSON
 *   node scripts/test-all.mjs --tap           # CI：TAP14
 *   node scripts/test-all.mjs --browser       # 加上真实 Chrome 套件
 *   node scripts/test-all.mjs --only brand,contract
 *
 * 为什么需要（v2.4 / P1-04）：v2.3.5 的 16 个测试脚本有四种汇总格式
 * （"N passed, M failed" / "N checks: ..." / "Ran N tests: ..." / "RESULT: PASS"），
 * CI 只能人肉 grep。这里统一解析成 {ok,total,passed,failed,suites[]}，
 * 退出码只看子进程真实 exit —— 不靠正则推断成败。
 *
 * 退出码：0 全部通过；1 任一失败；2 用法。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 解析器单独成模块，便于直接单测（本文件有顶层执行副作用，import 就会跑全套）。
import { parseSummary, tallySuite } from './summary-parse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const UNIT_SUITES = [
  'scripts/test-core.mjs',
  'scripts/test-nl2spec.mjs',
  'scripts/test-script.mjs',
  'scripts/test-assets.mjs',
  'scripts/test-variants.mjs',
  'scripts/test-reflow.mjs',
  'scripts/test-ref-core.mjs',
  'scripts/test-from-reference.mjs',
  'scripts/test-brand.mjs',
  'scripts/test-motion-profile.mjs',
  'scripts/test-style-pages.mjs',
  'scripts/test-spec-security.mjs',
  'scripts/test-accent-route.mjs',
  'scripts/test-compiler-contract.mjs',
  'scripts/test-versioning.mjs',
  'scripts/test-summary-parse.mjs',
  'scripts/test-ref-video.mjs',
  'scripts/test-generative.mjs',
  'scripts/test-transitions.mjs',
  'scripts/test-effects.mjs',
  'scripts/test-domains.mjs',
  'scripts/test-hardening.mjs',
  'scripts/test-strict-flags.mjs',
  'scripts/test-segment-edit.mjs',
  'scripts/test-spec-edit.mjs',   // R15：agent 向剪辑内核 + edit CLI（EDL/OTIO/dry-run）
  'scripts/test-mcp-server.mjs',  // R20：MCP stdio 接口层（线协议握手 + 10 工具实调）
  'scripts/test-ref-compare.mjs',  // R22：复刻度量的纯函数回归
  'scripts/test-film-export.mjs',   // R24：spec→OpenFilm IR 导出与 overrides
  'scripts/test-score-core.mjs',    // R24：主观质量评分纯函数
  'scripts/test-zip-lib.mjs',
  'scripts/test-trust-fixes.mjs',   // S0：F1/F2/F3/F5 假绿修复的命名回归（bare闸/指纹/film overrides/MCP --plan）
  'scripts/test-caption.mjs',         // S4-1：词级字幕契约层（注入/备份/冲突闸/漂移告警，不跑重模型）
  'scripts/test-motion-blur.mjs',      // S5a：模糊档位/哈希失效/renderArgs 下发（纯逻辑；--render 真机模式手动）
  'scripts/test-taste.mjs',         // S1：审美裁判机——判决/豁免生命周期/确定性同分/17 主题 body 对比度
  'scripts/test-qa-forward.mjs',    // G3-1：qa --strict 转发子闸 argv 回归（假绿同形复发防线）
  'scripts/test-theme-audit.mjs',   // G3-5：HUD 行 APCA 用合成后前景色（永不拦 bug 的回归）
  'scripts/test-ssrf-ipv6.mjs',     // S8/G5：IPv4-mapped IPv6 与打包整数回环/元数据地址硬拦
  'scripts/test-flash-words.mjs',   // G4：flash 真多变体/S9 words 闭环/bpm 进哈希/时钟
  'scripts/test-attest.mjs',        // G9：哈希证书四层结构/digest 稳定性/分层 verdict/真渲闭环
  'scripts/test-gc.mjs',            // G6-4：段缓存回收——护栏/配对删/keep·older-than 语义/孤儿 json
  'scripts/test-blur-cli.mjs',      // G6-1/3：motionBlur off 档对称 + 资源上限乘子帧倍率
  'scripts/test-bypass-security.mjs', // G5：安全旁路回归（XSS/逃逸/CORS/原型污染/cue 注入/数值闸），与 test-spec-security 等尺
  'scripts/test-version-sync.mjs',
  'scripts/test-demo-spec.mjs',
  'scripts/test-ui.mjs',
  'ingest/test-edl.mjs',
];

const BROWSER_SUITES = [
  'scripts/test-inspect.mjs',
  'scripts/test-wizard-ref.mjs',
  'scripts/test-reflow-pages.mjs',
  'scripts/still-cyber-pixel.mjs',
  'scripts/test-recipes.mjs',
  'scripts/test-style-pages-render.mjs',
  'scripts/test-effects-render.mjs',
  'scripts/test-image.mjs',
  'server/test-api.mjs',
  'scripts/test-brand-visual.mjs',
  'scripts/test-type-tokens.mjs',
  'scripts/test-renderer-recovery.mjs',
  // 静帧位级回归（内审 F10）：此前 test-golden 不在任何聚合入口——「34 套件全绿」
  // 时位级基线根本没跑。golden 是预览帧==成片帧承诺的最终证据，必须入门禁。
  'scripts/test-golden.mjs',
  // 逐帧预览工作台：核心断言是「live 画布 == 服务端 PNG」逐像素一致，必须有 Chrome。
  'scripts/test-frames.mjs',
  // G1-3→G8 校准：perf --quick 是真渲染套件（Chrome+ffmpeg），比纯逻辑慢一个数量级
  // 且墙钟阈值本机 vs CI 差 4×——放 UNIT 会让 push 门禁永远红（长红即噪音）。
  // 归 BROWSER 组（默认 900s 预算，这里给 1200s 让慢机也能跑完出正确性结论），
  // 由 render-smoke/nightly 消费；阈值类超限只 WARN（见 test-render-perf check()）。
  'scripts/test-render-perf.mjs --quick --suite-timeout 1200000',
];

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) { a._.push(k); continue; }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) a[k.slice(2)] = true;
    else { a[k.slice(2)] = next; i++; }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: node scripts/test-all.mjs [options]
  --json            machine-readable one-line report
  --tap             TAP version 14 output
  --browser         include suites that need real Chrome / ffmpeg
  --only <a,b>      run only suites whose path contains one of the substrings
  --timeout <ms>    per-suite timeout (default 900000 browser / 300000 unit).
                    Suite entries may carry inline args, e.g.
                    'scripts/test-render-perf.mjs --quick --suite-timeout 600000'
                    (--suite-timeout is consumed by test-all, not passed on).`);
  process.exit(0);
}

const MODE = args.json ? 'json' : args.tap ? 'tap' : 'text';
const SUITES = [...UNIT_SUITES, ...(args.browser ? BROWSER_SUITES : [])];
const only = typeof args['only'] === 'string'
  ? String(args['only']).split(',').map((s) => s.trim()).filter(Boolean)
  : null;
const selected = only ? SUITES.filter((s) => only.some((k) => s.includes(k))) : SUITES;
if (!selected.length) {
  console.error(`[test-all] no suites matched --only ${only.join(',')}`);
  process.exit(2);
}

// 优先级：CLI --timeout（调试用，最高）> 套件条目内联 --suite-timeout > 组默认。
const USER_TIMEOUT = Number(args.timeout) > 0 ? Number(args.timeout) : 0;
const timeout = USER_TIMEOUT || (args.browser ? 900000 : 300000);

export { parseSummary };

const rows = [];
const startedAll = Date.now();
for (const spec of selected) {
  // 条目可以是 'path/to/suite.mjs'，也可以带内联参数 'path --quick'（G1-3）。
  // `--suite-timeout <ms>` 由 test-all 自己消费（本套件 spawn 超时覆盖），不透传。
  const [suitePath, ...suiteArgsRaw] = String(spec).split(/\s+/).filter(Boolean);
  const suiteArgs = [];
  let suiteTimeout = timeout;
  for (let i = 0; i < suiteArgsRaw.length; i++) {
    if (suiteArgsRaw[i] === '--suite-timeout') {
      const v = Number(suiteArgsRaw[++i]);
      if (!USER_TIMEOUT && Number.isFinite(v) && v > 0) suiteTimeout = v;
      continue;
    }
    suiteArgs.push(suiteArgsRaw[i]);
  }
  const file = path.join(ROOT, suitePath);
  if (!fs.existsSync(file)) {
    // 缺失套件 = 硬失败：failed 兜底计 1 并标 failedUnparsed（G1-2 一致性）。
    rows.push({ suite: spec, ok: false, exit: null, passed: null, failed: 1, failedUnparsed: true, total: null, durationMs: 0, summary: 'missing suite file', output: '' });
    continue;
  }
  if (MODE === 'text') console.log(`\n=== ${spec} ===`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file, ...suiteArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: suiteTimeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: process.env,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (MODE === 'text') process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  const parsed = parseSummary(out);
  // 聚合唯一事实源：tallySuite（回归在 scripts/test-summary-parse.mjs）。
  // 旧版在此处对「exit≠0 且解析不出」写 failed:null，顶层再 Σ 时把 null 当 0 吞掉，
  // 造成报告 "ok:false + failed:0" 同屏说谎（G1-2）。
  const tally = tallySuite({ exit: r.status, parsed });
  const summary = out.trim().split(/\r?\n/).filter((l) => /passed|failed|RESULT|tests?/i.test(l)).slice(-2).join(' | ');
  rows.push({
    suite: spec,
    ok: tally.ok,
    exit: r.status,
    passed: parsed ? parsed.passed : null,
    failed: tally.failed,
    ...(tally.failedUnparsed ? { failedUnparsed: true } : {}),
    total: parsed ? parsed.total : null,
    durationMs: Date.now() - t0,
    summary: summary || (r.status === 0 ? (tally.ok ? 'ok' : `self-reported ${tally.failed} failed`) : `exit ${r.status}${r.signal ? ` signal ${r.signal}` : ''}`),
    output: r.error ? String(r.error.message || r.error) : '',
  });
}

const totals = rows.reduce((acc, r) => {
  acc.passed += Number(r.passed || 0);
  acc.failed += Number(r.failed || 0);
  return acc;
}, { passed: 0, failed: 0 });
// 一致性由行级契约保证（tallySuite）：ok ⇒ failed===0；failed>0 ⇒ !ok。
// 顶层因此不可能出现 ok 与 failed 互相矛盾的同屏说谎（G1-2）。
const ok = rows.every((r) => r.ok);
const report = {
  ok,
  generatedBy: 'scripts/test-all.mjs',
  durationMs: Date.now() - startedAll,
  browser: !!args.browser,
  suites: rows.length,
  passed: totals.passed,
  failed: totals.failed,
  results: rows.map(({ output, ...r }) => ({ ...r, ...(output ? { detail: output } : {}) })),
};

if (MODE === 'json') {
  process.stdout.write(JSON.stringify(report) + '\n');
} else if (MODE === 'tap') {
  console.log('TAP version 14');
  console.log(`1..${rows.length}`);
  rows.forEach((r, i) => {
    const name = r.suite.replace(/#/g, '');
    const counts = r.passed === null ? '' : ` passed=${r.passed} failed=${r.failed}`;
    console.log(`${r.ok ? 'ok' : 'not ok'} ${i + 1} - ${name}${counts} # exit=${r.exit}`);
    if (!r.ok) console.log(`  ---\n  suite: ${name}\n  exit: ${r.exit}\n  summary: ${r.summary.replace(/\r?\n/g, ' ')}\n  ...`);
  });
} else {
  console.log('\n── summary ───────────────────────────────────────────────');
  for (const r of rows) {
    const counts = r.passed === null ? '' : ` ${r.passed}/${r.total ?? r.passed} passed`;
    console.log(`${r.ok ? '✓' : '✗'} ${r.suite.padEnd(42)}${counts}  (${(r.durationMs / 1000).toFixed(1)}s)`);
  }
  console.log(`\n${ok ? 'PASS' : 'FAIL'} · ${rows.length} suites · ${report.passed} passed · ${report.failed ?? '?'} failed · ${(report.durationMs / 1000).toFixed(1)}s`);
}

process.exit(ok ? 0 : 1);
