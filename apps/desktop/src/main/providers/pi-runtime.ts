// pi-ai 运行时的**唯一**接入点：把 safeStorage 金库注入 pi 的 `createModels({ credentials })`，
// 并把认证相关能力收窄成一个可替身的 `PiAuthRuntime` 接口。
//
// ── 为什么是动态 import 且用变量做 specifier ──────────────────────────────────
// `@earendil-works/pi-ai` 是**纯 ESM** 包（package.json `"type":"module"`，exports 只有
// `import` 条件、没有 `require`），而主进程被 electron-vite 打成 **CJS**。静态 import 会被
// rollup 打进 CJS chunk（连带 zod / typebox / MCP SDK），正是 CLAUDE.md 里记的
// 「pi 纯 ESM 依赖闭包在 asar 里反复 ERR_MODULE_NOT_FOUND」那类坑。
// 用变量 specifier + `@vite-ignore` 让打包器完全不参与，运行时保留原生 `import()` 加载 ESM。
// 类型侧走 `import type`（编译期擦除，零运行时/打包影响）。
//
// 打包前置条件（已满足）：`@earendil-works/pi-ai` 是 apps/desktop 的直接依赖、与 pi-coding-agent
// 锁同版本（阶段① 为生成 Catalog 已加），故 electron-builder 裁剪 node_modules 后仍在。
// 依赖既已声明，externalizeDepsPlugin 也会外部化它；这里仍保留变量 specifier 作双保险——
// 一旦外部化因任何原因失效，静态写法会静默把纯 ESM 图打进 CJS chunk，就是历史上那个坑。

import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AuthInteraction,
  AuthType,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  MutableModels,
} from "@earendil-works/pi-ai";

import { createLogger } from "../log";
import { createSafeStorageCredentialStore } from "./credentials";
import { syncCustomProvidersInto } from "./custom-provider-registry";
import { safeErrorMessage } from "./secrets";

const log = createLogger("provider-pi-runtime");

/** 见文件头：刻意不是字符串字面量，避免被打包器静态分析并内联。 */
const PI_AI_ALL = ["@earendil-works", "pi-ai", "providers", "all"].join("/");

/** 连接测试的最小请求：只要能拿到一次成功响应即可，token 上限压到最低以免产生可观费用。 */
const TEST_MAX_TOKENS = 16;
const TEST_TIMEOUT_MS = 60_000;

/** provider 支持的登录方式。UI 据此决定展示「登录」还是「填 API Key」。 */
export interface ProviderAuthCapability {
  providerId: string;
  /** 有 `auth.oauth` 钩子 → 支持 provider-owned OAuth 登录。 */
  oauth: boolean;
  /** 有 `auth.apiKey.login` → 支持交互式填 key；无则是纯 ambient provider。 */
  apiKeyLogin: boolean;
}

/** pi 侧认证能力的收窄视图。抽成接口是为了单测可注入替身，不必真起 pi 运行时。 */
export interface PiAuthRuntime {
  /** 已注册（内建）Provider 的认证能力。 */
  capabilities(): Promise<ProviderAuthCapability[]>;
  /**
   * 免刷新地检查某 Provider 是否已配置完整认证。
   * 返回的 `source` 是 pi 给的人类可读来源标签（"ANTHROPIC_API_KEY" / "OAuth" / "~/.aws/credentials"），
   * 我们据此判定凭据来自 safeStorage 还是环境/ambient。
   */
  checkAuth(providerId: string): Promise<{ type: AuthType; source?: string } | undefined>;
  /** 跑 provider-owned 登录流程并持久化返回的凭据（pi `Models.login`）。 */
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<void>;
  /** 登出。pi **没有** provider 级 logout 钩子，落到 `Models.logout` → `CredentialStore.delete`。 */
  logout(providerId: string): Promise<void>;
  /** 用指定或首个模型发一次最小文本请求。返回实际使用的模型 id。 */
  probe(providerId: string, modelId: string | undefined, signal?: AbortSignal): Promise<{ modelId: string }>;
}

// ── 真实实现（懒加载 pi-ai） ─────────────────────────────────────────────────

let modelsPromise: Promise<MutableModels> | null = null;

/**
 * 取（并缓存）注入了 safeStorage 金库的 pi `Models` 集合。
 *
 * `builtinModels({ credentials })` 会把全部内建 Provider 注册进来，并让 OAuth 刷新走我们的
 * `CredentialStore.modify` —— 也就是走主进程的那把串行锁（见 credentials.ts 文件头）。
 */
async function getModels(): Promise<MutableModels> {
  modelsPromise ??= (async () => {
    const mod = (await import(/* @vite-ignore */ PI_AI_ALL)) as {
      builtinModels: (options?: { credentials?: ReturnType<typeof createSafeStorageCredentialStore> }) => MutableModels;
    };
    return mod.builtinModels({ credentials: createSafeStorageCredentialStore() });
  })().catch((err) => {
    // 失败不缓存：装包/权限问题修好后无需重启即可恢复。
    modelsPromise = null;
    log.error("pi-ai 运行时加载失败:", safeErrorMessage(err));
    throw new Error("模型运行时不可用（pi-ai 加载失败）");
  });
  const models = await modelsPromise;
  // 主进程这份注册表默认只有内建供应商;把用户的自定义供应商也补进来,否则连接测试与
  // Model Gateway（Reply / Research / 日报 / Writing）对自定义模型全都报「模型不存在」。
  // 幂等且廉价,每次取都同步一遍 —— 用户刚改完的定义立刻生效,不必重启。
  // 同步失败不影响内建供应商可用性（内部已吞错）。
  await syncCustomProvidersInto(models);
  return models;
}

/** 从 AssistantMessage 里取纯文本（连接测试只需确认「有响应」，不解析工具调用）。 */
function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function createRealRuntime(): PiAuthRuntime {
  return {
    capabilities: async () => {
      const models = await getModels();
      return models.getProviders().map((provider) => ({
        providerId: provider.id,
        oauth: Boolean(provider.auth.oauth),
        apiKeyLogin: Boolean(provider.auth.apiKey?.login),
      }));
    },
    checkAuth: async (providerId) => {
      const models = await getModels();
      const check = await models.checkAuth(providerId);
      return check ? { type: check.type, source: check.source } : undefined;
    },
    login: async (providerId, type, interaction) => {
      const models = await getModels();
      await models.login(providerId, type, interaction);
    },
    logout: async (providerId) => {
      const models = await getModels();
      await models.logout(providerId);
    },
    probe: async (providerId, modelId, signal) => {
      const models = await getModels();
      const model: Model<Api> | undefined = modelId
        ? models.getModel(providerId, modelId)
        : models.getModels(providerId)[0];
      if (!model) {
        throw new Error(modelId ? `模型不存在：${providerId}/${modelId}` : `该 Provider 没有可用模型：${providerId}`);
      }
      const message = await models.completeSimple(
        model,
        { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
        { maxTokens: TEST_MAX_TOKENS, timeoutMs: TEST_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      if (message.stopReason === "error") {
        throw new Error(message.errorMessage ?? "模型返回错误");
      }
      // 空响应也算失败：拿到 200 但没有任何内容说明链路配置有问题（常见于网关拦截）。
      if (!assistantText(message).trim() && message.content.length === 0) {
        throw new Error("模型返回了空响应");
      }
      return { modelId: model.id };
    },
  };
}

// ── Gateway 运行时（阶段③·4.1） ───────────────────────────────────────────────

/**
 * 文本补全的 pi 侧收窄视图。与 `PiAuthRuntime` 分成两个接口而不是合成一个：
 * 认证链路的替身（provider-auth.test.ts）不该被迫实现补全，反之亦然。
 *
 * 刻意只暴露 `completeSimple` / `streamSimple` 而不是 `complete` / `stream`：
 * 「Simple」这一对接受 provider-neutral 的 `reasoning: ThinkingLevel`，由 pi 自己用**模型
 * 自带的 `thinkingLevelMap`**（Catalog 抄的就是同一份数据）clamp 并翻译成各 api 的私有字段
 * （openai 的 `reasoning_effort`、zai 的 `thinking`、qwen 的 `enable_thinking`…）。
 * 用非 Simple 的那对就得由 Cortex 自己维护一张 api → 私有字段的映射表，
 * 那正是计划 §1「不维护 Cortex 自己的能力映射表」明令禁止的。
 */
export interface PiGatewayRuntime {
  /** 查一个已注册模型；返回 undefined 表示 pi 运行时里没有这个模型引用。 */
  getModel(providerId: string, modelId: string): Promise<Model<Api> | undefined>;
  /** 免刷新地确认 Provider 是否已配置完整认证（未认证 → Gateway 报 config 阻断）。 */
  isAuthenticated(providerId: string): Promise<boolean>;
  completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
  /**
   * 注意签名是 `Promise<流>` 而不是 pi 原生的「同步返回流」：pi 运行时本身是懒加载的
   * （见文件头的动态 import 约束），拿 `Models` 这一步天然异步。返回 Promise 比在外面
   * 再造一个可外部 push 的流壳简单得多，也少一处「装配失败时流永不收尾」的挂死风险。
   */
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<PiEventStream>;
}

/**
 * Gateway 对流的全部需求：迭代事件 + 拿终态消息。
 *
 * 刻意用**结构类型**而不是 pi 的 `AssistantMessageEventStream` 类：那个类带私有字段，
 * 结构类型不兼容，单测替身就只能去实例化真实 pi 类 —— 也就被迫在测试里加载纯 ESM 的
 * pi-ai，与文件头的加载约束正面冲突。pi 的真实流天然满足这个结构。
 */
export interface PiEventStream extends AsyncIterable<AssistantMessageEvent> {
  result(): Promise<AssistantMessage>;
}

function createRealGatewayRuntime(): PiGatewayRuntime {
  return {
    getModel: async (providerId, modelId) => (await getModels()).getModel(providerId, modelId),
    isAuthenticated: async (providerId) => Boolean(await (await getModels()).checkAuth(providerId)),
    completeSimple: async (model, context, options) => (await getModels()).completeSimple(model, context, options),
    streamSimple: async (model, context, options) => (await getModels()).streamSimple(model, context, options),
  };
}

let gatewayRuntime: PiGatewayRuntime | null = null;

/** 取当前 Gateway 运行时（默认真实实现，单测可用 setPiGatewayRuntimeForTests 替身）。 */
export function getPiGatewayRuntime(): PiGatewayRuntime {
  gatewayRuntime ??= createRealGatewayRuntime();
  return gatewayRuntime;
}

/** 单测注入点。传 null 恢复真实实现。 */
export function setPiGatewayRuntimeForTests(next: PiGatewayRuntime | null): void {
  gatewayRuntime = next;
  if (!next) modelsPromise = null;
}

// ── 注入点 ───────────────────────────────────────────────────────────────────

let runtime: PiAuthRuntime | null = null;

/** 取当前运行时（默认真实实现，单测可用 setPiAuthRuntimeForTests 替身）。 */
export function getPiAuthRuntime(): PiAuthRuntime {
  runtime ??= createRealRuntime();
  return runtime;
}

/** 单测注入点。传 null 恢复真实实现。 */
export function setPiAuthRuntimeForTests(next: PiAuthRuntime | null): void {
  runtime = next;
  if (!next) modelsPromise = null;
}

/**
 * 预热：应用启动后台调一次，把 pi 运行时与 capabilities 拉起来，
 * 使首次打开 Provider 设置页不必等 ESM 加载。失败只记日志，不影响启动。
 */
export async function primePiRuntime(): Promise<void> {
  try {
    await getPiAuthRuntime().capabilities();
  } catch (err) {
    log.warn("pi 运行时预热失败（不影响启动）:", safeErrorMessage(err));
  }
}
