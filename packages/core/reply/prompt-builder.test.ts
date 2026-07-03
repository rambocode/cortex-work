// prompt 构建行为契约测试。断言逐条移植自 ReplyClone ReplyCoreTests.swift。

import { describe, expect, it } from "vitest";
import { buildReplyPrompt } from "./prompt-builder";

describe("buildReplyPrompt", () => {
  it("system 交代标签语义，typedIntent 压制 voice", () => {
    const prompt = buildReplyPrompt({
      conversation: "A: Can we meet tomorrow?\nMe: Maybe.",
      typedIntent: "decline warmly but leave the door open",
      voiceIntent: "accept",
      calendarContext: "Free: Thu 10:00-10:30",
      userProfile: "Prefers concise replies.",
    });
    expect(prompt.system).toContain("only the reply text");
    expect(prompt.system).toContain("我：");
    expect(prompt.system).toContain("对方：");
    expect(prompt.user).toContain("decline warmly but leave the door open");
    expect(prompt.user).not.toContain("Spoken intent");
    expect(prompt.user).toContain("Free: Thu 10:00-10:30");
  });

  it("翻牌：avoidReplies 非空时列出避重列表，空白项过滤", () => {
    const prompt = buildReplyPrompt({
      conversation: "Them: got time today?",
      avoidReplies: ["Sure, 3pm works.", "  ", "Can we do tomorrow instead?"],
    });
    expect(prompt.user).toContain("Already suggested replies");
    expect(prompt.user).toContain("- Sure, 3pm works.");
    expect(prompt.user).toContain("- Can we do tomorrow instead?");
  });

  it("全空白避重列表 → 无翻牌段", () => {
    const prompt = buildReplyPrompt({
      conversation: "Them: ping",
      avoidReplies: ["   "],
    });
    expect(prompt.user).not.toContain("Already suggested replies");
  });

  it("typedIntent 空白时回退 Spoken intent", () => {
    const prompt = buildReplyPrompt({
      conversation: "Them: ping",
      typedIntent: "  ",
      voiceIntent: "ask for Friday afternoon",
    });
    expect(prompt.user).toContain("Spoken intent");
    expect(prompt.user).toContain("ask for Friday afternoon");
  });

  it("段落序：档案记忆 → 可见对话 → 意图 → 日历 → 避重 → 定向立场 → 收尾指令", () => {
    const prompt = buildReplyPrompt({
      conversation: "Them: hi",
      typedIntent: "be brief",
      calendarContext: "可用时间：09:00-09:30",
      userProfile: "my profile",
      avoidReplies: ["prev reply"],
      requestedStance: "reject",
    });
    const idxProfile = prompt.user.indexOf("User profile:");
    const idxConversation = prompt.user.indexOf("Visible conversation:");
    const idxIntent = prompt.user.indexOf("Typed intent");
    const idxCalendar = prompt.user.indexOf("Calendar availability");
    const idxAvoid = prompt.user.indexOf("Already suggested replies");
    const idxStance = prompt.user.indexOf("Required stance");
    const idxClosing = prompt.user.indexOf("First line: the stance tag");
    expect(idxProfile).toBeGreaterThanOrEqual(0);
    expect(idxProfile).toBeLessThan(idxConversation);
    expect(idxConversation).toBeLessThan(idxIntent);
    expect(idxIntent).toBeLessThan(idxCalendar);
    expect(idxCalendar).toBeLessThan(idxAvoid);
    expect(idxAvoid).toBeLessThan(idxStance);
    expect(idxStance).toBeLessThan(idxClosing);
  });

  it("conversationMemory 非空时注入在档案之后、可见对话之前；空白时无该段", () => {
    const prompt = buildReplyPrompt({
      conversation: "Them: hi",
      userProfile: "my profile",
      conversationMemory: "与「张玲玲」的既往互动要点：\n- 财务同事",
    });
    const idxProfile = prompt.user.indexOf("User profile:");
    const idxMemory = prompt.user.indexOf("与「张玲玲」的既往互动要点");
    const idxConversation = prompt.user.indexOf("Visible conversation");
    expect(idxMemory).toBeGreaterThan(idxProfile);
    expect(idxMemory).toBeLessThan(idxConversation);

    const without = buildReplyPrompt({ conversation: "Them: hi", conversationMemory: "  " });
    expect(without.user).not.toContain("既往互动要点");
  });

  it("requestedStance 非空时追加定向立场段，三档语义句各不相同", () => {
    const agree = buildReplyPrompt({ conversation: "对方：能接吗？", requestedStance: "agree" });
    const reject = buildReplyPrompt({ conversation: "对方：能接吗？", requestedStance: "reject" });
    const unsure = buildReplyPrompt({ conversation: "对方：能接吗？", requestedStance: "unsure" });
    expect(agree.user).toContain("Required stance");
    expect(agree.user).toContain("accept the request");
    expect(reject.user).toContain("decline the request");
    expect(unsure.user).toContain("clarifying question");
  });

  it("requestedStance 为 null / 缺省时无定向立场段", () => {
    expect(buildReplyPrompt({ conversation: "对方：ping" }).user).not.toContain("Required stance");
    expect(
      buildReplyPrompt({ conversation: "对方：ping", requestedStance: null }).user,
    ).not.toContain("Required stance");
  });

  it("system 含立场标记协议与 IM 风格约束（缓存约束：单一静态 system）", () => {
    const a = buildReplyPrompt({ conversation: "对方：ping" });
    const b = buildReplyPrompt({
      conversation: "别的对话",
      requestedStance: "agree",
      avoidReplies: ["x"],
    });
    // 协议锚点：四种标记 tag 都在 system 中交代
    expect(a.system).toContain("[stance:agree]");
    expect(a.system).toContain("[stance:reject]");
    expect(a.system).toContain("[stance:unsure]");
    expect(a.system).toContain("[stance:none]");
    // IM 风格锚点
    expect(a.system).toContain("instant message");
    expect(a.system).toContain("希望这能帮到你");
    // 缓存约束：system 不随调用参数变化
    expect(a.system).toBe(b.system);
  });

  it("counterpartName 非空时随可见对话段注入对方身份", () => {
    const prompt = buildReplyPrompt({
      conversation: "对方：在吗？\n我：在的",
      counterpartName: "张玲玲-财务",
    });
    expect(prompt.user).toContain('the other person "对方" is: 张玲玲-财务');
    // 仍在可见对话段内，不新增独立 section（段落序契约不变）
    expect(prompt.user).toContain("Visible conversation (the other person");
  });

  it("counterpartName 空白时退回泛化 Visible conversation 段头", () => {
    const prompt = buildReplyPrompt({ conversation: "对方：ping", counterpartName: "  " });
    expect(prompt.user).toContain("Visible conversation:");
    expect(prompt.user).not.toContain("the other person");
  });

  it("system 强调最新话题优先，避免回到已了结的旧话题", () => {
    const prompt = buildReplyPrompt({ conversation: "对方：ping" });
    expect(prompt.system).toContain("most recent message");
    expect(prompt.system).toContain("settled topics");
  });

  it("无日历 / 无档案时静默跳过对应段落", () => {
    const prompt = buildReplyPrompt({ conversation: "Them: ping" });
    expect(prompt.user).not.toContain("User profile:");
    expect(prompt.user).not.toContain("Calendar availability");
    expect(prompt.user).toContain("Visible conversation:");
    expect(prompt.user).toContain("First line: the stance tag");
  });
});
