// 「聚合网关向导」与**已保存的自定义 Provider 定义**之间的转换层。
//
// 为什么单独成文件：PiCustomProviderSection 只需要「这条定义是不是向导生成的」这一个判据来给
// 「编辑」按钮分流，向导本身则要整套编辑种子。把判据塞进向导组件文件会让分区反向依赖一个大
// 组件模块，也不好单测；放这里两边各取所需，且全是纯函数。
//
// ⚠️ 本文件里的两个字符串常量是**跨进程文本契约**：`capabilitySource` 由主进程
// `providers/capability-resolver.ts` 写入（`fallback` 与 `reference:<provider>/<model>` 两种形态），
// 渲染端只读、不造。任一侧改了措辞都必须同步另一侧，否则来源标注会静默显示成错误的类别
// （「保守默认」被显示成「来自目录」是最糟的一种：用户会以为那几个数字是查到的事实）。

import {
  parseCustomProvider,
  readCapabilitySources,
  type CustomProviderDefinition,
  type GatewayDiscoveredModel,
} from "@cortex-work/core/desktop/provider-catalog";
import { secretNameFor } from "./customProviderRules";

/** 主进程 `FALLBACK_SOURCE_REF` 的镜像：能力是保守兜底，不是查到的事实。 */
const FALLBACK_SOURCE = "fallback";

/** 主进程 `applyReferenceModel` 写入的前缀：能力抄自用户指认的某条目录模型。 */
const REFERENCE_PREFIX = "reference:";

/** 向导编辑态的种子：由一条已保存定义反解出来，无需联网即可直接进第二步。 */
export interface GatewaySeed {
  name: string;
  baseUrl: string;
  /** 空串表示定义里没写协议，调用方自行回落到默认协议。 */
  api: string;
  /** 原有的 Secret 名（`${secret:NAME}`）。缺省表示这份配置没有引用任何密钥。 */
  secretName?: string;
  /** 已保存的模型，按定义里的顺序；调用方全部预勾选。 */
  models: GatewayDiscoveredModel[];
}

/**
 * 判断一条自定义 Provider 是否由聚合网关向导生成 —— 决定「编辑」按钮是开向导还是开 JSON 编辑器。
 *
 * 判据：任一模型带 `capabilitySource` 字段。只有向导的生成器（主进程 buildGatewayProviderJson）
 * 会写这个字段，手写 JSON 与预制表单都不会，所以它是一个零误判的来源指纹。
 * 反过来也成立：没有这个字段的定义，向导无从知道每条模型的能力是从哪来的，硬塞进向导会把
 * 「用户自己声明的能力」当成「目录解析出来的能力」重新生成一遍，属于篡改用户配置。
 */
export function isGatewayGenerated(def: CustomProviderDefinition): boolean {
  return Object.keys(readCapabilitySources(def)).length > 0;
}

/**
 * `reference:<provider>/<model>` → `{providerId, modelId}`；其它形态（含 `fallback`、目录命中）返回 undefined。
 *
 * 只在第一个 `/` 处切分：模型 id 本身可能带斜杠（如 `anthropic/claude-sonnet-4`），
 * 从右边切会把 providerId 切错。
 */
export function parseReferenceSource(
  source: string | undefined,
): { providerId: string; modelId: string } | undefined {
  if (!source?.startsWith(REFERENCE_PREFIX)) return undefined;
  const rest = source.slice(REFERENCE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return { providerId: rest.slice(0, slash), modelId: rest.slice(slash + 1) };
}

/** 该来源是否为主进程的保守兜底（UI 据此走「未识别」渲染，不摆能力徽标）。 */
export function isFallbackSource(source: string | undefined): boolean {
  return source === FALLBACK_SOURCE;
}

/**
 * 从定义的 `apiKey` 字段里取回原有的 Secret 名。
 *
 * 编辑时**必须沿用**它：Secret 名原本由供应商名派生（`secretNameFor(slug)`），用户改个显示名
 * 就会算出一个新名字，配置里的引用随之指向一个金库里根本不存在的 Secret，运行期表现为
 * 「Header 为空 → 401」，且没有任何地方会报错。
 */
export function secretNameFromDefinition(def: CustomProviderDefinition): string | undefined {
  const raw = safeParseObject(def.json);
  const apiKey = raw?.apiKey;
  if (typeof apiKey !== "string") return undefined;
  // 名字集合与主进程 SECRET_NAME_RE 对齐（字母数字与 _ . -）。
  return /^\$\{secret:([A-Za-z0-9_.-]+)\}$/.exec(apiKey)?.[1];
}

/**
 * 把一条已保存的定义反解成向导种子。
 *
 * 模型列表刻意**从原始 JSON 的 models 数组枚举**，而不是只用 `parseCustomProvider` 的结果：
 * 后者会丢弃能力字段不全的模型，用它当唯一来源的话，那些模型会在「编辑 → 保存」后从用户
 * 配置里凭空消失。这里改成保留它们、按未识别行渲染，用户可以就地补一个参照模型。
 */
export function seedFromDefinition(def: CustomProviderDefinition): GatewaySeed {
  const parsed = parseCustomProvider(def);
  const sources = readCapabilitySources(def);
  const raw = safeParseObject(def.json);
  const rawModels = Array.isArray(raw?.models) ? raw.models : [];

  const models: GatewayDiscoveredModel[] = [];
  for (const item of rawModels) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id) continue;
    const source = sources[id];
    const caps = parsed?.models.find((m) => m.id === id);
    // 两种情况都按「未识别」行渲染：能力是保守兜底（fallback），或能力字段本就不全。
    // 共同点是**没有确定的能力事实可展示** —— 摆一排徽标会把猜测包装成结论，正是事故根因。
    if (!caps || isFallbackSource(source)) {
      models.push({ id, status: "unknown" });
      continue;
    }
    models.push({ id, status: "known", model: caps, capabilitySource: source });
  }

  return {
    name: parsed?.name ?? def.id,
    baseUrl: parsed?.baseUrl ?? "",
    api: parsed?.api ?? "",
    // 没有 apiKey 引用时回落到按 id（而非按名称）派生 —— id 在编辑态是锁死的，不会漂移。
    secretName: secretNameFromDefinition(def) ?? (hasSecretRef(def) ? secretNameFor(def.id) : undefined),
    models,
  };
}

/** 定义是否引用了任何 Secret（apiKey 之外还可能写在 headers 里）。 */
function hasSecretRef(def: CustomProviderDefinition): boolean {
  return def.secretRefs.length > 0;
}

/** JSON.parse 且只接受「顶层是对象」，与 parseCustomProvider 同一口径（数组要挡掉）。 */
function safeParseObject(json: string): Record<string, unknown> | undefined {
  try {
    const raw: unknown = JSON.parse(json);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
