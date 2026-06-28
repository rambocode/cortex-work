import { describe, expect, it } from "vitest";
import { MAX_STRING_LENGTH, redactObject, redactString, truncateString } from "./redact";

describe("redactString", () => {
  it("脱敏 apiKey / token / secret 的值（真实密钥子串必须消失）", () => {
    expect(redactString('apiKey: "sk-secret123"')).not.toContain("sk-secret123");
    expect(redactString('apiKey: "sk-secret123"')).toContain("***");
    expect(redactString("token=abc.def")).not.toContain("abc.def");
  });
  it("Bearer/Basic 鉴权 token 整体脱敏（不只脱方案名）", () => {
    const out = redactString("authorization: Bearer sk-live-abc123");
    expect(out).not.toContain("sk-live-abc123");
    expect(out).toContain("***");
    expect(redactString("Authorization: Basic dXNlcjpwYXNz")).not.toContain("dXNlcjpwYXNz");
  });
  it("覆盖 password / credential 形态", () => {
    expect(redactString("password=hunter2")).not.toContain("hunter2");
    expect(redactString('credential: "tok-xyz"')).not.toContain("tok-xyz");
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
  it("正常 key 下字符串值内嵌的密钥也脱敏（key 级之外的兜底）", () => {
    const out = redactObject({ stderrTail: "curl -H 'authorization: Bearer sk-xyz'" }) as {
      stderrTail: string;
    };
    expect(out.stderrTail).not.toContain("sk-xyz");
  });
  it("循环引用不抛错，断环为 [circular]", () => {
    const a: Record<string, unknown> = { token: "x" };
    a["self"] = a;
    expect(() => redactObject(a)).not.toThrow();
    const out = redactObject(a) as Record<string, unknown>;
    expect(out["token"]).toBe("[redacted]");
    expect(out["self"]).toBe("[circular]");
  });
});

describe("truncateString", () => {
  it("短文本不截断", () => {
    expect(truncateString("short")).toBe("short");
  });
});
