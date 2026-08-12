// 写作左栏文稿列表单测：隐藏 md 后缀、双击重命名（含后缀回填）、
// 「排序与显示」菜单（排序键切换 + 显示项开关）、时间/概要渲染与排序生效。
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import { useWritingWorkspaceStore } from "@cortex-work/core/writing/workspace-store";
import { __resetWritingReviews } from "@cortex-work/core/writing/review-manager";
import { WritingSidebar } from "./WritingSidebar";

const SPACE = { id: "s1", name: "writing", root: "/space", isDefault: true };
const OLD_PATH = "/space/旧稿.md";
const NEW_PATH = "/space/新稿.md";

const tree: PromptNode = {
  name: "writing",
  path: "/space",
  kind: "dir",
  children: [
    { name: "旧稿.md", path: OLD_PATH, kind: "file" },
    { name: "新稿.md", path: NEW_PATH, kind: "file" },
    { name: "论文.pdf", path: "/space/论文.pdf", kind: "file" },
  ],
};

// 旧稿创建早、改动晚；新稿创建晚、改动早 —— 两个时间键的排序结果因此可区分。
const META = {
  [OLD_PATH]: { path: OLD_PATH, birthtimeMs: 1_000, mtimeMs: 9_000, excerpt: "旧稿的正文概要" },
  [NEW_PATH]: { path: NEW_PATH, birthtimeMs: 5_000, mtimeMs: 2_000, excerpt: "新稿的正文概要" },
};

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    scanDirTree: vi.fn(async () => tree),
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
    writingDocMeta: vi.fn(async (req: { paths: string[] }) => ({
      items: req.paths.map((p) => META[p as keyof typeof META]).filter(Boolean),
    })),
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

// 左栏文件行的展示名序列（用于断言排序结果）。
function fileNames(): string[] {
  return Array.from(document.querySelectorAll(".pw-tree-row.is-file .pw-tree-name")).map(
    (el) => el.textContent ?? "",
  );
}

afterEach(cleanup);
beforeEach(() => {
  __resetWritingReviews();
  useWritingSpacesStore.setState({
    spaces: [SPACE],
    activeSpaceId: SPACE.id,
    docSortKey: "name",
    docSortOrder: "asc",
    docShowCreatedAt: true,
    docShowExcerpt: true,
  });
  useWritingWorkspaceStore.setState({ currentFile: null });
});

describe("WritingSidebar 文稿列表", () => {
  it("文件名隐藏 md 后缀，pdf 等非编辑格式保留后缀", async () => {
    renderSidebar(makeBridge());
    expect(await screen.findByText("旧稿")).toBeTruthy();
    expect(screen.queryByText("旧稿.md")).toBeNull();
    expect(screen.getByText("论文.pdf")).toBeTruthy();
  });

  it("双击文件行弹出重命名弹窗，输入无后缀时提交自动补回 .md", async () => {
    const bridge = makeBridge();
    renderSidebar(bridge);
    fireEvent.doubleClick(await screen.findByText("旧稿"));
    // 弹窗预填去后缀名，并把保留的后缀显示在输入框右侧。
    const dialog = screen.getByRole("dialog", { name: "重命名文件" });
    const input = within(dialog).getByLabelText<HTMLInputElement>("重命名");
    expect(input.value).toBe("旧稿");
    expect(within(dialog).getByText(".md")).toBeTruthy();
    fireEvent.change(input, { target: { value: "改名后" } });
    fireEvent.click(within(dialog).getByText("确定"));
    await waitFor(() =>
      expect(bridge.renameEntry).toHaveBeenCalledWith(OLD_PATH, "/space/改名后.md"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("重命名失败时弹窗不关闭，就地显示原因供改名重试", async () => {
    // 目标名已存在 → renameNode 的重名预检拦下（fileExists 对目标路径回 true）。
    const bridge = makeBridge({ fileExists: vi.fn(async () => true) });
    renderSidebar(bridge);
    fireEvent.doubleClick(await screen.findByText("旧稿"));
    const dialog = screen.getByRole("dialog", { name: "重命名文件" });
    fireEvent.change(within(dialog).getByLabelText("重命名"), { target: { value: "新稿" } });
    fireEvent.click(within(dialog).getByText("确定"));
    expect(await within(dialog).findByText("已存在同名文件或目录")).toBeTruthy();
    expect(bridge.renameEntry).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "重命名文件" })).toBeTruthy();
  });

  it("文件行不再有编辑图标；删除按钮与标题同行", async () => {
    renderSidebar(makeBridge());
    const nameEl = await screen.findByText("旧稿");
    expect(screen.queryByLabelText("重命名 旧稿.md")).toBeNull();
    // 删除按钮与文件名在同一行容器（标题行）内，概要/时间因此能占满整行宽度。
    const head = nameEl.closest(".pw-writing-file-head")!;
    expect(within(head as HTMLElement).getByLabelText("删除 旧稿.md")).toBeTruthy();
  });

  it("显示概要与创建时间；关掉开关后不再渲染", async () => {
    renderSidebar(makeBridge());
    expect(await screen.findByText("旧稿的正文概要")).toBeTruthy();
    // 创建时间按 YYYY/MM/DD HH:mm 渲染（本地时区，断言到行内存在时间元素即可）。
    await waitFor(() =>
      expect(document.querySelectorAll(".pw-writing-file-time").length).toBe(2),
    );

    fireEvent.click(screen.getByLabelText("排序与显示"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /显示概要/ }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /显示创建时间/ }));
    await waitFor(() => expect(screen.queryByText("旧稿的正文概要")).toBeNull());
    expect(document.querySelectorAll(".pw-writing-file-time").length).toBe(0);
  });

  it("按创建时间/修改时间排序，顺序可切换升降序", async () => {
    renderSidebar(makeBridge());
    await screen.findByText("旧稿的正文概要");
    // 默认名称升序：新稿 < 旧稿（zh-Hans 本地序），pdf 也参与。
    const menuBtn = screen.getByLabelText("排序与显示");

    fireEvent.click(menuBtn);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "创建时间" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "降序" }));
    // 创建时间降序：新稿(5000) > 旧稿(1000) > 论文.pdf(无元信息→0)。
    await waitFor(() => expect(fileNames()).toEqual(["新稿", "旧稿", "论文.pdf"]));

    fireEvent.click(screen.getByRole("menuitemradio", { name: "修改时间" }));
    // 修改时间降序：旧稿(9000) > 新稿(2000) > 论文.pdf。
    await waitFor(() => expect(fileNames()).toEqual(["旧稿", "新稿", "论文.pdf"]));
  });

  it("宿主壳不支持元信息通道时，时间/概要与按时间排序整体降级", async () => {
    renderSidebar(makeBridge({ writingDocMeta: undefined }));
    await screen.findByText("旧稿");
    expect(document.querySelectorAll(".pw-writing-file-time").length).toBe(0);
    fireEvent.click(screen.getByLabelText("排序与显示"));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitemradio", { name: "创建时间" })).toBeDisabled();
    expect(within(menu).getByRole("menuitemcheckbox", { name: /显示概要/ })).toBeDisabled();
    // 名称排序不依赖元信息，始终可用。
    expect(within(menu).getByRole("menuitemradio", { name: "文件名" })).not.toBeDisabled();
  });

  it("只开名称排序且不显示时间/概要时，不发起元信息请求", async () => {
    useWritingSpacesStore.setState({ docShowCreatedAt: false, docShowExcerpt: false });
    const bridge = makeBridge();
    renderSidebar(bridge);
    await screen.findByText("旧稿");
    expect(bridge.writingDocMeta).not.toHaveBeenCalled();
  });
});
