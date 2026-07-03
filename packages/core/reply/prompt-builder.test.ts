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
    expect(prompt.system).toContain("Output only the reply text");
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

  it("段落序：档案记忆 → 可见对话 → 意图 → 日历 → 避重 → 收尾指令", () => {
    const prompt = buildReplyPrompt({
      conversation: "Them: hi",
      typedIntent: "be brief",
      calendarContext: "可用时间：09:00-09:30",
      userProfile: "my profile",
      avoidReplies: ["prev reply"],
    });
    const idxProfile = prompt.user.indexOf("User profile:");
    const idxConversation = prompt.user.indexOf("Visible conversation:");
    const idxIntent = prompt.user.indexOf("Typed intent");
    const idxCalendar = prompt.user.indexOf("Calendar availability");
    const idxAvoid = prompt.user.indexOf("Already suggested replies");
    const idxClosing = prompt.user.indexOf("Return a concise reply");
    expect(idxProfile).toBeGreaterThanOrEqual(0);
    expect(idxProfile).toBeLessThan(idxConversation);
    expect(idxConversation).toBeLessThan(idxIntent);
    expect(idxIntent).toBeLessThan(idxCalendar);
    expect(idxCalendar).toBeLessThan(idxAvoid);
    expect(idxAvoid).toBeLessThan(idxClosing);
  });

  it("无日历 / 无档案时静默跳过对应段落", () => {
    const prompt = buildReplyPrompt({ conversation: "Them: ping" });
    expect(prompt.user).not.toContain("User profile:");
    expect(prompt.user).not.toContain("Calendar availability");
    expect(prompt.user).toContain("Visible conversation:");
    expect(prompt.user).toContain("Return a concise reply");
  });
});
