// entry 解析单测：纯函数，isPackaged / 路径 / exists 全部注入，无需 electron 替身。
import { describe, expect, it } from "vitest";

import { piHostEntryCandidates, resolvePiHostEntry } from "./entry";

describe("resolvePiHostEntry", () => {
  it("开发态取 <appPath>/out/worker/pi-host.js", () => {
    const entry = resolvePiHostEntry({
      isPackaged: false,
      appPath: "/repo/apps/desktop",
      resourcesPath: "/repo/apps/desktop/resources",
      exists: (p) => p === "/repo/apps/desktop/out/worker/pi-host.js",
    });
    expect(entry).toBe("/repo/apps/desktop/out/worker/pi-host.js");
  });

  it("打包态优先取 asar 外的 app.asar.unpacked 副本（KTD3：asar 内路径会静默失败）", () => {
    const unpacked = "/App/Contents/Resources/app.asar.unpacked/out/worker/pi-host.js";
    const inside = "/App/Contents/Resources/app.asar/out/worker/pi-host.js";
    const entry = resolvePiHostEntry({
      isPackaged: true,
      appPath: "/App/Contents/Resources/app.asar",
      resourcesPath: "/App/Contents/Resources",
      // 两个都存在时必须选 unpacked
      exists: (p) => p === unpacked || p === inside,
    });
    expect(entry).toBe(unpacked);
  });

  it("打包态 asarUnpack 未生效时回退到 asar 内路径（响亮失败好过功能消失）", () => {
    const inside = "/App/Contents/Resources/app.asar/out/worker/pi-host.js";
    const entry = resolvePiHostEntry({
      isPackaged: true,
      appPath: "/App/Contents/Resources/app.asar",
      resourcesPath: "/App/Contents/Resources",
      exists: (p) => p === inside,
    });
    expect(entry).toBe(inside);
  });

  it("接受 pi-host/index.js 目录形态产物", () => {
    const entry = resolvePiHostEntry({
      isPackaged: false,
      appPath: "/repo/apps/desktop",
      resourcesPath: "/repo/apps/desktop/resources",
      exists: (p) => p === "/repo/apps/desktop/out/worker/pi-host/index.js",
    });
    expect(entry).toBe("/repo/apps/desktop/out/worker/pi-host/index.js");
  });

  it("**绝不**把 out/worker/index.js 当成 pi-host —— 那是 research worker 的实测产物名", () => {
    const entry = resolvePiHostEntry({
      isPackaged: false,
      appPath: "/repo/apps/desktop",
      resourcesPath: "/repo/apps/desktop/resources",
      exists: (p) => p === "/repo/apps/desktop/out/worker/index.js",
    });
    expect(entry).toBeNull();
  });

  it("都找不到时返回 null", () => {
    const entry = resolvePiHostEntry({
      isPackaged: true,
      appPath: "/App/Contents/Resources/app.asar",
      resourcesPath: "/App/Contents/Resources",
      exists: () => false,
    });
    expect(entry).toBeNull();
  });
});

describe("piHostEntryCandidates", () => {
  it("打包态枚举 unpacked 与 asar 内两组候选，供入口缺失时的诊断日志", () => {
    const candidates = piHostEntryCandidates({
      isPackaged: true,
      appPath: "/App/Contents/Resources/app.asar",
      resourcesPath: "/App/Contents/Resources",
    });
    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toContain("app.asar.unpacked");
    expect(candidates.every((c) => !c.endsWith("/out/worker/index.js"))).toBe(true);
  });
});
