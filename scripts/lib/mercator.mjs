/**
 * Web Mercator 投影与瓦片窗口计算。
 *
 * 为什么单独一个模块：这套数学是「地点画在正确位置」的全部依据，
 * 也是最容易写错的地方（一个像素的偏移会被缩放到几十像素）。
 * 单独成文件便于单独测，不必跑整个构建。
 *
 * 约定：瓦片用标准 OSM 编号（z/x/y，y 从北向南），瓦片边长 256px。
 *
 * ## 画布尺寸为什么不跟着内容宽高比走
 *
 * 底图是 `<image preserveAspectRatio="none">`（overview-map.js:158），会被**拉伸**填满
 * 整个 viewBox，所以底图宽高比必须与 canvas 完全一致，否则地图变形。
 *
 * 但「等于内容宽高比」会让济州岛变成 1448×284 的一条 —— 济州 7 个地点全是东西向分布的，
 * 真实宽高比 5.10:1。画布只有 284 高时，标题（y=105）和 4 行图例（排到 y≈305）直接出界。
 *
 * 所以这里做两件事：
 *  1. canvas.width **固定**为 1448，与改造前一致。viewBox 宽度不变 ⇒ 模板里
 *     `place.size`（24）、图例字号（23）、图例 gap（43）、以及 HTML 圆点（固定 24 CSS px）
 *     全部沿用原调校，不需要跟着画布重新缩放。
 *  2. canvas.height = 1448 / 宽高比，宽高比**夹在 [minAspect, maxAspect] 之间**：
 *     内容太扁就向南北两侧**多展一点真实地图**（不是拉伸 —— 拉伸才会让位置失真）。
 *
 * 关键区别：夹宽高比是「多显示一些地图」，畸变是「把地图拉长」。前者位置依然正确。
 */

export const TILE_SIZE = 256;

/** 画布宽度固定 1448：与改造前一致，模板排版参数可直接沿用。 */
export const CANVAS_WIDTH = 1448;

/** 经度 → 归一化墨卡托 x（0..1，西→东）。 */
export function lngToUnitX(lng) {
  return (lng + 180) / 360;
}

/** 纬度 → 归一化墨卡托 y（0..1，北→南）。 */
export function latToUnitY(lat) {
  const radians = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

/** 归一化墨卡托 x → 经度。 */
export function unitXToLng(x) {
  return x * 360 - 180;
}

/** 归一化墨卡托 y → 纬度。 */
export function unitYToLat(y) {
  const n = Math.PI - 2 * Math.PI * y;
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** 经纬度 → 归一化墨卡托点。 */
export function geoToUnit(geo) {
  return { x: lngToUnitX(geo.lng), y: latToUnitY(geo.lat) };
}

/** 归一化墨卡托点 → 经纬度。 */
export function unitToGeo(point) {
  return { lng: unitXToLng(point.x), lat: unitYToLat(point.y) };
}

/** 经度 → 该缩放级别下的瓦片 x（含小数）。 */
export function lngToTileX(lng, zoom) {
  return lngToUnitX(lng) * 2 ** zoom;
}

/** 纬度 → 该缩放级别下的瓦片 y（含小数）。 */
export function latToTileY(lat, zoom) {
  return latToUnitY(lat) * 2 ** zoom;
}

/** 一组 geo 点的归一化墨卡托包围盒（未加 padding）。 */
export function contentBounds(geos) {
  if (!geos.length) throw new Error("contentBounds: 需要至少一个 geo 点");
  const units = geos.map(geoToUnit);
  const xs = units.map((unit) => unit.x);
  const ys = units.map((unit) => unit.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

/**
 * 把包围盒按目标宽高比扩张（居中），再统一留白。
 *
 * 扩张方向由宽高比决定：内容偏扁（aspect 偏大）就上下加，偏高就左右加。
 * 加出来的面积是**真实地图**，不是拉伸。
 */
export function expandToAspect(bounds, { aspect, minAspect = 1.1, maxAspect = 3.4, paddingRatio = 0.08 }) {
  const target = Math.min(maxAspect, Math.max(minAspect, aspect));
  let { minX, maxX, minY, maxY } = bounds;
  // 退化包围盒（所有点重合/共线）给个最小边长，否则后面除零
  const minimum = 1e-6;
  if (maxX - minX < minimum) { const mid = (minX + maxX) / 2; minX = mid - minimum / 2; maxX = mid + minimum / 2; }
  if (maxY - minY < minimum) { const mid = (minY + maxY) / 2; minY = mid - minimum / 2; maxY = mid + minimum / 2; }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  let width = maxX - minX;
  let height = maxY - minY;

  // 先按目标宽高比扩张较短的那一维
  if (width / height > target) height = width / target;
  else width = height * target;

  // 再统一留白（等比，不改变宽高比）
  width *= 1 + paddingRatio * 2;
  height *= 1 + paddingRatio * 2;

  return {
    minX: centerX - width / 2, maxX: centerX + width / 2,
    minY: centerY - height / 2, maxY: centerY + height / 2,
    aspect: width / height,
  };
}

/** 窗口覆盖的经纬度范围。 */
export function windowGeoBounds(window) {
  const northWest = unitToGeo({ x: window.bounds.minX, y: window.bounds.minY });
  const southEast = unitToGeo({ x: window.bounds.maxX, y: window.bounds.maxY });
  return {
    north: northWest.lat, west: northWest.lng,
    south: southEast.lat, east: southEast.lng,
    spanLng: southEast.lng - northWest.lng,
    spanLat: southEast.lat - northWest.lat,
  };
}

/**
 * 规划一个区域的瓦片窗口。
 *
 * 缩放级别：从 minZoom 往上试（不从高往低 —— 我们要的只是「源图足够覆盖画布」，
 * 级别越低瓦片越少），取第一个「窗口像素宽 ≥ canvasWidth 且瓦片总数 ≤ maxTiles」的级别。
 * 凡是满足「源 ≥ 目标」就是**降采样**，出图锐利；低级不够清晰时才升一级。
 *
 * @returns {{
 *   zoom, canvasWidth, canvasHeight, bounds, aspect,
 *   originTileX, originTileY, tilesX, tilesY, tileCount,
 *   windowPx: {x0, y0, x1, y1},   // 窗口在「z 像素空间」的位置（用于裁剪）
 *   crop: {x, y, width, height},  // 相对拼接图左上角的裁剪矩形
 *   scale: {x, y},                // z 像素 → 画布像素的缩放比（≤1 即降采样）
 * }}
 */
export function planWindow(geos, {
  canvasWidth = CANVAS_WIDTH,
  paddingRatio = 0.08,
  minAspect = 1.1,
  maxAspect = 3.4,
  minZoom = 10,
  maxZoom = 15,
  maxTiles = 64,
} = {}) {
  if (!geos.length) throw new Error("planWindow: 需要至少一个 geo 点");
  const raw = contentBounds(geos);
  const rawAspect = (raw.maxX - raw.minX) / (raw.maxY - raw.minY);
  const bounds = expandToAspect(raw, { aspect: rawAspect, minAspect, maxAspect, paddingRatio });
  const canvasHeight = Math.round(canvasWidth / bounds.aspect);
  const unitWidth = bounds.maxX - bounds.minX;
  const unitHeight = bounds.maxY - bounds.minY;

  let lastAttempt = null;
  for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
    const scaleFactor = 2 ** zoom * TILE_SIZE;      // 归一化单位 → z 像素
    const x0 = bounds.minX * scaleFactor;
    const y0 = bounds.minY * scaleFactor;
    const x1 = bounds.maxX * scaleFactor;
    const y1 = bounds.maxY * scaleFactor;
    const originTileX = Math.floor(x0 / TILE_SIZE);
    const originTileY = Math.floor(y0 / TILE_SIZE);
    // ceil 而非 floor：末瓦片只要沾到窗口就要抓（x1 恰好落格时不多抓一张）
    const tilesX = Math.ceil(x1 / TILE_SIZE) - originTileX;
    const tilesY = Math.ceil(y1 / TILE_SIZE) - originTileY;
    const attempt = {
      zoom,
      canvasWidth,
      canvasHeight,
      bounds,
      aspect: bounds.aspect,
      rawAspect,
      clampedAspect: Math.abs(bounds.aspect - rawAspect) > 1e-9,
      unitWidth,
      unitHeight,
      originTileX,
      originTileY,
      tilesX,
      tilesY,
      tileCount: tilesX * tilesY,
      windowPx: { x0, y0, x1, y1 },
      crop: {
        x: x0 - originTileX * TILE_SIZE,
        y: y0 - originTileY * TILE_SIZE,
        width: x1 - x0,
        height: y1 - y0,
      },
      scale: { x: canvasWidth / (x1 - x0), y: canvasHeight / (y1 - y0) },
    };
    lastAttempt = attempt;
    const coversCanvas = x1 - x0 >= canvasWidth && y1 - y0 >= canvasHeight;
    if (coversCanvas && attempt.tileCount <= maxTiles) return attempt;
  }
  throw new Error(
    `planWindow: 到 z=${maxZoom} 仍未找到满足条件（源 ≥ 画布 ${canvasWidth}×${canvasHeight}，` +
    `瓦片 ≤ ${maxTiles}）的级别；最后一次尝试 ` +
    `${lastAttempt.tilesX}×${lastAttempt.tilesY}=${lastAttempt.tileCount} 张。geo 点可能过于分散。`
  );
}

/**
 * geo → 画布像素坐标。
 *
 * 三段式：（瓦片坐标 → z 像素）→ 减去窗口原点 → 乘缩放比。
 * 窗口边界必须精确落在 0 与 canvasWidth/Height 上，否则地点会整体偏移。
 */
export function geoToCanvas(geo, window) {
  const scaleFactor = 2 ** window.zoom * TILE_SIZE;
  const px = lngToUnitX(geo.lng) * scaleFactor;
  const py = latToUnitY(geo.lat) * scaleFactor;
  return {
    x: (px - window.windowPx.x0) * window.scale.x,
    y: (py - window.windowPx.y0) * window.scale.y,
  };
}

/** 画布像素坐标 → 经纬度（反向校验用）。 */
export function canvasToGeo(point, window) {
  const scaleFactor = 2 ** window.zoom * TILE_SIZE;
  const px = window.windowPx.x0 + point.x / window.scale.x;
  const py = window.windowPx.y0 + point.y / window.scale.y;
  return unitToGeo({ x: px / scaleFactor, y: py / scaleFactor });
}
