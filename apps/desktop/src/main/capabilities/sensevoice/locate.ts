// SenseVoice 常驻 sidecar 定位。原生可执行文件必须位于 asar 外的真实路径。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";

export interface SenseVoiceSidecarLocation {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

function executableName(): string {
  return process.platform === "win32" ? "cortex-sensevoice-sidecar.exe" : "cortex-sensevoice-sidecar";
}

/**
 * 查找顺序：开发者覆盖 → 打包 resources → dev resources → cwd resources。
 * 路径中的平台和架构来自当前进程，避免把 arm64 runner 错装进 x64 包。
 */
export function resolveSenseVoiceSidecar(): SenseVoiceSidecarLocation {
  const candidates: string[] = [];
  const override = process.env.CORTEX_SENSEVOICE_SIDECAR;
  if (override) {
    candidates.push(override);
    if (existsSync(override)) return { command: override, cwd: dirname(override), env: {} };
  }

  const platformArch = `${process.platform}-${process.arch}`;
  const relative = join("sensevoice", platformArch, executableName());
  // 普通 Node 单测没有 Electron 注入的 resourcesPath；仅打包态才把它视为候选根。
  const resourcesRoot = typeof process.resourcesPath === "string" ? process.resourcesPath : "";
  const packed = join(resourcesRoot, relative);
  const dev = join(app.getAppPath(), "resources", relative);
  const cwd = join(process.cwd(), "resources", relative);
  candidates.push(packed, dev, cwd);

  if (app.isPackaged && existsSync(packed)) return { command: packed, cwd: dirname(packed), env: {} };
  if (!app.isPackaged && existsSync(dev)) return { command: dev, cwd: dirname(dev), env: {} };
  if (existsSync(cwd)) return { command: cwd, cwd: dirname(cwd), env: {} };
  throw new Error(
    `找不到 SenseVoice sidecar（${platformArch}）。已检查：\n${candidates.map((path) => `  ${path}`).join("\n")}`,
  );
}
