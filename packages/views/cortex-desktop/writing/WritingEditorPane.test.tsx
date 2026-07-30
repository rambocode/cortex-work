// WritingEditorPane 单测(U5):三档一致、去抖落盘/切文件 flush、基线与自写 hash 更新、
// 外部改动干净刷新/脏冲突两分支、自回声忽略、deleted 态。
// NoteCodeMirrorEditor 换成 textarea 桩(CM6 的动态装载/compartment 行为由其自身测试覆盖),
// 让本壳的编排逻辑(自动保存 / 基线 / 命令式句柄)可确定性驱动。
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import {
  __resetWritingBaselines,
  getBaseline,
  isSelfEcho,
} from "@cortex-work/core/writing/baseline";
import { WritingEditorPane, type WritingEditorPaneHandle } from "./WritingEditorPane";

// CM 内核桩:受控 textarea,onChange 直传值,readOnly 透传(deleted/审阅态断言用)。
vi.mock("../personal/editor/NoteCodeMirrorEditor", () => ({
  NoteCodeMirrorEditor: ({
    value,
    appearance,
    readOnly,
    onChange,
  }: {
    value: string;
    appearance: string;
    readOnly?: boolean;
    onChange: (v: string) => void;
  }) => (
    <textarea
      data-testid="cm"
      data-appearance={appearance}
      readOnly={!!readOnly}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

// 预览渲染桩:避免拉起 react-markdown/mermaid 重依赖,只回显内容供断言。
vi.mock("../personal/markdown/MarkdownView", () => ({
  MarkdownView: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

const A = "/space/a.md";
const B = "/space/b.md";

// 内存 fake bridge:readFile 读 Map、writeFile 记录并落 Map,pickDirectory 固定回目标目录。
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
    pickDirectory: async () => "/dest",
  } as unknown as DesktopBridge;
  return { bridge, files, writes };
}

function renderPane(
  bridge: DesktopBridge,
  path: string | null,
  ref: React.RefObject<WritingEditorPaneHandle | null>,
  extra?: { onConflict?: (i: { path: string; baseline: string; disk: string }) => void },
) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <WritingEditorPane ref={ref} path={path} onConflict={extra?.onConflict} />
    </CoreProvider>,
  );
}

describe("WritingEditorPane", () => {
  afterEach(cleanup);
  beforeEach(() => __resetWritingBaselines());

  it("加载文件后建立基线,三档切换内容一致", async () => {
    const { bridge } = fakeBridge({ [A]: "初始正文" });
    const ref = createRef<WritingEditorPaneHandle>();
    renderPane(bridge, A, ref);

    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    await waitFor(() => expect(cm.value).toBe("初始正文"));
    expect(getBaseline(A)?.content).toBe("初始正文");

    // 顶栏模式 pill 下拉切换:源码 → 仅预览(MarkdownView 回显同内容) → 实时预览,内容始终一致。
    // pickMode:打开模式下拉(pill 名称含当前档),再点目标档菜单项。
    const pickMode = (name: string): void => {
      fireEvent.click(screen.getByTitle("视图模式"));
      fireEvent.click(screen.getByRole("menuitem", { name }));
    };
    pickMode("源码");
    expect((screen.getByTestId("cm") as HTMLTextAreaElement).value).toBe("初始正文");
    pickMode("仅预览");
    expect(screen.getByTestId("md").textContent).toBe("初始正文");
    pickMode("实时预览");
    expect((screen.getByTestId("cm") as HTMLTextAreaElement).value).toBe("初始正文");
  });

  it("编辑后去抖落盘,并更新基线与自写 hash", async () => {
    const { bridge, writes } = fakeBridge({ [A]: "old" });
    const ref = createRef<WritingEditorPaneHandle>();
    renderPane(bridge, A, ref);
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    await waitFor(() => expect(cm.value).toBe("old"));

    fireEvent.change(cm, { target: { value: "new content" } });
    await waitFor(() => expect(writes).toEqual([{ path: A, content: "new content" }]), {
      timeout: 2000,
    });
    // 保存成功后:基线推进到已落盘内容,自写 hash 命中(供归因抑制回声)。
    expect(getBaseline(A)?.content).toBe("new content");
    expect(isSelfEcho(A, "new content")).toBe(true);
  });

  it("切文件时 flush 未保存内容到旧文件", async () => {
    const { bridge, writes } = fakeBridge({ [A]: "a0", [B]: "b0" });
    const ref = createRef<WritingEditorPaneHandle>();
    const { rerender } = renderPane(bridge, A, ref);
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    await waitFor(() => expect(cm.value).toBe("a0"));

    fireEvent.change(cm, { target: { value: "a-edited" } });
    // 立即切到 B(未等去抖):切文件应 flush A 的挂起内容。
    rerender(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <WritingEditorPane ref={ref} path={B} />
      </CoreProvider>,
    );
    await waitFor(() =>
      expect(writes.some((w) => w.path === A && w.content === "a-edited")).toBe(true),
    );
  });

  it("外部改动 + 编辑器干净:静默重读刷新,基线同步盘面", async () => {
    const { bridge, files } = fakeBridge({ [A]: "v1" });
    const ref = createRef<WritingEditorPaneHandle>();
    renderPane(bridge, A, ref);
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    await waitFor(() => expect(cm.value).toBe("v1"));

    files.set(A, "v2-external"); // 外部程序改盘
    let result: { status: string } | undefined;
    await act(async () => {
      result = await ref.current!.handleExternalChange();
    });
    expect(result?.status).toBe("refreshed");
    await waitFor(() =>
      expect((screen.getByTestId("cm") as HTMLTextAreaElement).value).toBe("v2-external"),
    );
    expect(getBaseline(A)?.content).toBe("v2-external");
  });

  it("外部改动 + 编辑器脏:不覆盖,转交冲突审阅", async () => {
    const { bridge, files } = fakeBridge({ [A]: "v1" });
    const onConflict = vi.fn();
    const ref = createRef<WritingEditorPaneHandle>();
    renderPane(bridge, A, ref, { onConflict });
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    await waitFor(() => expect(cm.value).toBe("v1"));

    // 用户编辑(脏),立即(去抖前)触发外部改动信号。
    fireEvent.change(cm, { target: { value: "my-draft" } });
    files.set(A, "external-v2");
    let result: { status: string } | undefined;
    await act(async () => {
      result = await ref.current!.handleExternalChange();
    });
    expect(result?.status).toBe("conflict");
    // 基线=编辑器当前内容,新版=盘上内容;编辑内容未被覆盖。
    expect(onConflict).toHaveBeenCalledWith({ path: A, baseline: "my-draft", disk: "external-v2" });
    expect((screen.getByTestId("cm") as HTMLTextAreaElement).value).toBe("my-draft");
  });

  it("自回声:自动保存落盘触发的外部信号被 hash 忽略", async () => {
    const { bridge, writes } = fakeBridge({ [A]: "old" });
    const ref = createRef<WritingEditorPaneHandle>();
    renderPane(bridge, A, ref);
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    await waitFor(() => expect(cm.value).toBe("old"));

    fireEvent.change(cm, { target: { value: "self-written" } });
    await waitFor(() => expect(writes.length).toBe(1), { timeout: 2000 });
    // 盘上内容 = 本端刚写内容 → 归因判为自回声,忽略。
    let result: { status: string } | undefined;
    await act(async () => {
      result = await ref.current!.handleExternalChange();
    });
    expect(result?.status).toBe("ignored-echo");
  });

  it("deleted 态:提示 + 另存可用 + 冻结编辑", async () => {
    const { bridge, writes } = fakeBridge({ [A]: "内容仍在" });
    const ref = createRef<WritingEditorPaneHandle>();
    renderPane(bridge, A, ref);
    const cm = (await screen.findByTestId("cm")) as HTMLTextAreaElement;
    await waitFor(() => expect(cm.value).toBe("内容仍在"));

    act(() => ref.current!.markDeleted());
    expect(screen.getByText(/文件已被删除/)).toBeInTheDocument();
    expect((screen.getByTestId("cm") as HTMLTextAreaElement).readOnly).toBe(true);

    // 另存为:选目录后写同名文件到目标目录。
    fireEvent.click(screen.getByRole("button", { name: /另存为/ }));
    await waitFor(() =>
      expect(writes.some((w) => w.path === "/dest/a.md" && w.content === "内容仍在")).toBe(true),
    );
  });
});
