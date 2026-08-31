import { app } from "electron";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { createLogger } from "./log";

const log = createLogger("cortex-runtime");
const START_TIMEOUT_MS = 10_000;

export interface CortexRuntimeHandle { address: string; token: string; version: string }
interface ReadyFrame extends CortexRuntimeHandle { type: "ready" }

let child: ReturnType<typeof spawn> | null = null;
let handle: CortexRuntimeHandle | null = null;
let starting: Promise<CortexRuntimeHandle> | null = null;

export function cortexRuntimeBinaryPath(): string {
  const resourceOS = process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : process.platform;
  const platformArch = `${resourceOS}-${process.arch}`;
  const name = process.platform === "win32" ? "cortex-runtime.exe" : "cortex-runtime";
  return app.isPackaged
    ? join(process.resourcesPath, "cortex-runtime", name)
    : join(__dirname, "../../resources/cortex-runtime", platformArch, name);
}

export function startCortexRuntime(): Promise<CortexRuntimeHandle> {
  if (handle) return Promise.resolve(handle);
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const binary = cortexRuntimeBinaryPath();
    if (!existsSync(binary)) { reject(new Error(`Cortex Runtime 不存在: ${binary}`)); return; }
    const proc = spawn(binary, [], { cwd: dirname(binary), stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    let buffer = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("Cortex Runtime 启动超时")); }, START_TIMEOUT_MS);
    const fail = (error: Error) => { clearTimeout(timer); child = null; handle = null; starting = null; reject(error); };
    proc.once("error", fail);
    proc.once("exit", (code) => {
      child = null; handle = null; starting = null;
      if (code !== 0) log.warn("Cortex Runtime 已退出", { code });
    });
    proc.stderr.on("data", (chunk: Buffer) => log.debug(chunk.toString("utf8").trim()));
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const frame = JSON.parse(buffer.slice(0, newline)) as ReadyFrame;
        if (frame.type !== "ready" || !frame.address || !frame.token) throw new Error("ready frame 无效");
        clearTimeout(timer); handle = { address: frame.address, token: frame.token, version: frame.version }; starting = null;
        resolve(handle); log.info("Cortex Runtime 已就绪", { address: frame.address, version: frame.version });
      } catch (error) { proc.kill(); fail(error instanceof Error ? error : new Error(String(error))); }
    });
  });
  return starting;
}

export function getCortexRuntimeHandle(): CortexRuntimeHandle | null { return handle; }

export function stopCortexRuntime(): void {
  const proc = child; const current = handle;
  child = null; handle = null; starting = null;
  if (!proc) return;
  if (current) {
    void fetch(`${current.address}/v1/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${current.token}` } }).catch(() => proc.kill());
    setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 3_500).unref();
  } else proc.kill();
}
