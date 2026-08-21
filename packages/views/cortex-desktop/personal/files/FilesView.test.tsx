import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import { FilesView } from "./FilesView";

vi.mock("docx-preview", () => ({
  renderAsync: vi.fn(async (_bytes: ArrayBuffer, body: HTMLElement) => {
    body.innerHTML = "<p>DOCX 预览正文</p>";
    return {};
  }),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: vi.fn(async () => ({
        getViewport: () => ({ width: 600, height: 800 }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      })),
      destroy: vi.fn(),
    }),
  })),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "pdf-worker.mjs" }));

vi.mock("@aiden0z/pptx-renderer", () => ({
  RECOMMENDED_ZIP_LIMITS: {},
  PptxViewer: {
    open: vi.fn(async (_bytes: ArrayBuffer, body: HTMLElement) => {
      body.textContent = "PPTX 预览正文";
      return { slideCount: 1, destroy: vi.fn(), goToSlide: vi.fn(), setZoom: vi.fn(), setFitMode: vi.fn() };
    }),
  },
}));

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
      panelRequest: undefined,
    });
  });

  it("项目匹配 → readFile(abs) 并渲染预览,请求被消费清空;.md 默认渲染预览(MarkdownView)", async () => {
    const bridge = makeBridge();
    usePersonalStore.setState({
      panelRequest: { panelId: "files", payload: { kind: "filePreview", projectId: "p1", path: "/code/alpha/docs/a.md", name: "a.md" }, nonce: 1 },
    });
    const { container } = renderView(bridge);
    await waitFor(() => expect(bridge.readFile).toHaveBeenCalledWith("/code/alpha/docs/a.md"));
    // .md 默认渲染预览(editMode=false → MarkdownView),点「编辑」才进 Monaco。
    await waitFor(() => expect(container.querySelector(".pw-file-md")).not.toBeNull());
    expect(container.querySelector(".pw-mona-wrap")).toBeNull();
    expect(usePersonalStore.getState().panelRequest).toBeUndefined();
  });

  it("预览工具栏收敛:低频动作(复制/打开/访达)在 ⋯ 菜单里,点「打开」走系统应用", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    const revealInFolder = vi.fn().mockResolvedValue(undefined);
    const bridge = makeBridge({ openPath, revealInFolder });
    usePersonalStore.setState({
      panelRequest: { panelId: "files", payload: { kind: "filePreview", projectId: "p1", path: "/code/alpha/docs/a.md", name: "a.md" }, nonce: 2 },
    });
    renderView(bridge);
    await waitFor(() => expect(bridge.readFile).toHaveBeenCalled());
    // 工具栏只留「编辑」与 ⋯;原独立按钮不再直接可见。
    expect(screen.getByTitle("编辑文件")).toBeInTheDocument();
    expect(screen.queryByTitle("用系统默认应用打开")).toBeNull();
    fireEvent.click(screen.getByTitle("更多"));
    // 菜单展开后包含四个低频动作,点「打开」调 openPath 并收起菜单。
    expect(screen.getByRole("menuitem", { name: /复制内容/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /复制路径/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /在访达中显示/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /打开/ }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/code/alpha/docs/a.md"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("项目不匹配 → 不消费、不调 readFile", async () => {
    const bridge = makeBridge();
    usePersonalStore.setState({
      panelRequest: { panelId: "files", payload: { kind: "filePreview", projectId: "p2", path: "/code/beta/x.md", name: "x.md" }, nonce: 3 },
    });
    renderView(bridge);
    // 等挂载 effect 跑完(scanDirTree 被调用)后再断言未读文件。
    await waitFor(() => expect(bridge.scanDirTree).toHaveBeenCalled());
    expect(bridge.readFile).not.toHaveBeenCalled();
    expect((usePersonalStore.getState().panelRequest?.payload as Record<string, unknown> | undefined)).toEqual({
      kind: "filePreview",
      projectId: "p2",
      path: "/code/beta/x.md",
      name: "x.md",
    });
  });

  it("非文本文件名(.png) → 系统默认应用打开,不调 readFile、不进内置预览", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    const bridge = makeBridge({ openPath });
    usePersonalStore.setState({
      panelRequest: { panelId: "files", payload: { kind: "filePreview", projectId: "p1", path: "/code/alpha/logo.png", name: "logo.png" }, nonce: 4 },
    });
    renderView(bridge);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/code/alpha/logo.png"));
    expect(bridge.readFile).not.toHaveBeenCalled();
  });

  it("xlsx 但无二进制桥(web/旧壳) → 回退系统默认应用打开,不调 readFile", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    const bridge = makeBridge({ openPath });
    usePersonalStore.setState({
      panelRequest: { panelId: "files", payload: { kind: "filePreview", projectId: "p1", path: "/code/alpha/outputs/monthly.xlsx", name: "monthly.xlsx" }, nonce: 5 },
    });
    renderView(bridge);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith("/code/alpha/outputs/monthly.xlsx"));
    expect(bridge.readFile).not.toHaveBeenCalled();
  });

  it("xlsx 且有二进制桥 → 进内置表格预览(readFileBinary),不再系统打开", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    // 无效 xlsx 字节:SheetViewer 解析失败降级为错误占位,但读取路径已走二进制通道。
    const readFileBinary = vi.fn().mockResolvedValue({ data: "AAAA", truncated: false, size: 3, mtimeMs: 1 });
    const bridge = makeBridge({ openPath, readFileBinary });
    usePersonalStore.setState({
      panelRequest: { panelId: "files", payload: { kind: "filePreview", projectId: "p1", path: "/code/alpha/outputs/monthly.xlsx", name: "monthly.xlsx" }, nonce: 6 },
    });
    renderView(bridge);
    await waitFor(() => expect(readFileBinary).toHaveBeenCalledWith("/code/alpha/outputs/monthly.xlsx"));
    expect(openPath).not.toHaveBeenCalled();
    expect(bridge.readFile).not.toHaveBeenCalled();
  });

  it("docx 且有二进制桥 → 进内置 Word 预览,不再系统打开或按文本读取", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    const readFileBinary = vi.fn().mockResolvedValue({
      data: "UEsDBA==",
      truncated: false,
      size: 4,
      mtimeMs: 1,
    });
    const bridge = makeBridge({ openPath, readFileBinary });
    usePersonalStore.setState({
      panelRequest: { panelId: "files", payload: { kind: "filePreview", projectId: "p1", path: "/code/alpha/outputs/report.docx", name: "report.docx" }, nonce: 7 },
    });

    renderView(bridge);

    expect(await screen.findByText("DOCX 预览正文")).toBeInTheDocument();
    expect(readFileBinary).toHaveBeenCalledWith("/code/alpha/outputs/report.docx");
    expect(openPath).not.toHaveBeenCalled();
    expect(bridge.readFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  it.each([
    ["PDF", "/code/alpha/outputs/report.pdf", "report.pdf"],
    ["PPTX", "/code/alpha/outputs/slides.pptx", "slides.pptx"],
  ])("%s 且有二进制桥 → 进入内置只读预览", async (label, path, name) => {
    const openPath = vi.fn().mockResolvedValue("");
    const readFileBinary = vi.fn().mockResolvedValue({
      data: label === "PDF" ? "JVBERi0xLjQ=" : "UEsDBA==",
      truncated: false,
      size: 8,
      mtimeMs: 1,
    });
    const bridge = makeBridge({ openPath, readFileBinary });
    usePersonalStore.setState({
      panelRequest: { panelId: "files", payload: { kind: "filePreview", projectId: "p1", path, name }, nonce: 8 },
    });

    renderView(bridge);

    expect(await screen.findByLabelText(new RegExp(`${name}.*预览`))).toBeInTheDocument();
    expect(readFileBinary).toHaveBeenCalledWith(path);
    expect(openPath).not.toHaveBeenCalled();
    expect(bridge.readFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
  });

  it("readFile 抛错 → onToast 读取失败提示", async () => {
    const bridge = makeBridge({ readFile: vi.fn().mockRejectedValue(new Error("EACCES")) });
    const onToast = vi.fn();
    usePersonalStore.setState({
      panelRequest: { panelId: "files", payload: { kind: "filePreview", projectId: "p1", path: "/code/alpha/secret.txt", name: "secret.txt" }, nonce: 9 },
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
      panelRequest: undefined,
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
