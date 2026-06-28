import { describe, expect, it } from "vitest";
import { MAX_STRING_LENGTH, redactObject, redactString, truncateString } from "./redact";

describe("redactString", () => {
  it("脱敏 apiKey / token / secret / authorization 的值", () => {
    expect(redactString('apiKey: "sk-secret123"')).not.toContain("sk-secret123");
    expect(redactString('apiKey: "sk-secret123"')).toContain("***");
    expect(redactString("token=abc.def")).toContain("***");
    expect(redactString("authorization: Bearer xyz")).toContain("***");
  });
  it("普通文本不动", () => {
    expect(redactString("hello world")).toBe("hello world");
  });
});

describe("redactObject", () => {
  it("命中敏感 key 的值替换为 [redacted]，递归生效", () => {
    const out = redactObject({
      apiKey: "sk-secret",
      Authorization: "Bearer token",
      env: { CORTEX_PI_KEY: "pi-secret", token: "secret-token" },
      keep: "visible",
    });
    expect(out).toMatchObject({
      apiKey: "[redacted]",
      Authorization: "[redacted]",
      env: { CORTEX_PI_KEY: "[redacted]", token: "[redacted]" },
      keep: "visible",
    });
  });
  it("数组递归脱敏", () => {
    expect(redactObject([{ token: "x" }, "plain"])).toEqual([{ token: "[redacted]" }, "plain"]);
  });
  it("超长字符串截断", () => {
    const long = "a".repeat(MAX_STRING_LENGTH + 100);
    const out = redactObject(long) as string;
    expect(out.length).toBe(MAX_STRING_LENGTH + 1); // 截断片段 + 省略号
    expect(out.endsWith("…")).toBe(true);
  });
  it("非对象原样返回", () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(null)).toBe(null);
  });
});

describe("truncateString", () => {
  it("短文本不截断", () => {
    expect(truncateString("short")).toBe("short");
  });
});
