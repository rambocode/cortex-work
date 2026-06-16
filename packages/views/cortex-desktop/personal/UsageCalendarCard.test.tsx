import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, dayKey } from "@cortex-work/core";
import type { DayGroup, DesktopBridge } from "@cortex-work/core";
import { UsageCalendarCard } from "./UsageCalendarCard";

afterEach(cleanup);

const TODAY = dayKey(Date.now());

function bridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return { ...over } as unknown as DesktopBridge;
}

function activityGroups(): DayGroup[] {
  return [{ day: TODAY, events: [], stats: { sessions: 1, runs: 4, files: 0, commits: 0, notes: 0 } }];
}

function renderCard(opts: { groups?: DayGroup[]; bridge?: DesktopBridge; onPick?: (d: string) => void } = {}) {
  const onPick = opts.onPick ?? vi.fn();
  const utils = render(
    <CoreProvider wsId="t" identity={{ userId: "me", name: "我" }} desktopBridge={opts.bridge ?? bridge()}>
      <UsageCalendarCard groups={opts.groups ?? activityGroups()} selectedDay={TODAY} onPickDay={onPick} />
    </CoreProvider>,
  );
  return { ...utils, onPick };
}

// 默认折叠：先点展开按钮，露出 tab 头部与网格，便于后续断言。
function expand() {
  fireEvent.click(screen.getByLabelText("展开用量日历"));
}

describe("UsageCalendarCard", () => {
  it("默认折叠：只显示展开按钮、不渲染头部与网格", () => {
    const { container } = renderCard();
    expect(screen.getByLabelText("展开用量日历")).toBeTruthy();
    expect(container.querySelector(".pw-usagecal-head")).toBeNull();
    expect(container.querySelector(".pw-hm")).toBeNull();
  });

  it("点展开渲染网格；再点折叠回到只剩展开按钮", () => {
    const { container } = renderCard();
    expand();
    expect(container.querySelector(".pw-hm")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("折叠用量日历"));
    expect(container.querySelector(".pw-hm")).toBeNull();
    expect(screen.getByLabelText("展开用量日历")).toBeTruthy();
  });

  it("切到 token 模式时改用 useDailyUsage 数据源并按 token 上色", async () => {
    const dailyUsage = vi.fn().mockResolvedValue({
      at: Date.now(),
      days: [{ day: TODAY, tokens: 300_000, msgs: 5 }],
    });
    const { container } = renderCard({ groups: [], bridge: bridge({ dailyUsage }) });
    expand();
    fireEvent.click(screen.getByRole("tab", { name: "token 用量" }));
    await waitFor(() => expect(dailyUsage).toHaveBeenCalled());
    await waitFor(() => {
      const cell = container.querySelector(`.pw-hm-cell[data-today="true"]`);
      // 300k tokens → tokenHeatLevel 档位 3
      expect(cell?.getAttribute("data-heat")).toBe("3");
    });
  });

  it("token 模式无数据 → warmup 空态", async () => {
    const dailyUsage = vi.fn().mockResolvedValue({ at: Date.now(), days: [] });
    renderCard({ groups: [], bridge: bridge({ dailyUsage }) });
    expand();
    fireEvent.click(screen.getByRole("tab", { name: "token 用量" }));
    expect(await screen.findByText("还没有记录到用量")).toBeTruthy();
    expect(screen.getByText("智能体用量")).toBeTruthy();
  });

  it("点击某天 cell 调用 onPickDay", () => {
    const onPick = vi.fn();
    const { container } = renderCard({ onPick });
    expand();
    const cell = container.querySelector(`.pw-hm-cell[data-today="true"]`) as HTMLButtonElement;
    fireEvent.click(cell);
    expect(onPick).toHaveBeenCalledWith(TODAY);
  });

  it("token 模式点刷新触发重新拉取", async () => {
    const dailyUsage = vi.fn().mockResolvedValue({
      at: Date.now(),
      days: [{ day: TODAY, tokens: 1000, msgs: 1 }],
    });
    renderCard({ groups: [], bridge: bridge({ dailyUsage }) });
    expand();
    fireEvent.click(screen.getByRole("tab", { name: "token 用量" }));
    await waitFor(() => expect(dailyUsage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("刷新"));
    await waitFor(() => expect(dailyUsage).toHaveBeenCalledTimes(2));
  });

  it("折叠再展开保留 token 模式", () => {
    renderCard({ bridge: bridge({ dailyUsage: vi.fn().mockResolvedValue({ at: 0, days: [] }) }) });
    expand();
    fireEvent.click(screen.getByRole("tab", { name: "token 用量" }));
    fireEvent.click(screen.getByLabelText("折叠用量日历"));
    expand();
    // 重新展开后仍是 token 模式：该 tab 处于 active 态
    expect(screen.getByRole("tab", { name: "token 用量" }).getAttribute("data-active")).toBe("true");
  });
});
