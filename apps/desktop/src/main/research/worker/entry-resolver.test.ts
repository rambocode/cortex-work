// entry-resolver 单测：纯函数，isPackaged / 路径 / exists 全部注入。
import { describe, expect, it } from "vitest";
import { resolveResearchWorkerEntry } from "./entry-resolver";

describe("resolveResearchWorkerEntry", () => {
  it("开发态取 <appPath>/out/worker/research-worker.js", () => {
    const entry = resolveResearchWorkerEntry({
      isPackaged: false,
      appPath: "/repo/apps/desktop",
      resourcesPath: "/repo/apps/desktop/resources",
      exists: (p) => p === "/repo/apps/desktop/out/worker/research-worker.js",
    });
    expect(entry).toBe("/repo/apps/desktop/out/worker/research-worker.js");
  });

  it("打包态优先取 asar 外的 app.asar.unpacked 副本", () => {
    const unpacked = "/App/Contents/Resources/app.asar.unpacked/out/worker/research-worker.js";
    const entry = resolveResearchWorkerEntry({
      isPackaged: true,
      appPath: "/App/Contents/Resources/app.asar",
      resourcesPath: "/App/Contents/Resources",
      exists: (p) => p === unpacked,
    });
    expect(entry).toBe(unpacked);
  });

  it("打包态 asarUnpack 未生效时回退到 asar 内路径", () => {
    const inside = "/App/Contents/Resources/app.asar/out/worker/research-worker.js";
    const entry = resolveResearchWorkerEntry({
      isPackaged: true,
      appPath: "/App/Contents/Resources/app.asar",
      resourcesPath: "/App/Contents/Resources",
      exists: (p) => p === inside,
    });
    expect(entry).toBe(inside);
  });

  it("产物名回退到 index.js（vite 的 build.ssr 会覆盖 lib.fileName，实测产出即 index.js）", () => {
    const entry = resolveResearchWorkerEntry({
      isPackaged: false,
      appPath: "/repo/apps/desktop",
      resourcesPath: "/repo/apps/desktop/resources",
      exists: (p) => p === "/repo/apps/desktop/out/worker/index.js",
    });
    expect(entry).toBe("/repo/apps/desktop/out/worker/index.js");
  });

  it("两种产物名同时存在时优先取 research-worker.js（配置声明的规范名）", () => {
    const entry = resolveResearchWorkerEntry({
      isPackaged: false,
      appPath: "/repo/apps/desktop",
      resourcesPath: "/repo/apps/desktop/resources",
      exists: () => true,
    });
    expect(entry).toBe("/repo/apps/desktop/out/worker/research-worker.js");
  });

  it("两处都不存在时返回 null（调用方据此判定 Worker 不可用）", () => {
    expect(
      resolveResearchWorkerEntry({
        isPackaged: true,
        appPath: "/App/Contents/Resources/app.asar",
        resourcesPath: "/App/Contents/Resources",
        exists: () => false,
      }),
    ).toBeNull();
    expect(
      resolveResearchWorkerEntry({
        isPackaged: false,
        appPath: "/repo/apps/desktop",
        resourcesPath: "/repo/apps/desktop/resources",
        exists: () => false,
      }),
    ).toBeNull();
  });
});
