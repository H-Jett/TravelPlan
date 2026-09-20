#!/usr/bin/env node
/**
 * 手动把 home/site/ 发布到远程分支（GitHub Pages 的 "Deploy from a branch" 模式）。
 *
 *   npm run deploy -- --dry-run                 只打印要做什么，不推送
 *   npm run deploy                              构建后推送到 gh-pages
 *   npm run deploy -- --branch main --dir docs  推到 main 的 docs/
 *
 * 什么时候需要它：
 *   - 仓库 Pages 设置为 "Deploy from a branch"（而不是 GitHub Actions）时；
 *   - 或者想在 Actions 之外手动补一次发布。
 * 仓库已带 .github/workflows/pages.yml，走 Actions 模式时**不需要**跑本脚本。
 *
 * 不做的事：不建仓库、不改 Pages 设置、不碰凭据。
 * 推送认证走 ~/.ssh/config 里的别名（默认 github-jiangh → H-Jett）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { HOME_SITE_DIR, ROOT } from "./lib/paths.mjs";
import { createLogger } from "./lib/log.mjs";

const log = createLogger("deploy");

const OPTIONS = new Set(["branch", "dir", "remote", "message", "dry-run", "no-build", "alias"]);
function parseArgs(argv) {
  const values = { "dry-run": false, "no-build": false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`无法识别的参数: ${arg}`);
    const name = arg.slice(2);
    if (!OPTIONS.has(name)) throw new Error(`未知选项: --${name}`);
    if (name === "dry-run" || name === "no-build") { values[name] = true; continue; }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} 需要一个值`);
    values[name] = value;
    i += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const branch = args.branch || "gh-pages";
const remote = args.remote || "origin";
const alias = args.alias || "github-jiangh";
const subdir = (args.dir || "").replace(/^\/+|\/+$/g, "");
const dryRun = args["dry-run"];

function run(command, argv, options = {}) {
  const printable = `${command} ${argv.join(" ")}`;
  if (dryRun) { log.info(`[dry-run] ${printable}`); return { status: 0, stdout: "", stderr: "" }; }
  log.debug(`$ ${printable}`);
  const result = spawnSync(command, argv, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`命令失败 (${result.status}): ${printable}\n${detail}`);
  }
  return result;
}

function runSoft(command, argv, options = {}) {
  const result = spawnSync(command, argv, { encoding: "utf8", ...options });
  return { status: result.status, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

// 1. 构建
if (!args["no-build"]) {
  const done = log.phase("构建站点");
  run("npm", ["run", "build"], { cwd: ROOT });
  done();
}

if (!fs.existsSync(path.join(HOME_SITE_DIR, "index.html"))) {
  log.error("home/site/index.html 不存在，构建没有产出。");
  process.exit(1);
}

// 2. 确认 remote 存在
const remotes = runSoft("git", ["remote"], { cwd: ROOT }).stdout.split("\n").filter(Boolean);
if (!remotes.includes(remote)) {
  log.error(`仓库里没有名为 ${remote} 的 remote。当前: ${remotes.join(", ") || "（无）"}`);
  log.error(`先添加，例如： git remote add origin git@${alias}:H-Jett/TravelPlan.git`);
  process.exit(1);
}
const remoteUrl = runSoft("git", ["remote", "get-url", remote], { cwd: ROOT }).stdout;
log.info(`remote  ${remote} → ${remoteUrl}`);

const fileCount = runSoft("bash", ["-c", `find ${JSON.stringify(HOME_SITE_DIR)} -type f | wc -l`]).stdout;
const sizeKb = runSoft("bash", ["-c", `du -sk ${JSON.stringify(HOME_SITE_DIR)} | cut -f1`]).stdout;
log.info(`产物    ${fileCount} 个文件, ${(Number(sizeKb) / 1024).toFixed(2)} MB`);

if (dryRun) {
  log.info(`[dry-run] 将会把 home/site/${subdir ? ` 下推到 ${branch}:${subdir}/` : ` 推到 ${branch} 根`}`);
  log.summary({ branch, subdir: subdir || "(root)", dryRun: true });
  log.close();
  process.exit(0);
}

// 3. 用临时工作区做一次"孤儿提交"，避免污染主仓库历史
//    刻意放在 /tmp 之外？—— 这里是纯 git 元数据，体积 = 站点大小(~6MB)，放 os.tmpdir() 可接受。
const work = fs.mkdtempSync(path.join(os.tmpdir(), "travel-deploy-"));
log.info(`临时工作区 ${work}`);

try {
  run("git", ["init", "--quiet", "--initial-branch", branch], { cwd: work });

  const target = subdir ? path.join(work, subdir) : work;
  fs.mkdirSync(target, { recursive: true });
  run("cp", ["-R", `${HOME_SITE_DIR}/.`, target]);

  // Pages 需要 .nojekyll 才会原样发布下划线开头的文件（如 _headers）
  fs.writeFileSync(path.join(target, ".nojekyll"), "", "utf8");

  run("git", ["add", "-A"], { cwd: work });
  const message = args.message || `deploy: ${new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 16)} (北京时间)`;
  run("git", [
    "-c", "user.name=H-Jett",
    "-c", "user.email=jianghao091@outlook.com",
    "commit", "--quiet", "-m", message
  ], { cwd: work });

  log.info("推送中…（认证走 ssh 别名，不会把 token 写进任何配置）");
  const url = remoteUrl.startsWith("git@") || remoteUrl.startsWith("ssh://")
    ? remoteUrl.replace(/^git@([^:]+):/, `git@${alias}:`)
    : remoteUrl;

  const pushed = spawnSync("git", ["push", "--force", url, `HEAD:${branch}`], { cwd: work, encoding: "utf8", stdio: "pipe" });
  if (pushed.status !== 0) {
    throw new Error(`推送失败:\n${(pushed.stderr || pushed.stdout || "").trim()}`);
  }

  const head = runSoft("git", ["rev-parse", "--short", "HEAD"], { cwd: work }).stdout;
  log.info(`已推送 ${head} → ${branch}`);
  log.summary({ branch, subdir: subdir || "(root)", files: fileCount, commit: head });
  log.info("若 Pages 尚未生效，到仓库 Settings → Pages 确认 Source 指向该分支与目录。");
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  log.debug(`已清理 ${work}`);
}
log.close();
