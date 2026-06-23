import { describe, expect, it } from "vitest";

import { normalizeOrigin } from "./browserOrigin";

describe("normalizeOrigin", () => {
  it("归一为 scheme+host+port、去尾斜杠与路径", () => {
    expect(normalizeOrigin("https://example.com/")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com/path?q=1")).toBe("https://example.com");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("scheme 大小写归一(口径与 url-gate 的 URL.origin 一致)", () => {
    expect(normalizeOrigin("HTTP://Example.com")).toBe("http://example.com");
  });

  it("去首尾空白", () => {
    expect(normalizeOrigin("  https://example.com  ")).toBe("https://example.com");
  });

  it("非 http(s) 或非法输入 → null", () => {
    expect(normalizeOrigin("file:///x")).toBeNull();
    expect(normalizeOrigin("ftp://example.com")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
  });
});
