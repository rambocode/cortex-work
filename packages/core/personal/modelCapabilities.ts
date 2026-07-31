// 模型能力（当前只用到「是否支持图片输入」）的渲染端只读查询层。
//
// 为什么需要这一层：Catalog 是构建期从 pi 内置目录生成的**只读**系统元数据，经
// `DesktopBridge.providerCatalogGet()` 过一次 IPC 就够了——但发送路径（messages.ts 的 send）
// 每轮都要判「当前模型能不能收图」，不能每次都过 IPC。故这里做**模块级进程内缓存**：
// 首次请求发一次 IPC，之后同步命中；UI 侧另有 React Query 包装（同一份缓存，key 稳定）。
//
// 三条硬约束（改动前先读 docs/2026-07-30-pi-provider-capability-fix-plan.md §2.3 与研究文档 §5.1）：
//   1. **能力三态**：supported / unsupported / unknown。`unknown`（Catalog 里查不到该模型）
//      **绝不允许**退化成 `unsupported` 或 `supported`——前者会让「目录不知道」被当成「明确不支持」
//      而静默丢图，后者会把图片送进真的不支持的模型让 pi 替换成 `(image omitted...)`。
//      两者都是本次事故的形态，故 unknown 单独成态、单独文案。
//   2. **渲染端不是唯一防线**。主进程（extension 生成 + pi 自身的 transform-messages）才是最终
//      权威；这一层只是「发送前的友好拦截」，目的是保住草稿并给用户可操作的出路，
//      而不是替代主进程校验。桥不可用 / Catalog 加载失败时按 unknown 处理（保守阻断）。
//   3. 能力**对用户只读**。这里只有查询，没有任何写入/覆盖入口——用户可改的能力位正是事故根因。

import { useQuery } from "@tanstack/react-query";
import type { DesktopBridge } from "../desktop/bridge";
import {
  findCatalogModel,
  modelSupportsImage,
  type CatalogModel,
  type CatalogProvider,
  type ModelRef,
  type ProviderCatalog,
} from "../desktop/provider-catalog";
import { useDesktopBridge } from "../provider";

/** Catalog 加载结果。`catalog` 与 `error` 互斥；两者皆空表示桥不支持（Web 端 / 旧壳）。 */
export interface CatalogLoadResult {
  catalog?: ProviderCatalog;
  error?: string;
}

/** 模型图片输入能力的三态。语义见文件头约束 1。 */
export type ImageSupport = "supported" | "unsupported" | "unknown";

// 模块级缓存：解析后的结果 + 在途 Promise（并发 send 只打一次 IPC）。
let cached: CatalogLoadResult | undefined;
let inflight: Promise<CatalogLoadResult> | undefined;

/** React Query key。UI 侧与模块缓存共存：前者管重渲染，后者管 send 路径的同步命中。 */
export const providerCatalogKey = ["personal", "providerCatalog"] as const;

/**
 * 加载 Catalog（带进程内缓存）。同一进程只成功加载一次——Catalog 随应用打包，
 * 运行期不会变，故不设 TTL；测试或主进程重载后用 `resetProviderCatalogCache()` 清。
 * 失败**不缓存**，让下次调用能重试（加载失败多半是主进程尚未就绪的时序问题）。
 */
export async function loadProviderCatalog(
  bridge: DesktopBridge | null | undefined,
): Promise<CatalogLoadResult> {
  if (cached) return cached;
  if (inflight) return inflight;
  // 桥或方法缺失（Web 端、旧版本外壳）：返回空结果且**不缓存**，调用方按 unknown 保守处理。
  if (!bridge?.providerCatalogGet) return {};
  inflight = (async () => {
    try {
      const res = await bridge.providerCatalogGet!();
      if (res.ok && res.catalog) {
        cached = { catalog: res.catalog };
        return cached;
      }
      return { error: res.error || "catalog unavailable" };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** 同步取已缓存的 Catalog（未加载过返回 undefined）。仅用于「不能 await」的同步分支。 */
export function peekProviderCatalog(): ProviderCatalog | undefined {
  return cached?.catalog;
}

/** 清空进程内缓存。测试用；主进程重装 Catalog 后也可调用。 */
export function resetProviderCatalogCache(): void {
  cached = undefined;
  inflight = undefined;
}

/**
 * 派生某 Provider 的「会影响 pi extension 内容」的配置摘要，供 `extensionFingerprint` 使用。
 *
 * 为什么需要它：阶段② 后渲染端只持有 providerId，看不到 baseUrl 覆盖与密钥。若指纹只认
 * providerId，用户改了自建网关端点或换了密钥时**温会话不会重开**，新 extension 到下次冷启才
 * 加载 —— 表现为「设置里填了自建网关，请求还发往官方端点」这类无报错的静默失败，正是计划
 * §6「配置变更后经 extensionFingerprint 在下一轮重启」要防的。
 *
 * ⚠️ 只取 `baseUrlOverride` / `configured` / `source` 三项非敏感字段。**绝不放密钥或其摘要**：
 * 指纹会进渲染端内存与比较逻辑，放进去等于把凭据泄回渲染层。密钥更换时 `configured`/`source`
 * 未必变，这一点是已知取舍——换密钥而不换来源时仍需冷启，但那不会指向错误的端点。
 *
 * 拿不到认证状态（Web 端、旧壳、主进程未就绪）时返回 undefined，退化成「只有换 id 才重开」。
 */
export async function providerConfigFingerprint(
  bridge: DesktopBridge | null | undefined,
  providerId: string | undefined,
): Promise<string | undefined> {
  if (!providerId || !bridge?.providerAuthStatus) return undefined;
  try {
    const snapshot = await bridge.providerAuthStatus();
    const status = snapshot.statuses.find((s) => s.providerId === providerId);
    if (!status) return undefined;
    return JSON.stringify({
      baseUrlOverride: status.baseUrlOverride ?? null,
      configured: status.configured,
      source: status.source,
    });
  } catch {
    // 认证状态读失败不该阻断开会话：退化成「只有换 id 才重开」，比整条链路挂掉好。
    return undefined;
  }
}

/**
 * 由已加载的 Catalog 判定图片能力。纯函数、可单测。
 * `modelSupportsImage` 返回 undefined 即「目录里没有这个 {providerId, modelId}」→ unknown。
 */
export function classifyImageSupport(
  catalog: ProviderCatalog | undefined,
  ref: ModelRef | undefined,
): ImageSupport {
  const supported = modelSupportsImage(catalog, ref);
  if (supported === undefined) return "unknown";
  return supported ? "supported" : "unsupported";
}

/**
 * 发送路径用的能力查询：拿 Catalog（缓存命中即同步返回）再判定。
 * ref 缺 providerId 或 modelId（会话还没选模型）一律 unknown——同样阻断，
 * 因为「不知道选了什么模型」和「不知道这个模型行不行」对用户是同一件事：都不能贸然发图。
 */
export async function checkImageSupport(
  bridge: DesktopBridge | null | undefined,
  ref: ModelRef | undefined,
): Promise<ImageSupport> {
  if (!ref?.providerId || !ref.modelId) return "unknown";
  const { catalog } = await loadProviderCatalog(bridge);
  return classifyImageSupport(catalog, ref);
}

/** 在 Catalog 中定位模型（re-export，省得调用方再从 desktop/provider-catalog 引一次）。 */
export function lookupCatalogModel(
  catalog: ProviderCatalog | undefined,
  ref: ModelRef | undefined,
): CatalogModel | undefined {
  return findCatalogModel(catalog, ref);
}

/** 在 Catalog 中定位 Provider。 */
export function lookupCatalogProvider(
  catalog: ProviderCatalog | undefined,
  providerId: string | undefined,
): CatalogProvider | undefined {
  if (!catalog || !providerId) return undefined;
  return catalog.providers.find((p) => p.id === providerId);
}

/**
 * 模型引用是否「悬空」：Catalog 中查不到（Provider 被删/改名、模型下线、旧配置残留）。
 * 计划 §5 要求悬空引用进入阻断态并给设置入口，**不自动回退任何模型**。
 */
export function isDanglingModelRef(
  catalog: ProviderCatalog | undefined,
  ref: ModelRef | undefined,
): boolean {
  if (!ref?.providerId || !ref.modelId) return true;
  return !findCatalogModel(catalog, ref);
}

/** UI 侧 Catalog 订阅。staleTime Infinity —— Catalog 随包不变，重复请求毫无意义。 */
export function useProviderCatalog(): {
  catalog: ProviderCatalog | undefined;
  error: string | undefined;
  loading: boolean;
  /** 桥不支持（Web 端 / 旧壳）：既没有 catalog 也没有 error，UI 应给「桌面端专属」提示。 */
  unsupported: boolean;
} {
  const bridge = useDesktopBridge();
  const supported = !!bridge?.providerCatalogGet;
  const q = useQuery({
    queryKey: providerCatalogKey,
    queryFn: () => loadProviderCatalog(bridge),
    enabled: supported,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return {
    catalog: q.data?.catalog,
    error: q.data?.error,
    loading: supported && q.isLoading,
    unsupported: !supported,
  };
}
