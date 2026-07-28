import { describe, expect, it } from "vitest";
import {
  AVATAR_BG_COLORS,
  AVATAR_EMOJIS,
  DEFAULT_AVATAR_BG,
  DEFAULT_AVATAR_EMOJI,
  LEGACY_AVATAR_EMOJI_MAP,
  migrateProfile,
  profileInitial,
  resolveAvatar,
} from "./avatars";

describe("头像素材清单", () => {
  it("背景色为 11 个合法 hex", () => {
    expect(AVATAR_BG_COLORS).toHaveLength(11);
    for (const c of AVATAR_BG_COLORS) {
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(new Set(AVATAR_BG_COLORS).size).toBe(11);
  });

  it("emoji 清单非空且唯一", () => {
    expect(AVATAR_EMOJIS.length).toBeGreaterThan(10);
    expect(new Set(AVATAR_EMOJIS).size).toBe(AVATAR_EMOJIS.length);
  });

  it("默认值取自清单", () => {
    expect(DEFAULT_AVATAR_EMOJI).toBe("🐼");
    expect(AVATAR_EMOJIS).toContain(DEFAULT_AVATAR_EMOJI);
    expect(DEFAULT_AVATAR_BG).toBe(AVATAR_BG_COLORS[0]);
  });

  it("旧内置头像 id 迁移映射覆盖全部 10 套", () => {
    expect(Object.keys(LEGACY_AVATAR_EMOJI_MAP)).toHaveLength(10);
    expect(LEGACY_AVATAR_EMOJI_MAP.fox).toBe("🦊");
    expect(LEGACY_AVATAR_EMOJI_MAP.robot).toBe("🤖");
  });
});

describe("migrateProfile — 旧存档头像迁移", () => {
  it("已知 avatarId 迁移为对应 emoji,并移除 avatarId", () => {
    const migrated = migrateProfile({ nickname: "阿伟", avatarId: "fox" });
    expect(migrated).toEqual({ nickname: "阿伟", avatarMode: "emoji", avatarEmoji: "🦊" });
    expect(migrated.avatarId).toBeUndefined();
  });

  it("未知 avatarId 回退默认 emoji 🐼", () => {
    const migrated = migrateProfile({ avatarId: "not-a-real-avatar" });
    expect(migrated.avatarEmoji).toBe(DEFAULT_AVATAR_EMOJI);
    expect(migrated.avatarId).toBeUndefined();
  });

  it("无 avatarId 且背景已是现行色板时原样返回(同一引用)", () => {
    const p = { nickname: "小明", avatarMode: "initials" as const, avatarBg: "#6b7280" };
    expect(migrateProfile(p)).toBe(p);
  });

  it("无 avatarId 但存 pastel 旧色 → 仅升级背景色(同索引饱和色)", () => {
    const p = { nickname: "小明", avatarMode: "initials" as const, avatarBg: "#E5E7EB" };
    const migrated = migrateProfile(p);
    expect(migrated).toEqual({ nickname: "小明", avatarMode: "initials", avatarBg: "#6b7280" });
  });

  it("迁移保留其它字段(现行色板背景原样保留)", () => {
    const migrated = migrateProfile({ nickname: "n", avatarBg: "#ec4899", avatarId: "owl" });
    expect(migrated.avatarBg).toBe("#ec4899");
    expect(migrated.avatarEmoji).toBe("🦉");
  });

  it("avatarId + pastel 旧背景同时迁移:emoji 化 + 背景升级", () => {
    const migrated = migrateProfile({ nickname: "n", avatarBg: "#DBEAFE", avatarId: "owl" });
    expect(migrated.avatarBg).toBe("#3b82f6");
    expect(migrated.avatarEmoji).toBe("🦉");
    expect(migrated.avatarId).toBeUndefined();
  });
});

describe("resolveAvatar — 头像渲染参数解析", () => {
  it("缺省回退 emoji 模式 + 默认 emoji + 默认背景", () => {
    expect(resolveAvatar(undefined)).toEqual({
      mode: "emoji",
      emoji: DEFAULT_AVATAR_EMOJI,
      bg: DEFAULT_AVATAR_BG,
    });
    expect(resolveAvatar({})).toEqual({
      mode: "emoji",
      emoji: DEFAULT_AVATAR_EMOJI,
      bg: DEFAULT_AVATAR_BG,
    });
  });

  it("已设置字段覆盖默认值", () => {
    expect(
      resolveAvatar({ avatarMode: "initials", avatarEmoji: "🦊", avatarBg: "#FCE7F3" }),
    ).toEqual({ mode: "initials", emoji: "🦊", bg: "#FCE7F3" });
  });
});

describe("profileInitial — 昵称首字符", () => {
  it("空/缺省/纯空白回退「我」", () => {
    expect(profileInitial(undefined)).toBe("我");
    expect(profileInitial("")).toBe("我");
    expect(profileInitial("   ")).toBe("我");
  });

  it("中文昵称取首字符", () => {
    expect(profileInitial("阿伟")).toBe("阿");
  });

  it("拉丁字母首字符转大写并忽略前导空白", () => {
    expect(profileInitial("mike")).toBe("M");
    expect(profileInitial("  bob")).toBe("B");
    expect(profileInitial("Alice")).toBe("A");
  });
});
