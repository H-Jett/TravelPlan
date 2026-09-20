/**
 * 用真实地图底图重建 routeMap。
 *
 * ## 为什么必须挂在构建流水线内部
 *
 * `scripts/build-site.mjs:318` 的 `rebuildMaps()` 会 spawn `template/scripts/build-map.mjs`，
 * 把**旧的示意投影** routeMap 原地写回 `trips/<slug>/trip-data.json`。
 * 所以「构建完再跑一次」的独立脚本会在下次构建时被静默还原 ——
 * 本模块必须插在 `rebuildMaps()` 之后、`materializeTrip()` 之前。
 *
 * ## 策略：保留结构，只重算几何
 *
 * 模板已经把「哪些地点属于哪个区域、路线分几段、每天含哪些点、配色」都算好了，
 * 存进了现有 routeMap。这些是**结构**，与投影无关，直接沿用；
 * 本模块只做一件事：把同一批地点按**真实经纬度**重新摆到画布上，
 * 并据此重算所有依赖坐标的字段。
 *
 * 这样既避免了复刻模板的 `mapDataForRegion()` / `scopedRoute()` 拆分逻辑，
 * 也不会因为「模板又改了拆分规则」而对不上。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CANVAS_WIDTH, geoToCanvas, planWindow, windowGeoBounds } from "./mercator.mjs";
import { fetchTiles, tilesForWindow } from "./tiles.mjs";
import { buildMosaic } from "./mosaic.mjs";
import { layoutLabels, chromeBox } from "./label-layout.mjs";

/**
 * 真实底图的免责声明，覆盖 trip-data.json 里手写的那条。
 *
 * 手写那条说的是「本图为模板化行程示意图……不代表真实比例或精确地理边界」——
 * 在示意底图时代是实话，换成真实 OSM 底图后就成了**假话**（地理边界恰恰是准的）。
 * 本模块正是把底图变真的人，所以由它来负责改口。
 * 仍然要声明的两条：标注位置为避重叠做过微调、国际航段不画。
 * 署名本身不写在这里 —— patch-template.mjs 会在两个视图都在的 .map-utility 栏里
 * 挂一个可点的 OSM 署名链接，写两遍反而重复。
 */
const REAL_MAP_DISCLAIMER =
  "本图底图为 OpenStreetMap 真实地图，地点按真实经纬度做墨卡托投影定位；" +
  "标注位置为避免重叠做过微调，国际航段不在图内。";

/** 与模板 GOLDEN 一致：路线配色按 (day-1) % 6 取。 */
const ROUTE_COLORS = ["#397dc1", "#e77e22", "#618344", "#209aaa", "#8865a5", "#df6185"];

/** 影响底图与布局的全部输入。变了才需要重新抓瓦片、重新求解标签。 */
export const PLAN_PARAMS = Object.freeze({
  canvasWidth: CANVAS_WIDTH,
  paddingRatio: 0.08,
  minAspect: 1.1,
  maxAspect: 3.4,
  fontSize: 24,
  dotRadius: 15,
});

/**
 * 底图指纹：地点集合 + 经纬度 + 全部计划参数。
 * 只有它变了才重新抓瓦片拼图 —— 否则每次构建都打一遍 OSM，CI 上还没有瓦片缓存。
 */
export function planFingerprint(geos, params = PLAN_PARAMS) {
  const payload = JSON.stringify({
    params,
    geos: geos.map((geo) => [geo.id, Number(geo.lat.toFixed(6)), Number(geo.lng.toFixed(6))]),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

/** 画布像素坐标下的贝塞尔路径（复刻 build-map.mjs:278 routePath）。 */
function routePath(ids, placeById, seed = 0) {
  const points = ids.map((id) => placeById.get(id)).filter(Boolean);
  if (points.length < 2) return "";
  let result = `M${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1], current = points[index];
    const dx = current.x - previous.x, dy = current.y - previous.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const bend = ((seed + index) % 2 ? 1 : -1) * Math.min(30, distance * 0.1);
    const nx = -dy / distance, ny = dx / distance;
    const c1x = previous.x + dx * 0.34 + nx * bend, c1y = previous.y + dy * 0.34 + ny * bend;
    const c2x = previous.x + dx * 0.68 + nx * bend, c2y = previous.y + dy * 0.68 + ny * bend;
    result += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${current.x} ${current.y}`;
  }
  return result;
}

/** 复刻 build-map.mjs:343 overviewRouteIds。 */
function overviewRouteIds(ids, overviewSet) {
  if (ids.length <= 2) return ids;
  const result = [ids[0], ...ids.slice(1, -1).filter((id) => overviewSet.has(id)), ids.at(-1)];
  return result.filter((id, index) => index === 0 || id !== result[index - 1]);
}

function midpoint(first, second) {
  return { x: Number(((first.x + second.x) / 2).toFixed(2)), y: Number(((first.y + second.y).toFixed(2))) };
}

/** 标签文本：与 build-map.mjs:441 一致（主名 + " /" 一行、中文名一行）。 */
function linesFor(place) {
  const primary = place.name || place.nameZh || place.id;
  const secondary = place.nameZh && place.nameZh !== primary ? place.nameZh : null;
  return secondary ? [`${primary} /`, secondary] : [primary];
}

/* chromeBox 已挪到 label-layout.mjs —— verify-projection.mjs 要拿同一个盒子复核，
   两处各写一份迟早会漂移。 */

/**
 * 处理一个已存在的 region，返回重建后的 region。
 * @returns {{region: object, report: object}}
 */
export async function rebuildRegion(region, { tripData, tripDir, tileCache, logger, previous }) {
  // logger 可为空：本模块是导出给别人用的库函数，调用方未必带日志器。
  const log = logger ?? { debug() {}, info() {}, warn() {} };
  const mapPlaces = new Map(tripData.map.places.map((place) => [place.id, place]));
  const missingGeo = region.places.filter((place) => !Number.isFinite(mapPlaces.get(place.id)?.geo?.lat));
  if (missingGeo.length) {
    throw new Error(`区域 ${region.id} 有 ${missingGeo.length} 个地点缺 geo：${missingGeo.map((p) => p.id).join(", ")}`);
  }

  const geos = region.places.map((place) => ({
    id: place.id,
    lat: mapPlaces.get(place.id).geo.lat,
    lng: mapPlaces.get(place.id).geo.lng,
  }));

  // 1. 墨卡托窗口（纯函数，与瓦片缓存无关）
  const window = planWindow(geos, PLAN_PARAMS);

  const outDir = path.join(tripDir, "assets", "maps", "regions");
  const fileName = `${region.id}.png`;
  const pngPath = path.join(outDir, fileName);

  // 2~3. 抓瓦片 + 拼图。指纹一致且底图已在盘上时整段跳过 ——
  //     别人 clone 后构建、以及 CI 构建，都不该需要联网。
  const fingerprint = planFingerprint(geos);
  const reusable = previous?.fingerprint === fingerprint && fs.existsSync(pngPath);
  let source;
  let cropped;
  let pngKB;
  if (reusable) {
    pngKB = Math.round(fs.statSync(pngPath).size / 1024);
    source = previous.source ?? null;
    cropped = previous.cropped ?? null;
    log.debug(`  ${region.id}: 底图指纹一致，复用 ${fileName}（${pngKB}KB），不抓瓦片`);
  } else {
    const tiles = await fetchTiles(tilesForWindow(window), { cacheDir: tileCache, logger });
    const mosaic = buildMosaic(tiles, window);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(pngPath, mosaic.buffer);
    source = mosaic.source;
    cropped = mosaic.cropped;
    pngKB = Math.round(mosaic.buffer.length / 1024);
  }

  // 4. 重投影：geo → 画布像素
  const positions = new Map(geos.map((geo) => [geo.id, geoToCanvas(geo, window)]));

  // 5. 标签布局（不使用模板的 labelFor，见 label-layout.mjs）
  const headingText = region.heading?.text || region.label;
  const { heading, legend, reserved, legendBottom } = chromeBox(region.routes.length, headingText);
  const labelInputs = region.places.map((place) => {
    const point = positions.get(place.id);
    const src = mapPlaces.get(place.id);
    return { id: place.id, x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)), lines: linesFor(src) };
  });
  const views = [
    region.overviewPlaceIds?.length ? region.overviewPlaceIds : labelInputs.map((p) => p.id),
    ...Object.values(region.dailyLayouts || {}).map((daily) => daily.places),
  ];
  const viewNames = [
    "总览",
    ...Object.keys(region.dailyLayouts || {}).map((day) => `第${day}天`),
  ];
  const { labels, collisions, cost } = layoutLabels(labelInputs, views, {
    canvas: { width: window.canvasWidth, height: window.canvasHeight },
    reserved: [reserved],
    fontSize: 24,
    dotRadius: 15,
    viewLabel: (index) => viewNames[index] || `视图${index}`,
    onProgress: (event) => log.debug(`  ${region.id} ${event.phase} ${event.sweep ?? event.round}: 代价 ${event.cost.toFixed(0)}，压字 ${event.collisions}`),
  });
  log.debug(`  ${region.id} 视图人数：${viewNames.map((name, index) => `${name}=${views[index].length}`).join(" ")}`);

  const placedById = new Map(labelInputs.map((place) => [place.id, place]));

  // 6. 重建 places / routes / dailyLayouts
  const places = region.places.map((place) => {
    const point = positions.get(place.id);
    const label = labels.get(place.id);
    const src = mapPlaces.get(place.id);
    return {
      ...place,
      x: Number(point.x.toFixed(2)),
      y: Number(point.y.toFixed(2)),
      tx: label.tx,
      ty: label.ty,
      anchor: label.anchor,
      lines: linesFor(src),
      geo: src.geo,
    };
  });
  const placeById = new Map(places.map((place) => [place.id, place]));

  const overviewSet = new Set(region.overviewPlaceIds || []);
  const routes = region.routes.map((route) => {
    const ids = route.placeIds.filter((id) => placeById.has(id));
    const detailed = routePath(ids, placeById, route.day);
    const overview = routePath(overviewRouteIds(ids, overviewSet), placeById, route.day);
    return {
      ...route,
      color: ROUTE_COLORS[(route.day - 1) % ROUTE_COLORS.length],
      placeIds: ids,
      paths: detailed ? [detailed] : [],
      overviewPaths: overview ? [overview] : [],
    };
  });

  // 模板写进 dailyLayouts 的 `places` 是**去过重**的（build-map.mjs: `[...new Set(ids)]`），
  // 但它自己的 `transport` 是按**未去重**的 `ids` 算出来的 —— 于是往返日（首尾同一点）
  // 两者差一格：places 比 transport 短 1。第 1 段的这一步不自洽被原样带过来，
  // 我们若照 `daily.places.slice(0, -1)` 重算 transport，就会把最后一段（回程）整段丢掉，
  // 地图上那一天少一个交通图钉（Day 2 城山→济州市区、Day 3 狭才→济州市区都栽在这）。
  // `region.routes` 里存着当日**未去重**、且已按区域裁过的点序列，正是该用的那一条。
  const routeSeqByDay = new Map((region.routes || []).map((route) => [String(route.day), route.placeIds || []]));
  const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

  const dailyLayouts = Object.fromEntries(Object.entries(region.dailyLayouts || {}).map(([day, daily]) => {
    const uniqueIds = [...new Set(daily.places.filter((id) => placeById.has(id)))];
    const labelsForDay = Object.fromEntries(uniqueIds.map((id) => {
      const place = placeById.get(id);
      return [id, { x: place.tx, y: place.ty, anchor: place.anchor }];
    }));
    // 模板自己的不变量是 `transport.length === 未去重序列.length - 1`。
    // 两个条件都满足才采用 route 序列：段数对得上、且它去重后就是 daily.places。
    // 任一不满足（例如 route 与 dailyLayouts 不同源、或磁盘上是上一次已被本模块改短的旧值）
    // 就退回原行为 —— 宁可少一段，也不凭猜测拼出一段不存在的交通。
    const seq = (routeSeqByDay.get(day) || []).filter((id) => placeById.has(id));
    const seqMatches = seq.length - 1 === (daily.transport?.length ?? -1) && sameIds([...new Set(seq)], uniqueIds);
    const ordered = seqMatches ? seq : daily.places;
    const transport = ordered.slice(0, -1)
      .map((id, index) => ({ id, next: ordered[index + 1], item: daily.transport?.[index] }))
      .filter((entry) => placeById.has(entry.id) && placeById.has(entry.next))
      .map((entry) => ({ items: entry.item?.items || [], ...midpoint(placeById.get(entry.id), placeById.get(entry.next)) }));
    return [day, { ...daily, places: uniqueIds, labels: labelsForDay, transport }];
  }));

  const geoBounds = windowGeoBounds(window);
  const bounds = {
    north: Number(geoBounds.north.toFixed(6)), west: Number(geoBounds.west.toFixed(6)),
    south: Number(geoBounds.south.toFixed(6)), east: Number(geoBounds.east.toFixed(6)),
  };
  const rebuilt = {
    ...region,
    canvas: { width: window.canvasWidth, height: window.canvasHeight },
    projection: { type: "web-mercator", bounds },
    baseImage: `assets/maps/regions/${fileName}`,
    heading: { ...heading, text: headingText },
    legend,
    scope: "real-basemap",
    mapMode: "web-mercator-osm",
    mapModeReason: "real-basemap-osm-tiles",
    // 覆盖继承来的手写免责声明：底图换成真实 OSM 后那句「不代表真实地理边界」已是假话
    disclaimer: REAL_MAP_DISCLAIMER,
    ariaLabel: `${region.label}真实地图旅行路线图，共${region.days.length}天`,
    routes,
    places,
    dailyLayouts,
  };

  /** 写进 metadata.realMaps，供下次构建判断能否跳过抓图。模板只覆盖 metadata.assets，这里安全。 */
  const sidecar = {
    fingerprint,
    file: `assets/maps/regions/${fileName}`,
    zoom: window.zoom,
    tileRange: {
      x0: window.originTileX, y0: window.originTileY,
      x1: window.originTileX + window.tilesX - 1, y1: window.originTileY + window.tilesY - 1,
    },
    tiles: window.tileCount,
    canvas: { width: window.canvasWidth, height: window.canvasHeight },
    source, cropped,
    contentAspect: Number(window.rawAspect.toFixed(4)),
    canvasAspect: Number(window.aspect.toFixed(4)),
    clampedAspect: window.clampedAspect,
    geoBounds: bounds,
    attribution: "© OpenStreetMap contributors",
    sourceUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    reused: reusable,
  };

  const report = {
    id: region.id,
    zoom: window.zoom,
    canvas: `${window.canvasWidth}×${window.canvasHeight}`,
    contentAspect: Number(window.rawAspect.toFixed(2)),
    canvasAspect: Number(window.aspect.toFixed(2)),
    clamped: window.clampedAspect,
    tiles: window.tileCount,
    source: source ? `${source.width}×${source.height}` : "复用",
    cropped: cropped ? `${cropped.width}×${cropped.height}` : "复用",
    scale: Number(window.scale.x.toFixed(3)),
    pngKB,
    reused: reusable,
    labelCost: Math.round(cost),
    collisions: collisions.map((c) => `${c.view}:${c.what}(${Number.isFinite(c.depth) ? `${c.depth.toFixed(1)}px` : "出界"})`),
    legendBottom,
  };
  return { region: rebuilt, report, sidecar };
}

/**
 * 对一份 trip-data 跑全部区域。
 * @returns {{tripData: object, reports: Array}}
 */
export async function buildRealMaps(tripData, { tripDir, tileCache, logger }) {
  if (!tripData.routeMap?.regions?.length) throw new Error("没有 routeMap.regions，先跑一次模板构建");
  const mapPlaces = new Map((tripData.map?.places || []).map((place) => [place.id, place]));
  const regionsWithoutGeo = tripData.routeMap.regions.filter((region) =>
    region.places.some((place) => !Number.isFinite(mapPlaces.get(place.id)?.geo?.lat)));
  if (regionsWithoutGeo.length) {
    throw new Error(
      `${regionsWithoutGeo.map((r) => r.id).join(", ")} 缺真实经纬度（map.places[].geo），` +
      `无法用真实底图；该目的地暂时保留示意图底图`);
  }
  const previousRealMaps = tripData.metadata?.realMaps || {};
  const reports = [];
  const regions = [];
  const realMaps = { ...previousRealMaps };
  for (const region of tripData.routeMap.regions) {
    const { region: rebuilt, report, sidecar } = await rebuildRegion(region, {
      tripData, tripDir, tileCache, logger, previous: previousRealMaps[region.id],
    });
    regions.push(rebuilt);
    reports.push(report);
    realMaps[region.id] = { ...sidecar, generatedAt: new Date().toISOString() };
  }
  const output = {
    ...tripData,
    routeMap: { ...tripData.routeMap, regions },
    metadata: {
      ...tripData.metadata,
      realMaps,
      assets: { ...(tripData.metadata?.assets || {}), routeMaps: [...new Set(regions.map((region) => region.baseImage))] },
    },
  };
  return { tripData: output, reports };
}
