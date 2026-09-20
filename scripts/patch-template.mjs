#!/usr/bin/env node
/**
 * 给 vendored template/ 打最小补丁。
 *
 * 为什么单独一个脚本、而不是散在 build 里：
 *   - template/ 是第三方 vendored 代码（SKILL.md 明令普通生成不得修改），
 *     改动必须集中、可审查、可重复执行；
 *   - 本脚本幂等，靠注释标记 / 锚点定位，重复跑不会重复插入；
 *   - 改的是 template/ 这一份源，build 时再拷贝到每个 trip，天然全站生效。
 *
 * 补丁清单（HTML/CSS 用 <!-- build:xxx --> / /* build:xxx *​/ 包裹，便于移除与幂等判定）：
 *   template/index.html   顶部加一个返回首页的链接（build:home-link）
 *   template/index.html   补 favicon（build:favicon）
 *   template/styles.css   返回首页链接的样式（build:home-link）
 *   template/styles.css   移动端每日地图点击热区（build:tap-target）
 *   template/route-ui.js  OSM 底图署名（build:osm-attribution，ODbL 要求各视图可见）
 *   template/styles.css   署名样式（build:osm-attribution）
 *
 * 注意：链接是 ../../ —— 只对 home/site/trips/<slug>/ 这个层级成立。
 * 单独把 template/ 拿去当单站部署时，这个链接会 404（不影响页面其余功能）。
 */
import fs from "node:fs";
import path from "node:path";

import { TEMPLATE_DIR } from "./lib/paths.mjs";
import { createLogger } from "./lib/log.mjs";

const log = createLogger("patch-template");

const MARKER_START = "<!-- build:home-link -->";
const MARKER_END = "<!-- /build:home-link -->";
const FAVICON_START = "<!-- build:favicon -->";
const FAVICON_END = "<!-- /build:favicon -->";
const CSS_MARKER_START = "/* build:home-link */";
const CSS_MARKER_END = "/* /build:home-link */";
const TAP_MARKER_START = "/* build:tap-target */";
const TAP_MARKER_END = "/* /build:tap-target */";
const ATTR_MARKER_START = "/* build:osm-attribution */";
const ATTR_MARKER_END = "/* /build:osm-attribution */";
// route-ui.js 用 JS 注释做幂等标记（该文件不是 CSS/HTML）
const ATTR_JS_MARKER = "build:osm-attribution";

const HOME_LINK_HTML = `${MARKER_START}
  <a class="home-link" href="../../" aria-label="返回全部攻略">← 全部攻略</a>
  ${MARKER_END}`;

// 上游 index.html 没有 favicon，浏览器会去要 /favicon.ico 拿个 404。
// 指到站点根（home/favicon.svg），顺带让每个 trip 页也有站点图标。
const FAVICON_HTML = `${FAVICON_START}
  <link rel="icon" href="../../favicon.svg" type="image/svg+xml">
  ${FAVICON_END}`;

const HOME_LINK_CSS = `${CSS_MARKER_START}
.home-link {
  position: fixed;
  z-index: 60;
  left: 12px;
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
  padding: 7px 14px;
  border: 1px solid var(--line, #dde5e0);
  border-radius: 999px;
  background: var(--surface, #ffffff);
  color: var(--ink-soft, #5b6b62);
  font-size: 13px;
  line-height: 1.4;
  text-decoration: none;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .08);
}
.home-link:hover { color: var(--ink, #1c2b23); }
@media print { .home-link { display: none; } }
${CSS_MARKER_END}
`;

/*
 * 上游在小屏（<=699px）把每日地图的地点圆点缩到 14px（视觉 8px），
 * 手机上只有 ~2.5mm，远低于 WCAG 2.5.8 的 24px 与 Apple HIG 的 44px，实测很难点中。
 *
 * 这里**不动视觉**，只按上游对 .transport-pin 已有的同款做法（::before { inset:-Npx }）
 * 给圆点补一层透明热区：14px + 2×8px = 30px 可点范围，外观与上游完全一致。
 * 放在 patch 里而不是直接改 styles.css，是为了让 vendored 模板的偏离集中、可审查、可重复应用。
 */
const TAP_TARGET_CSS = `${TAP_MARKER_START}
@media (max-width: 699px) {
  .is-daily .map-place-dot::before { content: ""; position: absolute; inset: -8px; border-radius: 50%; }
  .is-daily .transport-pin::before { inset: -5px; }
}
${TAP_MARKER_END}
`;

/*
 * OSM 署名（ODbL 要求可见）。必须**每个视图**都在 ——
 * 上游的 disclaimer 只在总览视图渲染（route-ui.js:116 的每日分支是硬编码文案），
 * 所以署名塞进两个视图共用的 .map-utility 栏里。
 *
 * 只在本区域确实用了真实底图时才显示：成都仍是模板插画底图，给它挂 OSM 署名是**假署名**。
 * 判据取 projection.type（真实底图由 build-real-map.mjs 写成 web-mercator）。
 */
const OSM_LINK = '<a class="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';
const ROUTE_UI_ANCHOR = '<button type="button" data-expand-map="${id}">放大 ↗</button>';
// \${ 转义成字面量 ${，让生成的代码在运行时做判断；${OSM_LINK} 这里就要替换进去
const ROUTE_UI_PATCHED =
  `\${source.projection&&source.projection.type==="web-mercator"?'${OSM_LINK}':''}${ROUTE_UI_ANCHOR}`;

const ATTRIBUTION_CSS = `${ATTR_MARKER_START}
.map-utility .map-attribution {
  /* margin-left:auto 吃掉全部剩余空间，把署名+放大按钮一起顶到右边 */
  margin-left: auto;
  margin-right: 10px;
  color: var(--muted, #5b6b62);
  font-size: 11px;
  text-decoration: none;
  white-space: nowrap;
}
.map-utility .map-attribution:hover { text-decoration: underline; }
@media print { .map-utility .map-attribution { text-decoration: none; } }
${ATTR_MARKER_END}
`;

/*
 * 门票「现场购买」这一档。
 *
 * 上游 ticketRequirement() 只认三种 requirement，其余一律回退成「门票信息」——
 * 但济州牛岛渡轮、城山日出峰这类是**没有预约系统、只能到现场买**的，
 * 标成「购票方式待确认」是错的，回退成「门票信息」又没说清楚要不要提前订。
 * 补一个 onsite-purchase 档，让这类门票的标签如实。
 */
const TICKET_REQ_ANCHOR = '"needs-confirmation": "购票方式待确认"';
const TICKET_REQ_PATCHED = `${TICKET_REQ_ANCHOR},\n    "onsite-purchase": "现场购票（无需预约）"`;

const changes = [];

function patchHtml(file) {
  let html = fs.readFileSync(file, "utf8");
  let changed = false;

  if (!html.includes(FAVICON_START)) {
    const anchor = '<link rel="stylesheet" href="styles.css';
    const at = html.indexOf(anchor);
    if (at < 0) throw new Error(`index.html 中找不到 favicon 插入锚点「${anchor}」，模板结构可能已变`);
    html = `${html.slice(0, at)}${FAVICON_HTML}\n  ${html.slice(at)}`;
    changed = true;
  }

  if (!html.includes(MARKER_START)) {
    const anchor = '<a class="skip-link"';
    const at = html.indexOf(anchor);
    if (at < 0) throw new Error(`index.html 中找不到 home-link 插入锚点「${anchor}」，模板结构可能已变，请人工确认`);
    html = `${html.slice(0, at)}${HOME_LINK_HTML}\n  ${html.slice(at)}`;
    changed = true;
  }

  if (!changed) {
    log.debug("index.html 已是最新补丁状态，跳过");
    return false;
  }
  fs.writeFileSync(file, html, "utf8");
  return true;
}

function patchRouteUi(file) {
  const js = fs.readFileSync(file, "utf8");
  if (js.includes(ROUTE_UI_PATCHED)) {
    log.debug("route-ui.js 已含 OSM 署名，跳过");
    return false;
  }
  if (!js.includes(ROUTE_UI_ANCHOR)) {
    throw new Error(`route-ui.js 中找不到 OSM 署名插入锚点「${ROUTE_UI_ANCHOR}」，模板结构可能已变，请人工确认`);
  }
  fs.writeFileSync(file, js.replace(ROUTE_UI_ANCHOR, ROUTE_UI_PATCHED), "utf8");
  return true;
}

function patchCss(file) {
  let css = fs.readFileSync(file, "utf8");
  let appended = "";
  if (!css.includes(CSS_MARKER_START)) appended += `\n\n${HOME_LINK_CSS}`;
  else log.debug("styles.css 已含 home-link，跳过");
  if (!css.includes(TAP_MARKER_START)) appended += `\n${TAP_TARGET_CSS}`;
  else log.debug("styles.css 已含 tap-target，跳过");
  if (!css.includes(ATTR_MARKER_START)) appended += `\n${ATTRIBUTION_CSS}`;
  else log.debug("styles.css 已含 osm-attribution，跳过");
  if (!appended) return false;
  fs.writeFileSync(file, `${css.trimEnd()}${appended}`, "utf8");
  return true;
}

function patchAppJs(file) {
  const js = fs.readFileSync(file, "utf8");
  if (js.includes(TICKET_REQ_PATCHED)) {
    log.debug("app.js 已含 onsite-purchase 档，跳过");
    return false;
  }
  if (!js.includes(TICKET_REQ_ANCHOR)) {
    throw new Error(`app.js 中找不到门票档位插入锚点「${TICKET_REQ_ANCHOR}」，模板结构可能已变，请人工确认`);
  }
  fs.writeFileSync(file, js.replace(TICKET_REQ_ANCHOR, TICKET_REQ_PATCHED), "utf8");
  return true;
}

const done = log.phase("打模板补丁");

for (const [rel, fn] of [["index.html", patchHtml], ["styles.css", patchCss], ["route-ui.js", patchRouteUi], ["app.js", patchAppJs]]) {
  const file = path.join(TEMPLATE_DIR, rel);
  if (!fs.existsSync(file)) {
    log.error(`缺少 ${rel}，跳过`);
    continue;
  }
  const changed = fn(file);
  changes.push(`${rel}:${changed ? "已修改" : "无变化"}`);
}

done(changes.join(" "));

if (changes.every((c) => c.endsWith("无变化"))) {
  log.info("补丁已是目标状态，无需改动");
} else {
  log.info("已修改 template/，请重新 npm run build 让各 trip 生效");
}
log.summary({ 文件: changes.length, 改动: changes.filter((c) => c.includes("已修改")).length });
log.close();
