import { act, cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, NoteMeta } from "@cortex-work/core";
import { NotesView } from "./NotesView";

const NOW = Date.now();

// 内存闪记存储:notesList / notesUpdate / notesDelete 往返(只删自身,不碰文档/会话)。
// 附带深化(U8)所需的最小桥:loadChat（空历史）+ startCli（记录调用,不真起进程）,
// 让「建会话即发」走到首条防丢 + deepening 标记 + setActiveSession,且不抛错。
// U10 追加:readFile/writeFile（深化产物 .md 磁盘读写,docFiles 缺失即模拟外部删除）。
function fakeNotesBridge(initial: NoteMeta[], docFiles: Record<string, string> = {}) {
  const store = new Map<string, NoteMeta>(initial.map((n) => [n.id, n]));
  const files = new Map<string, string>(Object.entries(docFiles));
  const calls = {
    delete: [] as string[],
    update: [] as { id: string; patch: Record<string, unknown> }[],
    startCli: [] as { prompt: string; cwd: string; appendSystemPrompt?: string }[],
    writeFile: [] as { path: string; content: string }[],
  };
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
    // 深化（send）依赖:历史加载（空）+ spawn（记录）。
    loadChat: async () => [],
    saveChat: async () => {},
    startCli: async (opts: { prompt: string; cwd: string; appendSystemPrompt?: string }) => {
      calls.startCli.push({ prompt: opts.prompt, cwd: opts.cwd, appendSystemPrompt: opts.appendSystemPrompt });
    },
    // 深化产物 .md 磁盘读写:文件不存在 → reject（模拟外部删除,触发缺失友好降级）。
    readFile: async (path: string) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return { content: files.get(path)!, truncated: false };
    },
    writeFile: async (path: string, content: string) => {
      calls.writeFile.push({ path, content });
      files.set(path, content);
    },
    // 深化/生成 plan 注入用:按 name 返回内置 skill 元数据（降格执行,只给路径+源数据）。
    skillGet: async (name: string) => ({
      name,
      description: `${name} 说明`,
      argumentHint: undefined,
      skillMdPath: `/abs/skills/${name}/SKILL.md`,
      dir: `/abs/skills/${name}`,
    }),
    // run 收尾产出探测:集成测试不真跑 CLI（startCli 只记录,不触发 cli:exit → finalize）,默认 false。
    fileExists: async () => false,
  } as unknown as DesktopBridge;
  return { bridge, store, calls, files };
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

// 列表行点击现改为「进入中心区写作面」(openNoteEditor),右栏内 NoteDetail 仅经
// 跨栏 requestNoteDetail 速览打开。详情类断言统一经此辅助打开右栏详情。
async function openDetailViaRequest(noteId: string, waitText: string) {
  await screen.findByText(waitText); // 确保列表已渲染
  act(() => {
    usePersonalStore.getState().requestNoteDetail({ noteId });
  });
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
      // 深化新会话默认 agent 走 defaultAgent;钉 claude 让深化编排走单发 startCli 路径
      // （否则回退 pi → RPC piOpen,与本测试关注的 cwd/outPath/systemPrompt 注入无关）。
      agentsAvailable: { claude: true },
      noteDetailRequest: undefined,
      noteEditorId: undefined,
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

  it("projectId 不在 projects 的孤儿闪记并入「未归类」,不静默消失", async () => {
    // 笔记的 projectId 指向一个已不在 projects store 的项目(项目被删 / store 未加载完)。
    const { bridge } = fakeNotesBridge([
      note({ id: "n1", projectId: "ghost", content: "孤儿闪记甲" }),
      note({ id: "n2", projectId: "ghost", content: "孤儿闪记乙" }),
    ]);
    renderNotes(bridge);
    // 落到「未归类」兜底分组,两条都可见。
    expect(await screen.findByText("未归类")).toBeInTheDocument();
    expect(screen.getByText("孤儿闪记甲")).toBeInTheDocument();
    expect(screen.getByText("孤儿闪记乙")).toBeInTheDocument();
  });

  it("列表点击闪记 → 进入中心区写作面(openNoteEditor)", async () => {
    const { bridge } = fakeNotesBridge([note({ id: "n1", projectId: "p1", content: "进编辑器" })]);
    renderNotes(bridge);
    fireEvent.click(await screen.findByText("进编辑器"));
    expect(usePersonalStore.getState().noteEditorId).toBe("n1");
  });

  it("跨栏速览详情,编辑 textarea 保存后经 notesUpdate 写回 content", async () => {
    const { bridge, calls, store } = fakeNotesBridge([
      note({ id: "n1", projectId: "p1", content: "原始想法" }),
    ]);
    const { container } = renderNotes(bridge);

    await openDetailViaRequest("n1", "原始想法");
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

    await openDetailViaRequest("n1", "保持原样");
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

    await openDetailViaRequest("n1", "待删");
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

  it("同项目内多选 + 点「深化 N 条」触发深化:源闪记置 deepening + 链新会话 + 切到新会话 + 即建即发", async () => {
    const onToast = vi.fn();
    const { bridge, store, calls } = fakeNotesBridge([
      note({ id: "n1", projectId: "p1", content: "想法甲", createdAt: NOW + 1 }),
      note({ id: "n2", projectId: "p1", content: "想法乙", createdAt: NOW }),
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

    // 建会话即发:新会话创建并被设为活跃(自动切到新会话)。
    await waitFor(() => expect(usePersonalStore.getState().activeSessionId).toBeTruthy());
    const newSessionId = usePersonalStore.getState().activeSessionId!;
    const newSession = usePersonalStore.getState().sessions.find((s) => s.id === newSessionId);
    expect(newSession?.projectId).toBe("p1");

    // 源闪记被置「深化中」并把新会话 id 追加进 conversationIds（完整数组传给 notesUpdate）。
    await waitFor(() => {
      expect(store.get("n1")?.status).toBe("deepening");
      expect(store.get("n2")?.status).toBe("deepening");
    });
    expect(store.get("n1")?.conversationIds).toContain(newSessionId);
    expect(store.get("n2")?.conversationIds).toContain(newSessionId);

    // 首条防丢链路:在新会话 cwd(项目路径)下发起 CLI,system prompt 注入 ce-ideate 路径 + 确定产出路径。
    await waitFor(() => expect(calls.startCli.length).toBe(1));
    expect(calls.startCli[0]!.cwd).toBe("/code/alpha");
    expect(calls.startCli[0]!.appendSystemPrompt).toContain(
      `/code/alpha/docs/ideation/${newSessionId}-deepen.md`,
    );
    // 注入内置 ce-ideate skill 路径（让 agent 自己 Read,不内联全文）。
    expect(calls.startCli[0]!.appendSystemPrompt).toContain("/abs/skills/ce-ideate/SKILL.md");
    // 种子按 createdAt 升序:想法乙(更早)在想法甲之前。
    const sp = calls.startCli[0]!.appendSystemPrompt ?? "";
    expect(sp.indexOf("想法乙")).toBeLessThan(sp.indexOf("想法甲"));
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

    await openDetailViaRequest("n1", "短命想法");
    await screen.findByTitle("删除");
    fireEvent.click(screen.getByTitle("删除"));

    // 删除后详情退出,回到列表空态
    await waitFor(() => expect(screen.queryByTitle("编辑")).toBeNull());
  });
});

// U10：深化产物的查看/轻量编辑 + 生成 plan 入口（契约 5.7 / 6.1 已深化徽标段）。
describe("NotesView U10 深化产物查看与生成 plan", () => {
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
      // 深化新会话默认 agent 走 defaultAgent;钉 claude 让深化编排走单发 startCli 路径
      // （否则回退 pi → RPC piOpen,与本测试关注的 cwd/outPath/systemPrompt 注入无关）。
      agentsAvailable: { claude: true },
      noteDetailRequest: undefined,
      noteEditorId: undefined,
    });
  });

  // AE3：点已深化闪记 → 显示「已深化」+ 可跳转产出文档与来源(深化)会话。
  it("已深化详情:列出全部 docPaths 且可跳转(requestFilePreview),并经 conversationIds 跳回深化会话", async () => {
    const docA = "/code/alpha/docs/flash-notes/c1/brainstorm.md";
    const docB = "/code/alpha/docs/flash-notes/c2/plan.md";
    const { bridge } = fakeNotesBridge(
      [
        note({
          id: "n1",
          projectId: "p1",
          content: "已孵化想法",
          status: "deepened",
          conversationIds: ["c1", "c2"],
          docPaths: [docA, docB],
        }),
      ],
      { [docA]: "# 头脑风暴", [docB]: "# 计划" },
    );
    // 两段深化会话仍在(支持逐段跳回)。
    usePersonalStore.setState((s) => ({
      sessions: [
        ...s.sessions,
        { id: "c1", projectId: "p1", title: "深化一", agent: "claude" as const, model: "sonnet", createdAt: NOW, updatedAt: NOW },
        { id: "c2", projectId: "p1", title: "深化二", agent: "claude" as const, model: "sonnet", createdAt: NOW, updatedAt: NOW },
      ],
    }));
    renderNotes(bridge);

    await openDetailViaRequest("n1", "已孵化想法");
    // 已深化徽标在详情头出现。
    expect(await screen.findAllByText("已深化")).not.toHaveLength(0);
    // 多份产物全部列出。
    expect(screen.getByText("brainstorm.md")).toBeInTheDocument();
    expect(screen.getByText("plan.md")).toBeInTheDocument();

    // 「在文件视图打开」副入口 → requestFilePreview 切右栏文件视图(经 store 断言)。
    fireEvent.click(screen.getByTitle(`在文件视图打开 brainstorm.md`));
    await waitFor(() => {
      const st = usePersonalStore.getState();
      expect(st.filePreviewRequest?.path).toBe(docA);
      expect(st.rightView).toBe("files");
    });

    // 来源(深化)会话经 conversationIds → setActiveSession 跳回(点最近一段 c2)。
    fireEvent.click(screen.getByText("深化会话 2"));
    await waitFor(() => expect(usePersonalStore.getState().activeSessionId).toBe("c2"));
  });

  // 链接悬挂降级:某文档被外部删除 → 其余仍可达,缺失项给友好提示(不崩)。
  it("某产物被外部删除时其余仍可达、缺失项给友好提示", async () => {
    const docOk = "/code/alpha/docs/flash-notes/c1/brainstorm.md";
    const docGone = "/code/alpha/docs/flash-notes/c1/plan.md";
    const { bridge } = fakeNotesBridge(
      [
        note({
          id: "n1",
          projectId: "p1",
          content: "半残产物",
          status: "deepened",
          conversationIds: ["c1"],
          docPaths: [docOk, docGone],
        }),
      ],
      { [docOk]: "# 存在" }, // 故意只给 docOk;docGone 读时 reject(模拟外删)
    );
    renderNotes(bridge);

    await openDetailViaRequest("n1", "半残产物");
    // 两份都列出(缺失项不从列表消失,仍可点)。
    expect(await screen.findByText("brainstorm.md")).toBeInTheDocument();
    expect(screen.getByText("plan.md")).toBeInTheDocument();

    // 打开缺失文档内联编辑 → 读盘失败 → 友好降级提示,不崩。
    fireEvent.click(screen.getByText("plan.md"));
    expect(await screen.findByText(/文档不可用|读取失败|不存在/)).toBeInTheDocument();

    // 切回存在的文档 → 正常加载预览。
    fireEvent.click(screen.getByText("brainstorm.md"));
    await waitFor(() => expect(screen.getByText("存在")).toBeInTheDocument());
  });

  // 内联编辑磁盘 md:textarea + Cmd/Ctrl+S 经 bridge.writeFile 写回。
  it("内联编辑产物文档 Cmd+S 经 writeFile 写回磁盘", async () => {
    const doc = "/code/alpha/docs/flash-notes/c1/brainstorm.md";
    const { bridge, calls } = fakeNotesBridge(
      [
        note({
          id: "n1",
          projectId: "p1",
          content: "可编辑产物",
          status: "deepened",
          conversationIds: ["c1"],
          docPaths: [doc],
        }),
      ],
      { [doc]: "旧产物正文" },
    );
    const { container } = renderNotes(bridge);

    await openDetailViaRequest("n1", "可编辑产物");
    fireEvent.click(await screen.findByText("brainstorm.md"));
    // 内联文档编辑入口。
    fireEvent.click(await screen.findByTitle("编辑文档"));
    const ta = container.querySelector<HTMLTextAreaElement>(".pw-note-doc-ta")!;
    await waitFor(() => expect(ta.value).toBe("旧产物正文"));
    fireEvent.change(ta, { target: { value: "改写后的产物" } });
    fireEvent.keyDown(ta, { key: "s", metaKey: true });

    await waitFor(() => expect(calls.writeFile).toEqual([{ path: doc, content: "改写后的产物" }]));
  });

  // 生成 plan 入口(契约 5.7):已产出 brainstorm 的闪记详情提供「生成 plan」按钮,
  // 触发深化编排再开一段(同 conversationId 目录写 plan.md,经 send → startCli)。
  it("「生成 plan」按钮存在且触发深化编排(同会话目录写 plan.md)", async () => {
    const brainstorm = "/code/alpha/docs/flash-notes/c1/brainstorm.md";
    const { bridge, calls, store } = fakeNotesBridge(
      [
        note({
          id: "n1",
          projectId: "p1",
          content: "待生成计划",
          status: "deepened",
          conversationIds: ["c1"],
          docPaths: [brainstorm],
        }),
      ],
      { [brainstorm]: "# 头脑风暴产物" },
    );
    // 深化会话 c1 仍在(生成 plan 复用同一会话目录)。
    usePersonalStore.setState((s) => ({
      sessions: [
        ...s.sessions,
        {
          id: "c1",
          projectId: "p1",
          title: "深化会话",
          agent: "claude" as const,
          model: "sonnet",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }));
    renderNotes(bridge);

    await openDetailViaRequest("n1", "待生成计划");
    const planBtn = await screen.findByRole("button", { name: /生成 plan/ });
    fireEvent.click(planBtn);

    // 经 send → startCli 发到同一深化会话目录,注入 ce-plan + 确定 plan 产出路径。
    await waitFor(() => expect(calls.startCli.length).toBe(1));
    expect(calls.startCli[0]!.cwd).toBe("/code/alpha");
    expect(calls.startCli[0]!.appendSystemPrompt).toContain(
      "/code/alpha/docs/plans/c1-plan.md",
    );
    expect(calls.startCli[0]!.appendSystemPrompt).toContain("/abs/skills/ce-plan/SKILL.md");
    // status 仍 deepened（plan 不改 status;plan 路径靠 run 收尾 finalize 探测追加,集成测试不触发）。
    expect(store.get("n1")?.status).toBe("deepened");
    // 切回该深化会话(继续观察 plan 产出)。
    expect(usePersonalStore.getState().activeSessionId).toBe("c1");
  });

  it("草稿态闪记详情不显示「生成 plan」入口", async () => {
    const { bridge } = fakeNotesBridge([note({ id: "n1", projectId: "p1", content: "纯草稿" })]);
    renderNotes(bridge);
    await openDetailViaRequest("n1", "纯草稿");
    await screen.findByTitle("编辑");
    expect(screen.queryByRole("button", { name: /生成 plan/ })).toBeNull();
  });
});

// 对抗 review 健壮性修复：不留僵尸闪记（R17）+ 深化触发在途防抖。
describe("NotesView 深化健壮性", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({
      homeOpen: false,
      activeProjectId: undefined,
      activeSessionId: undefined,
      projects: [{ id: "p1", name: "alpha", path: "/code/alpha", addedAt: NOW }],
      sessions: [],
      // 深化新会话默认 agent 走 defaultAgent;钉 claude 让深化编排走单发 startCli 路径
      // （否则回退 pi → RPC piOpen,与本测试关注的 cwd/outPath/systemPrompt 注入无关）。
      agentsAvailable: { claude: true },
      noteDetailRequest: undefined,
      noteEditorId: undefined,
    });
  });

  // 修复 1（R17）：deepening 闪记卡死出口 —— 详情提供「放弃深化」回落草稿。
  it("deepening 闪记详情显示「放弃深化」,点击调 notesUpdate(id,{status:draft})", async () => {
    const { bridge, calls, store } = fakeNotesBridge([
      note({ id: "n1", projectId: "p1", content: "卡住的深化", status: "deepening", conversationIds: ["c1"] }),
    ]);
    renderNotes(bridge);

    await openDetailViaRequest("n1", "卡住的深化");
    const giveUp = await screen.findByRole("button", { name: /放弃深化/ });
    fireEvent.click(giveUp);

    await waitFor(() => expect(calls.update.length).toBeGreaterThan(0));
    expect(calls.update[0]).toMatchObject({ id: "n1", patch: { status: "draft" } });
    expect(store.get("n1")?.status).toBe("draft");
  });

  it("draft 闪记详情不显示「放弃深化」", async () => {
    const { bridge } = fakeNotesBridge([note({ id: "n1", projectId: "p1", content: "草稿想法" })]);
    renderNotes(bridge);
    await openDetailViaRequest("n1", "草稿想法");
    await screen.findByTitle("编辑");
    expect(screen.queryByRole("button", { name: /放弃深化/ })).toBeNull();
  });

  it("deepened 闪记详情不显示「放弃深化」", async () => {
    const doc = "/code/alpha/docs/flash-notes/c1/brainstorm.md";
    const { bridge } = fakeNotesBridge(
      [
        note({
          id: "n1",
          projectId: "p1",
          content: "已深化想法",
          status: "deepened",
          conversationIds: ["c1"],
          docPaths: [doc],
        }),
      ],
      { [doc]: "# 产物" },
    );
    renderNotes(bridge);
    await openDetailViaRequest("n1", "已深化想法");
    await screen.findByTitle("编辑");
    expect(screen.queryByRole("button", { name: /放弃深化/ })).toBeNull();
  });

  // 修复 2：深化触发在途时按钮 disabled,完成后恢复（防极快二次点击建重复会话）。
  it("深化触发在途时「深化」按钮 disabled,完成后恢复", async () => {
    // 用一个挂起的 startCli 制造在途窗口（send 内 await startCli → onDeepen 卡在 await）。
    let releaseCli: (() => void) | null = null;
    const { bridge } = fakeNotesBridge([note({ id: "n1", projectId: "p1", content: "待深化" })]);
    (bridge as unknown as { startCli: (opts: { prompt: string; cwd: string }) => Promise<void> }).startCli =
      () =>
        new Promise<void>((resolve) => {
          releaseCli = resolve;
        });
    renderNotes(bridge);

    fireEvent.click(await screen.findByTitle("选择「待深化」"));
    const deepenBtn = await screen.findByRole("button", { name: /深化 1 条/ });
    expect(deepenBtn).not.toBeDisabled();

    fireEvent.click(deepenBtn);

    // 在途:按钮 disabled（文案切换为「深化中…」）。
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /深化中…/ })).toBeDisabled();
    });

    // 放行挂起的 CLI → onDeepen 完成 → 清空多选,底栏隐藏（恢复可点初态:在途按钮消失）。
    releaseCli!();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /深化中…/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /深化 \d+ 条/ })).toBeNull();
    });
  });
});
