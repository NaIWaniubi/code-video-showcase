/**
 * strict-flags.mjs — 用户入口的 flag 白名单解析（R3-审计 RT-04 #1）。
 *
 * 背景：R2-16 只给 `cvs build|compile` 与 `again` 加了 KNOWN_FLAGS，而 plan /
 * deliver / versions / render-farm / render-batch / render-segment 的宽容解析器
 * 仍然静默吞掉未知 flag——`--strik`、`--coer`、`--labell` 一律照常执行并 exit 0，
 * 「忘加 --strict」这类拼写错误会被当成成功结论写进交付判断（正是 R2-16 声称消灭、
 * 只是换了出口的假绿）。
 *
 * 语义：未知 `--flag` → [error] [E_USAGE] + 最邻近已知 flag 建议 + exit 2；
 * 非 `--` 开头的裸 token 保留给子命令位置参数（如 `cvs rollback v001`），不拦。
 */
const LEV_MAX = 3;   // 编辑距离超过 3 不做「did you mean」建议，避免乱猜

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** 从 known 集里挑一个编辑距离最近的名字；没有明显候选返回 null。 */
export function suggestFlag(name, known) {
  let best = null;
  let bestD = LEV_MAX + 1;
  for (const k of known) {
    const d = levenshtein(String(name), String(k));
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= LEV_MAX ? best : null;
}

/**
 * 解析 argv（只认 --flag 形式；positional 原样跳过）。
 * @returns {{args:object, unknown:string[]}}
 */
export function parseStrict(argv, known) {
  const allow = new Set(known);
  const args = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    if (!allow.has(name)) { unknown.push(name); continue; }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[name] = true;
    else { args[name] = next; i++; }
  }
  return { args, unknown };
}

/** 未知 flag 的统一出口：打印原因与建议后以 usage 退出码 2 收工。 */
export function rejectUnknown(programName, unknown, known) {
  const first = String(unknown[0] || '');
  const s = suggestFlag(first, known);
  console.error(`[error] [E_USAGE] unknown flag --${first}` + (s ? ` (did you mean --${s}?)` : ''));
  console.error(`run "${programName} --help" to see the accepted flags`);
  process.exit(2);
}