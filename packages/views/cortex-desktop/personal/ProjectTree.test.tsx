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
  // 折叠态经 localStorage 窄通道持久化，测试间清理避免串场。
  try {
    window.localStorage.clear();
  } catch {
    /* noop */
  }
});

describe("ProjectTree", () => {
  it("默认全展开：三层全部可见；折叠某节点后其子孙隐藏、再展开恢复（U11）", () => {
    renderTree();
    // 默认全展开 → 三层节点均可见
    expect(screen.getByText("文件夹A")).toBeTruthy();
    expect(screen.getByText("项目B")).toBeTruthy();
    expect(screen.getByText("项目C")).toBeTruthy();

    // 折叠 A（展开态标题为「折叠」，DOM 首个即 A）→ 子孙 B、C 隐藏
    fireEvent.click(screen.getAllByTitle("折叠")[0]!);
    expect(screen.queryByText("项目B")).toBeNull();
    expect(screen.queryByText("项目C")).toBeNull();

    // A 现为「折叠」态，箭头标题变「展开」→ 再点恢复
    fireEvent.click(screen.getByTitle("展开"));
    expect(screen.getByText("项目B")).toBeTruthy();
    expect(screen.getByText("项目C")).toBeTruthy();
  });

  it("折叠态经 localStorage 窄通道持久化：重挂后保持折叠（U11）", () => {
    const first = render(<ProjectTree selection={{ kind: "today" }} onSelect={vi.fn()} />);
    fireEvent.click(first.getAllByTitle("折叠")[0]!); // 折叠 A
    expect(first.queryByText("项目B")).toBeNull();
    first.unmount();
    // 全新挂载读回 localStorage → A 仍折叠、B 不可见。
    const second = render(<ProjectTree selection={{ kind: "today" }} onSelect={vi.fn()} />);
    expect(second.queryByText("项目B")).toBeNull();
  });

  it("点节点名触发 onSelect：folder → kind folder，project → kind project", () => {
    const { onSelect } = renderTree();
    fireEvent.click(screen.getByText("文件夹A"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "folder", id: "a" });

    fireEvent.click(screen.getByText("项目B")); // 默认全展开，B 直接可见
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
    // 全展开后可见 folder A + project B + project C；模式菜单只应有 2 个（B、C），folder A 无。
    expect(screen.getAllByTitle("执行模式（并行 / 顺序）").length).toBe(2);
  });

  it("project 节点切「顺序」经 useUpdateTaskProject 写回 patch.mode（U8/R24）", () => {
    renderTree();
    // 默认全展开，project B（默认 parallel）为首个模式菜单。
    fireEvent.click(screen.getAllByTitle("执行模式（并行 / 顺序）")[0]!);
    fireEvent.click(screen.getByText("顺序"));
    expect(mutate).toHaveBeenCalledWith({ id: "b", patch: { mode: "sequential" } });
  });

  it("聚焦 folder：只渲染焦点子树，今日/收件箱入口与顶层「＋」隐藏", () => {
    render(
      <ProjectTree
        selection={{ kind: "folder", id: "a" }}
        onSelect={vi.fn()}
        focus={{ kind: "folder", id: "a" }}
      />,
    );
    // 焦点子树（A 及其子孙）完整可见。
    expect(screen.getByText("文件夹A")).toBeTruthy();
    expect(screen.getByText("项目B")).toBeTruthy();
    expect(screen.getByText("项目C")).toBeTruthy();
    // 内置视图入口与顶层「＋」在聚焦态隐藏（焦点外内容不可达；顶层新建会落焦点外）。
    expect(screen.queryByText("今日")).toBeNull();
    expect(screen.queryByText("收件箱")).toBeNull();
    expect(screen.queryByTitle("新建项目 / 文件夹")).toBeNull();
  });

  it("聚焦 project：只渲染该项目及其子项目，兄弟与祖先不显示", () => {
    render(
      <ProjectTree
        selection={{ kind: "project", id: "b" }}
        onSelect={vi.fn()}
        focus={{ kind: "project", id: "b" }}
      />,
    );
    // 焦点根 B 及其子 C 可见；祖先 folder A 不再渲染。
    expect(screen.getByText("项目B")).toBeTruthy();
    expect(screen.getByText("项目C")).toBeTruthy();
    expect(screen.queryByText("文件夹A")).toBeNull();
  });

  it("聚焦目标不存在（已删竞态帧）：渲染空树且不显示「还没有项目」引导", () => {
    render(
      <ProjectTree selection={{ kind: "today" }} onSelect={vi.fn()} focus={{ kind: "project", id: "gone" }} />,
    );
    expect(screen.queryByText("文件夹A")).toBeNull();
    // 空态引导只属于「真没有项目」，聚焦竞态帧不该引导新建。
    expect(screen.queryByText("还没有项目")).toBeNull();
  });

  it("顺序项目在树节点显示模式标识；点当前档不重复写回（同档去重）", () => {
    renderTree();
    // 默认全展开，B、C 均可见。顺序项目 C 有模式标识；并行项目 B 无。
    expect(screen.getByLabelText("顺序项目")).toBeTruthy();
    // 打开 C 的模式菜单（DOM 末位）点「顺序」→ 同档、不 mutate
    const menus = screen.getAllByTitle("执行模式（并行 / 顺序）");
    fireEvent.click(menus[menus.length - 1]!);
    fireEvent.click(screen.getByText("顺序"));
    expect(mutate).not.toHaveBeenCalled();
  });
});
