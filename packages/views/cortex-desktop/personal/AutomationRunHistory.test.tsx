import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationRun } from "@cortex-work/core";
import { AutomationRunHistory } from "./AutomationRunHistory";

afterEach(() => cleanup());

// 用本地时间构造,使 fmtDateTime(同样按本地时区)的断言与时区无关。
const run = (i: number, over: Partial<AutomationRun> = {}): AutomationRun => ({
  id: `r${i}`,
  automationId: "a1",
  startedAt: new Date(2026, 5, 24 - i, 9, 10).getTime(),
  endedAt: new Date(2026, 5, 24 - i, 9, 10, 30).getTime(),
  status: "ok",
  trigger: i % 2 === 0 ? "schedule" : "manual",
  agent: "claude",
  prompt: "p",
  output: `第 ${i} 次输出内容`,
  ...over,
});

const many = (n: number) => Array.from({ length: n }, (_, i) => run(i));

describe("AutomationRunHistory", () => {
  it("超过一页 → 显示「加载更多」,点击后多渲染一页", () => {
    const { getByText, queryByText } = render(
      <AutomationRunHistory runs={many(13)} onOpenRun={() => {}} onDeleteRun={() => {}} />,
    );
    // 首屏 10 条,第 11 条(r10)不可见
    expect(queryByText("第 10 次输出内容")).toBeNull();
    fireEvent.click(getByText(/加载更多/));
    // 加载更多后展开 r10 才能看到正文,这里先确认按钮消失(13 条一次补满)
    expect(queryByText(/加载更多/)).toBeNull();
  });

  it("行内展开单开:点一行展开,点另一行前者收起", () => {
    const { getByText, queryByText } = render(
      <AutomationRunHistory runs={[run(0), run(1)]} onOpenRun={() => {}} onDeleteRun={() => {}} />,
    );
    fireEvent.click(getByText("2026-06-24 09:10")); // r0
    expect(getByText("第 0 次输出内容")).toBeTruthy();
    fireEvent.click(getByText("2026-06-23 09:10")); // r1
    expect(getByText("第 1 次输出内容")).toBeTruthy();
    expect(queryByText("第 0 次输出内容")).toBeNull();
  });

  it("查看完整 → onOpenRun(id)", () => {
    const onOpenRun = vi.fn();
    const { getByText } = render(
      <AutomationRunHistory runs={[run(0)]} onOpenRun={onOpenRun} onDeleteRun={() => {}} />,
    );
    fireEvent.click(getByText("2026-06-24 09:10"));
    fireEvent.click(getByText("查看完整"));
    expect(onOpenRun).toHaveBeenCalledWith("r0");
  });

  it("行尾删除 → onDeleteRun(id),不触发展开", () => {
    const onDeleteRun = vi.fn();
    const { getAllByTitle, queryByText } = render(
      <AutomationRunHistory runs={[run(0)]} onOpenRun={() => {}} onDeleteRun={onDeleteRun} />,
    );
    fireEvent.click(getAllByTitle("删除此记录")[0]!);
    expect(onDeleteRun).toHaveBeenCalledWith("r0");
    expect(queryByText("第 0 次输出内容")).toBeNull();
  });

  it("搜索过滤:命中关键字仅留命中行并显示计数,无命中显示空态", () => {
    const { getByPlaceholderText, getByText, queryByText } = render(
      <AutomationRunHistory runs={[run(0), run(1)]} onOpenRun={() => {}} onDeleteRun={() => {}} />,
    );
    const input = getByPlaceholderText("搜索日期、状态或内容…");
    fireEvent.change(input, { target: { value: "手动" } }); // 仅 r1 是手动
    expect(getByText("1 / 2 条")).toBeTruthy();
    fireEvent.change(input, { target: { value: "不存在的词" } });
    expect(getByText("没有匹配的运行记录")).toBeTruthy();
    expect(queryByText(/次运行/)).toBeNull();
  });

  it("空 runs → 暂无运行记录", () => {
    const { getByText } = render(<AutomationRunHistory runs={[]} onOpenRun={() => {}} onDeleteRun={() => {}} />);
    expect(getByText("暂无运行记录")).toBeTruthy();
  });
});
