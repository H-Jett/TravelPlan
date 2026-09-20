#!/usr/bin/env node
/**
 * 本地预览 home/site/（首页 + 所有目的地）。
 * 必须先 npm run build，本脚本只负责起一个静态服务器，不做任何构建。
 *
 *   npm run preview            从 / 进入首页
 *   npm run preview -- --open  起完服务后打印首页地址
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

import { HOME_SITE_DIR, ROOT } from "./lib/paths.mjs";
import { createLogger } from "./lib/log.mjs";

const log = createLogger("preview");

if (!fs.existsSync(path.join(HOME_SITE_DIR, "index.html"))) {
  log.error(`还没构建过：${path.relative(ROOT, HOME_SITE_DIR)}/index.html 不存在。先跑 npm run build`);
  process.exit(1);
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2"
};

const host = process.env.HOST || "127.0.0.1";
const requestedPort = Number(process.env.PORT || 4173);
let activePort = requestedPort;

function send(response, status, headers, body) {
  response.writeHead(status, headers);
  response.end(body);
}

function serve(request, response, url) {
  if (!["GET", "HEAD"].includes(request.method || "GET")) {
    send(response, 405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" }, "Method not allowed");
    return;
  }

  let requested;
  try {
    requested = decodeURIComponent(url.pathname);
  } catch {
    send(response, 400, { "content-type": "text/plain; charset=utf-8" }, "Bad request");
    return;
  }

  // 目录请求补 index.html，和静态托管的默认行为保持一致
  if (requested.endsWith("/")) requested += "index.html";
  const filePath = path.resolve(HOME_SITE_DIR, `.${requested}`);

  if (filePath !== HOME_SITE_DIR && !filePath.startsWith(`${HOME_SITE_DIR}${path.sep}`)) {
    send(response, 403, { "content-type": "text/plain; charset=utf-8" }, "Forbidden");
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    send(response, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
    return;
  }
  if (stat.isDirectory()) {
    response.writeHead(302, { location: `${url.pathname.replace(/\/?$/, "/")}` });
    response.end();
    return;
  }

  const body = fs.readFileSync(filePath);
  send(response, 200, {
    "content-type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-store"
  }, request.method === "HEAD" ? undefined : body);
}

const server = http.createServer((request, response) => {
  try {
    serve(request, response, new URL(request.url, `http://${host}:${activePort}`));
  } catch (error) {
    log.error(`请求处理失败: ${error.message}`);
    send(response, 500, { "content-type": "text/plain; charset=utf-8" }, `Preview server failed: ${error.message}`);
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && !process.env.PORT && activePort < requestedPort + 20) {
    activePort += 1;
    server.listen(activePort, host);
    return;
  }
  log.error(`监听失败: ${error.message}`);
  process.exit(1);
});

server.listen(activePort, host, () => {
  log.info(`站点目录: ${HOME_SITE_DIR}`);
  log.info(`Travel plans preview: http://${host}:${activePort}/`);
  log.info("仅本地预览。运行时数据（记账/Todo/门票）只存在浏览器本地。");
  log.close();
});
