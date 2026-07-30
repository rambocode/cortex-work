import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@cortex-work/core";
import { DocxViewer } from "./DocxViewer";

const { renderAsync } = vi.hoisted(() => ({
  renderAsync: vi.fn(),
}));

vi.mock("docx-preview", () => ({ renderAsync }));

const DOCS = {
  report: { path: "/docs/report.docx", name: "report.docx" },
  large: { path: "/docs/large.docx", name: "large.docx" },
  broken: { path: "/docs/broken.docx", name: "broken.docx" },
  links: { path: "/docs/links.docx", name: "links.docx" },
} as const;

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    readFileBinary: vi.fn().mockResolvedValue({
      data: "UEsDBA==",
      truncated: false,
      size: 4,
      mtimeMs: 1,
    }),
    openPath: vi.fn().mockResolvedValue(""),
    openExternal: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as DesktopBridge;
}

describe("DocxViewer", () => {
  beforeEach(() => {
    renderAsync.mockReset();
    renderAsync.mockImplementation(async (_bytes: ArrayBuffer, body: HTMLElement) => {
      body.innerHTML = '<section class="cortex-docx">预览正文</section>';
      return {};
    });
  });

  afterEach(cleanup);

  it("读取二进制并以安全选项渲染 DOCX", async () => {
    const bridge = makeBridge();
    render(<DocxViewer filePath={DOCS.report.path} fileName={DOCS.report.name} bridge={bridge} />);

    expect(screen.getByText("Word 文档加载中…")).toBeInTheDocument();
    expect(await screen.findByText("预览正文")).toBeInTheDocument();
    expect(bridge.readFileBinary).toHaveBeenCalledWith("/docs/report.docx");
    expect(renderAsync).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.any(HTMLElement),
      expect.any(HTMLElement),
      expect.objectContaining({
        className: "cortex-docx",
        renderAltChunks: false,
        renderComments: false,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
        useBase64URL: true,
      }),
    );
  });

  it("文件超过二进制预览上限时给出系统打开恢复动作", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    const bridge = makeBridge({
      openPath,
      readFileBinary: vi.fn().mockResolvedValue({
        data: null,
        truncated: true,
        size: 26 * 1024 * 1024,
        mtimeMs: 1,
      }),
    });

    render(<DocxViewer filePath={DOCS.large.path} fileName={DOCS.large.name} bridge={bridge} />);

    expect(await screen.findByText("文件过大，无法在应用内预览")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "用系统应用打开" }));
    expect(openPath).toHaveBeenCalledWith("/docs/large.docx");
    expect(renderAsync).not.toHaveBeenCalled();
  });

  it("解析失败后显示错误并可重试", async () => {
    renderAsync.mockRejectedValueOnce(new Error("invalid zip"));
    const bridge = makeBridge();

    render(<DocxViewer filePath={DOCS.broken.path} fileName={DOCS.broken.name} bridge={bridge} />);

    expect(await screen.findByText("Word 文档预览失败")).toBeInTheDocument();
    expect(screen.getByText("invalid zip")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("预览正文")).toBeInTheDocument();
    await waitFor(() => expect(bridge.readFileBinary).toHaveBeenCalledTimes(2));
  });

  it("只允许 http/https 链接交给系统浏览器", async () => {
    renderAsync.mockImplementation(async (_bytes: ArrayBuffer, body: HTMLElement) => {
      body.innerHTML = [
        '<a href="https://example.com">官网</a>',
        '<a href="file:///etc/passwd">本地文件</a>',
        '<a href="#internal">文档内锚点</a>',
      ].join("");
      return {};
    });
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const bridge = makeBridge({ openExternal });

    render(<DocxViewer filePath={DOCS.links.path} fileName={DOCS.links.name} bridge={bridge} />);

    fireEvent.click(await screen.findByRole("link", { name: "官网" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");

    fireEvent.click(screen.getByRole("link", { name: "本地文件" }));
    expect(openExternal).toHaveBeenCalledTimes(1);

    const hashClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    expect(screen.getByRole("link", { name: "文档内锚点" }).dispatchEvent(hashClick)).toBe(false);
  });

  it("默认适合宽度并提供 50%–150% 的缩放控制", async () => {
    const bridge = makeBridge();
    render(<DocxViewer filePath={DOCS.report.path} fileName={DOCS.report.name} bridge={bridge} />);

    await screen.findByText("预览正文");
    const fit = await screen.findByRole("button", { name: "适合宽度" });
    expect(fit).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("100%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByText("110%")).toBeInTheDocument();
    expect(fit).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(fit);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(fit).toHaveAttribute("aria-pressed", "true");
  });
});
