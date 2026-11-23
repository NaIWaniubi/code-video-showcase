#!/usr/bin/env node
/**
 * mcp/server.mjs — CVS 的 MCP stdio 接口：任意 agent 一行接入。
 *
 *   node mcp/server.mjs            # 或经 npm run mcp
 *
 * 为什么选 MCP（而非再包一层 HTTP）：
 *   - 零配置：Claude Desktop / Cursor / ZCode / Claude Code 都支持
 *     `"command": "node", "args": ["mcp/server.mjs"]`，无需端口、token、CORS；
 *   - stdio 天然隔离：只在调用期间存在，不常驻进程、不暴露端口；
 *   - 零依赖：手写最小 JSON-RPC 子集（initialize / tools/list / tools/call），
 *     与官方 SDK 线协议兼容（newline-delimited JSON-RPC 2.0）。
 *
 * 工具集 = CLI 全链路的语义级封装（内核优先，子进程兜底）：
 *   cvs_new        自然语言 → spec（内核直调）
 *   cvs_lint       spec 门禁（lint）
 *   cvs_plan       spec → plan 摘要
 *   cvs_build      编译链（默认 dry-run——agent 安全第一性；--apply 才落盘）
 *   cvs_edit       结构四件套（split/drop/move/trim，默认 dry-run）
 *   cvs_suggest    建议切点（内核直调，瞬时无浏览器）
 *   cvs_qa         双闸质检
 *   cvs_ship       交付打包（--check 预检）
 *   cvs_demo       导演演示集一键出片
 *   cvs_caption  本地词级字幕（识别/注入两模式）
 *   cvs_attest   产物哈希证书 / 跨机重放验证（G9，四层 verdict）
 *   cvs_health     一键全身体检
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nl2spec } from '../scripts/nl2spec.mjs';
import { suggestedCuts } from '../scripts/lib/spec-edit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const SERVER_INFO = { name: 'code-video-showcase', version: '4.10.1' };

// ── 内核工具（无子进程）───────────────────────────────────────────────────

function specOf(specPath, root) {
  const p = path.resolve(root || process.cwd(), String(specPath));
  let doc;
  try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`cannot read spec ${p}: ${e.message}`); }
  return { doc, p };
}

/**
 * G5-2（2026-11 安全审计 E_OUTPATH_ESCAPE）：cvs_new 的 outPath 是不可信参数，
 * 旧版 path.resolve(ROOT, p) 后直接 mkdir+writeFileSync——`../../outside` 这类
 * 相对逃逸写在仓库外；绝对路径只要进程有权限也照写（复现见
 * references/security-audit.md）。闸门规则：
 *   1. 语法层：path.resolve(ROOT, outPath) 必须 isInside(ROOT)；
 *   2. 真实层：realpath 目标（不存在则逐级解析已存在的最近祖先再拼回），
 *      防 symlink 把「看起来在内」的路径引到仓库外；
 *   越界 → 抛带 code=E_OUTPATH_ESCAPE 的 Error，工具层回结构化 error。
 * 返回真实路径（写盘后用于回报）。宁可拒服务，不可静默放行。
 */
export function assertInsideRoot(rootDir, targetPath) {
  const abs = path.resolve(rootDir, String(targetPath));
  const inside = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (!inside(rootDir, abs)) {
    const e = new Error(`E_OUTPATH_ESCAPE: outPath escapes project root: ${targetPath}`);
    e.code = 'E_OUTPATH_ESCAPE';
    throw e;
  }
  // realpath 逐级回退：目标可能不存在（正要创建），解析到最近的已存在祖先。
  let realRoot;
  try { realRoot = fs.realpathSync(rootDir); } catch { realRoot = rootDir; }
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      const rebuilt = tail.length ? path.join(real, ...tail.reverse()) : real;
      if (!inside(realRoot, rebuilt)) {
        const e = new Error(`E_OUTPATH_ESCAPE: outPath resolves outside project root (via symlink?): ${targetPath}`);
        e.code = 'E_OUTPATH_ESCAPE';
        throw e;
      }
      return rebuilt;
    } catch (err) {
      if (err.code === 'E_OUTPATH_ESCAPE') throw err;
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
        const e = new Error(`E_OUTPATH_ESCAPE: cannot verify outPath ${targetPath}: ${err.message}`);
        e.code = 'E_OUTPATH_ESCAPE';
        throw e;
      }
      const parent = path.dirname(cur);
      if (parent === cur) {   // 到盘根仍不存在 → 用语法路径再判一次
        if (!inside(realRoot, abs)) {
          const e = new Error(`E_OUTPATH_ESCAPE: outPath escapes project root: ${targetPath}`);
          e.code = 'E_OUTPATH_ESCAPE';
          throw e;
        }
        return abs;
      }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// ── 子进程工具封装 ─────────────────────────────────────────────────────────

/** 跑 `bin/cvs.mjs` 子命令；返回 {ok, exitCode, text}。timeout 秒（钳 10..1800）。 */
function runCvs(args, { timeoutSeconds = 300 } = {}) {
  return new Promise((resolve) => {
    const t = Math.max(10, Math.min(1800, Number(timeoutSeconds) || 300));
    const child = spawn(process.execPath, ['bin/cvs.mjs', ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    const cap = (b) => { out += b.toString('utf8'); if (out.length > 1 << 20) out = out.slice(-(1 << 20)); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, t * 1000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, exitCode: null, text: `spawn error: ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, exitCode: code, text: out.trim() }); });
  });
}

function resultText(t, label) {
  return `--- ${label} ---\n${t}`;
}

// ── 工具表 ─────────────────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: 'cvs_new',
    description: '自然语言 → spec（确定性规则引擎，无模型调用）。文本里出现的产品/风格/时长会被解析进 spec；未识别的字段用默认值并在返回 notes 说明。',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: '一句话需求，如「做一条 30 秒赛博竖屏国风宣传片」' },
      outPath: { type: 'string', description: '可选：写入该路径（相对项目根或绝对）' },
      overrides: { type: 'object', description: '可选强制覆盖：kind/style/theme/aspect/seconds/mood 等枚举字段' },
    }, required: ['text'] },
    run: async (a) => {
      try {
        const spec = await nl2spec(String(a.text), (a.overrides && typeof a.overrides === 'object') ? a.overrides : {});
        let wrote = null;
        if (a.outPath) {
          // G5-2：写盘前过根目录闸（语法 + realpath 两级），越界抛 E_OUTPATH_ESCAPE。
          const p = assertInsideRoot(ROOT, a.outPath);
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, JSON.stringify(spec, null, 2));
          wrote = p;
        }
        return { text: `spec 已生成（kind=${spec.kind ?? 'promo'}, style=${spec.style?.id ?? '-'}）。${wrote ? `已写入 ${wrote}` : '未指定 outPath，未落盘。'}`, payload: { wrote, spec } };
      } catch (e) { return { isError: true, code: e && e.code || undefined, text: String(e && e.message || e) }; }
    },
  },
  {
    name: 'cvs_suggest',
    description: '把 spec 结构展开为建议切点（每个段边界一个候选切点；卡→风格不算切点）。瞬时、无浏览器——与 GET /frames/api/suggestions 同口径。',
    inputSchema: { type: 'object', properties: { specPath: { type: 'string' } }, required: ['specPath'] },
    run: async (a) => {
      try {
        const { doc, p } = specOf(a.specPath, a.root);
        const sug = suggestedCuts(doc);
        const lines = [`D=${sug.total.toFixed(2)}s`];
        for (const r of sug.rows) lines.push(`${r.start.toFixed(2)}–${r.end.toFixed(2)}s  ${r.id}  (${r.kind})`);
        lines.push('cuts:');
        for (const c of sug.cuts) lines.push(`  ${c.at.toFixed(2)}s  ${c.after} → ${c.before}  (${c.kind})`);
        return { text: `spec: ${p}\n${lines.join('\n')}`, payload: { total: sug.total, cuts: sug.cuts } };
      } catch (e) { return { isError: true, text: String(e && e.message || e) }; }
    },
  },
  {
    name: 'cvs_lint',
    description: 'spec 门禁 lint：页面/主题/APCA/占位符等校验；strict 时 WARN 也拦。',
    inputSchema: { type: 'object', properties: { specPath: { type: 'string' }, strict: { type: 'boolean' }, root: { type: 'string' } }, required: ['specPath'] },
    run: async (a) => {
      const r = await runCvs(['lint', a.specPath, ...(a.strict ? ['--strict'] : []), ...(a.root ? ['--root', a.root] : [])]);
      return { isError: !r.ok, text: resultText(r.text.slice(-4000), `lint exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_plan',
    description: 'spec → plan.json（分段哈希/页 URL），只读不渲染。',
    inputSchema: { type: 'object', properties: { specPath: { type: 'string' }, root: { type: 'string' } }, required: ['specPath'] },
    run: async (a) => {
      const r = await runCvs(['plan', a.specPath, ...(a.root ? ['--root', a.root] : [])]);
      return { isError: !r.ok, text: resultText(r.text.slice(-4000), `plan exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_build',
    description: '编译链：lint → plan → 增量渲染 → concat → QA。默认 dry-run（只验证不落盘）保证 agent 安全；显式 apply 才写盘。渲染较慢（分钟级），大改请调大 timeoutSeconds。',
    inputSchema: { type: 'object', properties: {
      specPath: { type: 'string' },
      platform: { type: 'string', enum: ['douyin', 'bilibili', 'xiaohongshu', 'master'] },
      strict: { type: 'boolean' },
      apply: { type: 'boolean', description: 'true 才真渲染落盘（默认 dry-run 验证）' },
      segmentPatch: { type: 'string', description: '帧工作台导出的段表补丁 JSON 路径' },
      refPatch: { type: 'string', description: '参考片反推补丁路径' },
      root: { type: 'string' },
      timeoutSeconds: { type: 'number', description: '预算（秒，10–1800，默认 300）' },
      concurrency: { type: 'number', description: '段级并行度（本机 GPU 弱时给 1 更稳）' },
    }, required: ['specPath'] },
    run: async (a) => {
      const args = ['build', a.specPath];
      if (a.platform) args.push('--platform', a.platform);
      if (a.strict) args.push('--strict');
      if (a.concurrency != null && Number.isFinite(Number(a.concurrency))) args.push('--concurrency', String(a.concurrency));
      if (a.segmentPatch) args.push('--segment-patch', a.segmentPatch);
      if (a.refPatch) args.push('--ref-patch', a.refPatch);
      args.push(...(a.apply ? [] : ['--dry-run']));   // 默认 dry-run；apply = 不带开关直接编译
      if (a.root) args.push('--root', a.root);
      const r = await runCvs(args, { timeoutSeconds: a.timeoutSeconds });
      return { isError: !r.ok, text: resultText(r.text.slice(-6000), `build(${a.apply ? 'apply' : 'dry-run'}) exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_edit',
    description: 'agent 向结构剪辑四件套：splitAt（秒拆分轮）、drop（轮 id）、move（id:位置）、trim（目标秒数重拟合）；D 公式恒闭合。默认 dry-run，apply 才写回原文件并自动 .bak。',
    inputSchema: { type: 'object', properties: {
      specPath: { type: 'string' }, splitAt: { type: 'number' }, drop: { type: 'string' },
      move: { type: 'string' }, trim: { type: 'number' }, apply: { type: 'boolean' }, root: { type: 'string' },
    }, required: ['specPath'] },
    run: async (a) => {
      const args = ['edit', a.specPath];
      const edits = [];
      if (a.splitAt != null && Number.isFinite(Number(a.splitAt))) { args.push('--split-at', String(a.splitAt)); edits.push(`split@${a.splitAt}s`); }
      if (a.drop) { args.push('--drop', a.drop); edits.push(`drop ${a.drop}`); }
      if (a.move) { args.push('--move', a.move); edits.push(`move ${a.move}`); }
      if (a.trim != null && Number.isFinite(Number(a.trim))) { args.push('--trim', String(a.trim)); edits.push(`trim→${a.trim}s`); }
      if (!edits.length) return { text: resultText('no edit requested — pass splitAt / drop / move / trim (summary shown)', 'edit') };
      args.push(...(a.apply ? ['--apply'] : ['--dry-run']));
      if (a.root) args.push('--root', a.root);
      const r = await runCvs(args);
      return { isError: !r.ok, text: resultText(r.text.slice(-4000), `edit [${edits.join(', ')}] exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_qa',
    description: '成片双闸质检（视频 + 音频一次跑完；任一 FAIL 即整体 FAIL）。',
    inputSchema: { type: 'object', properties: { videoPath: { type: 'string' }, planPath: { type: 'string' }, strict: { type: 'boolean' } }, required: ['videoPath'] },
    run: async (a) => {
      // S0-1（内审 F1）：planPath 此前当**位置参数**传——qa.mjs 只认 --plan，
      // 帧数/切点/占位页检查静默不跑还返回全绿。现在显式旗标传递。
      const args = ['qa', a.videoPath, ...(a.planPath ? ['--plan', a.planPath] : []), ...(a.strict ? ['--strict'] : [])];
      const r = await runCvs(args, { timeoutSeconds: 900 });
      return { isError: !r.ok, text: resultText(r.text.slice(-6000), `qa exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_ship',
    description: '交付打包：spec+成片+字幕+清单+README 打 zip（--check 先过双闸）。',
    inputSchema: { type: 'object', properties: { specPath: { type: 'string' }, check: { type: 'boolean' } }, required: ['specPath'] },
    run: async (a) => {
      const r = await runCvs(['ship', a.specPath, ...(a.check ? ['--check'] : [])]);
      return { isError: !r.ok, text: resultText(r.text.slice(-4000), `ship exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_demo',
    description: '导演演示集一键出片（白模/骨骼/L-system/喷泉/地形/网络/generative…），manifest 如实报账。',
    inputSchema: { type: 'object', properties: { styleId: { type: 'string' }, seconds: { type: 'number' }, platform: { type: 'string', enum: ['mp4', 'gif', 'webm'] } }, required: ['styleId'] },
    run: async (a) => {
      const args = ['demo', a.styleId];
      if (Number.isFinite(Number(a.seconds))) args.push('--seconds', String(a.seconds));
      if (a.platform) args.push('--platform', a.platform);
      const r = await runCvs(args, { timeoutSeconds: 900 });
      return { isError: !r.ok, text: resultText(r.text.slice(-4000), `demo exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_image',
    description: '从 spec 出图集（封面/卡片/海报/故事图）——艺术静帧，走同一确定性渲染链。',
    inputSchema: { type: 'object', properties: {
      specPath: { type: 'string', description: 'spec 路径（与 page/theme 二选一）' },
      page: { type: 'string', description: '直接指定页面模板（如 templates/recipe-guofeng.html），配合 theme 使用' },
      theme: { type: 'string', description: '主题 id（--page 模式下）' },
      set: { type: 'string', description: '预设组合，默认 cover,card,poster,story；可 cover,poster 等' },
      at: { type: 'number', description: '采样时刻（秒，默认各预设自带）' },
      outPath: { type: 'string', description: '输出目录（默认 out/images；不同片之间建议隔离）' },
    } },
    run: async (a) => {
      const args = ['image'];
      if (a.specPath) args.push('--spec', a.specPath);
      else if (a.page) { args.push('--page', a.page); if (a.theme) args.push('--theme', a.theme); }
      else return { isError: true, text: '需要 specPath 或 page(+theme)' };
      if (a.set) args.push('--set', a.set);
      if (a.at != null && Number.isFinite(Number(a.at))) args.push('--at', String(a.at));
      if (a.outPath) args.push('--out', a.outPath);
      const r = await runCvs(args, { timeoutSeconds: 600 });
      return { isError: !r.ok, text: resultText(r.text.slice(-4000), `image exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_taste',
    description: '确定性审美闸（S1）：规则表驱动，error 硬闸 / warning 扣分 / advisory 只列示；同 spec 同分数可回归。误判走 waivers，绝不为过闸改阈值。',
    inputSchema: { type: 'object', properties: {
      specPath: { type: 'string' },
      strict: { type: 'boolean', description: 'warning 也拦（exit 13）' },
      waiversPath: { type: 'string', description: '豁免文件（默认 <root>/.cvs/waivers.json）' },
    }, required: ['specPath'] },
    run: async (a) => {
      const args = ['taste', a.specPath, ...(a.strict ? ['--strict'] : []), ...(a.waiversPath ? ['--waivers', a.waiversPath] : []), '--json'];
      const r = await runCvs(args, { timeoutSeconds: 120 });
      return { isError: !r.ok, text: resultText(r.text.slice(-6000), `taste exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_caption',
    description: '本地词级字幕（faster-whisper）：同输入缓存复用；--into 把段映射进 spec.audio.vo（含 words[]），非确定性只活在产文件那一刻。',
    inputSchema: { type: 'object', properties: {
      media: { type: 'string', description: '音频/视频路径（识别模式）' },
      applyJson: { type: 'string', description: '已产 caption JSON（注入模式，配 into）' },
      into: { type: 'string', description: '注入目标 spec.json' },
      replaceVo: { type: 'boolean', description: 'spec 已有 vo 时确认覆盖' },
      model: { type: 'string', description: 'whisper 模型（默认 large-v3；离线指本地目录）' },
      language: { type: 'string', description: 'zh/en/auto（默认 auto）' },
    } },
    run: async (a) => {
      const args = [];
      if (a.applyJson) {
        if (!a.into) return { isError: true, text: '注入模式需要 into <spec.json>' };
        args.push('--apply', a.applyJson, '--into', a.into, ...(a.replaceVo ? ['--replace-vo'] : []));
      } else if (a.media) {
        args.push(a.media);
        if (a.model) args.push('--model', a.model);
        if (a.language) args.push('--language', a.language);
      } else return { isError: true, text: '需要 media（识别）或 applyJson+into（注入）' };
      const r = await runCvs(['caption', ...args], { timeoutSeconds: 1800 });
      return { isError: !r.ok, text: resultText(r.text.slice(-4000), `caption exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_attest',
    description: 'G9 产物哈希证书 + 跨机重放验证：产证书 = 容器 sha256 + framemd5 逐帧摘要 + toolchain 指纹 + 段哈希（digest 不含时间戳，跨机重算可比）；verifyPath 给出另一机/另一份成片时离线分层复核——帧同容器异=mux 抖动(pass-with-note)，帧异=真像素漂移(FAIL, exit 13)。',
    inputSchema: { type: 'object', properties: {
      videoPath: { type: 'string', description: '成片 mp4 路径' },
      verifyPath: { type: 'string', description: '已有 attestation.json → 复核模式' },
      manifestPath: { type: 'string', description: 'render-manifest.json（默认自动找 <mp4 目录>/）' },
      planPath: { type: 'string', description: 'plan.json（段哈希权威顺序）' },
      outPath: { type: 'string', description: '证书输出路径（产证书模式，默认 <mp4 同名>.attestation.json）' },
    }, required: ['videoPath'] },
    run: async (a) => {
      const args = ['attest', a.videoPath];
      if (a.verifyPath) args.push('--verify', a.verifyPath);
      if (a.manifestPath) args.push('--manifest', a.manifestPath);
      if (a.planPath) args.push('--plan', a.planPath);
      if (a.outPath && !a.verifyPath) args.push('--out', a.outPath);
      args.push('--json');
      const r = await runCvs(args, { timeoutSeconds: 600 });
      return { isError: !r.ok, text: resultText(r.text.slice(-6000), `attest exit=${r.exitCode}`) };
    },
  },
  {
    name: 'cvs_health',
    description: '一键全身体检（doctor + 错误码矩阵 + golden 位级基线 + fixture lint）。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const r = await runCvs(['health'], { timeoutSeconds: 900 });
      return { isError: !r.ok, text: resultText(r.text.slice(-6000), `health exit=${r.exitCode}`) };
    },
  },
];

// ── MCP 线协议（最小子集，与官方 SDK 互通）────────────────────────────────

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, res) => send({ jsonrpc: '2.0', id, result: res });
const failReply = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'notifications/initialized':   // 通知无 id，不回复
      return;
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return failReply(id, -32602, `unknown tool: ${params.name}`);
      try {
        const out = await tool.run(params.arguments || {});
        // G5-2：结构化错误码随 result 投影（MCP 客户端忽略未知字段；回归测试据此断言）。
        return reply(id, { content: [{ type: 'text', text: out.text }], isError: !!out.isError, ...(out.code ? { code: out.code } : {}) });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: String(e && e.stack || e) }], isError: true });
      }
    }
    default:
      if (id !== undefined) return failReply(id, -32601, `method not found: ${method}`);
  }
}

// ── stdio 主循环 ────────────────────────────────────────────────────────────
// G5-2：加 isMain 闸——被 import（回归测试直调 TOOLS/assertInsideRoot）时
// 不接管 stdin，否则测试进程会被 readline/stdin 挂住。行为对 CLI 启动不变。
const isMain = (() => {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
})();

if (isMain) {
  const readline = (await import('node:readline')).default.createInterface({ input: process.stdin });
  readline.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return failReply(null, -32700, 'parse error'); }
    try { await handle(msg); } catch (e) { if (msg.id !== undefined) failReply(msg.id, -32603, String(e && e.message || e)); }
  });

  // stdin EOF 即退出（不常驻）
  process.stdin.on('end', () => process.exit(0));
}