// CRE 信任区策略判定（spec §6）。
//
// 定位：所有「这份数据能不能出站」的判断都必须经过本文件的三个谓词，编排层不得自己写
// `if (zone === "public_web")` 之类的散落判断——散落判断正是隐私事故的温床。
//
// 类型真源在 ./evidence（TrustZone / SourcePolicy），这里只提供默认矩阵与纯判定函数。
import type { SourcePolicy, TrustZone } from "./evidence";
import type { ModelDataPolicy } from "./types";

/// 信任区类型从 ./evidence 重导出，让调用方只 import 本文件即可写出完整签名，
/// 同时保证全仓只有一处 TrustZone 声明。
export type { TrustZone };

/// 各信任区的默认策略矩阵（spec §6 表格）。
///
/// 总原则是零信任：**只有 public_web 默认允许出站**，其余信任区一律要走来源级单独批准
/// （由 resolveSourcePolicy 之外的授权流程写入更宽的 policy，而不是在这里放宽默认值）。
export const DEFAULT_SOURCE_POLICIES: Record<TrustZone, SourcePolicy> = {
  // 公网内容本来就是公开的：查询可以出站给 Search Server，正文按 ModelDataPolicy 决定，
  // 抓取快照可跨 Session 复用（受来源级 expiresAt 的 TTL 限制）。
  public_web: {
    trustZone: "public_web",
    allowSearchServer: true,
    allowCloudModel: true,
    allowCrossSessionReuse: true,
  },
  // 登录后才能看到的内容可能包含账号私有数据，默认全禁，且不跨 Session 复用
  // （同一 URL 在不同账号下内容可能完全不同，复用会串数据）。
  authenticated_web: {
    trustZone: "authenticated_web",
    allowSearchServer: false,
    allowCloudModel: false,
    allowCrossSessionReuse: false,
  },
  local_file: {
    trustZone: "local_file",
    allowSearchServer: false,
    allowCloudModel: false,
    allowCrossSessionReuse: false,
  },
  // allowSearchServer 为 false 的原因：spec 写的是「仅企业节点」可发，
  // 而 M1 还没有企业节点这条部署形态，所以现在只能是 false；等企业节点落地后由企业策略下发覆盖。
  // 复用为 true 是因为同租户、同权限范围内的企业文档快照可以共享。
  enterprise: {
    trustZone: "enterprise",
    allowSearchServer: false,
    allowCloudModel: false,
    allowCrossSessionReuse: true,
  },
  // Memory 是用户的长期个人记忆，默认最严：不出站、不跨 Session 复用（复用范围由 Memory scope 另行决定）。
  memory: {
    trustZone: "memory",
    allowSearchServer: false,
    allowCloudModel: false,
    allowCrossSessionReuse: false,
  },
};

/// 未知信任区的兜底策略：全禁。持久化数据跨版本回滚、或配置被手改时会走到这里，
/// 此时唯一安全的选择是 fail-closed。
function denyAllPolicy(trustZone: TrustZone): SourcePolicy {
  return {
    trustZone,
    allowSearchServer: false,
    allowCloudModel: false,
    allowCrossSessionReuse: false,
  };
}

/// 该来源的查询/URL 是否可以发给 Search Server（会出站到自建搜索服务）。
export function canSendToSearchServer(policy: SourcePolicy): boolean {
  return policy.allowSearchServer === true;
}

/// 该来源的正文是否可以发给云模型。
///
/// 这是两道闸门的**与**运算，缺一不可：
/// - Session 级的 ModelDataPolicy 表达「用户这次授权到什么程度」：
///   local_only 恒 false（没有本地模型就直接失败，绝不静默回退云模型）；
///   metadata_only 同样恒 false —— 元数据（标题、域名、统计）走的是另一条构造通道，
///   本函数判定的对象只有正文，所以这里不能因为「只发元数据」就放行；
///   只有 evidence_allowed 才轮到看来源。
/// - 来源级的 policy.allowCloudModel 表达「这份数据本身允不允许出站」。
export function canSendToCloudModel(
  policy: SourcePolicy,
  modelDataPolicy: ModelDataPolicy,
): boolean {
  if (modelDataPolicy !== "evidence_allowed") return false;
  return policy.allowCloudModel === true;
}

/// 该来源的抓取快照是否可以被其它 Session 复用。
///
/// now 由调用方显式传入：packages/core 是平台无关层，不读时钟也不依赖 Date.now，
/// 这样时间相关的判定在测试里完全确定。
/// expiresAt 无法解析或恰好等于 now 时一律判为过期（fail-closed）——授权过期后必须重新走
/// 授权流程，而不是静默沿用旧授权。
export function canReuseAcrossSessions(policy: SourcePolicy, now: Date): boolean {
  if (policy.allowCrossSessionReuse !== true) return false;
  if (policy.expiresAt === undefined) return true;
  const expiresAt = Date.parse(policy.expiresAt);
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > now.getTime();
}

/// 取某信任区的生效策略：默认矩阵 + 用户/企业覆盖。
///
/// **安全不变量：overrides 只能收紧，不能放宽。** true → false 生效，false → true 一律忽略。
/// 理由：overrides 的来源是磁盘配置、企业下发和 IPC 入参，全都可能被篡改或误写；
/// 如果允许放宽，一条 `{ allowCloudModel: true }` 就能把 memory / local_file 的正文送上云端，
/// 默认矩阵形同虚设。真正需要放宽的场景（用户对单个来源显式批准）走独立的授权流程，
/// 由它直接构造 SourcePolicy，而不是借这个函数的覆盖参数绕过默认值。
///
/// overrides.trustZone 同样被忽略——不能借覆盖参数把一个 memory 来源"改判"成 public_web。
export function resolveSourcePolicy(
  trustZone: TrustZone,
  overrides?: Partial<SourcePolicy>,
): SourcePolicy {
  const base = DEFAULT_SOURCE_POLICIES[trustZone] ?? denyAllPolicy(trustZone);
  const policy: SourcePolicy = { ...base, trustZone };
  if (typeof overrides !== "object" || overrides === null) return policy;

  // 只认真正的 false：非布尔脏值（"false"、0）不构成收紧意图，保持默认值。
  policy.allowSearchServer = base.allowSearchServer && overrides.allowSearchServer !== false;
  policy.allowCloudModel = base.allowCloudModel && overrides.allowCloudModel !== false;
  policy.allowCrossSessionReuse =
    base.allowCrossSessionReuse && overrides.allowCrossSessionReuse !== false;

  // 默认矩阵从不带 expiresAt，因此设置一个过期时间只会让复用更早失效，属于收紧。
  if (typeof overrides.expiresAt === "string") {
    policy.expiresAt = overrides.expiresAt;
  }
  return policy;
}
