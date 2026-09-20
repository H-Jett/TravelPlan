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
 *   template/app.js       门票弹窗正文结构化（guidance[] 分组成列表，见下）
 *   template/ledger.css   门票弹窗分组的样式（build:ticket-dialog）
 *   template/index.html   顶部模块导航，替换上游的「旅行信息 ▾」下拉（build:module-nav）
 *   template/ledger.css   导航样式 + 重算 .section 的 scroll-margin-top（build:module-nav）
 *   template/nav-highlight.js  新建：滚动高亮（由本脚本写出，不是 vendored 文件）
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
 * 门票弹窗正文结构化。
 *
 * 上游把 guidance[] 用「·」拼成一整段平铺文本（ticketGuidance()），
 * 卡片摘要和弹窗正文共用这一个函数 —— 于是弹窗里 5~7 条互不相干的信息
 * （票价 / 时刻 / 预约方式 / 注意事项）连成一大坨，读的人得自己断句。
 *
 * 这里改成分组列表：把 guidance[] 拆成「已确认 / 说明 / 注意」三组，
 * 每组一个小标题 + 一条一项的 <ul>。分组判据只看每条的**开头**，
 * 不猜语义 —— 判错的代价只是某条落进「说明」组，不会丢内容。
 *
 * 卡片上的 <small> 只留第一条（ticketGuidanceItems()[0]）：卡片本来就窄，
 * 铺 7 条只会把卡片撑得比正文还高。完整内容点开弹窗看。
 */
const TICKET_DIALOG_MARK = "function ticketGuidanceList(ticket)";

const TICKET_GUIDANCE_ANCHOR = [
  "function ticketGuidance(ticket) {",
  "  const guidance = ticket.guidance || ticket.notes || [];",
  '  return Array.isArray(guidance) ? guidance.join("·") : String(guidance || "");',
  "}",
].join("\n");

// 用单引号逐行拼：这几行里含反引号与 ${}，写成模板字面量要一路转义，反而更难读。
const TICKET_GUIDANCE_PATCHED = [
  "function ticketGuidanceItems(ticket) {",
  "  const guidance = ticket.guidance || ticket.notes || [];",
  "  const list = Array.isArray(guidance) ? guidance : [guidance];",
  '  return list.map((text) => String(text == null ? "" : text).trim()).filter(Boolean);',
  "}",
  "",
  "function ticketGuidance(ticket) {",
  '  return ticketGuidanceItems(ticket).join("·");',
  "}",
  "",
  "// 分组只看开头，不猜语义：判错的代价是某条落进「说明」，不会丢内容",
  "function isTicketConfirmed(text) {",
  '  return /^已(出票|购票|预订|预约|确认|订)/.test(text);',
  "}",
  "",
  "function isTicketAlert(text) {",
  '  return /^[\\u26a0\\u2757\\u2755\\u203c]/.test(text) || /^注意[:：]/.test(text);',
  "}",
  "",
  "function ticketGuidanceList(ticket) {",
  "  const items = ticketGuidanceItems(ticket);",
  '  if (!items.length) return "";',
  "  const confirmed = items.filter(isTicketConfirmed);",
  "  const alerts = items.filter((text) => !isTicketConfirmed(text) && isTicketAlert(text));",
  "  const notes = items.filter((text) => !isTicketConfirmed(text) && !isTicketAlert(text));",
  "  const rest = notes.length + alerts.length;",
  '  const label = (text) => `<p class="ticket-dialog__label">${text}</p>`;',
  '  const list = (group, cls) => group.length',
  '    ? `<ul class="ticket-dialog__list${cls ? " " + cls : ""}">${group.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>`',
  '    : "";',
  "  // 只有一组时不出小标题 —— 一条列表上面顶个「说明」纯属噪音",
  "  return [",
  '    confirmed.length ? `${rest ? label("已确认") : ""}${list(confirmed, "is-confirmed")}` : "",',
  '    rest ? `${confirmed.length ? label("说明") : ""}${list(notes, "")}` : "",',
  '    alerts.length ? `${label("注意")}${list(alerts, "is-alert")}` : "",',
  '  ].join("");',
  "}",
].join("\n");

// 弹窗正文那一行（openTicketDialog 里）
const TICKET_DIALOG_BODY_ANCHOR =
  '    ${ticketGuidance(ticket) ? `<p class="ticket-dialog__guidance">${escapeHtml(ticketGuidance(ticket))}</p>` : ""}';
const TICKET_DIALOG_BODY_PATCHED = "    ${ticketGuidanceList(ticket)}";

// 卡片上那行摘要（inlineTicketMarkup 里）
const TICKET_CARD_ANCHOR = "          <small>${escapeHtml(ticketGuidance(ticket))}</small>";
const TICKET_CARD_PATCHED = '          <small>${escapeHtml(ticketGuidanceItems(ticket)[0] || "")}</small>';

/*
 * 弹窗分组的样式，写在 ledger.css（层叠顺序见文件顶部的说明）。
 * 上游 styles.css 里的 .ticket-dialog__guidance 就不再被用到了 ——
 * 留着无害（没有元素带这个 class 了），删它要给 styles.css 做减法补丁，不值得。
 */
const TICKET_DIALOG_CSS = `/* build:ticket-dialog */
.ticket-dialog__label {
  margin: 16px 0 6px;
  color: var(--muted, #5b6b62);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
}

/*
 * 正文第一块紧跟在状态行后面。状态行（上游 .ticket-dialog__status）margin 是 0，
 * 列表也是 0 —— 单组弹窗（没有小标题）时首条会**贴到状态行上**，实测间距 0px。
 * 所以给「状态行之后的第一个块」统一补上间距，两种情况（有/无小标题）都覆盖。
 */
.ticket-dialog__status + .ticket-dialog__list,
.ticket-dialog__status + .ticket-dialog__label { margin-top: 14px; }

.ticket-dialog__list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.ticket-dialog__list li {
  position: relative;
  padding: 0 0 0 16px;
  margin-bottom: 7px;
  color: #47575b;
  font-size: 13px;
  line-height: 1.65;
}
.ticket-dialog__list li::before {
  content: "";
  position: absolute;
  left: 3px;
  top: .62em;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: .45;
}
.ticket-dialog__list li:last-child { margin-bottom: 0; }

/* 已确认：把「票已经在我手上」这部分框出来，一眼能跳过 */
.ticket-dialog__list.is-confirmed {
  padding: 10px 12px;
  border-radius: 10px;
  background: #edf6f5;
}
.ticket-dialog__list.is-confirmed li { color: #205e6b; font-weight: 600; }
.ticket-dialog__list.is-confirmed li::before { opacity: .7; }

/* 注意：真正会误事的那几条 */
.ticket-dialog__list.is-alert li { color: #a2563a; }
.ticket-dialog__list.is-alert li::before { opacity: .8; }

@media (max-width: 420px) {
  .ticket-dialog__list li { font-size: 12.5px; }
}
/* /build:ticket-dialog */
`;

/*
 * 顶部模块导航：把上游的「旅行信息 ▾」下拉（<details>，要点两下才展开）
 * 换成**顶栏右侧一行常驻的模块链接**，点一下直接跳到对应模块，并随滚动高亮当前模块。
 *
 * 为什么放在 <header class="topbar"> 里、而不是另起一条吸顶条：
 *   - 顶栏本身就是 `position: sticky; top: 0`，放进来的东西天然常驻，不用再写 sticky；
 *   - 与 wordmark（页面上显示的「KR · 2026」）同行，页面上只有这一行导航，
 *     不出现第二条横条；
 *   - 省掉「第二条的高度」这笔账：不需要 --module-tabs-h，
 *     也不用给 .ledger-view 补 min-height。
 *
 * ⚠️ 不要把它挪进 <main>：styles.css 的 `main { overflow: hidden }`
 * 会让 `overflow:hidden` 的祖先成为 sticky 的滚动容器，其后代的 position:sticky 全部失效。
 *
 * 三个必须保住的既有约定（保住它们，vendored 的 site-navigation.js 与 app.js
 * 就一行都不用改）：
 *   - 容器 class 仍是 .travel-navigation-menu —— app.js:50 靠
 *     `.travel-navigation-menu [data-module]` 数「还有几个模块可见」，
 *     数为 0 就把 #travel-navigation 整块隐藏；
 *   - 外层仍是 id="travel-navigation" —— 同上，以及 site-navigation.js
 *     里几处 travelMenu?.removeAttribute("open")（对 <nav> 是空操作，安全）；
 *   - 每个链接仍带 data-module —— app.js:47 按 config.modules 逐项开关，
 *     「按 config 自动显示已启用模块」就是这么来的，不要改成别的属性名。
 *
 * 记账链接也并进这一行：保留 id="ledger-navigation-link"，
 * site-navigation.js:4 的 ledgerEnabled() 读的就是它的 hidden。
 */
const NAV_MARKER_START = "<!-- build:module-nav -->";
const NAV_MARKER_END = "<!-- /build:module-nav -->";
const NAV_SCRIPT = '<script src="nav-highlight.js" defer></script>';

const MODULE_NAV_HTML = `    ${NAV_MARKER_START}
    <nav class="primary-navigation" id="travel-navigation" aria-label="模块导航" hidden>
      <div class="travel-navigation-menu">
        <a href="#flights" data-module="flights" hidden>航班</a>
        <a href="#route" data-module="overview" hidden>路线</a>
        <a href="#itinerary" data-module="itinerary" hidden>行程</a>
        <a href="#drive" data-module="driving" hidden>自驾</a>
        <a href="#prep" data-module="todo" hidden>Todo</a>
        <a class="primary-navigation__ledger" id="ledger-navigation-link" href="#ledger" data-module="ledger" hidden>记账</a>
      </div>
    </nav>
    ${NAV_MARKER_END}`;

// 要整体摘掉的上游导航块：从 .primary-navigation 开标签到它的闭标签。
const OLD_NAV_START = '<nav class="primary-navigation"';
const OLD_NAV_END = "</nav>";

/*
 * 上一版补丁的痕迹（顶栏下方那条独立的吸顶 tab 条）。
 * 保留这两个常量只为**清理**：换设计时它已经在 template/index.html 与 ledger.css 里了，
 * 不主动摘掉的话会变成一条谁也不认识的残条。取完这次的设计后可以删掉这三行常量。
 */
const LEGACY_TABS_MARKER_START = "<!-- build:module-tabs -->";
const LEGACY_TABS_MARKER_END = "<!-- /build:module-tabs -->";
const LEGACY_TABS_SCRIPT = '<script src="module-tabs.js" defer></script>';

/*
 * 导航样式写在 ledger.css 而不是 styles.css。
 * index.html 先加载 styles.css、后加载 ledger.css，同特异性下后者胜 ——
 * 写进 styles.css 会被上游 .travel-navigation-menu 的浮层规则（position:fixed 等）
 * 原样盖掉，是个不报错、只是不生效的静默坑。
 */
const NAV_CSS = `/* build:module-nav */
/*
 * 顶栏右侧的模块导航。上游那一段 .topbar .primary-navigation / .travel-navigation-menu
 * 就在本文件上方（ledger.css:4-85），这里靠**写在后面**覆盖它。
 */

/* 顶部模块导航与 wordmark 同行，wordmark 那一侧不许被挤扁 */
.topbar .wordmark { flex: 0 0 auto; white-space: nowrap; }

#travel-navigation {
  min-width: 0;               /* 允许收缩，否则窄屏会把 wordmark 顶出屏幕 */
  overflow-x: auto;           /* 放不下时横向滚，而不是撑破顶栏 */
  overscroll-behavior-inline: contain;
  scrollbar-width: none;
}
/* 作者样式里的 display:flex 会盖掉 hidden 自带的 display:none，必须显式补一条。
   id 选择器(1,0,0) 胜过 .topbar .primary-navigation(0,2,0)，不用 !important。 */
#travel-navigation[hidden] { display: none; }
#travel-navigation::-webkit-scrollbar { display: none; }

/* 把上游的浮层下拉（position:fixed + grid + 阴影）拉平成一行 */
#travel-navigation .travel-navigation-menu {
  position: static;
  top: auto;
  right: auto;
  left: auto;
  width: auto;
  margin: 0;
  padding: 0;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

#travel-navigation .travel-navigation-menu a {
  flex: 0 0 auto;
  min-width: 42px;
  min-height: 40px;
  padding: 0 9px;
  font-size: 12px;
  white-space: nowrap;
}
#travel-navigation .travel-navigation-menu a[aria-current="location"] {
  color: #fff;
  background: var(--ink);
}

/*
 * 点链接后标题不能被吸顶顶栏盖住。上游 styles.css 写的是 48px —— 只算了顶栏，
 * 漏了安全区。这里补上 --safe-top 再加 8px 余量。
 */
.section { scroll-margin-top: calc(48px + var(--safe-top) + 8px); }

@media print { #travel-navigation { display: none; } }
/* /build:module-nav */
`;

/*
 * 滚动高亮（scroll spy）。上游整份模板里没有任何滚动高亮，只能从零写。
 *
 * 语义提醒：这是**页面内锚点导航**，不是 tabpanel 切换 —— 各模块 section
 * 同时存在，点 tab 只是滚动定位。所以用普通 <nav> + aria-current="location"
 * （ARIA 里专为「页面内当前位置」定义的取值），不要用 role="tablist"/"tab"，
 * 那会让读屏软件以为下面是互斥面板（记账那边的真 tab 才该那么写）。
 */
const NAV_HIGHLIGHT_JS = `/**
 * 顶部模块导航的滚动高亮。由 scripts/patch-template.mjs 写出，改它请改脚本。
 *
 * 显隐不归这里管：app.js 的 applyModuleConfig() 已按 config.modules 逐项开关
 * [data-module]，本文件只在 travel-config:ready 之后接管高亮。
 */
(() => {
  const nav = () => document.getElementById("travel-navigation");
  const links = () => [...document.querySelectorAll("#travel-navigation .travel-navigation-menu a")];

  let offset = 0; // 判定线：越过它的最后一个 section 就是「当前模块」
  let frame = 0;

  function measure() {
    const bar = nav();
    if (!bar || bar.hidden || !bar.offsetHeight) return;
    // 导航在 sticky 顶栏里，rect.bottom 就是顶栏下沿，不加 scrollY 才对。
    //
    // +24 而不是 +8：点链接 / scrollIntoView 会把 section 停在
    // scroll-margin-top = 顶栏底 + 8 处（实测会因 scrollY 取整落在 +8.0~+8.2），
    // 若判定线也取 +8，这一零点几像素的误差就会让刚点到的那个模块**不高亮**
    // （高亮停在上一项）。判定线必须严格低于落点，留出余量。
    offset = bar.getBoundingClientRect().bottom + 24;
  }

  function sync() {
    frame = 0;
    const bar = nav();
    if (!bar || bar.hidden) return;
    // 记账视图下各 section 整体 hidden，这里不干预 ——
    // 否则会把 site-navigation.js 刚给记账链接设的 aria-current="page" 抹掉。
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
        // 窄屏放不下时导航可横向滚动，把当前项带进视野
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
  // 点链接后 site-navigation.js 用 pushState 改 hash，不会触发 hashchange，
  // 所以点完自己补一次同步。
  document.addEventListener("click", (event) => {
    if (event.target.closest("#travel-navigation a")) schedule();
  });

  const start = () => { measure(); schedule(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
`;

const changes = [];

function patchHtml(file) {
  const original = fs.readFileSync(file, "utf8");
  let html = original;

  if (!html.includes(FAVICON_START)) {
    const anchor = '<link rel="stylesheet" href="styles.css';
    const at = html.indexOf(anchor);
    if (at < 0) throw new Error(`index.html 中找不到 favicon 插入锚点「${anchor}」，模板结构可能已变`);
    html = `${html.slice(0, at)}${FAVICON_HTML}\n  ${html.slice(at)}`;
  }

  if (!html.includes(MARKER_START)) {
    const anchor = '<a class="skip-link"';
    const at = html.indexOf(anchor);
    if (at < 0) throw new Error(`index.html 中找不到 home-link 插入锚点「${anchor}」，模板结构可能已变，请人工确认`);
    html = `${html.slice(0, at)}${HOME_LINK_HTML}\n  ${html.slice(at)}`;
  }

  // ── 顶部模块导航：把三种历史状态收敛到当前版本 ──
  // ① 上一版的残迹：顶栏下方那条独立的吸顶 tab 条 + 它的脚本标签。
  //    换设计时它们已经躺在 template/index.html 里了，不主动摘掉就成了一条谁也不认识的横条。
  const legacy = stripBlock(html, LEGACY_TABS_MARKER_START, LEGACY_TABS_MARKER_END);
  if (legacy.changed) html = legacy.text;
  html = stripLine(html, LEGACY_TABS_SCRIPT).text;

  // ② 一次都没打过补丁的上游下拉（<details class="travel-navigation"> 那一整块）。
  //    判据是「新标记不在」——标记在了说明位置已经是我们的，不必也不能再摘。
  //    三种合法历史状态：上游原样 / 上一版吸顶 tab 条 / 当前版本；都不像就该停下问人。
  if (!html.includes(NAV_MARKER_START)) {
    const upstream = stripBlock(html, OLD_NAV_START, OLD_NAV_END);
    if (!upstream.changed && !legacy.changed) {
      throw new Error(`index.html 的顶栏既没有「${NAV_MARKER_START}」，也找不到上游导航锚点「${OLD_NAV_START}」，模板结构可能已变，请人工确认`);
    }
    html = upstream.text;
  }

  // ③ 插进 <header class="topbar">，与 wordmark 同行。
  //    已在则按内容替换 —— 详见 upsertBlock 的注释。
  const headerEnd = html.indexOf("</header>");
  if (headerEnd < 0) throw new Error("index.html 中找不到 </header>，模板结构可能已变，请人工确认");
  html = upsertBlock(html, NAV_MARKER_START, NAV_MARKER_END, MODULE_NAV_HTML, html.lastIndexOf("\n", headerEnd) + 1).text;

  if (!html.includes(NAV_SCRIPT)) {
    // 排在 site-navigation.js 之后：注册监听早于 app.js 的 fetch 完成，
    // 所以 travel-config:ready 一定收得到。
    const anchor = '<script src="site-navigation.js';
    const at = html.indexOf(anchor);
    if (at < 0) throw new Error(`index.html 中找不到脚本插入锚点「${anchor}」，模板结构可能已变，请人工确认`);
    const lineEnd = html.indexOf("\n", at);
    html = `${html.slice(0, lineEnd + 1)}  ${NAV_SCRIPT}\n${html.slice(lineEnd + 1)}`;
  }

  // 换设计时 </header> 与 <main> 之间会攒下空行，收敛成恰好一个空行
  html = html.replace(/(<\/header>)[ \t]*\n\s*\n\s*(<main)/, "$1\n\n  $2");

  if (html === original) {
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
 * 自写入后没再改过；导航这块会跟着设计迭代，必须按内容比对。
 *
 * 替换区间**从标记所在行的行首算起**，连缩进一起换 —— 否则块首行的缩进
 * 会被当成「块外的文本」留着，改一次缩进就永远收敛不了。
 *
 * `insertAt`：标记还不存在时插到哪个字符偏移处（默认追加到文末）。
 */
function upsertBlock(text, startMarker, endMarker, block, insertAt = null) {
  const norm = (value) => value.replace(/\s+$/, "");
  const markerAt = text.indexOf(startMarker);
  if (markerAt < 0) {
    if (insertAt == null) return { text: `${text.trimEnd()}\n\n${norm(block)}\n`, changed: true };
    return { text: text.slice(0, insertAt) + norm(block) + "\n" + text.slice(insertAt), changed: true };
  }
  const start = text.lastIndexOf("\n", markerAt) + 1;
  const end = text.indexOf(endMarker, markerAt);
  if (end < 0) throw new Error(`发现起始标记「${startMarker}」但没有结束标记「${endMarker}」，请人工确认`);
  if (norm(text.slice(start, end + endMarker.length)) === norm(block)) return { text, changed: false };
  return { text: text.slice(0, start) + norm(block) + text.slice(end + endMarker.length), changed: true };
}

/** 摘掉标记包裹的整块（含标记本身与它前面那个换行）；标记不在则原样返回。 */
function stripBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) return { text, changed: false };
  const close = text.indexOf(endMarker, start);
  if (close < 0) throw new Error(`发现起始标记「${startMarker}」但没有结束标记「${endMarker}」，请人工确认`);
  const lineStart = text.lastIndexOf("\n", start);
  return { text: text.slice(0, lineStart) + text.slice(close + endMarker.length), changed: true };
}

/** 按「整行包含某字符串」摘掉行；命不中则原样返回。 */
function stripLine(text, needle) {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !line.includes(needle));
  if (kept.length === lines.length) return { text, changed: false };
  return { text: kept.join("\n"), changed: true };
}

function patchLedgerCss(file) {
  let css = fs.readFileSync(file, "utf8");
  const before = css;
  // 上一版那条独立吸顶 tab 条的样式块，连同它的 --module-tabs-h 一起摘掉
  css = stripBlock(css, "/* build:module-tabs */", "/* /build:module-tabs */").text;
  css = upsertBlock(css, "/* build:module-nav */", "/* /build:module-nav */", NAV_CSS).text;
  css = upsertBlock(css, "/* build:ticket-dialog */", "/* /build:ticket-dialog */", TICKET_DIALOG_CSS).text;
  if (css === before) {
    log.debug("ledger.css 的补丁块已是最新，跳过");
    return false;
  }
  fs.writeFileSync(file, css, "utf8");
  return true;
}

function writeNavHighlightJs(file) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (existing === NAV_HIGHLIGHT_JS) {
    log.debug("nav-highlight.js 已是最新，跳过");
    return false;
  }
  fs.writeFileSync(file, NAV_HIGHLIGHT_JS, "utf8");
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

/*
 * 三处补丁共用一个文件，逐处独立判定 —— 不能像早先那样「第一处已打过就整体跳过」，
 * 否则后加的补丁在这个文件上永远不生效（本仓库最典型的一类静默坑）。
 */
function patchAppJs(file) {
  let js = fs.readFileSync(file, "utf8");
  const before = js;
  const targets = [
    [TICKET_REQ_ANCHOR, TICKET_REQ_PATCHED, TICKET_REQ_PATCHED, "onsite-purchase 档"],
    [TICKET_GUIDANCE_ANCHOR, TICKET_GUIDANCE_PATCHED, TICKET_DIALOG_MARK, "弹窗分组函数"],
    [TICKET_DIALOG_BODY_ANCHOR, TICKET_DIALOG_BODY_PATCHED, TICKET_DIALOG_BODY_PATCHED, "弹窗正文"],
    [TICKET_CARD_ANCHOR, TICKET_CARD_PATCHED, TICKET_CARD_PATCHED, "卡片摘要"],
  ];
  for (const [anchor, patched, doneMark, label] of targets) {
    if (js.includes(doneMark)) {
      log.debug(`app.js 已含${label}，跳过`);
      continue;
    }
    if (!js.includes(anchor)) {
      throw new Error(`app.js 中找不到${label}的插入锚点「${anchor}」，模板结构可能已变，请人工确认`);
    }
    js = js.replace(anchor, patched);
  }
  if (js === before) return false;
  fs.writeFileSync(file, js, "utf8");
  return true;
}

const done = log.phase("打模板补丁");

for (const [rel, fn] of [
  ["index.html", patchHtml],
  ["styles.css", patchCss],
  ["ledger.css", patchLedgerCss],
  ["route-ui.js", patchRouteUi],
  ["app.js", patchAppJs],
  ["nav-highlight.js", writeNavHighlightJs],
]) {
  const file = path.join(TEMPLATE_DIR, rel);
  // nav-highlight.js 是本脚本**新建**的运行时文件，仓库里本来就没有，不能按「缺失=跳过」处理。
  if (!fs.existsSync(file) && rel !== "nav-highlight.js") {
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
