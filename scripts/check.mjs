#!/usr/bin/env node
/**
 * 结构健康检查：不构建，只报告"我的仓库状态对不对"。
 * 适合在 npm run build 之后跑一遍确认，也适合接进 CI。
 *
 *   npm run check
 *   npm run check -- --json   机器可读输出
 */
import fs from "node:fs";
import path from "node:path";

import { ROOT, TEMPLATE_DIR, HOME_SITE_DIR, RUNTIME_FILES, tripDir } from "./lib/paths.mjs";
import { readRegistry, reconcile } from "./lib/registry.mjs";

const jsonMode = process.argv.includes("--json");
const errors = [];
const warnings = [];
const notes = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

// 1. 仓库自身
check(fs.existsSync(path.join(ROOT, "package.json")), "缺少 package.json");
check(fs.existsSync(TEMPLATE_DIR), "缺少 template/（vendored 模板）");
for (const file of RUNTIME_FILES) {
  check(fs.existsSync(path.join(TEMPLATE_DIR, file)), `template/ 缺少运行时文件 ${file}`);
}
check(fs.existsSync(path.join(TEMPLATE_DIR, "scripts", "build-map.mjs")), "template/scripts/build-map.mjs 丢失，底图无法重建");
check(
  fs.existsSync(path.join(TEMPLATE_DIR, "assets", "maps", "templates", "manifest.json")),
  "底图清单 template/assets/maps/templates/manifest.json 丢失"
);

const skillFile = path.join(ROOT, ".claude", "skills", "generate-lightweight-travel-page", "SKILL.md");
if (!fs.existsSync(skillFile)) {
  warnings.push("项目级 Skill 未安装：.claude/skills/generate-lightweight-travel-page/SKILL.md");
} else {
  const head = fs.readFileSync(skillFile, "utf8").slice(0, 400);
  if (!/^---[\s\S]*?name:\s*\S+/.test(head)) warnings.push("Skill 文件缺少合法的 frontmatter（name/description）");
}

// 2. 注册表 vs 磁盘
let entries = [];
try {
  const registry = readRegistry();
  const result = reconcile(registry);
  entries = result.entries;
  for (const slug of result.missingOnDisk) {
    warnings.push(`configs/trips.json 登记了 ${slug}，但 trips/${slug}/site/ 未生成（跑 npm run build）`);
  }
  for (const slug of result.orphanOnDisk) {
    warnings.push(`trips/${slug}/ 有产物但未登记在 configs/trips.json（首页仍会显示，建议补登记）`);
  }
} catch (error) {
  errors.push(`configs/trips.json 读取失败: ${error.message}`);
}

// 3. 每个目的地
for (const entry of entries) {
  const slug = entry.slug;
  const dir = tripDir(slug);
  const dataFile = path.join(dir, "trip-data.json");
  if (!fs.existsSync(dataFile)) {
    errors.push(`trips/${slug}/trip-data.json 不存在`);
    continue;
  }

  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } catch (error) {
    errors.push(`trips/${slug}/trip-data.json 解析失败: ${error.message}`);
    continue;
  }

  if (data.schemaVersion !== "2.0-lite") warnings.push(`trips/${slug}: schemaVersion=${data.schemaVersion}，预期 2.0-lite`);
  if (!data.metadata?.tripId) errors.push(`trips/${slug}: metadata.tripId 为空（会退化成 default-trip，多站共享本地存储）`);
  if (data.metadata?.tripId && data.metadata.tripId !== slug) {
    notes.push(`trips/${slug}: tripId「${data.metadata.tripId}」与目录名不同（允许，但排查问题时注意）`);
  }
  if (data.trip?.status === "uninitialized") {
    warnings.push(`trips/${slug}: 还是空白底板（trip.status=uninitialized），尚未写入行程`);
  }
  const dayCount = Array.isArray(data.days) ? data.days.length : 0;
  if (data.trip?.dayCount && data.trip.dayCount !== dayCount) {
    errors.push(`trips/${slug}: trip.dayCount=${data.trip.dayCount} 与实际 days 数量 ${dayCount} 不一致`);
  }

  // 模块开启但数据为空 = 页面会显示空模块
  const modules = data.config?.modules || {};
  const emptiness = [
    ["flights", Array.isArray(data.flights) ? data.flights.length : 0],
    ["itinerary", dayCount],
    ["driving", data.groundTransport?.rentalCar ? 1 : 0],
    ["overview", Array.isArray(data.map?.places) ? data.map.places.length : 0]
  ];
  for (const [name, count] of emptiness) {
    if (modules[name] === true && count === 0) warnings.push(`trips/${slug}: 模块 ${name} 已开启但没有数据`);
  }

  // 底图
  const routeMaps = data.routeMap?.regions || [];
  if (modules.overview === true && !routeMaps.length) {
    warnings.push(`trips/${slug}: 地图模块已开启但还没有 routeMap（跑 npm run build 生成）`);
  }
  for (const region of routeMaps) {
    if (!region.baseImage) continue;
    // 底图有两个合法来源：template/ 下的共用示意图，或本 trip assets/ 下的真实地图
    // （构建时抓 OSM 瓦片拼出来的，入库在本 trip 目录）。
    const inTemplate = path.resolve(TEMPLATE_DIR, region.baseImage);
    const inTrip = path.resolve(dir, region.baseImage);
    const inside = (base, value) => value.startsWith(base + path.sep);
    if (inside(TEMPLATE_DIR, inTemplate) && fs.existsSync(inTemplate)) continue;
    if (inside(dir, inTrip) && fs.existsSync(inTrip)) continue;
    errors.push(`trips/${slug}: routeMap 引用的底图缺失 ${region.baseImage}`);
  }

  // 产物
  const siteIndex = path.join(dir, "site", "index.html");
  if (fs.existsSync(siteIndex)) {
    const html = fs.readFileSync(siteIndex, "utf8");
    if (!html.includes('href="../../"')) warnings.push(`trips/${slug}/site/index.html 缺少返回首页链接（跑 npm run patch && npm run build）`);
  }
}

const result = {
  ok: errors.length === 0,
  summary: { trips: entries.length, errors: errors.length, warnings: warnings.length },
  errors,
  warnings,
  notes
};

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(result.ok ? `check: PASS（${entries.length} 个目的地）` : `check: FAIL（${entries.length} 个目的地）`);
  warnings.forEach((m) => console.log(`WARN  ${m}`));
  notes.forEach((m) => console.log(`NOTE  ${m}`));
  errors.forEach((m) => console.log(`ERROR ${m}`));
}

process.exit(result.ok ? 0 : 1);
