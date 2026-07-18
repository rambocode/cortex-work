// URL 闸 + 预授权白名单(U6)。纯逻辑(便于单测,不 import electron 有副作用部分)。
// 工具层「快速判定 + 待授权回传」,**不替代** webviewGuards 三道闸(两道正交防线)。
//
// 策略(KTD4 预授权白名单、R13/R14):
//   - 本地放行:localhost / ::1 / 环回 IPv4(含 127.1 / 0x7f000001 / 2130706433 等变体)。
//   - file:// 须经现有授权(调用方传 isFileAuthorized,对齐 webviewGuards 的 isAuthorizedFileUrl)。
//   - 非本地:在 approvedOrigins 白名单内 → 放行;否则拒,回 origin 供工具回传 + 入「待授权」。
//   - 私网 / 链路本地字面 IP(RFC1918 / 169.254)且未授权 → 拒(SSRF 跳板)。
// DNS-rebinding(已授权公网 origin 解析到私网)是残留:由 server 的 token + Origin + loopback 兜底
// (见 server.ts / KTD10),非本闸唯一防线。

export type GateVerdict =
  | { allow: true }
  | { allow: false; reason: "non-local-unapproved"; origin: string }
  | { allow: false; reason: "private-ip" }
  | { allow: false; reason: "file-unauthorized" }
  | { allow: false; reason: "bad-url" };

// 把 host 解析为 IPv4 整数:支持点分(含缺段如 127.1)、单一十进制(2130706433)、十六进制(0x7f000001),
// 每段可十进制/十六进制。非 IPv4 字面返回 null。覆盖常见 localhost 绕过写法。
function ipv4ToInt(host: string): number | null {
  const seg = (p: string): number => {
    if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p, 16);
    if (/^\d+$/.test(p)) return Number(p);
    return NaN;
  };
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    const n = seg(host);
    return Number.isFinite(n) && n >= 0 && n <= 0xffffffff ? n >>> 0 : null;
  }
  const parts = host.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const nums = parts.map(seg);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  // 缺段:最后一段占剩余字节(127.1 → 127.0.0.1)。
  const caps = [0, 0, 0xffffffff, 0xffff, 0xff]; // index = parts.length 对应「最后段上限」
  const last = nums[nums.length - 1];
  if (last > caps[parts.length]) return null;
  if (nums.slice(0, -1).some((n) => n > 0xff)) return null;
  let ip = 0;
  for (let i = 0; i < nums.length - 1; i++) ip = (ip | (nums[i] << (24 - i * 8))) >>> 0;
  return (ip | last) >>> 0;
}

function inRange(ip: number, baseHost: string, bits: number): boolean {
  const base = ipv4ToInt(baseHost);
  if (base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const ip = ipv4ToInt(host);
  return ip !== null && (inRange(ip, "127.0.0.0", 8) || inRange(ip, "0.0.0.0", 8));
}

function isPrivateOrLinkLocal(host: string): boolean {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return (
    inRange(ip, "10.0.0.0", 8) ||
    inRange(ip, "172.16.0.0", 12) ||
    inRange(ip, "192.168.0.0", 16) ||
    inRange(ip, "169.254.0.0", 16)
  );
}

// 导航授权范围(设置页「导航授权范围」下拉,plan U5/R9):
//   - none(默认):全部授权——http/https 一律放行(含私网/内网 IP),免预授权白名单。
//     file:// 不受本档影响,仍须经既有授权(文件访问权限独立于导航范围)。
//   - nonLocalOnly:本地免审,仅非本地查白名单。
//   - all:连本地(localhost/127.x/::1)也需在 approvedOrigins 白名单,未授权则拒并回 origin。
// cortex 无事中弹窗审批(claude/codex 一次性 spawn),故用预授权强度取代 Codex 的事中「审批」。
export type NavigationApproval = "none" | "nonLocalOnly" | "all";

// 判定 agent 请求导航的目标 URL 是否放行。isFileAuthorized 由调用方注入(对齐 webviewGuards）。
// navigationApproval 缺省 nonLocalOnly,保后向兼容(既有 3 参调用与测试不变;运行时实际档位
// 由 tools.ts 从持久化设置读出并显式传入)。
export function classifyTarget(
  rawUrl: string,
  approvedOrigins: string[],
  isFileAuthorized: (url: string) => boolean,
  navigationApproval: NavigationApproval = "nonLocalOnly",
): GateVerdict {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { allow: false, reason: "bad-url" };
  }
  if (u.protocol === "file:") {
    return isFileAuthorized(u.toString()) ? { allow: true } : { allow: false, reason: "file-unauthorized" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { allow: false, reason: "bad-url" };
  // none 档(全部授权):http/https 一律放行,连私网检查也跳过——「全部」的字面语义,
  // SSRF 面由用户显式选择该档位承担(bad-url/file 闸仍在)。
  if (navigationApproval === "none") return { allow: true };
  const host = u.hostname.replace(/^\[|\]$/g, ""); // 去 IPv6 方括号
  // all 档下本地不再免审,落入下方白名单检查(未授权 → 回 origin 待授权)。
  if (navigationApproval !== "all" && isLoopbackHost(host)) return { allow: true }; // 本地自测,免审
  if (approvedOrigins.includes(u.origin)) return { allow: true }; // 已预授权(含 all 档下已授权的本地)
  if (isPrivateOrLinkLocal(host)) return { allow: false, reason: "private-ip" }; // 未授权私网 → SSRF 跳板,拒
  return { allow: false, reason: "non-local-unapproved", origin: u.origin }; // 非本地未授权 → 回 origin 待授权
}
