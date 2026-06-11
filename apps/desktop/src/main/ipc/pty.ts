// 内嵌终端：node-pty 真 PTY 进程（参考 fanbox 实现）。
// renderer 侧 xterm.js 经 pty:* channel 双向桥接。node-pty 懒加载,
// 不可用时优雅降级（pty:spawn 返回 error 而非崩溃）。

import { ipcMain } from "electron";
import { homedir } from "os";
import { chmodSync, existsSync } from "fs";
import { dirname, join } from "path";
import { execFile } from "child_process";
import { buildEnv } from "./cli";

interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

type PtyModule = {
  spawn(shell: string, args: string[], opts: Record<string, unknown>): PtyProcess;
};

let ptyModule: PtyModule | null | undefined; // undefined=未尝试, null=加载失败

// pnpm 安装 node-pty 预编译产物时会丢失 spawn-helper 的执行权限,
// 导致 spawn 报 "posix_spawnp failed" —— 加载时自愈。
function fixSpawnHelperPerms(): void {
  try {
    const pkgRoot = dirname(require.resolve("node-pty/package.json"));
    const helper = join(pkgRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // 平台无 helper（win32）或权限不足,忽略
  }
}

function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule;
  try {
    fixSpawnHelperPerms();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ptyModule = require("node-pty") as PtyModule;
  } catch (err) {
    console.error("[pty] node-pty 加载失败:", err);
    ptyModule = null;
  }
  return ptyModule;
}

const terminals = new Map<string, PtyProcess>();

export function registerPtyHandlers(): void {
  ipcMain.handle("pty:spawn", (event, req: { id: string; cwd?: string; cols: number; rows: number }) => {
    const pty = loadPty();
    if (!pty) return { ok: false, error: "node-pty 不可用,请重新安装依赖" };

    // 已存在同 id 终端则复用（防 React 重复挂载导致多进程）。
    if (terminals.has(req.id)) return { ok: true, cwd: req.cwd };

    const sender = event.sender;
    const shell = process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");
    const cwd = req.cwd && existsSync(req.cwd) ? req.cwd : homedir();
    const env = { ...buildEnv(), TERM: "xterm-256color" } as Record<string, string>;
    // GUI 启动不继承 shell locale,中文路径会乱码,兜底 UTF-8。
    if (!/UTF-8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "")) env.LANG = "zh_CN.UTF-8";

    try {
      const proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: req.cols || 80,
        rows: req.rows || 24,
        cwd,
        env,
      });
      terminals.set(req.id, proc);
      proc.onData((data) => {
        if (!sender.isDestroyed()) sender.send("pty:data", { id: req.id, data });
      });
      proc.onExit(({ exitCode }) => {
        terminals.delete(req.id);
        if (!sender.isDestroyed()) sender.send("pty:exit", { id: req.id, exitCode });
      });
      return { ok: true, cwd };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.on("pty:input", (_e, { id, data }: { id: string; data: string }) => {
    terminals.get(id)?.write(data);
  });

  ipcMain.on("pty:resize", (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    terminals.get(id)?.resize(cols, rows);
  });

  ipcMain.on("pty:kill", (_e, { id }: { id: string }) => {
    terminals.get(id)?.kill();
    terminals.delete(id);
  });

  // 查询 shell 当前真实目录（跟随 cd,fanbox 同款 lsof 方案;仅 macOS/Linux）。
  ipcMain.handle("pty:cwd", async (_e, { id }: { id: string }) => {
    const proc = terminals.get(id);
    if (!proc || process.platform === "win32") return null;
    return new Promise<string | null>((resolve) => {
      execFile(
        "lsof",
        ["-a", "-p", String(proc.pid), "-d", "cwd", "-Fn"],
        { env: { ...process.env, LC_ALL: "en_US.UTF-8" }, timeout: 2000 },
        (err, stdout) => {
          if (err) return resolve(null);
          const line = stdout.split("\n").find((l) => l.startsWith("n"));
          if (!line) return resolve(null);
          // lsof 把非 ASCII 字符转义成 \xNN,还原成 UTF-8。
          const raw = line.slice(1);
          try {
            const bytes: number[] = [];
            for (let i = 0; i < raw.length; i++) {
              if (raw[i] === "\\" && raw[i + 1] === "x") {
                bytes.push(parseInt(raw.slice(i + 2, i + 4), 16));
                i += 3;
              } else {
                bytes.push(...Buffer.from(raw[i]!, "utf8"));
              }
            }
            resolve(Buffer.from(bytes).toString("utf8"));
          } catch {
            resolve(raw);
          }
        },
      );
    });
  });
}

export function killAllPty(): void {
  for (const proc of terminals.values()) {
    try {
      proc.kill();
    } catch {
      // 已退出
    }
  }
  terminals.clear();
}
