import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types";
import type { DesktopBridge } from "../desktop/bridge";
import type { NoteMeta, SessionMeta, TimelineEvent } from "../desktop/types";
import { usePersonalStore } from "../store/personal";
import {
  buildCalendarWeeks,
  buildDailyReportText,
  buildGlobalSummaryPrompt,
  buildPushReportData,
  completeWithSummaryModel,
  SummaryModelNotConfiguredError,
  dayKey,
  DEFAULT_PUSH_TEMPLATE,
  deriveBackfillEvents,
  enabledPushTargets,
  extractChangedFile,
  groupEventsByDay,
  noteEvents,
  NOTE_EVENTS_SOFT_CAP,
  promptTitle,
  renderPushReport,
  sessionCreatedEvents,
} from "./timeline";

function ev(partial: Partial<TimelineEvent> & { ts: number }): TimelineEvent {
  return { id: `e-${partial.ts}`, projectId: "p1", kind: "run", title: "t", ...partial };
}

function note(partial: Partial<NoteMeta> & { id: string; createdAt: number }): NoteMeta {
  return {
    projectId: "p1",
    status: "draft",
    content: `内容 ${partial.id}`,
    updatedAt: partial.createdAt,
    ...partial,
  };
}

const T0 = new Date(2026, 5, 10, 9, 0, 0).getTime(); // 2026-06-10 09:00 本地时间

describe("dayKey", () => {
  it("按本地时间生成 YYYY-MM-DD", () => {
    expect(dayKey(T0)).toBe("2026-06-10");
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });
});

describe("groupEventsByDay", () => {
  it("按天分组、天倒序、组内升序,并统计去重文件数", () => {
    const groups = groupEventsByDay([
      ev({ ts: T0 + 3600_000, files: ["a.ts", "b.ts"] }),
      ev({ ts: T0, files: ["a.ts"] }),
      ev({ ts: T0 - 86400_000, kind: "session.created" }),
    ]);
    expect(groups.map((g) => g.day)).toEqual(["2026-06-10", "2026-06-09"]);
    expect(groups[0]?.events.map((e) => e.ts)).toEqual([T0, T0 + 3600_000]);
    expect(groups[0]?.stats).toEqual({ sessions: 0, runs: 2, files: 2, commits: 0, notes: 0 });
    expect(groups[1]?.stats.sessions).toBe(1);
  });

  it("note 事件计入 notes 统计且进事件流,与 run 等其它 kind 共处一天", () => {
    const groups = groupEventsByDay([
      ev({ ts: T0, kind: "run" }),
      ev({ ts: T0 + 1000, id: "note-x", kind: "note", title: "闪记", meta: { noteId: "x", noteStatus: "draft" } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.stats).toMatchObject({ runs: 1, notes: 1 });
    expect(groups[0]?.events).toHaveLength(2); // note 进事件流,计入当日事件数
  });

  it("summary.day 按 meta.day 归位且不进事件流,重复时保留最新", () => {
    const groups = groupEventsByDay([
      ev({ ts: T0 }),
      ev({ ts: T0 + 86400_000, kind: "summary.day", summary: "旧", meta: { day: "2026-06-10" } }),
      ev({ ts: T0 + 2 * 86400_000, kind: "summary.day", summary: "新", meta: { day: "2026-06-10" } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.summary?.summary).toBe("新");
    expect(groups[0]?.events).toHaveLength(1);
  });
});

describe("buildCalendarWeeks", () => {
  it("周一为一周第一天,网格覆盖整月", () => {
    // 2026-06-01 是周一。
    const weeks = buildCalendarWeeks(2026, 5, []);
    expect(weeks[0]?.[0]?.day).toBe("2026-06-01");
    const lastCell = weeks.at(-1)?.[6];
    expect(lastCell && (lastCell.inMonth === false || lastCell.day.startsWith("2026-06"))).toBe(true);
    expect(weeks.flat().filter((c) => c.inMonth)).toHaveLength(30);
  });

  it("月首非周一时补前导外月格,并挂上统计", () => {
    // 2026-05-01 是周五 → 前导 4 格（周一到周四属 4 月）。
    const groups = groupEventsByDay([ev({ ts: new Date(2026, 4, 1, 12, 0).getTime() })]);
    const weeks = buildCalendarWeeks(2026, 4, groups);
    expect(weeks[0]?.filter((c) => !c.inMonth)).toHaveLength(4);
    const first = weeks[0]?.find((c) => c.day === "2026-05-01");
    expect(first?.stats?.runs).toBe(1);
  });
});

describe("extractChangedFile", () => {
  it("写类工具提取相对路径,读类工具忽略", () => {
    expect(extractChangedFile("Edit", "/proj/src/a.ts", "/proj")).toBe("src/a.ts");
    expect(extractChangedFile("Write", "src/a.ts", "/proj")).toBe("src/a.ts");
    expect(extractChangedFile("Read", "/proj/src/a.ts", "/proj")).toBeUndefined();
    expect(extractChangedFile("Bash", "rm -rf x", "/proj")).toBeUndefined();
  });

  it("被截断的 detail 不可信,丢弃", () => {
    expect(extractChangedFile("Edit", "/proj/very/long/path…", "/proj")).toBeUndefined();
  });
});

describe("promptTitle", () => {
  it("取首个非空行并截断", () => {
    expect(promptTitle("\n  修复登录超时\n详情…")).toBe("修复登录超时");
    expect(promptTitle("x".repeat(80))).toBe("x".repeat(60) + "…");
    expect(promptTitle("  ")).toBe("（空提示）");
  });
});

describe("sessionCreatedEvents", () => {
  it("只合成本项目的会话", () => {
    const sessions: SessionMeta[] = [
      { id: "s1", projectId: "p1", title: "A", agent: "claude", createdAt: T0, updatedAt: T0 },
      { id: "s2", projectId: "p2", title: "B", agent: "codex", createdAt: T0, updatedAt: T0 },
    ];
    const events = sessionCreatedEvents(sessions, "p1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "session.created", sessionId: "s1", title: "A" });
  });
});

describe("noteEvents", () => {
  afterEach(() => vi.restoreAllMocks());

  it("只合成本项目的闪记,字段映射正确", () => {
    const notes: NoteMeta[] = [
      note({ id: "n1", createdAt: T0, content: "想法一", sourceSessionId: "s1", status: "deepened" }),
      note({ id: "n2", createdAt: T0 + 1000, content: "想法二" }),
      note({ id: "x1", createdAt: T0, projectId: "p2", content: "别的项目" }),
    ];
    const events = noteEvents(notes, "p1");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: "note-n1",
      kind: "note",
      projectId: "p1",
      sessionId: "s1",
      ts: T0,
      title: "想法一",
      summary: "想法一",
      meta: { noteId: "n1", noteStatus: "deepened" },
    });
    expect(events[1]).toMatchObject({ id: "note-n2", meta: { noteId: "n2", noteStatus: "draft" } });
  });

  it("3 条闪记按天分组,groupEventsByDay 含 notes 计数且计入当日事件数", () => {
    const notes: NoteMeta[] = [
      note({ id: "a", createdAt: T0 }),
      note({ id: "b", createdAt: T0 + 3600_000 }),
      note({ id: "c", createdAt: T0 - 86400_000 }),
    ];
    const groups = groupEventsByDay(noteEvents(notes, "p1"));
    expect(groups.map((g) => g.day)).toEqual(["2026-06-10", "2026-06-09"]);
    expect(groups[0]?.stats.notes).toBe(2);
    expect(groups[1]?.stats.notes).toBe(1);
    // note 计入「当日事件数」（进 g.events,与其它 kind 口径一致）。
    expect(groups[0]?.events).toHaveLength(2);
  });

  it("编辑闪记内容后合成事件的标题/正文更新（单一来源,不双写）", () => {
    const before = noteEvents([note({ id: "n1", createdAt: T0, content: "旧内容" })], "p1");
    expect(before[0]?.title).toBe("旧内容");
    expect(before[0]?.summary).toBe("旧内容");
    const after = noteEvents([note({ id: "n1", createdAt: T0, content: "新内容" })], "p1");
    expect(after[0]?.id).toBe("note-n1"); // id 稳定
    expect(after[0]?.title).toBe("新内容");
    expect(after[0]?.summary).toBe("新内容");
  });

  it("删除闪记后该 note 事件消失（无落盘双写）", () => {
    const full = noteEvents([note({ id: "n1", createdAt: T0 }), note({ id: "n2", createdAt: T0 + 1 })], "p1");
    expect(full.map((e) => e.id)).toEqual(["note-n1", "note-n2"]);
    const afterDelete = noteEvents([note({ id: "n2", createdAt: T0 + 1 })], "p1");
    expect(afterDelete.map((e) => e.id)).toEqual(["note-n2"]);
  });

  it("超软上限仅合成最近 500 条并 console.warn,升序还原", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const total = NOTE_EVENTS_SOFT_CAP + 5;
    // createdAt 递增：i=0 最旧,i=total-1 最新。
    const notes: NoteMeta[] = Array.from({ length: total }, (_, i) => note({ id: `n${i}`, createdAt: T0 + i }));
    const events = noteEvents(notes, "p1");
    expect(events).toHaveLength(NOTE_EVENTS_SOFT_CAP);
    expect(warn).toHaveBeenCalledOnce();
    // 取最近 500（最旧被丢）：首条应为 n5（ts=T0+5）,末条为 n{total-1}。
    expect(events[0]?.id).toBe("note-n5");
    expect(events.at(-1)?.id).toBe(`note-n${total - 1}`);
    // 升序还原：ts 单调递增。
    expect(events.every((e, i) => i === 0 || e.ts >= events[i - 1]!.ts)).toBe(true);
  });

  it("空正文闪记标题兜底为占位文案", () => {
    const events = noteEvents([note({ id: "n1", createdAt: T0, content: "   " })], "p1");
    expect(events[0]?.title).toBe("（空闪记）");
  });
});

describe("deriveBackfillEvents", () => {
  const sess: SessionMeta = { id: "s1", projectId: "p1", title: "A", agent: "claude", createdAt: T0, updatedAt: T0 };

  it("用户消息生成 run 事件,配对其后 agent 回复为摘要,归到 updatedAt", () => {
    const messages: Message[] = [
      { kind: "text", who: "me", time: "09:00", text: "实现登录\n细节…" },
      { kind: "agentLog", who: "claude", time: "09:01", title: "执行", items: [] },
      { kind: "text", who: "claude", time: "09:02", text: "已完成登录实现" },
      { kind: "text", who: "me", time: "10:00", text: "再加个测试" },
    ];
    const events = deriveBackfillEvents([sess], "p1", { s1: messages });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      kind: "run",
      title: "实现登录",
      summary: "已完成登录实现",
      ts: T0,
      meta: { agent: "claude", backfilled: true },
    });
    expect(events[1]).toMatchObject({ title: "再加个测试", ts: T0 + 1 }); // 偏移保序
    expect(events[1]?.summary).toBeUndefined();
  });

  it("跳过 rich 文本与其他项目的会话", () => {
    const rich: Message[] = [{ kind: "text", who: "me", time: "09:00", text: { kind: "rich", parts: [] } }];
    expect(deriveBackfillEvents([sess], "p1", { s1: rich })).toHaveLength(0);
    expect(deriveBackfillEvents([{ ...sess, projectId: "p2" }], "p1", { s1: [] })).toHaveLength(0);
  });
});

describe("buildDailyReportText", () => {
  it("有日报时正文用日报,标题含项目与日期", () => {
    const groups = groupEventsByDay([
      ev({ ts: T0, title: "修复登录", files: ["a.ts"] }),
      ev({ ts: T0 + 1000, kind: "summary.day", summary: "今天主要修复了登录。", meta: { day: "2026-06-10" } }),
    ]);
    const { subject, text } = buildDailyReportText("demo", groups[0]!);
    expect(subject).toBe("【demo】2026-06-10 工作日报");
    expect(text).toContain("1 轮交互 · 1 个文件变更");
    expect(text).toContain("今天主要修复了登录。");
  });

  it("无日报时退化为 run 标题列表", () => {
    const groups = groupEventsByDay([ev({ ts: T0, title: "修复登录" }), ev({ ts: T0 + 1, title: "加测试" })]);
    const { text } = buildDailyReportText("demo", groups[0]!);
    expect(text).toContain("· 修复登录");
    expect(text).toContain("· 加测试");
  });
});

describe("enabledPushTargets", () => {
  it("只返回启用且配置完整的渠道,空 secret 归一为 undefined", () => {
    const targets = enabledPushTargets({
      wecom: { enabled: true, webhookUrl: "https://qyapi.weixin.qq.com/x" },
      dingtalk: { enabled: true, webhookUrl: "https://oapi.dingtalk.com/x", secret: "" },
      email: { enabled: false, smtpHost: "smtp.qq.com", smtpPort: 465, secure: true, user: "u", pass: "p", from: "", to: "a@b.c" },
    });
    expect(targets.map((t) => t.target.kind)).toEqual(["wecom", "dingtalk"]);
    const ding = targets[1]!.target;
    expect(ding.kind === "dingtalk" && ding.secret).toBeUndefined();
  });

  it("渠道启用但缺关键字段时不返回", () => {
    expect(enabledPushTargets({ wecom: { enabled: true, webhookUrl: "" } })).toHaveLength(0);
  });
});

describe("renderPushReport", () => {
  const data = {
    project: "demo",
    date: "2026-06-10",
    stats: "2 轮交互",
    summary: "",
    runs: "· 修复登录\n· 加测试",
    files: "· src/a.ts",
    commits: "",
  };

  it("占位符替换,首行剥 markdown 标记作为标题", () => {
    const { subject, text } = renderPushReport("# 【{{project}}】{{date}}\n\n{{runs}}", data);
    expect(subject).toBe("【demo】2026-06-10");
    expect(text).toContain("· 修复登录");
    expect(text.startsWith("# 【demo】")).toBe(true);
  });

  it("数据为空的占位符行整行剔除,未知占位符原样保留", () => {
    const { text } = renderPushReport("标题\n{{summary}}\n{{commits}}\n{{unknown}}\n{{runs}}", data);
    expect(text).not.toContain("{{summary}}");
    expect(text.split("\n").filter((l: string) => l === "")).toHaveLength(0);
    expect(text).toContain("{{unknown}}");
  });

  it("默认模板:无日报时不留空行,有统计与事项", () => {
    const { subject, text } = renderPushReport(DEFAULT_PUSH_TEMPLATE, data);
    expect(subject).toBe("【demo】2026-06-10 工作日报");
    expect(text).toContain("2 轮交互");
    expect(text).toContain("今日事项:");
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe("buildGlobalSummaryPrompt", () => {
  const entries = (names: string[]) =>
    names.map((projectName) => ({
      projectName,
      group: groupEventsByDay([ev({ ts: T0, title: `${projectName} 的工作` })])[0]!,
    }));

  it("按项目分节,含日期与项目数", () => {
    const prompt = buildGlobalSummaryPrompt("2026-06-10", entries(["alpha", "beta"]));
    expect(prompt).toContain("2026-06-10");
    expect(prompt).toContain("2 个项目");
    expect(prompt).toContain("## 项目「alpha」");
    expect(prompt).toContain("## 项目「beta」");
    expect(prompt).toContain("- [run] alpha 的工作");
  });

  it("事件行带结果与文件,正文整体截断", () => {
    const group = groupEventsByDay([
      ev({ ts: T0, title: "修复", summary: "完成了。", files: ["a.ts"] }),
    ])[0]!;
    const prompt = buildGlobalSummaryPrompt("2026-06-10", [{ projectName: "demo", group }]);
    expect(prompt).toContain("结果:完成了。");
    expect(prompt).toContain("文件:a.ts");
    const big = groupEventsByDay([ev({ ts: T0, title: "x".repeat(50), summary: "y".repeat(200) })])[0]!;
    const long = buildGlobalSummaryPrompt(
      "2026-06-10",
      Array.from({ length: 200 }, (_, i) => ({ projectName: `p${i}`, group: big })),
    );
    expect(long.length).toBeLessThan(6500);
  });
});

// 阶段③ 收编后的契约：渲染端只传 providerId（endpoint 与密钥由主进程从 Catalog/prefs/金库解析），
// 且**悬空引用一律抛错阻断**——旧的两条静默回退（回退 defaultProviderId、退化成「裸 pi」）已被
// 刻意移除：§5 清理掉 providerSettings 后它们会变成「每次都静默换模型」，用户拿到一份不知道
// 是谁生成的日报。下面几条用例就是这两条回退的回归护栏。
describe("completeWithSummaryModel", () => {
  const fakeBridge = () =>
    ({
      oneshotCli: vi.fn().mockResolvedValue("结果"),
      openaiComplete: vi.fn().mockResolvedValue("结果"),
    }) as unknown as DesktopBridge;

  it("gateway:按 Catalog 引用调 openaiComplete，明文密钥不过桥", async () => {
    const bridge = fakeBridge();
    usePersonalStore.setState({
      timelineSettings: { summaryModel: { kind: "gateway", ref: { providerId: "deepseek", modelId: "deepseek-chat" } } },
    });
    await completeWithSummaryModel(bridge, "p");
    expect(bridge.openaiComplete).toHaveBeenCalledWith({
      providerId: "deepseek",
      modelId: "deepseek-chat",
      prompt: "p",
    });
  });

  it("gateway:ref 缺省 → 抛阻断错误，不发任何请求", async () => {
    const bridge = fakeBridge();
    usePersonalStore.setState({ timelineSettings: { summaryModel: { kind: "gateway" } } });
    await expect(completeWithSummaryModel(bridge, "p")).rejects.toThrow(SummaryModelNotConfiguredError);
    expect(bridge.openaiComplete).not.toHaveBeenCalled();
    expect(bridge.oneshotCli).not.toHaveBeenCalled();
  });

  it("pi:只传 providerId，不再拍平 baseUrl/apiKey", async () => {
    const bridge = fakeBridge();
    usePersonalStore.setState({
      timelineSettings: { summaryModel: { kind: "agent", agent: "pi", providerId: "ds", model: "deepseek-reasoner" } },
    });
    await completeWithSummaryModel(bridge, "p");
    expect(bridge.oneshotCli).toHaveBeenCalledWith({
      prompt: "p",
      agent: "pi",
      model: "deepseek-reasoner",
      providerId: "ds",
    });
  });

  it("pi:无 providerId → 抛阻断错误，不退化成「裸 pi」（旧静默回退的回归护栏）", async () => {
    const bridge = fakeBridge();
    usePersonalStore.setState({
      timelineSettings: { summaryModel: { kind: "agent", agent: "pi", model: "deepseek-chat" } },
    });
    await expect(completeWithSummaryModel(bridge, "p")).rejects.toThrow(SummaryModelNotConfiguredError);
    expect(bridge.oneshotCli).not.toHaveBeenCalled();
  });

  it("claude:不带 providerId 字段", async () => {
    const bridge = fakeBridge();
    usePersonalStore.setState({
      timelineSettings: { summaryModel: { kind: "agent", agent: "claude", model: "haiku" } },
    });
    await completeWithSummaryModel(bridge, "p");
    expect(bridge.oneshotCli).toHaveBeenCalledWith({ prompt: "p", agent: "claude", model: "haiku" });
  });
});

describe("buildPushReportData", () => {
  it("聚合统计/事项/去重文件/提交", () => {
    const groups = groupEventsByDay([
      ev({ ts: T0, title: "修复登录", files: ["a.ts", "b.ts"] }),
      ev({ ts: T0 + 1, title: "加测试", files: ["a.ts"] }),
      ev({ ts: T0 + 2, kind: "git.commit", title: "fix: login", meta: { hash: "abcdef1234" } }),
      ev({ ts: T0 + 3, kind: "summary.day", summary: "概括。", meta: { day: "2026-06-10" } }),
    ]);
    const data = buildPushReportData("demo", groups[0]!);
    expect(data).toMatchObject({ project: "demo", date: "2026-06-10", summary: "概括。" });
    expect(data.stats).toBe("2 轮交互 · 2 个文件变更 · 1 次提交");
    expect(data.runs).toBe("· 修复登录\n· 加测试");
    expect(data.files.split("\n")).toHaveLength(2);
    expect(data.commits).toBe("· abcdef1 fix: login");
  });
});
