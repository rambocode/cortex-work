import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, NoteMeta } from "@cortex-work/core";
import { NotesView } from "./NotesView";

const NOW = Date.now();

// 内存闪记存储:notesList / notesUpdate / notesDelete 往返(只删自身,不碰文档/会话)。
function fakeNotesBridge(initial: NoteMeta[]) {
  const store = new Map<string, NoteMeta>(initial.map((n) => [n.id, n]));
  const calls = { delete: [] as string[], update: [] as { id: string; patch: Record<string, unknown> }[] };
  const bridge = {
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
  } as unknown as DesktopBridge;
  return { bridge, store, calls };
}

function renderNotes(bridge: DesktopBridge) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <NotesView onToast={() => {}} />
    </CoreProvider>,
  );
}

function note(patch: Partial<NoteMeta> & Pick<NoteMeta, "id">): NoteMeta {
  return {
    status: "draft",
    content: "正文",
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

describe("NotesView 列表/详情", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      activeProjectId: undefined,
      activeSessionId: undefined,
      projects: [
        { id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW },
        { id: "p2", name: "beta", path: "/code/beta", addedAt: NOW },
      ],
      sessions: [],
      noteDetailRequest: undefined,
    });
  });

  it("按项目分组渲染闪记标题（首行截断）", async () => {
    const { bridge } = fakeNotesBridge([
      note({ id: "n1", projectId: "p1", content: "想法一\n更多正文" }),
      note({ id: "n2", projectId: "p2", content: "想法二" }),
    ]);
    renderNotes(bridge);

    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("想法一")).toBeInTheDocument();
    expect(screen.getByText("想法二")).toBeInTheDocument();
  });

  it("整体无闪记时显示空态", async () => {
    const { bridge } = fakeNotesBridge([]);
    renderNotes(bridge);
    expect(await screen.findByText(/还没有闪记/)).toBeInTheDocument();
  });

  it("未归类分组无内容时隐藏其标题", async () => {
    const { bridge } = fakeNotesBridge([note({ id: "n1", projectId: "p1", content: "归类的" })]);
    renderNotes(bridge);
    await screen.findByText("归类的");
    expect(screen.queryByText("未归类")).toBeNull();
  });

  it("未归类闪记单独成组,显示「未归类」标题", async () => {
    const { bridge } = fakeNotesBridge([note({ id: "n1", content: "散记" })]);
    renderNotes(bridge);
    expect(await screen.findByText("未归类")).toBeInTheDocument();
    expect(screen.getByText("散记")).toBeInTheDocument();
  });

  it("点击闪记进入详情,编辑 textarea 保存后经 notesUpdate 写回 content", async () => {
    const { bridge, calls, store } = fakeNotesBridge([
      note({ id: "n1", projectId: "p1", content: "原始想法" }),
    ]);
    const { container } = renderNotes(bridge);

    fireEvent.click(await screen.findByText("原始想法"));
    // 详情态:编辑入口
    fireEvent.click(await screen.findByTitle("编辑"));
    const ta = container.querySelector<HTMLTextAreaElement>(".pw-note-edit-ta")!;
    expect(ta.value).toBe("原始想法");

    fireEvent.change(ta, { target: { value: "修订后的想法" } });
    fireEvent.keyDown(ta, { key: "s", metaKey: true });

    await waitFor(() => expect(calls.update.length).toBeGreaterThan(0));
    expect(calls.update[0]).toMatchObject({ id: "n1", patch: { content: "修订后的想法" } });
    expect(store.get("n1")?.content).toBe("修订后的想法");
  });

  it("Esc 取消编辑不写回", async () => {
    const { bridge, calls } = fakeNotesBridge([note({ id: "n1", projectId: "p1", content: "保持原样" })]);
    const { container } = renderNotes(bridge);

    fireEvent.click(await screen.findByText("保持原样"));
    fireEvent.click(await screen.findByTitle("编辑"));
    const ta = container.querySelector<HTMLTextAreaElement>(".pw-note-edit-ta")!;
    fireEvent.change(ta, { target: { value: "改了不保存" } });
    fireEvent.keyDown(ta, { key: "Escape" });

    await waitFor(() => expect(container.querySelector(".pw-note-edit-ta")).toBeNull());
    expect(calls.update.length).toBe(0);
  });

  it("删除仅调 notesDelete(自身),不波及文档/会话(无 deleteFile 调用)", async () => {
    const { bridge, calls } = fakeNotesBridge([note({ id: "n1", projectId: "p1", content: "待删" })]);
    const deleteFile = vi.fn(async () => {});
    (bridge as unknown as { deleteFile: typeof deleteFile }).deleteFile = deleteFile;
    renderNotes(bridge);

    fireEvent.click(await screen.findByText("待删"));
    fireEvent.click(await screen.findByTitle("删除"));

    await waitFor(() => expect(calls.delete).toEqual(["n1"]));
    // 仅删自身:不调用文档/会话删除。
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("已深化闪记显示「已深化」徽标", async () => {
    const { bridge } = fakeNotesBridge([
      note({ id: "n1", projectId: "p1", content: "已孵化", status: "deepened", docPaths: ["/code/alpha/docs/flash-notes/c1/brainstorm.md"] }),
    ]);
    renderNotes(bridge);
    expect(await screen.findByText("已深化")).toBeInTheDocument();
  });

  it("同项目内多选 + 出现「深化 N 条」按钮;占位深化提示「下一步接入」", async () => {
    const onToast = vi.fn();
    const { bridge } = fakeNotesBridge([
      note({ id: "n1", projectId: "p1", content: "想法甲" }),
      note({ id: "n2", projectId: "p1", content: "想法乙" }),
    ]);
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <NotesView onToast={onToast} />
      </CoreProvider>,
    );

    const c1 = await screen.findByTitle("选择「想法甲」");
    const c2 = await screen.findByTitle("选择「想法乙」");
    fireEvent.click(c1);
    fireEvent.click(c2);

    const deepenBtn = await screen.findByRole("button", { name: /深化 2 条/ });
    fireEvent.click(deepenBtn);
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("下一步"));
  });

  it("跨项目选择互斥:选中 p2 的项后只保留 p2(p1 取消)", async () => {
    const { bridge } = fakeNotesBridge([
      note({ id: "n1", projectId: "p1", content: "甲项目记" }),
      note({ id: "n2", projectId: "p2", content: "乙项目记" }),
    ]);
    render(
      <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
        <NotesView onToast={() => {}} />
      </CoreProvider>,
    );

    fireEvent.click(await screen.findByTitle("选择「甲项目记」"));
    expect(await screen.findByRole("button", { name: /深化 1 条/ })).toBeInTheDocument();
    // 选另一项目 → 互斥,只保留新项目的 1 条
    fireEvent.click(await screen.findByTitle("选择「乙项目记」"));
    expect(await screen.findByRole("button", { name: /深化 1 条/ })).toBeInTheDocument();
  });

  it("未归类「移到项目」归档:notesUpdate(projectId) 后该闪记进入目标项目分组", async () => {
    const { bridge, store } = fakeNotesBridge([note({ id: "n1", content: "无主想法" })]);
    renderNotes(bridge);

    await screen.findByText("未归类");
    // 「移到项目」下拉选择 alpha
    fireEvent.click(await screen.findByTitle("移到项目"));
    fireEvent.click(await screen.findByText("alpha"));

    await waitFor(() => expect(store.get("n1")?.projectId).toBe("p1"));
  });

  it("consumeNoteDetailRequest 落地为打开该闪记详情", async () => {
    const { bridge } = fakeNotesBridge([note({ id: "n1", projectId: "p1", content: "跨栏跳转目标" })]);
    renderNotes(bridge);
    await screen.findByText("跨栏跳转目标");

    usePersonalStore.getState().requestNoteDetail({ noteId: "n1" });
    // 详情态出现编辑入口
    expect(await screen.findByTitle("编辑")).toBeInTheDocument();
  });

  it("选中目标失效(被删)自动退出详情", async () => {
    const { bridge } = fakeNotesBridge([note({ id: "n1", projectId: "p1", content: "短命想法" })]);
    renderNotes(bridge);

    fireEvent.click(await screen.findByText("短命想法"));
    await screen.findByTitle("删除");
    fireEvent.click(screen.getByTitle("删除"));

    // 删除后详情退出,回到列表空态
    await waitFor(() => expect(screen.queryByTitle("编辑")).toBeNull());
  });
});
