import path from "node:path";
import { fileURLToPath } from "node:url";

/** 本仓库根目录（scripts/lib/ 往上两级）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** vendored 的旅行页模板，只读，不要手工改动。 */
export const TEMPLATE_DIR = path.join(ROOT, "template");

/** 每次生成从 template/ 拷贝出来的静态运行时骨架。 */
export const HOME_DIR = path.join(ROOT, "home");
export const HOME_SITE_DIR = path.join(HOME_DIR, "site");

/** 每个目的地一个目录：trips/<slug>/。 */
export const TRIPS_DIR = path.join(ROOT, "trips");

export const CONFIGS_DIR = path.join(ROOT, "configs");
export const LOGS_DIR = path.join(ROOT, "logs");

/** 旅行页运行时真正会去读的文件，必须随每个 trip 一起拷贝。 */
export const RUNTIME_FILES = [
  "index.html",
  "styles.css",
  "ledger.css",
  "runtime-storage.js",
  "overview-map.js",
  "route-ui.js",
  "app.js",
  "ticket-pdf-preview.js",
  "ledger.js",
  "site-navigation.js",
  // 由 scripts/patch-template.mjs 写出（不是 vendored 文件），
  // 不在这个白名单里 build 就不会拷进站点，页面静默没有滚动高亮。
  "module-tabs.js"
];

/** site 根要带的静态杂项（没有内容，但影响托管行为）。 */
export const RUNTIME_DOTFILES = [".nojekyll", "_headers"];

export function tripDir(slug) {
  return path.join(TRIPS_DIR, slug);
}

/**
 * 该目的地在**发布目录**里的位置：home/site/trips/<slug>/。
 * 发布目录是一个整体，trip 的产物在里面，不在 trips/<slug>/site/ ——
 * 否则 GitHub Pages 只能发 home/site/ 时，trip 页会漏在外面。
 */
export function siteTripDir(slug) {
  return path.join(HOME_SITE_DIR, "trips", slug);
}
