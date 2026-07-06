// WritingEditorPane PDF 分派单测(U5):.pdf 路径分派到只读阅读器、旁路文本读盘/自动保存;
// 非 .pdf 仍走 CM 文本编辑(不回归);PDF 选区经 onPdfSelectionChange 上报。
// WritingPdfViewer 与 NoteCodeMirrorEditor 均换桩,避免拉起 pdfjs / CM6 重依赖。
import { createRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { __resetWritingBaselines } from "@cortex-work/core/writing/baseline";
import type { WritingSelectionSnapshot } from "@cortex-work/core/writing/prompt";
import { WritingEditorPane, type WritingEditorPaneHandle } from "./WritingEditorPane";

// CM 桩:回显为 textarea,便于断言「文本档挂载了 CM」。
vi.mock("../personal/editor/NoteCodeMirrorEditor", () => ({
  NoteCodeMirrorEditor: ({ value }: { value: string }) => <textarea data-testid="cm" value={value} readOnly />,
}));

// PDF 阅读器桩:回显 filePath;提供一个按钮触发选区上报,验证 onPdfSelectionChange 链路。
vi.mock("./pdf/WritingPdfViewer", () => ({
  WritingPdfViewer: ({
    filePath,
    onSelectionChange,
  }: {
    filePath: string;
    onSelectionChange?: (s: WritingSelectionSnapshot | null) => void;
  }) => (
    <div data-testid="pdf-viewer" data-path={filePath}>
      <button
        type="button"
        onClick={() =>
          onSelectionChange?.({ text: "选中", charCount: 2, sourceKind: "pdf", pageStart: 2, pageEnd: 3 })
        }
      >
        report-sel
      </button>
    </div>
  ),
}));

vi.mock("../personal/MarkdownView", () => ({
  MarkdownView: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

const MD = "/space/a.md";
const PDF = "/space/paper.pdf";

// fake bridge:记录 readFile/writeFile 调用;writingReadPdf 存在但阅读器已被桩替换故不会真调。
function fakeBridge() {
  const readFileCalls: string[] = [];
  const writes: string[] = [];
  const bridge = {
    readFile: async (p: string) => {
      readFileCalls.push(p);
      return { content: "文本正文", truncated: false };
    },
    writeFile: async (p: string) => {
      writes.push(p);
    },
    writingReadPdf: async () => ({ ok: false as const, message: "unused (viewer stubbed)" }),
  } as unknown as DesktopBridge;
  return { bridge, readFileCalls, writes };
}

function renderPane(
  bridge: DesktopBridge,
  path: string | null,
  onPdfSelectionChange?: (s: WritingSelectionSnapshot | null) => void,
) {
  const ref = createRef<WritingEditorPaneHandle>();
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <WritingEditorPane ref={ref} path={path} onPdfSelectionChange={onPdfSelectionChange} />
    </CoreProvider>,
  );
}

describe("WritingEditorPane PDF 分派", () => {
  afterEach(cleanup);
  beforeEach(() => __resetWritingBaselines());

  it(".pdf 分派到阅读器,不挂 CM、不读盘为文本", async () => {
    const { bridge, readFileCalls } = fakeBridge();
    renderPane(bridge, PDF);
    const viewer = await screen.findByTestId("pdf-viewer");
    expect(viewer.getAttribute("data-path")).toBe(PDF);
    expect(screen.queryByTestId("cm")).toBeNull();
    // 关键:PDF 不经文本 readFile(二进制),旁路自动保存链路。
    expect(readFileCalls).not.toContain(PDF);
  });

  it("非 .pdf 仍走 CM 文本编辑(不回归)", async () => {
    const { bridge } = fakeBridge();
    renderPane(bridge, MD);
    await waitFor(() => expect(screen.getByTestId("cm")).toBeTruthy());
    expect(screen.queryByTestId("pdf-viewer")).toBeNull();
  });

  it("PDF 文本层选区经 onPdfSelectionChange 上报(带页码)", async () => {
    const { bridge } = fakeBridge();
    const onPdfSelectionChange = vi.fn();
    renderPane(bridge, PDF, onPdfSelectionChange);
    fireEvent.click(await screen.findByText("report-sel"));
    expect(onPdfSelectionChange).toHaveBeenCalledWith({
      text: "选中",
      charCount: 2,
      sourceKind: "pdf",
      pageStart: 2,
      pageEnd: 3,
    });
  });
});
