#!/usr/bin/env node
/**
 * 把每个 trips/<slug>/ 编译成可独立托管的静态站点片段，并生成首页。
 *
 * 产出（全部落在 home/site/，整目录可直接发布到任意静态托管）：
 *   home/site/index.html              目的地列表首页
 *   home/site/styles.css              首页样式
 *   home/site/assets/*.js/css         模板运行时（从 template/ 拷贝，共享一份）
 *   home/site/trips/<slug>/index.html 该目的地的旅行页
 *   home/site/trips/<slug>/trip-data.json
 *   home/site/trips/<slug>/assets/    该目的地专属素材（门票 PDF / 底图等）
 *
 * 关键约束：build-map.mjs 写进 trip-data.json 的 baseImage 是"页面相对路径"，
 * 所以静态运行时和 trips/<slug>/ 必须处于同一站点根下、且相对层级一致。
 * 本脚本负责生成这个层级，并校验底图确实存在。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { RUNTIME_DOTFILES, RUNTIME_FILES, ROOT, TEMPLATE_DIR, HOME_SITE_DIR, siteTripDir, tripDir } from "./lib/paths.mjs";
import { readRegistry, reconcile } from "./lib/registry.mjs";
import { createLogger } from "./lib/log.mjs";

const log = createLogger("build-site");

// 排除 Template 自带、首页站点不需要的文档与后端模板。
const SKIP_DIRS = new Set([".git", "node_modules", "optional", "references", "schemas", "tests", "scripts"]);

function copyDir(from, to, { skipDirs = new Set(), skipFiles = new Set() } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".nojekyll") continue;
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      copyDir(path.join(from, entry.name), path.join(to, entry.name), { skipDirs, skipFiles });
      continue;
    }
    if (skipFiles.has(entry.name)) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
  }
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 读 trips/<slug>/trip-data.json，顺便把首页卡片要显示的信息抽出来。 */
function loadTrip(slug) {
  const dataFile = path.join(tripDir(slug), "trip-data.json");
  if (!fs.existsSync(dataFile)) return { slug, error: "缺少 trip-data.json" };
  let data;
  try {
    data = readJson(dataFile);
  } catch (error) {
    return { slug, error: `trip-data.json 解析失败: ${error.message}` };
  }
  const days = Array.isArray(data.days) ? data.days.length : 0;
  const flightCount = Array.isArray(data.flights) ? data.flights.length : 0;
  const dateRange = [data.trip?.startDate, data.trip?.endDate].filter(Boolean).join(" → ");
  const enabledModules = Object.entries(data.config?.modules || {})
    .filter(([, on]) => on === true)
    .map(([name]) => name);
  return {
    slug,
    data,
    title: data.metadata?.title || slug,
    tripId: data.metadata?.tripId || slug,
    status: data.trip?.status || "unknown",
    days,
    flightCount,
    dateRange,
    enabledModules,
    routeSummary: data.trip?.routeSummary || "",
    error: null
  };
}

/** 拷贝 trip 站点，返回本次用到的底图清单（用于校验和共享复用）。 */
function materializeTrip(trip) {
  const target = siteTripDir(trip.slug);
  fs.rmSync(target, { recursive: true, force: true });

  // 1. 运行时骨架：与 template/ 保持相对层级一致，这样底图相对路径才不会错位。
  for (const file of RUNTIME_FILES) {
    const source = path.join(TEMPLATE_DIR, file);
    if (!fs.existsSync(source)) throw new Error(`template/ 缺少运行时文件: ${file}`);
    copyFile(source, path.join(target, file));
  }
  for (const dotfile of RUNTIME_DOTFILES) {
    const source = path.join(TEMPLATE_DIR, dotfile);
    if (fs.existsSync(source)) copyFile(source, path.join(target, dotfile));
  }

  // 2. 数据
  copyFile(path.join(tripDir(trip.slug), "trip-data.json"), path.join(target, "trip-data.json"));

  // 3. trip 专属素材（门票 PDF、专属底图……）
  const tripAssets = path.join(tripDir(trip.slug), "assets");
  const copiedAssets = [];
  if (fs.existsSync(tripAssets)) {
    copyDir(tripAssets, path.join(target, "assets"));
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.relative(tripAssets, path.join(dir, e.name))]);
    copiedAssets.push(...walk(tripAssets));
  }

  // 4. 底图：trip-data.json 里 baseImage 指向 template/assets/...，
  //    先在站点根共享一份，再给本 trip 兜底一份，两种相对写法都能命中。
  const routeMaps = [...new Set(
    (trip.data.routeMap?.regions || []).map((region) => region.baseImage).filter(Boolean)
  )];
  for (const rel of routeMaps) {
    const source = path.resolve(TEMPLATE_DIR, rel);
    if (!source.startsWith(TEMPLATE_DIR) || !fs.existsSync(source)) {
      throw new Error(`trip-data.json 引用的底图不存在: ${rel}（slug=${trip.slug}）`);
    }
    copyFile(source, path.join(HOME_SITE_DIR, rel));
    copyFile(source, path.join(target, rel));
  }

  return { routeMaps, copiedAssets, target };
}

/** 首页 HTML。纯静态、无构建依赖，直接用 <a> 跳转，不用 JS 路由，保证任何静态托管都能用。 */
function renderHome(entries, generatedAt) {
  const cards = entries.map((entry) => {
    const meta = [
      entry.days ? `${entry.days} 天` : null,
      entry.flightCount ? `${entry.flightCount} 段航班` : null,
      entry.dateRange || null
    ].filter(Boolean).join(" · ");
    const tags = (entry.enabledModules || []).join(" / ");
    const badge = entry.orphan ? `<span class="card__badge card__badge--warn">未登记</span>`
      : entry.status === "draft" ? `<span class="card__badge">草稿</span>` : "";
    return `      <li class="card">
        <a class="card__link" href="trips/${encodeURIComponent(entry.slug)}/">
          <h2 class="card__title">${escapeHtml(entry.title)}${badge}</h2>
          ${entry.subtitle ? `<p class="card__subtitle">${escapeHtml(entry.subtitle)}</p>` : ""}
          ${meta ? `<p class="card__meta">${escapeHtml(meta)}</p>` : ""}
          ${entry.routeSummary ? `<p class="card__route">${escapeHtml(entry.routeSummary)}</p>` : ""}
          <p class="card__foot"><code>trips/${escapeHtml(entry.slug)}/</code>${tags ? `<span>${escapeHtml(tags)}</span>` : ""}</p>
        </a>
      </li>`;
  }).join("\n");

  const empty = `      <li class="empty">
        <p>还没有任何攻略。</p>
        <p class="empty__hint">在 <code>trips/&lt;slug&gt;/trip-data.json</code> 写入行程后运行：</p>
        <pre><code>npm run new -- --slug &lt;slug&gt; --title "目的地"
npm run build</code></pre>
      </li>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f3f6f2">
  <title>我的旅行攻略</title>
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="home-header">
    <p class="home-header__kicker">MY TRAVEL PLANS</p>
    <h1 class="home-header__title">我的旅行攻略</h1>
    <p class="home-header__sub">${entries.length} 个目的地 · 生成于 ${escapeHtml(generatedAt)}</p>
  </header>

  <main>
    <ul class="card-grid">
${entries.length ? cards : empty}
    </ul>
  </main>

  <footer class="home-footer">
    <p>纯静态站点，发布在 GitHub Pages。页面上的勾选状态只存在你自己的浏览器里。</p>
  </footer>
</body>
</html>
`;
}

const HOME_STYLES = `:root {
  --bg: #f3f6f2;
  --surface: #ffffff;
  --ink: #1c2b23;
  --ink-soft: #5b6b62;
  --line: #dde5e0;
  --accent: #397dc1;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141a17;
    --surface: #1d2621;
    --ink: #e8efe9;
    --ink-soft: #9aaba1;
    --line: #2c3a33;
    --accent: #6aa9e0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0 16px 48px;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-text-size-adjust: 100%;
}
.home-header { max-width: 1040px; margin: 0 auto; padding: 56px 0 28px; }
.home-header__kicker {
  margin: 0 0 6px; font-size: 12px; letter-spacing: .18em;
  text-transform: uppercase; color: var(--ink-soft);
}
.home-header__title { margin: 0 0 8px; font-size: 30px; line-height: 1.25; }
.home-header__sub { margin: 0; color: var(--ink-soft); font-size: 14px; }
main { max-width: 1040px; margin: 0 auto; }
.card-grid {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}
.card {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: 14px; overflow: hidden;
  transition: transform .16s ease, box-shadow .16s ease;
}
.card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,.08); }
.card__link { display: block; padding: 18px 18px 16px; color: inherit; text-decoration: none; }
.card__title { margin: 0 0 6px; font-size: 19px; line-height: 1.3; }
.card__badge {
  display: inline-block; margin-left: 8px; padding: 1px 8px;
  border-radius: 999px; background: var(--line); color: var(--ink-soft);
  font-size: 12px; font-weight: 400; vertical-align: middle;
}
.card__badge--warn { background: #f6e0c8; color: #8a5a1a; }
.card__subtitle { margin: 0 0 4px; color: var(--ink-soft); font-size: 14px; }
.card__meta { margin: 0 0 6px; color: var(--ink); font-size: 14px; font-variant-numeric: tabular-nums; }
.card__route { margin: 0 0 10px; color: var(--ink-soft); font-size: 13px; }
.card__foot {
  margin: 0; padding-top: 10px; border-top: 1px solid var(--line);
  display: flex; justify-content: space-between; gap: 8px;
  color: var(--ink-soft); font-size: 12px;
}
.card__foot code { font-size: 12px; }
.empty { grid-column: 1 / -1; padding: 32px 20px; border: 1px dashed var(--line); border-radius: 14px; color: var(--ink-soft); }
.empty p { margin: 0 0 10px; }
.empty__hint { font-size: 14px; }
.empty pre {
  margin: 0; padding: 14px; overflow-x: auto;
  background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
}
.empty code { font-size: 13px; }
.home-footer { max-width: 1040px; margin: 40px auto 0; color: var(--ink-soft); font-size: 13px; }
.home-footer p { margin: 0; }
@media (max-width: 480px) {
  .home-header { padding-top: 36px; }
  .home-header__title { font-size: 25px; }
}
`;

/** 用 template/ 的 build-map 重新生成每个 trip 的 routeMap，保证与三张底图一致。 */
function rebuildMaps(slugs) {
  const script = path.join(TEMPLATE_DIR, "scripts", "build-map.mjs");
  if (!fs.existsSync(script)) {
    log.warn("template/scripts/build-map.mjs 不存在，跳过底图重建");
    return { ok: 0, failed: [] };
  }
  let ok = 0;
  const failed = [];
  const tick = log.progress("重建 routeMap", slugs.length);
  for (const slug of slugs) {
    const tripFile = path.join(tripDir(slug), "trip-data.json");
    const result = spawnSync(process.execPath, [script, "--trip", tripFile], { encoding: "utf8" });
    tick();
    if (result.status === 0) {
      ok += 1;
      log.debug(`  ${slug}: ${(result.stdout || "").trim()}`);
    } else {
      failed.push(slug);
      log.error(`  ${slug} 底图重建失败: ${(result.stderr || result.stdout || "").trim()}`);
    }
  }
  return { ok, failed };
}

// ---------------------------------------------------------------- main
log.info(`仓库根目录: ${ROOT}`);
const startAll = Date.now();

const registry = readRegistry();
const { entries, missingOnDisk, orphanOnDisk } = reconcile(registry);
log.info(`注册表: ${registry.trips.length} 条；数据就绪: ${entries.filter((e) => e.hasData).length} 个目的地`);
if (missingOnDisk.length) log.warn(`已登记但缺少 trip-data.json，跳过: ${missingOnDisk.join(", ")}`);
if (orphanOnDisk.length) log.warn(`磁盘上有但未登记（仍会构建并出现在首页）: ${orphanOnDisk.join(", ")}`);

const buildable = entries.filter((entry) => entry.hasData);

// 1. 先重建底图，让 trip-data.json 带上最新的 routeMap
const mapResult = rebuildMaps(buildable.map((entry) => entry.slug));
// 底图没建出来的目的地不能进站点：routeMap 缺失会渲染出一个没有地图的空壳页面。
// 直接把它当失败跳过，而不是发布半成品。
const mapFailed = new Set(mapResult.failed);

// 2. 搭站点骨架
{
  const doneSkeleton = log.phase("准备站点骨架");
  fs.rmSync(HOME_SITE_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOME_SITE_DIR, { recursive: true });
  for (const file of RUNTIME_FILES) {
    copyFile(path.join(TEMPLATE_DIR, file), path.join(HOME_SITE_DIR, file));
  }
  for (const dotfile of RUNTIME_DOTFILES) {
    const source = path.join(TEMPLATE_DIR, dotfile);
    if (fs.existsSync(source)) copyFile(source, path.join(HOME_SITE_DIR, dotfile));
  }
  copyDir(path.join(TEMPLATE_DIR, "assets", "maps", "templates"), path.join(HOME_SITE_DIR, "assets", "maps", "templates"));
  copyFile(path.join(TEMPLATE_DIR, "assets", "maps", "README.md"), path.join(HOME_SITE_DIR, "assets", "maps", "README.md"));
  // 站点图标：trip 页用 ../../favicon.svg 引到这里
  const favicon = path.join(ROOT, "home", "favicon.svg");
  if (fs.existsSync(favicon)) copyFile(favicon, path.join(HOME_SITE_DIR, "favicon.svg"));
  fs.writeFileSync(path.join(HOME_SITE_DIR, "styles.css"), HOME_STYLES, "utf8");
  doneSkeleton(`运行时 ${RUNTIME_FILES.length} 个文件 + 10 张底图`);
}

// 3. 逐个目的地生成
let generated = 0;
const failed = [];
{
  const doneTrips = log.phase("生成目的地图");
  const tick = log.progress("目的地", buildable.length, { every: 1, minIntervalMs: 0 });
  for (const entry of buildable) {
    try {
      if (mapFailed.has(entry.slug)) throw new Error("底图重建失败，已跳过（见上方 ERROR）");
      const trip = loadTrip(entry.slug);
      if (trip.error) throw new Error(trip.error);
      const { routeMaps, copiedAssets } = materializeTrip(trip);
      log.info(`  ${entry.slug}: ${routeMaps.length} 张底图, ${copiedAssets.length} 个专属素材 → trips/${entry.slug}/`);
      generated += 1;
    } catch (error) {
      failed.push({ slug: entry.slug, error: error.message });
      log.error(`  ${entry.slug} 生成失败: ${error.message}`);
    }
    tick();
  }
  doneTrips(`成功 ${generated} / 失败 ${failed.length}`);
}

// 4. 首页
{
  const doneHome = log.phase("生成首页");
  const cards = [];
  for (const entry of entries) {
    if (!entry.hasData) { cards.push(entry); continue; }
    if (mapFailed.has(entry.slug)) continue; // 底图失败的目的地不进首页，避免链到空壳页面
    const trip = loadTrip(entry.slug);
    cards.push({ ...entry, ...trip, title: entry.title || trip.title });
  }
  const generatedAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16);
  fs.writeFileSync(path.join(HOME_SITE_DIR, "index.html"), renderHome(cards, generatedAt), "utf8");
  doneHome(`${cards.length} 张卡片`);
}

log.summary({
  目的地: entries.length,
  生成成功: generated,
  生成失败: failed.length,
  底图重建: `${mapResult.ok}/${buildable.length}`,
  站点目录: path.relative(ROOT, HOME_SITE_DIR)
});

if (failed.length || mapResult.failed.length) {
  log.error(`存在失败项，构建未全部成功: ${[...failed.map((f) => f.slug), ...mapResult.failed].join(", ")}`);
  log.close();
  process.exit(1);
}
log.info(`总用时 ${((Date.now() - startAll) / 1000).toFixed(2)}s`);
log.close();
