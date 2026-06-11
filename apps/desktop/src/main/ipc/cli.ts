// CLI 流式管线：spawn agent CLI → stdout 按行缓冲 → adapter 解析为归一化事件
// → webContents.send 推给 renderer。每个 runId 一个子进程，支持 kill；
// 应用退出前统一清理。

import { ipcMain, type WebContents } from "electron";
import { spawn, type ChildProcess } from "child_process";
import { delimiter } from "path";
import { homedir } from "os";
import { existsSync, readdirSync } from "fs";
import type { CliExitEvent, CliStartRequest, CliStreamEvent } from "./types";
import { getAdapter } from "../agents";

const running = new Map<string, ChildProcess>();

function nvmBinDirs(home: string): string[] {
  const root = `${home}/.nvm/versions/node`;
  try {
    return readdirSync(root)
      .map((name) => `${root}/${name}/bin`)
      .filter((dir) => existsSync(dir));
  } catch {
    return [];
  }
}

// GUI 进程的 PATH 通常缺少用户 shell 的安装目录（macOS 尤甚），补齐常见位置。
// pty.ts（内嵌终端）也复用此 env。
export function buildEnv(): NodeJS.ProcessEnv {
  const home = homedir();
  const extras = [
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    ...nvmBinDirs(home),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.bun/bin`,
    `${home}/.cargo/bin`,
  ].filter((dir) => existsSync(dir));
  const current = process.env.PATH ?? "";
  const merged = [...new Set([...current.split(delimiter).filter(Boolean), ...extras])].join(delimiter);
  return { ...process.env, PATH: merged };
}

export function registerCliHandlers(): void {
  ipcMain.handle("cli:start", (event, req: CliStartRequest) => {
    const sender = event.sender;
    const adapter = getAdapter(req.agent);
    const { cmd, args } = adapter.buildArgs(req); // 未接入的 agent 在此抛错 → renderer 收到 rejection

    const child = spawn(cmd, args, { cwd: req.cwd, env: buildEnv(), stdio: ["ignore", "pipe", "pipe"] });
    running.set(req.runId, child);

    // 事件回显 sessionId:renderer 被 HMR/刷新重载丢失内存注册表后,
    // 仍能把事件归属到正确的 session 继续渲染/清理。
    const sendEvent = (ev: CliStreamEvent) => {
      if (!sender.isDestroyed()) sender.send("cli:event", { runId: req.runId, sessionId: req.sessionId, event: ev });
    };
    const sendExit = (exit: CliExitEvent) => {
      if (!sender.isDestroyed()) sender.send("cli:exit", exit);
    };

    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const ev = adapter.parseLine(line);
        if (ev) sendEvent(ev);
      }
    });

    let stderrTail = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    child.on("error", (err) => {
      running.delete(req.runId);
      sendExit({ runId: req.runId, code: null, error: err.message });
    });

    child.on("close", (code) => {
      // 冲刷残留的最后一行（无换行结尾时）。
      const line = buffer.trim();
      if (line) {
        const ev = adapter.parseLine(line);
        if (ev) sendEvent(ev);
      }
      running.delete(req.runId);
      sendExit({
        runId: req.runId,
        sessionId: req.sessionId,
        code,
        error: code !== 0 && code !== null ? stderrTail.trim() || undefined : undefined,
      });
    });
  });

  // 一次性短任务（生成 session 标题 / 日报等）:复用各 agent 的 adapter
  // （buildArgs 构造命令 + parseLine 解析流式输出）,聚合 text 增量为纯文本返回。
  // 新接入的 agent 自动获得 oneshot 能力。60 秒超时。
  // 不传 cwd 时在用户主目录运行 —— 不加载项目上下文,更快更省。
  ipcMain.handle(
    "cli:oneshot",
    (_e, req: { agent?: "claude" | "codex"; cwd?: string; prompt: string; model?: string }) => {
      const agent = req.agent ?? "claude";
      const adapter = getAdapter(agent);
      const { cmd, args } = adapter.buildArgs({
        runId: "oneshot",
        sessionId: "oneshot",
        agent,
        cwd: req.cwd ?? homedir(),
        prompt: req.prompt,
        model: req.model,
      });
      return new Promise<string>((resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: req.cwd ?? homedir(),
          env: buildEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let resultText = "";
        let failed: string | null = null;
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("oneshot 超时"));
        }, 60_000);

        const handleLine = (line: string) => {
          if (!line) return;
          const ev = adapter.parseLine(line);
          if (!ev) return;
          if (ev.type === "text" && out.length < 20_000) out += ev.delta;
          if (ev.type === "result") {
            if (!ev.ok) failed = ev.error ?? "执行失败";
            else if (ev.text) resultText = ev.text;
          }
        };

        let buffer = "";
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          buffer += chunk;
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            handleLine(buffer.slice(0, nl).trim());
            buffer = buffer.slice(nl + 1);
          }
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          handleLine(buffer.trim()); // 冲刷无换行结尾的最后一行
          const text = (out || resultText).trim();
          if (failed) reject(new Error(failed));
          else if (code === 0 && text) resolve(text);
          else if (code === 0) reject(new Error("oneshot 无输出"));
          else reject(new Error(`oneshot 退出码 ${code}`));
        });
      });
    },
  );

  ipcMain.handle("cli:kill", (_e, runId: string) => {
    const child = running.get(runId);
    if (!child) return;
    child.kill("SIGTERM");
    // 3 秒未退出则强杀（claude 偶尔会拖延收尾）。
    setTimeout(() => {
      if (running.has(runId)) child.kill("SIGKILL");
    }, 3000);
  });
}

export function killAllCli(): void {
  for (const child of running.values()) child.kill("SIGTERM");
  running.clear();
}

// 供测试或诊断使用。
export function hasRunning(_sender?: WebContents): boolean {
  return running.size > 0;
}
