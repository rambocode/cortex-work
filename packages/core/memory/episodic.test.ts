// 情景记忆采样纯函数测试：水位判定、正文抽取（噪音过滤）、预算截断、增量消化。
import { describe, expect, it } from "vitest";
import {
  extractEpisodeLines,
  hasUndigestedMessages,
  sampleUndigestedEpisodes,
  type EpisodicSessionInput,
} from "./episodic";

const textMsg = (who: string, text: unknown) => ({ kind: "text", who, time: "10:00", text });

function session(id: string, messages: unknown[], lastActivity = 0): EpisodicSessionInput {
  return { sessionId: id, title: `会话${id}`, lastActivity, messages };
}

describe("extractEpisodeLines 正文抽取", () => {
  it("只取 text 消息，用户/助手前缀区分，过滤过程噪音", () => {
    const messages = [
      { kind: "day", label: "今天" },
      textMsg("me", "我在做 cortex 桌面端"),
      { kind: "typing", who: "claude", text: "…" },
      { kind: "reasoning", who: "claude", time: "10:01", text: "思考中" },
      { kind: "agentLog", who: "claude", time: "10:01", title: "工具", items: [] },
      textMsg("claude", "好的，已了解"),
      textMsg("me", "   "), // 空白正文丢弃
    ];
    expect(extractEpisodeLines(messages)).toEqual(["用户：我在做 cortex 桌面端", "助手：好的，已了解"]);
  });

  it("RichText parts 拼接为纯文本；异形消息不抛错", () => {
    const messages = [
      textMsg("me", { kind: "rich", parts: [{ t: "text", v: "看下 " }, { t: "path", v: "a.ts" }] }),
      null,
      42,
      { kind: "text", who: "me", text: { broken: true } },
    ];
    expect(extractEpisodeLines(messages)).toEqual(["用户：看下 a.ts"]);
  });
});

describe("水位判定与增量消化", () => {
  it("消息数超过水位才算未消化", () => {
    const input = session("s1", [textMsg("me", "a"), textMsg("me", "b")]);
    expect(hasUndigestedMessages(input, {})).toBe(true);
    expect(hasUndigestedMessages(input, { s1: { digestedMsgCount: 2, digestedAt: 1 } })).toBe(false);
    expect(hasUndigestedMessages(input, { s1: { digestedMsgCount: 1, digestedAt: 1 } })).toBe(true);
  });

  it("只消化水位之后的新增消息，watermark 推进到当前总数", () => {
    const input = session("s1", [textMsg("me", "旧消息"), textMsg("me", "新消息")]);
    const { episodes, watermarks } = sampleUndigestedEpisodes(
      [input],
      { s1: { digestedMsgCount: 1, digestedAt: 1 } },
    );
    expect(episodes[0]?.lines).toEqual(["用户：新消息"]);
    expect(watermarks).toEqual({ s1: 2 });
  });

  it("新增消息全是噪音时不产出 episode 但仍推进水位", () => {
    const input = session("s1", [{ kind: "typing", who: "x", text: "…" }]);
    const { episodes, watermarks } = sampleUndigestedEpisodes([input], {});
    expect(episodes).toEqual([]);
    expect(watermarks).toEqual({ s1: 1 });
  });
});

describe("预算截断", () => {
  it("按最近活动降序取前 maxSessions 个会话", () => {
    const inputs = [
      session("old", [textMsg("me", "旧")], 1),
      session("mid", [textMsg("me", "中")], 2),
      session("new", [textMsg("me", "新")], 3),
    ];
    const { episodes } = sampleUndigestedEpisodes(inputs, {}, {
      maxSessions: 2,
      maxCharsPerSession: 100,
      maxTotalChars: 1000,
    });
    expect(episodes.map((e) => e.sessionId)).toEqual(["new", "mid"]);
  });

  it("单会话超预算时保留最近的行", () => {
    const input = session("s1", [textMsg("me", "很旧的一大段内容".repeat(10)), textMsg("me", "最新的话")]);
    const { episodes } = sampleUndigestedEpisodes([input], {}, {
      maxSessions: 5,
      maxCharsPerSession: 30,
      maxTotalChars: 1000,
    });
    expect(episodes[0]?.lines).toEqual(["用户：最新的话"]);
  });

  it("合计超总预算时不再纳入后续会话，其水位不推进（下次再消化）", () => {
    const inputs = [
      session("a", [textMsg("me", "x".repeat(50))], 3),
      session("b", [textMsg("me", "y".repeat(50))], 2),
      session("c", [textMsg("me", "z".repeat(50))], 1),
    ];
    const { episodes, watermarks } = sampleUndigestedEpisodes(inputs, {}, {
      maxSessions: 10,
      maxCharsPerSession: 200,
      maxTotalChars: 60,
    });
    expect(episodes.map((e) => e.sessionId)).toEqual(["a"]);
    expect(Object.keys(watermarks)).toEqual(["a"]);
  });
});
