import { describe, expect, it } from "vitest";

import { classifyTarget } from "./url-gate";

const noFile = () => false;
const allow = (raw: string, approved: string[] = [], isFile: (u: string) => boolean = noFile) =>
  classifyTarget(raw, approved, isFile).allow;

describe("URL 闸 classifyTarget（U6）", () => {
  it("本地放行:localhost / 127.0.0.1 + 各种环回变体", () => {
    expect(allow("http://localhost:3000")).toBe(true);
    expect(allow("http://127.0.0.1:8080/path")).toBe(true);
    expect(allow("http://127.1/")).toBe(true); // 缺段
    expect(allow("http://0x7f000001/")).toBe(true); // 十六进制
    expect(allow("http://2130706433/")).toBe(true); // 十进制整数
    expect(allow("http://[::1]:3000/")).toBe(true); // IPv6 环回
  });

  it("非本地未授权 → 拒 + 回 origin(供待授权)", () => {
    const v = classifyTarget("https://evil.com/x", [], noFile);
    expect(v).toEqual({ allow: false, reason: "non-local-unapproved", origin: "https://evil.com" });
  });

  it("非本地但在白名单 → 放行", () => {
    expect(allow("https://example.com/a", ["https://example.com"])).toBe(true);
    // 白名单按 origin 精确匹配:不同 scheme/port 不算
    expect(allow("http://example.com/a", ["https://example.com"])).toBe(false);
  });

  it("未授权私网 / 链路本地字面 IP → 拒(SSRF)", () => {
    for (const u of [
      "http://192.168.1.1/",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://169.254.169.254/", // 云 metadata
    ]) {
      expect(classifyTarget(u, [], noFile)).toEqual({ allow: false, reason: "private-ip" });
    }
  });

  it("file:// 须经授权", () => {
    const isAuth = (u: string) => u.includes("ok.html");
    expect(allow("file:///tmp/ok.html", [], isAuth)).toBe(true);
    expect(classifyTarget("file:///etc/passwd", [], isAuth)).toEqual({ allow: false, reason: "file-unauthorized" });
  });

  it("非法 / 非 http(s)/file scheme → bad-url", () => {
    expect(classifyTarget("not a url", [], noFile)).toEqual({ allow: false, reason: "bad-url" });
    expect(classifyTarget("ftp://x/", [], noFile)).toEqual({ allow: false, reason: "bad-url" });
  });
});
