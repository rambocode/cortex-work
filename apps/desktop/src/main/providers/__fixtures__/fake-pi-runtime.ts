// 单测共用的 pi 运行时替身（阶段③·4.1 收编后，各调用方的测试都从这里取）。
//
// 收编前这些测试注入的是 `fetchFn`，因为每个调用方自己拼 URL 发 HTTP。收编后出站口是
// pi 的 `Models`，替身自然下移到同一层（理由详见 gateway.test.ts 文件头：bedrock / vertex
// 根本不走 fetch，在 fetch 上挖替身会漏掉最不该真调的两种协议）。
//
// 放在 `__fixtures__/` 而不是 `*.test.ts` 旁：它被多个目录下的测试引用，且静态检查
//（no-direct-endpoint.test.ts）扫源码时会跳过这个目录。

import type { AssistantMessage, AssistantMessageEvent, Api, Context, Model } from "@earendil-works/pi-ai";

import type { PiGatewayRuntime } from "../pi-runtime";
import type { CatalogModel, CatalogProvider, ProviderCatalog } from "../contract";

/** 一次出站调用的可观测记录。 */
export interface FakeRuntimeCall {
  model: Model<Api>;
  context: Context;
  options?: Record<string, unknown>;
}

export interface FakePiRuntime extends PiGatewayRuntime {
  calls: FakeRuntimeCall[];
}

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 造一条 pi 终态回复消息。 */
export function fakeAssistantMessage(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "p1",
    model: "m1",
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  } as AssistantMessage;
}

export interface FakeRuntimeOptions {
  /** 每次调用依次返回的正文；用完后重复最后一条。抛错用 `() => { throw ... }` 形式的 respond。 */
  texts?: string[];
  /** 完全自定义单次响应（优先于 texts）。入参是本次调用序号（从 0 起）。 */
  respond?: (index: number, call: FakeRuntimeCall) => AssistantMessage | Promise<AssistantMessage>;
  /** 流式时把正文切成几段增量下发（默认整段一次）。 */
  chunk?: (text: string) => string[];
  /** 模型是否存在（默认存在）。 */
  hasModel?: boolean;
  /** Provider 是否已认证（默认是）。 */
  authenticated?: boolean;
}

/**
 * 造一个可观测的 pi 运行时替身。默认「模型存在 + 已认证 + 每次返回 texts 里的下一条」。
 * **从不发起任何真实网络请求**，所以所有用它的测试都是零网络的。
 */
export function createFakePiRuntime(options: FakeRuntimeOptions = {}): FakePiRuntime {
  const calls: FakeRuntimeCall[] = [];
  const texts = options.texts ?? ["ok"];
  const nextMessage = async (call: FakeRuntimeCall): Promise<AssistantMessage> => {
    const index = calls.length - 1;
    if (options.respond) return options.respond(index, call);
    return fakeAssistantMessage(texts[Math.min(index, texts.length - 1)] ?? "");
  };

  return {
    calls,
    getModel: async (providerId, modelId) =>
      options.hasModel === false
        ? undefined
        : ({ id: modelId, provider: providerId, api: "openai-completions" } as Model<Api>),
    isAuthenticated: async () => options.authenticated !== false,
    completeSimple: async (model, context, opts) => {
      const call = { model, context, options: opts as Record<string, unknown> };
      calls.push(call);
      return nextMessage(call);
    },
    streamSimple: async (model, context, opts) => {
      const call = { model, context, options: opts as Record<string, unknown> };
      calls.push(call);
      const message = await nextMessage(call);
      const full = message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const parts = options.chunk ? options.chunk(full) : [full];
      return {
        async *[Symbol.asyncIterator]() {
          for (const delta of parts) {
            if (!delta) continue;
            yield { type: "text_delta", contentIndex: 0, delta, partial: message } as AssistantMessageEvent;
          }
        },
        result: async () => message,
      };
    },
  };
}

/** 造一个只含单个 provider / 单个模型的 Catalog，供 Gateway 的引用解析用。 */
export function fakeCatalog(
  providerId = "p1",
  modelId = "m1",
  model: Partial<CatalogModel> = {},
  provider: Partial<CatalogProvider> = {},
): ProviderCatalog {
  return {
    schemaVersion: 1,
    piVersion: "0.82.1",
    hash: "test",
    providers: [
      {
        id: providerId,
        name: providerId,
        api: "openai-completions",
        baseUrl: "https://api.example.com",
        auth: ["api-key"],
        models: [
          {
            id: modelId,
            name: modelId,
            api: "openai-completions",
            input: ["text"],
            reasoning: false,
            contextWindow: 128_000,
            maxTokens: 8_192,
            ...model,
          },
        ],
        ...provider,
      },
    ],
  };
}
