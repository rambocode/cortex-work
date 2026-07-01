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
    { id: "c", name: "项目C", kind: "project", parentId: "b" },
  ];
  return {
    useTaskProjects: () => ({ data: projects }),
    useAddTaskProject: () => ({ mutate }),
    useUpdateTaskProject: () => ({ mutate }),
    useDeleteTaskProject: () => ({ mutate }),
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
});
