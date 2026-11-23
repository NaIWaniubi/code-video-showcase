/**
 * summary-parse.mjs — 把测试脚本的历史汇总格式解析成 {total, passed, failed}。
 *
 * 单独成模块是为了能被直接单测：test-all.mjs 有顶层执行副作用，import 它就会跑全套。
 *
 * 仓库里现存五种汇总写法，都必须读对：
 *   "Ran 21 tests: 20 passed, 1 failed"   (server/test-api.mjs)
 *   "34 tests: 32 passed, 2 failed"       (scripts/test-spec-security.mjs)
 *   "33 checks: 32 passed, 1 failed"      (scripts/test-image.mjs)
 *   "51 passed, 4 failed"                 (test-inspect / test-reflow-pages / …)
 *   "22 tests passed"                     (ingest/test-edl.mjs)
 *
 * 退出码 0/1 由调用方按子进程真实 exit 判定；这里只负责计数。
 */

/** 从汇总文本里抽 (passed, failed, total)。抽不到返回 null。 */
export function parseSummary(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 每种格式显式标注语义，**不要**用 m.length 猜：
  // "N passed, M failed" 只有 2 个捕获组（m.length===3），曾被当成「只有 passed」，
  // 于是 failed 被丢成 0、total 被读成 passed —— 报告少报失败断言，CI 上看不出来。
  const patterns = [
    // "Ran" 可选：test-spec-security 打的是 "34 tests: 32 passed, 2 failed"。
    { re: /(?:Ran\s+)?(\d+)\s+tests?:\s*(\d+)\s+passed,\s*(\d+)\s+failed/i, kind: 'total' },
    { re: /(\d+)\s+checks?:\s*(\d+)\s+passed,\s*(\d+)\s+failed/i, kind: 'total' },
    // 中点分隔（test-script）："Ran N tests · X passed · Y failed"。
    { re: /(?:Ran\s+)?(\d+)\s+tests?\s*[·•]\s*(\d+)\s+passed\s*[·•]\s*(\d+)\s+failed/i, kind: 'total' },
    { re: /(\d+)\s+passed,\s*(\d+)\s+failed/i, kind: 'pair' },
    // 反序（ingest/test-edl 失败行）："N failed, M passed"。
    { re: /(\d+)\s+failed,\s*(\d+)\s+passed/i, kind: 'reversed' },
    { re: /(\d+)\s+tests?\s+passed/i, kind: 'all' },
    // 分数（test-nl2spec 成功行）："✓ 20/20"。锚定行尾，避免误匹配用例名。
    { re: /^✓?\s*(\d+)\s*\/\s*(\d+)(?:\s+passed)?$/i, kind: 'fraction' },
    { re: /^(\d+)\s+checks?\s+passed$/i, kind: 'all' },
    { re: /^(\d+)\s+passed$/i, kind: 'all' },
  ];
  // **从后往前**逐行找，而不是在整段尾部文本里取第一个匹配：
  // 测试用例名本身可能含汇总格式字符串（如 "✓ 格式读对：34 tests: 32 passed, 2 failed"），
  // 取第一个匹配会把用例名当成汇总。真实汇总永远是最后一条像汇总的行。
  // G1-2：扫描范围是**全部**输出行，不再截尾 12 行——test-compiler-contract
  // 这类「先打汇总、后面还有晚定义用例」的套件，汇总行距末尾可远超 12 行，
  // 截窗会把真实计数整个漏掉（报告 failed:null 与 ok:false 同屏说谎）。
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const { re, kind } of patterns) {
      const m = lines[i].match(re);
      if (!m) continue;
      if (kind === 'total') {
        const total = Number(m[1]), passed = Number(m[2]), failed = Number(m[3]);
        // 自洽兜底：不管哪种格式，passed+failed 必须等于 total。
        return { total: passed + failed === total ? total : passed + failed, passed, failed };
      }
      if (kind === 'pair') {
        const passed = Number(m[1]), failed = Number(m[2]);
        return { total: passed + failed, passed, failed };
      }
      if (kind === 'reversed') {
        const failed = Number(m[1]), passed = Number(m[2]);
        return { total: passed + failed, passed, failed };
      }
      if (kind === 'fraction') {
        const passed = Number(m[1]), total = Number(m[2]);
        return { total, passed, failed: Math.max(0, total - passed) };
      }
      const n = Number(m[1]);
      return { total: n, passed: n, failed: 0 };
    }
  }
  return null;
}

/**
 * tallySuite — 单套件计数收敛（G1-2 聚合说谎的修复点，test-all.mjs 消费）。
 *
 * 契约（不可协商）：
 *   1. 套件退出码非 0（含 spawn 失败 status=null）⇒ failed 至少 1。
 *      解析不出汇总、或解析到 failed=0 时按 1 计，并标 failedUnparsed=true，
 *      让读报告的人知道这个数字是兜底值而非断言计数。
 *   2. 退出码 0 但输出自报 failed>0 ⇒ 该套件自己在说谎：ok=false、failed 如实计。
 *   3. 行级 ok 与行级 failed 强一致（ok ⇒ failed===0，failed>0 ⇒ !ok），
 *      因此顶层由 rows.every(ok) 与 Σfailed 推出的报告不可能出现
 *      "ok:false 且 failed:0" 或 "ok:true 且 failed>0" 的同屏矛盾。
 *
 * @param {{exit: number|null, parsed: {total:number,passed:number,failed:number}|null}} input
 * @returns {{ok: boolean, failed: number, failedUnparsed: boolean}}
 */
export function tallySuite({ exit, parsed }) {
  const exitOk = exit === 0;
  let failed = parsed ? Number(parsed.failed) || 0 : 0;
  let failedUnparsed = false;
  if (!exitOk && failed < 1) {
    failed = 1;
    failedUnparsed = true;
  }
  return { ok: exitOk && failed === 0, failed, failedUnparsed };
}
