// WritingEditorPane × review-manager 接线单测(U6):pending 命中当前文件 → 切审阅态
// (显示 diff 视图而非编辑器、冻结自动保存);裁决落盘写盘 + 推进基线 + 清 pending + 同步编辑器内容;
// 切文件保留 pending、切回恢复审阅。CM 内核与 diff 视图均以桩替换(逻辑编排可确定性驱动)。
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { __resetWritingBaselines, getBaseline } from "@cortex-work/core/writing/baseline";
import {
  __resetWritingReviews,
  getPendingReview,
  useWritingReviewStore,
} from "@cortex-work/core/writing/review-manager";
import { WritingEditorPane, type WritingEditorPaneHandle } from "./WritingEditorPane";

// CM 内核桩:受控 textarea,onChange 直传,readOnly 透传。
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

// diff 视图桩:回显 baseline/next,并暴露两按钮触发 onResolve(整体接受=next、拒绝=baseline)。
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
      <button type="button" onClick={() => onResolve(baseline)}>
        reject-all
      </button>
    </div>
  ),
}));

const A = "/space/a.md";
const B = "/space/b.md";

function fakeBridge(initial: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial));
  const writes: { path: string; content: string }[] = [];
  const bridge = {
    readFile: async (p: string) => {
      if (!files.has(p)) throw new Error(`missing ${p}`);
      return { content: files.get(p) as string, truncated: false };
    },
    writeFile: async (p: string, c: string) => {
      files.set(p, c);
      writes.push({ path: p, content: c });
    },
  } as unknown as DesktopBridge;
  return { bridge, files, writes };
}

function renderPane(
  bridge: DesktopBridge,
  path: string | null,
  ref: React.RefObject<WritingEditorPaneHandle | null>,
) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <WritingEditorPane ref={ref} path={path} />
    </CoreProvider>,
  );
}

describe("WritingEditorPane diff 审阅接线", () => {
  afterEach(cleanup);
  beforeEach(() => {
    __resetWritingReviews();
    __resetWritingBaselines();
  });

  it("pending 命中当前文件:切审阅态(显示 diff 视图,隐藏编辑器)", async () => {
    const { bridge } = fakeBridge({ [A]: "v1" });
    const ref = createRef<WritingEditorPaneHandle>();
    renderPane(bridge, A, ref);
    await screen.findByTestId("cm");

    act(() => {
      useWritingReviewStore.getState().beginReview({
        path: A,
        baseline: "v1",
        next: "agent-v2",
        origin: "agent",
      });
    });
    // 编辑器让位给 diff 视图,diff 拿到基线/新版。
    await screen.findByTestId("diff");
    expect(screen.queryByTestId("cm")).toBeNull();
    expect(screen.getByTestId("diff-base").textContent).toBe("v1");
    expect(screen.getByTestId("diff-next").textContent).toBe("agent-v2");
  });

  it("裁决(全部接受):写盘新版 + 推进基线 + 清 pending + 编辑器回落显示新版", async () => {
    const { bridge, writes } = fakeBridge({ [A]: "v1" });
    const ref = createRef<WritingEditorPaneHandle>();
    renderPane(bridge, A, ref);
    await screen.findByTestId("cm");

    act(() => {
      useWritingReviewStore.getState().beginReview({
        path: A,
        baseline: "v1",
        next: "agent-v2",
        origin: "agent",
      });
    });
    await screen.findByTestId("diff");
    fireEvent.click(screen.getByRole("button", { name: "accept-all" }));

    await waitFor(() => expect(writes).toContainEqual({ path: A, content: "agent-v2" }));
    // pending 清除(解冻),基线推进,编辑器回来并显示裁决结果。
    expect(getPendingReview(A)).toBeUndefined();
    expect(getBaseline(A)?.content).toBe("agent-v2");
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    await waitFor(() => expect(cm.value).toBe("agent-v2"));
  });

  it("裁决(全部拒绝):写盘基线,新版被丢弃", async () => {
    const { bridge, writes } = fakeBridge({ [A]: "on-disk-changed-by-agent" });
    const ref = createRef<WritingEditorPaneHandle>();
    renderPane(bridge, A, ref);
    await screen.findByTestId("cm");

    act(() => {
      useWritingReviewStore.getState().beginReview({
        path: A,
        baseline: "baseline-before-agent",
        next: "on-disk-changed-by-agent",
        origin: "agent",
      });
    });
    await screen.findByTestId("diff");
    fireEvent.click(screen.getByRole("button", { name: "reject-all" }));

    await waitFor(() =>
      expect(writes).toContainEqual({ path: A, content: "baseline-before-agent" }),
    );
    expect(getPendingReview(A)).toBeUndefined();
  });

  it("切文件保留 pending、切回恢复审阅", async () => {
    const { bridge } = fakeBridge({ [A]: "v1", [B]: "b0" });
    const ref = createRef<WritingEditorPaneHandle>();
    const { rerender } = renderPane(bridge, A, ref);
    await screen.findByTestId("cm");

    act(() => {
      useWritingReviewStore.getState().beginReview({
        path: A,
        baseline: "v1",
        next: "agent-v2",
        origin: "agent",
      });
    });
    await screen.findByTestId("diff");

    // 切到 B:A 的 pending 常驻(模块级),B 无审阅显示编辑器。
    rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <WritingEditorPane ref={ref} path={B} />
      </CoreProvider>,
    );
    await waitFor(() =>
      expect((screen.getByTestId("cm") as HTMLTextAreaElement).value).toBe("b0"),
    );
    expect(screen.queryByTestId("diff")).toBeNull();
    expect(getPendingReview(A)).toBeDefined();

    // 切回 A:恢复审阅态。
    rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <WritingEditorPane ref={ref} path={A} />
      </CoreProvider>,
    );
    await screen.findByTestId("diff");
    expect(screen.getByTestId("diff-next").textContent).toBe("agent-v2");
  });
});
