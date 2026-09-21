// 铃铛 + 消息中心测试：未读角标、打开活动视图即已读、订阅推送、无桥降级。
// 数据全部来自主进程，故这里用假 bridge 驱动，不碰真实 IPC。

import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import { i18nReady } from "@cortex-work/core/i18n";
import type { DesktopBridge, NotificationRecord } from "@cortex-work/core";
import { NotificationBell, NotificationList, useNotificationCenter } from "./NotificationBell";

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

// 用侧栏同款接法渲染:hook 取数据,铃铛切换 open,打开时渲染消息列表并标已读。
function Harness() {
  const center = useNotificationCenter();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && center.unread > 0) center.markRead();
  }, [open, center]);
  return (
    <>
      <NotificationBell active={open} badge={center.unread} onToggle={() => setOpen((v) => !v)} />
      {open && center.items.length > 0 ? <NotificationList items={center.items} onClear={center.clear} /> : null}
    </>
  );
}

function renderBell(bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <Harness />
    </CoreProvider>,
  );
}

beforeAll(async () => {
  await i18nReady;
});
afterEach(cleanup);

describe("NotificationBell / useNotificationCenter", () => {
  it("有未读时显示蓝点(不显示数字),条数写在无障碍名称里", async () => {
    const { container } = renderBell(bridgeWith([rec(), rec(), rec({ readAt: NOW })]));
    await waitFor(() => expect(container.querySelector(".pw-sb-bell-dot")).toBeTruthy());
    expect(container.querySelector(".pw-sb-bell-dot")?.textContent).toBe("");
    expect(screen.getByRole("button", { name: /2 条待关注/ })).toBeTruthy();
  });

  it("全部已读时无角标", async () => {
    const { container } = renderBell(bridgeWith([rec({ readAt: NOW })]));
    await waitFor(() => expect(container.querySelector(".pw-sb-bell")).toBeTruthy());
    expect(container.querySelector(".pw-sb-bell-dot")).toBeNull();
  });

  // 打开活动视图即视为看到了消息，不该再要求用户逐条点「已读」。
  it("点铃铛切换为激活态,消息标为已读并展示列表", async () => {
    const bridge = bridgeWith([rec({ title: "日报生成完成", body: "共 12 条" })]);
    const { container } = renderBell(bridge);
    await waitFor(() => expect(container.querySelector(".pw-sb-bell-dot")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /查看活动/ }));
    expect(screen.getByRole("button", { name: /关闭活动视图/ }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(bridge.notificationCenterMarkRead).toHaveBeenCalled());
    expect(screen.getByText("日报生成完成")).toBeTruthy();
    expect(screen.getByText("共 12 条")).toBeTruthy();
    expect(screen.getByText("消息保留 60 天")).toBeTruthy();
    fireEvent.click(screen.getByText("清空"));
    expect(bridge.notificationCenterClear).toHaveBeenCalled();
  });

  // 主进程推全量快照 → 列表即时刷新，不必等下次手动拉取。
  it("订阅主进程推送后刷新", async () => {
    let push: ((list: NotificationRecord[]) => void) | undefined;
    const bridge = bridgeWith([], {
      onNotificationCenterChanged: (cb: (list: NotificationRecord[]) => void) => {
        push = cb;
        return () => {};
      },
    } as Partial<DesktopBridge>);
    const { container } = renderBell(bridge);
    await waitFor(() => expect(push).toBeTruthy());
    act(() => push!([rec({ title: "新来的" })]));
    await waitFor(() => expect(container.querySelector(".pw-sb-bell-dot")).toBeTruthy());
  });

  // 活动视图不依赖消息中心:无桥(web / 旧壳)时铃铛照常可用,只是没有消息。
  it("无桥能力时铃铛仍渲染、无角标", () => {
    const { container } = renderBell(null);
    expect(container.querySelector(".pw-sb-bell")).toBeTruthy();
    expect(container.querySelector(".pw-sb-bell-dot")).toBeNull();
  });
});
