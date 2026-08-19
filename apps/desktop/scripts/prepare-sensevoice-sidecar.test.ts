import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareSenseVoiceSidecar } from "./prepare-sensevoice-sidecar.mjs";

const scriptsRoot = import.meta.dirname;
const desktopRoot = join(scriptsRoot, "..");
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sensevoice-cache-test-"));
  temporaryRoots.push(root);
  return root;
}

function fakeDesktop(parent: string, name: string, source = "same-source"): string {
  const root = join(parent, name);
  const sourceRoot = join(root, "native", "sensevoice-sidecar");
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "CMakeLists.txt"), `cmake:${source}\n`);
  writeFileSync(join(sourceRoot, "sensevoice-sidecar.cpp"), `cpp:${source}\n`);
  return root;
}

function fakeCmake() {
  const calls: Array<{ command: string; args: string[] }> = [];
  let builds = 0;
  const execFile = ((command: string, args: string[]) => {
    calls.push({ command, args: [...args] });
    if (command !== "cmake") throw new Error(`unexpected command: ${command}`);
    if (args[0] === "--build") {
      builds += 1;
      const binaryRoot = join(args[1]!, "bin");
      mkdirSync(binaryRoot, { recursive: true });
      writeFileSync(join(binaryRoot, "cortex-sensevoice-sidecar"), `fake-binary-${builds}`);
    }
    return Buffer.alloc(0);
  }) as typeof import("node:child_process").execFileSync;
  return { calls, execFile };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SenseVoice sidecar 构建护栏", () => {
  it("固定上游提交、支持矩阵并禁用 Metal", () => {
    const script = readFileSync(join(scriptsRoot, "prepare-sensevoice-sidecar.mjs"), "utf8");
    const cmake = readFileSync(join(desktopRoot, "native", "sensevoice-sidecar", "CMakeLists.txt"), "utf8");
    expect(script).toContain("runtime-llamacpp-v0.1.9");
    expect(script).toContain("9b918d74d7090b38211a6414c6ee08893a34afd4");
    expect(script).toContain('["darwin-arm64", "darwin-x64", "win32-x64"]');
    expect(cmake).toContain("8086439a4cea94c71a5dfb8fe4ad1546aebd640f");
    expect(cmake).toContain("set(GGML_METAL OFF");
    expect(cmake).toContain("set(GGML_NATIVE OFF");
  });

  it("两个不同 worktree 的相同源码只编译一次，第二个从共享产物缓存物化", () => {
    const root = temporaryRoot();
    const firstDesktop = fakeDesktop(root, "worktree-a");
    const secondDesktop = fakeDesktop(root, "worktree-b");
    const sharedCacheRoot = join(root, "shared-cache");
    const buildCacheRoot = join(root, "cmake-cache");
    const cmake = fakeCmake();
    const common = {
      args: [],
      hostPlatform: "darwin" as const,
      hostArch: "arm64",
      sharedCacheRoot,
      buildCacheRoot,
      toolchainSha256: "toolchain-v1",
      execFile: cmake.execFile,
      log: () => undefined,
    };

    const first = prepareSenseVoiceSidecar({ ...common, desktopRoot: firstDesktop });
    const second = prepareSenseVoiceSidecar({ ...common, desktopRoot: secondDesktop });
    const repeated = prepareSenseVoiceSidecar({ ...common, desktopRoot: secondDesktop });

    expect(first.status).toBe("built");
    expect(second.status).toBe("shared-cache");
    expect(repeated.status).toBe("local");
    expect(first.artifactKey).toBe(second.artifactKey);
    expect(cmake.calls.filter((call) => call.command === "cmake")).toHaveLength(2);
    expect(
      readFileSync(
        join(secondDesktop, "resources", "sensevoice", "darwin-arm64", "cortex-sensevoice-sidecar"),
        "utf8",
      ),
    ).toBe("fake-binary-1");
  });

  it("源码或工具链变化会切换 artifactKey 并重新构建", () => {
    const root = temporaryRoot();
    const firstDesktop = fakeDesktop(root, "worktree-a", "source-v1");
    const secondDesktop = fakeDesktop(root, "worktree-b", "source-v2");
    const cmake = fakeCmake();
    const common = {
      args: [],
      hostPlatform: "darwin" as const,
      hostArch: "arm64",
      sharedCacheRoot: join(root, "shared-cache"),
      buildCacheRoot: join(root, "cmake-cache"),
      execFile: cmake.execFile,
      log: () => undefined,
    };

    const first = prepareSenseVoiceSidecar({ ...common, desktopRoot: firstDesktop, toolchainSha256: "toolchain-v1" });
    const sourceChanged = prepareSenseVoiceSidecar({
      ...common,
      desktopRoot: secondDesktop,
      toolchainSha256: "toolchain-v1",
    });
    const toolchainChanged = prepareSenseVoiceSidecar({
      ...common,
      desktopRoot: firstDesktop,
      toolchainSha256: "toolchain-v2",
    });

    expect(new Set([first.artifactKey, sourceChanged.artifactKey, toolchainChanged.artifactKey]).size).toBe(3);
    expect(cmake.calls.filter((call) => call.command === "cmake")).toHaveLength(6);
  });

  it("--force 绕过本地与共享命中并刷新同一指纹产物", () => {
    const root = temporaryRoot();
    const desktop = fakeDesktop(root, "worktree");
    const cmake = fakeCmake();
    const common = {
      hostPlatform: "darwin" as const,
      hostArch: "arm64",
      desktopRoot: desktop,
      sharedCacheRoot: join(root, "shared-cache"),
      buildCacheRoot: join(root, "cmake-cache"),
      toolchainSha256: "toolchain-v1",
      execFile: cmake.execFile,
      log: () => undefined,
    };

    const first = prepareSenseVoiceSidecar({ ...common, args: [] });
    const forced = prepareSenseVoiceSidecar({ ...common, args: ["--force"] });

    expect(first.status).toBe("built");
    expect(forced.status).toBe("built");
    expect(forced.artifactKey).toBe(first.artifactKey);
    expect(cmake.calls.filter((call) => call.command === "cmake")).toHaveLength(4);
    expect(
      readFileSync(join(desktop, "resources", "sensevoice", "darwin-arm64", "cortex-sensevoice-sidecar"), "utf8"),
    ).toBe("fake-binary-2");
  });

  it("升级前的 worktree 本地产物可直接晋升共享缓存，不再编译", () => {
    const root = temporaryRoot();
    const seedDesktop = fakeDesktop(root, "seed");
    const targetDesktop = fakeDesktop(root, "target");
    const sharedCacheRoot = join(root, "shared-cache");
    const cmake = fakeCmake();
    const common = {
      args: [],
      hostPlatform: "darwin" as const,
      hostArch: "arm64",
      sharedCacheRoot,
      buildCacheRoot: join(root, "cmake-cache"),
      toolchainSha256: "toolchain-v1",
      execFile: cmake.execFile,
      log: () => undefined,
    };
    const built = prepareSenseVoiceSidecar({ ...common, desktopRoot: seedDesktop });
    const seedOutputRoot = join(seedDesktop, "resources", "sensevoice", "darwin-arm64");
    const targetOutputRoot = join(targetDesktop, "resources", "sensevoice", "darwin-arm64");
    mkdirSync(targetOutputRoot, { recursive: true });
    copyFileSync(
      join(seedOutputRoot, "cortex-sensevoice-sidecar"),
      join(targetOutputRoot, "cortex-sensevoice-sidecar"),
    );
    const legacyMarker = JSON.parse(readFileSync(join(seedOutputRoot, "runner.json"), "utf8")) as Record<
      string,
      unknown
    >;
    delete legacyMarker.cacheSchema;
    delete legacyMarker.artifactKey;
    delete legacyMarker.toolchainSha256;
    delete legacyMarker.binarySha256;
    writeFileSync(join(targetOutputRoot, "runner.json"), `${JSON.stringify(legacyMarker)}\n`);
    rmSync(sharedCacheRoot, { recursive: true, force: true });
    cmake.calls.length = 0;

    const promoted = prepareSenseVoiceSidecar({ ...common, desktopRoot: targetDesktop });

    expect(promoted.status).toBe("local");
    expect(promoted.artifactKey).toBe(built.artifactKey);
    expect(cmake.calls).toHaveLength(0);
    expect(readFileSync(join(sharedCacheRoot, "darwin-arm64", built.artifactKey, "runner.json"), "utf8")).toContain(
      '"binarySha256"',
    );
  });
});
