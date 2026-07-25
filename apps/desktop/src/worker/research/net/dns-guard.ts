// DNS 解析 + 私网判定（spec §12.3、§19.2.1）——SSRF 的第二道闸。
//
// 第一道闸是 core 的 checkUrlPolicy（scheme / userinfo / 端口 / 域名列表 / IP 字面量）；
// 本模块负责「域名解析出来的真实地址是否危险」。两者缺一不可：`http://evil.example/`
// 过得了字符串层，但它可能解析到 127.0.0.1。
//
// **核心不变量：任一解析地址命中禁止段 → 整个主机拒绝**（而不是过滤掉坏地址、留下好地址）。
// 原因是 DNS rebinding：同一域名可以轮流返回公网与私网地址，"挑一个好的用" 等于把攻击者
// 想要的那次连接留给了下一跳。宁可整体拒绝，也不做地址级挑选。
//
// 本文件跑在 utilityProcess Worker 里，**禁止 import electron**。
import { lookup as dnsLookup } from "node:dns";
import {
  DEFAULT_FORBIDDEN_RANGES,
  isForbiddenIp,
  parseIpLiteral,
  type IpRange,
} from "@cortex-work/core/research/url-safety";

/// 一个已通过私网判定的地址。family 用于后续把连接钉死在这个地址上（4/6 决定 socket 族）。
export interface ResolvedAddress {
  address: string;
  family: number;
}

/// 可注入的 DNS 解析函数。生产传 node:dns 的 `lookup(host, { all: true })` 包装，
/// 测试传返回固定地址表的替身；集成测试可配合 forbiddenRanges: [] 放行 loopback。
export type DnsLookupFn = (host: string) => Promise<ResolvedAddress[]>;

/// resolveAndGuard 的注入依赖。两项都是参数而非全局开关——见 core/url-safety 里
/// isForbiddenIp 关于「测试改了全局忘还原 → 生产放行内网」的说明。
export interface DnsGuardDeps {
  lookup?: DnsLookupFn;
  forbiddenRanges?: readonly IpRange[];
}

/// 判定结果。失败码直接复用协议的 fetch_failure 码，调用方无需再映射。
export type DnsGuardResult =
  | { ok: true; addresses: ResolvedAddress[] }
  | { ok: false; code: "dns_failure" | "blocked_by_policy"; message: string };

/// 生产用的 DNS 解析：`dns.lookup(host, { all: true })`。
/// 用 lookup 而非 resolve4/resolve6 是刻意的——它走系统解析器（含 /etc/hosts 与 mDNS），
/// 与后续 socket 实际连接所用的解析路径一致；用 resolve* 会出现「校验的与连接的不是同一份结果」。
export const nodeDnsLookup: DnsLookupFn = (host) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(addresses.map((item) => ({ address: item.address, family: item.family })));
    });
  });

/// 解析主机名并对**每个**返回地址做禁止段判定，任一命中即整体拒绝。
export async function resolveAndGuard(
  host: string,
  deps: DnsGuardDeps = {},
): Promise<DnsGuardResult> {
  const lookup = deps.lookup ?? nodeDnsLookup;
  const ranges = deps.forbiddenRanges ?? DEFAULT_FORBIDDEN_RANGES;

  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(host);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "dns_failure", message: `无法解析主机 ${host}: ${message}` };
  }

  // 空结果不能当「没有危险地址」放行：它意味着我们无从判定，也无从钉扎连接目标。
  if (addresses.length === 0) {
    return { ok: false, code: "dns_failure", message: `主机 ${host} 未解析出任何地址` };
  }

  for (const item of addresses) {
    const bytes = parseIpLiteral(item.address);
    // 解析器返回了我们看不懂的地址形态时宁可误杀：放行等于放弃这道闸。
    if (!bytes) {
      return {
        ok: false,
        code: "blocked_by_policy",
        message: `主机 ${host} 解析出无法识别的地址 ${item.address}`,
      };
    }
    if (isForbiddenIp(bytes, ranges)) {
      return {
        ok: false,
        code: "blocked_by_policy",
        message: `主机 ${host} 解析到禁止访问的地址 ${item.address}`,
      };
    }
  }

  return { ok: true, addresses };
}
