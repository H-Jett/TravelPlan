#!/usr/bin/env node
/**
 * 投影正确性检查：地图上任意两点的**方位角**与**距离尺度**是否与真实地理一致。
 *
 * ## 为什么需要这个检查
 *
 * 线上曾经出现过「地图和真实地图以及位置完全不一样」——根因是示意投影的
 * `separatePoints()` 力导向分离把靠近的点强行推开（回拉系数仅 0.055）。
 * 当时**没有任何测试覆盖「位置对不对」**，所以这个 bug 一直没人发现。
 * 本脚本补的正是这个缺口。
 *
 * ## 判据为什么是这样
 *
 * 不能直接比像素距离 —— 缩放会掩盖一切。要用**尺度无关**的两个量：
 *
 *  1. `web-mercator` 是**等角**投影，所以任意两点的地图方位角应**严格等于**
 *     真实地理方位角（方位不对 = 错位 / 镜像 / 各向异性拉伸）。
 *  2. 距离尺度（px/km）在同一区域内应**接近常数**（离散度大 = 非线性拉伸）。
 *
 * 只有真实的 web-mercator 投影能同时满足这两条；示意投影两条都过不了。
 *
 * 用法：
 *   node scripts/verify-projection.mjs            # 检查全部目的地
 *   node scripts/verify-projection.mjs --json
 *   node scripts/verify-projection.mjs --baseline # 额外打印 git HEAD 里的旧数据做对照
 *
 * 除投影外还复核「标题/图例的保留区有没有盖住标题」—— 标题是「英文名 / 中文名」，
 * 目的地名一长就会伸进标签区，而这类错误投影、标签互相压字、出界三项检查全是绿的。
 * 注意这条是**静态估算**（AFM 字宽度量，实测偏大 2%），只能保证「不该压」；
 * 最终仍要看一眼浏览器实际渲染，见 SKILL.md 验收第 6 条。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROOT, tripDir } from "./lib/paths.mjs";
import { estimateLineWidth, chromeBox } from "./lib/label-layout.mjs";

// 门槛。真实 web-mercator 投影的实测值远好于此（方位误差 0.0°、尺度离散 0.0%），
// 这里留足余量，只用来抓「投影整体不对」这类量级的错误。
const MAX_MEDIAN_BEARING = 5;    // 中位方位误差 ≤5°
const MIN_WITHIN_30 = 0.9;       // ≥90% 的点对方位误差 ≤30°
const MAX_SCALE_SPREAD = 0.05;   // 距离尺度离散度 ≤5%
const MIN_PAIR_KM = 0.15;        // 近于此距离的点对，方位角本身没有意义
const CHROME_DEPTH = 4;          // 标签压标题/图例：与 label-layout 同一把尺子（重叠深度 ≥4px）

const jsonMode = process.argv.includes("--json");
const baselineMode = process.argv.includes("--baseline");

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** 真实地理方位角（罗盘：正北 0°，顺时针）。 */
function trueBearing(a, b) {
  const meanLat = toRad((a.lat + b.lat) / 2);
  const north = (b.lat - a.lat) * 111.32;
  const east = (b.lng - a.lng) * 111.32 * Math.cos(meanLat);
  return (toDeg(Math.atan2(east, north)) + 360) % 360;
}

/** 真实地理距离（km）。东西向按中点纬度做 cos 收缩。 */
function trueKm(a, b) {
  const meanLat = toRad((a.lat + b.lat) / 2);
  const north = (b.lat - a.lat) * 111.32;
  const east = (b.lng - a.lng) * 111.32 * Math.cos(meanLat);
  return Math.hypot(north, east);
}

/**
 * 地图方位角。画布 y 轴向下（地理北 = 屏幕 -y，地理东 = 屏幕 +x），
 * 所以罗盘方位 = atan2(dx, -dy)。
 */
function mapBearing(a, b) {
  return (toDeg(Math.atan2(b.x - a.x, -(b.y - a.y))) + 360) % 360;
}

function angleError(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ------------------------------------------------------------------ 标题区

/** 标签 em 盒（与浏览器 getBBox 同口径，见 label-layout.mjs 的 ASCENT/DESCENT）。 */
const LABEL_ASCENT = 21.1;
const LABEL_DESCENT = 5.28;
const LABEL_LINE_HEIGHT = 31;

function labelBoxOf(place) {
  const lines = place.lines?.length ? place.lines : [place.name || place.id];
  const width = Math.max(...lines.map((line) => estimateLineWidth(line, place.size || 24)));
  const height = LABEL_ASCENT + (lines.length - 1) * LABEL_LINE_HEIGHT + LABEL_DESCENT;
  const x = place.anchor === "end" ? place.tx - width : place.tx;
  return { x, y: place.ty - LABEL_ASCENT, width, height };
}

/**
 * 标题 / 图例与地点标签是否压字。
 *
 * 这里能查两件事，都**不是**「渲染出来到底压没压」：
 *
 *  1. **保留区有没有盖住标题**（`reservedCoversHeading`）。这才是真正的回归护栏：
 *     标题是「英文名 / 中文名」，长标题（成都「CHENGDU / 成都市区」实测 396px）
 *     超过模板默认的 300px，保留区就必须跟着长。曾经它写死 300，
 *     求解器以为标题只占到 x=318，把标签摆到标题尾巴上，视觉上压字 22px、24px，
 *     而所有检查都是绿的。把这条断出来，写死宽度会立刻失败。
 *  2. **求解器有没有做到它自己那份约束**（`chromeOverlaps`）。坐标下降是贪心+提前退出，
 *     不保证收敛到零代价，所以这不是恒真命题。
 *
 * 至于「浏览器里到底压没压」，本脚本只能给**保守估计**：宽度用 AFM 字体度量估算，
 * 实测偏大 2%（估算 405px vs 实测 396px），所以「不侵入保留区」蕴含「视觉不压字」，
 * 反过来不成立。最终确认仍要看一眼 —— 见 SKILL.md 验收第 6 条。
 */
export function evaluateChrome(data) {
  const notCovered = [];
  const found = [];
  const placesById = new Map((data.map?.places || []).map((place) => [place.id, place]));
  for (const region of data.routeMap?.regions || []) {
    // 图例只画有日期的路线，所以行数按「能在 days 里找到日期」的路线数算
    const dated = (region.routes || []).filter((route) =>
      (data.days || []).some((day) => day.day === route.day && day.date));
    const heading = region.heading || {};
    const headingText = heading.text || region.label || "";
    const { reserved } = chromeBox(dated.length, headingText, { fontSize: heading.size || 40 });

    // 1. 保留区右边界必须越过标题右边界
    const headingRight = (heading.x ?? 33) + estimateLineWidth(headingText, heading.size || 40) + 6;
    if (reserved.x + reserved.width < headingRight - 1) {
      notCovered.push({
        region: region.id,
        heading: headingText,
        needed: Number((headingRight - reserved.x).toFixed(1)),
        reserved: Number(reserved.width.toFixed(1)),
      });
    }

    // 2. 标签不得侵入保留区
    for (const place of region.places || []) {
      const box = labelBoxOf(place);
      const dx = Math.min(box.x + box.width, reserved.x + reserved.width) - Math.max(box.x, reserved.x);
      const dy = Math.min(box.y + box.height, reserved.y + reserved.height) - Math.max(box.y, reserved.y);
      const depth = dx > 0 && dy > 0 ? Math.min(dx, dy) : 0;
      if (depth >= CHROME_DEPTH) {
        found.push({
          region: region.id,
          place: place.id,
          text: (placesById.get(place.id)?.nameZh) || place.id,
          depth: Number(depth.toFixed(1)),
          heading: headingText,
        });
      }
    }
  }
  return { notCovered, overlaps: found };
}

/**
 * 评估一份 trip-data：逐区域算方位误差与距离尺度。
 * @param {object} data
 * @param {{force?: boolean}} [options] force=true 时忽略「是否已迁移」，用于评估旧数据做对照
 */
export function evaluate(data, { force = false } = {}) {
  const geoById = new Map((data.map?.places || []).map((place) => [place.id, place.geo]));
  const realMaps = new Set(Object.keys(data.metadata?.realMaps || {}));
  const regions = [];
  const skipped = [];

  for (const region of data.routeMap?.regions || []) {
    const points = region.places
      .map((place) => {
        const geo = geoById.get(place.id);
        return geo ? { id: place.id, x: place.x, y: place.y, lat: geo.lat, lng: geo.lng } : null;
      })
      .filter(Boolean);

    // 没迁移到真实底图的区域（还带着示意投影）单独列出，不静默跳过
    if ((!force && !realMaps.has(region.id)) || points.length < 2) {
      skipped.push({ id: region.id, places: region.places.length, withGeo: points.length });
      continue;
    }

    const errors = [];
    const scales = [];
    let worst = { error: 0 };
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const km = trueKm(points[i], points[j]);
        if (km < MIN_PAIR_KM) continue;
        const error = angleError(mapBearing(points[i], points[j]), trueBearing(points[i], points[j]));
        errors.push(error);
        if (error > worst.error) worst = { error, a: points[i].id, b: points[j].id };
        scales.push(Math.hypot(points[j].x - points[i].x, points[j].y - points[i].y) / km);
      }
    }
    const meanScale = scales.reduce((sum, value) => sum + value, 0) / scales.length;
    const variance = scales.reduce((sum, value) => sum + (value - meanScale) ** 2, 0) / scales.length;
    regions.push({
      id: region.id,
      places: points.length,
      pairs: errors.length,
      medianError: median(errors),
      worst,
      within30: errors.length ? errors.filter((error) => error <= 30).length / errors.length : 1,
      pxPerKm: meanScale,
      scaleSpread: meanScale > 0 ? Math.sqrt(variance) / meanScale : 0,
      canvas: region.canvas,
    });
  }
  return { regions, skipped };
}

function readTripData(slug) {
  const file = path.join(tripDir(slug), "trip-data.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function gitHeadTripData(slug) {
  const result = spawnSync("git", ["show", `HEAD:trips/${slug}/trip-data.json`], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/** 一个区域是否达标。 */
function judge(region) {
  const problems = [];
  if (region.medianError > MAX_MEDIAN_BEARING) problems.push(`中位方位误差 ${region.medianError.toFixed(1)}° > ${MAX_MEDIAN_BEARING}°`);
  if (region.within30 < MIN_WITHIN_30) problems.push(`仅 ${(region.within30 * 100).toFixed(0)}% 点对 ≤30°`);
  if (region.scaleSpread > MAX_SCALE_SPREAD) problems.push(`距离尺度离散 ${(region.scaleSpread * 100).toFixed(1)}% > ${MAX_SCALE_SPREAD * 100}%`);
  return problems;
}

// ------------------------------------------------------------------ main

const tripsDir = path.join(ROOT, "trips");
const slugs = fs.existsSync(tripsDir)
  ? fs.readdirSync(tripsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : [];

const all = [];
const skippedAll = [];
const failures = [];
const chromeHits = [];
const chromeNotCovered = [];

for (const slug of slugs) {
  const data = readTripData(slug);
  if (!data?.routeMap?.regions?.length) continue;
  const { regions, skipped } = evaluate(data);
  for (const region of regions) {
    const problems = judge(region);
    all.push({ slug, ...region, problems });
    if (problems.length) failures.push({ slug, id: region.id, problems });
  }
  for (const item of skipped) skippedAll.push({ slug, ...item });
  const chrome = evaluateChrome(data);
  for (const hit of chrome.overlaps) chromeHits.push({ slug, ...hit });
  for (const miss of chrome.notCovered) chromeNotCovered.push({ slug, ...miss });
}

if (jsonMode) {
  console.log(JSON.stringify({
    ok: failures.length === 0 && chromeHits.length === 0 && chromeNotCovered.length === 0 && all.length > 0,
    regions: all,
    skipped: skippedAll,
    failures,
    chromeOverlaps: chromeHits,
    chromeNotCovered,
    thresholds: { MAX_MEDIAN_BEARING, MIN_WITHIN_30, MAX_SCALE_SPREAD, CHROME_DEPTH },
  }, null, 2));
  process.exit(failures.length === 0 && chromeHits.length === 0 && chromeNotCovered.length === 0 && all.length > 0 ? 0 : 1);
}

const row = (region) =>
  `点 ${String(region.places).padStart(2)} 对 ${String(region.pairs).padStart(3)}  ` +
  `中位方位 ${region.medianError.toFixed(1).padStart(4)}°  ` +
  `≤30° ${(region.within30 * 100).toFixed(0).padStart(3)}%  ` +
  `最差 ${region.worst.error.toFixed(0).padStart(3)}°` +
  (region.worst.a ? ` (${region.worst.a}↔${region.worst.b})` : "") +
  `  尺度离散 ${(region.scaleSpread * 100).toFixed(1).padStart(4)}%  ${region.pxPerKm.toFixed(2)} px/km`;

console.log(`投影正确性（门槛：中位方位 ≤${MAX_MEDIAN_BEARING}°、≥${MIN_WITHIN_30 * 100}% 点对 ≤30°、尺度离散 ≤${MAX_SCALE_SPREAD * 100}%）`);
for (const region of all) {
  console.log(`  ${region.problems.length ? "❌" : "✅"} ${`${region.slug}/${region.id}`.padEnd(34)}${row(region)}`);
}
for (const problem of failures) {
  for (const message of problem.problems) console.log(`       ↳ ${message}`);
}
if (skippedAll.length) {
  console.log("\n未覆盖（仍是示意底图，不计入判定）:");
  for (const item of skippedAll) {
    console.log(`  ⏭  ${`${item.slug}/${item.id}`.padEnd(34)} 共 ${item.places} 点，其中 ${item.withGeo} 个有经纬度`);
  }
  console.log("     → 补全 trips/<slug>/trip-data.json 里 map.places[].geo 后即可迁移到真实底图");
}

if (chromeNotCovered.length) {
  console.log("\n❌ 保留区没盖住标题（长标题会压到标签上）:");
  for (const miss of chromeNotCovered) {
    console.log(`  ${`${miss.slug}/${miss.region}`.padEnd(34)} 「${miss.heading}」需要 ${miss.needed}px，保留区只给了 ${miss.reserved}px`);
  }
  console.log("     → 保留区宽度必须由标题字宽算出（chromeBox），不能写死。");
}

if (chromeHits.length) {
  console.log(`\n❌ 标签侵入标题/图例保留区（重叠深度 ≥${CHROME_DEPTH}px）:`);
  for (const hit of chromeHits) {
    console.log(`  ${`${hit.slug}/${hit.region}`.padEnd(34)} ${hit.text} 压「${hit.heading}」${hit.depth}px`);
  }
  console.log("     → 求解器没收敛到零代价；可增大 sweeps/refineRounds，或缩短 heading。");
} else if (all.length && !chromeNotCovered.length) {
  console.log(`\n标签未侵入标题/图例保留区（估算法，重叠深度 ≥${CHROME_DEPTH}px）`);
}

if (baselineMode) {
  console.log("\n对照：git HEAD（改动前，强制评估）");
  let shown = 0;
  for (const slug of slugs) {
    const head = gitHeadTripData(slug);
    if (!head?.routeMap?.regions?.length) continue;
    for (const region of evaluate(head, { force: true }).regions) {
      console.log(`  ⏪ ${`${slug}/${region.id}`.padEnd(34)}${row(region)}`);
      shown += 1;
    }
  }
  if (!shown) console.log("  （git HEAD 里没有可评估的区域）");
}

if (!all.length) {
  console.log("\n没有任何区域使用真实底图（projection.type=web-mercator-osm）");
  process.exit(1);
}
const bad = failures.length + chromeHits.length + chromeNotCovered.length;
console.log(bad
  ? `\n${failures.length} 个区域投影不正确、${chromeNotCovered.length} 处保留区不盖标题、${chromeHits.length} 处压字`
  : `\n全部 ${all.length} 个区域投影正确`);
process.exit(bad ? 1 : 0);
