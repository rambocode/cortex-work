import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@cortex-work/core";
import { PdfViewer } from "./PdfViewer";

const { getDocument, modernGetDocument, getPage, renderPage, cancelRender, destroyDocument } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  modernGetDocument: vi.fn(),
  getPage: vi.fn(),
  renderPage: vi.fn(),
  cancelRender: vi.fn(),
  destroyDocument: vi.fn(),
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: modernGetDocument,
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "pdf-worker.mjs" }));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument,
}));

vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "legacy-pdf-worker.mjs" }));

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    readFileBinary: vi.fn().mockResolvedValue({
      data: "JVBERi0xLjQ=",
      truncated: false,
      size: 8,
      mtimeMs: 1,
    }),
    openPath: vi.fn().mockResolvedValue(""),
    ...over,
  } as unknown as DesktopBridge;
}

const PDF_FILES = {
  report: { path: "/docs/report.pdf", name: "report.pdf" },
  large: { path: "/docs/large.pdf", name: "large.pdf" },
} as const;

describe("PdfViewer", () => {
  beforeEach(() => {
    getDocument.mockReset();
    modernGetDocument.mockReset();
    getPage.mockReset();
    renderPage.mockReset();
    cancelRender.mockReset();
    destroyDocument.mockReset();
    renderPage.mockReturnValue({ promise: Promise.resolve(), cancel: cancelRender });
    getPage.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: renderPage,
    });
    const loadingTask = {
      promise: Promise.resolve({
        numPages: 2,
        getPage,
        cleanup: vi.fn(),
        destroy: destroyDocument,
      }),
      destroy: vi.fn(),
    };
    getDocument.mockReturnValue(loadingTask);
    modernGetDocument.mockReturnValue(loadingTask);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("在本地读取并渲染 PDF，支持翻页", async () => {
    const bridge = makeBridge();
    render(<PdfViewer filePath={PDF_FILES.report.path} fileName={PDF_FILES.report.name} bridge={bridge} />);

    expect(screen.getByText("PDF 加载中…")).toBeInTheDocument();
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
    expect(bridge.readFileBinary).toHaveBeenCalledWith("/docs/report.pdf");
    expect(getDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.any(Uint8Array),
        isEvalSupported: false,
        useWorkerFetch: false,
      }),
    );
    expect(modernGetDocument).not.toHaveBeenCalled();
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(1));

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("2 / 2")).toBeInTheDocument();
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(2));
  });

  it("提供 50%–200% 缩放和适合宽度控制", async () => {
    render(<PdfViewer filePath={PDF_FILES.report.path} fileName={PDF_FILES.report.name} bridge={makeBridge()} />);

    const fit = await screen.findByRole("button", { name: "适合宽度" });
    expect(fit).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByText("110%")).toBeInTheDocument();
    expect(fit).toHaveAttribute("aria-pressed", "false");
  });

  it("超限时提示并允许系统打开", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    const bridge = makeBridge({
      openPath,
      readFileBinary: vi.fn().mockResolvedValue({
        data: null,
        truncated: true,
        size: 30 * 1024 * 1024,
        mtimeMs: 1,
      }),
    });
    render(<PdfViewer filePath={PDF_FILES.large.path} fileName={PDF_FILES.large.name} bridge={bridge} />);

    expect(await screen.findByText("文件过大，无法在应用内预览")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "用系统应用打开" }));
    expect(openPath).toHaveBeenCalledWith("/docs/large.pdf");
    expect(getDocument).not.toHaveBeenCalled();
  });
});
