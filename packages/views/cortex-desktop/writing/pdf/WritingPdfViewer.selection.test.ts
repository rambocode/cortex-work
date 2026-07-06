// @vitest-environment jsdom
// PDF 选区快照纯函数单测(U5):pdfSelectionSnapshotFromSelection 从 DOM Selection 算出
// sourceKind=pdf + 页码区间。用 jsdom 构造带 data-write-pdf-page 的节点 + duck-typed Selection
// (jsdom 的原生 Selection.toString 支持有限,故只注入本函数实际读取的字段)。
import { afterEach, describe, expect, it } from "vitest";
import { pdfSelectionSnapshotFromSelection } from "./WritingPdfViewer";

// 构造:root 下两页(page 2 / page 3),各含一段文本节点。返回 root 与两页的文本节点。
function buildViewerDom(): { root: HTMLElement; text2: Text; text3: Text } {
  const root = document.createElement("div");
  const page2 = document.createElement("div");
  page2.setAttribute("data-write-pdf-page", "2");
  const span2 = document.createElement("span");
  const text2 = document.createTextNode("第二页选中的文字");
  span2.appendChild(text2);
  page2.appendChild(span2);

  const page3 = document.createElement("div");
  page3.setAttribute("data-write-pdf-page", "3");
  const span3 = document.createElement("span");
  const text3 = document.createTextNode("第三页选中的文字");
  span3.appendChild(text3);
  page3.appendChild(span3);

  root.appendChild(page2);
  root.appendChild(page3);
  document.body.appendChild(root);
  return { root, text2, text3 };
}

// 造一个只含本函数读取字段的 Selection 替身。
function fakeSelection(over: Partial<Selection> & { toString?: () => string }): Selection {
  return {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: null,
    focusNode: null,
    toString: () => "",
    ...over,
  } as unknown as Selection;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pdfSelectionSnapshotFromSelection", () => {
  it("单页选中 → sourceKind=pdf,pageStart=pageEnd=页码", () => {
    const { root, text2 } = buildViewerDom();
    const snap = pdfSelectionSnapshotFromSelection(
      root,
      fakeSelection({ anchorNode: text2, focusNode: text2, toString: () => "  一段文字  " }),
    );
    expect(snap).not.toBeNull();
    expect(snap!.sourceKind).toBe("pdf");
    expect(snap!.text).toBe("一段文字"); // trim
    expect(snap!.charCount).toBe(4);
    expect(snap!.pageStart).toBe(2);
    expect(snap!.pageEnd).toBe(2);
  });

  it("跨页选中 → 页码取两端最小/最大", () => {
    const { root, text2, text3 } = buildViewerDom();
    const snap = pdfSelectionSnapshotFromSelection(
      root,
      fakeSelection({ anchorNode: text2, focusNode: text3, toString: () => "跨页选中" }),
    );
    expect(snap!.pageStart).toBe(2);
    expect(snap!.pageEnd).toBe(3);
  });

  it("折叠选区 / 空文本 → null", () => {
    const { root, text2 } = buildViewerDom();
    expect(
      pdfSelectionSnapshotFromSelection(root, fakeSelection({ isCollapsed: true, anchorNode: text2 })),
    ).toBeNull();
    expect(
      pdfSelectionSnapshotFromSelection(
        root,
        fakeSelection({ anchorNode: text2, focusNode: text2, toString: () => "   " }),
      ),
    ).toBeNull();
  });

  it("选区在 root 外 → null(选到助手面板等)", () => {
    const { root } = buildViewerDom();
    const outside = document.createElement("div");
    const outsideText = document.createTextNode("面板里的文字");
    outside.appendChild(outsideText);
    document.body.appendChild(outside);
    const snap = pdfSelectionSnapshotFromSelection(
      root,
      fakeSelection({ anchorNode: outsideText, focusNode: outsideText, toString: () => "面板文字" }),
    );
    expect(snap).toBeNull();
  });
});
