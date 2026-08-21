// auth-helpers 纯函数单测：状态机推进、slug 派生（含中文/空格/非法字符）、输入校验、baseUrl 规范化。
import { describe, it, expect } from "vitest";
import {
  nextAuthStep,
  prevAuthStep,
  deriveSlug,
  isValidSlug,
  isValidEmail,
  isValidCode,
  normalizeBaseUrl,
} from "./auth-helpers";

describe("auth step machine", () => {
  it("forward 线性推进且末步夹住", () => {
    expect(nextAuthStep("server")).toBe("code");
    expect(nextAuthStep("code")).toBe("workspace");
    expect(nextAuthStep("workspace")).toBe("workspace");
  });
  it("backward 线性回退且首步夹住", () => {
    expect(prevAuthStep("workspace")).toBe("code");
    expect(prevAuthStep("code")).toBe("server");
    expect(prevAuthStep("server")).toBe("server");
  });
});

describe("deriveSlug", () => {
  it("空格 → 连字符并转小写", () => {
    expect(deriveSlug("My Team")).toBe("my-team");
    expect(deriveSlug("  Alpha   Squad  ")).toBe("alpha-squad");
  });
  it("剔除非法字符并折叠重复连字符", () => {
    expect(deriveSlug("A/B & C")).toBe("ab-c");
    expect(deriveSlug("team!!!name")).toBe("teamname");
    expect(deriveSlug("a---b")).toBe("a-b");
  });
  it("纯中文名派生为空串（需 UI 提示手填）", () => {
    expect(deriveSlug("研发团队")).toBe("");
  });
  it("中英混合仅保留 ASCII 部分", () => {
    expect(deriveSlug("研发 Team 01")).toBe("team-01");
  });
});

describe("isValidSlug", () => {
  it("接受合法 slug", () => {
    expect(isValidSlug("team")).toBe(true);
    expect(isValidSlug("my-team-01")).toBe(true);
  });
  it("拒绝空/首尾连字符/大写/非法字符", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("-team")).toBe(false);
    expect(isValidSlug("team-")).toBe(false);
    expect(isValidSlug("Team")).toBe(false);
    expect(isValidSlug("a_b")).toBe(false);
  });
});

describe("isValidEmail / isValidCode", () => {
  it("邮箱粗校验", () => {
    expect(isValidEmail("a@b.com")).toBe(true);
    expect(isValidEmail("  a@b.co  ")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });
  it("验证码需 6 位数字", () => {
    expect(isValidCode("123456")).toBe(true);
    expect(isValidCode(" 123456 ")).toBe(true);
    expect(isValidCode("12345")).toBe(false);
    expect(isValidCode("12a456")).toBe(false);
  });
});

describe("normalizeBaseUrl", () => {
  it("去首尾空白与结尾斜杠", () => {
    expect(normalizeBaseUrl("  http://127.0.0.1:8080/  ")).toBe("http://127.0.0.1:8080");
    expect(normalizeBaseUrl("http://x//")).toBe("http://x");
    expect(normalizeBaseUrl("http://x")).toBe("http://x");
  });
});
