#!/usr/bin/env node
/**
 * 给 vendored template/ 打最小补丁：在旅行页顶部加一个「← 全部攻略」返回入口。
 *
 * 为什么单独一个脚本、而不是散在 build 里：
 *   - template/ 是第三方 vendored 代码（SKILL.md 明令普通生成不得修改），
 *     改动必须集中、可审查、可重复执行；
 *   - 本脚本幂等，靠 HTML 注释标记定位，重复跑不会重复插入；
 *   - 改的是 template/ 这一份源，build 时再拷贝到每个 trip，天然全站生效。
 *
 * 补丁清单（全部用 <!-- build:home-link --> ... 包裹，便于移除）：
 *   template/index.html   顶部加一个返回首页的链接
 *   template/styles.css   对应的样式
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

function patchCss(file) {
  let css = fs.readFileSync(file, "utf8");
  if (css.includes(CSS_MARKER_START)) {
    log.debug("styles.css 已含 home-link，跳过");
    return false;
  }
  fs.writeFileSync(file, `${css.trimEnd()}\n\n${HOME_LINK_CSS}`, "utf8");
  return true;
}

const done = log.phase("打 home-link 补丁");

for (const [rel, fn] of [["index.html", patchHtml], ["styles.css", patchCss]]) {
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
