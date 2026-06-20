import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocFileRaw } from "@cortex-work/core";

// 隔离 core 的桥/查询/动作 hook：useDocTasks 返回 mock 聚合数据，useContinueDoc 给 spy。
const h = vi.hoisted(() => ({ data: undefined as unknown, continueSpy: vi.fn() }));
vi.mock("@cortex-work/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cortex-work/core")>();
  return {
    ...actual,
    useDocTasks: () => ({ data: h.data }),
    useDocTasksWatch: () => {},
    useContinueDoc: () => h.continueSpy,
    docTasksAvailable: () => true,
    useDesktopBridge: () => ({ readFile: async () => ({ content: "# 详情", truncated: false }) }),
  };
});

import { assembleDocTasks } from "@cortex-work/core";
import { TasksDocsView } from "./TasksDocsView";

function raw(name: string, kind: DocFileRaw["kind"], head: string): DocFileRaw {
  return { name, path: `/repo/docs/${kind}/${name}`, kind, mtimeMs: 0, head };
}

const RAW: DocFileRaw[] = [
  raw("2026-06-17-001-feat-idea-a-deepen.md", "ideation", "---\ntopic: a\n---\n# 想法A"),
  raw("2026-06-17-002-feat-plan-b-plan.md", "plan", "---\ntitle: 计划B\ntype: feat\nstatus: ready\n---"),
  raw("2026-06-17-003-fix-plan-c-plan.md", "plan", "---\ntitle: 计划C\ntype: fix\nstatus: completed\n---"),
  raw("d-requirements.md", "brainstorm", "---\ntopic: d\n---\n# 需求D"),
  raw("2026-06-17-004-feat-plan-e-plan.md", "plan", "---\ntitle: 计划E\ntype: feat\norigin: docs/brainstorms/d-requirements.md\n---"),
];

beforeEach(() => {
  h.data = assembleDocTasks(RAW);
  h.continueSpy.mockClear();
});
afterEach(() => cleanup());

describe("TasksDocsView", () => {
  it("按状态分组并显示计数", () => {
    render(<TasksDocsView onToast={() => {}} />);
    // 待执行组含 计划B / 计划E（plan 默认 todo），构思组含 想法A / 需求D。
    expect(screen.getByText(/待执行 \(2\)/)).toBeTruthy();
    expect(screen.getByText(/构思 \(2\)/)).toBeTruthy();
    expect(screen.getByText(/已完成 \(1\)/)).toBeTruthy();
  });

  it("已完成组默认折叠，点击展开", () => {
    render(<TasksDocsView onToast={() => {}} />);
    expect(screen.queryByText("计划C")).toBeNull(); // done 默认折叠
    fireEvent.click(screen.getByText(/已完成 \(1\)/));
    expect(screen.getByText("计划C")).toBeTruthy();
  });

  it("标签 chip 筛选：选 fix 只剩 fix 卡", () => {
    render(<TasksDocsView onToast={() => {}} />);
    // 展开 done 才能看到 fix 的计划C
    fireEvent.click(screen.getByText(/已完成 \(1\)/));
    expect(screen.getByText("计划B")).toBeTruthy();
    const fixChip = screen.getAllByText("fix").find((el) => el.classList.contains("pw-doc-chip"))!;
    fireEvent.click(fixChip);
    expect(screen.queryByText("计划B")).toBeNull(); // feat 被过滤掉
    expect(screen.getByText("计划C")).toBeTruthy();
  });

  it("空数据显示空态提示", () => {
    h.data = { docs: [], pipelines: [], orphans: [] };
    render(<TasksDocsView onToast={() => {}} />);
    expect(screen.getByText(/没有匹配的文档/)).toBeTruthy();
  });

  it("点击继续按钮触发 useContinueDoc", () => {
    render(<TasksDocsView onToast={() => {}} />);
    // 计划B 的继续按钮文案为「开始实现」(plan→ce-work)
    const btns = screen.getAllByText("开始实现");
    fireEvent.click(btns[0]!);
    expect(h.continueSpy).toHaveBeenCalledTimes(1);
  });

  it("血缘视图开关渲染流水线（需求D→计划E 成链）", () => {
    render(<TasksDocsView onToast={() => {}} />);
    fireEvent.click(screen.getByText("血缘"));
    // 流水线节点用阶段标签着色，需求(📋)与计划(📐)同卡出现
    expect(screen.getByText("计划E")).toBeTruthy();
    expect(screen.getByText("需求D")).toBeTruthy();
  });

  it("点击卡片进入详情并可返回", () => {
    render(<TasksDocsView onToast={() => {}} />);
    fireEvent.click(screen.getByText("计划B"));
    const back = screen.getByTitle("返回列表");
    expect(back).toBeTruthy();
    fireEvent.click(back);
    expect(screen.getByText(/待执行 \(2\)/)).toBeTruthy(); // 回到列表
  });

  it("列表卡片显示文件名（basename）", () => {
    render(<TasksDocsView onToast={() => {}} />);
    // 计划B 卡片应展示其源文件名，便于区分同标题/同日期文档
    expect(screen.getByText("2026-06-17-002-feat-plan-b-plan.md")).toBeTruthy();
  });

  it("进入详情显示文件完整路径", () => {
    render(<TasksDocsView onToast={() => {}} />);
    fireEvent.click(screen.getByText("计划B"));
    // 详情态展示仓库相对全路径（raw() 里 path = /repo/docs/{kind}/{name}）
    expect(screen.getByText("/repo/docs/plan/2026-06-17-002-feat-plan-b-plan.md")).toBeTruthy();
  });
});
