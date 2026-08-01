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
// CM 桩:受控 textarea + 两个按钮驱动 onSelectionChange(jsdom 下无法真跑 CM 选区,用桩确定性触发)。
vi.mock("../personal/editor/NoteCodeMirrorEditor", () => ({
  NoteCodeMirrorEditor: ({
    value,
    onChange,
    onSelectionChange,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSelectionChange?: (sel: { text: string; from: number; to: number; startLine: number; endLine: number } | null) => void;
  }) => (
    <div>
      <textarea data-testid="cm" value={value} onChange={(e) => onChange(e.target.value)} />
      <button
        type="button"
        data-testid="cm-select"
        onClick={() => onSelectionChange?.({ text: "选中段", from: 0, to: 3, startLine: 1, endLine: 1 })}
      >
        select
      </button>
      <button type="button" data-testid="cm-deselect" onClick={() => onSelectionChange?.(null)}>
        deselect
      </button>
    </div>
  ),
}));
vi.mock("../personal/markdown/MarkdownView", () => ({
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
  // 预置两个空间(activeSpace=alpha),避免 ensureDefaultSpace 触发默认建空间;复位视图偏好。
  useWritingSpacesStore.setState({
    spaces: [SPACE_A, SPACE_B],
    activeSpaceId: SPACE_A.id,
    previewMode: "live",
    fontSizePx: 16,
    fontPreset: "system",
    customFontFamily: "",
    lineHeight: 1.75,
  });
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
    // 通栏设计:无横跨顶栏;返回按钮在左栏贴顶条,左栏树内容渲染。
    expect(screen.getByLabelText("返回")).toBeTruthy();
    expect(await screen.findByText("a1.md")).toBeTruthy();
    // 点返回 → closeWriting:writingOpen 复位、homeOpen 回落
    fireEvent.click(screen.getByLabelText("返回"));
    expect(usePersonalStore.getState().writingOpen).toBe(false);
    expect(usePersonalStore.getState().homeOpen).toBe(true);
  });

  it("顶部「新建文件」→ 在活跃空间根建 untitled.md 并打开", async () => {
    const bridge = makeBridge();
    renderWs(bridge);
    await screen.findByText("a1.md"); // 活跃空间 alpha 自动展开
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    await waitFor(() => expect(bridge.writeFile).toHaveBeenCalledWith("/w/alpha/untitled.md", ""));
    await waitFor(() =>
      expect(useWritingWorkspaceStore.getState().currentFile).toBe("/w/alpha/untitled.md"),
    );
  });

  it("删除当前打开文件触发确认;确认后 currentFile 清空(deleted 信号)", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const bridge = makeBridge();
    renderWs(bridge);
    // 等左栏树渲染(文件名同时出现在顶栏,故用行内删除按钮 aria-label 定位,避免多匹配)。
    await screen.findByLabelText("删除 a1.md");
    fireEvent.click(screen.getByLabelText("删除 a1.md"));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(bridge.deleteEntry).toHaveBeenCalledWith("/w/alpha/a1.md"));
    await waitFor(() => expect(useWritingWorkspaceStore.getState().currentFile).toBeNull());
    confirmSpy.mockRestore();
  });

  it("删除当前文件时用户取消确认 → 不删除", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const bridge = makeBridge();
    renderWs(bridge);
    await screen.findByLabelText("删除 a1.md");
    fireEvent.click(screen.getByLabelText("删除 a1.md"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(bridge.deleteEntry).not.toHaveBeenCalled();
    expect(useWritingWorkspaceStore.getState().currentFile).toBe("/w/alpha/a1.md");
    confirmSpy.mockRestore();
  });

  it("展开非活跃空间:扫描 + watch 其根;点其文件切活跃空间;折叠 → unwatch", async () => {
    const bridge = makeBridge();
    renderWs(bridge);
    // 活跃空间 alpha 自动展开 → 扫描 + watch
    await waitFor(() => expect(bridge.watchDir).toHaveBeenCalledWith(SPACE_A.id, SPACE_A.root));
    await screen.findByText("a1.md");
    // 展开 beta(点其空间行,标题=空间名)→ 扫描 + watch beta;两空间同时展开
    fireEvent.click(screen.getByText("beta"));
    await screen.findByText("b1.md");
    expect(bridge.scanDirTree).toHaveBeenCalledWith(SPACE_B.root);
    await waitFor(() => expect(bridge.watchDir).toHaveBeenCalledWith(SPACE_B.id, SPACE_B.root));
    // alpha 仍展开 → 未被 unwatch
    expect(bridge.unwatchDir).not.toHaveBeenCalledWith(SPACE_A.id);
    // 点 beta 的文件 → 切活跃空间 + 打开
    fireEvent.click(screen.getByText("b1.md"));
    expect(useWritingSpacesStore.getState().activeSpaceId).toBe(SPACE_B.id);
    expect(useWritingWorkspaceStore.getState().currentFile).toBe("/w/beta/b1.md");
    // 折叠 beta(再点其空间行)→ unwatch beta
    fireEvent.click(screen.getByText("beta"));
    await waitFor(() => expect(bridge.unwatchDir).toHaveBeenCalledWith(SPACE_B.id));
  });

  it("排版设置 → 中栏 CSS 变量(字号/字体/行距)生效", async () => {
    useWritingSpacesStore.setState({
      fontSizePx: 20,
      fontPreset: "kaiti",
      customFontFamily: "",
      lineHeight: 2.0,
    });
    const { container } = renderWs(makeBridge());
    const center = container.querySelector(".pw-writing-center") as HTMLElement;
    expect(center.style.getPropertyValue("--pw-writing-font-size")).toBe("20px");
    expect(center.style.getPropertyValue("--pw-writing-font-family")).toContain("KaiTi");
    expect(center.style.getPropertyValue("--pw-writing-line-height")).toBe("2");
  });

  it("编辑器选区上报 → 助手面板选区 chip 条出现(含 edit 类指令);取消选区后消失(R11)", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    renderWs(makeBridge());
    await screen.findByTestId("cm");
    // 空态收敛为固定三卡(对齐 Kun):无选区时选区类指令(重新格式化)无入口。
    expect(screen.queryByText("重新格式化")).not.toBeInTheDocument();
    // 上报选区 → 选区 chip 条出现,edit 类指令可点。
    fireEvent.click(screen.getByTestId("cm-select"));
    await waitFor(() => expect(screen.getByText("重新格式化")).toBeInTheDocument());
    expect(screen.getByText("重新格式化").closest("button")!).not.toBeDisabled();
    // 取消选区 → chip 条整体消失。
    fireEvent.click(screen.getByTestId("cm-deselect"));
    await waitFor(() => expect(screen.queryByText("重新格式化")).not.toBeInTheDocument());
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

describe("WritingWorkspace 中栏工具栏", () => {
  it("折叠左栏:点折叠按钮 → 左栏隐藏,按钮切「展开侧栏」", async () => {
    const { container } = renderWs(makeBridge());
    await screen.findByLabelText("删除 a1.md"); // 左栏已渲染
    expect(container.querySelector(".pw-writing-left.is-collapsed")).toBeNull();
    fireEvent.click(screen.getByLabelText("折叠侧栏"));
    expect(container.querySelector(".pw-writing-left.is-collapsed")).not.toBeNull();
    expect(screen.getByLabelText("展开侧栏")).toBeTruthy();
  });

  // 折叠按钮归属:展开态在左栏(紧跟返回),折叠态才由中栏顶栏接管——
  // 因为 .pw-writing-left.is-collapsed 是 display:none,按钮不能只放左栏,否则展不开。
  it("折叠按钮在左栏返回按钮右边;折叠后展开入口移到中栏顶栏", async () => {
    const { container } = renderWs(makeBridge());
    await screen.findByLabelText("删除 a1.md");

    // 展开态:折叠按钮在左栏 titlebar 内,且排在返回按钮之后。
    const bar = container.querySelector(".pw-writing-left-titlebar")!;
    const btns = Array.from(bar.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(btns).toEqual(["返回", "折叠侧栏"]);
    // 展开态中栏顶栏不再重复放这个按钮。
    expect(container.querySelector(".pw-wt-left .pw-wt-icon-btn")).toBeNull();

    // 折叠后左栏整条隐藏 → 展开入口须出现在中栏顶栏。
    fireEvent.click(screen.getByLabelText("折叠侧栏"));
    expect(container.querySelector(".pw-wt-left .pw-wt-icon-btn")).not.toBeNull();
    expect(screen.getByLabelText("展开侧栏")).toBeTruthy();
  });

  it("视图模式下拉切换 → 持久化到 store", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    renderWs(makeBridge());
    await screen.findByTestId("cm");
    fireEvent.click(screen.getByTitle(/^视图模式：/));
    fireEvent.click(screen.getByRole("menuitem", { name: "源码" }));
    expect(useWritingSpacesStore.getState().previewMode).toBe("source");
  });

  // 顶栏三条精简（用户实测反馈）：标题不重复、文件名前无图标、模式触发器只留图标。
  it("顶栏:文件名只出现一次(路径与文件名相同时省略),文件名前无图标", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    const { container } = renderWs(makeBridge());
    await screen.findByTestId("cm");

    // a1.md 就在空间根下 → 相对路径等于文件名,那行小字应省略,整个顶栏只出现一次。
    const head = container.querySelector(".pw-wt-left")!;
    expect(head.textContent?.match(/a1\.md/g) ?? []).toHaveLength(1);
    expect(container.querySelector(".pw-wt-file-path")).toBeNull();
    expect(container.querySelector(".pw-wt-file-icon")).toBeNull();
  });

  it("顶栏:模式触发器只显示图标,档名在展开的菜单项里", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    const { container } = renderWs(makeBridge());
    await screen.findByTestId("cm");

    // 不绑定具体档（默认档随实现变,rich 档还渲染 tiptap 而非 CodeMirror）：
    // 从 title 里取出当前档名，再断言 pill 正文里没有它。
    const pill = container.querySelector(".pw-wt-mode-pill")!;
    const label = pill.getAttribute("title")!.replace("视图模式：", "");
    expect(label).toBeTruthy(); // title 仍带档名,不靠图标形状传达语义
    expect(pill.textContent).not.toContain(label);

    // 展开后菜单项是 icon + 文字。
    fireEvent.click(pill);
    expect(screen.getByRole("menuitem", { name: new RegExp(label) })).toBeTruthy();
  });

  it("字号步进:增大/减小改 store,边界禁用", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    renderWs(makeBridge());
    await screen.findByTestId("cm");
    // 默认 16 → 增大到 17
    fireEvent.click(screen.getByLabelText("增大字号"));
    expect(useWritingSpacesStore.getState().fontSizePx).toBe(17);
    // 拉到上界 48:增大按钮禁用
    act(() => useWritingSpacesStore.setState({ fontSizePx: 48 }));
    expect(screen.getByLabelText("增大字号")).toBeDisabled();
    // 拉到下界 10:减小按钮禁用
    act(() => useWritingSpacesStore.setState({ fontSizePx: 10 }));
    expect(screen.getByLabelText("减小字号")).toBeDisabled();
  });

  it("手动保存:编辑后点保存立即落盘(flush)", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    const bridge = makeBridge();
    renderWs(bridge);
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    fireEvent.change(cm, { target: { value: "手动保存内容" } });
    fireEvent.click(screen.getByLabelText("保存"));
    await waitFor(() =>
      expect(bridge.writeFile).toHaveBeenCalledWith("/w/alpha/a1.md", "手动保存内容"),
    );
  });

  it("字数统计:去空白后按字符计(顶栏 badge)", async () => {
    useWritingWorkspaceStore.setState({ currentFile: "/w/alpha/a1.md" });
    renderWs(makeBridge());
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    fireEvent.change(cm, { target: { value: "a b c" } }); // 去空白 → "abc" = 3
    await waitFor(() => expect(screen.getByText("字数 3")).toBeTruthy());
  });

  it("无打开文件:顶栏显示占位名与「尚未打开文件」", () => {
    renderWs(makeBridge());
    expect(screen.getByText("写作台")).toBeTruthy();
    expect(screen.getByText("尚未打开文件")).toBeTruthy();
  });
});
