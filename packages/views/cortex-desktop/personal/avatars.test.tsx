import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { BUILTIN_AVATAR_IDS } from "@cortex-work/core";
import { BUILTIN_AVATARS, renderAvatar } from "./avatars";

describe("内置头像 SVG 映射", () => {
  it("views 的 id 集合与 core BUILTIN_AVATAR_IDS 逐一对应且同序", () => {
    expect(BUILTIN_AVATARS.map((a) => a.id)).toEqual([...BUILTIN_AVATAR_IDS]);
  });

  it("每套头像都带名称与背景色", () => {
    for (const a of BUILTIN_AVATARS) {
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.bg).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("renderAvatar 对每个内置 id 返回 React 元素", () => {
    for (const id of BUILTIN_AVATAR_IDS) {
      expect(isValidElement(renderAvatar(id))).toBe(true);
    }
  });

  it("renderAvatar 对未知 id / 空值返回 null（调用方回退首字母）", () => {
    expect(renderAvatar("not-a-real-avatar")).toBeNull();
    expect(renderAvatar(undefined)).toBeNull();
    expect(renderAvatar(null)).toBeNull();
    expect(renderAvatar("")).toBeNull();
  });
});
