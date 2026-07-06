// WritingSidebar 新结构单测(对齐 Kun):顶部两整行按钮、写作空间分组、默认空间副标、
// 新建文件自动递增命名、跨空间文件点击切活跃空间、展开/折叠触发扫描与 watch/unwatch。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import { __resetWritingReviews } from "@cortex-work/core/writing/review-manager";
import { WritingSidebar } from "./WritingSidebar";

const SPACE_DEFAULT = { id: "s1", name: "writing", root: "/space", isDefault: true };
const SPACE_OTHER = { id: "s2", name: "other", root: "/other" };

const treeDefault: PromptNode = {
  name: "writing",
  path: "/space",
  kind: "dir",
  children: [{ name: "a.md", path: "/space/a.md", kind: "file" }],
};
const treeOther: PromptNode = {
  name: "other",
  path: "/other",
  kind: "dir",
  children: [{ name: "b.md", path: "/other/b.md", kind: "file" }],
};

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    scanDirTree: vi.fn(async (root: string) => (root === SPACE_OTHER.root ? treeOther : treeDefault)),
    fileExists: vi.fn(async () => false),
    readFile: vi.fn(async () => ({ content: "", truncated: false })),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    deleteEntry: vi.fn(async () => {}),
    renameEntry: vi.fn(async () => {}),
    pickDirectory: vi.fn(async () => null),
    watchDir: vi.fn(async () => {}),
    unwatchDir: vi.fn(),
    onDirChanged: vi.fn(() => () => {}),
    ...over,
  } as unknown as DesktopBridge;
}

function renderSidebar(bridge: DesktopBridge): ReturnType<typeof render> {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <WritingSidebar />
    </CoreProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  __resetWritingReviews();
  useWritingSpacesStore.setState({
    spaces: [SPACE_DEFAULT, SPACE_OTHER],
    activeSpaceId: SPACE_DEFAULT.id,
  });
  useWritingWorkspaceStore.setState({ currentFile: null });
});

describe("WritingSidebar 新结构", () => {
  it("顶部两整行按钮 + 写作空间分组标题渲染", async () => {
    renderSidebar(makeBridge());
    expect(screen.getByRole("button", { name: "新建文件" })).toBeTruthy();
    // 顶部整行按钮 + 分组标题图标按钮均以「添加写作空间」为可及名(同一动作两处入口)。
    expect(screen.getAllByRole("button", { name: "添加写作空间" }).length).toBeGreaterThanOrEqual(2);
    // 分组标题 + 两个空间行
    expect(screen.getByText("写作空间")).toBeTruthy();
    expect(screen.getByText("writing")).toBeTruthy();
    expect(screen.getByText("other")).toBeTruthy();
    // 活跃(默认)空间自动展开 → 其文件渲染
    expect(await screen.findByText("a.md")).toBeTruthy();
  });

  it("默认空间渲染「默认写作空间」副标,非默认空间不渲染", () => {
    renderSidebar(makeBridge());
    const subs = screen.getAllByText("默认写作空间");
    expect(subs).toHaveLength(1);
  });

  it("顶部「新建文件」自动递增命名:untitled.md 已存在 → 建 untitled-2.md", async () => {
    // fileExists 只对 /space/untitled.md 返回 true,递增到 untitled-2.md 才落盘。
    const bridge = makeBridge({
      fileExists: vi.fn(async (p: string) => p === "/space/untitled.md"),
    });
    renderSidebar(bridge);
    await screen.findByText("a.md");
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    await waitFor(() =>
      expect(bridge.writeFile).toHaveBeenCalledWith("/space/untitled-2.md", ""),
    );
    // 打开新建文件
    await waitFor(() =>
      expect(useWritingWorkspaceStore.getState().currentFile).toBe("/space/untitled-2.md"),
    );
  });

  it("「添加写作空间」调用 pickDirectory", async () => {
    const bridge = makeBridge();
    renderSidebar(bridge);
    fireEvent.click(screen.getAllByRole("button", { name: "添加写作空间" })[0]);
    await waitFor(() => expect(bridge.pickDirectory).toHaveBeenCalled());
  });

  it("展开非活跃空间并点其文件 → 切活跃空间 + 打开", async () => {
    const bridge = makeBridge();
    renderSidebar(bridge);
    await screen.findByText("a.md");
    // 点 other 空间行展开 → 扫描其树
    fireEvent.click(screen.getByText("other"));
    expect(await screen.findByText("b.md")).toBeTruthy();
    await waitFor(() => expect(bridge.watchDir).toHaveBeenCalledWith(SPACE_OTHER.id, SPACE_OTHER.root));
    // 点 other 的文件 → 活跃空间切到 s2 + 打开
    fireEvent.click(screen.getByText("b.md"));
    expect(useWritingSpacesStore.getState().activeSpaceId).toBe(SPACE_OTHER.id);
    expect(useWritingWorkspaceStore.getState().currentFile).toBe("/other/b.md");
  });

  it("折叠空间 → unwatch 该空间", async () => {
    const bridge = makeBridge();
    renderSidebar(bridge);
    // 活跃空间 writing 自动展开 + watch
    await waitFor(() => expect(bridge.watchDir).toHaveBeenCalledWith(SPACE_DEFAULT.id, SPACE_DEFAULT.root));
    await screen.findByText("a.md");
    // 折叠 writing(点空间行)→ unwatch
    act(() => {
      fireEvent.click(screen.getByText("writing"));
    });
    await waitFor(() => expect(bridge.unwatchDir).toHaveBeenCalledWith(SPACE_DEFAULT.id));
  });
});
