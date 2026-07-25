// research IPC 的 sender 校验测试。用手写的最小事件替身，不加载 electron。
import { describe, expect, it } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { assertResearchSender, isAllowedResearchSenderUrl } from "./ipc-guard";

/// 造一个只带 senderFrame.url 的最小事件替身（真实 IpcMainInvokeEvent 字段远多于此）。
function eventWith(url: string | null): IpcMainInvokeEvent {
  return { senderFrame: url === null ? null : { url } } as unknown as IpcMainInvokeEvent;
}

const DEV_SERVER = "http://localhost:5173/index.html";

describe("isAllowedResearchSenderUrl", () => {
  it.each([
    ["file:///Applications/Cortex.app/Contents/Resources/app.asar/out/renderer/index.html", undefined, true],
    ["http://localhost:5173/index.html", DEV_SERVER, true],
    ["http://localhost:5173/#/research", DEV_SERVER, true],
    // 同 origin 才算：端口不同即视为外部页面
    ["http://localhost:6666/index.html", DEV_SERVER, false],
    ["https://evil.example.com/", DEV_SERVER, false],
    // 未配置 dev server 时，任何 http 来源都不可信（打包态只应有 file://）
    ["http://localhost:5173/index.html", undefined, false],
    ["data:text/html,<script>fetch()</script>", undefined, false],
    ["about:blank", undefined, false],
    ["", undefined, false],
  ])("%s（devServer=%s）→ %s", (url, devServerUrl, expected) => {
    expect(isAllowedResearchSenderUrl(url, devServerUrl)).toBe(expected);
  });

  it("senderFrame 为空一律拒绝", () => {
    expect(isAllowedResearchSenderUrl(null, DEV_SERVER)).toBe(false);
    expect(isAllowedResearchSenderUrl(undefined, DEV_SERVER)).toBe(false);
  });
});

describe("assertResearchSender", () => {
  it("合法 sender 直接通过", () => {
    expect(() => assertResearchSender(eventWith("file:///app/index.html"))).not.toThrow();
  });

  it("非法 sender 抛错（错误消息不回显完整 URL 的查询串）", () => {
    expect(() => assertResearchSender(eventWith("https://evil.example.com/x?token=abc"))).toThrow(
      /不可信/,
    );
    try {
      assertResearchSender(eventWith("https://evil.example.com/x?token=abc"));
    } catch (err) {
      expect((err as Error).message).not.toContain("token=abc");
    }
  });

  it("senderFrame 为 null 时抛错", () => {
    expect(() => assertResearchSender(eventWith(null))).toThrow();
  });
});
