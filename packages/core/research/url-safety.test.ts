// url-safety.ts 的 SSRF 判定测试（spec §19.2.1 的自动化验收）。
//
// 这里的每一条 case 都对应一种真实的 SSRF 绕过手法：十进制/十六进制/八进制 IPv4、
// 缺位补齐、IPv6 loopback、IPv4-mapped。任何一条变红都意味着抓取层可能被诱导打内网。
import { describe, expect, it } from "vitest";

import {
  DEFAULT_FORBIDDEN_RANGES,
  canonicalizeUrl,
  checkUrlPolicy,
  isForbiddenIp,
  parseIpLiteral,
  stripTrackingParams,
  type IpRange,
} from "./url-safety";

/// 把 parseIpLiteral 的输出转成小写 hex 串，便于用字面量做断言。
function toHex(bytes: Uint8Array | null): string | null {
  if (!bytes) return null;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/// 从 hex 串构造 16 字节地址，供自定义 IpRange 使用。
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const V4_MAPPED_PREFIX = "00000000000000000000ffff";

describe("parseIpLiteral", () => {
  it.each([
    // [输入, 期望 hex, 说明]
    ["127.0.0.1", `${V4_MAPPED_PREFIX}7f000001`, "点分十进制"],
    ["0x7f000001", `${V4_MAPPED_PREFIX}7f000001`, "单段十六进制"],
    ["2130706433", `${V4_MAPPED_PREFIX}7f000001`, "单段十进制"],
    ["0177.0.0.1", `${V4_MAPPED_PREFIX}7f000001`, "八进制首段"],
    ["0x7f.1", `${V4_MAPPED_PREFIX}7f000001`, "十六进制 + 缺位补齐"],
    ["127.1", `${V4_MAPPED_PREFIX}7f000001`, "两段缺位补齐"],
    ["127.0.1", `${V4_MAPPED_PREFIX}7f000001`, "三段缺位补齐"],
    ["0.0.0.0", `${V4_MAPPED_PREFIX}00000000`, "未指定 IPv4"],
    ["255.255.255.255", `${V4_MAPPED_PREFIX}ffffffff`, "广播地址"],
    ["192.168.1.5", `${V4_MAPPED_PREFIX}c0a80105`, "私网"],
    ["[::1]", "00000000000000000000000000000001", "带方括号的 IPv6 loopback"],
    ["::1", "00000000000000000000000000000001", "IPv6 loopback"],
    ["::ffff:127.0.0.1", `${V4_MAPPED_PREFIX}7f000001`, "IPv4-mapped 点分尾段"],
    ["::ffff:7f00:1", `${V4_MAPPED_PREFIX}7f000001`, "IPv4-mapped 十六进制写法"],
    ["fe80::1", "fe800000000000000000000000000001", "link-local"],
    ["::", "00000000000000000000000000000000", "全零"],
    ["fc00::1234", "fc000000000000000000000000001234", "ULA"],
    ["2001:db8::1", "20010db8000000000000000000000001", "文档地址"],
    ["fe80::1%25eth0", "fe800000000000000000000000000001", "带百分号编码 zone id"],
  ])("解析 %s（%s）", (input, expected) => {
    expect(toHex(parseIpLiteral(input))).toBe(expected);
  });

  it.each([
    ["example.com", "普通域名"],
    ["", "空串"],
    ["localhost", "主机名而非字面量"],
    ["256.0.0.1", "超范围段"],
    ["1.2.3.4.5", "五段"],
    ["127.0.0.", "尾随点"],
    ["0x1g.1", "非法十六进制"],
    ["08.0.0.1", "非法八进制数字 8"],
    ["::1::2", "多个双冒号"],
    ["12345::", "超长分组"],
    ["1:2:3:4:5:6:7:8:9", "九个分组"],
    ["[::1", "方括号不配对"],
    ["4294967296", "超过 32 位的单段整数"],
  ])("对 %s（%s）返回 null", (input) => {
    expect(parseIpLiteral(input)).toBeNull();
  });
});

describe("isForbiddenIp", () => {
  it.each([
    ["127.0.0.1", "IPv4 loopback"],
    ["127.255.255.254", "127/8 上界"],
    ["10.0.0.1", "私网 10/8"],
    ["172.16.0.1", "私网 172.16/12"],
    ["172.31.255.255", "私网 172.16/12 上界"],
    ["192.168.1.5", "私网 192.168/16"],
    ["169.254.169.254", "link-local 元数据服务"],
    ["100.64.0.1", "CGNAT"],
    ["0.0.0.0", "0/8"],
    ["224.0.0.1", "组播 224/4"],
    ["240.0.0.1", "保留 240/4"],
    ["255.255.255.255", "受限广播"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 未指定"],
    ["fc00::1", "ULA"],
    ["fd12:3456::1", "ULA fd 段"],
    ["fe80::1", "IPv6 link-local"],
    ["ff02::1", "IPv6 组播"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped link-local"],
    ["0x7f000001", "十六进制 loopback"],
    ["2130706433", "十进制 loopback"],
  ])("禁止 %s（%s）", (host) => {
    const bytes = parseIpLiteral(host);
    expect(bytes).not.toBeNull();
    expect(isForbiddenIp(bytes as Uint8Array)).toBe(true);
  });

  it.each([
    ["1.1.1.1", "公网 DNS"],
    ["8.8.8.8", "公网 DNS"],
    ["172.15.255.255", "172.16/12 之外的下邻"],
    ["172.32.0.1", "172.16/12 之外的上邻"],
    ["100.63.255.255", "CGNAT 之外的下邻"],
    ["100.128.0.1", "CGNAT 之外的上邻"],
    ["192.167.255.255", "192.168/16 之外"],
    ["223.255.255.255", "组播之外"],
    ["2001:db8::1", "公网 IPv6"],
    ["2400:cb00::1", "公网 IPv6"],
  ])("允许 %s（%s）", (host) => {
    const bytes = parseIpLiteral(host);
    expect(bytes).not.toBeNull();
    expect(isForbiddenIp(bytes as Uint8Array)).toBe(false);
  });

  it("ranges 是参数：传入自定义集合可放行 loopback（用于本地假站测试）", () => {
    const bytes = parseIpLiteral("127.0.0.1") as Uint8Array;
    const onlyPrivate: IpRange[] = [{ start: fromHex(`${V4_MAPPED_PREFIX}0a000000`), prefixLength: 104 }];
    expect(isForbiddenIp(bytes, onlyPrivate)).toBe(false);
    expect(isForbiddenIp(parseIpLiteral("10.1.2.3") as Uint8Array, onlyPrivate)).toBe(true);
  });

  it("空 ranges 表示不禁止任何地址", () => {
    expect(isForbiddenIp(parseIpLiteral("127.0.0.1") as Uint8Array, [])).toBe(false);
  });

  it("非 16 字节输入一律视为禁止（宁可误杀）", () => {
    expect(isForbiddenIp(new Uint8Array(4))).toBe(true);
  });

  it("DEFAULT_FORBIDDEN_RANGES 的每条 start 都是 16 字节且前缀长度合法", () => {
    expect(DEFAULT_FORBIDDEN_RANGES.length).toBeGreaterThan(0);
    for (const range of DEFAULT_FORBIDDEN_RANGES) {
      expect(range.start).toHaveLength(16);
      expect(range.prefixLength).toBeGreaterThanOrEqual(0);
      expect(range.prefixLength).toBeLessThanOrEqual(128);
    }
  });
});

describe("checkUrlPolicy", () => {
  it.each([
    ["not a url", "invalid_url", "完全无法解析"],
    ["/relative/path", "invalid_url", "相对路径"],
    ["file:///etc/passwd", "bad_scheme", "file 协议"],
    ["ftp://example.com/x", "bad_scheme", "ftp 协议"],
    ["javascript:alert(1)", "bad_scheme", "javascript 伪协议"],
    ["data:text/html,hi", "bad_scheme", "data URL"],
    ["https://user:pass@example.com/", "has_userinfo", "带用户名密码"],
    ["https://user@example.com/", "has_userinfo", "只带用户名"],
    ["http://example.com:8080/", "bad_port", "非 80/443 端口"],
    ["http://example.com:22/", "bad_port", "SSH 端口"],
    ["http://127.0.0.1/", "forbidden_ip", "loopback"],
    ["http://0x7f000001/", "forbidden_ip", "十六进制 loopback"],
    ["http://[::1]/", "forbidden_ip", "IPv6 loopback"],
    ["http://169.254.169.254/latest/meta-data/", "forbidden_ip", "云元数据服务"],
    ["http://192.168.1.5/", "forbidden_ip", "私网"],
  ])("%s 被拒（%s / %s）", (url, code) => {
    const result = checkUrlPolicy({ url });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it.each([
    ["https://example.com/a", "https 默认端口"],
    ["http://example.com/a", "http 默认端口"],
    ["https://example.com:443/a", "显式 443"],
    ["http://example.com:80/a", "显式 80"],
    ["https://1.1.1.1/", "公网 IP 字面量"],
  ])("%s 通过（%s）", (url) => {
    const result = checkUrlPolicy({ url });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url).toBeInstanceOf(URL);
  });

  it("allowedPorts 可覆盖默认端口白名单", () => {
    expect(checkUrlPolicy({ url: "http://example.com:8080/", allowedPorts: [80, 8080] }).ok).toBe(true);
    expect(checkUrlPolicy({ url: "http://example.com/", allowedPorts: [8080] }).ok).toBe(false);
  });

  it("forbiddenRanges 可覆盖：允许 loopback 打本地假站", () => {
    expect(checkUrlPolicy({ url: "http://127.0.0.1:80/", forbiddenRanges: [] }).ok).toBe(true);
  });

  describe("域名列表", () => {
    it.each([
      ["https://example.com/", true, "精确命中"],
      ["https://a.example.com/", true, "子域后缀命中"],
      ["https://a.b.example.com/", true, "多级子域命中"],
      ["https://EXAMPLE.com/", true, "大小写无关"],
      ["https://example.com./", true, "尾随点不能绕过"],
      ["https://notexample.com/", false, "相似域名不得命中"],
      ["https://example.com.evil.com/", false, "后缀伪装不得命中"],
      ["https://example.org/", false, "无关域名"],
    ])("blocklist 对 %s 判定为 %s（%s）", (url, blocked) => {
      const result = checkUrlPolicy({ url, blocklist: ["example.com"] });
      expect(result.ok).toBe(!blocked);
      if (!result.ok && blocked) expect(result.code).toBe("blocked_domain");
    });

    it("allowlist 非空时，未列入的域名被拒", () => {
      const result = checkUrlPolicy({ url: "https://other.com/", allowlist: ["example.com"] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("not_allowed_domain");
    });

    it("allowlist 支持子域后缀", () => {
      expect(checkUrlPolicy({ url: "https://docs.example.com/x", allowlist: ["example.com"] }).ok).toBe(true);
      expect(checkUrlPolicy({ url: "https://notexample.com/x", allowlist: ["example.com"] }).ok).toBe(false);
    });

    it("allowlist 为空数组表示不限制域名", () => {
      expect(checkUrlPolicy({ url: "https://anything.com/", allowlist: [] }).ok).toBe(true);
    });

    it("blocklist 优先于 allowlist", () => {
      const result = checkUrlPolicy({
        url: "https://example.com/",
        allowlist: ["example.com"],
        blocklist: ["example.com"],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("blocked_domain");
    });

    it("IP 字面量走精确匹配，不做后缀匹配", () => {
      // "0.0.1" 是 "127.0.0.1" 的字符串后缀，但绝不能因此被视为白名单成员。
      const result = checkUrlPolicy({
        url: "http://127.0.0.1/",
        allowlist: ["0.0.1"],
        forbiddenRanges: [],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("not_allowed_domain");
    });

    it("允许把 IP 字面量精确写进 allowlist", () => {
      expect(
        checkUrlPolicy({ url: "http://127.0.0.1/", allowlist: ["127.0.0.1"], forbiddenRanges: [] }).ok,
      ).toBe(true);
    });
  });

  it("UrlRejectCode 的每个取值都被覆盖", () => {
    const codes = new Set<string>();
    for (const url of [
      "not a url",
      "file:///etc/passwd",
      "https://u:p@example.com/",
      "http://example.com:8080/",
      "http://127.0.0.1/",
    ]) {
      const r = checkUrlPolicy({ url });
      if (!r.ok) codes.add(r.code);
    }
    const blocked = checkUrlPolicy({ url: "https://example.com/", blocklist: ["example.com"] });
    if (!blocked.ok) codes.add(blocked.code);
    const notAllowed = checkUrlPolicy({ url: "https://example.com/", allowlist: ["other.com"] });
    if (!notAllowed.ok) codes.add(notAllowed.code);

    expect([...codes].sort()).toEqual([
      "bad_port",
      "bad_scheme",
      "blocked_domain",
      "forbidden_ip",
      "has_userinfo",
      "invalid_url",
      "not_allowed_domain",
    ]);
  });
});

describe("stripTrackingParams", () => {
  it.each([
    ["https://e.com/a?utm_source=x&id=1", "https://e.com/a?id=1"],
    ["https://e.com/a?utm_medium=x&utm_campaign=y", "https://e.com/a"],
    ["https://e.com/a?gclid=1&q=2", "https://e.com/a?q=2"],
    ["https://e.com/a?fbclid=1", "https://e.com/a"],
    ["https://e.com/a?msclkid=1", "https://e.com/a"],
    ["https://e.com/a?mc_eid=1", "https://e.com/a"],
    ["https://e.com/a?ref=hn&x=1", "https://e.com/a?x=1"],
    ["https://e.com/a?spm=abc", "https://e.com/a"],
    ["https://e.com/a?_hsenc=abc", "https://e.com/a"],
    ["https://e.com/a?q=utm_source", "https://e.com/a?q=utm_source"],
    ["https://e.com/a?utmx=1", "https://e.com/a?utmx=1"],
  ])("%s → %s", (input, expected) => {
    expect(stripTrackingParams(new URL(input)).href).toBe(expected);
  });

  it("不修改入参", () => {
    const original = new URL("https://e.com/a?utm_source=x");
    const cleaned = stripTrackingParams(original);
    expect(original.href).toBe("https://e.com/a?utm_source=x");
    expect(cleaned).not.toBe(original);
  });
});

describe("canonicalizeUrl", () => {
  it.each([
    ["HTTPS://Example.COM/a", "https://example.com/a", "scheme 与 host 小写"],
    ["https://example.com:443/a", "https://example.com/a", "去 https 默认端口"],
    ["http://example.com:80/a", "http://example.com/a", "去 http 默认端口"],
    ["https://example.com/a#section", "https://example.com/a", "去 fragment"],
    ["https://example.com", "https://example.com/", "空路径补根斜杠"],
    ["https://example.com//", "https://example.com/", "多重尾斜杠归一"],
    ["https://example.com/a//", "https://example.com/a/", "路径尾斜杠归一"],
    ["https://example.com/a?b=2&a=1", "https://example.com/a?a=1&b=2", "query 排序"],
    ["https://example.com/a?utm_source=x&b=1", "https://example.com/a?b=1", "剥 tracking"],
    ["https://example.com/a?utm_source=x", "https://example.com/a", "剥空后不留问号"],
    ["https://example.com:8443/a", "https://example.com:8443/a", "非默认端口保留"],
    ["https://example.com./a", "https://example.com/a", "去主机尾随点"],
  ])("%s → %s（%s）", (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it.each([["not a url"], ["file:///etc/passwd"], ["ftp://example.com/"], [""]])(
    "对不可归一的 %s 返回 null",
    (input) => {
      expect(canonicalizeUrl(input)).toBeNull();
    },
  );

  it("等价 URL 归一为同一个去重键", () => {
    const a = canonicalizeUrl("HTTPS://Example.com:443/post?b=2&utm_source=t&a=1#top");
    const b = canonicalizeUrl("https://example.com/post?a=1&b=2");
    expect(a).toBe(b);
  });
});
