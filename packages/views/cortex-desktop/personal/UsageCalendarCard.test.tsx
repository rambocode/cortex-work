import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

// 默认折叠：先点展开按钮，露出头部与网格，便于后续断言。
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

  it("有活动时按活动计数上色", () => {
    const { container } = renderCard();
    expand();
    const cell = container.querySelector(`.pw-hm-cell[data-today="true"]`);
    // 4 轮交互 + 1 新会话 → homeHeatLevel 非 0
    expect(Number(cell?.getAttribute("data-heat"))).toBeGreaterThan(0);
  });

  it("无活动 → warmup 空态", () => {
    renderCard({ groups: [] });
    expand();
    expect(screen.getByText("还没有记录到活动")).toBeTruthy();
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
});
