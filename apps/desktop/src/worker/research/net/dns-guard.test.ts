// dns-guard 单测：DNS 解析结果的私网判定。
// 零 mock 框架——lookup 与 forbiddenRanges 都是注入参数，直接传手写替身。
import { describe, expect, it } from "vitest";
import { DEFAULT_FORBIDDEN_RANGES } from "@cortex-work/core/research/url-safety";
import { resolveAndGuard, type DnsLookupFn } from "./dns-guard";

/// 构造一个返回固定地址表的假 lookup。
function fakeLookup(addresses: Array<{ address: string; family: number }>): DnsLookupFn {
  return async () => addresses;
}

/// 构造一个必定失败的假 lookup。
function failingLookup(message: string, code?: string): DnsLookupFn {
  return async () => {
    const err = new Error(message) as Error & { code?: string };
    if (code) err.code = code;
    throw err;
  };
}

describe("resolveAndGuard", () => {
  it("全部为公网地址时通过，并原样带出已验证地址", async () => {
    const result = await resolveAndGuard("example.com", {
      lookup: fakeLookup([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.addresses.map((a) => a.address)).toEqual([
      "93.184.216.34",
      "2606:2800:220:1:248:1893:25c8:1946",
    ]);
  });

  it("混合返回中只要有一个私网地址就整体拒绝（DNS rebinding 防线）", async () => {
    const result = await resolveAndGuard("rebind.example", {
      lookup: fakeLookup([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    });
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
  });

  it("loopback / link-local / IPv6 loopback 均被拒", async () => {
    for (const address of ["127.0.0.1", "169.254.169.254", "::1", "0.0.0.0"]) {
      const result = await resolveAndGuard("h", { lookup: fakeLookup([{ address, family: 4 }]) });
      expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
    }
  });

  it("forbiddenRanges 可注入：清空后 loopback 放行（集成测试用假站需要）", async () => {
    const result = await resolveAndGuard("localhost", {
      lookup: fakeLookup([{ address: "127.0.0.1", family: 4 }]),
      forbiddenRanges: [],
    });
    expect(result.ok).toBe(true);
  });

  it("默认 ranges 与 core 的 DEFAULT_FORBIDDEN_RANGES 一致", async () => {
    const explicit = await resolveAndGuard("h", {
      lookup: fakeLookup([{ address: "192.168.1.1", family: 4 }]),
      forbiddenRanges: DEFAULT_FORBIDDEN_RANGES,
    });
    const implicit = await resolveAndGuard("h", {
      lookup: fakeLookup([{ address: "192.168.1.1", family: 4 }]),
    });
    expect(explicit.ok).toBe(false);
    expect(implicit.ok).toBe(false);
  });

  it("解析失败归类为 dns_failure", async () => {
    const result = await resolveAndGuard("nope.invalid", {
      lookup: failingLookup("getaddrinfo ENOTFOUND nope.invalid", "ENOTFOUND"),
    });
    expect(result).toMatchObject({ ok: false, code: "dns_failure" });
  });

  it("空解析结果归类为 dns_failure 而不是放行", async () => {
    const result = await resolveAndGuard("empty.example", { lookup: fakeLookup([]) });
    expect(result).toMatchObject({ ok: false, code: "dns_failure" });
  });

  it("无法解析成 16 字节地址的返回值一律拒绝（宁可误杀）", async () => {
    const result = await resolveAndGuard("weird.example", {
      lookup: fakeLookup([{ address: "not-an-ip", family: 4 }]),
    });
    expect(result).toMatchObject({ ok: false, code: "blocked_by_policy" });
  });
});
