/**
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
