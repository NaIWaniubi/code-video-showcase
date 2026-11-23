#!/usr/bin/env node
/**
 * test-ssrf-ipv6.mjs — S8/G5 移交修复的回归：allowRemotePages 打开后的
 * IPv4-mapped IPv6 绕过（点分与十六进制两式）与打包整数 IPv4 绕过，导航前必须拦。
 *
 * 旧版裸正则 `127\.` 前缀判据会被 `[::ffff:127.0.0.1]`（Node 归一化为
 * `[::ffff:7f00:1]`）与 `[::ffff:a9fe:a9fe]`（169.254 云元数据）绕过。
 * 退出码 0/1。零依赖。
 */
import assert from 'node:assert/strict';
import { isPrivateHost } from '../templates/render-segment.mjs';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { failed++; console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const priv = [
  'http://127.0.0.1/x',
  'http://[::1]/x',
  'http://[::ffff:127.0.0.1]/x',      // 点分映射
  'http://[::ffff:7f00:1]/x',         // 十六进制映射 = 127.0.0.1（旧版绕过点）
  'http://[::ffff:a9fe:a9fe]/x',      // 169.254.169.254 云元数据（旧版绕过点）
  'http://[::ffff:169.254.169.254]/x',
  'http://[fd00::1]/x',               // ULA
  'http://[fc00::1]/x',
  'http://[::]/x',                    // unspecified
  'http://10.1.2.3/x',
  'http://192.168.0.1/x',
  'http://172.16.5.4/x',
  'http://169.254.169.254/latest/meta-data/',
  'http://0.0.0.0/x',
  'http://2130706433/x',              // 打包十进制 = 127.0.0.1（旧版绕过点）
  'http://0x7f000001/x',              // 打包十六进制 = 127.0.0.1
  'http://localhost/x',
];
const pub = [
  'http://example.com/x.html',
  'http://93.184.216.34/x',           // 公网 IPv4
  'http://[2606:2800:220:1:248:1893:25c8:1946]/x', // 公网 IPv6
  'http://sub.domain.test/a',
];

test('IPv4-mapped IPv6 与打包整数回环/元数据地址全部硬拦', () => {
  for (const u of priv) assert.ok(isPrivateHost(u), `should block ${u}`);
});
test('公网地址不被误拦', () => {
  for (const u of pub) assert.ok(!isPrivateHost(u), `should allow ${u}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
