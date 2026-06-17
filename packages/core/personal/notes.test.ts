// 闪记 core 封装的纯逻辑单测：
//   resolveDefaultNoteProject 归属推导（当前会话 > active > lastActive > undefined,
//     且失效项目回落 undefined）;
//   notesAvailable 在 bridge 为 null / 旧壳缺方法时安全降级;
//   深化注入（buildDeepenSystemPrompt / buildPlanSystemPrompt 注入 ce-ideate/ce-plan 元数据+路径,降格执行）;
//   产出确定路径（deepenDocPath / planDocPath 含 sessionId）;
//   状态机（deepenStateTransition 按 status 分流 + applyDeepenFinalize fs.exists 探测 + gate 扩展）。
// React Query hook 本身（useProjectNotes 等）走 useDesktopBridge + useQuery,需 Provider 包裹,
// 沿用本仓核心层「只测纯函数」惯例,由集成/人工验证覆盖。

import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../desktop/bridge";
import type { NoteMeta, SkillMeta } from "../desktop/types";
import {
  DEEPEN_MAX_NOTES,
  DEEPEN_NOTE_BODY_MAX,
  appendUnique,
  applyDeepenFinalize,
  buildDeepenSystemPrompt,
  buildPlanSystemPrompt,
  cancelDeepenPlan,
  deepenDocPath,
  deepenStateTransition,
  isDeepeningForSession,
  isLinkedToSession,
  noteContentToSubmit,
  notesAvailable,
  notesLinkedToSession,
  planDocPath,
  prepareDeepenNotes,
  resolveDefaultNoteProject,
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

// ── 深化种子拼装 ───────────────────────────────────────────────────────────

function note(partial: Partial<NoteMeta> & Pick<NoteMeta, "id" | "createdAt">): NoteMeta {
  return {
    projectId: "p1",
    status: "draft",
    content: `内容-${partial.id}`,
    updatedAt: partial.createdAt,
    ...partial,
  };
}

const ideateSkill: SkillMeta = {
  name: "ce-ideate",
  description: "Generate and critically evaluate grounded ideas",
  argumentHint: "[focus] [output:md]",
  skillMdPath: "/abs/skills/ce-ideate/SKILL.md",
  dir: "/abs/skills/ce-ideate",
};

const planSkill: SkillMeta = {
  name: "ce-plan",
  description: "Create structured plans for multi-step tasks",
  skillMdPath: "/abs/skills/ce-plan/SKILL.md",
  dir: "/abs/skills/ce-plan",
};

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
      note({ id: "n1", createdAt: 1, status: "deepened", docPaths: ["/p/docs/ideation/old-deepen.md"] }),
    ]);
    expect(out.ok).toBe(true);
  });
});

describe("deepenDocPath / planDocPath（确定路径含 sessionId）", () => {
  it("deepenDocPath = <cwd>/docs/ideation/<sid>-deepen.md", () => {
    expect(deepenDocPath("/home/me/proj", "sess-abc")).toBe(
      "/home/me/proj/docs/ideation/sess-abc-deepen.md",
    );
  });

  it("planDocPath = <cwd>/docs/plans/<sid>-plan.md", () => {
    expect(planDocPath("/home/me/proj", "sess-abc")).toBe(
      "/home/me/proj/docs/plans/sess-abc-plan.md",
    );
  });

  it("剥除 cwd 尾部斜杠", () => {
    expect(deepenDocPath("/home/me/proj/", "s1")).toBe("/home/me/proj/docs/ideation/s1-deepen.md");
    expect(planDocPath("/home/me/proj/", "s1")).toBe("/home/me/proj/docs/plans/s1-plan.md");
  });
});

describe("buildDeepenSystemPrompt（注入 ce-ideate 元数据+路径,降格执行）", () => {
  const notes: NoteMeta[] = [
    note({ id: "n1", createdAt: 1700000000000, content: "想法甲" }),
    note({ id: "n2", createdAt: 1700000100000, content: "想法乙" }),
  ];
  const outPath = "/home/me/proj/docs/ideation/sess-abc-deepen.md";
  const prompt = buildDeepenSystemPrompt(notes, { skill: ideateSkill, outPath });

  it("注入 skill 名称与说明（frontmatter 源数据）", () => {
    expect(prompt).toContain("ce-ideate");
    expect(prompt).toContain("Generate and critically evaluate grounded ideas");
  });

  it("引导 agent Read SKILL.md 绝对路径（不内联全文）", () => {
    expect(prompt).toContain("/abs/skills/ce-ideate/SKILL.md");
  });

  it("给出 references 绝对前缀（避免相对 cwd 断链）", () => {
    expect(prompt).toContain("/abs/skills/ce-ideate/references/");
  });

  it("降格指令:禁子 agent(Task) / 禁阻塞提问(AskUserQuestion)", () => {
    expect(prompt).toContain("Task");
    expect(prompt).toContain("AskUserQuestion");
  });

  it("产出落点给死为确定 outPath", () => {
    expect(prompt).toContain(outPath);
  });

  it("每条一个 <note id created> 块,正文内联", () => {
    expect(prompt).toContain(`<note id="n1" created="${new Date(1700000000000).toISOString()}">`);
    expect(prompt).toContain("想法甲");
    expect(prompt).toContain(`<note id="n2" created="${new Date(1700000100000).toISOString()}">`);
    expect(prompt).toContain("想法乙");
  });
});

describe("buildPlanSystemPrompt（注入 ce-plan 元数据+路径,降格执行）", () => {
  const outPath = "/home/me/proj/docs/plans/sess-abc-plan.md";
  const prompt = buildPlanSystemPrompt({ skill: planSkill, outPath });

  it("注入 ce-plan 名称/说明/SKILL.md 路径", () => {
    expect(prompt).toContain("ce-plan");
    expect(prompt).toContain("Create structured plans");
    expect(prompt).toContain("/abs/skills/ce-plan/SKILL.md");
  });

  it("产出落点给死为确定 outPath + references 绝对前缀 + 降格", () => {
    expect(prompt).toContain(outPath);
    expect(prompt).toContain("/abs/skills/ce-plan/references/");
    expect(prompt).toContain("Task");
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

describe("isLinkedToSession / isDeepeningForSession / notesLinkedToSession（gate）", () => {
  it("isLinkedToSession:conversationIds 含 sessionId（不限状态）", () => {
    expect(
      isLinkedToSession(note({ id: "n1", createdAt: 1, status: "deepened", conversationIds: ["s1"] }), "s1"),
    ).toBe(true);
    expect(
      isLinkedToSession(note({ id: "n1", createdAt: 1, status: "draft", conversationIds: ["s1"] }), "s1"),
    ).toBe(true);
    expect(
      isLinkedToSession(note({ id: "n1", createdAt: 1, conversationIds: ["other"] }), "s1"),
    ).toBe(false);
  });

  it("isDeepeningForSession:仅 deepening 且含 sessionId", () => {
    expect(
      isDeepeningForSession(note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: ["s1"] }), "s1"),
    ).toBe(true);
    expect(
      isDeepeningForSession(note({ id: "n1", createdAt: 1, status: "deepened", conversationIds: ["s1"] }), "s1"),
    ).toBe(false);
    expect(
      isDeepeningForSession(note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: ["other"] }), "s1"),
    ).toBe(false);
  });

  it("notesLinkedToSession 筛出关联本会话的（deepening 或 deepened,不含其它会话/draft）", () => {
    const all = [
      note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: ["s1"] }),
      note({ id: "n2", createdAt: 2, status: "deepened", conversationIds: ["s1"] }),
      note({ id: "n3", createdAt: 3, status: "deepening", conversationIds: ["s2"] }),
      note({ id: "n4", createdAt: 4, status: "draft" }),
    ];
    expect(notesLinkedToSession(all, "s1").map((n) => n.id).sort()).toEqual(["n1", "n2"]);
  });
});

describe("cancelDeepenPlan（取消深化:待杀会话 + 回落 draft,纯函数）", () => {
  it("deepening + 有 conversationIds → 待杀会话取末项,patch 回落 draft", () => {
    const plan = cancelDeepenPlan(
      note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: ["sOld", "sCur"] }),
    );
    expect(plan).toEqual({ sessionId: "sCur", patch: { status: "draft" } });
  });

  it("deepening + 无 conversationIds（重载后孤儿态/断链）→ sessionId undefined,仍回落 draft", () => {
    expect(cancelDeepenPlan(note({ id: "n1", createdAt: 1, status: "deepening" }))).toEqual({
      sessionId: undefined,
      patch: { status: "draft" },
    });
    expect(
      cancelDeepenPlan(note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [] })),
    ).toEqual({ sessionId: undefined, patch: { status: "draft" } });
  });

  it("非 deepening（draft / deepened）→ null,不触碰", () => {
    expect(cancelDeepenPlan(note({ id: "n1", createdAt: 1, status: "draft" }))).toBeNull();
    expect(
      cancelDeepenPlan(note({ id: "n1", createdAt: 1, status: "deepened", conversationIds: ["s1"] })),
    ).toBeNull();
  });

  it("patch 只含 status:draft → 保留 docPaths/conversationIds（编排层全数组写回不丢已产出链接）", () => {
    const plan = cancelDeepenPlan(
      note({
        id: "n1",
        createdAt: 1,
        status: "deepening",
        conversationIds: ["s1"],
        docPaths: ["/docs/ideation/s1-deepen.md"],
      }),
    );
    // 纯函数不动 docPaths/conversationIds（patch 不含它们 → notesUpdate 不覆盖）。
    expect(plan?.patch).toEqual({ status: "draft" });
    expect(plan?.patch).not.toHaveProperty("docPaths");
    expect(plan?.patch).not.toHaveProperty("conversationIds");
  });
});

describe("deepenStateTransition（produced 布尔 + status 分流,纯函数）", () => {
  const cwd = "/home/me/proj";
  const sid = "sess-1";

  // ── deepening（深化 run）分流 ──
  it("deepening + produced → deepened + 追加 deepenDocPath", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
      cwd,
      sessionId: sid,
      produced: true,
      terminalFailure: false,
    });
    expect(patch).toEqual({ status: "deepened", docPaths: [deepenDocPath(cwd, sid)] });
  });

  it("deepening + 再深化:已有 docPaths 追加不覆盖", () => {
    const old = "/home/me/proj/docs/ideation/old-deepen.md";
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: ["old", sid], docPaths: [old] }),
      cwd,
      sessionId: sid,
      produced: true,
      terminalFailure: false,
    });
    expect(patch).toEqual({ status: "deepened", docPaths: [old, deepenDocPath(cwd, sid)] });
  });

  it("deepening + 无产出非失败（澄清轮）→ null（保持 deepening）", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
      cwd,
      sessionId: sid,
      produced: false,
      terminalFailure: false,
    });
    expect(patch).toBeNull();
  });

  it("deepening + terminalFailure → 回落 draft（优先于产出）", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
      cwd,
      sessionId: sid,
      produced: true,
      terminalFailure: true,
    });
    expect(patch).toEqual({ status: "draft" });
  });

  // ── deepened（生成 plan run）分流 ──
  it("deepened + produced → 仅追加 planDocPath,不改 status", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepened", conversationIds: [sid], docPaths: [deepenDocPath(cwd, sid)] }),
      cwd,
      sessionId: sid,
      produced: true,
      terminalFailure: false,
    });
    expect(patch).toEqual({ docPaths: [deepenDocPath(cwd, sid), planDocPath(cwd, sid)] });
  });

  it("deepened + terminalFailure → null（绝不回落,保护已深化成果）", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepened", conversationIds: [sid] }),
      cwd,
      sessionId: sid,
      produced: false,
      terminalFailure: true,
    });
    expect(patch).toBeNull();
  });

  it("deepened + 无产出 → null", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "deepened", conversationIds: [sid] }),
      cwd,
      sessionId: sid,
      produced: false,
      terminalFailure: false,
    });
    expect(patch).toBeNull();
  });

  // ── draft 不触碰 ──
  it("draft → null（不触碰,即使 produced）", () => {
    const patch = deepenStateTransition({
      note: note({ id: "n1", createdAt: 1, status: "draft", conversationIds: [sid] }),
      cwd,
      sessionId: sid,
      produced: true,
      terminalFailure: false,
    });
    expect(patch).toBeNull();
  });
});

describe("applyDeepenFinalize（fs.exists 探测 + gate 扩展 deepening/deepened,严格降级）", () => {
  function makeBridge(notes: NoteMeta[], existing: Set<string> = new Set()) {
    const updates: { id: string; patch: unknown }[] = [];
    const bridge = {
      notesList: vi.fn(async () => notes),
      notesUpdate: vi.fn(async (id: string, patch: unknown) => {
        updates.push({ id, patch });
        return notes.find((n) => n.id === id) ?? null;
      }),
      fileExists: vi.fn(async (path: string) => existing.has(path)),
    } as unknown as DesktopBridge;
    return { bridge, updates };
  }

  const cwd = "/home/me/proj";
  const sid = "sess-1";

  it("普通会话（无关联闪记）→ 完全 no-op,不读写", async () => {
    const { bridge, updates } = makeBridge([
      note({ id: "n1", createdAt: 1, status: "draft" }),
      note({ id: "n2", createdAt: 2, status: "deepening", conversationIds: ["other-sess"] }),
    ]);
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, terminalFailure: false });
    expect(updates).toEqual([]);
    expect((bridge.notesUpdate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("deepening + 探测到 deepenDocPath → 置 deepened + docPaths", async () => {
    const { bridge, updates } = makeBridge(
      [note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] })],
      new Set([deepenDocPath(cwd, sid)]),
    );
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, terminalFailure: false });
    expect(updates).toEqual([{ id: "n1", patch: { status: "deepened", docPaths: [deepenDocPath(cwd, sid)] } }]);
  });

  it("deepening + 未探测到产出（澄清轮）→ 不写,保持 deepening", async () => {
    const { bridge, updates } = makeBridge([
      note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
    ]);
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, terminalFailure: false });
    expect(updates).toEqual([]);
  });

  it("deepening + terminalFailure → 回落 draft（不探测）", async () => {
    const { bridge, updates } = makeBridge([
      note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
    ]);
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, terminalFailure: true });
    expect(updates).toEqual([{ id: "n1", patch: { status: "draft" } }]);
  });

  it("deepened（plan run）+ 探测到 planDocPath → 仅追加 docPaths,不改 status", async () => {
    const { bridge, updates } = makeBridge(
      [note({ id: "n1", createdAt: 1, status: "deepened", conversationIds: [sid], docPaths: [deepenDocPath(cwd, sid)] })],
      new Set([planDocPath(cwd, sid)]),
    );
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, terminalFailure: false });
    expect(updates).toEqual([
      { id: "n1", patch: { docPaths: [deepenDocPath(cwd, sid), planDocPath(cwd, sid)] } },
    ]);
  });

  it("deepened（plan run）+ terminalFailure → 不回落、不写（保护已深化成果）", async () => {
    const { bridge, updates } = makeBridge([
      note({ id: "n1", createdAt: 1, status: "deepened", conversationIds: [sid] }),
    ]);
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, terminalFailure: true });
    expect(updates).toEqual([]);
  });

  it("多条同会话 deepening → 全部按同一规则迁移", async () => {
    const { bridge, updates } = makeBridge(
      [
        note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] }),
        note({ id: "n2", createdAt: 2, status: "deepening", conversationIds: [sid] }),
      ],
      new Set([deepenDocPath(cwd, sid)]),
    );
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, terminalFailure: false });
    expect(updates.map((u) => u.id).sort()).toEqual(["n1", "n2"]);
    for (const u of updates) {
      expect(u.patch).toEqual({ status: "deepened", docPaths: [deepenDocPath(cwd, sid)] });
    }
  });

  it("bridge 缺 notesList/notesUpdate（web/旧壳）→ 安全降级,不抛", async () => {
    await expect(
      applyDeepenFinalize(null, { sessionId: sid, cwd, terminalFailure: false }),
    ).resolves.toBeUndefined();
    await expect(
      applyDeepenFinalize({} as DesktopBridge, { sessionId: sid, cwd, terminalFailure: false }),
    ).resolves.toBeUndefined();
  });

  it("缺 fileExists（旧壳）→ 探测降级 false,不误判已深化（保持 deepening）", async () => {
    const updates: { id: string; patch: unknown }[] = [];
    const bridge = {
      notesList: vi.fn(async () => [note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] })]),
      notesUpdate: vi.fn(async (id: string, patch: unknown) => {
        updates.push({ id, patch });
        return null;
      }),
      // 无 fileExists
    } as unknown as DesktopBridge;
    await applyDeepenFinalize(bridge, { sessionId: sid, cwd, terminalFailure: false });
    expect(updates).toEqual([]);
  });

  it("notesList 拉取失败 → 静默,不抛、不调用 notesUpdate", async () => {
    const bridge = {
      notesList: vi.fn(async () => {
        throw new Error("io");
      }),
      notesUpdate: vi.fn(),
    } as unknown as DesktopBridge;
    await expect(
      applyDeepenFinalize(bridge, { sessionId: sid, cwd, terminalFailure: false }),
    ).resolves.toBeUndefined();
    expect((bridge.notesUpdate as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("cwd 缺失:终态失败仍回落 deepening,非失败保持原状", async () => {
    const failing = makeBridge([note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] })]);
    await applyDeepenFinalize(failing.bridge, { sessionId: sid, cwd: undefined, terminalFailure: true });
    expect(failing.updates).toEqual([{ id: "n1", patch: { status: "draft" } }]);

    const ok = makeBridge([note({ id: "n1", createdAt: 1, status: "deepening", conversationIds: [sid] })]);
    await applyDeepenFinalize(ok.bridge, { sessionId: sid, cwd: undefined, terminalFailure: false });
    expect(ok.updates).toEqual([]);
  });
});
