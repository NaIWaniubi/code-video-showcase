# CVS 安全审计 — G5「安全旁路收口」报告

> **方法论**：CF 审计口径（三判决 / 覆盖账本 / 验证者≠发现者，ROADMAP-OVERTAKE S7-1 交付物）。
> **基线**：v4.10.1（`ship-test.spec-2026-11-22` 后的 main 工作树）。
> **审计执行日期**：发现与复现 2026-11-23（安全审计席）；修复与本状态表 2026-11-23（G5 builder）。
> **执行边界**：全部复现仅在本地回环服务与一次性临时目录内进行；复现产物（逃逸目录、
> proof 文件、注入 VTT）均已删除。未触碰部署端点、外部服务与真实凭据。

## 0. 三判决口径

| 判决 | 含义 |
|---|---|
| **CONFIRMED** | 越过了真实信任边界，复现载荷在本机打出效果，证据在案 |
| **REFUTED** | 候选被针对性验证为不成立（输入到不了该面 / 已有闸挡住并实测） |
| **NEEDS-VALIDATION** | 决定性事实超出本次源码+沙箱复现能力，如实挂账不判 |

修复状态另记：`fixed@G5`（本切片修复+回归）、`pending@G2`（已移交、不在本域）、`open`。

## 1. 判决清单（8 条本切片 + 1 条移交）

安全口径统一为**宁可拒服务，不可静默放行**；每条修复均配「闸门不误伤」正向用例。

### F-01 [P1 · CONFIRMED · fixed@G5] film 导出 HTML/内联 script 注入
- **位置**：`scripts/lib/film-export.mjs`（原 :92 `page.split('?')[1]` 裸拼进 `src` 属性；:153 `String(s.page)` 裸拼进页壳 `src`；:154 `JSON.stringify(id)` 直插 `<script>`）。
- **信任边界**：spec.json 是不可信输入（表单/agent/上传），产物 film.html / pages/*.html 是浏览器直开文件。
- **复现（修前）**：载荷 `templates/segment.html?a=x" onerror="alert(1)` 与 round id `r01</script><img src=x onerror=alert(2)>`——导出产物中事件处理器成对逃逸属性、`</script>` 原样截断内联脚本。
- **修法**：入口 `writeFilmProject` 先过 `deepValidate`（内含 `validateSpec` 纯逻辑闸）error 即拒且不留任何文件；字符串层三处全部过 `esc()`，`<script>` 上下文用新增 `jsString()`（`JSON.stringify` + `<`→`\u003c`、`>`→`\u003e`、U+2028/2029 转义）；`format.width/height/fps` 数值钳制 `num()`。`scripts/film.mjs` 把 `--root` 传入校验基准（此前是死参数）。
- **回归证据**：`scripts/test-bypass-security.mjs` G5-1 六条（属性逃逸 / id 实体化 / 入口拒非法 id 且零落盘 / 远程页入口拒 / 合法载荷页壳转义 / jsString 单元直测）。

### F-02 [P1 · CONFIRMED · fixed@G5] cvs_new outPath 任意写（路径穿越 + 绝对路径）
- **位置**：`mcp/server.mjs` `cvs_new`（原 :85-88 `path.resolve(ROOT,p)` 后直接 mkdir+写）。
- **信任边界**：MCP 工具参数由任意接入 agent 控制；ROOT 是本仓库目录约束。
- **复现（修前）**：`outPath="../../outside"` 实际写出 `E:\…\workspace\cvs-escape-probe\spec.json`（仓库外两级）；`C:/Windows/Tmp/…` 仅因 OS EPERM 侥幸失败——有写权限的任何绝对路径（如用户启动目录）都会命中。
- **修法**：新增导出 `assertInsideRoot(ROOT, p)`：①语法 `isInside`；②`fs.realpath` 目标（不存在则逐级解析最近已存在祖先再拼回）防 symlink 外引。越界返回结构化 error `code:E_OUTPATH_ESCAPE`（随 MCP result 投影）；`mcp/server.mjs` 加 isMain 闸使模块可被测试安全 import（CLI 行为不变）。
- **回归证据**：G5-2 五条（穿越拒 / 盘外绝对路径拒 / 仓内深路径放行 / 工具层结构化码+零落盘 / 仓内正常写）。错误码已注册（`schema/errors.json`、`docs/ERRORS.md`）。

### F-03 [P2 · CONFIRMED · fixed@G5] api.mjs CORS/Token 模块级单例跨实例泄漏
- **位置**：`server/api.mjs`（原 :56/:58 `let ALLOWED_ORIGINS`/`let AUTH_TOKEN`，`createJobServer` 直接覆写）。
- **信任边界**：一进程多 server 是合法用法（本仓 `startServer` 支持并发测试实例）；A 实例的 `--cors` 白名单被 B 实例继承 = 向 B 的调用方泄露并放大 A 的授权。
- **复现（修前）**：同进程建 A（cors=`http://evil-a.example`）+ B（无 cors）——B 对 A 的 origin 回 `Access-Control-Allow-Origin: http://evil-a.example`；token 同理互相污染（先设常不清除）。
- **修法**：白名单/token 收进 `createJobServer` 闭包（`makeCorsHeaders`/`makeAssertRequestOrigin`/`sendJsonWith` 工厂化），模块级 `let` 全删。
- **回归证据**：G5-3 三条（双 server ACAO 隔离 / token 实例隔离 / 静态防线：源码不得再现模块级 `let ALLOWED_ORIGINS|AUTH_TOKEN`）。`test-spec-security.mjs`（import 本模块）与 `server/test-api.mjs`（startServer 路径）接口未变。

### F-04a [P2 · CONFIRMED · fixed@G5] wizard analyze-ref 无 Origin/Host 校验（CSRF/重绑定）
- **位置**：`app/wizard/serve.mjs` POST `/api/analyze-ref`。
- **复现（修前）**：`curl -H 'Origin: http://evil.example'` 直通（400/进业务），任意网页可对回环重管道发 multipart（表单提交不触发预检）；Host 头不校验（DNS rebinding 面）。
- **修法**：`assertWizardWriteOrigin`（复用 `server/api.mjs` 的 `isLoopbackHost`——口径对齐、判定唯一），403 `E_ORIGIN`/`E_HOST`，先于读 body。
- **回归证据**：G5-4 两条（跨源 Origin→403 E_ORIGIN；Host 非回环→403 E_HOST）；同源请求行为不回归（400 E_NO_FILE_PART 等业务码原样）。

### F-04b [P2 · CONFIRMED · fixed@G5] 可预测临时文件 + symlink 跟随覆写
- **位置**：`app/wizard/serve.mjs`（原 `"cvs-ref-"+pid+"-"+Date.now()+ext` + `writeFileSync`）。
- **复现（修前·源码级）**：路径可枚举（pid+时间戳），`writeFileSync` 跟随符号链接——本机上任意用户态进程预放链接即可让上传内容写到链接目标。
- **修法**：`fs.mkdtempSync`（0700 独占目录）+ `fs.openSync(tmpPath,'wx')`（已存在/symlink 直接 EEXIST），spawn 后整目录清理。
- **回归证据**：G5-4 静态防线一条（mkdtemp+wx 模式锁；pid 拼接形态回潮即红）。Windows 非管理员无法稳定建 symlink，行为级用例挂 **NEEDS-VALIDATION**（Linux CI 可补 `ln -s` 用例）。

### F-04c [P2 · CONFIRMED · fixed@G5] 上传无 Content-Length 预检、无并发闸（资源 DoS）
- **复现（修前）**：`curl --data 'x'` + 声明 999GB Content-Length——请求挂在监听器上无限等 body，旧版连响应都难写回（本次复现直接把 shell 挂死到超时）；并发多路各缓 ≤400MB + 各占一路 10 分钟 ffmpeg 链。
- **修法**：入口 Content-Length>400MB 直接 413（一字节不收）；`in-flight` 计数闸 MAX=2，满员 429 `E_REF_BUSY`（新码已注册），响应 close/finish 双路释放。
- **回归证据**：G5-4 两条（裸 socket 天文 CL→即时 413；两路挂起后第三路 429、释放后恢复 400）。附带修复本文件 `--port 0` 被 `||5181` 吞掉的端口解析（测试并发实例的前提）。

### F-04d [P2 · CONFIRMED · fixed@G5] `split("/\r?\n/")` 字符串字面量（功能缺陷）
- **复现（修前·源码级）**：两处按「行」切的调用实为按字面量子串切——stderr 整段进 200 字错误摘要、`--json` 多行 stdout 时 `JSON.parse` 整段必炸成 `E_REF_VIDEO_UNPARSEABLE`。
- **修法**：两处改 `split(/\r?\n/)`。
- **回归证据**：G5-4 静态防线一条（字符串形态回潮即红）。

### F-05 [P3 · CONFIRMED · fixed@G5] `again --set` 原型污染 + 无界数组膨胀
- **位置**：`scripts/again.mjs` `setPath`。
- **复现（修前）**：`--set meta.__proto__.polluted=1` exit 0「applied」——`cur = cur['__proto__']` 落在 `Object.prototype` 后赋值，污染本进程后续全部 JSON 对象（`changed` 判定、`JSON.stringify` 语义都可被带偏）；`--set rounds.200000.first=x` 实测静默 push 20 万项（索引可达 4e9 → OOM）。
- **修法**：全段（含末段）拒绝 `__proto__/constructor/prototype`；数组索引上限 65535；抛错带 `code:E_SET_UNSAFE_PATH`（新码已注册），exit 2，被拒不产出 out 文件。
- **回归证据**：G5-5 四条（proto 载荷拒+原型零污染 / constructor+prototype 同拒 / 70000 拒 5 放行 / 正常键不误伤）。

### F-06 [P3 · CONFIRMED · fixed@G5] VTT/SRT 文案换行伪造 cue 行
- **位置**：`scripts/deliver.mjs` `captionRows` → `master.vtt`/`master.srt`。
- **复现（修前）**：plan 段文案（`copy.title`，或 opening/ending 回退的 `meta.title`）带 `\n` 即产出 `00:00.000 --> 09:99.000`、伪造 `WEBVTT FAKE CUE` 与 `Style:` 指令独立成行（实测文件在案）。
- **修法**：入 cue 前 `text.replace(/[\r\n]+/g,' ')` 压平（SRT/VTT 同一入口，BOM/CRLF 转换之前）；控制字符随 `[\r\n]+` 一并压掉行分隔语义。
- **回归证据**：G5-6 三条（VTT 合法时间轴行恒 1 / SRT 同路径 / 干净文案不误伤）。

### F-07 [P3 · CONFIRMED · fixed@G5] concat-and-encode.sh DURATION/FPS 未验数值 → 命令执行面
- **位置**：`templates/concat-and-encode.sh`（:83-84 取值，:169 `$((FPS*2))`，:222-223 `python -c`/awk 插值）。
- **复现（修前）**：`FPS='a[$(touch proof)]'`——bash 算术展开执行了 `touch`（proof 文件生成在案）；DURATION 载荷 `1) or __import__("os"); #` 可注入 `python -c` 源码（插值实测改变求值）。
- **修法**：取值后入口正则断言：DURATION `^[0-9]+(\.[0-9]+)?$`、FPS `^[0-9]+$` 且 ≥1，非数 exit 2——算术展开与解释器插值永远只收到已验数字。
- **回归证据**：G5-7 三条（FPS 注入拒且 proof 不生成 / DURATION 注入拒 / `61 30` 合法放行到下一环节）。GIF/derived 编码链若复制此模式（`templates/` 其余 .sh）建议下轮按同法抽查——本轮未逐文件复扫，如实记 **NEEDS-VALIDATION**。

### F-08 [P1 · CONFIRMED(审计席) · pending@G2] render-segment IPv4-mapped IPv6 绕过回环判定
- **位置**：`templates/render-segment.mjs`（回环/远程页判定对 `::ffff:a.b.c.d` 形态的处理）。
- **状态**：发现与复现归安全审计席；主线程已移交 **G2**（与哈希 allowlist 骨架一并修）。本 builder 的文件域明令**不得触碰**该文件，故此处只挂账：判决 CONFIRMED（审计席复现）、修复 pending@G2、回归责任在 G2 切片。
- **交接要求**：G2 落地时须带旁路回归（`[::ffff:169.254.169.254]` 形态的页面 URL 不得被当回环放行），并与 F-03 的实例隔离测试互不踩面。

## 2. 覆盖账本（ledger 行 = 攻击面 × 判决 × 核验方法）

审计席已核无问题的清单沿录如下；「核验」列写明判定来源，builder 未重复造轮子但做了标注 ↩︎ 的当日抽查复证。

| # | 攻击面 | 判决 | 核验方法（审计席，2026-11-23） | builder 复证 |
|---|---|---|---|---|
| L1 | 参数注入链（spec→plan→ffmpeg concat 清单/文件名） | REFUTED | 源码走查 `rounds[].id`→段名→`concatList` 全链；载荷 `'a b`、`\nfile x`、`..` 被 validateSpec/plan 双闸拒（E_ROUND_ID/E_PAGE_*） | ↩︎ `test-spec-security.mjs` 34/34 重跑绿 |
| L2 | 模板 DOM（segment/big-card/recipe 页运行 spec 字段） | REFUTED | 审计席清单项（据移交记录）；builder 本轮未逐模板复跑 | — |
| L3 | 静态服务器（wizard/api/file 服务） | CONFIRMED→fixed@G5（F-04a/b/c）+ 其余 REFUTED | `safeResolve` 前缀判定 + 点段一律拒（isDenied）实测 `/.ssh`、`%2e%2e/` 403；analyze-ref 例外即本切片四条 | ↩︎ 走查 serve.mjs L114-128 今日读码 |
| L4 | api 单实例假设（进程内多 server） | CONFIRMED→fixed@G5（F-03） | 见 F-03；`startServer` 对外契约未变，`server/test-api.mjs` 用法兼容 | ↩︎ 本切片以双实例实测（监听 OS 端口） |
| L5 | MCP 读面（specOf/cvs_lint 可指任意路径） | REFUTED（设计内） | stdio 会话即调用方 shell 等权——读权限等同直接 `cat`，无跨边界；写面（cvs_new outPath）即 F-02 已收口 | ↩︎ 读 `specOf` 与工具表确认读面不新增能力 |
| L6 | 深合并（refPatch/segmentPatch/overrides → spec） | REFUTED | 审计席清单项；builder 当日抽验两点：`JSON.parse` 的 `__proto__` 键只成 own-property（不触原型，实测）；`overridesToSpecPatch` 仅写定名字段（读码）。patch 应用主体在 compile.mjs（非本域，未逐行复审） | ↩︎ 见左 |
| L7 | 历史高危复核（audit2 FINDINGS-ROUND2 的 R2-07 page oracle、RT 系列红闸） | REFUTED（修复未回潮） | 对 R2-07 的 `E_PAGE_TRAVERSAL` 闸、RT-04 #1 strict flag 闸做定点重放（非法输入仍非零退出） | ↩︎ `test-strict-flags`/`test-spec-security` 重跑绿 |
| L8 | 许可证抽查（vendor/字体/示例素材） | REFUTED | 审计席清单项（据移交记录），本轮未重抽 | — |
| L9 | `POST /jobs` body → buildPlanFromSpec（api 写面） | REFUTED | 与 L1 同闸；`render.allowRemotePages` 由服务端剥离（api.mjs handleJobsCreate），HTTP 客户端不可自带 | — |
| L10 | errors 注册表一致性 | CONFIRMED（债务在他域）· 本切片零回潮 | `node scripts/errors.mjs --check`：8 个 `E_TASTE_*` 未注册为 HEAD 既有债（taste 车道），本切片新增 `E_OUTPATH_ESCAPE`/`E_SET_UNSAFE_PATH`/`E_REF_BUSY` 已注册并生成进 `docs/ERRORS.md` | ↩︎ 今日 `--check`+`--write` 双跑 |

**账本外显式挂账（NEEDS-VALIDATION）**：F-04b 的 symlink 行为级用例（Windows 权限受限，建议 Linux CI 补）；F-07 的其余 .sh 同模式复扫；render-segment IPv6 回归归 G2。

## 3. 验证者 ≠ 发现者声明

- **发现/复现**：安全审计席（发现者）。
- **修复**：G5 builder（本文件 §1 各 fixed@G5 条目的实现者）。
- **回归证据**：`scripts/test-bypass-security.mjs`（30 用例）由 **修复者本人** 编写运行——按 CF 口径这只构成一级（自证）证据；**二级独立验证待主线程/另一验证席执行**（建议：直接跑该套件 + 对 §1 每条载荷做盲放）。在独立验证完成前，本报告不声明「已验证合规」。
- F-08 修复完成后，验证者须为 G2 之外席次。

## 4. 残余风险与后续（如实记录）

1. `assertInsideRoot` 存在理论 TOCTOU（校验→写盘间换 symlink）；MCP stdio 会话与调用方同权，风险等级低，未上 O_NOFOLLOW 级封堵。
2. wizard `spawnSync` 600s 预算阻塞事件循环（服务期间其它请求排队）——属可用性问题非本批安全项，留待 ROADMAP。
3. `deliver.mjs` 的 `meta.title/cta` 进 delivery.json（JSON 上下文，非语法位）仍保留原换行，本轮按任务口径只封 VTT/SRT 写盘路径。
4. test-all 注册行（主线程合并，本 builder 只报告不改文件）：
   `'scripts/test-bypass-security.mjs',   // G5：安全旁路回归（XSS/逃逸/CORS/原型污染/cue 注入/数值闸），与 test-spec-security 等尺`
   建议插入位置：`UNIT_SUITES` 中 `'scripts/test-trust-fixes.mjs',` 之后。
