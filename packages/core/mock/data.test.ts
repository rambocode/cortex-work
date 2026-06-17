import { describe, expect, it } from "vitest";
import { whoMeta } from "./data";

describe("whoMeta — 用户本人 profile 注入", () => {
  it("不传 profile 时 who='me' 返回默认昵称「我」+ 首字母头像,无 avatarId", () => {
    const meta = whoMeta("me");
    expect(meta.name).toBe("我");
    expect(meta.avatar).toEqual({ initials: "我", bg: "#1a1916" });
    expect(meta.avatar.avatarId).toBeUndefined();
    expect(meta.isMe).toBe(true);
  });

  it("传入昵称+头像时覆盖 who='me' 的名称与 avatarId", () => {
    const meta = whoMeta("me", { nickname: "阿伟", avatarId: "fox" });
    expect(meta.name).toBe("阿伟");
    expect(meta.avatar.avatarId).toBe("fox");
  });

  it("空白/纯空格昵称回退为「我」(不渲染空名)", () => {
    expect(whoMeta("me", { nickname: "" }).name).toBe("我");
    expect(whoMeta("me", { nickname: "   " }).name).toBe("我");
  });

  it("只设头像不设昵称:名称仍为「我」,avatarId 生效", () => {
    const meta = whoMeta("me", { avatarId: "cat" });
    expect(meta.name).toBe("我");
    expect(meta.avatar.avatarId).toBe("cat");
  });

  it("pi agent 头像与顶部一致(PI / #4338ca / Pi),不回退成灰色 ?", () => {
    const meta = whoMeta("pi");
    expect(meta.name).toBe("Pi");
    expect(meta.avatar).toEqual({ initials: "PI", bg: "#4338ca" });
    expect(meta.agent).toBe("agent");
  });

  it("profile 不影响非本人作者（agent / me-agent / 未知）", () => {
    const profile = { nickname: "阿伟", avatarId: "fox" };
    // CLI agent:与不传 profile 完全一致。
    expect(whoMeta("claude", profile)).toEqual(whoMeta("claude"));
    // me-agent 虽 isMe,但不在 who="me" 范围,不受 profile 影响。
    expect(whoMeta("me-agent", profile)).toEqual(whoMeta("me-agent"));
    expect(whoMeta("me-agent", profile).avatar.avatarId).toBeUndefined();
    // 未知作者回退。
    expect(whoMeta("nobody", profile)).toEqual(whoMeta("nobody"));
  });
});
