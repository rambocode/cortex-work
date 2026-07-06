// 写作工作区整窗覆盖层 + 文件树(U4)组件测试:
// 覆盖 R4(覆盖层渲染 + 返回)、R5(树渲染 / 新建重名拒绝)、R8 树侧(删除当前文件确认)、切空间联动;
// U9 追加:完整改稿回合的端到端接线(tool 事件 → 编辑器 diff 审阅 → 裁决落盘)。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { CliStreamEvent, DesktopBridge, PromptNode } from "@cortex-work/core";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import { __resetWritingBaselines, getBaseline } from "@cortex-work/core/writing/baseline";
import {
  __resetWritingReviews,
  getPendingReview,
} from "@cortex-work/core/writing/review-manager";
import { __resetWritingRunManagerForTest } from "@cortex-work/core/writing/run/writing-run-manager";
import { __resetWritingThreadsForTest } from "@cortex-work/core/writing/threads";
import { WritingWorkspace } from "./WritingWorkspace";

// CM 内核 / Markdown / diff 视图桩:整窗集成关注编排,编辑器内核用受控 textarea 替身即可确定性驱动。
vi.mock("../personal/editor/NoteCodeMirrorEditor", () => ({
  NoteCodeMirrorEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => <textarea data-testid="cm" value={value} onChange={(e) => onChange(e.target.value)} />,
}));
vi.mock("../personal/MarkdownView", () => ({
  MarkdownView: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));
vi.mock("./WritingDiffReview", () => ({
  WritingDiffReview: ({
    baseline,
    next,
    onResolve,
  }: {
    baseline: string;
    next: string;
    onResolve: (accepted: string) => void;
  }) => (
    <div data-testid="diff">
      <span data-testid="diff-base">{baseline}</span>
      <span data-testid="diff-next">{next}</span>
      <button type="button" onClick={() => onResolve(next)}>
        accept-all
      </button>
    </div>
  ),
}));

const SPACE_A = { id: "sa", name: "alpha", root: "/w/alpha" };
const SPACE_B = { id: "sb", name: "beta", root: "/w/beta" };

// 构造两个空间各自的文件树,scanDirTree 按 root 返回不同内容以验证切空间重扫。
const treeA: PromptNode = {
  name: "alpha", path: "/w/alpha", kind: "dir",
  children: [{ name: "a1.md", path: "/w/alpha/a1.md", kind: "file" }],
};
const treeB: PromptNode = {
  name: "beta", path: "/w/beta", kind: "dir",
  children: [{ name: "b1.md", path: "/w/beta/b1.md", kind: "file" }],
};

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    scanDirTree: vi.fn(async (root: string) => (root === SPACE_B.root ? treeB : treeA)),
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
    writingWorkspaceRoot: vi.fn(async () => "/w/default"),
    // run-manager(助手面板 installWritingRuntime)与归因(WritingWorkspace)都要订阅 CLI 事件流。
    startCli: vi.fn(async () => {}),
    killCli: vi.fn(async () => {}),
    onCliEvent: vi.fn(() => () => {}),
    onCliExit: vi.fn(() => () => {}),
    ...over,
  } as unknown as DesktopBridge;
}

function renderWs(bridge: DesktopBridge): ReturnType<typeof render> {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <WritingWorkspace />
    </CoreProvider>,
  );
}

beforeEach(() => {
  // 预置两个空间(activeSpace=alpha),避免 ensureDefaultSpace 触发默认建空间。
  useWritingSpacesStore.setState({ spaces: [SPACE_A, SPACE_B], activeSpaceId: SPACE_A.id });
  useWritingWorkspaceStore.setState({ currentFile: null });
  usePersonalStore.setState({ writingOpen: true, homeOpen: false });
  // 复位写作模块级态,避免用例间串场(基线 / 审阅 / run / 会话)。
  __resetWritingBaselines();
  __resetWritingReviews();
  __resetWritingRunManagerForTest();
  __resetWritingThreadsForTest();
});
afterEach(() => cleanup());

describe("WritingWorkspace(U4)", () => {
  it("渲染覆盖层三栏 + 返回按钮调用 closeWriting", async () => {
    renderWs(makeBridge());
    // 覆盖层标题 + 左栏树内容渲染
    expect(screen.getByText("写作")).toBeTruthy();
    expect(await screen.findByText("a1.md")).toBeTruthy();
    // 点返回 → closeWriting:writingOpen 复位、homeOpen 回落
    fireEvent.click(screen.getByLabelText("返回"));
    expect(usePersonalStore.getState().writingOpen).toBe(false);
    expect(usePersonalStore.getState().homeOpen).toBe(true);
  });

  it("树渲染 scanDirTree 结果;新建重名被拒并提示", async () => {
    const bridge = makeBridge({ fileExists: vi.fn(async () => true) }); // 目标已存在
    renderWs(bridge);
    await screen.findByText("a1.md");
    // 打开新建文件输入,输入一个已存在的名字并提交
    fireEvent.click(screen.getByLabelText("新建文件"));
    const input = screen.getByLabelText("新建文件名");
    fireEvent.change(input, { target: { value: "dup.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // toast 提示重名,且未写盘
    expect(await screen.findByText("已存在同名文件或目录")).toBeTruthy();
    expect(bridge.writeFile).not.toHaveBeenCalled();
  });

  it("新建文件成功 → 写空文件并打开", async () => {
    const bridge = makeBridge();
    renderWs(bridge);
    await screen.findByText("a1.md");
    fireEvent.click(screen.getByLabelText("新建文件"));
    const input = screen.getByLabelText("新建文件名");
    fireEvent.change(input, { target: { value: "fresh.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(bridge.writeFile).toHaveBeenCalledWith("/w/alpha/fresh.md", ""));
    await waitFor(() => expect(useWritingWorkspaceStore.getState().currentFile).toBe("/w/alpha/fresh.md"));
  });

  it("删除当前打开文件触发确认;确认后 currentFile 清空(deleted 信号)", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const bridge = makeBridge();
    renderWs(bridge);
    const row = await screen.findByText("a1.md");
    // 删除该文件(行内删除按钮 aria-label 含文件名)
    fireEvent.click(screen.getByLabelText("删除 a1.md"));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(bridge.deleteEntry).toHaveBeenCalledWith("/w/alpha/a1.md"));
    await waitFor(() => expect(useWritingWorkspaceStore.getState().currentFile).toBeNull());
    expect(row).toBeTruthy();
    confirmSpy.mockRestore();
  });

  it("删除当前文件时用户取消确认 → 不删除", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const bridge = makeBridge();
    renderWs(bridge);
    await screen.findByText("a1.md");
    fireEvent.click(screen.getByLabelText("删除 a1.md"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(bridge.deleteEntry).not.toHaveBeenCalled();
    expect(useWritingWorkspaceStore.getState().currentFile).toBe("/w/alpha/a1.md");
    confirmSpy.mockRestore();
  });

  it("切空间:重扫树 + watch 新根 / unwatch 旧根", async () => {
    const bridge = makeBridge();
    renderWs(bridge);
    // 初始订阅 alpha
    await waitFor(() => expect(bridge.watchDir).toHaveBeenCalledWith(SPACE_A.id, SPACE_A.root));
    await screen.findByText("a1.md");
    // 切到 beta
    fireEvent.change(screen.getByLabelText("写作空间"), { target: { value: SPACE_B.id } });
    await screen.findByText("b1.md"); // 树切换为 beta
    expect(bridge.scanDirTree).toHaveBeenCalledWith(SPACE_B.root);
    await waitFor(() => expect(bridge.watchDir).toHaveBeenCalledWith(SPACE_B.id, SPACE_B.root));
    expect(bridge.unwatchDir).toHaveBeenCalledWith(SPACE_A.id);
    expect(useWritingSpacesStore.getState().activeSpaceId).toBe(SPACE_B.id);
  });

  // U9 端到端:模拟 WritingWorkspace 的归因接线闭环。
  it("完整回合:agent tool 写盘 → 编辑器进入 diff 审阅 → 全部接受落盘", async () => {
    const FILE = "/w/alpha/a1.md";
    useWritingWorkspaceStore.setState({ currentFile: FILE });
    // 内存盘 + 收集所有 onCliEvent 订阅者(run-manager 与归因各订阅一次),emit 时全部投递。
    const files: Record<string, string> = { [FILE]: "v1" };
    const cliSubs: ((runId: string, ev: CliStreamEvent) => void)[] = [];
    const emit = (runId: string, ev: CliStreamEvent): void => {
      act(() => {
        for (const cb of cliSubs) cb(runId, ev);
      });
    };
    const bridge = makeBridge({
      readFile: vi.fn(async (p: string) => ({ content: files[p] ?? "", truncated: false })),
      writeFile: vi.fn(async (p: string, c: string) => {
        files[p] = c;
      }),
      onCliEvent: vi.fn((cb: (runId: string, ev: CliStreamEvent) => void) => {
        cliSubs.push(cb);
        return () => {};
      }),
    });
    renderWs(bridge);

    // 编辑器加载 v1 → 建立基线(= 发送前盘面)。
    await screen.findByTestId("cm");
    await waitFor(() => expect(getBaseline(FILE)?.content).toBe("v1"));

    // agent 用 Edit 工具改盘:先落盘 v2,再发 tool 事件(命中当前文件)。
    files[FILE] = "agent-v2";
    emit("writing:sa:r1", {
      type: "tool",
      name: "Edit",
      phase: "start",
      input: { file_path: FILE },
    });

    // 编辑器让位给 diff 视图,基线 v1 / 新版 v2。
    await screen.findByTestId("diff");
    expect(screen.getByTestId("diff-base").textContent).toBe("v1");
    expect(screen.getByTestId("diff-next").textContent).toBe("agent-v2");
    expect(getPendingReview(FILE)?.origin).toBe("agent");

    // 全部接受 → 落盘新版、推进基线、清 pending。
    fireEvent.click(screen.getByRole("button", { name: "accept-all" }));
    await waitFor(() => expect(bridge.writeFile).toHaveBeenCalledWith(FILE, "agent-v2"));
    await waitFor(() => expect(getPendingReview(FILE)).toBeUndefined());
    expect(getBaseline(FILE)?.content).toBe("agent-v2");
  });
});
