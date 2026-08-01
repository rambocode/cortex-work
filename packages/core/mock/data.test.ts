import { describe, expect, it } from "vitest";
import { whoMeta } from "./data";
import { DEFAULT_AVATAR_BG, DEFAULT_AVATAR_EMOJI } from "../personal/avatars";

describe("whoMeta — 用户本人 profile 注入", () => {
  it("不传 profile 时 who='me' 返回默认昵称「我」+ 默认 emoji/背景头像", () => {
    const meta = whoMeta("me");
    expect(meta.name).toBe("我");
    expect(meta.avatar).toEqual({ initials: "我", bg: DEFAULT_AVATAR_BG, emoji: DEFAULT_AVATAR_EMOJI });
    expect(meta.isMe).toBe(true);
  });

  it("emoji 模式:昵称与 emoji/bg 生效,initials 取昵称首字符", () => {
    const meta = whoMeta("me", {
      nickname: "阿伟",
      avatarMode: "emoji",
      avatarEmoji: "🦊",
      avatarBg: "#EDE9FE",
    });
    expect(meta.name).toBe("阿伟");
    expect(meta.avatar).toEqual({ initials: "阿", bg: "#EDE9FE", emoji: "🦊" });
  });

  it("initials 模式:只画首字符+背景,不带 emoji;拉丁首字符大写", () => {
    const meta = whoMeta("me", { nickname: "mike", avatarMode: "initials", avatarBg: "#E5E7EB" });
    expect(meta.name).toBe("mike");
    expect(meta.avatar).toEqual({ initials: "M", bg: "#E5E7EB" });
    expect(meta.avatar.emoji).toBeUndefined();
  });

  it("空白/纯空格昵称回退为「我」(不渲染空名)", () => {
    expect(whoMeta("me", { nickname: "" }).name).toBe("我");
    expect(whoMeta("me", { nickname: "   " }).name).toBe("我");
  });

  it("pi agent 头像与顶部一致(C / #4338ca / Cortex),不回退成灰色 ?", () => {
    const meta = whoMeta("pi");
    expect(meta.name).toBe("Cortex");
    expect(meta.avatar).toEqual({ initials: "C", bg: "#4338ca" });
    expect(meta.agent).toBe("agent");
  });

  it("profile 不影响非本人作者（agent / me-agent / 未知）", () => {
    const profile = { nickname: "阿伟", avatarMode: "emoji" as const, avatarEmoji: "🦊" };
    // CLI agent:与不传 profile 完全一致。
    expect(whoMeta("claude", profile)).toEqual(whoMeta("claude"));
    // me-agent 虽 isMe,但不在 who="me" 范围,不受 profile 影响。
    expect(whoMeta("me-agent", profile)).toEqual(whoMeta("me-agent"));
    expect(whoMeta("me-agent", profile).avatar.emoji).toBeUndefined();
    // 未知作者回退。
    expect(whoMeta("nobody", profile)).toEqual(whoMeta("nobody"));
  });
});
