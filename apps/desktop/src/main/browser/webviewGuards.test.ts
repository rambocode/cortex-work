import { describe, it, expect } from "vitest";
import { evaluateNavigation, externalUrlForWindowOpen } from "./webviewGuards";

describe("evaluateNavigation — scheme 严格白名单", () => {
  it("放行任意 https(地址栏发起)", () => {
    expect(evaluateNavigation({ targetUrl: "https://example.com", currentOrigin: null })).toBe(true);
  });

  it("放行环回/私网 http", () => {
    expect(evaluateNavigation({ targetUrl: "http://localhost:5173", currentOrigin: null })).toBe(true);
    expect(evaluateNavigation({ targetUrl: "http://192.168.1.10:3000", currentOrigin: null })).toBe(true);
  });

  it("拒绝明文公网 http", () => {
    expect(evaluateNavigation({ targetUrl: "http://evil.com", currentOrigin: null })).toBe(false);
  });

  it("deny-by-default 拒绝 javascript/data/blob/file/自定义", () => {
    for (const u of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "blob:https://x/y",
      "file:///etc/passwd",
      "vscode://foo",
      "about:blank",
    ]) {
      expect(evaluateNavigation({ targetUrl: u, currentOrigin: null })).toBe(false);
    }
  });

  it("非法 URL 拒绝", () => {
    expect(evaluateNavigation({ targetUrl: "not a url", currentOrigin: null })).toBe(false);
  });
});

describe("evaluateNavigation — 公网 origin 禁跳私网(SSRF 跳板)", () => {
  it("公网页跳环回/私网 http → 拒", () => {
    expect(
      evaluateNavigation({ targetUrl: "http://127.0.0.1:9000", currentOrigin: "https://attacker.com" }),
    ).toBe(false);
    expect(
      evaluateNavigation({ targetUrl: "http://169.254.169.254/", currentOrigin: "https://attacker.com" }),
    ).toBe(false);
  });

  it("公网页跳私网 https → 拒", () => {
    expect(
      evaluateNavigation({ targetUrl: "https://localhost:9000", currentOrigin: "https://attacker.com" }),
    ).toBe(false);
  });

  it("同样目标由地址栏(无公网 origin)触发 → 放行", () => {
    expect(evaluateNavigation({ targetUrl: "http://127.0.0.1:9000", currentOrigin: null })).toBe(true);
  });

  it("本地页跳本地 → 放行(currentOrigin 非公网)", () => {
    expect(
      evaluateNavigation({ targetUrl: "http://127.0.0.1:9000", currentOrigin: "http://localhost:5173" }),
    ).toBe(true);
  });

  it("公网页跳公网 https → 放行", () => {
    expect(
      evaluateNavigation({ targetUrl: "https://other.com", currentOrigin: "https://attacker.com" }),
    ).toBe(true);
  });
});

describe("externalUrlForWindowOpen", () => {
  it("http(s) 返回原 URL(交系统浏览器)", () => {
    expect(externalUrlForWindowOpen("https://x.com")).toBe("https://x.com");
    expect(externalUrlForWindowOpen("http://x.com")).toBe("http://x.com");
  });
  it("自定义协议返回 null(不外溢)", () => {
    expect(externalUrlForWindowOpen("vscode://x")).toBeNull();
    expect(externalUrlForWindowOpen("smb://x")).toBeNull();
    expect(externalUrlForWindowOpen("javascript:alert(1)")).toBeNull();
  });
});
