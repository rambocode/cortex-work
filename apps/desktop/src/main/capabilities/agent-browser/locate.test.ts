import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { agentBrowserPackageBinaryName, resolveAgentBrowserBinary } from "./locate";

describe("agent-browser binary locator", () => {
  it.each([
    ["darwin", "arm64", "agent-browser-darwin-arm64"],
    ["darwin", "x64", "agent-browser-darwin-x64"],
    ["win32", "x64", "agent-browser-win32-x64.exe"],
  ])("maps %s/%s to the npm package binary", (platform, arch, expected) => {
    expect(agentBrowserPackageBinaryName(platform, arch)).toBe(expected);
  });

  it("resolves the packaged binary from Electron resources", () => {
    const exists = vi.fn(() => true);
    const result = resolveAgentBrowserBinary({
      isPackaged: true,
      resourcesPath: "/Applications/Cortex.app/Contents/Resources",
      appPath: "/unused",
      platform: "darwin",
      arch: "arm64",
      exists,
    });

    expect(result).toBe(path.join("/Applications/Cortex.app/Contents/Resources", "agent-browser", "agent-browser"));
    expect(exists).toHaveBeenCalledWith(result);
  });

  it("resolves the development binary from node_modules", () => {
    const exists = vi.fn(() => true);
    const makeExecutable = vi.fn();
    const result = resolveAgentBrowserBinary({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: "/repo/apps/desktop",
      platform: "win32",
      arch: "x64",
      exists,
      makeExecutable,
    });

    expect(result).toBe(path.join("/repo/apps/desktop", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe"));
    expect(makeExecutable).not.toHaveBeenCalled();
  });

  it("makes the development Unix binary executable", () => {
    const makeExecutable = vi.fn();
    const result = resolveAgentBrowserBinary({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: "/repo/apps/desktop",
      platform: "darwin",
      arch: "arm64",
      exists: () => true,
      makeExecutable,
    });
    expect(makeExecutable).toHaveBeenCalledWith(result);
  });

  it("returns null when the target binary is unavailable", () => {
    expect(
      resolveAgentBrowserBinary({
        isPackaged: true,
        resourcesPath: "/resources",
        appPath: "/app",
        platform: "linux",
        arch: "s390x",
        exists: () => false,
      }),
    ).toBeNull();
  });
});
