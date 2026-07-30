import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@cortex-work/core";
import { PptxViewer } from "./PptxViewer";

const { openPresentation, goToSlide, setZoom, setFitMode, destroyViewer, recommendedZipLimits } = vi.hoisted(() => ({
  openPresentation: vi.fn(),
  goToSlide: vi.fn(),
  setZoom: vi.fn(),
  setFitMode: vi.fn(),
  destroyViewer: vi.fn(),
  recommendedZipLimits: { maxEntries: 4000 },
}));

vi.mock("@aiden0z/pptx-renderer", () => ({
  PptxViewer: { open: openPresentation },
  RECOMMENDED_ZIP_LIMITS: recommendedZipLimits,
}));

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    readFileBinary: vi.fn().mockResolvedValue({
      data: "UEsDBA==",
      truncated: false,
      size: 4,
      mtimeMs: 1,
    }),
    openPath: vi.fn().mockResolvedValue(""),
    ...over,
  } as unknown as DesktopBridge;
}

const PPTX_FILES = {
  report: { path: "/slides/report.pptx", name: "report.pptx" },
  broken: { path: "/slides/broken.pptx", name: "broken.pptx" },
  links: { path: "/slides/links.pptx", name: "links.pptx" },
} as const;

describe("PptxViewer", () => {
  beforeEach(() => {
    openPresentation.mockReset();
    goToSlide.mockReset().mockResolvedValue(undefined);
    setZoom.mockReset().mockResolvedValue(undefined);
    setFitMode.mockReset().mockResolvedValue(undefined);
    destroyViewer.mockReset();
    openPresentation.mockImplementation(async (_bytes: ArrayBuffer, container: HTMLElement) => {
      container.textContent = "季度汇报";
      return {
        slideCount: 3,
        goToSlide,
        setZoom,
        setFitMode,
        destroy: destroyViewer,
      };
    });
  });

  afterEach(cleanup);

  it("使用安全 ZIP 限制在本地渲染 PPTX", async () => {
    const bridge = makeBridge();
    render(<PptxViewer filePath={PPTX_FILES.report.path} fileName={PPTX_FILES.report.name} bridge={bridge} />);

    expect(screen.getByText("演示文稿加载中…")).toBeInTheDocument();
    expect(await screen.findByText("季度汇报")).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(bridge.readFileBinary).toHaveBeenCalledWith("/slides/report.pptx");
    expect(openPresentation).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      expect.any(HTMLElement),
      expect.objectContaining({
        renderMode: "slide",
        zipLimits: recommendedZipLimits,
        lazySlides: true,
        lazyMedia: true,
        pdfjs: false,
      }),
    );
  });

  it("支持幻灯片翻页和缩放", async () => {
    render(<PptxViewer filePath={PPTX_FILES.report.path} fileName={PPTX_FILES.report.name} bridge={makeBridge()} />);
    await screen.findByText("1 / 3");

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(goToSlide).toHaveBeenCalledWith(1));
    expect(screen.getByText("2 / 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    await waitFor(() => expect(setZoom).toHaveBeenCalledWith(110));
    expect(screen.getByText("110%")).toBeInTheDocument();
  });

  it("解析失败后显示错误并可重试", async () => {
    openPresentation.mockRejectedValueOnce(new Error("invalid pptx"));
    const bridge = makeBridge();
    render(<PptxViewer filePath={PPTX_FILES.broken.path} fileName={PPTX_FILES.broken.name} bridge={bridge} />);

    expect(await screen.findByText("演示文稿预览失败")).toBeInTheDocument();
    expect(screen.getByText("invalid pptx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("季度汇报")).toBeInTheDocument();
    expect(bridge.readFileBinary).toHaveBeenCalledTimes(2);
  });

  it("只允许 http/https 链接交给系统浏览器", async () => {
    openPresentation.mockImplementationOnce(async (_bytes: ArrayBuffer, container: HTMLElement) => {
      container.innerHTML = '<a href="https://example.com">官网</a><a href="file:///etc/passwd">本地文件</a>';
      return {
        slideCount: 1,
        goToSlide,
        setZoom,
        setFitMode,
        destroy: destroyViewer,
      };
    });
    const openExternal = vi.fn().mockResolvedValue(undefined);
    render(
      <PptxViewer
        filePath={PPTX_FILES.links.path}
        fileName={PPTX_FILES.links.name}
        bridge={makeBridge({ openExternal })}
      />,
    );

    fireEvent.click(await screen.findByRole("link", { name: "官网" }));
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
    fireEvent.click(screen.getByRole("link", { name: "本地文件" }));
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
