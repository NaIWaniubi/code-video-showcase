#!/usr/bin/env node
/**
 * cvs — code-video-showcase 统一入口。
 *
 *   cvs new "帮我做个赛博像素的宣传片，30秒竖屏" --out project.spec.json
 *   cvs ref poster.jpg --spec project.spec.json --out project.spec.json
 *   cvs lint project.spec.json --root .
 *   cvs build project.spec.json --platform douyin --strict
 *   cvs again --set look.theme=amber-noir
 *   cvs deliver --spec project.spec.json
 *
 * 所有命令都是对现有脚本的薄封装；不引入新依赖。
 * 退出码：0 成功；2 用法/未知命令；10 spec；11 render；12 concat；13 qa；14 env。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();
const [cmd, ...rest] = process.argv.slice(2);

const node = (script, args) => spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
  cwd: process.cwd(), stdio: 'inherit', windowsHide: true,
});

const hasSpec = fs.existsSync(path.join(process.cwd(), 'project.spec.json'));
const specArgs = (args) => {
  if (args.length && !args[0].startsWith('--')) return ['--spec', ...args];
  if (hasSpec) return ['--spec', 'project.spec.json', ...args];
  return args;
};

// R3-审计（RT-01×RT-08 交叉）：首页「从零到成片」第 5 步教的 `cvs qa …` 是死路
// （E_UNKNOWN_COMMAND）。沿用 specArgs 同款默认值口径：仓库根有 out/master.mp4 就
// 直接拿它当视频，有 out/plan.json 就带上 --plan。
const hasMaster = fs.existsSync(path.join(process.cwd(), 'out', 'master.mp4'));
const hasOutPlan = fs.existsSync(path.join(process.cwd(), 'out', 'plan.json'));
const qaArgs = (args) => {
  if (args.length && !args[0].startsWith('--')) return args;
  const out = hasMaster ? ['out/master.mp4', ...args] : [...args];
  if (!out.includes('--plan') && !out.some((x) => String(x).startsWith('--plan=')) && hasOutPlan) {
    out.splice(1, 0, '--plan', 'out/plan.json');
  }
  return out;
};

// R2-35（N01-F5）：`cvs wizard --help` 以前不打印帮助反而起服务占住 5181。
// surface 命令统一：--help/-h 只打一行用法+URL 就退出，端口绝不进入 LISTENING。
const SURFACES = { wizard: 5181, canvas: 5182, script: 5183, versions: 5184, review: 5185 };
function surface(name, port, args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`cvs ${name} — start the ${name} dev surface (static server, port ${port})
usage: cvs ${name} [--port <n>]
  URL: http://127.0.0.1:${port}/app/${name}/
  Ctrl+C stops the server. This command does not build a film; use \`cvs build\` for that.`);
    process.exit(0);
  }
  return node(`app/${name}/serve.mjs`, args);
}

const commands = {
  new:      (a) => node('scripts/nl2spec.mjs', a),
  // R4 旗舰：`cvs ref video <mp4>`——参考片反推（结构/节拍/主题→spec patch）。
  // `cvs ref <image>` 保持旧图入口（R1 审计槽位同构：brand/motion/versions 的 verb 先例）。
  ref:      (a) => (a[0] === 'video' || a[0] === 'v')
    ? node('scripts/ref-video.mjs', ['--video', ...a.slice(1)])
    : node('scripts/from-reference.mjs', a.length && !a[0].startsWith('--') ? ['--img', ...a] : a),
  lint:     (a) => node('scripts/spec-lint.mjs', specArgs(a)),
  plan:     (a) => node('templates/plan.mjs', specArgs(a)),
  build:    (a) => node('scripts/compile.mjs', specArgs(a)),
  compile:  (a) => node('scripts/compile.mjs', specArgs(a)),
  again:    (a) => node('scripts/again.mjs', a),
  deliver:  (a) => node('scripts/deliver.mjs', specArgs(a)),
  // R10-W3：cvs qa 双闸——视频+音频一次跑完（旧版只跑视频闸）。
  qa:      (a) => node('scripts/qa.mjs', a.length && !a[0].startsWith('--') ? a : ['--help']),
  snapshot: (a) => node('scripts/versions.mjs', ['snapshot', ...specArgs(a)]),
  rollback: (a) => node('scripts/versions.mjs', ['rollback', ...a]),
  history:  (a) => node('scripts/versions.mjs', ['list', ...a]),
  verify:   (a) => node('scripts/versions.mjs', ['verify', ...a]),
  variant:  (a) => node('scripts/variants.mjs', specArgs(a)),
  variants: (a) => node('scripts/variants.mjs', specArgs(a)),
  ingest:   (a) => node('ingest/cli.mjs', a.length && !a[0].startsWith('--') ? ['--input', ...a] : a),
  doctor:   (a) => node('scripts/doctor.mjs', a),
  errors:   (a) => node('scripts/errors.mjs', a),
  brand:    (a) => node('scripts/brand.mjs', a),
  golden:   (a) => node('scripts/golden.mjs', a),
  image:    (a) => node('scripts/image.mjs', a),
  motion:   (a) => node('scripts/motion.mjs', a),
  // R6 旗舰入口：cvs demo <style> 一键排演示片（导演演示集六件）。
  demo:    (a) => node('scripts/demo.mjs', a.length && !a[0].startsWith('--') ? a : ['--help']),
  // R11-W2：一键全身体检（doctor + 错误码注册表 + 矩阵 + golden 位级基线）
  health: (a) => node('scripts/health.mjs', a),
  ship:   (a) => node('scripts/ship.mjs', a.length && !a[0].startsWith('--') ? a : ['--help']),
  // R15-W5：cvs edit — agent 向结构剪辑（split/drop/move/trim，D 公式闭合，默认 dry-run）。
  edit:   (a) => node('scripts/edit.mjs', a.length && !a[0].startsWith('--') ? a : ['--help']),
  film:    (a) => node('scripts/film.mjs', a.length && !a[0].startsWith('--') ? a : ['--help']),
  score:   (a) => node('scripts/score.mjs', a.length && !a[0].startsWith('--') ? a : ['--help']),
  // S1：cvs taste — 审美裁判机（规则表驱动、纯确定性、error 硬闸 / warning 扣分 / advisory 只列示）。
  taste:   (a) => node('scripts/taste.mjs', a.length && !a[0].startsWith('--') ? a : ['--help']),
  // S4-1：cvs caption — 本地词级字幕（faster-whisper 适配器 + sha256 缓存 + spec 注入）。
  caption: (a) => node('scripts/caption.mjs', a.length ? a : ['--help']),
  // G9：cvs attest — 产物哈希证书 + 跨机重放验证器（容器/帧/工具链/段哈希四层，
  // 帧同容器异=mux 抖动，帧异=真像素漂移 FAIL）。
  attest:  (a) => node('scripts/attest.mjs', a.length && !a[0].startsWith('--') ? a : ['--help']),
  api:      (a) => node('server/api.mjs', a),
  wizard:   (a) => surface('wizard', SURFACES.wizard, a),
  canvas:   (a) => surface('canvas', SURFACES.canvas, a),
  script:   (a) => surface('script', SURFACES.script, a),
  versions: (a) => surface('versions', SURFACES.versions, a),
  review:   (a) => surface('review', SURFACES.review, a),
  frames:   (a) => node('app/frames/serve.mjs', a),
  ui:       (a) => node('app/ui/serve.mjs', a),
  test:     (a) => node('scripts/test-all.mjs', a),
};

function help() {
  console.log(`cvs ${VERSION} — video compiler

usage: cvs <command> [args]

  new "<text>" [--out spec.json]         natural language -> spec (deterministic rules)
  ref <image> [--spec spec] [--out f]    reference image -> theme / accent / density
  ref video <mp4> [--apply spec.json]     reference film -> structure / BPM / theme -> spec patch
  lint <spec> [--root .] [--strict]      pages / theme / APCA / placeholder gates
  plan <spec> [--print]                  spec -> plan.json with per-segment hashes
  build <spec> [--audio f|--no-audio] [--platform douyin] [--strict] [--burn-subtitles] [--cover]
               [--transition fade|wipeleft|circleopen|...] [--transition-duration 0.4]
               [--concurrency n] [--resume] [--no-qa] [--json] [--dry-run]
                                        validate -> plan -> incremental render -> concat(xfade) -> qa
  qa [video] [--plan f]                quality gates (video + audio both, strict WARN fails)
                                        (default video out/master.mp4, plan out/plan.json)
  again [--set k=v] [--no-build]         edit last spec + rebuild only dirty segments
  deliver [--spec f] [--json] [--cover img]  delivery.json + master.srt/.vtt + cover
  snapshot [--spec f] [--label name] [--outdir d]
                                        version snapshot of master/spec/plan/qa (+ review.json)
  history [--spec f] [--json] [--outdir d]    list version snapshots in <outDir>/versions
  verify <version> [--spec f]            re-hash a snapshot against its record
  rollback <version> [--spec f]          restore a verified snapshot to outDir
  variant <spec> --axes <file> [--out d] cartesian variants + manifest (one outDir per variant)
  ingest <file|dir> --target <sec>       footage -> EDL + spec draft
  brand apply|check|list                 brand kit apply / compliance check
  motion list|show|derive|matrix         motion profile levels + kind×style derivation
  golden [--update|--selfcheck]          byte-exact still regression
  image [--spec f] [--set a,b] [--at t]  spec -> image set (cover/card/poster/story/...); --list shows presets
  api [--port 5190] [--host h] [--token t]  job-queue HTTP service (origin-checked)
  demo <style-id> [--seconds n] [--platform gif|webm|mp4]  one-shot demo film (directors' demo set)
  wizard | canvas | script | versions | review    start a dev surface (5181-5185)
  frames [--video f|--plan f|--spec f|--dir d] [--port 5186]
                                         per-frame realtime preview workbench
  ui [--port 5180]                       one server for all six surfaces (start at /app/)
  ship <spec> [--check]   package delivery bundle (spec+film+subs+manifest+README)
  edit <spec> [--split-at=sec] [--drop=id] [--move=id:pos] [--trim=sec] [--edl f] [--otio f]
                                        agent-grade structural edits (D-closed, default dry-run)
  film <spec> [--out dir] [--overrides f]
                                        export an OpenFilm-IR timeline (film.html + pages/)
  score <video> [--plan f] [--qa-audio f]   subjective quality score (5 parts, A-D grade)
  taste <spec> [--strict] [--waivers f]  deterministic aesthetic gate (rules table, error/warning/advisory)
  attest <out.mp4> [--verify attestation.json] [--manifest f] [--plan f] [--out f] [--json]
                                        产物哈希证书（container sha + framemd5 逐帧 + toolchain + 段哈希，
                                        digest 无时间戳可跨机重算）；--verify 离线分层复核
  health                 full checkup: doctor + error registry + combos + golden
  test [--browser]                       run all suites
  doctor                                 environment check (renderer capability probe)
  errors [--check|--write]               error-code registry / docs/ERRORS.md

default spec: ./project.spec.json when present.
exit codes: 0 ok · 2 usage · 10 spec · 11 render · 12 concat · 13 qa · 14 env`);
}

if (cmd === '--version' || cmd === '-V' || cmd === 'version') {
  console.log(VERSION);
  process.exit(0);
}

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  help();
  process.exit(0);
}

if (!commands[cmd]) {
  console.error(`[error] [E_UNKNOWN_COMMAND] ${cmd}`);
  console.error(`run "cvs --help" to see the ${Object.keys(commands).length} supported commands`);
  process.exit(2);
}

const r = commands[cmd](rest);
process.exit(r.status ?? 1);
