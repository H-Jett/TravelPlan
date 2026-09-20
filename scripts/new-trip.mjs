#!/usr/bin/env node
/**
 * 新建一个目的地攻略骨架。
 *
 *   npm run new -- --slug chengdu --title "成都五日" --dest 成都 --start 2026-10-01 --end 2026-10-05
 *
 * 做三件事：
 *   1. trips/<slug>/trip-data.json  从 template/ 的空白底板派生，写入标题/日期/目的地/slug
 *   2. trips/<slug>/assets/         专属素材目录（门票 PDF、专属底图）
 *   3. 注册到 configs/trips.json
 *
 * 只负责搭骨架，不改任何 template/ 下的运行时文件。
 */
import fs from "node:fs";
import path from "node:path";

import { CONFIGS_DIR, ROOT, TEMPLATE_DIR, tripDir } from "./lib/paths.mjs";
import { assertSlug, readRegistry, uniqueSlug, writeRegistry } from "./lib/registry.mjs";
import { createLogger } from "./lib/log.mjs";

const log = createLogger("new-trip");

const OPTIONS = new Set(["slug", "title", "dest", "start", "end", "subtitle"]);

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`无法识别的参数: ${arg}`);
    const name = arg.slice(2);
    if (!OPTIONS.has(name)) throw new Error(`未知选项: --${name}（可用: ${[...OPTIONS].join(", ")}）`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} 需要一个值`);
    values[name] = value;
    i += 1;
  }
  return values;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

/** 从目的地名推一个可读的 slug（中文等非 ASCII 走拼音代价太大，这里退回手填提示）。 */
function suggestSlug(title) {
  const ascii = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return /^[a-z0-9]/.test(ascii) ? ascii : "";
}

const args = parseArgs(process.argv.slice(2));
if (!args.title && !args.slug) {
  log.error("至少需要 --title 或 --slug。例：npm run new -- --slug chengdu --title \"成都五日\"");
  process.exit(1);
}

const registry = readRegistry();
const taken = new Set(registry.trips.map((t) => t.slug));
const wanted = args.slug || suggestSlug(args.title);
if (!wanted) {
  log.error(`无法从标题「${args.title}」推出 slug，请显式指定 --slug（小写字母/数字/连字符）。`);
  process.exit(1);
}

assertSlug(wanted);
const slug = uniqueSlug(wanted, taken);
if (slug !== wanted) log.warn(`slug「${wanted}」已存在，改用「${slug}」`);

for (const [name, value] of [["start", args.start], ["end", args.end]]) {
  if (value && !isIsoDate(value)) {
    log.error(`--${name} 必须是 YYYY-MM-DD 格式，收到: ${value}`);
    process.exit(1);
  }
}
if (args.start && args.end && args.start > args.end) {
  log.error(`--start (${args.start}) 不能晚于 --end (${args.end})`);
  process.exit(1);
}

const title = args.title || slug;
const target = tripDir(slug);
if (fs.existsSync(target)) {
  log.error(`目录已存在: ${path.relative(ROOT, target)}，未做任何修改。`);
  process.exit(1);
}

const done = log.phase(`创建 trip「${slug}」`);

// 1. 数据底板
const blank = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, "trip-data.json"), "utf8"));
const data = {
  ...blank,
  metadata: { ...blank.metadata, tripId: slug, title },
  trip: {
    ...blank.trip,
    startDate: args.start || null,
    endDate: args.end || null,
    primaryDestinationName: args.dest || "",
    citiesAndAreas: args.dest ? [args.dest] : []
  }
};

fs.mkdirSync(target, { recursive: true });
fs.mkdirSync(path.join(target, "assets"), { recursive: true });
fs.writeFileSync(path.join(target, "trip-data.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");
fs.writeFileSync(path.join(target, "assets", ".gitkeep"), "", "utf8");
fs.writeFileSync(path.join(target, "SOURCE.md"), `# ${title} · 原始资料

把这次旅行的原始资料（订单截图文字、行程草稿、链接摘录）贴到这里，供生成时阅读。

> 注意：本文件是生成输入，不是站点产物，不会被拷贝进 home/site/。
> 若含有票号、订单号、门禁密码等敏感内容，公开部署前先处理。
`, "utf8");

// 2. 注册
fs.mkdirSync(CONFIGS_DIR, { recursive: true });
registry.trips.push({
  slug,
  title,
  subtitle: args.subtitle || "",
  region: args.dest || "",
  order: registry.trips.length + 1
});
writeRegistry(registry);

done(`→ ${path.relative(ROOT, target)}`);

log.info(`trip-data.json : ${path.join(target, "trip-data.json")}`);
log.info(`原始资料       : ${path.join(target, "SOURCE.md")}`);
log.info(`素材目录       : ${path.join(target, "assets")}`);
log.info(`注册表         : ${path.join(CONFIGS_DIR, "trips.json")}`);
log.info("");
log.info("下一步：");
log.info(`  1. 把旅行资料整理进 ${path.relative(ROOT, path.join(target, "SOURCE.md"))}`);
log.info(`  2. 按 template/SKILL.md 的流程把内容写进 trip-data.json（六个模块开关 + 地点/路线）`);
log.info("  3. npm run build 生成站点（会自动重建底图）");
log.info("  4. npm run preview 本地预览");
log.summary({ slug, title, start: args.start || "-", end: args.end || "-" });
log.close();
