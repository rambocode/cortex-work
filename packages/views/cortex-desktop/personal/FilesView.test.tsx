import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import { FilesView } from "./FilesView";

const NOW = Date.now();

const EMPTY_TREE: PromptNode = { kind: "dir", name: "alpha", path: "/code/alpha", children: [] };

const TREE: PromptNode = {
  kind: "dir",
  name: "alpha",
  path: "/code/alpha",
  children: [
    { kind: "file", name: "readme.md", path: "/code/alpha/readme.md" },
    {
      kind: "dir",
      name: "src",
      path: "/code/alpha/src",
      children: [
        { kind: "file", name: "app.ts", path: "/code/alpha/src/app.ts" },
        { kind: "file", name: "util.ts", path: "/code/alpha/src/util.ts" },
      ],
    },
  ],
};

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    scanDirTree: vi.fn().mockResolvedValue(EMPTY_TREE),
    readFile: vi.fn().mockResolvedValue({ content: "# Hello", truncated: false }),
    ...over,
  } as unknown as DesktopBridge;
}

function renderView(bridge: DesktopBridge, onToast: (t: string) => void = () => {}) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <FilesView onToast={onToast} />
    </CoreProvider>,
  );
}

describe("FilesView 消费 filePreviewRequest", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      activeProjectId: "p1",
      filePreviewRequest: undefined,
    });
  });

  it("项目匹配 → readFile(abs) 并渲染预览,请求被消费清空", async () => {
    const bridge = makeBridge();
    usePersonalStore.setState({
      filePreviewRequest: { projectId: "p1", path: "/code/alpha/docs/a.md", name: "a.md" },
    });
    renderView(bridge);
    // .md 走 MarkdownView,断言渲染出标题文本。
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(bridge.readFile).toHaveBeenCalledWith("/code/alpha/docs/a.md");
    expect(usePersonalStore.getState().filePreviewRequest).toBeUndefined();
  });

  it("项目不匹配 → 不消费、不调 readFile", async () => {
    const bridge = makeBridge();
    usePersonalStore.setState({
      filePreviewRequest: { projectId: "p2", path: "/code/beta/x.md", name: "x.md" },
    });
    renderView(bridge);
    // 等挂载 effect 跑完(scanDirTree 被调用)后再断言未读文件。
    await waitFor(() => expect(bridge.scanDirTree).toHaveBeenCalled());
    expect(bridge.readFile).not.toHaveBeenCalled();
    expect(usePersonalStore.getState().filePreviewRequest).toEqual({
      projectId: "p2",
      path: "/code/beta/x.md",
      name: "x.md",
    });
  });

  it("非文本文件名(.png) → 系统默认应用打开,不调 readFile、不进内置预览", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    const bridge = makeBridge({ openPath });
    usePersonalStore.setState({
      filePreviewRequest: { projectId: "p1", path: "/code/alpha/logo.png", name: "logo.png" },
    });
    renderView(bridge);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/code/alpha/logo.png"));
    expect(bridge.readFile).not.toHaveBeenCalled();
  });

  it("office 文档(.xlsx) → 系统默认应用打开,不调 readFile", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    const bridge = makeBridge({ openPath });
    usePersonalStore.setState({
      filePreviewRequest: { projectId: "p1", path: "/code/alpha/outputs/monthly.xlsx", name: "monthly.xlsx" },
    });
    renderView(bridge);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/code/alpha/outputs/monthly.xlsx"));
    expect(bridge.readFile).not.toHaveBeenCalled();
  });

  it("readFile 抛错 → onToast 读取失败提示", async () => {
    const bridge = makeBridge({ readFile: vi.fn().mockRejectedValue(new Error("EACCES")) });
    const onToast = vi.fn();
    usePersonalStore.setState({
      filePreviewRequest: { projectId: "p1", path: "/code/alpha/secret.txt", name: "secret.txt" },
    });
    renderView(bridge, onToast);
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("读取失败")));
  });
});

describe("FilesView 搜索/过滤", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      activeProjectId: "p1",
      filePreviewRequest: undefined,
    });
  });

  it("输入文件名 → 文件树按名过滤,匹配目录展开,无关文件不渲染", async () => {
    const bridge = makeBridge({ scanDirTree: vi.fn().mockResolvedValue(TREE) });
    renderView(bridge);
    // 初始全量渲染。
    expect(await screen.findByText("readme.md")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Filter files/), { target: { value: "app" } });

    // 命中 app.ts（src 目录因含匹配后代被保留并强制展开）;util.ts / readme.md 被过滤掉。
    expect(await screen.findByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.queryByText("util.ts")).not.toBeInTheDocument();
    expect(screen.queryByText("readme.md")).not.toBeInTheDocument();
  });

  it("无匹配文件名 → 显示空提示", async () => {
    const bridge = makeBridge({ scanDirTree: vi.fn().mockResolvedValue(TREE) });
    renderView(bridge);
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Filter files/), { target: { value: "zzzznope" } });
    expect(await screen.findByText("没有匹配的文件")).toBeInTheDocument();
  });

  it("? 前缀 → 调 searchContent,渲染命中文件与命中行,点击打开预览", async () => {
    const searchContent = vi.fn().mockResolvedValue({
      files: [
        { path: "/code/alpha/src/app.ts", rel: "src/app.ts", name: "app.ts", lines: [{ line: 3, text: "const foo = 1;" }] },
      ],
      truncated: false,
    });
    const readFile = vi.fn().mockResolvedValue({ content: "const foo = 1;", truncated: false });
    const bridge = makeBridge({ scanDirTree: vi.fn().mockResolvedValue(TREE), searchContent, readFile });
    renderView(bridge);
    await screen.findByText("readme.md");

    fireEvent.change(screen.getByPlaceholderText(/Filter files/), { target: { value: "?foo" } });

    await waitFor(() => expect(searchContent).toHaveBeenCalledWith("/code/alpha", "foo"));
    expect(await screen.findByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("const foo = 1;")).toBeInTheDocument();

    fireEvent.click(screen.getByText("src/app.ts"));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("/code/alpha/src/app.ts"));
  });

  it("? 内容搜索无命中 → 显示无匹配提示", async () => {
    const searchContent = vi.fn().mockResolvedValue({ files: [], truncated: false });
    const bridge = makeBridge({ scanDirTree: vi.fn().mockResolvedValue(TREE), searchContent });
    renderView(bridge);
    await screen.findByText("readme.md");
    fireEvent.change(screen.getByPlaceholderText(/Filter files/), { target: { value: "?nope" } });
    await waitFor(() => expect(searchContent).toHaveBeenCalledWith("/code/alpha", "nope"));
    expect(await screen.findByText(/没有匹配/)).toBeInTheDocument();
  });
});
