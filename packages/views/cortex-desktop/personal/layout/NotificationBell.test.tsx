// 消息铃铛测试：未读红点、打开即已读、订阅推送、无桥降级。
// 数据全部来自主进程，故这里用假 bridge 驱动，不碰真实 IPC。

import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import { i18nReady } from "@cortex-work/core/i18n";
import type { DesktopBridge, NotificationRecord } from "@cortex-work/core";
import { NotificationBell } from "./NotificationBell";

const NOW = Date.now();

function rec(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: `n-${Math.random().toString(36).slice(2)}`,
    source: "automation",
    level: "info",
    title: "自动化跑完了",
    createdAt: NOW - 60_000,
    ...overrides,
  };
}

function bridgeWith(items: NotificationRecord[], extra: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    notificationCenterList: async () => items,
    notificationCenterMarkRead: vi.fn(async () => {}),
    notificationCenterClear: vi.fn(async () => {}),
    ...extra,
  } as unknown as DesktopBridge;
}

function renderBell(bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <NotificationBell />
    </CoreProvider>,
  );
}

beforeAll(async () => {
  await i18nReady;
});
afterEach(cleanup);

describe("NotificationBell", () => {
  it("未读数打在红点上，读完不再显示", async () => {
    const { container } = renderBell(bridgeWith([rec(), rec(), rec({ readAt: NOW })]));
    await waitFor(() => expect(container.querySelector(".pw-sb-bell-dot")?.textContent).toBe("2"));
  });

  it("未读超过 99 显示 99+，不撑破圆点", async () => {
    const many = Array.from({ length: 120 }, () => rec());
    const { container } = renderBell(bridgeWith(many));
    await waitFor(() => expect(container.querySelector(".pw-sb-bell-dot")?.textContent).toBe("99+"));
  });

  it("全部已读时无红点", async () => {
    const { container } = renderBell(bridgeWith([rec({ readAt: NOW })]));
    await waitFor(() => expect(container.querySelector(".pw-sb-bell")).toBeTruthy());
    expect(container.querySelector(".pw-sb-bell-dot")).toBeNull();
  });

  // 展开即视为看到了，不该再要求用户逐条点「已读」。
  it("打开 popover 即把未读标为已读", async () => {
    const bridge = bridgeWith([rec()]);
    const { container } = renderBell(bridge);
    await waitFor(() => expect(container.querySelector(".pw-sb-bell-dot")).toBeTruthy());

    fireEvent.click(container.querySelector(".pw-sb-bell")!);
    expect(bridge.notificationCenterMarkRead).toHaveBeenCalled();
    expect(container.querySelector(".pw-sb-msgs")).toBeTruthy();
  });

  it("空列表给出占位而不是空白面板", async () => {
    const { container } = renderBell(bridgeWith([]));
    await waitFor(() => expect(container.querySelector(".pw-sb-bell")).toBeTruthy());
    fireEvent.click(container.querySelector(".pw-sb-bell")!);
    expect(screen.getByText("暂无消息")).toBeTruthy();
    // 空列表时不给「清空」（没东西可清）。
    expect(container.querySelector(".pw-sb-msgs-clear")).toBeNull();
  });

  it("列表渲染标题与正文，并告知 60 天保留期", async () => {
    const { container } = renderBell(bridgeWith([rec({ title: "日报生成完成", body: "共 12 条" })]));
    await waitFor(() => expect(container.querySelector(".pw-sb-bell")).toBeTruthy());
    fireEvent.click(container.querySelector(".pw-sb-bell")!);
    expect(screen.getByText("日报生成完成")).toBeTruthy();
    expect(screen.getByText("共 12 条")).toBeTruthy();
    expect(screen.getByText("消息保留 60 天")).toBeTruthy();
  });

  // 主进程推全量快照 → 列表即时刷新，不必等下次手动拉取。
  it("订阅主进程推送后刷新列表", async () => {
    let push: ((list: NotificationRecord[]) => void) | undefined;
    const bridge = bridgeWith([], {
      onNotificationCenterChanged: (cb: (list: NotificationRecord[]) => void) => {
        push = cb;
        return () => {};
      },
    } as Partial<DesktopBridge>);
    const { container } = renderBell(bridge);
    await waitFor(() => expect(push).toBeTruthy());

    push!([rec({ title: "新来的" })]);
    await waitFor(() => expect(container.querySelector(".pw-sb-bell-dot")?.textContent).toBe("1"));
  });

  it("无桥能力（web / 旧壳）整体不渲染", () => {
    const { container } = renderBell(null);
    expect(container.querySelector(".pw-sb-bell")).toBeNull();
  });
});
