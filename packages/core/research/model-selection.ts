// 研究模型选型（原 model-policy.ts）——决定「这次研究用哪个模型」以及「正文会不会离开本机」。
//
// 本模块是纯判定，不发起任何请求：provider 清单由宿主（Desktop 设置层）注入，
// 判定结果由编排层执行。这样同一套规则可以在 UI 预览、Session 启动、以及每次模型调用前重复跑。
//
// **这里没有出站策略枚举**（原 spec KTD5 的 ModelDataPolicy 已移除，见 ./types 的说明）：
// 数据去哪由所选模型唯一决定 —— isLocal 为 true 表示模型跑在本机，正文不离开这台设备；
// 为 false 表示会发给远端供应商。用户只需选模型，不必再回答一个语义重复的策略问题。
import { isForbiddenIp, parseIpLiteral, type IpRange } from "./url-safety";

/// 「本机」的地址段：仅 IPv4 127/8 与 IPv6 ::1。
/// 刻意不含 RFC1918 —— 局域网里的另一台机器同样是「数据离开了本机」，不能算本地模型。
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
/// 无法解析的字符串返回 false —— 拿不准时必须按「非本地」处理，否则会给用户一个
/// 「正文不会离开设备」的错误承诺。
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

/// 研究专用的模型偏好（来自 ResearchEngineSettings）。两者都可缺省 = 跟随全局默认。
export interface ResearchModelPreference {
  providerId?: string;
  modelId?: string;
}

/// selectResearchModel 的入参。providers 是宿主已配置的模型供应商快照（含未启用项）。
export interface ModelSelectionInput {
  providers: ReadonlyArray<{
    id: string;
    baseUrl: string;
    enabled: boolean;
    models: ReadonlyArray<{ id: string }>;
  }>;
  /// 研究设置里的模型偏好（第一优先）。
  preference?: ResearchModelPreference;
  /// 全局默认供应商 / 模型（ProviderSettings.defaultProviderId / defaultModel），第二优先。
  fallbackProviderId?: string;
  fallbackModel?: string;
}

/// 选型结果。失败只有一种情况——一个可用供应商都没有，此时 UI 引导用户去设置里添加。
export type ModelSelection =
  | { ok: true; providerId: string; model: string; isLocal: boolean }
  | { ok: false; code: "no_provider_configured"; message: string };

/// 选出本次研究使用的 provider + model。
///
/// **三级回落**（每级都要求「真的可用」，失效的偏好静默降级而不是让研究不可用）：
///   供应商：研究偏好 → 全局默认 → 首个可用；
///   模型：  研究偏好 → 全局默认 → 该供应商的首个模型。
///
/// 模型 id 只在**选中的供应商**里查找：模型 id 属于某个供应商，把 A 家的模型名套到 B 家
/// 只会得到一个必然 404 的请求。因此偏好的 providerId 失效时，它的 modelId 也一并作废
/// （落回全局默认模型或该供应商首个模型），而不是跨供应商硬套。
export function selectResearchModel(input: ModelSelectionInput): ModelSelection {
  const usable = input.providers.filter((p) => p.enabled && p.models.length > 0);
  if (usable.length === 0) {
    return {
      ok: false,
      code: "no_provider_configured",
      message: "尚未配置任何可用的模型供应商，请先在设置中添加并启用。",
    };
  }

  const byId = (id: string | undefined) => (id ? usable.find((p) => p.id === id) : undefined);
  // usable 非空，故末位回落必然存在；?? 分支只为类型收窄。
  const provider =
    byId(input.preference?.providerId) ?? byId(input.fallbackProviderId) ?? usable[0]!;

  const hasModel = (id: string | undefined) =>
    id ? provider.models.find((m) => m.id === id)?.id : undefined;
  const model =
    hasModel(input.preference?.modelId) ?? hasModel(input.fallbackModel) ?? provider.models[0]!.id;

  return {
    ok: true,
    providerId: provider.id,
    model,
    isLocal: isLoopbackBaseUrl(provider.baseUrl),
  };
}

/// describeModelEgress 的返回：供 UI 一句话告诉用户「这次研究的数据会去哪」。
export interface EgressDescription {
  /// 是否有任何数据离开本机。这是用户最关心的一位。
  sendsToRemote: boolean;
  summaryZh: string;
}

/// 用人话描述所选模型下的数据出站范围。
///
/// 入参是「模型是否在本机」这一**从选型结果推导出的事实**，不是用户设置项 ——
/// 文案与实际行为因此不可能漂移（原先用户选的策略与实际选中的模型可以互相矛盾）。
export function describeModelEgress(isLocal: boolean): EgressDescription {
  return isLocal
    ? {
        sendsToRemote: false,
        summaryZh: "该模型运行在本机：证据正文与元数据都不会离开这台设备。",
      }
    : {
        sendsToRemote: true,
        summaryZh: "证据正文片段与元数据会发送给所选的模型供应商。",
      };
}
