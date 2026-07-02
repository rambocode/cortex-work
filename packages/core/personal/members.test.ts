// members 纯函数表驱动单测：岗位标签库解析三态、头像色 hash 确定性、成员输入校验。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_JOB_TYPES,
  MEMBER_AVATAR_COLOR_COUNT,
  memberAvatarColorIndex,
  resolveJobTypes,
  validateMemberInput,
} from "./members";

describe("resolveJobTypes", () => {
  it("undefined → 返回默认表副本（改副本不污染常量）", () => {
    const resolved = resolveJobTypes(undefined);
    expect(resolved).toEqual([...DEFAULT_JOB_TYPES]);
    resolved.push("新增");
    expect(DEFAULT_JOB_TYPES).not.toContain("新增");
  });

  it("空数组保留（用户删空是有效状态，不回退默认）", () => {
    expect(resolveJobTypes([])).toEqual([]);
  });

  it("自定义列表原样返回", () => {
    expect(resolveJobTypes(["运营"])).toEqual(["运营"]);
  });

  it("默认表对齐 IFocus 六岗位", () => {
    expect([...DEFAULT_JOB_TYPES]).toEqual(["开发", "设计", "产品", "测试", "运维", "项目经理"]);
  });
});

describe("memberAvatarColorIndex", () => {
  it("确定性：同名恒同色", () => {
    expect(memberAvatarColorIndex("jone")).toBe(memberAvatarColorIndex("jone"));
    expect(memberAvatarColorIndex("张三")).toBe(memberAvatarColorIndex("张三"));
  });

  it("值域收敛在 [0, 6)", () => {
    for (const name of ["jone", "mike", "tim", "jack", "张三", "李四", "", "a", "很长很长的名字".repeat(20)]) {
      const idx = memberAvatarColorIndex(name);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(MEMBER_AVATAR_COLOR_COUNT);
      expect(Number.isInteger(idx)).toBe(true);
    }
  });
});

describe("validateMemberInput", () => {
  it.each<[string, string | null]>([
    ["jone", null],
    ["", "成员姓名不能为空"],
    ["   ", "成员姓名不能为空"],
  ])("name=%j → %s", (name, expected) => {
    expect(validateMemberInput({ name })).toBe(expected);
  });
});
