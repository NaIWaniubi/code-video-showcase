#!/usr/bin/env node
/**
 * test-bypass-security.mjs — G5「安全旁路收口」回归套件（2026-11 安全审计，纯 Node）。
 *
 * 固化 G5-1…G5-7 七条 finding 的复现载荷 → 修复后必须失效。与
 * scripts/test-spec-security.mjs 同尺：载荷直给、闸门直断、零宽容。
 * 安全口径：宁可拒服务不可静默放行——测试同时锁「放行合法输入」不误伤。
 *
 * 覆盖：
 *  G5-1 film-export：spec→film.html/页面壳的 XSS 载荷必须转义失效；
 *       写盘入口 deepValidate（含 validateSpec）拒非法 spec 且不留文件。
 *  G5-2 mcp cvs_new：outPath 相对穿越/绝对路径/realpath 逃逸 → E_OUTPATH_ESCAPE。
 *  G5-3 api.mjs：一进程多 server 时 CORS 白名单与 token 必须实例隔离。
 *  G5-4 wizard serve：analyze-ref 的 Origin/Host 闸、Content-Length 预检、
 *       并发闸、mkdtemp+'wx' 临时文件、split(/\r?\n/) 行切修复。
 *  G5-5 again --set：__proto__/constructor/prototype 与超大数组索引 → E_SET_UNSAFE_PATH。
 *  G5-6 deliver VTT/SRT：文案换行不得伪造 cue 行。
 *  G5-7 concat-and-encode.sh：DURATION/FPS 非数 exit 2，不进算术/解释器插值。
 *
 * 退出码 0/1。除 wizard（自管子进程）与 bash（G5-7）外零外部依赖。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let passed = 0;
let failed = 0;
const asyncTests = [];
function test(name, fn) { asyncTests.push([name, fn]); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cvs-bypass-sec-'));
const tmp = (...p) => path.join(TMP, ...p);

/** 读 fixtures/mini-41s 的最小合法 spec（与 test-film-export 同源）。 */
function miniSpec(mutate = () => {}) {
  const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'mini-41s', 'spec.json'), 'utf8'));
  mutate(s);
  return s;
}

// ── G5-1 film-export：HTML/script 注入 ──────────────────────────────────────

const XSS_QS = 'templates/segment.html?a=x" onerror="alert(1)';
const XSS_ID = 'r01</script><img src=x onerror=alert(2)>';

const film = await import('./lib/film-export.mjs');

test('G5-1 buildFilmHtml：page 查询串的引号转义失效（不能逃出 src 属性）', () => {
  const html = film.buildFilmHtml(miniSpec((s) => { s.opening.page = XSS_QS; }));
  const line = html.split('\n').find((l) => l.includes('<section') && l.includes('00-opening'));
  assert.ok(line, 'opening section 存在');
  // 载荷特征：属性逃逸后的裸 onerror="…"；转义后只能是 &quot;
  assert.ok(!/&lt;|" onerror="/.test(line.replace(/&quot;/g, '')), `属性逃逸未挡住: ${line}`);
  assert.ok(line.includes('a=x&quot; onerror=&quot;alert(1)'), '查询串应实体化');
  // iframe src 属性必须完整闭合：行内双引号计数为偶数是属性结构的最低要求
  assert.equal((line.match(/"/g) || []).length % 2, 0, 'src 属性引号不配对');
});

test('G5-1 buildFilmHtml：id 的 </script> 载荷在属性里实体化', () => {
  const html = film.buildFilmHtml(miniSpec((s) => { s.rounds[0].id = XSS_ID; }));
  const idx = html.indexOf('-card"');
  assert.ok(idx > 0);
  const ctx = html.slice(html.indexOf('<section', idx - 300), html.indexOf('</section>', idx) + 10);
  assert.ok(!/onerror=alert\(2\)&gt;"|<img src=x onerror=alert\(2\)>/.test(ctx), `id 逃逸未挡住: ${ctx}`);
  assert.ok(ctx.includes('&lt;/script&gt;&lt;img'), 'id 必须整体实体化');
});

test('G5-1 writeFilmProject：入口 deepValidate 拒非法 id 的 spec，且一个文件都不留', () => {
  const outDir = tmp('g5-1-reject');
  assert.throws(
    () => film.writeFilmProject(miniSpec((s) => { s.rounds[0].id = XSS_ID; }), { outDir, root: ROOT }),
    (e) => e.code === 'E_SPEC' && /E_ROUND_ID/.test(String(e.issues && JSON.stringify(e.issues))),
    '必须以 E_SPEC（含 E_ROUND_ID）拒绝',
  );
  assert.ok(!fs.existsSync(outDir), '被拒 spec 不得留下任何输出目录');
});

test('G5-1 writeFilmProject：远程页面 spec 同样在入口被拒（E_PAGE_REMOTE）', () => {
  const outDir = tmp('g5-1-remote');
  assert.throws(
    () => film.writeFilmProject(miniSpec((s) => { s.opening.page = 'http://169.254.169.254/latest/meta-data/'; }), { outDir, root: ROOT }),
    (e) => e.code === 'E_SPEC',
  );
  assert.ok(!fs.existsSync(outDir), '远程页 spec 不得落盘');
});

test('G5-1 writeFilmProject：validateSpec 放行不了的载荷进不了写盘路径；合法载荷进页面壳必须转义', () => {
  const outDir = tmp('g5-1-pages');
  // 查询串载荷不影响页面存在性判定 → spec 合法，导出必须发生且两处产物都已转义
  const res = film.writeFilmProject(miniSpec((s) => { s.opening.page = XSS_QS; }), { outDir, root: ROOT });
  assert.ok(res.pages > 0, '合法 spec 正常导出（闸门不误伤）');
  const shell = fs.readFileSync(path.join(outDir, 'pages', '00-opening.html'), 'utf8');
  assert.ok(!shell.includes(`src="${XSS_QS}`), '页面壳 src 不得裸拼载荷');
  assert.ok(shell.includes('a=x&quot; onerror=&quot;alert(1)'), '页面壳查询串已实体化');
  const clipLine = shell.split('\n').find((l) => l.includes('window.__clip'));
  assert.ok(clipLine.includes('id: "00-opening"'), '内联 script 的 id 正常');
  assert.equal((shell.match(/<script/g) || []).length, (shell.match(/<\/script>/g) || []).length, 'script 标签配对');
});

test('G5-1 jsString：内联 <script> 上下文的 id 含 </script> 必须 \u003c 化（页壳 __clip）', () => {
  // 页面壳 `window.__clip = { id: <jsString> }` 是内联脚本上下文：esc() 的 &lt;
  // 在这里不是 JS 转义；JSON.stringify 原样保留 </script> 会先闭合 <script> 标签
  // （复现载荷 id 含 </script><img onerror=…>）。函数导出供单元级直测；
  // 写盘路径另有 deepValidate 前置闸（上条已证非法 id 到不了这里）。
  const raw = 'r01</script><img src=x onerror=alert(2)>';
  const out = film.jsString(raw);
  assert.ok(!out.includes('</script'), `jsString 未转义 </script>: ${out}`);
  assert.ok(out.includes('\\u003c/script\\u003e'), '应转为 \\u003c 形式');
  assert.deepEqual(JSON.parse(out), raw, '转义结果必须仍是原值的合法表示（不破坏数据）');
  const sep = 'a' + String.fromCharCode(0x2028) + 'b';
  assert.ok(film.jsString(sep).includes('\\u2028'), 'U+2028 应转为 \u2028 文本形式');
  assert.deepEqual(JSON.parse(film.jsString(sep)), sep, 'U+2028 转义同样不破坏数据');
});

// ── G5-2 mcp/server.mjs：cvs_new outPath ────────────────────────────────────

const mcp = await import('../mcp/server.mjs');

test('G5-2 assertInsideRoot：../../ 穿越拒（E_OUTPATH_ESCAPE）', () => {
  assert.throws(() => mcp.assertInsideRoot(ROOT, '../../outside/x.spec.json'), (e) => e.code === 'E_OUTPATH_ESCAPE');
});

test('G5-2 assertInsideRoot：盘外绝对路径拒（C:/Windows/...）', () => {
  assert.throws(() => mcp.assertInsideRoot(ROOT, process.platform === 'win32' ? 'C:/Windows/Tmp/x.spec.json' : '/etc/cvs-x.json'), (e) => e.code === 'E_OUTPATH_ESCAPE');
});

test('G5-2 assertInsideRoot：仓库内深路径放行并给出真实路径', () => {
  const p = mcp.assertInsideRoot(ROOT, path.join('out', 'g5-2-deep', 'nested', 'x.spec.json'));
  assert.ok(path.isAbsolute(p));
  assert.ok(p.startsWith(fs.realpathSync(ROOT)) || p.startsWith(path.resolve(ROOT)));
});

test('G5-2 cvs_new 工具层：逃逸 outPath 返回结构化 error（code=E_OUTPATH_ESCAPE），不落盘', () => {
  const tool = mcp.TOOLS.find((t) => t.name === 'cvs_new');
  return tool.run({ text: '30秒赛博宣传片', outPath: '../../cvs-sec-probe-should-not-exist/spec.json' }).then((r) => {
    assert.equal(r.isError, true);
    assert.equal(r.code, 'E_OUTPATH_ESCAPE');
    assert.ok(!fs.existsSync(path.resolve(ROOT, '..', '..', 'cvs-sec-probe-should-not-exist')), '逃逸目录不得被创建');
  });
});

test('G5-2 cvs_new：仓库内 outPath 正常写盘（闸门不误伤）', () => {
  const tool = mcp.TOOLS.find((t) => t.name === 'cvs_new');
  const rel = 'out/g5-2-ok.spec.json';
  return tool.run({ text: '30秒赛博宣传片', outPath: rel }).then((r) => {
    assert.equal(r.isError, undefined, r.text);
    assert.ok(fs.existsSync(path.resolve(ROOT, rel)), 'in-root 写入成功');
    fs.rmSync(path.resolve(ROOT, rel), { force: true });
  });
});

// ── G5-3 server/api.mjs：实例隔离 ───────────────────────────────────────────

const { createJobServer } = await import('../server/api.mjs');

function getJson(server, { path: p = '/health', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
  });
}

test('G5-3 一进程双 server：A 带 --cors、B 不带，B 不得对 A 的 origin 回 ACAO', async () => {
  const a = createJobServer({ cors: 'http://g5a.example', outDir: tmp('api-a') });
  const b = createJobServer({ outDir: tmp('api-b') });
  await new Promise((r) => a.listen(0, '127.0.0.1', r));
  await new Promise((r) => b.listen(0, '127.0.0.1', r));
  try {
    const rb = await getJson(b, { headers: { origin: 'http://g5a.example' } });
    assert.equal(rb.headers['access-control-allow-origin'], undefined, `B 泄漏了 A 的 CORS 白名单: ${JSON.stringify(rb.headers)}`);
    const ra = await getJson(a, { headers: { origin: 'http://g5a.example' } });
    assert.equal(ra.headers['access-control-allow-origin'], 'http://g5a.example', 'A 自己的白名单仍生效');
  } finally {
    await new Promise((r) => a.close(r)); await new Promise((r) => b.close(r));
  }
});

test('G5-3 token 实例隔离：带 token 的 C 拒无凭证请求，不涉他实例', async () => {
  const c = createJobServer({ token: 'g5-secret', outDir: tmp('api-c') });
  const plain = createJobServer({ outDir: tmp('api-plain') });
  await new Promise((r) => c.listen(0, '127.0.0.1', r));
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  try {
    const rc = await getJson(c);
    assert.equal(rc.status, 401, 'token 实例必须 401');
    assert.equal(rc.body.includes('E_AUTH'), true);
    const rp = await getJson(plain);
    assert.equal(rp.status, 200, 'token 不得外溢到无 token 实例（旧版模块级 AUTH_TOKEN 会）');
  } finally {
    await new Promise((r) => c.close(r)); await new Promise((r) => plain.close(r));
  }
});

test('G5-3 静态防线：api.mjs 不得再出现模块级 ALLOWED_ORIGINS/AUTH_TOKEN 可变单例', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'api.mjs'), 'utf8');
  assert.ok(!/^let\s+ALLOWED_ORIGINS\b/m.test(src), 'ALLOWED_ORIGINS 又变回模块级 let 了');
  assert.ok(!/^let\s+AUTH_TOKEN\b/m.test(src), 'AUTH_TOKEN 又变回模块级 let 了');
});

// ── G5-4 wizard serve.mjs：analyze-ref 闸门 ─────────────────────────────────

/** 起一份真实 wizard serve.mjs（port=0 让 OS 分配），解析它打印的实际端口。 */
function startWizard() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'app', 'wizard', 'serve.mjs'), '--port', '0'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let buf = '';
    let done = false;
    const onData = (d) => {
      buf += String(d);
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m && !done) { done = true; clearTimeout(t); resolve({ child, port: Number(m[1]) }); }
    };
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      reject(new Error(`wizard 启动超时:\n${buf}`));
    }, 15000);
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { if (!done) { done = true; clearTimeout(t); reject(new Error(`wizard 启动即退出 code=${code}`)); } });
  });
}

test('G5-4 analyze-ref：跨源 Origin 必须 403 E_ORIGIN（复现前是 400/直通）', async () => {
  const { child, port } = await startWizard();
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/analyze-ref',
        headers: { origin: 'http://evil.example', 'content-type': 'multipart/form-data; boundary=x' } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, d })); });
      req.on('error', reject); req.end('--x--\r\n\r\n');
    });
    assert.equal(r.status, 403, `期望 403，实得 ${r.status}: ${r.d}`);
    assert.ok(r.d.includes('E_ORIGIN'), r.d);
  } finally { child.kill('SIGKILL'); }
});

test('G5-4 analyze-ref：Host 非回环必须 403 E_HOST（DNS rebinding 面）', async () => {
  const { child, port } = await startWizard();
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/analyze-ref',
        headers: { host: 'evil.example', 'content-type': 'multipart/form-data; boundary=x' } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, d })); });
      req.on('error', reject); req.end('--x--\r\n\r\n');
    });
    assert.equal(r.status, 403, `期望 403，实得 ${r.status}: ${r.d}`);
    assert.ok(r.d.includes('E_HOST'), r.d);
  } finally { child.kill('SIGKILL'); }
});

test('G5-4 analyze-ref：天文 Content-Length 收到 413，一个字节不陪跑', async () => {
  const { child, port } = await startWizard();
  try {
    // 裸 socket 发「声明 1TB、实际不发 body」的请求——http.request 客户端自己
    // 就会因 Content-Length 不匹配报错，测不到服务端预检。旧版无预检：请求挂在
    // 监听器上白占资源（复现时 curl 版直接挂死终端）。
    const r = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      let buf = '';
      const t = setTimeout(() => { sock.destroy(); reject(new Error('413 预检未即时返回（旧版会挂起）')); }, 6000);
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        const m = /HTTP\/1\.[01] (\d{3})/.exec(buf);
        if (m && buf.includes('\r\n\r\n')) { clearTimeout(t); sock.destroy(); resolve({ status: Number(m[1]), body: buf.slice(buf.indexOf('\r\n\r\n') + 4) }); }
      });
      sock.on('error', (e) => { clearTimeout(t); reject(e); });
      sock.end('POST /api/analyze-ref HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nContent-Type: multipart/form-data; boundary=x\r\nContent-Length: 1099511627776\r\n\r\n');
    });
    assert.equal(r.status, 413, `期望 413，实得 ${r.status}: ${r.body}`);
    assert.ok(r.body.includes('E_BODY_TOO_LARGE'), r.body);
  } finally { child.kill('SIGKILL'); }
});

test('G5-4 analyze-ref：并发闸——2 路挂起后第 3 路 429 E_REF_BUSY，释放后恢复', async () => {
  const { child, port } = await startWizard();
  const hanging = [];
  const startHanging = () => new Promise((resolve, reject) => {
    // headers 完整 + 半截 body：服务端已进闸计数但永远等不到 'end'。
    // 不 await 响应（不会有响应），只等 socket 确已连接且写出。
    let done = false;
    const go = () => { if (done) return; done = true; req.write('partial'); resolve(req); };
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/analyze-ref',
      headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '1000000' } });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET' && e.code !== 'ERR_STREAM_DESTROYED') reject(e); });
    req.on('socket', (sock) => { if (sock.writableLength === 0 && !sock.connecting) go(); else sock.on('connect', go); });
    hanging.push(req);
  });
  const post = (body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/analyze-ref',
      headers: { 'content-type': 'multipart/form-data; boundary=x' } },
    (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, d })); });
    req.on('error', reject);
    req.end(body);
  });
  try {
    await startHanging();
    await startHanging();
    await new Promise((r) => setTimeout(r, 300));
    const third = await post('--x--\r\n\r\n');
    assert.equal(third.status, 429, `第 3 路应 429，实得 ${third.status}: ${third.d}`);
    assert.ok(third.d.includes('E_REF_BUSY'), third.d);
    for (const req of [...hanging]) { try { req.destroy(); } catch { /* gone */ } }
    hanging.length = 0;
    await new Promise((r) => setTimeout(r, 400));
    const fourth = await post('junk');
    assert.notEqual(fourth.status, 429, `闸未释放: ${fourth.status}`);
    assert.ok([400, 500].includes(fourth.status), `释放后应回到业务错误，实得 ${fourth.status}`);
  } finally {
    for (const req of hanging) { try { req.destroy(); } catch { /* gone */ } }
    child.kill('SIGKILL');
  }
});

test('G5-4 静态防线：tmp 文件必须 mkdtemp + wx（可预测路径/symlink 覆写不得回潮）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'wizard', 'serve.mjs'), 'utf8');
  assert.match(src, /mkdtempSync\(path\.join\(os\.tmpdir\(\),\s*"cvs-ref-"\)\)/);
  assert.match(src, /fs\.openSync\(\s*tmpPath,\s*"wx"\s*\)/);
  assert.ok(!/"cvs-ref-"\s*\+\s*process\.pid/.test(src), 'pid+Date.now() 可预测路径又回来了');
});

test('G5-4 静态防线：行切必须是正则 split(/\\r?\\n/)（字符串字面量 bug 不得回潮）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app', 'wizard', 'serve.mjs'), 'utf8');
  assert.ok(!src.includes('split("/\\r?\\n/")'), 'split("/\\r?\\n/") 是字符串——从不按行切');
  assert.ok(src.includes('split(/\\r?\\n/)'), '应使用正则 split(/\\r?\\n/)');
});

// ── G5-5 again.mjs --set ────────────────────────────────────────────────────

function runAgain(args, specObj) {
  const sp = tmp('again-spec.json');
  fs.writeFileSync(sp, JSON.stringify(specObj || { specVersion: 1, meta: { name: 'p' }, format: { fps: 30 }, look: {}, rounds: [] }));
  const out = tmp('again-out.json');
  fs.rmSync(out, { force: true });   // 前一条测试的产物不得冒充本条的「已写出」
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'again.mjs'), '--spec', sp, '--out', out, '--no-build', '--root', ROOT, ...args,
  ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  return { ...r, out };
}

test('G5-5 again：meta.__proto__.polluted=1 被拒（E_SET_UNSAFE_PATH），进程原型零污染', () => {
  const r = runAgain(['--set', 'meta.__proto__.polluted=1']);
  assert.equal(r.status, 2, `期望 exit 2，实得 ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /E_SET_UNSAFE_PATH/);
  assert.equal({}.polluted, undefined, 'Object.prototype 被污染了');
  assert.equal({}.polluted2, undefined);
});

test('G5-5 again：constructor/prototype 段同拒', () => {
  for (const k of ['meta.constructor.prototype.x=1', 'look.prototype.y=2', 'format.__proto__=z']) {
    const r = runAgain(['--set', k]);
    assert.equal(r.status, 2, `${k} 应被拒，stderr:\n${r.stderr}`);
    assert.match(r.stderr, /E_SET_UNSAFE_PATH/);
  }
});

test('G5-5 again：数组索引 70000 拒（上限 65535），5 放行', () => {
  const bad = runAgain(['--set', 'rounds.70000.first=x']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /E_SET_UNSAFE_PATH/);
  assert.ok(!fs.existsSync(bad.out), '被拒的 set 不得产出 out');
  const ok = runAgain(['--set', 'rounds.5.first=x']);
  assert.equal(ok.status, 0, ok.stderr);
  const s = JSON.parse(fs.readFileSync(ok.out, 'utf8'));
  assert.equal(s.rounds[5].first, 'x', '合法索引路径功能不回归');
});

test('G5-5 again：正常键（look.theme）照常生效——闸门不误伤', () => {
  const r = runAgain(['--set', 'look.theme=amber-noir']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(r.out, 'utf8')).look.theme, 'amber-noir');
});

// ── G5-6 deliver.mjs VTT/SRT cue 注入 ───────────────────────────────────────

function runDeliverWith(payloadText) {
  const dir = tmp('deliver-g56');
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out', 'master.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({
    specVersion: 1, meta: { title: 'T', locale: 'zh-CN' }, render: { outDir: 'out' },
  }));
  fs.writeFileSync(path.join(dir, 'out', 'plan.json'), JSON.stringify({
    stats: {}, segments: [{ kind: 'style', start: 0, end: 1, copy: { title: payloadText } }],
  }));
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'deliver.mjs'), '--spec', path.join(dir, 'spec.json'), '--root', dir,
  ], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  return { r, dir };
}

test('G5-6 VTT：文案带换行的伪造 cue 被压平成一行（复现载荷）', () => {
  const inj = 'legit\n00:00.000 --> 09:99.000\nWEBVTT FAKE CUE\nStyle: injected';
  const { r, dir } = runDeliverWith(inj);
  assert.equal(r.status, 0, r.stderr);
  const vtt = fs.readFileSync(path.join(dir, 'out', 'master.vtt'), 'utf8');
  // 真 cue 时间轴行有严格形态 HH:MM:SS.mmm --> …；伪造行（缺小时段的
  // 00:00.000 -->）与任何载荷行都不得成「行首」。压平后的注入文本留在
  // 同一条 cue 的正文里，是数据不是语法。
  const realCues = vtt.split('\n').filter((l) => /^\d\d:\d\d:\d\d[.,]\d{3} --> /.test(l));
  assert.equal(realCues.length, 1, `合法时间轴行只能 1 条，实得 ${realCues.length}:\n${vtt}`);
  assert.ok(!/^00:00\.000 -->/m.test(vtt), '伪造 cue 行仍独占一行——压平失守');
  assert.ok(!/^WEBVTT FAKE CUE$/m.test(vtt), '伪造头部行不得成行');
  assert.ok(!/^Style:/m.test(vtt), '伪造 Style 指令行不得成行');
  assert.ok(vtt.includes('legit 00:00.000 --> 09:99.000 WEBVTT FAKE CUE Style: injected'), '载荷应压平进同一条 cue 文本');
});

test('G5-6 SRT：同路径同样压平（BOM+CRLF 转换前清行内换行）', () => {
  const inj = 'ok\r\n2\r\n00:00:00,000 --> 00:00:01,000\r\nFORGED CUE';
  const { r, dir } = runDeliverWith(inj);
  assert.equal(r.status, 0, r.stderr);
  const srt = fs.readFileSync(path.join(dir, 'out', 'master.srt'), 'utf8').replace(/^\uFEFF/, '');
  const cues = srt.split('\r\n\r\n').filter((b) => /\d+\r\n\d\d:/.test(b));
  assert.equal(cues.length, 1, `SRT cue 只能 1 条，实得 ${cues.length}:\n${srt}`);
  assert.ok(!/^FORGED CUE$/m.test(srt));
});

test('G5-6 deliver：干净文案不受影响（闸门不误伤）', () => {
  const { r, dir } = runDeliverWith('普通字幕文案');
  assert.equal(r.status, 0, r.stderr);
  const vtt = fs.readFileSync(path.join(dir, 'out', 'master.vtt'), 'utf8');
  assert.ok(vtt.includes('普通字幕文案'));
});

// ── G5-7 concat-and-encode.sh 数值闸 ────────────────────────────────────────

function sh(cmd, args, opts = {}) {
  return spawnSync('bash', [cmd, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true, ...opts });
}
const BASH_OK = (() => { try { return spawnSync('bash', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0; } catch { return false; } })();

if (!BASH_OK) console.error('[warn] G5-7 跳过：本机无 bash（Git Bash）可用');

test('G5-7 FPS=`a[$(touch proof)]`：算术展开命令替换被数值闸挡住，proof 不生成', () => {
  if (!BASH_OK) return;
  const proof = tmp('g57-proof');
  const seg = tmp('g57-seg.txt'); fs.writeFileSync(seg, '');
  const r = sh(path.join(ROOT, 'templates', 'concat-and-encode.sh'), [seg, tmp('a.wav'), tmp('o.mp4'), '61', `a[$(touch ${proof.replace(/\\/g, '/')})]`]);
  assert.equal(r.status, 2, `期望 exit 2，实得 ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /FPS must be a positive integer/);
  assert.ok(!fs.existsSync(proof), '命令替换被执行了——数值闸失守');
});

test('G5-7 DURATION 带 python 代码片：数值闸 exit 2（不流进 python -c 插值）', () => {
  if (!BASH_OK) return;
  const seg = tmp('g57-seg2.txt'); fs.writeFileSync(seg, '');
  const r = sh(path.join(ROOT, 'templates', 'concat-and-encode.sh'), [seg, tmp('a.wav'), tmp('o.mp4'), '1) or __import__("os"); #']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /DURATION must be a plain decimal number/);
});

test('G5-7 合法数值放行到下一环节（闸不误伤：错误应来自 ffmpeg 而非数值断言）', () => {
  if (!BASH_OK) return;
  const seg = tmp('g57-seg3.txt'); fs.writeFileSync(seg, '');
  const r = sh(path.join(ROOT, 'templates', 'concat-and-encode.sh'), [seg, tmp('a.wav'), tmp('o.mp4'), '61', '30']);
  assert.ok(!/DURATION must be|FPS must be/.test(r.stderr), `合法数值被数值闸误拒:\n${r.stderr}`);
});

// ── 主运行器 ────────────────────────────────────────────────────────────────

for (const [name, fn] of asyncTests) {
  try {
    await fn();
    passed++; console.log(`✓ ${name}`);
  } catch (e) {
    failed++; console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1;
  }
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY：临时目录由 OS 回收 */ }

const total = passed + failed;
console.log(`\n${total} tests: ${passed} passed, ${failed} failed`);
if (total === 0) { console.error('FATAL: 0 tests ran — 视为失败'); process.exitCode = 1; }
process.exit(failed || total === 0 ? 1 : 0);
