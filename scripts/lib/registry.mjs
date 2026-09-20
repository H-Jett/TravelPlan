import fs from "node:fs";
import path from "node:path";
import { CONFIGS_DIR, TRIPS_DIR, siteTripDir, tripDir } from "./paths.mjs";

export const REGISTRY_FILE = path.join(CONFIGS_DIR, "trips.json");

/** trip 的数据是否就绪 —— 可构建的唯一条件。 */
export function hasTripData(slug) {
  return fs.existsSync(path.join(tripDir(slug), "trip-data.json"));
}

/** 是否已经构建过（产物在发布目录里）。 */
export function hasTripSite(slug) {
  return fs.existsSync(path.join(siteTripDir(slug), "index.html"));
}

/** slug 必须是安全的单层目录名，防止路径穿越。 */
export function assertSlug(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    throw new Error(
      `非法 slug: ${JSON.stringify(slug)}。只允许小写字母/数字/连字符，以字母或数字开头，最长 63 字符。`
    );
  }
  return slug;
}

export function readRegistry() {
  if (!fs.existsSync(REGISTRY_FILE)) {
    return { schemaVersion: 1, trips: [] };
  }
  const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  const trips = Array.isArray(raw.trips) ? raw.trips : [];
  const seen = new Set();
  for (const trip of trips) {
    assertSlug(trip.slug);
    if (seen.has(trip.slug)) throw new Error(`configs/trips.json 中 slug 重复: ${trip.slug}`);
    seen.add(trip.slug);
  }
  return { schemaVersion: raw.schemaVersion || 1, trips };
}

export function writeRegistry(registry) {
  fs.mkdirSync(CONFIGS_DIR, { recursive: true });
  const temp = `${REGISTRY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  fs.renameSync(temp, REGISTRY_FILE);
}

/**
 * 注册表是"意图"，磁盘是"事实"。两者不一致时以磁盘为准并把差异报出来，
 * 避免首页链接到 404，也避免已经生成好的目的地从首页消失。
 *
 * 注意区分两件不同的事：
 *   hasData —— trips/<slug>/trip-data.json 存在，**这才是可构建的条件**。
 *   hasSite —— 已经构建过（site/index.html 存在），只用于报告"待重建"。
 * 新脚手架出来的 trip 只有 hasData、没有 hasSite，必须照样参与构建。
 */
export function reconcile(registry) {
  const entries = [];
  const declared = new Set(registry.trips.map((t) => t.slug));

  for (const trip of registry.trips) {
    entries.push({ ...trip, hasData: hasTripData(trip.slug), hasSite: hasTripSite(trip.slug), orphan: false });
  }

  const orphanOnDisk = [];
  if (fs.existsSync(TRIPS_DIR)) {
    for (const name of fs.readdirSync(TRIPS_DIR)) {
      const full = path.join(TRIPS_DIR, name);
      if (!fs.statSync(full).isDirectory()) continue;
      if (declared.has(name)) continue;
      if (!hasTripData(name)) continue;
      orphanOnDisk.push(name);
      entries.push({
        slug: name,
        title: name,
        subtitle: "未登记在 configs/trips.json",
        hasData: true,
        hasSite: hasTripSite(name),
        orphan: true
      });
    }
  }

  return { entries, missingOnDisk: entries.filter((e) => !e.hasData).map((e) => e.slug), orphanOnDisk };
}

/** 找下一个可用的 slug（-2, -3 ...）。 */
export function uniqueSlug(base, taken) {
  assertSlug(base);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`无法为 ${base} 找到空闲 slug`);
}
