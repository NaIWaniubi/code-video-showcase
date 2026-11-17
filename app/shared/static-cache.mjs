/**
 * static-cache.mjs — 各界面静态服务的统一 Cache-Control 策略。
 *
 * 为什么单独一份：以前 ui/frames 用「字体 10min、模板/资源 2min、HTML no-store」，
 * 而 wizard/script/versions 单起时全资源 no-store——同一 URL 两套行为，字体二进制
 * 与 1MB 的 /shared/fonts.css 在老入口每次开页重下（R3-审计 RT-03 #6/#7）。
 * 收敛到这一处常量后，任何入口任何路径策略一致。
 */
export const staticCacheControl = (file, pathname) => {
  // 字体与字体声明表是仓库内大体积二进制/样式（woff2 28MB、fonts.css ~1MB）：
  // 内容只在发版时变，给 10 分钟缓存。
  if (/\.(woff2?|ttf|otf)$/i.test(pathname)) return 'public, max-age=600';
  if (pathname === '/shared/fonts.css') return 'public, max-age=600';
  // 页面用的模板/依赖/预览图：iframe 池反复载，2 分钟短缓存足够。
  if (/^\/(templates|node_modules|assets)\//.test(pathname)) return 'public, max-age=120';
  // 其余（HTML、JS、CSS 等可编辑源）永远 no-store，改完刷新即见。
  return 'no-store';
};