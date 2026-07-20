import { chmodSync, existsSync } from "node:fs";
import path from "node:path";

export interface AgentBrowserBinaryLocationInput {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: string;
  arch: string;
  exists?: (candidate: string) => boolean;
  makeExecutable?: (candidate: string) => void;
}

export function agentBrowserPackageBinaryName(platform: string, arch: string): string {
  return `agent-browser-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

export function resolveAgentBrowserBinary(input: AgentBrowserBinaryLocationInput): string | null {
  const candidate = input.isPackaged
    ? path.join(input.resourcesPath, "agent-browser", input.platform === "win32" ? "agent-browser.exe" : "agent-browser")
    : path.join(
        input.appPath,
        "node_modules",
        "agent-browser",
        "bin",
        agentBrowserPackageBinaryName(input.platform, input.arch),
      );
  if (!(input.exists ?? existsSync)(candidate)) return null;
  if (!input.isPackaged && input.platform !== "win32") {
    try {
      (input.makeExecutable ?? ((p) => chmodSync(p, 0o755)))(candidate);
    } catch {
      return null;
    }
  }
  return candidate;
}
