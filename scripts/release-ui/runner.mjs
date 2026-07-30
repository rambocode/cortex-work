// 发布控制台的执行内核：进程派生、日志环形缓冲、阶段状态机与订阅广播。
//
// 与 scripts/local-release-mac.sh 的关系：那个脚本是一条 `set -e` 的直线，任何一步失败都只能
// 从头再来——v0.1.49 发版时就因为 Apple 公证排队，白白重跑了两轮 arm64 构建（每轮约 10 分钟）。
// 这里把同一套流程拆成带 id 的独立阶段，状态与产物暂存目录都落盘持久化，于是「从失败的那一步
// 继续」成为可能。阶段的具体定义在 steps.mjs，本文件只负责通用的跑与记。

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

// 日志保留上限。发布日志以 electron-builder 的 vite 产物清单为大头，单轮约数千行；
// 留 5000 行足够回溯失败现场，又不至于让浏览器端一次性渲染卡死。
const LOG_LIMIT = 5000;

export const STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  SKIPPED: "skipped",
};

/**
 * 一次发布运行的状态机。持有阶段列表、日志缓冲与订阅者，所有变更都经 emit("update") 广播给 SSE。
 */
export class ReleaseRun extends EventEmitter {
  constructor({ repoRoot, stateFile }) {
    super();
    this.repoRoot = repoRoot;
    this.stateFile = stateFile;
    this.steps = [];
    this.logs = [];
    this.seq = 0;
    this.child = null;
    this.activeStepId = null;
    this.aborted = false;
    this.tag = null;
    this.version = null;
    this.stageDir = null;
    this.startedAt = null;
    this.finishedAt = null;
  }

  /** 用阶段定义初始化（或重置）本次运行；已完成阶段的状态可由 restore 覆盖回来。 */
  init(stepDefs, { tag, version, stageDir }) {
    this.steps = stepDefs.map((d) => ({
      id: d.id,
      title: d.title,
      group: d.group,
      status: STATUS.PENDING,
      startedAt: null,
      finishedAt: null,
      error: null,
    }));
    this.tag = tag;
    this.version = version;
    this.stageDir = stageDir;
    this.emitUpdate();
  }

  /** 从落盘状态恢复阶段完成情况——这是「从失败处续跑」能跨进程重启生效的关键。 */
  restore() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (saved.tag !== this.tag) return; // 换版本了，旧进度一律作废
      for (const s of this.steps) {
        const prev = saved.steps?.[s.id];
        // 只恢复 done：failed/running 在新一轮里都该重跑，避免把上次的失败当成既成事实。
        if (prev?.status === STATUS.DONE) {
          s.status = STATUS.DONE;
          s.startedAt = prev.startedAt ?? null;
          s.finishedAt = prev.finishedAt ?? null;
        }
      }
      this.emitUpdate();
    } catch {
      /* 状态文件损坏时静默忽略，等价于全新一轮 */
    }
  }

  persist() {
    if (!this.stateFile) return;
    const payload = {
      tag: this.tag,
      version: this.version,
      stageDir: this.stageDir,
      steps: Object.fromEntries(
        this.steps.map((s) => [s.id, { status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt }]),
      ),
    };
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(payload, null, 2));
  }

  get running() {
    return this.steps.some((s) => s.status === STATUS.RUNNING);
  }

  step(id) {
    return this.steps.find((s) => s.id === id);
  }

  log(line, level = "info") {
    const entry = { seq: ++this.seq, ts: Date.now(), level, step: this.activeStepId, text: line };
    this.logs.push(entry);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    this.emit("log", entry);
  }

  emitUpdate() {
    this.emit("update", this.snapshot());
  }

  snapshot() {
    return {
      tag: this.tag,
      version: this.version,
      stageDir: this.stageDir,
      running: this.running,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      steps: this.steps,
    };
  }

  markStep(id, status, error = null) {
    const s = this.step(id);
    if (!s) return;
    s.status = status;
    if (status === STATUS.RUNNING) {
      s.startedAt = Date.now();
      s.finishedAt = null;
      s.error = null;
      this.activeStepId = id;
    } else {
      s.finishedAt = Date.now();
      s.error = error;
      if (this.activeStepId === id) this.activeStepId = null;
    }
    this.persist();
    this.emitUpdate();
  }

  /**
   * 派生一条命令并把 stdout/stderr 按行推进日志。
   * 刻意不用 shell:参数已结构化传入，省掉引号转义这一整类坑；需要 glob 的地方在 JS 里用 readdir 解决。
   */
  exec(cmd, args, { cwd = this.repoRoot, env = process.env } = {}) {
    return new Promise((resolve, reject) => {
      if (this.aborted) return reject(new Error("已被用户停止"));
      this.log(`$ ${cmd} ${args.join(" ")}`, "cmd");
      const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;

      // 按行切分:构建工具的进度条会用 \r 覆写同一行,统一转成换行免得日志里粘成一坨。
      const pump = (stream, level) => {
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          buf += chunk.replace(/\r/g, "\n");
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) if (l.trim()) this.log(l, level);
        });
        stream.on("end", () => {
          if (buf.trim()) this.log(buf, level);
        });
      };
      pump(child.stdout, "out");
      pump(child.stderr, "err");

      child.on("error", (err) => {
        this.child = null;
        reject(err);
      });
      child.on("close", (code, signal) => {
        this.child = null;
        if (signal) return reject(new Error(`被信号 ${signal} 终止`));
        if (code !== 0) return reject(new Error(`退出码 ${code}：${cmd} ${args.join(" ")}`));
        resolve();
      });
    });
  }

  /** 同 exec，但捕获 stdout 返回字符串（用于 gh api 之类要取值的调用），失败不抛。 */
  capture(cmd, args, { cwd = this.repoRoot, env = process.env } = {}) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", () => resolve({ ok: false, stdout: "", stderr: "spawn failed", code: -1 }));
      child.on("close", (code) => resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim(), code }));
    });
  }

  /** 停止：先 SIGTERM 给收尾机会，3 秒后仍在就 SIGKILL（electron-builder 偶尔吃掉 TERM）。 */
  stop() {
    this.aborted = true;
    const child = this.child;
    if (!child) return false;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (this.child === child) child.kill("SIGKILL");
    }, 3000);
    return true;
  }
}
