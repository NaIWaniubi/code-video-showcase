#!/usr/bin/env node
/**
 * test-mcp-server.mjs — MCP stdio 接口层验收（R20-W）。
 *
 *   node scripts/test-mcp-server.mjs
 *
 * 驱动真实子进程 + 真线协议（newline-delimited JSON-RPC 2.0）：
 *   initialize → tools/list（10 工具 + inputSchema）→ suggest/lint/new 实调
 *   → 未知工具错误码 → stdin EOF 干净退出。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.execPath;
let passed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const child = spawn(BIN, ['mcp/server.mjs'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const waiters = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
      else if (msg.method === 'message') waiters.forEach((w) => w(msg));
    }
  });
  const send = (req) => new Promise((res) => { pending.set(req.id, res); child.stdin.write(JSON.stringify(req) + '\n'); });
  return { child, send };
}

async function rpc(send, id, method, params) {
  return send({ jsonrpc: '2.0', id, method, params: params || {} });
}

(async () => {
  const { child, send } = startServer();
  try {
    // 1) initialize
    let r = await rpc(send, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } });
    assert.equal(r.result.serverInfo.name, 'code-video-showcase');
    assert.ok(r.result.protocolVersion);

    // 2) 通知不产生回复（无 id 的消息不回——此处只验证不崩、流程继续）
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(150);

    // 3) tools/list —— 10 个工具全带 inputSchema
    r = await rpc(send, 2, 'tools/list');
    const names = r.result.tools.map((t) => t.name);
    for (const n of ['cvs_new','cvs_lint','cvs_plan','cvs_build','cvs_edit','cvs_suggest','cvs_qa','cvs_ship','cvs_demo','cvs_health']) {
      assert.ok(names.includes(n), `缺工具 ${n}`);
    }
    assert.ok(r.result.tools.every((t) => t.inputSchema && t.inputSchema.properties), '每个工具都要有 inputSchema');

    // 4) cvs_suggest —— 内核直调，瞬时
    r = await rpc(send, 3, 'tools/call', { name: 'cvs_suggest', arguments: { specPath: 'fixtures/mini-41s/spec.json' } });
    assert.equal(r.result.isError, false);
    assert.match(r.result.content[0].text, /cuts:/);
    assert.match(r.result.content[0].text, /r01-card/);

    // 5) cvs_lint —— fixture 过 lint
    r = await rpc(send, 4, 'tools/call', { name: 'cvs_lint', arguments: { specPath: 'fixtures/mini-41s/spec.json' } });
    assert.equal(r.result.isError, false, r.result.content[0].text.slice(-400));

    // 6) cvs_new —— 内核直调，自然语言 → spec
    r = await rpc(send, 5, 'tools/call', { name: 'cvs_new', arguments: { text: '做一条 20 秒赛博竖屏宣传片' } });
    assert.equal(r.result.isError, false);
    assert.match(r.result.content[0].text, /spec 已生成/);

    // 7) 未知工具 → -32602
    r = await rpc(send, 6, 'tools/call', { name: 'no_such_tool', arguments: {} });
    assert.equal(r.error.code, -32602);

    // 8) 未知方法 → -32601
    r = await rpc(send, 7, 'no_such_method', {});
    assert.equal(r.error.code, -32601);

    passed++;
    console.log('PASS  MCP 全套线协议握手 + 10 工具 + 实调（suggest/lint/new）+ 错误码 + EOF');
  } finally {
    child.stdin.end();          // EOF → server 应干净退出
    const code = await new Promise((res) => child.on('exit', res));
    assert.equal(code, 0, `EOF 后应 exit 0，实际 ${code}`);
  }
  console.log(`\n${passed} checks passed`);
  if (passed === 0) process.exit(1);
})().catch((e) => { console.error('\n[mcp-test fatal]', e); process.exit(1); });