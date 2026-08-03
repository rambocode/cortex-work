// 把用户保存的自定义供应商注册进**主进程内**的 pi-ai 模型注册表。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// 自定义供应商此前只在**聊天**里能用：它是经生成的 extension 文件用 `-e` 注册到被 spawn 的
// pi 子进程里的。而主进程自己还有一份独立的 pi-ai 实例（`pi-runtime.ts` 的 `builtinModels()`），
// 只装了内建供应商 —— 于是所有走主进程那份注册表的功能对自定义供应商全都失效：
//   · 连接测试（`probe`）        → 必报「模型不存在：<id>/<model>」
//   · Pi Model Gateway（`gateway.ts`）→ Reply 草稿 / Research / 日报 / Writing 续写与 Cmd-K
//     在默认模型被设成自定义模型时全部失败
// 两处症状同一个根因：两份注册表内容不一致。本模块把自定义供应商补进主进程那一份。
//
// ── 不可让步的红线 ──────────────────────────────────────────────────────────
//  1. **绝不覆盖内建供应商**：`setProvider` 是按 id upsert 的。若某个自定义 id 与内建撞车而
//     被写进去，就等于用用户声明的能力替换掉 pi 内置目录 —— 那正是 2026-07-30 事故的形态。
//     这里与全链路其它地方一样采用「Catalog 优先」：命中 Catalog 的 id 直接跳过。
//  2. **明文只在请求那一刻存在**：API Key 在 `resolve()` 被调用时才从金库解出来，不在注册时
//     捕获进闭包常驻。这样既缩短明文驻留时间，也让用户改完 Secret 立即生效。
//  3. **不猜能力**：只注册能力字段完整的模型，缺字段的整条丢弃（与 `parseCustomProvider` 同规矩）。

import { safeId } from "../agents/pi-providers";
import { getProviderCatalog } from "./catalog";
import { readSecrets } from "./credentials";
import { listCustomProviders } from "./custom-providers";
import { resolveSecretRefs, safeErrorMessage } from "./secrets";
import { createLogger } from "../log";

const log = createLogger("custom-provider-registry");

// 与 pi-runtime.ts 同款的「bundler 不可见」动态 import：拼出来的 specifier 让 electron-vite
// 不去静态解析它（pi-ai 是纯 ESM，静态引入会被打进包并在 asar 里解析失败）。
const piAiApiModule = (name: string): string => ["@earendil-works", "pi-ai", "api", `${name}.lazy`].join("/");
const PI_AI_MODELS = ["@earendil-works", "pi-ai"].join("/");

/**
 * pi 的 api 标识 → 对应 lazy 工厂的导出名。
 * 只列**自定义供应商用得上**的四种：其余（bedrock / vertex / codex-responses…）都依赖
 * 云 SDK 或 OAuth，不是「填个地址加 Key」能接进来的形态，注册了也用不了。
 */
const API_FACTORY: Record<string, string> = {
  "openai-completions": "openAICompletionsApi",
  "openai-responses": "openAIResponsesApi",
  "anthropic-messages": "anthropicMessagesApi",
  "google-generative-ai": "googleGenerativeAIApi",
};

/** 上一轮注册进去的 id 集合。用户删掉定义后要据此从注册表里摘除，否则会残留成幽灵供应商。 */
let registeredIds = new Set<string>();

/** 能力字段完整才注册 —— 与 `parseCustomProvider` 同一把尺子，缺字段整条丢弃、绝不补默认值。 */
function toModel(raw: unknown, providerId: string, baseUrl: string, providerApi: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  const api = typeof m.api === "string" ? m.api : typeof providerApi === "string" ? providerApi : "";
  const input = Array.isArray(m.input) ? m.input.filter((x) => x === "text" || x === "image") : [];
  if (typeof m.id !== "string" || !m.id || !API_FACTORY[api]) return undefined;
  if (!input.length || typeof m.reasoning !== "boolean") return undefined;
  if (typeof m.contextWindow !== "number" || typeof m.maxTokens !== "number") return undefined;

  const cost = (m.cost ?? {}) as Record<string, unknown>;
  return {
    id: m.id,
    name: typeof m.name === "string" ? m.name : m.id,
    api,
    provider: providerId,
    baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : baseUrl,
    reasoning: m.reasoning,
    ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
    input,
    cost: {
      input: typeof cost.input === "number" ? cost.input : 0,
      output: typeof cost.output === "number" ? cost.output : 0,
      cacheRead: typeof cost.cacheRead === "number" ? cost.cacheRead : 0,
      cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : 0,
    },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    ...(m.headers && typeof m.headers === "object" ? { headers: m.headers } : {}),
    // compat 原样带上：它决定 role / max_tokens 字段名等线格式，丢了会让非 OpenAI 上游 400
    //（详见 capability-resolver.ts 里的实测记录）。
    ...(m.compat !== undefined ? { compat: m.compat } : {}),
  };
}

/**
 * 由一条自定义供应商定义构造 pi-ai 的 `Provider`。
 * 返回 undefined 表示这条定义不可用（JSON 坏了 / 没有一个能力完整的模型 / 协议不支持）。
 */
async function buildProvider(
  definition: { id: string; json: string },
  deps: { createProvider: (input: Record<string, unknown>) => unknown; apiFor: (api: string) => Promise<unknown> },
): Promise<{ id: string; provider: unknown } | undefined> {
  const id = safeId(definition.id);
  let parsed: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(definition.json);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    parsed = raw as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const baseUrl = typeof parsed.baseUrl === "string" ? parsed.baseUrl : "";
  if (!/^https?:\/\//i.test(baseUrl)) return undefined;

  const models = (Array.isArray(parsed.models) ? parsed.models : [])
    .map((m) => toModel(m, id, baseUrl, parsed.api))
    .filter((m): m is Record<string, unknown> => !!m);
  if (!models.length) return undefined;

  // 每个用到的 api 各挂一份实现；`createProvider` 按 model.api 分派。
  const apiMap: Record<string, unknown> = {};
  for (const api of new Set(models.map((m) => String(m.api)))) {
    apiMap[api] = await deps.apiFor(api);
  }

  const name = typeof parsed.name === "string" && parsed.name ? parsed.name : id;
  const rawApiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : undefined;

  return {
    id,
    provider: deps.createProvider({
      id,
      name,
      baseUrl,
      ...(parsed.headers && typeof parsed.headers === "object" ? { headers: parsed.headers } : {}),
      auth: {
        apiKey: {
          name: `${name} API key`,
          // ⚠️ 明文在这里才解出来，而不是在注册时捕获进闭包：既缩短驻留时间，
          // 也让用户在「Secret 管理」里改完之后**立即**生效，不必重启或重存供应商。
          resolve: async () => {
            if (!rawApiKey) return undefined;
            const { text, missing } = resolveSecretRefs(rawApiKey, await readSecrets());
            // 缺引用时返回 undefined（= 未配置），绝不把带 `${secret:}` 的字面量当成密钥发出去。
            if (missing.length || !text.trim()) return undefined;
            return { auth: { apiKey: text }, source: "Cortex 密钥库" };
          },
        },
      },
      models,
      api: apiMap,
    }),
  };
}

/**
 * 把全部自定义供应商同步进给定的 pi-ai 注册表（幂等，可重复调用）。
 *
 * 调用方（`pi-runtime.getModels`）每次取注册表时都会调一遍：`listCustomProviders` 有进程内
 * 缓存、`setProvider` 只是一次 Map 写入，代价可忽略，换来的是「用户刚改完的定义立刻生效」。
 */
// 泛型化 provider 类型（而不是写死 unknown）：`MutableModels.setProvider` 的形参是
// `Provider<Api>`，函数参数是逆变的，用 unknown 会类型不兼容。泛型让调用方把自己的类型带进来，
// 本模块因此不必 import pi-ai 的类型（它是纯 ESM、只能动态引入，静态类型引用会拖进打包）。
export async function syncCustomProvidersInto<TProvider>(models: {
  setProvider: (provider: TProvider) => void;
  deleteProvider: (id: string) => void;
}): Promise<void> {
  let definitions: { id: string; json: string }[];
  try {
    definitions = await listCustomProviders();
  } catch (err) {
    log.warn("读取自定义供应商失败，本轮不同步:", safeErrorMessage(err));
    return;
  }

  // Catalog 优先：命中内建 id 的自定义定义一律跳过，绝不 upsert 覆盖内建供应商。
  let builtinIds: Set<string>;
  try {
    builtinIds = new Set(getProviderCatalog()?.providers.map((p) => p.id) ?? []);
  } catch {
    builtinIds = new Set();
  }

  let deps: Parameters<typeof buildProvider>[1];
  try {
    const mod = (await import(/* @vite-ignore */ PI_AI_MODELS)) as {
      createProvider: (input: Record<string, unknown>) => unknown;
    };
    const apiCache = new Map<string, unknown>();
    deps = {
      createProvider: mod.createProvider,
      apiFor: async (api) => {
        if (!apiCache.has(api)) {
          const m = (await import(/* @vite-ignore */ piAiApiModule(api))) as Record<string, () => unknown>;
          apiCache.set(api, m[API_FACTORY[api]!]!());
        }
        return apiCache.get(api);
      },
    };
  } catch (err) {
    log.warn("pi-ai 加载失败，自定义供应商本轮不进主进程注册表:", safeErrorMessage(err));
    return;
  }

  const next = new Set<string>();
  for (const definition of definitions) {
    const id = safeId(definition.id);
    if (builtinIds.has(id)) {
      log.warn(`自定义供应商「${definition.id}」与内建供应商同名，已跳过（不覆盖内建目录）`);
      continue;
    }
    try {
      const built = await buildProvider(definition, deps);
      if (!built) continue;
      models.setProvider(built.provider as TProvider);
      next.add(built.id);
    } catch (err) {
      // 单条坏定义不该拖垮整批同步 —— 其余供应商照常注册。
      log.warn(`自定义供应商「${definition.id}」注册失败:`, safeErrorMessage(err));
    }
  }

  // 用户删掉的定义要从注册表里摘除，否则会残留成一个「选得到但配置已不存在」的幽灵供应商。
  for (const id of registeredIds) if (!next.has(id)) models.deleteProvider(id);
  registeredIds = next;
}

/** 单测用：清掉「上一轮注册了哪些」的进程内状态。 */
export function resetCustomProviderRegistryForTests(): void {
  registeredIds = new Set();
}
