import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchSelection } from "./ProjectsWorkbench";
import { ProjectTree } from "./ProjectTree";

// mock core hooks（U6 只依赖 tasks hooks；taskProjectTree 纯函数保持真实）。
// 三层树：文件夹A → 项目B → 项目C，用于折叠展开与选中回调断言。
const mutate = vi.fn();
vi.mock("@cortex-work/core/personal/tasks", () => {
  const projects = [
    { id: "a", name: "文件夹A", kind: "folder" },
    { id: "b", name: "项目B", kind: "project", parentId: "a" },
    { id: "c", name: "项目C", kind: "project", parentId: "b", mode: "sequential" },
  ];
  return {
    useTaskProjects: () => ({ data: projects }),
    useAddTaskProject: () => ({ mutate }),
    useUpdateTaskProject: () => ({ mutate }),
    useDeleteTaskProject: () => ({ mutate }),
    // projectMode 是纯函数，mock 里照实现（读时默认 parallel）供节点标识 / 同档去重用。
    projectMode: (p: { mode?: string }) => p.mode ?? "parallel",
  };
});

function renderTree(selection: WorkbenchSelection = { kind: "today" }) {
  const onSelect = vi.fn();
  render(<ProjectTree selection={selection} onSelect={onSelect} />);
  return { onSelect };
}

afterEach(() => {
  cleanup();
  mutate.mockClear();
});

describe("ProjectTree", () => {
  it("三层树逐级折叠/展开：默认只见根，展开后依次露出子孙", () => {
    renderTree();
    // 默认全收起 → 只有根节点可见
    expect(screen.getByText("文件夹A")).toBeTruthy();
    expect(screen.queryByText("项目B")).toBeNull();
    expect(screen.queryByText("项目C")).toBeNull();

    // 展开 A（此时唯一带「展开」标题的箭头）→ 露出 B
    fireEvent.click(screen.getByTitle("展开"));
    expect(screen.getByText("项目B")).toBeTruthy();
    expect(screen.queryByText("项目C")).toBeNull();

    // A 现为「折叠」，剩下 B 的「展开」箭头 → 展开 B 露出 C
    fireEvent.click(screen.getByTitle("展开"));
    expect(screen.getByText("项目C")).toBeTruthy();
  });

  it("点节点名触发 onSelect：folder → kind folder，project → kind project", () => {
    const { onSelect } = renderTree();
    fireEvent.click(screen.getByText("文件夹A"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "folder", id: "a" });

    fireEvent.click(screen.getByTitle("展开")); // 展开 A 才能点到 B
    fireEvent.click(screen.getByText("项目B"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "project", id: "b" });
  });

  it("今日 / 收件箱内置入口切换", () => {
    const { onSelect } = renderTree({ kind: "inbox" });
    fireEvent.click(screen.getByText("今日"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "today" });
    fireEvent.click(screen.getByText("收件箱"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "inbox" });
  });

  it("folder 节点不渲染执行模式菜单（U8：模式仅 project 有意义）", () => {
    renderTree();
    // 仅根 A（folder）可见 → 无执行模式按钮
    expect(screen.queryByTitle("执行模式（并行 / 顺序）")).toBeNull();
  });

  it("project 节点切「顺序」经 useUpdateTaskProject 写回 patch.mode（U8/R24）", () => {
    renderTree();
    fireEvent.click(screen.getByTitle("展开")); // 展开 A 露出 project B（默认 parallel）
    fireEvent.click(screen.getByTitle("执行模式（并行 / 顺序）"));
    fireEvent.click(screen.getByText("顺序"));
    expect(mutate).toHaveBeenCalledWith({ id: "b", patch: { mode: "sequential" } });
  });

  it("顺序项目在树节点显示模式标识；点当前档不重复写回（同档去重）", () => {
    renderTree();
    fireEvent.click(screen.getByTitle("展开")); // A → B
    fireEvent.click(screen.getByTitle("展开")); // B → C（sequential）
    // 顺序项目 C 有模式标识；并行项目 B 无
    expect(screen.getByLabelText("顺序项目")).toBeTruthy();
    // 打开 C 的模式菜单（DOM 末位）点「顺序」→ 同档、不 mutate
    const menus = screen.getAllByTitle("执行模式（并行 / 顺序）");
    fireEvent.click(menus[menus.length - 1]!);
    fireEvent.click(screen.getByText("顺序"));
    expect(mutate).not.toHaveBeenCalled();
  });
});
