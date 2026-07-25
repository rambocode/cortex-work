// 模型出站闸（spec KTD5 / §19.2.5）——决定「这次研究可以用哪个模型」以及「什么数据会离开本机」。
//
// 本模块是纯判定，不发起任何请求：provider 清单由宿主（Desktop 设置层）注入，
// 判定结果由编排层执行。这样同一套规则可以在 UI 预览、Session 启动、以及每次模型调用前重复跑。
import { isForbiddenIp, parseIpLiteral, type IpRange } from "./url-safety";
import type { ModelDataPolicy } from "./types";

/// 「本机」的地址段：仅 IPv4 127/8 与 IPv6 ::1。
/// 刻意不含 RFC1918 —— 局域网里的另一台机器同样是「数据离开了本机」，不满足 local_only 的承诺。
const LOOPBACK_RANGES: readonly IpRange[] = [
  { start: buildV4Loopback(), prefixLength: 96 + 8 },
  { start: parseIpLiteral("::1") as Uint8Array, prefixLength: 128 },
];

/// 构造 ::ffff:127.0.0.0 的 16 字节起点（parseIpLiteral 对 IPv4 统一输出 IPv4-mapped）。
function buildV4Loopback(): Uint8Array {
  const start = new Uint8Array(16);
  start[10] = 0xff;
  start[11] = 0xff;
  start[12] = 127;
  return start;
}

/// 判断一个 provider 的 baseUrl 是否指向本机（loopback）。
///
/// 认三类写法：`localhost` 及其子域（RFC 6761 规定必须解析到本机）、127/8 的任意字面量变体
/// （十进制/十六进制/八进制/缺位补齐，见 parseIpLiteral）、IPv6 ::1 与其 IPv4-mapped 形式。
/// 无法解析的字符串返回 false —— local_only 场景下「不确定」必须按「非本地」处理。
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = url.hostname.trim().toLowerCase().replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const bytes = parseIpLiteral(url.hostname);
  if (!bytes) return false;
  // 复用 isForbiddenIp 的段匹配能力：这里传入的是「本机段」，命中即表示是本机。
  return isForbiddenIp(bytes, LOOPBACK_RANGES);
}

/// selectResearchModel 的入参。providers 是宿主已配置的模型供应商快照（含未启用项）。
export interface ModelSelectionInput {
  policy: ModelDataPolicy;
  providers: ReadonlyArray<{
    id: string;
    baseUrl: string;
    enabled: boolean;
    models: ReadonlyArray<{ id: string }>;
  }>;
  /// 用户偏好；不可用时按策略回落，但**永不**因偏好而突破 policy。
  preferredProviderId?: string;
  preferredModel?: string;
}

/// 选型结果。失败时区分「一个模型都没配」与「配了但没有合规的本地模型」，两者的引导文案不同。
export type ModelSelection =
  | { ok: true; providerId: string; model: string; isLocal: boolean }
  | { ok: false; code: "local_model_unavailable" | "no_provider_configured"; message: string };

/// 按 ModelDataPolicy 选出本次研究可用的 provider + model。
///
/// **不静默回退**（KTD5）：policy 为 local_only 时只在 loopback provider 中挑选；一个都没有就返回
/// local_model_unavailable，绝不因为「云 provider 可用」而改用云模型 —— 那等于把用户明确
/// 拒绝出站的正文偷偷发出去，是本模块存在的全部理由。
/// preferredProviderId 指向不合规的 provider 时同样只做降级（改选合规项），不做提权。
export function selectResearchModel(input: ModelSelectionInput): ModelSelection {
  const usable = input.providers.filter((p) => p.enabled && p.models.length > 0);
  if (usable.length === 0) {
    return {
      ok: false,
      code: "no_provider_configured",
      message: "尚未配置任何可用的模型供应商，请先在设置中添加并启用。",
    };
  }

  const candidates =
    input.policy === "local_only" ? usable.filter((p) => isLoopbackBaseUrl(p.baseUrl)) : usable;
  const provider = candidates.find((p) => p.id === input.preferredProviderId) ?? candidates[0];
  if (!provider) {
    return {
      ok: false,
      code: "local_model_unavailable",
      message: "当前策略为「仅本地模型」，但没有检测到运行在本机的模型服务；不会回退到云端模型。",
    };
  }

  // usable 已过滤掉空模型列表的 provider，因此 models[0] 必然存在；?? 分支只为满足类型收窄。
  const fallbackModel = provider.models[0]?.id ?? "";
  const model = provider.models.find((m) => m.id === input.preferredModel)?.id ?? fallbackModel;

  return {
    ok: true,
    providerId: provider.id,
    model,
    isLocal: isLoopbackBaseUrl(provider.baseUrl),
  };
}

/// describeEgress 的返回：供「策略告知弹窗」逐条展示本策略下会发生什么。
export interface EgressDescription {
  /// 是否会把证据正文送进模型（local_only 下也是 true，但收件方是本机进程）。
  sendsFullText: boolean;
  /// 是否会送出标题、摘要、域名、统计等元数据。
  sendsMetadata: boolean;
  /// 是否有任何数据离开本机。这是用户最关心的一位。
  sendsToRemote: boolean;
  summaryZh: string;
}

/// 用人话描述某个策略下的数据出站范围，供 UI 在首次使用或策略变化时告知用户（KTD5）。
export function describeEgress(policy: ModelDataPolicy): EgressDescription {
  switch (policy) {
    case "local_only":
      return {
        sendsFullText: true,
        sendsMetadata: true,
        sendsToRemote: false,
        summaryZh: "仅使用本机模型：证据正文与元数据都不会离开这台设备。",
      };
    case "metadata_only":
      return {
        sendsFullText: false,
        sendsMetadata: true,
        sendsToRemote: true,
        summaryZh: "云端模型只会收到标题、摘要、域名与统计等元数据，抓取到的正文不会发送。",
      };
    case "evidence_allowed":
      return {
        sendsFullText: true,
        sendsMetadata: true,
        sendsToRemote: true,
        summaryZh: "已授权：证据正文片段与元数据会发送给所选的模型供应商。",
      };
  }
}
