// @vitest-environment jsdom
// CoreProvider 核心路径埋点（U7）单测
// 覆盖：挂载时经注入 desktopBridge.logMessage("info", ...) 记一条初始化信息（含 wsId / liveData /
// 是否有桥）；web 端 bridge=null 时安全 no-op 不抛错。
// 用 jsdom 环境（render 依赖 DOM）；core 包默认 node 环境，用 docblock 覆盖。

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import type { DesktopBridge } from "./desktop/bridge";
import { CoreProvider } from "./provider";

// 构造最小 mock bridge：仅关心 logMessage 被如何调用。
function makeBridge(logMessage: DesktopBridge["logMessage"]): DesktopBridge {
  return { loadChat: async () => [], saveChat: async () => {}, logMessage } as unknown as DesktopBridge;
}

describe("CoreProvider 初始化埋点（U7）", () => {
  it("挂载时经注入 bridge 以 info 级记录一条初始化信息（含 wsId/liveData/bridge）", () => {
    const logMessage = vi.fn<(level: string, message: string) => Promise<void>>(async () => {});
    render(
      React.createElement(
        CoreProvider,
        {
          wsId: "ws-7",
          identity: { userId: "u", name: "n" },
          desktopBridge: makeBridge(logMessage),
        },
        null,
      ),
    );
    expect(logMessage).toHaveBeenCalledTimes(1);
    const [level, message] = logMessage.mock.calls[0]!;
    expect(level).toBe("info");
    // 报文须含 wsId 与两项布尔标识（无 liveData 配置 → liveData=false；有桥 → bridge=true）。
    expect(message).toContain("ws-7");
    expect(message).toContain("liveData=false");
    expect(message).toContain("bridge=true");
  });

  it("web 端 desktopBridge=null 时安全 no-op，不抛错", () => {
    expect(() =>
      render(
        React.createElement(
          CoreProvider,
          {
            wsId: "ws-web",
            identity: { userId: "u", name: "n" },
            desktopBridge: null,
          },
          null,
        ),
      ),
    ).not.toThrow();
  });
});
