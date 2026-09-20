import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "./paths.mjs";

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function stamp() {
  // 日志时间统一用北京时间，便于和对话里的时间戳对照。
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  return now.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * 建一个同时写控制台和 logs/<name>.log 的 logger。
 * 长时间任务请用 progress() 打进度，不要静默跑。
 */
export function createLogger(name) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logFile = path.join(LOGS_DIR, `${name}.log`);
  const stream = fs.createWriteStream(logFile, { flags: "a" });
  const floor = LEVELS[String(process.env.LOG_LEVEL || "INFO").toUpperCase()] ?? LEVELS.INFO;
  const startedAt = Date.now();

  function emit(level, message) {
    if (LEVELS[level] < floor) return;
    const line = `[${stamp()}] ${level.padEnd(5)} ${message}`;
    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);
    stream.write(`${line}\n`);
  }

  return {
    file: logFile,
    debug: (m) => emit("DEBUG", m),
    info: (m) => emit("INFO", m),
    warn: (m) => emit("WARN", m),
    error: (m) => emit("ERROR", m),

    /** 阶段开始/结束打点，返回一个收尾函数。 */
    phase(label) {
      emit("INFO", `▶ ${label} 开始`);
      const at = Date.now();
      return (extra = "") => {
        const ms = Date.now() - at;
        emit("INFO", `✔ ${label} 完成 (${ms}ms)${extra ? ` ${extra}` : ""}`);
        return ms;
      };
    },

    /**
     * 通用进度输出：每 total/step 条或每 minIntervalMs 打一次，避免刷屏也避免长时间无输出。
     * 用法：const tick = log.progress("下载", total); tick(); tick(); ... tick(true)
     */
    progress(label, total, { every = Math.max(1, Math.ceil(total / 20)), minIntervalMs = 3000 } = {}) {
      let done = 0;
      let lastAt = 0;
      const start = Date.now();
      return (force = false) => {
        done += 1;
        const now = Date.now();
        const due = force || done >= total || (done % every === 0 && now - lastAt >= minIntervalMs);
        if (!due) return;
        lastAt = now;
        const ratio = total ? done / total : 1;
        const elapsed = (now - start) / 1000;
        const eta = ratio > 0 && ratio < 1 ? Math.max(0, elapsed / ratio - elapsed) : 0;
        emit("INFO", `   ${label} ${done}/${total} (${(ratio * 100).toFixed(1)}%) 用时${elapsed.toFixed(1)}s ETA ${eta.toFixed(1)}s`);
      };
    },

    /** 整体汇总，任务结束前调一次。 */
    summary(fields) {
      const ms = Date.now() - startedAt;
      emit("INFO", `汇总: ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")} 总用时${(ms / 1000).toFixed(2)}s`);
      emit("INFO", `日志: ${logFile}`);
    },

    close() {
      stream.end();
    }
  };
}
