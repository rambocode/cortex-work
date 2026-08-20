// 把一条已校验的 Cortex 自定义 Provider 定义构造成 pi-ai 原生 Provider。
//
// 本模块刻意只依赖纯函数与注入的 Secret 读取器：主进程和 pi-host worker 都要复用同一套
// 模型能力、协议实现、兼容参数与 Secret 解析规则。若各自维护一份，设置页连接测试与聊天会话
// 很容易再次出现「一边能用、一边报模型不存在」的注册表漂移。

import type { Provider } from "@earendil-works/pi-ai";

import { safeId } from "../agents/pi-providers";
import { importPiRuntimeModule } from "../agents/pi-inproc/runtime";
import { collectSecretRefs, resolveSecretRefs } from "./secrets";

/** 自定义 Provider 在进程间传递的安全形状；JSON 只含 `${secret:...}` 引用，不含解密后的真值。 */
export interface CustomProviderSource {
  id: string;
  json: string;
}

export interface CustomProviderBuildOptions {
  /**
   * 按名字读取 Secret。主进程从 safeStorage 读取；worker 经 credential RPC 回主进程读取。
   * 缺失项不要出现在返回对象里，构造器会拒绝把未解析的占位符当成凭据发出去。
   */
  readSecrets(names: readonly string[]): Promise<Readonly<Record<string, string>>>;
  /** Header 引用缺失时仅用于留痕；回调只收到名字，绝不收到 Secret 真值。 */
  onMissingHeaderSecrets?: (providerId: string, header: string, names: readonly string[]) => void;
}

// specifier 仍须由变量拼出，避免 bundler 静态内联纯 ESM 图；真正 import 统一经过
// pi-inproc/runtime.ts，因为只有它同时处理主进程 app.asar 与 unpacked worker 两种父链。
const piAiApiModule = (name: string): string => ["@earendil-works", "pi-ai", "api", `${name}.lazy`].join("/");
const PI_AI_MODELS = ["@earendil-works", "pi-ai"].join("/");

/** 自定义端点能稳定接入的四类流式 API；其它类型依赖云 SDK 或 OAuth，不应在这里猜接法。 */
const API_FACTORY: Record<string, string> = {
  "openai-completions": "openAICompletionsApi",
  "openai-responses": "openAIResponsesApi",
  "anthropic-messages": "anthropicMessagesApi",
  "google-generative-ai": "googleGenerativeAIApi",
};

/** 解析 Header 中的 Secret 引用；缺任一引用时丢弃整条 Header，避免发出半解析凭据。 */
function resolveHeaderSecrets(
  headers: Record<string, unknown>,
  secrets: Readonly<Record<string, string>>,
  onDrop: (key: string, missing: string[]) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    const { text, missing } = resolveSecretRefs(value, secrets);
    if (missing.length) {
      onDrop(key, missing);
      continue;
    }
    out[key] = text;
  }
  return out;
}

/** 能力字段完整才注册；缺字段的模型整条丢弃，不用默认值伪造能力。 */
function toModel(
  raw: unknown,
  providerId: string,
  baseUrl: string,
  providerApi: unknown,
  resolveHeaders: (headers: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const model = raw as Record<string, unknown>;
  const api = typeof model.api === "string" ? model.api : typeof providerApi === "string" ? providerApi : "";
  const input = Array.isArray(model.input) ? model.input.filter((item) => item === "text" || item === "image") : [];
  if (typeof model.id !== "string" || !model.id || !API_FACTORY[api]) return undefined;
  if (!input.length || typeof model.reasoning !== "boolean") return undefined;
  if (typeof model.contextWindow !== "number" || typeof model.maxTokens !== "number") return undefined;

  const cost = (model.cost ?? {}) as Record<string, unknown>;
  return {
    id: model.id,
    name: typeof model.name === "string" ? model.name : model.id,
    api,
    provider: providerId,
    baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input,
    cost: {
      input: typeof cost.input === "number" ? cost.input : 0,
      output: typeof cost.output === "number" ? cost.output : 0,
      cacheRead: typeof cost.cacheRead === "number" ? cost.cacheRead : 0,
      cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers && typeof model.headers === "object"
      ? { headers: resolveHeaders(model.headers as Record<string, unknown>) }
      : {}),
    ...buildCompat(model),
  };
}

/** 自定义网关域名通常无法触发 pi-ai 的官方端点探测，按模型族系补推理协议格式。 */
function inferThinkingCompat(model: Record<string, unknown>): string | undefined {
  if (model.reasoning !== true) return undefined;
  const key = `${typeof model.id === "string" ? model.id : ""} ${typeof model.name === "string" ? model.name : ""}`.toLowerCase();
  if (/deepseek/.test(key)) return "deepseek";
  if (/\bglm|zai/.test(key)) return "zai";
  if (/qwen|qwq/.test(key)) return "qwen";
  return undefined;
}

/** 用户显式 compat 永远优先于族系推断。 */
function buildCompat(model: Record<string, unknown>): { compat?: unknown } {
  const inferred = inferThinkingCompat(model);
  const explicit =
    model.compat !== undefined && typeof model.compat === "object" && model.compat !== null
      ? (model.compat as Record<string, unknown>)
      : undefined;
  if (!inferred && model.compat === undefined) return {};
  if (!inferred) return { compat: model.compat };
  return { compat: { thinkingFormat: inferred, ...(explicit ?? {}) } };
}

/** 收集 Provider 与各模型 Header 中的 Secret 名，避免为顶层 apiKey 提前解密并常驻。 */
function collectHeaderSecretRefs(parsed: Record<string, unknown>): string[] {
  const refs: string[] = [];
  const append = (headers: unknown): void => {
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return;
    for (const name of collectSecretRefs(JSON.stringify(headers))) if (!refs.includes(name)) refs.push(name);
  };
  append(parsed.headers);
  if (Array.isArray(parsed.models)) {
    for (const raw of parsed.models) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) append((raw as Record<string, unknown>).headers);
    }
  }
  return refs;
}

/**
 * 构造可直接交给 `ModelRuntime.registerNativeProvider()` 的 pi-ai Provider。
 *
 * API key 在 pi 真正请求认证时才读取，避免明文随会话常驻；Header 没有延迟解析钩子，只能在
 * 注册时解析，但仍只存在于 worker 内存，不经 open 协议传输、不落盘。
 */
export async function buildCustomProvider(
  definition: CustomProviderSource,
  options: CustomProviderBuildOptions,
): Promise<{ id: string; provider: Provider } | undefined> {
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

  const headerRefs = collectHeaderSecretRefs(parsed);
  const headerSecrets = headerRefs.length ? await options.readSecrets(headerRefs) : {};
  const resolveHeaders = (headers: Record<string, unknown>): Record<string, unknown> =>
    resolveHeaderSecrets(headers, headerSecrets, (header, missing) =>
      options.onMissingHeaderSecrets?.(id, header, missing),
    );

  const models = (Array.isArray(parsed.models) ? parsed.models : [])
    .map((model) => toModel(model, id, baseUrl, parsed.api, resolveHeaders))
    .filter((model): model is Record<string, unknown> => !!model);
  if (!models.length) return undefined;

  const apiMap: Record<string, unknown> = {};
  for (const api of new Set(models.map((model) => String(model.api)))) {
    const module = await importPiRuntimeModule<Record<string, () => unknown>>(piAiApiModule(api));
    apiMap[api] = module[API_FACTORY[api]!]!();
  }
  const piAi = await importPiRuntimeModule<{
    createProvider: (input: Record<string, unknown>) => Provider;
  }>(PI_AI_MODELS);

  const name = typeof parsed.name === "string" && parsed.name ? parsed.name : id;
  const rawApiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : undefined;
  return {
    id,
    provider: piAi.createProvider({
      id,
      name,
      baseUrl,
      ...(parsed.headers && typeof parsed.headers === "object"
        ? { headers: resolveHeaders(parsed.headers as Record<string, unknown>) }
        : {}),
      auth: {
        apiKey: {
          name: `${name} API key`,
          resolve: async () => {
            if (!rawApiKey) return undefined;
            const refs = collectSecretRefs(rawApiKey);
            const { text, missing } = resolveSecretRefs(rawApiKey, refs.length ? await options.readSecrets(refs) : {});
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
