import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import { FilesView } from "./FilesView";

const NOW = Date.now();

const EMPTY_TREE: PromptNode = { kind: "dir", name: "alpha", path: "/code/alpha", children: [] };

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

  it("二进制文件名(.png) → 占位分支,不调 readFile", async () => {
    const bridge = makeBridge();
    usePersonalStore.setState({
      filePreviewRequest: { projectId: "p1", path: "/code/alpha/logo.png", name: "logo.png" },
    });
    renderView(bridge);
    expect(await screen.findByText(/二进制文件/)).toBeInTheDocument();
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
