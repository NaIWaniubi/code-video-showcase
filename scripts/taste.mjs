#!/usr/bin/env node
/**
 * taste.mjs — `cvs taste`：S1 审美裁判机（纯确定性，无网络无 LLM）。
 *
 *   node scripts/taste.mjs <spec.json> [--root dir] [--waivers f] [--strict] [--json] [--out dir]
 *
 * 设计（依据 E:\myzcode\_research_22\notes\G3.md，蓝本=impeccable 工程形态 ×
 * hallmark 58 门可判定子集 × taste-skill 的 GATE/waiver 纪律）：
 *  - 规则目录 schema/taste-rules.json 是数据；本文件的 EVALS 按 id 实现数值断言。
 *    **写不出数值断言的审美维度不进闸**（hallmark 的教训：无 scope 的阈值必误判）。
 *  - 三层判决：error 永远拦（exit 13）· warning 计入 100−Σweight 且 --strict 拦 ·
 *    advisory 永不拦只列示。
 *  - 豁免照抄 taste-skill/impeccable：.cvs/waivers.json 逐条 {ruleId, reason, date}，
 *    绝不为过闸改规则本身；--report-unused-waivers 把过期豁免显式化。
 *  - 确定性承诺：同 spec + 同规则版本 → 同分数同序（进回归测试）。
 * 退出码：0 通过 · 2 用法/读盘失败 · 13 质检不过（与 SKILL §0.0 出口码表同族）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseStrict, rejectUnknown } from './lib/strict-flags.mjs';
import { parseColor, apcaAbs, toOklch, auditApca } from '../templates/color.js';
import { THEMES, THEME_IDS, DEFAULT_THEME } from '../templates/themes.js';

const PROG = 'node scripts/taste.mjs';
const KNOWN = new Set(['root', 'waivers', 'strict', 'json', 'out', 'rules', 'report-unused-waivers', 'help']);
const argv = process.argv.slice(2);
const { args, unknown } = parseStrict(argv, KNOWN);
if (unknown.length) rejectUnknown(PROG, unknown, KNOWN);
const specArg = String(argv.find((a) => !String(a).startsWith('--')) || '');
if (args.help || !specArg) {
  console.log(`Usage: node scripts/taste.mjs <spec.json> [options]
  --root <dir>                project root (default cwd)
  --rules <f>                 rule catalog (default schema/taste-rules.json)
  --waivers <f>               waivers JSON (default <root>/.cvs/waivers.json)
  --strict                    warnings fail too
  --report-unused-waivers     waived rules that no longer fire are reported
  --json                      machine report on stdout
  --out <dir>                 write taste.json (default <root>/out/qa)`);
  process.exit(args.help ? 0 : 2);
}

const ROOT = path.resolve(String(args.root || process.cwd()));
let spec;
try { spec = JSON.parse(fs.readFileSync(path.resolve(specArg), 'utf8')); }
catch (e) { console.error(`[error] [E_TASTE_READ] spec 不可读: ${String(e.message).slice(0, 160)}`); process.exit(2); }
let catalog;
try { catalog = JSON.parse(fs.readFileSync(path.resolve(String(args.rules || path.join(ROOT, 'schema', 'taste-rules.json'))), 'utf8')); }
catch (e) { console.error(`[error] [E_TASTE_READ] rules 不可读: ${String(e.message).slice(0, 160)}`); process.exit(2); }

// ── 小工具 ──
const themeOf = () => (spec.look && spec.look.theme && THEMES[spec.look.theme]) || THEMES[DEFAULT_THEME];
const c = (k) => themeOf().colors?.[k] || null;
const normHex = (h) => {
  if (!h) return '';
  const s = String(h).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + [...s.slice(1)].map((x) => x + x).join('');
  try { const { r, g, b } = parseColor(s); return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join(''); } catch { return s; }
};
const frac = (x) => x - Math.floor(x);
const copyStrings = () => {
  const out = [];
  const push = (label, v) => { if (typeof v === 'string' && v) out.push([label, v]); };
  const m = spec.meta || {};
  push('meta.brand', m.brand); push('meta.title', m.title); push('meta.cta', m.cta); push('meta.description', m.description);
  for (const [k, v] of Object.entries(spec.copy || {})) push(`copy.${k}`, typeof v === 'string' ? v : JSON.stringify(v));
  for (const r of spec.rounds || []) {
    push(`rounds[${r.id}].card.first`, r.card?.first); push(`rounds[${r.id}].card.keyword`, r.card?.keyword);
    const sc = r.style?.copy || {};
    for (const [k, v] of Object.entries(sc)) push(`rounds[${r.id}].style.copy.${k}`, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return out;
};

// ── 判定实现（与 schema/taste-rules.json 的 id 一一对应；写不出数值断言的不进闸）──
const PLACEHOLDER_RE = /lorem|tbd|todo|\{\{|待填|示例|acme|jane doe|john doe/i;
const METRIC_RE = /(9[5-9]|100)\s*%|\b10\s*[×xX倍]|\d+\s*万\+?(次|人|用户)/;
const SOURCE_RE = /实测|复现|eval|bench|repro/i;

export const EVALS = {
  'placeholder-copy': () => {
    const hits = copyStrings().filter(([, v]) => PLACEHOLDER_RE.test(v));
    return hits.length ? { pass: false, value: hits.map(([l, v]) => `${l}="${v.slice(0, 40)}"`).join(', ') } : { pass: true, value: 'clean' };
  },
  'theme-known': () => {
    const t = spec.look?.theme;
    const okv = !t || t === DEFAULT_THEME || THEME_IDS.includes(t);
    return { pass: okv, value: String(t ?? `default(${DEFAULT_THEME})`) };
  },
  'contrast-body': () => {
    // 单一真值：直接消费模板层 auditApca 的行（ink/bg≥60 等），不在这里复写阈值。
    const row = auditApca(themeOf()).find((r) => r.pair === 'ink / bg');
    if (!row) return { pass: true, value: 'N/A' };
    return { pass: row.pass, value: `Lc=${row.lc}`, threshold: row.need };
  },
  'contrast-large': () => {
    const rows = auditApca(themeOf()).filter((r) => r.pair === 'muted / bg' || r.pair === 'accent / bg');
    const fails = rows.filter((r) => !r.pass);
    return fails.length
      ? { pass: false, value: fails.map((r) => `${r.pair.split(' ')[0]}=${r.lc}(需${r.need})`).join(','), threshold: 'auditApca 口径' }
      : { pass: true, value: rows.map((r) => `${r.pair.split(' ')[0]}=${r.lc}`).join(',') };
  },
  'black-on-black': () => {
    const a = toOklch(c('accentSoft')), b = toOklch(c('surface'));
    const dl = Math.abs(a.l - b.l) * 100, dc = Math.abs(a.c - b.c);
    const bad = dl < 5 && dc < 0.05 && a.h != null && b.h != null;
    return { pass: !bad, value: `ΔL=${dl.toFixed(1)} ΔC=${dc.toFixed(3)}` };
  },
  'neutral-chroma': () => {
    const cc = toOklch(c('muted')).c ?? 0;
    return { pass: cc >= 0.005, value: +cc.toFixed(4), threshold: 0.005 };
  },
  'override-silent': () => {
    const ov = spec.look?.accentOverride;
    if (!ov) return { pass: true, value: 'none（未覆盖，N/A）' };
    const same = normHex(ov) === normHex(c('accent'));
    return { pass: !same, value: same ? `override==theme.accent(${ov})` : `override=${ov}` };
  },
  'style-duplicate-page': () => {
    const seen = new Map();
    for (const r of spec.rounds || []) {
      const p = String(r.style?.page || '').split('?')[0];
      if (!p) continue;
      seen.set(p, (seen.get(p) || 0) + 1);
    }
    const dup = [...seen.entries()].filter(([, n]) => n > 1);
    return dup.length ? { pass: false, value: dup.map(([p, n]) => `${path.basename(p)}×${n}`).join(',') } : { pass: true, value: `${seen.size} 页各一轮` };
  },
  'transition-variety': () => {
    const rounds = spec.rounds || [];
    if (rounds.length < 3) return { pass: true, value: `rounds=${rounds.length}（N/A）` };
    const set = new Set(rounds.map((r) => String(r.style?.transition || r.transition || 'cut').toLowerCase()));
    return { pass: set.size >= 2, value: `distinct=${set.size} [${[...set].join(',')}]` };
  },
  'beat-grid': () => {
    const bpm = Number(spec.audio?.bpm || 0), st = spec.structure || {};
    if (!bpm) return { pass: true, value: 'bpm 未声明（N/A）' };
    const off = [];
    for (const [name, sec] of [['round', st.round], ['card', st.card], ['opening', st.opening], ['ending', st.ending]]) {
      if (!sec) continue;
      const beats = (Number(sec) * bpm) / 60, f = Math.abs(beats - Math.round(beats));
      if (f > 0.05 && !(Number(sec) === st.opening || Number(sec) === st.ending) && f > 0.05) off.push(`${name}=${sec}s→${beats.toFixed(2)}拍`);
      else if (f > 0.05 && (Number(sec) === st.opening || Number(sec) === st.ending) && f > 0.25) off.push(`${name}=${sec}s→${beats.toFixed(2)}拍`);
    }
    return off.length ? { pass: false, value: off.join(','), threshold: '±0.05拍(首尾±0.25)' } : { pass: true, value: `bpm=${bpm} 全部落拍` };
  },
  'flash-overload': () => {
    const f = spec.structure?.flash || {}, dur = Number(spec.format?.duration || 0);
    const share = dur ? (Number(f.count || 0) * Number(f.each || 0)) / dur : 0;
    return { pass: share <= 0.15 + 1e-9, value: `${(share * 100).toFixed(1)}%`, threshold: 15 };
  },
  'duration-band': () => {
    const d = Number(spec.format?.duration || 0);
    return { pass: d >= 20 && d <= 95, value: `${d}s`, threshold: '20–95' };
  },
  'copy-density': () => {
    const empt = (spec.rounds || []).filter((r) => !String(r.style?.copy?.subtitle || '').trim()).map((r) => r.id);
    return empt.length ? { pass: false, value: `无副题: ${empt.join(',')}` } : { pass: true, value: '每轮有副题' };
  },
  'fabricated-metric': () => {
    const bad = copyStrings().filter(([, v]) => METRIC_RE.test(v) && !SOURCE_RE.test(v));
    return bad.length ? { pass: false, value: bad.map(([l]) => l).join(',') } : { pass: true, value: '无未溯源数字声明' };
  },
};

// ── 运行 ──
const waiversPath = args.waivers ? path.resolve(String(args.waivers)) : path.join(ROOT, '.cvs', 'waivers.json');
let waivers = [];
try { waivers = JSON.parse(fs.readFileSync(waiversPath, 'utf8')).waivers || []; } catch { waivers = []; }
const waiverMap = new Map(waivers.map((w) => [String(w.rule), w]));

const results = [];
for (const rule of catalog.rules) {
  const ev = EVALS[rule.id];
  if (!ev) { results.push({ rule: rule.id, severity: rule.severity, status: 'unimplemented', evidence: 'EVALS 缺实现（闸不许假绿：视为 finding）' }); continue; }
  let r;
  try { r = ev(); } catch (e) { results.push({ rule: rule.id, severity: rule.severity, status: 'error', evidence: String(e.message).slice(0, 120) }); continue; }
  let status = r.pass ? 'pass' : 'fail';
  const wv = waiverMap.get(rule.id);
  if (status === 'fail' && wv && rule.waivable && rule.severity !== 'error') status = 'waived';
  else if (status === 'fail' && wv && rule.waivable && rule.severity === 'error') status = 'fail'; // error 不可豁免于闸（记录但照拦）
  results.push({ rule: rule.id, title: rule.title, from: rule.from, severity: rule.severity, status,
    weight: rule.weight || 0, evidence: String(r.value ?? ''), threshold: r.threshold ?? null,
    waivedBy: status === 'waived' ? `${wv.reason}（${wv.date || '无日期'}）` : null });
}
const fired = new Set(results.filter((x) => x.status === 'fail').map((x) => x.rule));
const unusedWaivers = waivers.filter((w) => !fired.has(String(w.rule))).map((w) => `${w.rule}: ${w.reason || ''}`);

const fails = results.filter((x) => x.status === 'fail');
const errs = fails.filter((x) => x.severity === 'error');
const warns = fails.filter((x) => x.severity === 'warning');
const advisories = fails.filter((x) => x.severity === 'advisory');
const deducted = warns.reduce((s, x) => s + (catalog.rules.find((r) => r.id === x.rule)?.weight || 5), 0);
const score = +Math.max(0, 100 - deducted).toFixed(1);
const report = {
  engine: 'taste/1', rulesVersion: catalog.version, spec: path.basename(specArg),
  score, blocking: errs.length > 0 || (Boolean(args.strict) && warns.length > 0),
  counts: { error: errs.length, warning: warns.length, advisory: advisories.length, waived: results.filter((x) => x.status === 'waived').length },
  results, unusedWaivers: Boolean(args['report-unused-waivers']) ? unusedWaivers : undefined,
};

const outDir = args.out ? path.resolve(String(args.out)) : path.join(ROOT, 'out', 'qa');
try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'taste.json'), JSON.stringify(report, null, 2) + '\n'); } catch { /* 报告写不进不掩判决 */ }

console.error(`[taste] score ${score}/100 · error ${errs.length} · warning ${warns.length} · advisory ${advisories.length}${report.counts.waived ? ` · waived ${report.counts.waived}` : ''}`);
for (const x of results) {
  if (x.status === 'fail') console.error(`  ✗ [${x.severity}] ${x.rule} — ${x.title} · ${x.evidence}`);
  if (x.status === 'waived') console.error(`  ~ [waived] ${x.rule} — ${x.waivedBy}`);
}
if (args['report-unused-waivers'] && unusedWaivers.length) console.error(`  ! 过期豁免: ${unusedWaivers.join(' | ')}`);
if (args.json) process.stdout.write(JSON.stringify(report) + '\n');
if (report.blocking) console.error(`[error] [E_TASTE_FAIL] taste 闸不过：error=${errs.length} warning=${warns.length}${args.strict ? '（--strict）' : ''} · 报告 ${path.join(outDir, 'taste.json')}`);
process.exit(report.blocking ? 13 : 0);
