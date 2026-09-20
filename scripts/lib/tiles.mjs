/**
 * OSM 瓦片抓取（礼貌模式）。
 *
 * ## 为什么这么小心
 *
 * OSM 的瓦片服务是**社区捐赠**的基础设施，官方 Tile Usage Policy 明确禁止批量下载。
 * 本站只需 ~112 张（三个区域，一次性），远谈不上批量，但仍按规矩来：
 *  - 串行抓取，每张之间固定间隔（默认 1s，远低于 2 req/s 的上限）
 *  - 带**可联系**的 User-Agent —— 匿名 UA 会被直接封，这是 policy 的硬要求
 *  - 本地缓存到 `.cache/tiles/`（进 .gitignore），重复构建不重复打 OSM
 *
 * 生成好的拼接图会入库到 `trips/<slug>/assets/`，所以**别人 clone 后构建完全不需要联网**，
 * 也不需要预先跑抓取 —— 抓取只在底图需要更新时手动跑一次。
 */

import fs from "node:fs";
import path from "node:path";

/** 官方瓦片端点。不要改成镜像 —— 镜像的坐标系与配色不保证一致。 */
export const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/**
 * OSM 政策要求 UA 能标识应用且可联系。不要改成通用 UA（如 curl/xxx），会被封。
 */
export const DEFAULT_USER_AGENT =
  "travel-plans-static-site/1.0 (+https://github.com/H-Jett/TravelPlan; personal travel itinerary site)";

export function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

export function tileCachePath(cacheDir, z, x, y) {
  return path.join(cacheDir, String(z), String(x), `${y}.png`);
}

/** 窗口需要的全部瓦片编号。 */
export function tilesForWindow(window) {
  const tiles = [];
  for (let dy = 0; dy < window.tilesY; dy += 1) {
    for (let dx = 0; dx < window.tilesX; dx += 1) {
      tiles.push({ z: window.zoom, x: window.originTileX + dx, y: window.originTileY + dy });
    }
  }
  return tiles;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一张瓦片：先看缓存，没有再抓（带重试）。 */
async function fetchOne(tile, { cacheDir, urlTemplate, userAgent, retries, logger }) {
  const cachePath = tileCachePath(cacheDir, tile.z, tile.x, tile.y);
  if (fs.existsSync(cachePath)) {
    return { buffer: fs.readFileSync(cachePath), fromCache: true };
  }

  const url = urlTemplate
    .replace("{z}", tile.z)
    .replace("{x}", tile.x)
    .replace("{y}", tile.y);

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent, Accept: "image/png,image/*;q=0.8" },
      });
      if (!response.ok) {
        // 429/503 是限流信号，值得退避重试；404 说明编号越界，重试无意义
        if (response.status === 404) throw new Error(`${url} -> 404（瓦片编号越界？）`);
        throw new Error(`${url} -> HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error(`${url} -> 空响应`);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, buffer);
      return { buffer, fromCache: false };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const backoff = 1000 * 2 ** attempt;
        logger?.warn(`瓦片 ${tileKey(tile.z, tile.x, tile.y)} 第 ${attempt} 次失败（${error.message}），${backoff}ms 后重试`);
        await sleep(backoff);
      }
    }
  }
  throw new Error(`瓦片 ${tileKey(tile.z, tile.x, tile.y)} 抓取失败：${lastError?.message}`);
}

/**
 * 抓取一批瓦片。
 *
 * @param {Array<{z,x,y}>} tiles 去重后的瓦片列表
 * @returns {Promise<Map<string, Buffer>>} key 为 `z/x/y`
 */
export async function fetchTiles(tiles, {
  cacheDir,
  urlTemplate = DEFAULT_TILE_URL,
  userAgent = DEFAULT_USER_AGENT,
  delayMs = 1000,
  retries = 3,
  logger = null,
  useCache = true,
} = {}) {
  const unique = [...new Map(tiles.map((t) => [tileKey(t.z, t.x, t.y), t])).values()];
  if (!unique.length) return new Map();

  const result = new Map();
  const started = Date.now();
  // log.phase(label) 返回的是「收尾函数」，log.progress(label,total) 返回的是「打点函数」
  const done = logger?.phase?.(`抓取 OSM 瓦片（${unique.length} 张）`);
  const tick = logger?.progress?.("瓦片", unique.length, { every: 5, minIntervalMs: 5000 });
  let fetched = 0;
  let cached = 0;

  for (let index = 0; index < unique.length; index += 1) {
    const tile = unique[index];
    const key = tileKey(tile.z, tile.x, tile.y);

    if (!useCache) {
      const cachePath = tileCachePath(cacheDir, tile.z, tile.x, tile.y);
      if (fs.existsSync(cachePath)) fs.rmSync(cachePath);
    }

    const { buffer, fromCache } = await fetchOne(tile, {
      cacheDir, urlTemplate, userAgent, retries, logger,
    });
    result.set(key, buffer);
    if (fromCache) cached += 1; else fetched += 1;

    // 只在真的打了网络时才等待 —— 全命中缓存时不该白等
    if (!fromCache && index < unique.length - 1) await sleep(delayMs);

    tick?.();
  }

  done?.(`新抓 ${fetched} 张，命中缓存 ${cached} 张，用 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return result;
}
