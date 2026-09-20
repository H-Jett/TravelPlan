/**
 * 地点标签布局：决定每个标签的 tx / ty / anchor。
 *
 * ## 为什么不用模板的 labelFor()
 *
 * `template/scripts/build-map.mjs:299` 的 labelFor() 有两个硬伤：
 *  1. 候选位移只有 **12 个固定方位**
 *  2. 判碰撞用的是**估算宽度**，且只估 `name`/`nameZh` 里较长的那一个，
 *     完全没算两行标签里第一行末尾那个 ` /`（`lines` 是 `["Name /", "中文名"]`）
 *
 * 地点一密集（首尔 17 个）12 个方位全被占满，算法只能退而选「撞得最轻」的那个 ——
 * 实测它自己会把首尔站标签甩到离圆点 200px、清潭洞 335px、仁川机场直接甩出画布。
 * 本脚本是 routeMap 的新生成者，不必再复刻那套启发式，直接做正经布局。
 *
 * ## 判据：重叠**深度** ≥4px，不是「有没有相交」
 *
 * `getBBox()` 返回的是 em 布局盒（含 ascent/descent 空白），两盒相交几像素往往毫无墨迹接触。
 * 所以算「真压字」要看待重叠深度，阈值 4px。这与验收脚本 `/tmp/verify/labeldepth.cjs`
 * 用的是同一把尺子 —— 本模块的求解目标就是那个脚本的通过条件。
 *
 * ## 目标函数：连续代价 + 坐标下降
 *
 * 重叠**计数**是个阶梯函数、大片平台，坐标下降会卡在烂解（实测卡在 (-256,-232)）。
 * 改用「超过阈值的重叠深度之和」后梯度信息足够，再以标签离圆点的位移做次要项。
 */

/** Times New Roman Bold 的字宽表（单位 /1000 em），取自标准 AFM 度量。 */
const LATIN_WIDTHS = {
  " ": 250, "!": 333, '"': 555, "#": 500, $: 500, "%": 1000, "&": 833, "'": 238,
  "(": 333, ")": 333, "*": 500, "+": 570, ",": 250, "-": 333, ".": 250, "/": 278,
  ":": 333, ";": 333, "<": 570, "=": 570, ">": 570, "?": 500, "@": 930,
  "[": 333, "\\": 278, "]": 333, "^": 570, _: 500, "`": 333,
  "{": 348, "|": 220, "}": 348, "~": 570,
  0: 500, 1: 500, 2: 500, 3: 500, 4: 500, 5: 500, 6: 500, 7: 500, 8: 500, 9: 500,
  A: 722, B: 667, C: 667, D: 722, E: 667, F: 611, G: 778, H: 778, I: 389, J: 500,
  K: 722, L: 611, M: 944, N: 722, O: 778, P: 611, Q: 778, R: 667, S: 556, T: 611,
  U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611,
  a: 500, b: 556, c: 444, d: 556, e: 444, f: 333, g: 500, h: 556, i: 278, j: 333,
  k: 556, l: 278, m: 833, n: 556, o: 500, p: 556, q: 556, r: 444, s: 389, t: 333,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 444,
};

/** 是否全角（CJK/假名/全角标点）—— 这些在回退字体里基本是 1em 宽。 */
function isFullWidth(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}

// 实测校准（/tmp/korea-trip/labeldims.json，33 个标签的浏览器 getBBox 宽度）：
// 上面的 AFM 表 + 全角 1em 复算，与实测误差普遍 <1%（如 "Jeju International Airport /"
// 算得 283.3px、实测 283.06px）。加 3% 余量兜住字体回退差异。
const WIDTH_SAFETY = 1.03;

/** 估算一行文本的渲染宽度（px）。 */
export function estimateLineWidth(text, fontSize) {
  let units = 0;
  for (const character of String(text)) {
    const codePoint = character.codePointAt(0);
    if (isFullWidth(codePoint)) units += 1000;
    else units += LATIN_WIDTHS[character] ?? 556;
  }
  return (units / 1000) * fontSize * WIDTH_SAFETY;
}

/** 标签文本宽度 = 各行里最宽的一行。 */
export function estimateLabelWidth(lines, fontSize) {
  return Math.max(...lines.map((line) => estimateLineWidth(line, fontSize)));
}

/** 基线到 em 盒顶部的距离（实测 21.1px @ font-size 24）。 */
const ASCENT = 21.1;
/** em 盒底部到最后一行的距离（实测：两行盒高 57.38 = 21.1 + 31 + 5.28）。 */
const DESCENT = 5.28;

/** 标签盒高度：单行 26.38，两行 57.38。 */
export function labelHeight(lineCount, lineHeight = 31) {
  return ASCENT + (lineCount - 1) * lineHeight + DESCENT + (lineCount - 1) * 0;
}

/**
 * 标签盒（em 布局盒，与 getBBox 同口径）。
 * anchor 由 dx 的符号决定 —— 它是**输出**，不是输入。
 */
export function labelBox(place, dx, dy, width, height) {
  const anchor = dx < 0 ? "end" : "start";
  const x = place.x + dx;
  const y = place.y + dy;
  return { x: anchor === "end" ? x - width : x, y: y - ASCENT, width, height, anchor, tx: x, ty: y };
}

/** 圆形/矩形的重叠深度（不相交为 0）。 */
function depth(a, b) {
  const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return dx > 0 && dy > 0 ? Math.min(dx, dy) : 0;
}

/** 超过阈值的重叠深度 —— 只有它才计入代价。 */
function penalty(a, b, threshold) {
  const value = depth(a, b);
  return value > threshold ? value - threshold : 0;
}

/**
 * 重叠代价的权重，远大于位移（位移量级几百 px，单处重叠量级几十 px）。
 * 于是总代价近似**词典序**：先把重叠压到最小，重叠打平了再比谁离圆点近。
 * 少了这个权重，位移会和重叠同量级竞争，求解器就会拿「多几处轻微重叠」去换
 * 「标签更贴圆点」—— 实测会来回震荡，代价降了但压字数量反而涨。
 */
const PENALTY_WEIGHT = 1e4;

const ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const RADII = [26, 46, 70, 96, 120, 170, 230, 300];
/** 模板 labelFor 原生的 12 个方位，作为初始解。 */
const TEMPLATE_CHOICES = [[32, -32], [32, 50], [-32, -32], [-32, 50], [78, -62], [78, 76], [-78, -62], [-78, 76], [138, -88], [-138, -88], [138, 102], [-138, 102]];

/** 候选位移：12 个原生方位 + 若干同心环。 */
export function candidateOffsets() {
  const seen = new Set();
  const out = [];
  const push = (dx, dy) => {
    const key = `${dx},${dy}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ dx, dy });
  };
  for (const [dx, dy] of TEMPLATE_CHOICES) push(dx, dy);
  for (const radius of RADII) {
    for (const angle of ANGLES) {
      push(Math.round(radius * Math.cos((angle * Math.PI) / 180)), Math.round(radius * Math.sin((angle * Math.PI) / 180)));
    }
  }
  return out;
}

/**
 * 布局标签。
 *
 * @param {Array<{id, x, y, lines}>} places 地点（x/y 已是画布像素坐标）
 * @param {Array<Array<string>>} views 每个视图可见的 place id 列表（总览 + 各天）
 * @param {object} options
 * @returns {{labels: Map<string, {dx, dy, anchor, tx, ty}>, collisions: Array, cost: number}}
 */
export function layoutLabels(places, views, {
  canvas,
  reserved = [],
  fontSize = 24,
  lineHeight = 31,
  dotRadius = 13,
  depthThreshold = 4,
  sweeps = 40,
  refineRounds = 6,
  refineStep = 8,
  refineRange = 48,
  onProgress = null,
  viewLabel = null,
} = {}) {
  const byId = new Map(places.map((place) => [place.id, place]));
  const widths = new Map(places.map((place) => [place.id, estimateLabelWidth(place.lines, fontSize)]));
  const heights = new Map(places.map((place) => [place.id, labelHeight(place.lines.length, lineHeight)]));
  const dots = new Map(places.map((place) => [place.id, {
    x: place.x - dotRadius, y: place.y - dotRadius, width: dotRadius * 2, height: dotRadius * 2,
  }]));

  const visibleViews = views.filter((ids) => ids.length > 1);
  const viewsOf = new Map(places.map((place) => [place.id, visibleViews.filter((ids) => ids.includes(place.id))]));

  const offsets = new Map(places.map((place, index) => {
    const [dx, dy] = TEMPLATE_CHOICES[(index * 2) % TEMPLATE_CHOICES.length];
    return [place.id, { dx, dy }];
  }));

  const boxes = new Map();
  const inCanvasOf = new Map();
  const displacementOf = new Map();

  function refresh(id) {
    const place = byId.get(id);
    const { dx, dy } = offsets.get(id);
    const box = labelBox(place, dx, dy, widths.get(id), heights.get(id));
    boxes.set(id, box);
    // 出画布按巨大代价罚 —— 但不能是无穷，否则梯度信息全被淹没
    inCanvasOf.set(id,
      box.x >= 6 && box.x + box.width <= canvas.width - 6 &&
      box.y >= 6 && box.y + box.height <= canvas.height - 6);
    displacementOf.set(id, Math.hypot(dx, dy));
    return box;
  }
  for (const place of places) refresh(place.id);

  /** 某个标签在它出现的所有视图里造成的代价（重叠深度 + 位移 + 出界）。 */
  function localCost(id) {
    const box = boxes.get(id);
    let overlap = 0;
    for (const view of viewsOf.get(id)) {
      for (const other of view) {
        if (other === id) continue;
        overlap += penalty(box, boxes.get(other), depthThreshold);
        overlap += penalty(box, dots.get(other), depthThreshold);
      }
    }
    for (const item of reserved) overlap += penalty(box, item, depthThreshold);
    let cost = overlap * PENALTY_WEIGHT + displacementOf.get(id);
    if (!inCanvasOf.get(id)) cost += 1e6;
    return cost;
  }

  const costOf = new Map(places.map((place) => [place.id, localCost(place.id)]));
  let total = [...costOf.values()].reduce((sum, value) => sum + value, 0);

  const CANDIDATES = candidateOffsets();
  const FINE = [];
  for (let d = -refineRange; d <= refineRange; d += refineStep) FINE.push(d);

  /** 对一个地点做一轮坐标下降：试遍候选，取使总代价最小的那个。 */
  function bestOffsetFor(place) {
    const id = place.id;
    const current = offsets.get(id);
    let best = current;
    let bestCost = total;
    for (const candidate of CANDIDATES) {
      if (candidate.dx === current.dx && candidate.dy === current.dy) continue;
      offsets.set(id, candidate);
      refresh(id);
      const next = total - costOf.get(id) + localCost(id);
      if (next < bestCost - 1e-9) { bestCost = next; best = candidate; }
    }
    offsets.set(id, best);
    refresh(id);
    costOf.set(id, localCost(id));
    total = bestCost;
    return best !== current;
  }

  /** 在当前位置附近扫小网格，把环形候选落不到最优解附近的几十像素浪费掉。 */
  function refineOne(place) {
    const id = place.id;
    const start = offsets.get(id);
    let best = start;
    let bestCost = total;
    for (const dx of FINE) {
      for (const dy of FINE) {
        const candidate = { dx: start.dx + dx, dy: start.dy + dy };
        offsets.set(id, candidate);
        refresh(id);
        const next = total - costOf.get(id) + localCost(id);
        if (next < bestCost - 1e-9) { bestCost = next; best = candidate; }
      }
    }
    offsets.set(id, best);
    refresh(id);
    costOf.set(id, localCost(id));
    total = bestCost;
    return best !== start;
  }

  for (let sweep = 1; sweep <= sweeps; sweep += 1) {
    let improved = false;
    for (const place of places) if (bestOffsetFor(place)) improved = true;
    if (onProgress) onProgress({ phase: "sweep", sweep, cost: total, collisions: countCollisions().length });
    if (!improved) break;
  }
  for (let round = 1; round <= refineRounds; round += 1) {
    let improved = false;
    for (const place of places) if (refineOne(place)) improved = true;
    if (onProgress) onProgress({ phase: "refine", round, cost: total, collisions: countCollisions().length });
    if (!improved) break;
  }

  /** 逐视图列出超过阈值的真压字。 */
  function countCollisions() {
    const found = [];
    for (const [viewIndex, view] of visibleViews.entries()) {
      const tag = viewLabel ? viewLabel(viewIndex, view) : `视图${viewIndex}`;
      for (let i = 0; i < view.length; i += 1) {
        for (let j = i + 1; j < view.length; j += 1) {
          const d = depth(boxes.get(view[i]), boxes.get(view[j]));
          if (d >= depthThreshold) found.push({ view: tag, what: `${view[i]}×${view[j]}`, depth: d });
        }
      }
      for (const id of view) {
        for (const other of view) {
          if (other === id) continue;
          const d = depth(boxes.get(id), dots.get(other));
          if (d >= depthThreshold) found.push({ view: tag, what: `${id}压${other}(圆点)`, depth: d });
        }
      }
    }
    for (const place of places) {
      for (const item of reserved) {
        const d = depth(boxes.get(place.id), item);
        if (d >= depthThreshold) found.push({ view: "标题区", what: `${place.id}压标题`, depth: d });
      }
      if (!inCanvasOf.get(place.id)) found.push({ view: "画布", what: `${place.id}出画布`, depth: Infinity });
    }
    return found;
  }

  const labels = new Map(places.map((place) => {
    const { dx, dy } = offsets.get(place.id);
    const box = boxes.get(place.id);
    return [place.id, { dx, dy, anchor: box.anchor, tx: Number(box.tx.toFixed(2)), ty: Number(box.ty.toFixed(2)) }];
  }));

  return { labels, collisions: countCollisions(), cost: total };
}
