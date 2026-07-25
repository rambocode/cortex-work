// stealth 抓取域名判定。
//
// 这条判定决定「哪些 URL 允许被发到服务端、让服务器代为访问」，因此它的边界是安全边界，
// 不只是功能开关。最危险的失误是后缀匹配写松（`evilzhihu.com` 命中 `zhihu.com`）——
// 那等于让任意域名都能挤进白名单。
import { describe, expect, it } from "vitest";
import { STEALTH_FETCH_DOMAINS, needsStealthFetch } from "./stealth-domains";

describe("needsStealthFetch", () => {
  it("清单里的域名及其子域命中", () => {
    expect(needsStealthFetch("zhihu.com")).toBe(true);
    expect(needsStealthFetch("zhuanlan.zhihu.com")).toBe(true);
    expect(needsStealthFetch("www.zhihu.com")).toBe(true);
    expect(needsStealthFetch("a.b.zhihu.com")).toBe(true);
  });

  it("大小写与末尾点不影响判定", () => {
    expect(needsStealthFetch("ZhuanLan.Zhihu.COM")).toBe(true);
    expect(needsStealthFetch("zhuanlan.zhihu.com.")).toBe(true);
  });

  it("带端口也能判定", () => {
    expect(needsStealthFetch("zhihu.com:443")).toBe(true);
  });

  /// 红线：后缀匹配必须要求点边界。
  it("同后缀但不同注册域**不得**命中", () => {
    expect(needsStealthFetch("evilzhihu.com")).toBe(false);
    expect(needsStealthFetch("notzhihu.com")).toBe(false);
    expect(needsStealthFetch("zhihu.com.evil.example")).toBe(false);
    expect(needsStealthFetch("xzhihu.com")).toBe(false);
  });

  it("清单外的域名不命中", () => {
    expect(needsStealthFetch("example.com")).toBe(false);
    expect(needsStealthFetch("github.com")).toBe(false);
  });

  it("空 / 畸形输入不命中（不抛错）", () => {
    expect(needsStealthFetch("")).toBe(false);
    expect(needsStealthFetch("   ")).toBe(false);
    expect(needsStealthFetch(".")).toBe(false);
  });

  it("可传入自定义清单（供设置项将来接管）", () => {
    expect(needsStealthFetch("foo.example.com", ["example.com"])).toBe(true);
    expect(needsStealthFetch("zhihu.com", ["example.com"])).toBe(false);
    expect(needsStealthFetch("anything.com", [])).toBe(false);
    // 清单里的空条目不能变成「匹配一切」。
    expect(needsStealthFetch("anything.com", ["", "  "])).toBe(false);
  });

  it("默认清单非空且都是裸注册域（不带协议 / 路径 / 通配符）", () => {
    expect(STEALTH_FETCH_DOMAINS.length).toBeGreaterThan(0);
    for (const domain of STEALTH_FETCH_DOMAINS) {
      expect(domain).not.toContain("/");
      expect(domain).not.toContain("*");
      expect(domain).not.toContain(":");
      expect(domain).toBe(domain.toLowerCase());
    }
  });
});
