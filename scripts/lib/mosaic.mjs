/**
 * 把若干张 256×256 瓦片拼成一张底图。
 *
 * 三步：拼接 → 裁剪到窗口 → 重采样到画布尺寸。
 *
 * ## 为什么要重采样
 *
 * 底图是 `<image preserveAspectRatio="none">`，会被拉伸填满 viewBox，
 * 所以底图宽高比必须与 canvas 一致（见 mercator.mjs 的说明）。
 * 而 canvas 宽固定 1448、高按夹过的宽高比算，几乎不可能正好等于
 * 「整数张瓦片 × 256」—— 所以必须把裁剪出来的窗口重采样到精确的画布尺寸。
 *
 * ## 重采样算法
 *
 * 分两种情况，因为两者的最优解不同：
 *  - **降采样**（缩放 < 1，常态）：面积平均（box filter）。每个目标像素取源矩形内
 *    所有像素的加权平均。地图上多的是细线（路网、海岸线），用双线性降采样会
 *    只采到 1/2 或 1/3 的源像素、产生摩尔纹；面积平均不会。
 *  - **升采样**（缩放 > 1，源图不够大时）：双线性。面积平均在这种情况下退化成最近邻，
 *    会出方块。
 */

import { PNG } from "pngjs";
import { TILE_SIZE } from "./mercator.mjs";
import { tileKey } from "./tiles.mjs";

/** 解码一张 PNG 瓦片。 */
export function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

/**
 * 把瓦片拼成一张大图。
 * @param {Map<string, Buffer>} tiles  key = `z/x/y`
 * @returns {{width, height, data: Buffer}} RGBA
 */
export function stitchTiles(tiles, window) {
  const width = window.tilesX * TILE_SIZE;
  const height = window.tilesY * TILE_SIZE;
  const data = Buffer.alloc(width * height * 4);

  for (let dy = 0; dy < window.tilesY; dy += 1) {
    for (let dx = 0; dx < window.tilesX; dx += 1) {
      const x = window.originTileX + dx;
      const y = window.originTileY + dy;
      const buffer = tiles.get(tileKey(window.zoom, x, y));
      if (!buffer) throw new Error(`拼接缺瓦片 ${tileKey(window.zoom, x, y)}`);
      const tile = decodePng(buffer);
      if (tile.width !== TILE_SIZE || tile.height !== TILE_SIZE) {
        throw new Error(`瓦片 ${tileKey(window.zoom, x, y)} 尺寸异常：${tile.width}×${tile.height}`);
      }
      // 逐行 copy，比逐像素快得多
      const rowBytes = TILE_SIZE * 4;
      for (let row = 0; row < TILE_SIZE; row += 1) {
        const srcStart = row * rowBytes;
        const dstStart = ((dy * TILE_SIZE + row) * width + dx * TILE_SIZE) * 4;
        tile.data.copy(data, dstStart, srcStart, srcStart + rowBytes);
      }
    }
  }
  return { width, height, data };
}

/**
 * 裁剪。矩形按像素取整（向外扩张半像素），保证不丢内容。
 */
export function cropImage(image, rect) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) throw new Error(`裁剪矩形越界：${JSON.stringify(rect)}`);

  const data = Buffer.alloc(width * height * 4);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const srcStart = ((y0 + row) * image.width + x0) * 4;
    image.data.copy(data, row * rowBytes, srcStart, srcStart + rowBytes);
  }
  return { width, height, data };
}

/** 面积平均降采样。 */
function resampleArea(image, targetWidth, targetHeight) {
  const data = Buffer.alloc(targetWidth * targetHeight * 4);
  const scaleX = image.width / targetWidth;
  const scaleY = image.height / targetHeight;

  for (let ty = 0; ty < targetHeight; ty += 1) {
    const sy0 = ty * scaleY;
    const sy1 = sy0 + scaleY;
    const iy0 = Math.floor(sy0);
    const iy1 = Math.min(image.height, Math.ceil(sy1));

    for (let tx = 0; tx < targetWidth; tx += 1) {
      const sx0 = tx * scaleX;
      const sx1 = sx0 + scaleX;
      const ix0 = Math.floor(sx0);
      const ix1 = Math.min(image.width, Math.ceil(sx1));

      let r = 0, g = 0, b = 0, sumW = 0, sumWA = 0;
      for (let sy = iy0; sy < iy1; sy += 1) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = ix0; sx < ix1; sx += 1) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const at = (sy * image.width + sx) * 4;
          const alpha = image.data[at + 3] / 255;
          // 颜色按 alpha 预乘后再平均，最后除掉总 alpha 还原 —— 避免透明像素把颜色拉黑
          r += image.data[at] * w * alpha;
          g += image.data[at + 1] * w * alpha;
          b += image.data[at + 2] * w * alpha;
          sumW += w;
          sumWA += w * alpha;
        }
      }

      const out = (ty * targetWidth + tx) * 4;
      if (sumWA > 0) {
        data[out] = Math.round(r / sumWA);
        data[out + 1] = Math.round(g / sumWA);
        data[out + 2] = Math.round(b / sumWA);
        // 还原后的 alpha = alpha 加权平均：sumWA / sumW
        data[out + 3] = Math.round((255 * sumWA) / sumW);
      }
      // 全透明区域保持 0
    }
  }
  return { width: targetWidth, height: targetHeight, data };
}

/** 双线性升采样。 */
function resampleBilinear(image, targetWidth, targetHeight) {
  const data = Buffer.alloc(targetWidth * targetHeight * 4);
  const scaleX = image.width / targetWidth;
  const scaleY = image.height / targetHeight;

  for (let ty = 0; ty < targetHeight; ty += 1) {
    // 目标像素中心对应的源坐标
    const sy = (ty + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));

    for (let tx = 0; tx < targetWidth; tx += 1) {
      const sx = (tx + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));

      const out = (ty * targetWidth + tx) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const p00 = image.data[(y0 * image.width + x0) * 4 + channel];
        const p10 = image.data[(y0 * image.width + x1) * 4 + channel];
        const p01 = image.data[(y1 * image.width + x0) * 4 + channel];
        const p11 = image.data[(y1 * image.width + x1) * 4 + channel];
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        data[out + channel] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { width: targetWidth, height: targetHeight, data };
}

/** 重采样到目标尺寸，自动选算法。 */
export function resampleImage(image, targetWidth, targetHeight) {
  const scale = Math.min(targetWidth / image.width, targetHeight / image.height);
  return scale < 1
    ? resampleArea(image, targetWidth, targetHeight)
    : resampleBilinear(image, targetWidth, targetHeight);
}

/**
 * 编码成 PNG。地图是不透明的，用 colorType 2（RGB）而不是 6（RGBA），
 * 少掉一整个 alpha 通道，文件明显更小。
 */
export function encodePng(image) {
  const png = new PNG({ width: image.width, height: image.height, colorType: 2 });
  png.data = image.data;
  return PNG.sync.write(png, { colorType: 2, inputColorType: 6, inputHasAlpha: true });
}

/**
 * 全流程：瓦片 → 拼接 → 裁剪到窗口 → 重采样到画布尺寸 → PNG。
 * @returns {{buffer: Buffer, source: {width, height}, cropped: {width, height}}}
 */
export function buildMosaic(tiles, window) {
  const stitched = stitchTiles(tiles, window);
  const cropped = cropImage(stitched, window.crop);
  const scaled = resampleImage(cropped, window.canvasWidth, window.canvasHeight);
  return {
    buffer: encodePng(scaled),
    source: { width: stitched.width, height: stitched.height },
    cropped: { width: cropped.width, height: cropped.height },
  };
}
