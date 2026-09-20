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
 *   template/app.js       门票「现场购买」档（onsite-purchase）
 *   template/index.html   顶部模块 tab 条，替换上游的「旅行信息 ▾」下拉（build:module-tabs）
 *   template/ledger.css   tab 条样式 + 重算 .section 的 scroll-margin-top（build:module-tabs）
 *   template/module-tabs.js  新建：tab 条的滚动高亮（由本脚本写出，不是 vendored 文件）
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

/*
 * 顶部模块 tab 条：把上游的「旅行信息 ▾」下拉（<details>，要点两下）
 * 换成一条常驻吸顶的 tab 条，点一下直接跳到对应模块，并随滚动高亮当前模块。
 *
 * 三个必须保住的既有约定（保住它们，vendored 的 site-navigation.js 与 app.js
 * 就一行都不用改）：
 *   - 容器 class 仍是 .travel-navigation-menu —— app.js:50 靠
 *     `.travel-navigation-menu [data-module]` 数「还有几个模块可见」，
 *     数为 0 就把 #travel-navigation 整条隐藏；
 *   - 外层仍是 id="travel-navigation" —— 同上，以及 site-navigation.js
 *     里几处 travelMenu?.removeAttribute("open")（对 <nav> 是空操作，安全）；
 *   - 每个 tab 仍带 data-module —— app.js:47 按 config.modules 逐项开关，
 *     「按 config 自动显示已启用模块」就是这么来的，不要改成别的属性名。
 *
 * 记账 tab 也并进这条：保留 id="ledger-navigation-link"，
 * site-navigation.js:4 的 ledgerEnabled() 读的就是它的 hidden。
 *
 * 位置必须放在 </header> 之后、<main> 之前 —— 不能放进 <main>：
 * styles.css:83 的 main{overflow:hidden} 会让其后代的 position:sticky 完全失效。
 */
const TABS_MARKER_START = "<!-- build:module-tabs -->";
const TABS_MARKER_END = "<!-- /build:module-tabs -->";
const TABS_SCRIPT = '<script src="module-tabs.js" defer></script>';

const MODULE_TABS_HTML = `${TABS_MARKER_START}
  <nav class="module-tabs" id="travel-navigation" aria-label="模块导航" hidden>
    <div class="travel-navigation-menu">
      <a href="#flights" data-module="flights" hidden>航班</a>
      <a href="#route" data-module="overview" hidden>路线</a>
      <a href="#itinerary" data-module="itinerary" hidden>行程</a>
      <a href="#drive" data-module="driving" hidden>自驾</a>
      <a href="#prep" data-module="todo" hidden>Todo</a>
      <a class="primary-navigation__ledger" id="ledger-navigation-link" href="#ledger" data-module="ledger" hidden>记账</a>
    </div>
  </nav>
  ${TABS_MARKER_END}`;

// 要整体摘掉的上游导航块：从 .primary-navigation 开标签到它的闭标签。
const OLD_NAV_START = '<nav class="primary-navigation"';
const OLD_NAV_END = "</nav>";

/*
 * tab 条样式写在 ledger.css 而不是 styles.css。
 * index.html:14-15 先加载 styles.css、后加载 ledger.css，同特异性下后者胜 ——
 * 写进 styles.css 会被上游 .travel-navigation-menu 的浮层规则（position:fixed 等）
 * 原样盖掉，是个不报错、只是不生效的静默坑。
 */
const TABS_CSS = `/* build:module-tabs */
:root { --module-tabs-h: 47px; }

.module-tabs {
  position: sticky;
  /* 正好贴在顶栏下沿：顶栏高 48px + 安全区 */
  top: calc(48px + var(--safe-top));
  z-index: 19; /* 低于顶栏(20)：顶栏的投影要压在 tab 条上 */
  background: var(--paper);
  border-bottom: 1px solid var(--line);
}
/* display:flex 会盖掉 hidden 属性的 display:none，必须显式补一条 */
.module-tabs[hidden] { display: none; }
/*
 * 记账视图里**保留**这条 tab 条（上游同样保留顶栏的旅行导航），
 * 否则进了记账就再也跳不回行程模块，只剩 wordmark 一条退路。
 * 代价是记账页要少算 47px 高度，见下方 .ledger-view 的补偿。
 */
body[data-active-view="ledger"] .ledger-view {
  min-height: calc(100vh - 48px - var(--module-tabs-h));
  min-height: calc(100dvh - 48px - var(--module-tabs-h));
}

/* 覆盖上游的浮层下拉（position:fixed + grid） */
.module-tabs .travel-navigation-menu {
  position: static;
  width: auto;
  margin: 0;
  padding: 6px 12px;
  display: flex;
  gap: 4px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
  scroll-snap-type: x proximity;
  scrollbar-width: none;
}
.module-tabs .travel-navigation-menu::-webkit-scrollbar { display: none; }

.module-tabs .travel-navigation-menu a {
  flex: 0 0 auto;
  scroll-snap-align: center;
  min-height: 34px;
  padding: 0 13px;
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 680;
  text-decoration: none;
  white-space: nowrap;
}
.module-tabs .travel-navigation-menu a[aria-current="location"] {
  color: #fff;
  background: var(--ink);
}

/*
 * 点 tab 后标题不能被吸顶条盖住。上游 styles.css:96 写的是 48px
 * （只算了顶栏），这里重算：顶栏 + 安全区 + tab 条 + 8px 余量。
 * 靠 ledger.css 的层叠顺序覆盖，不改 styles.css。
 */
.section { scroll-margin-top: calc(48px + var(--safe-top) + var(--module-tabs-h) + 8px); }

@media print { .module-tabs { display: none; } }
/* /build:module-tabs */
`;

/*
 * 滚动高亮（scroll spy）。上游整份模板里没有任何滚动高亮，只能从零写。
 *
 * 语义提醒：这是**页面内锚点导航**，不是 tabpanel 切换 —— 各模块 section
 * 同时存在，点 tab 只是滚动定位。所以用普通 <nav> + aria-current="location"
 * （ARIA 里专为「页面内当前位置」定义的取值），不要用 role="tablist"/"tab"，
 * 那会让读屏软件以为下面是互斥面板（记账那边的真 tab 才该那么写）。
 */
const MODULE_TABS_JS = `/**
 * 模块 tab 条的滚动高亮。由 scripts/patch-template.mjs 写出，改它请改脚本。
 *
 * 显隐不归这里管：app.js 的 applyModuleConfig() 已按 config.modules 逐项开关
 * [data-module]，本文件只在 travel-config:ready 之后接管高亮。
 */
(() => {
  const nav = () => document.querySelector(".module-tabs");
  const links = () => [...document.querySelectorAll(".module-tabs .travel-navigation-menu a")];

  let offset = 0; // 吸顶线：越过它的最后一个 section 就是「当前模块」
  let frame = 0;

  function measure() {
    const bar = nav();
    if (!bar || bar.hidden || !bar.offsetHeight) return;
    // 吸顶时 rect.top 就等于它吸住的位置，所以不加 scrollY 才是对的。
    //
    // +24 而不是 +8：点 tab / scrollIntoView 会把 section 停在
    // scroll-margin-top = 吸顶条底 + 8 处（实测会因 scrollY 取整落在 +8.0~+8.2），
    // 若判定线也取 +8，这一零点几像素的误差就会让刚点到的那个模块**不高亮**
    // （高亮停在上一项）。判定线必须严格低于落点，留出余量。
    offset = bar.getBoundingClientRect().top + bar.offsetHeight + 24;
  }

  function sync() {
    frame = 0;
    const bar = nav();
    if (!bar || bar.hidden) return;
    // 记账视图下各 section 整体 hidden，这里不干预 ——
    // 否则会把 site-navigation.js 刚给记账 tab 设的 aria-current="page" 抹掉。
    const travelView = document.querySelector("main[data-site-view='travel']");
    if (!travelView || travelView.hidden) return;

    const sections = [...document.querySelectorAll("main[data-site-view='travel'] section[id][data-module]")]
      .filter((section) => !section.hidden);
    let current = null;
    for (const section of sections) {
      if (section.getBoundingClientRect().top <= offset) current = section;
      else break; // section 按文档顺序排列
    }
    for (const link of links()) {
      if (current && link.getAttribute("href") === "#" + current.id) {
        link.setAttribute("aria-current", "location");
        if (bar.scrollWidth > bar.clientWidth) link.scrollIntoView({ inline: "nearest", block: "nearest" });
      } else if (link.getAttribute("aria-current") === "location") {
        // 只清自己设的 location，不动 site-navigation.js 设的 page
        link.removeAttribute("aria-current");
      }
    }
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(sync);
  }

  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", () => { measure(); schedule(); }, { passive: true });
  window.addEventListener("travel-config:ready", () => { measure(); schedule(); });
  window.addEventListener("travel-view:shown", schedule);
  // 点 tab 后 site-navigation.js 用 pushState 改 hash，不会触发 hashchange，
  // 所以点完自己补一次同步。
  document.addEventListener("click", (event) => {
    if (event.target.closest(".module-tabs a")) schedule();
  });

  const start = () => { measure(); schedule(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
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

  // ① 摘掉顶栏里原来的 .primary-navigation 整块（下拉 + 记账链接）
  // ② 在 </header> 之后插入吸顶 tab 条
  // 两步一起做、一起判幂等：marker 在就都跳过。
  if (!html.includes(TABS_MARKER_START)) {
    const start = html.indexOf(OLD_NAV_START);
    if (start < 0) throw new Error(`index.html 中找不到旧导航锚点「${OLD_NAV_START}」，模板结构可能已变，请人工确认`);
    const end = html.indexOf(OLD_NAV_END, start);
    if (end < 0) throw new Error(`index.html 中找不到旧导航的结束标签「${OLD_NAV_END}」，模板结构可能已变，请人工确认`);
    // 连同上一个换行一起切，否则会空出一整行
    const lineStart = html.lastIndexOf("\n", start);
    html = html.slice(0, lineStart) + html.slice(end + OLD_NAV_END.length);

    const headerEnd = html.indexOf("</header>");
    if (headerEnd < 0) throw new Error("index.html 中找不到 </header>，模板结构可能已变，请人工确认");
    const at = headerEnd + "</header>".length;
    html = `${html.slice(0, at)}\n\n  ${MODULE_TABS_HTML}${html.slice(at)}`;
    changed = true;
  }

  if (!html.includes(TABS_SCRIPT)) {
    // 排在 site-navigation.js 之后：注册监听早于 app.js 的 fetch 完成，
    // 所以 travel-config:ready 一定收得到。
    const anchor = '<script src="site-navigation.js';
    const at = html.indexOf(anchor);
    if (at < 0) throw new Error(`index.html 中找不到脚本插入锚点「${anchor}」，模板结构可能已变，请人工确认`);
    const lineEnd = html.indexOf("\n", at);
    html = `${html.slice(0, lineEnd + 1)}  ${TABS_SCRIPT}\n${html.slice(lineEnd + 1)}`;
    changed = true;
  }

  if (!changed) {
    log.debug("index.html 已是最新补丁状态，跳过");
    return false;
  }
  fs.writeFileSync(file, html, "utf8");
  return true;
}

/**
 * 用 build:xxx 标记包裹的整块内容：标记在但内容变了就**整块替换**。
 *
 * 不能只判「标记在不在」——那样一旦标记写进去了，之后修改常量里的内容
 * 就永远不会生效（跑多少次都是「无变化」），是个不报错的静默坑。
 * 本文件里其它一次性补丁（home-link 等）也用了标记判定，但它们的内容
 * 自写入后没再改过；tab 条这块会跟着设计迭代，必须按内容比对。
 */
function upsertBlock(text, startMarker, endMarker, block) {
  const start = text.indexOf(startMarker);
  if (start < 0) return { text: `${text.trimEnd()}\n\n${block}`, changed: true };
  const end = text.indexOf(endMarker, start);
  if (end < 0) throw new Error(`发现起始标记「${startMarker}」但没有结束标记「${endMarker}」，请人工确认`);
  const current = text.slice(start, end + endMarker.length);
  if (current === block.trimEnd()) return { text, changed: false };
  return { text: text.slice(0, start) + block.trimEnd() + text.slice(end + endMarker.length), changed: true };
}

function patchLedgerCss(file) {
  const css = fs.readFileSync(file, "utf8");
  const { text, changed } = upsertBlock(css, "/* build:module-tabs */", "/* /build:module-tabs */", TABS_CSS);
  if (!changed) {
    log.debug("ledger.css 的 module-tabs 块已是最新，跳过");
    return false;
  }
  fs.writeFileSync(file, text, "utf8");
  return true;
}

function writeModuleTabsJs(file) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (existing === MODULE_TABS_JS) {
    log.debug("module-tabs.js 已是最新，跳过");
    return false;
  }
  fs.writeFileSync(file, MODULE_TABS_JS, "utf8");
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

for (const [rel, fn] of [
  ["index.html", patchHtml],
  ["styles.css", patchCss],
  ["ledger.css", patchLedgerCss],
  ["route-ui.js", patchRouteUi],
  ["app.js", patchAppJs],
  ["module-tabs.js", writeModuleTabsJs],
]) {
  const file = path.join(TEMPLATE_DIR, rel);
  // module-tabs.js 是本脚本**新建**的运行时文件，仓库里本来就没有，不能按「缺失=跳过」处理。
  if (!fs.existsSync(file) && rel !== "module-tabs.js") {
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
