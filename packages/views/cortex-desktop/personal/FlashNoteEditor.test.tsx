import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, NoteMeta } from "@cortex-work/core";
import { FlashNoteEditor } from "./FlashNoteEditor";

const NOW = Date.now();

function fakeBridge(initial: NoteMeta[]) {
  const store = new Map<string, NoteMeta>(initial.map((n) => [n.id, n]));
  const calls = { delete: [] as string[], update: [] as { id: string; patch: Record<string, unknown> }[] };
  return {
    bridge: {
      notesList: async (projectId?: string) => {
        const all = [...store.values()];
        return projectId === undefined ? all : all.filter((n) => n.projectId === projectId);
      },
      notesUpdate: async (id: string, patch: Record<string, unknown>) => {
        calls.update.push({ id, patch });
        const cur = store.get(id);
        if (!cur) return null;
        const next = { ...cur, ...patch, updatedAt: Date.now() } as NoteMeta;
        store.set(id, next);
        return next;
      },
      notesDelete: async (id: string) => {
        calls.delete.push(id);
        store.delete(id);
      },
    } as unknown as DesktopBridge,
    store,
    calls,
  };
}

function note(patch: Partial<NoteMeta> & Pick<NoteMeta, "id">): NoteMeta {
  return { status: "draft", content: "正文", createdAt: NOW, updatedAt: NOW, ...patch };
}

function renderEditor(bridge: DesktopBridge, noteId: string, onClose = () => {}) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <FlashNoteEditor noteId={noteId} onClose={onClose} onToast={() => {}} />
    </CoreProvider>,
  );
}

describe("FlashNoteEditor 三档写作面", () => {
  afterEach(cleanup);
  beforeEach(() => {
    usePersonalStore.setState({
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [],
    });
  });

  it("默认进实时预览,显示标题并异步挂载 CodeMirror 实例", async () => {
    const { bridge } = fakeBridge([note({ id: "n1", projectId: "p1", content: "# 标题\n正文一" })]);
    const { container } = renderEditor(bridge, "n1");
    expect(await screen.findByText("标题")).toBeInTheDocument(); // 头部标题(首行截断,# 去掉空格后)
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  });

  it("切到「仅预览」渲染 MarkdownView,不挂 CodeMirror", async () => {
    const { bridge } = fakeBridge([note({ id: "n1", projectId: "p1", content: "正文内容" })]);
    const { container } = renderEditor(bridge, "n1");
    fireEvent.click(await screen.findByRole("button", { name: "仅预览" }));
    await waitFor(() => {
      expect(container.querySelector(".pw-note-editor-preview")).not.toBeNull();
      expect(container.querySelector(".cm-editor")).toBeNull();
    });
  });

  it("三档可切换:切到源码后再回实时预览,内容不丢", async () => {
    const { bridge } = fakeBridge([note({ id: "n1", projectId: "p1", content: "保留内容" })]);
    const { container } = renderEditor(bridge, "n1");
    await screen.findByRole("button", { name: "源码" });
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    fireEvent.click(screen.getByRole("button", { name: "仅预览" }));
    await waitFor(() => expect(screen.getAllByText("保留内容").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "实时预览" }));
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull(), { timeout: 5000 });
  });

  it("删除按钮:调用 notesDelete 并回调 onClose(仅删闪记自身)", async () => {
    const { bridge, calls } = fakeBridge([note({ id: "n1", projectId: "p1", content: "待删" })]);
    const onClose = vi.fn();
    renderEditor(bridge, "n1", onClose);
    fireEvent.click(await screen.findByTitle("删除闪记"));
    await waitFor(() => {
      expect(calls.delete).toEqual(["n1"]);
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("已深化闪记展示深化产物链接与生成 plan 入口", async () => {
    const { bridge } = fakeBridge([
      note({
        id: "n1",
        projectId: "p1",
        status: "deepened",
        content: "已深化的想法",
        docPaths: ["/code/alpha/docs/brainstorms/n1.md"],
        conversationIds: ["c1"],
      }),
    ]);
    renderEditor(bridge, "n1");
    expect(await screen.findByText("深化产物")).toBeInTheDocument();
    expect(screen.getByText("n1.md")).toBeInTheDocument();
    expect(screen.getByText("生成 plan")).toBeInTheDocument();
  });
});
