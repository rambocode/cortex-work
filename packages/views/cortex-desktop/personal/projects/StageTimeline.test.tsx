// 阶段 timeline 组件测试：条形按几何公式定位、粒度切换改列宽、今日线存在、阶段过滤、空态。
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localDay } from "@cortex-work/core/personal/tasks";
import { dayWidthFor } from "@cortex-work/core/personal/stageTimeline";
import type { ProjectStage } from "@cortex-work/core/desktop/types";
import { StageTimeline } from "./StageTimeline";

// 以「今天」为锚构造阶段（timeline 窗口 = 今天前14/后28 天，测试不依赖固定日期）。
function isoOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDay(d);
}

const stages: ProjectStage[] = [
  { id: "s1", name: "调研", status: "done", order: 0, startDate: isoOffset(-3), dueDate: isoOffset(-1) },
  { id: "s2", name: "开发", status: "active", order: 1, startDate: isoOffset(0), dueDate: isoOffset(4) },
  { id: "s3", name: "无日期", status: "not-started", order: 2 },
];

afterEach(cleanup);

describe("StageTimeline", () => {
  it("条形按 stageBarGeometry 定位：默认周粒度（dayWidth=30），今天起 5 天的阶段 left=14*30、width=5*30", () => {
    const { container } = render(<StageTimeline stages={stages} activeStageId={null} />);
    const bar = container.querySelector<HTMLElement>('[data-stage-id="s2"] .pw-tl-bar')!;
    expect(bar.style.left).toBe(`${14 * 30}px`);
    expect(bar.style.width).toBe(`${5 * 30}px`);
    expect(bar.className).toContain("pw-tl-bar--active");
  });

  it("无日期阶段不画条、显行内提示", () => {
    const { container } = render(<StageTimeline stages={stages} activeStageId={null} />);
    expect(container.querySelector('[data-stage-id="s3"] .pw-tl-bar')).toBeNull();
    expect(screen.getByText("「无日期」未设起止日期")).toBeTruthy();
  });

  it("粒度切换改每天像素宽：切「日」后条形按 dayWidth=60 重排", () => {
    const { container } = render(<StageTimeline stages={stages} activeStageId={null} />);
    fireEvent.click(screen.getByText("日"));
    const bar = container.querySelector<HTMLElement>('[data-stage-id="s2"] .pw-tl-bar')!;
    expect(bar.style.left).toBe(`${14 * dayWidthFor("day")}px`);
    expect(bar.style.width).toBe(`${5 * dayWidthFor("day")}px`);
  });

  it("今日红线落在当天格中点（left = 14*dayWidth + dayWidth/2）", () => {
    const { container } = render(<StageTimeline stages={stages} activeStageId={null} />);
    const marker = container.querySelector<HTMLElement>(".pw-tl-today")!;
    expect(marker.style.left).toBe(`${14 * 30 + 15}px`);
  });

  it("activeStageId 过滤：只渲染目标阶段行", () => {
    const { container } = render(<StageTimeline stages={stages} activeStageId="s1" />);
    expect(container.querySelectorAll(".pw-tl-row")).toHaveLength(1);
    expect(container.querySelector('[data-stage-id="s1"]')).toBeTruthy();
  });

  it("无阶段时显空态引导", () => {
    render(<StageTimeline stages={[]} activeStageId={null} />);
    expect(screen.getByText(/暂无阶段/)).toBeTruthy();
  });

  it("「今天」按钮触发滚动容器 scrollTo（滚动居中）", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
    render(<StageTimeline stages={stages} activeStageId={null} />);
    fireEvent.click(screen.getByText("今天"));
    expect(scrollTo).toHaveBeenCalled();
  });
});
