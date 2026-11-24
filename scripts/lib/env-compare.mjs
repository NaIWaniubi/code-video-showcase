/**
 * env-compare.mjs — golden manifest 的环境比对（R3-审计 RT-09 F2）。
 * golden.mjs 无 main 守卫、import 即跑 CLI，所以这个纯函数单独成模块供单测。
 */
export function buildEnvCompare(manifest = {}, env = {}) {
  const cmp = (expected, actual) => ({
    expected: expected ?? null,
    actual: actual ?? null,
    // R2-12（N09-F2）：旧逻辑 `!env.chrome → match:true` 让探测失败变假绿灯。
    // manifest 记了版本而本机探不到 = 环境**未知**，必须按不匹配处理。
    match: !expected || (actual != null && expected === actual),
    reason: !expected ? 'not-recorded' : (actual == null ? 'probe-failed' : (expected === actual ? 'equal' : 'differs')),
  });
  return {
    chrome: cmp(manifest.chrome, env.chrome),
    fonts: cmp(manifest.fonts, env.fonts),
    node: { expected: manifest.node ?? null, actual: env.node },
    platform: { expected: manifest.platform ?? null, actual: env.platform },
  };
}
