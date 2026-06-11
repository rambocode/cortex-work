import { describe, expect, it } from "vitest";
import type { Message } from "../types";
import type { SessionMeta, TimelineEvent } from "../desktop/types";
import {
  buildCalendarWeeks,
  buildDailyReportText,
  dayKey,
  deriveBackfillEvents,
  enabledPushTargets,
  extractChangedFile,
  groupEventsByDay,
  promptTitle,
  sessionCreatedEvents,
} from "./timeline";

function ev(partial: Partial<TimelineEvent> & { ts: number }): TimelineEvent {
  return { id: `e-${partial.ts}`, projectId: "p1", kind: "run", title: "t", ...partial };
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
    expect(groups[0]?.stats).toEqual({ sessions: 0, runs: 2, files: 2, commits: 0 });
    expect(groups[1]?.stats.sessions).toBe(1);
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
      summaryModel: { kind: "agent", agent: "claude" },
      push: {
        wecom: { enabled: true, webhookUrl: "https://qyapi.weixin.qq.com/x" },
        dingtalk: { enabled: true, webhookUrl: "https://oapi.dingtalk.com/x", secret: "" },
        email: { enabled: false, smtpHost: "smtp.qq.com", smtpPort: 465, secure: true, user: "u", pass: "p", from: "", to: "a@b.c" },
      },
    });
    expect(targets.map((t) => t.target.kind)).toEqual(["wecom", "dingtalk"]);
    const ding = targets[1]!.target;
    expect(ding.kind === "dingtalk" && ding.secret).toBeUndefined();
  });

  it("渠道启用但缺关键字段时不返回", () => {
    expect(
      enabledPushTargets({
        summaryModel: { kind: "agent", agent: "claude" },
        push: { wecom: { enabled: true, webhookUrl: "" } },
      }),
    ).toHaveLength(0);
  });
});
