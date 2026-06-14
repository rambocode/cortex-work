import { describe, expect, it } from "vitest";
import { BUILTIN_AVATAR_IDS, DEFAULT_AVATAR_ID, isBuiltinAvatarId } from "./avatars";

describe("内置头像 id 清单", () => {
  it("恰好 10 套且 id 唯一", () => {
    expect(BUILTIN_AVATAR_IDS).toHaveLength(10);
    expect(new Set(BUILTIN_AVATAR_IDS).size).toBe(10);
  });

  it("均为合法 kebab 字符串", () => {
    for (const id of BUILTIN_AVATAR_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("默认头像 id 在清单内", () => {
    expect(BUILTIN_AVATAR_IDS).toContain(DEFAULT_AVATAR_ID);
  });

  it("isBuiltinAvatarId 识别内置 id,拒绝未知/空值", () => {
    expect(isBuiltinAvatarId("fox")).toBe(true);
    expect(isBuiltinAvatarId("not-a-real-avatar")).toBe(false);
    expect(isBuiltinAvatarId(undefined)).toBe(false);
    expect(isBuiltinAvatarId(null)).toBe(false);
    expect(isBuiltinAvatarId("")).toBe(false);
  });
});
