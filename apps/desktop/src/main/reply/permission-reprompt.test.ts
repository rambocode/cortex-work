import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  TCC_SERVICE_BY_KIND,
  readBundleId,
  repromptPermission,
  resolveAppBundlePath,
} from "./permission-reprompt";

describe("resolveAppBundlePath", () => {
  it("由主进程 exe 路径回推 .app bundle 根（向上三级）", () => {
    expect(resolveAppBundlePath("/Applications/Cortex.app/Contents/MacOS/Cortex")).toBe(
      "/Applications/Cortex.app",
    );
  });

  // dev 下 exe 埋在 node_modules/.pnpm 里,这正是用户不该被要求手抄的那条路径。
  it("dev 的 Electron.app 同样回推正确", () => {
    const exe = "/repo/node_modules/.pnpm/electron@39.8.10/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
    expect(resolveAppBundlePath(exe)).toBe(
      "/repo/node_modules/.pnpm/electron@39.8.10/node_modules/electron/dist/Electron.app",
    );
  });
});

describe("readBundleId", () => {
  function makeBundle(plist: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "cu-bundle-"));
    const app = join(root, "Foo.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    if (plist !== null) writeFileSync(join(app, "Contents", "Info.plist"), plist);
    return app;
  }

  it("从 XML plist 读出 CFBundleIdentifier", () => {
    const app = makeBundle(
      `<?xml version="1.0"?><plist><dict>
        <key>CFBundleName</key><string>Foo</string>
        <key>CFBundleIdentifier</key><string>com.github.Electron</string>
      </dict></plist>`,
    );
    expect(readBundleId(app)).toBe("com.github.Electron");
    rmSync(app, { recursive: true, force: true });
  });

  it("Info.plist 缺失 → null（调用方据此降级,不拿猜的 id 去 reset）", () => {
    const app = makeBundle(null);
    expect(readBundleId(app)).toBeNull();
    rmSync(app, { recursive: true, force: true });
  });

  it("plist 里没有该键 → null", () => {
    const app = makeBundle(`<?xml version="1.0"?><plist><dict></dict></plist>`);
    expect(readBundleId(app)).toBeNull();
    rmSync(app, { recursive: true, force: true });
  });
});

describe("TCC_SERVICE_BY_KIND", () => {
  it("只覆盖没有应用内授权弹窗的两项", () => {
    expect(TCC_SERVICE_BY_KIND.accessibility).toBe("Accessibility");
    expect(TCC_SERVICE_BY_KIND.screenRecording).toBe("ScreenCapture");
    // 日历/麦克风/语音识别有真正的模态弹窗,不该动它们的 TCC 记录。
    expect(TCC_SERVICE_BY_KIND.calendar).toBeUndefined();
    expect(TCC_SERVICE_BY_KIND.microphone).toBeUndefined();
    expect(TCC_SERVICE_BY_KIND.speechRecognition).toBeUndefined();
  });
});

describe("repromptPermission", () => {
  const deps = (over: Partial<Parameters<typeof repromptPermission>[1]> = {}) => ({
    bundleId: "com.github.Electron",
    resetTcc: vi.fn().mockResolvedValue(true),
    requestAccess: vi.fn().mockResolvedValue(true),
    openSettings: vi.fn().mockResolvedValue(undefined),
    ...over,
  });

  // 顺序是这个功能的全部要害:先 reset 清掉「已提示过」的记录,再 request 才能重新弹提示。
  // 反过来 request 会被那条记录挡住,于是提示不弹、条目不出现,按钮看起来毫无作用。
  it("严格先 reset 再 request", async () => {
    const order: string[] = [];
    const d = deps({
      resetTcc: vi.fn(async () => {
        order.push("reset");
        return true;
      }),
      requestAccess: vi.fn(async () => {
        order.push("request");
        return true;
      }),
    });
    await repromptPermission("accessibility", d);
    expect(order).toEqual(["reset", "request"]);
    expect(d.resetTcc).toHaveBeenCalledWith("Accessibility", "com.github.Electron");
  });

  it("screenRecording 用 ScreenCapture 这个 service 名", async () => {
    const d = deps();
    await repromptPermission("screenRecording", d);
    expect(d.resetTcc).toHaveBeenCalledWith("ScreenCapture", "com.github.Electron");
  });

  // 面板始终打开:提示可能因系统状态仍不弹出,此时面板是用户唯一可见的着力点。
  it("无论 reset / request 结果如何都打开设置面板", async () => {
    for (const [reset, req] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const d = deps({
        resetTcc: vi.fn().mockResolvedValue(reset),
        requestAccess: vi.fn().mockResolvedValue(req),
      });
      await repromptPermission("accessibility", d);
      expect(d.openSettings).toHaveBeenCalledWith("accessibility");
    }
  });

  it("bundleId 读不到 → 跳过 reset,但仍请求 + 开面板（降级而非报废）", async () => {
    const d = deps({ bundleId: null });
    const r = await repromptPermission("accessibility", d);
    expect(d.resetTcc).not.toHaveBeenCalled();
    expect(d.requestAccess).toHaveBeenCalled();
    expect(d.openSettings).toHaveBeenCalled();
    expect(r.reset).toBe(false);
  });

  it("不支持 reprompt 的 kind → 跳过 reset,退化成原有的「请求 + 开面板」", async () => {
    const d = deps();
    const r = await repromptPermission("calendar", d);
    expect(d.resetTcc).not.toHaveBeenCalled();
    expect(r).toEqual({ reset: false, requested: true });
    expect(d.openSettings).toHaveBeenCalledWith("calendar");
  });

  it("回带 reset / requested 结果供 UI 与日志判断", async () => {
    const r = await repromptPermission("accessibility", deps({ resetTcc: vi.fn().mockResolvedValue(false) }));
    expect(r).toEqual({ reset: false, requested: true });
  });
});
