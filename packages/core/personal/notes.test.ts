// 闪记 core 封装的纯逻辑单测：
//   resolveDefaultNoteProject 归属推导（当前会话 > active > lastActive > undefined,
//     且失效项目回落 undefined）;
//   notesAvailable 在 bridge 为 null / 旧壳缺方法时安全降级。
// React Query hook 本身（useProjectNotes 等）走 useDesktopBridge + useQuery,需
// Provider 包裹,沿用本仓核心层「只测纯函数」惯例,由集成/人工验证覆盖。

import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { NoteMeta } from "../desktop/types";
import {
  DEEPEN_BRAINSTORM_FILE,
  DEEPEN_MAX_NOTES,
  DEEPEN_NOTE_BODY_MAX,
  appendUnique,
  applyDeepenFinalize,
  buildDeepenSystemPrompt,
  deepenDocDir,
  deepenDocPath,
  deepenStateTransition,
  isDeepeningForSession,
  noteContentToSubmit,
  notesAvailable,
  notesDeepeningForSession,
  prepareDeepenNotes,
  relForCompare,
  resolveDefaultNoteProject,
  runProducedDeepenDoc,
} from "./notes";

describe("resolveDefaultNoteProject", () => {
  const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("优先当前会话所属项目", () => {
    expect(
      resolveDefaultNoteProject({
        currentSessionProjectId: "a",
        activeProjectId: "b",
        lastActiveProjectId: "c",
        projects,
      }),
    ).toBe("a");
  });

  it("无当前会话项目时取 activeProjectId", () => {
    expect(
      resolveDefaultNoteProject({
        activeProjectId: "b",
        lastActiveProjectId: "c",
        projects,
      }),
    ).toBe("b");
  });

  it("再无则取 lastActiveProjectId", () => {
    expect(
      resolveDefaultNoteProject({
        lastActiveProjectId: "c",
        projects,
      }),
    ).toBe("c");
  });

  it("三者都无 → undefined（未归类）", () => {
    expect(resolveDefaultNoteProject({ projects })).toBeUndefined();
  });

  it("推导出的项目已不在 projects 中 → 回落 undefined", () => {
    expect(
      resolveDefaultNoteProject({
        currentSessionProjectId: "gone",
        activeProjectId: "b",
        projects,
      }),
    ).toBeUndefined();
  });

  it("当前会话项目失效但仍只看当前会话档（不串到 active）→ undefined", () => {
    // 归属来源按优先级取「第一个有值」的,失效后整体回落 undefined,不继续往下找。
    expect(
      resolveDefaultNoteProject({
        currentSessionProjectId: "gone",
        activeProjectId: "a",
        lastActiveProjectId: "b",
        projects,
      }),
    ).toBeUndefined();
  });

  it("projects 为空 → undefined", () => {
    expect(
      resolveDefaultNoteProject({ activeProjectId: "a", projects: [] }),
    ).toBeUndefined();
  });
});

describe("noteContentToSubmit（浮层空内容守卫）", () => {
  it("纯空白 → null（不创建,浮层保持打开）", () => {
    expect(noteContentToSubmit("")).toBeNull();
    expect(noteContentToSubmit("   ")).toBeNull();
    expect(noteContentToSubmit("\n\t  \n")).toBeNull();
  });

  it("有内容 → 去掉首尾空白后的文本", () => {
    expect(noteContentToSubmit("  hello  ")).toBe("hello");
    expect(noteContentToSubmit("foo\nbar")).toBe("foo\nbar");
  });

  it("内部空白保留,仅修剪首尾", () => {
    expect(noteContentToSubmit("\n  记一笔  \n")).toBe("记一笔");
  });
});

describe("notesAvailable（缺桥/旧壳安全降级）", () => {
  it("bridge 为 null → false", () => {
    expect(notesAvailable(null)).toBe(false);
  });

  it("旧壳缺 notesList 方法 → false", () => {
    expect(notesAvailable({} as DesktopBridge)).toBe(false);
  });

  it("具备 notesList → true", () => {
    const bridge = { notesList: async () => [] } as unknown as DesktopBridge;
    expect(notesAvailable(bridge)).toBe(true);
  });
});

// ── 深化种子拼装（U8）──────────────────────────────────────────────────────

function note(partial: Partial<NoteMeta> & Pick<NoteMeta, "id" | "createdAt">): NoteMeta {
  return {
    projectId: "p1",
    status: "draft",
    content: `内容-${partial.id}`,
    updatedAt: partial.createdAt,
    ...partial,
  };
}

describe("prepareDeepenNotes（升序 / 上限 / 正文截断）", () => {
  it("按 createdAt 升序排列（不依赖入参顺序）", () => {
    const out = prepareDeepenNotes([
      note({ id: "n3", createdAt: 300 }),
      note({ id: "n1", createdAt: 100 }),
      note({ id: "n2", createdAt: 200 }),
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.notes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("条数超过 DEEPEN_MAX_NOTES 阻止（不静默截断条数）", () => {
    const many = Array.from({ length: DEEPEN_MAX_NOTES + 1 }, (_, i) =>
      note({ id: `n${i}`, createdAt: i }),
    );
    const out = prepareDeepenNotes(many);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("too-many");
    // 提示文案含上限值,便于 UI 直接展示。
    expect(out.message).toContain(String(DEEPEN_MAX_NOTES));
  });

  it("恰好等于上限不阻止", () => {
    const exactly = Array.from({ length: DEEPEN_MAX_NOTES }, (_, i) =>
      note({ id: `n${i}`, createdAt: i }),
    );
    expect(prepareDeepenNotes(exactly).ok).toBe(true);
  });

  it("空选择阻止（无可深化条目）", () => {
    const out = prepareDeepenNotes([]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("empty");
  });

  it("单条正文超过 DEEPEN_NOTE_BODY_MAX 截断到上限并标记被截断", () => {
    const long = "x".repeat(DEEPEN_NOTE_BODY_MAX + 500);
    const out = prepareDeepenNotes([note({ id: "n1", createdAt: 1, content: long })]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.notes[0]!.content.length).toBe(DEEPEN_NOTE_BODY_MAX);
    // 正文级截断（不是 clipSummary 的 200）。
    expect(DEEPEN_NOTE_BODY_MAX).toBe(4000);
    expect(out.truncatedCount).toBe(1);
  });

  it("正文未超限不截断、truncatedCount 为 0", () => {
    const out = prepareDeepenNotes([note({ id: "n1", createdAt: 1, content: "短内容" })]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.notes[0]!.content).toBe("短内容");
    expect(out.truncatedCount).toBe(0);
  });
});

describe("deepenDocDir（确定性产出路径含 conversationId）", () => {
  it("路径 = <projectDir>/docs/flash-notes/<conversationId>", () => {
    expect(deepenDocDir("/home/me/proj", "sess-abc")).toBe(
      "/home/me/proj/docs/flash-notes/sess-abc",
    );
  });

  it("剥除项目目录尾部斜杠", () => {
    expect(deepenDocDir("/home/me/proj/", "sess-abc")).toBe(
      "/home/me/proj/docs/flash-notes/sess-abc",
    );
  });
});

describe("buildDeepenSystemPrompt（<note> 块结构 + brainstorm 落点）", () => {
  const notes: NoteMeta[] = [
    note({ id: "n1", createdAt: 1700000000000, content: "想法甲" }),
    note({ id: "n2", createdAt: 1700000100000, content: "想法乙" }),
  ];
  const docDir = "/home/me/proj/docs/flash-notes/sess-abc";
  const prompt = buildDeepenSystemPrompt(notes, docDir);

  it("每条一个 <note id created> 块,正文内联", () => {
    expect(prompt).toContain(
      `<note id="n1" created="${new Date(1700000000000).toISOString()}">`,
    );
    expect(prompt).toContain("想法甲");
    expect(prompt).toContain("</note>");
    expect(prompt).toContain(`<note id="n2" created="${new Date(1700000100000).toISOString()}">`);
    expect(prompt).toContain("想法乙");
  });

  it("把确定性产出路径 <docDir>/brainstorm.md 喂给 agent", () => {
    expect(prompt).toContain(`${docDir}/brainstorm.md`);
  });

  it("首条前有引导语（让 agent 先提澄清问题、再孵化）", () => {
    expect(prompt.indexOf("澄清问题")).toBeGreaterThanOrEqual(0);
    // 引导语在第一个 <note> 块之前。
    expect(prompt.indexOf("澄清问题")).toBeLessThan(prompt.indexOf("<note"));
  });
});

// ── 深化状态推进 / 失败回落（U9）─────────────────────────────────────────────

describe("prepareDeepenNotes 防重复触发（deepening 拦截）", () => {
  it("选中含 deepening 闪记 → already-deepening 阻止", () => {
    const out = prepareDeepenNotes([
      note({ id: "n1", createdAt: 1 }),
      note({ id: "n2", createdAt: 2, status: "deepening", conversationIds: ["sess-x"] }),
    ]);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("already-deepening");
  });

  it("已深化（deepened）闪记可再深化（不拦截）", () => {
    const out = prepareDeepenNotes([
      note({ id: "n1", createdAt: 1, status: "deepened", docPaths: ["/p/docs/flash-notes/old/brainstorm.md"] }),
    ]);
    expect(out.ok).toBe(true);
  });
});

describe("relForCompare 路径归一化（绝对/相对混写）", () => {
  it("绝对路径剥 cwd 前缀 → 相对", () => {
    expect(relForCompare("/home/me/proj/docs/flash-notes/s1/brainstorm.md", "/home/me/proj")).toBe(
      "docs/flash-notes/s1/brainstorm.md",
    );
  });

  it("已是相对路径 → 原样（去首尾斜杠）", () => {
    expect(relForCompare("docs/flash-notes/s1/brainstorm.md", "/home/me/proj")).toBe(
      "docs/flash-notes/s1/brainstorm.md",
    );
  });

  it("cwd 带尾斜杠 / 反斜杠混写也能归一", () => {
    expect(relForCompare("/home/me/proj/docs/x.md", "/home/me/proj/")).toBe("docs/x.md");
    expect(relForCompare("C:\\proj\\docs\\x.md", "C:\\proj")).toBe("docs/x.md");
  });
});

describe("runProducedDeepenDoc（本轮 changedFiles 含约定路径才命中）", () => {
  const cwd = "/home/me/proj";
  const sid = "sess-1";

  it("相对路径命中约定 brainstorm.md", () => {
    expect(runProducedDeepenDoc([`docs/flash-notes/${sid}/${DEEPEN_BRAINSTORM_FILE}`], sid, cwd)).toBe(true);
  });

  it("agent 写绝对路径也能命中（归一化后比对）", () => {
    expect(
      runProducedDeepenDoc([`${cwd}/docs/flash-notes/${sid}/${DEEPEN_BRAINSTORM_FILE}`], sid, cwd),
    ).toBe(true);
  });

  it("只写了 plan.md / 其它文件 → 不命中（判已深化只认 brainstorm.md）", () => {
    expect(runProducedDeepenDoc([`docs/flash-notes/${sid}/plan.md`, "src/a.ts"], sid, cwd)).toBe(false);
  });

  it("写到别的会话目录 → 不命中（会话 id 不同）", () => {
    expect(
      runProducedDeepenDoc([`docs/flash-notes/other/${DEEPEN_BRAINSTORM_FILE}`], sid, cwd),
    ).toBe(false);
  });

  it("空 changedFiles → 不命中（普通澄清轮）", () => {
    expect(runProducedDeepenDoc([], sid, cwd)).toBe(false);
  });

  it("截断路径（… 结尾,extractChangedFile 本应返回 undefined）即便混入也不误命中", () => {
    // 实际上截断路径不会进 changedFiles（extractChangedFile 截断返回 undefined）,
    // 这里做防御断言:即便混入,也因不等于完整约定路径而不命中。
    expect(runProducedDeepenDoc([`docs/flash-notes/${sid}/brainst…`], sid, cwd)).toBe(false);
  });
});

describe("appendUnique（追加不覆盖、去重）", () => {
  it("空数组 → 单元素", () => {
    expect(appendUnique(undefined, "x")).toEqual(["x"]);
  });
  it("已有则不重复追加", () => {
    expect(appendUnique(["a", "b"], "b")).toEqual(["a", "b"]);
  });
  it("新值追加到末尾", () => {
    expect(appendUnique(["a"], "b")).toEqual(["a", "b"]);
  });
});

describe("isDeepeningForSession / notesDeepeningForSession（gate）", () => {
  it("deepening 且 conversationIds 含 sessionId → true", () => {
    expect(
      isDeepeningForSession(note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: ["s1"] }), "s1"),
    ).toBe(true);
  });
  it("deepening 但 conversationIds 不含 sessionId → false（其它会话不误伤）", () => {
    expect(
      isDeepeningForSession(note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: ["other"] }), "s1"),
    ).toBe(false);
  });
  it("draft / deepened 即使含 sessionId → false（仅 deepening 态参与）", () => {
    expect(
      isDeepeningForSession(note({ id: "n1", createdAt: 1, status: "draft", conversationIds: ["s1"] }), "s1"),
    ).toBe(false);
    expect(
      isDeepeningForSession(note({ id: "n1", createdAt: 1, status: "deepened", conversationIds: ["s1"] }), "s1"),
    ).toBe(false);
  });
  it("筛选只取本会话的 deepening 闪记", () => {
    const all = [
      note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: ["s1"] }),
      note({ id: "n2", createdAt: 2, status: "deepening", conversationIds: ["s2"] }),
      note({ id: "n3", createdAt: 3, status: "draft" }),
    ];
    expect(notesDeepeningForSession(all, "s1").map((n) => n.id)).toEqual(["n1"]);
  });
});

describe("deepenStateTransition（状态迁移决策,纯函数）", () => {
  const cwd = "/home/me/proj";
  const sid = "sess-1";
  const docPath = deepenDocPath(cwd, sid);

  it("本轮含约定路径 → deepened + docPaths 追加该路径", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
      conversationId: sid,
      cwd,
      changedFiles: [`docs/flash-notes/${sid}/${DEEPEN_BRAINSTORM_FILE}`],
      terminalFailure: false,
    });
    expect(patch).toEqual({ status: "deepened", docPaths: [docPath] });
  });

  it("再深化:已有 docPaths 追加不覆盖", () => {
    const old = "/home/me/proj/docs/flash-notes/old/brainstorm.md";
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: ["old", sid], docPaths: [old] }),
      conversationId: sid,
      cwd,
      changedFiles: [`${cwd}/docs/flash-notes/${sid}/${DEEPEN_BRAINSTORM_FILE}`],
      terminalFailure: false,
    });
    expect(patch).toEqual({ status: "deepened", docPaths: [old, docPath] });
  });

  it("目标路径已存在但本轮未写入（changedFiles 不含）→ 不置已深化（返回 null,保持 deepening）", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
      conversationId: sid,
      cwd,
      changedFiles: ["src/a.ts"], // 本轮没碰约定路径,文件存在不能单独判已深化
      terminalFailure: false,
    });
    expect(patch).toBeNull();
  });

  it("普通澄清轮（无产出、非终态失败）→ null（保持 deepening,不回落不已深化）", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
      conversationId: sid,
      cwd,
      changedFiles: [],
      terminalFailure: false,
    });
    expect(patch).toBeNull();
  });

  it("终态失败 → 回落 draft,不置已深化、不追加 docPaths", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
      conversationId: sid,
      cwd,
      changedFiles: [],
      terminalFailure: true,
    });
    expect(patch).toEqual({ status: "draft" });
  });

  it("终态失败优先于产出判定（即使本轮写了文件也回落,不残留已深化）", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
      conversationId: sid,
      cwd,
      changedFiles: [`docs/flash-notes/${sid}/${DEEPEN_BRAINSTORM_FILE}`],
      terminalFailure: true,
    });
    expect(patch).toEqual({ status: "draft" });
  });
});

describe("applyDeepenFinalize（finalizeRun 副作用入口,严格 gate）", () => {
  function makeBridge(notes: NoteMeta[]) {
    const updates: { id: string; patch: unknown }[] = [];
    const bridge = {
      notesList: vi.fn(async () => notes),
      notesUpdate: vi.fn(async (id: string, patch: unknown) => {
        updates.push({ id, patch });
        return notes.find((n) => n.id === id) ?? null;
      }),
    } as unknown as DesktopBridge;
    return { bridge, updates };
  }

  const cwd = "/home/me/proj";
  const sid = "sess-1";

  it("普通（非深化）会话 finalizeRun → 不读写任何闪记（完全 no-op,不误伤）", async () => {
    // 本 session 没有任何 deepening 闪记（全是别的会话/draft）。
    const { bridge, updates } = makeBridge([
      note({ id: "n1", createdAt: 1, status: "draft" }),
      note({ id: "n2", createdAt: 2, status: "deepening", conversationIds: ["other-sess"] }),
    ]);
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, changedFiles: ["src/a.ts"], terminalFailure: false });
    expect(updates).toEqual([]);
    expect((bridge.notesUpdate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("本轮 changedFiles 含约定路径 → 该 session 的 deepening 闪记置 deepened + docPaths", async () => {
    const { bridge, updates } = makeBridge([
      note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
    ]);
    await applyDeepenFinalize(bridge, {
      sessionId: sid,
      cwd,
      changedFiles: [`docs/flash-notes/${sid}/${DEEPEN_BRAINSTORM_FILE}`],
      terminalFailure: false,
    });
    expect(updates).toEqual([{ id: "n1", patch: { status: "deepened", docPaths: [deepenDocPath(cwd, sid)] } }]);
  });

  it("普通澄清轮（无产出）→ 不写任何闪记（保持 deepening）", async () => {
    const { bridge, updates } = makeBridge([
      note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
    ]);
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, changedFiles: [], terminalFailure: false });
    expect(updates).toEqual([]);
  });

  it("终态失败（spawn/auth/超时/放弃）→ 回落 draft,无悬挂 docPaths（Covers AE7/AE8）", async () => {
    const { bridge, updates } = makeBridge([
      note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
    ]);
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, changedFiles: [], terminalFailure: true });
    expect(updates).toEqual([{ id: "n1", patch: { status: "draft" } }]);
  });

  it("多条同会话深化闪记 → 全部按同一规则迁移", async () => {
    const { bridge, updates } = makeBridge([
      note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
      note({ id: "n2", createdAt: 2, status: "deepening", conversationIds: [sid] }),
    ]);
    await applyDeepenFinalize(bridge, {
      sessionId: sid,
      cwd,
      changedFiles: [`${cwd}/docs/flash-notes/${sid}/${DEEPEN_BRAINSTORM_FILE}`],
      terminalFailure: false,
    });
    expect(updates.map((u) => u.id).sort()).toEqual(["n1", "n2"]);
    for (const u of updates) {
      expect(u.patch).toEqual({ status: "deepened", docPaths: [deepenDocPath(cwd, sid)] });
    }
  });

  it("bridge 缺 notesList/notesUpdate（web/旧壳）→ 安全降级,不抛", async () => {
    await expect(applyDeepenFinalize(null, { sessionId: sid, cwd, changedFiles: [], terminalFailure: false })).resolves.toBeUndefined();
    await expect(
      applyDeepenFinalize({} as DesktopBridge, { sessionId: sid, cwd, changedFiles: [], terminalFailure: false }),
    ).resolves.toBeUndefined();
  });

  it("notesList 拉取失败 → 静默,不抛、不调用 notesUpdate", async () => {
    const bridge = {
      notesList: vi.fn(async () => {
        throw new Error("io");
      }),
      notesUpdate: vi.fn(),
    } as unknown as DesktopBridge;
    await expect(
      applyDeepenFinalize(bridge, { sessionId: sid, cwd, changedFiles: [], terminalFailure: false }),
    ).resolves.toBeUndefined();
    expect((bridge.notesUpdate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("cwd 缺失（无项目目录无法解析）：终态失败仍回落,非失败保持 deepening", async () => {
    const failing = makeBridge([note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] })]);
    await applyDeepenFinalize(failing.bridge, { sessionId: sid, cwd: undefined, changedFiles: [], terminalFailure: true });
    expect(failing.updates).toEqual([{ id: "n1", patch: { status: "draft" } }]);

    const ok = makeBridge([note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] })]);
    await applyDeepenFinalize(ok.bridge, { sessionId: sid, cwd: undefined, changedFiles: [], terminalFailure: false });
    expect(ok.updates).toEqual([]);
  });
});
