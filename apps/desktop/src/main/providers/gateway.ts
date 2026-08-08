// Pi Model Gateway（阶段③·4.1）：**全仓文本补全的唯一出口**。
//
// 收编前，Reply / Research / Timeline / Writing / 做梦蒸馏各自从旧 `providerSettings` 里取
// baseUrl+apiKey，自己拼 OpenAI 兼容的 chat completions 端点。那套做法有三个不可修补的问题：
//   1. 只会说 OpenAI 兼容一种协议 —— Anthropic / Bedrock / Vertex / Responses 全都调不动；
//   2. 明文 apiKey 必须流经业务模块；
//   3. 模型能力（能不能推理、thinking 档位怎么翻译）得由 Cortex 自己猜——正是本次事故的根因。
// 现在统一交给 pi 的 `Models`：协议分发、认证解析、thinking 档位翻译、usage 全部由 pi 负责，
// Cortex 只做寻址（`{providerId, modelId}`）、取消、错误分类三件事。
//
// ── 三条不可回退的约束 ────────────────────────────────────────────────────────
//
// 1. **工具集永远为空**。`buildPiContext()` 是本文件构造 pi `Context` 的唯一处，它结构上
//    不接受、也从不写 `Context.tools`；`GatewayCompleteRequest`（contract.ts）同样没有任何
//    tools 字段。于是「处理 public_web 正文的模型调用不得挂载文件 / Memory / 发送 / 终端 /
//    写工具」这条 prompt injection 防线（research spec §6.1 第 4 条）在**类型层面**成立，
//    "忘了关工具" 这个错误无法发生 —— 与被它取代的 postChatCompletion 是同一种保证方式。
//    gateway.test.ts 对此有回归断言。
//
// 2. **不自动回退任何模型**。模型引用在 Catalog 中不存在、pi 运行时里没注册、或 Provider 未
//    认证，一律返回 `errorKind: "config"` 让调用方进阻断态（计划 §5）。悄悄换一个"能用的"
//    模型会把用户的正文发给他没选过的供应商。
//
// 3. **凭据不进日志 / 错误详情**。所有对外的错误文案都过 `safeErrorMessage`（secrets.ts）——
//    provider SDK 的异常经常把请求头（含 Authorization）和响应体（含 token）塞进 message。
//
// ── 截断（stopReason === "length"）为什么不是失败 ──────────────────────────────
// 截断的输出**有时仍然可用**（报告正文截掉结尾一段，总比整个 Session 失败好），所以以
// `truncated: true` 的形式随成功结果返回，由调用方决定怎么处理；`ipc/openai-chat.ts` 把它
// 翻成沿用至今的 `TRUNCATED_MARKER` 尾标记。
// ⚠️ IPC 侧的 `GatewayCompleteResult`（contract.ts，与 core 逐字镜像）没有 truncated 位，
// 本阶段刻意不动那份契约；渲染端目前也没有 Gateway 消费方。主进程内部消费方一律走本文件的
// `runGatewayComplete` / `runGatewayStream`，能拿到完整的 truncated。

import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  ThinkingLevel,
  UserMessage,
  Usage,
} from "@earendil-works/pi-ai";

import { getProviderCatalog } from "./catalog";
import { listCustomProviders } from "./custom-providers";
import type {
  CatalogModel,
  GatewayCompleteRequest,
  GatewayCompleteResult,
  GatewayErrorKind,
  GatewayMessage,
  GatewayStreamEvent,
  GatewayUsage,
  ModelRef,
} from "./contract";
import { getPiGatewayRuntime, type PiGatewayRuntime } from "./pi-runtime";
import { safeErrorMessage } from "./secrets";

/** pi `UserMessage.content` 的形状（字符串或 text/image 块数组）。 */
type UserContent = UserMessage["content"];

/** 默认单次调用超时。与被取代的 postChatCompletion 保持同值，避免收编顺带改了行为。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** pi 的 thinking 档位全集（`ThinkingLevel`）。用户传来的字符串必须命中其一才下发。 */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** 主进程内部消费方拿到的完整结果（比 IPC 的 GatewayCompleteResult 多一个 truncated）。 */
export interface GatewayOutcome {
  ok: boolean;
  text: string;
  usage?: GatewayUsage;
  /** stopReason === "length"：输出被 token 上限截断，但内容仍然可用。 */
  truncated: boolean;
  error?: string;
  errorKind?: GatewayErrorKind;
}

/** 调用侧的附加参数（不进 IPC 契约：signal 与注入点都过不了桥）。 */
export interface GatewayCallOptions {
  /** 调用方取消信号。与 requestId 注册的控制器、超时信号三者取或。 */
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 单测注入口。生产不传，走 pi 真实运行时。 */
  runtime?: PiGatewayRuntime;
}

// ── 取消注册表 ────────────────────────────────────────────────────────────────

/**
 * requestId → 该请求的取消控制器。渲染端只能拿到 requestId（AbortSignal 过不了 IPC），
 * `modelGateway:abort` 据此中止在途请求。
 * 请求结束（成功 / 失败 / 取消）必须在 finally 里注销，否则长跑进程会泄漏 controller。
 */
const inflight = new Map<string, AbortController>();

/** 按 requestId 取消一个在途请求。返回是否真的找到并取消了。 */
export function abortGatewayRequest(requestId: string): boolean {
  const controller = inflight.get(requestId);
  if (!controller) return false;
  controller.abort();
  return true;
}

/** 仅供单测：清空注册表，避免用例之间互相污染。 */
export function __resetGatewayInflightForTests(): void {
  inflight.clear();
}

// ── 模型解析（Catalog + pi 运行时 + 认证，三关都过才出站） ──────────────────────

interface ResolveOk {
  ok: true;
  model: Model<Api>;
  catalogModel: CatalogModel;
}
interface ResolveFail {
  ok: false;
  error: string;
  errorKind: GatewayErrorKind;
}

/**
 * 把 `{providerId, modelId}` 解析成一个可出站的 pi `Model`。
 *
 * 三关顺序有意如此：Catalog（随包静态目录，最便宜且不触网）→ pi 运行时注册表 → 认证。
 * 任一关不过都是 `config`：对用户而言这三种都是「去设置里把模型配好」，
 * 而不是「重试一下」。**绝不回退到别的模型**（计划 §5）。
 */
async function resolveModel(ref: ModelRef, runtime: PiGatewayRuntime): Promise<ResolveOk | ResolveFail> {
  const providerId = ref.providerId?.trim();
  const modelId = ref.modelId?.trim();
  if (!providerId || !modelId) {
    return { ok: false, error: "未配置模型", errorKind: "config" };
  }

  // 自定义供应商本就不在随包 Catalog 里（那是 pi 内置目录的快照），它们经
  // `custom-provider-registry` 注册进主进程 pi 运行时。对这类引用跳过 Catalog 这一关，
  // 改由运行时注册表把关 —— 「不自动回退」的保证没有松动:下面 getModel 取不到照样阻断。
  // 不这么做，Reply / Research / 日报 / Writing 在默认模型是自定义模型时全部失败。
  const isCustom = (await listCustomProviders()).some((item) => item.id === providerId);

  const catalog = getProviderCatalog();
  if (!catalog && !isCustom) {
    return { ok: false, error: "Provider 目录不可用（随包 Catalog 校验失败）", errorKind: "config" };
  }
  const provider = catalog?.providers.find((p) => p.id === providerId);
  const catalogHit = provider?.models.find((m) => m.id === modelId);
  if (!catalogHit && !isCustom) {
    // 既不在内置目录、也不是自定义供应商 —— 是一条悬空引用。
    // 文案要说清是「引用无效」而非「网络问题」，否则用户会去重试而不是去设置里改。
    return { ok: false, error: `模型引用无效：${providerId}/${modelId}`, errorKind: "config" };
  }

  const model = await runtime.getModel(providerId, modelId);
  if (!model) {
    return { ok: false, error: `模型未注册：${providerId}/${modelId}`, errorKind: "config" };
  }

  if (!(await runtime.isAuthenticated(providerId))) {
    return { ok: false, error: `供应商未认证：${providerId}`, errorKind: "config" };
  }

  // catalogModel 只被 resolveThinkingLevel 消费（读 reasoning / thinkingLevelMap）。
  // 自定义供应商没有目录条目，就从运行时那份 Model 派生 —— 同一份数据，只是来源不同。
  return { ok: true, model, catalogModel: catalogHit ?? toCatalogShape(model) };
}

/** 运行时 `Model` → `CatalogModel` 形状（自定义供应商没有目录条目时用）。 */
function toCatalogShape(model: Model<Api>): CatalogModel {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    input: model.input,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap as Record<string, string | null> } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  };
}

/**
 * 把请求里的 thinkingLevel 收敛成可下发给 pi 的 `reasoning`。
 *
 * 这里**只做取舍判定，不做字符串翻译**：真正翻成 provider 私有值（`reasoning_effort` /
 * `enable_thinking` / `thinking` …）是 pi 用模型自带 `thinkingLevelMap` 做的，而 Catalog 里的
 * `thinkingLevelMap` 抄的就是同一份数据。Cortex 再翻一次等于维护第二张映射表（计划 §1 禁止）。
 *
 * 判定规则：模型不支持推理、档位不是 pi 合法值、或 Catalog 把该档位显式标成不支持（
 * `thinkingLevelMap[level] === null`）→ 返回 undefined，即不下发思考参数。
 * 不报错是刻意的：thinking 是可选增强，为它整条调用失败对用户毫无价值。
 */
function resolveThinkingLevel(catalogModel: CatalogModel, level: string | undefined): ThinkingLevel | undefined {
  if (!level || level === "off") return undefined;
  if (!catalogModel.reasoning) return undefined;
  if (!THINKING_LEVELS.includes(level as ThinkingLevel)) return undefined;
  const mapped = catalogModel.thinkingLevelMap?.[level];
  if (mapped === null) return undefined;
  return level as ThinkingLevel;
}

// ── 请求构造 ──────────────────────────────────────────────────────────────────

/** 图片块缺 base64 数据时的错误。见 toPiContent —— 宁可整条失败也不静默发一张空图。 */
class MissingImageDataError extends Error {
  constructor() {
    super("图片内容缺少 base64 数据（Gateway 不读磁盘，调用方需自行把 imagePath 读成 dataBase64）");
  }
}

/**
 * 把 Gateway 的内容块翻成 pi 的 content 数组。图片以 base64 内联（pi 的 `ImageContent` 形状）。
 *
 * `GatewayContentBlock.imagePath` **不被支持**：Gateway 是纯计算模块，不碰文件系统
 * （读盘要做路径校验、大小限制、MIME 魔数检测，那是调用方各自的入口该做的事）。
 * 缺 `dataBase64` 时直接抛错而不是补空串 —— 静默发出一张空图正是本次事故
 *（图片被替换成 `(image omitted...)` 占位文本）的同一类形态。
 */
function toPiContent(content: GatewayMessage["content"]): UserContent {
  if (typeof content === "string") return content;
  return content.map((block) => {
    if (block.type !== "image") return { type: "text" as const, text: block.text ?? "" };
    if (!block.dataBase64) throw new MissingImageDataError();
    return { type: "image" as const, data: block.dataBase64, mimeType: block.mimeType ?? "image/png" };
  });
}

/**
 * 构造 pi `Context`。**本文件构造 Context 的唯一处**，且刻意不写 `tools` —— 见文件头约束 1。
 *
 * system 的两个来源（`req.system` 与 messages 里的 system 角色）合并成 `Context.systemPrompt`：
 * pi 的 `Message` 联合类型里根本没有 system 角色，system 是 Context 上的独立字段。
 * 多条 system 按出现顺序换行拼接，保证静态前缀仍在最前（prompt 缓存命中前缀不被打乱）。
 */
function buildPiContext(req: GatewayCompleteRequest): Context {
  const systemParts: string[] = [];
  if (req.system?.trim()) systemParts.push(req.system);
  const messages: Message[] = [];
  for (const message of req.messages) {
    if (message.role === "system") {
      if (typeof message.content === "string") systemParts.push(message.content);
      else systemParts.push(message.content.map((b) => b.text ?? "").join("\n"));
      continue;
    }
    // assistant 角色的 content 在 pi 里是另一组块类型（含 thinking / toolCall），
    // 但 Gateway 只回填纯文本历史，故两者共用 toPiContent 的输出后再收窄。
    messages.push({
      role: message.role,
      content: toPiContent(message.content),
      timestamp: Date.now(),
    } as unknown as Message);
  }
  return {
    ...(systemParts.length > 0 ? { systemPrompt: systemParts.join("\n") } : {}),
    messages,
  };
}

/** 取 AssistantMessage 里的纯文本（thinking 与 toolCall 块不进正文）。 */
function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** pi Usage → Gateway Usage（只保留 token 数，成本由 UI 自己按 Catalog 的 cost 算）。 */
function toGatewayUsage(usage: Usage | undefined): GatewayUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}

// ── 错误分类 ──────────────────────────────────────────────────────────────────

/**
 * 把任意异常 / pi 的错误态归到 `GatewayErrorKind`。
 *
 * 分类只看**已清洗过的文案**与错误名，不碰 error 对象的其它字段：provider SDK 的 error 上
 * 挂着 response body 与 request headers，读它们等于把密钥引进日志（见 secrets.ts 文件头）。
 *
 * `config` 不在这里产生 —— 它只来自 resolveModel 的三关，是「发出去之前就知道不行」。
 */
export function classifyGatewayError(err: unknown, message: string): GatewayErrorKind {
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || /\baborted\b|已取消/i.test(message)) return "aborted";
  if (name === "TimeoutError") return "aborted";
  // pi 的 ModelsError.code 是 "auth" / "oauth" 时确定是认证问题；HTTP 401/403 同理。
  const code = (err as { code?: unknown })?.code;
  if (code === "auth" || code === "oauth") return "auth";
  if (/\b(401|403)\b|unauthorized|forbidden|invalid[_ -]?api[_ -]?key/i.test(message)) return "auth";
  if (/\b429\b|rate[_ -]?limit|too many requests|quota/i.test(message)) return "rate-limit";
  if (code === "provider" || code === "stream" || /\b(4\d{2}|5\d{2})\b/.test(message)) return "provider";
  return "unknown";
}

/** 从 pi 的失败 AssistantMessage 归一出 { message, kind }。 */
function classifyAssistantFailure(message: AssistantMessage): { error: string; errorKind: GatewayErrorKind } {
  const text = safeErrorMessage(message.errorMessage, "模型调用失败");
  if (message.stopReason === "aborted") return { error: "模型调用已取消或超时", errorKind: "aborted" };
  return { error: text, errorKind: classifyGatewayError(undefined, text) };
}

// ── 信号编排 ──────────────────────────────────────────────────────────────────

/**
 * 组合「调用方 signal + requestId 注册的取消 + 超时」三路信号，并返回注销函数。
 *
 * 为什么自己再叠一层超时而不是只靠 pi 的 `timeoutMs`：pi 的 `StreamOptions.timeoutMs` 是
 * 「provider/SDK 支持就用」的尽力而为项，不是所有 api 都兑现；而 Writing 的 ghost-text 靠
 * 12s 硬超时才不至于卡住输入。两者都下发，谁先到算谁。
 */
function prepareSignal(
  requestId: string | undefined,
  options: GatewayCallOptions,
): { signal: AbortSignal; release: () => void } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);

  let controller: AbortController | undefined;
  if (requestId) {
    controller = new AbortController();
    inflight.set(requestId, controller);
    signals.push(controller.signal);
  }
  return {
    signal: AbortSignal.any(signals),
    release: () => {
      if (requestId && inflight.get(requestId) === controller) inflight.delete(requestId);
    },
  };
}

/** 组装下发给 pi 的 SimpleStreamOptions（temperature / maxTokens 不传就沿用供应商默认）。 */
function buildStreamOptions(
  req: GatewayCompleteRequest,
  catalogModel: CatalogModel,
  signal: AbortSignal,
  timeoutMs: number,
): Record<string, unknown> {
  const reasoning = resolveThinkingLevel(catalogModel, req.thinkingLevel);
  return {
    signal,
    timeoutMs,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

// ── 对外入口 ──────────────────────────────────────────────────────────────────

/** 取消态的统一结果（解析阶段就被取消时用，避免各处重复拼这三个字段）。 */
const ABORTED_OUTCOME: GatewayOutcome = {
  ok: false,
  text: "",
  truncated: false,
  error: "模型调用已取消或超时",
  errorKind: "aborted",
};

/**
 * 上游明确拒绝 temperature 参数的报错特征。
 *
 * OpenAI 的推理模型（gpt-5.x / o 系，经 openai-responses / openai-codex-responses 出站）对
 * 请求体里的 temperature 直接 400："Unsupported parameter: 'temperature'"；部分兼容网关的
 * 措辞是 "temperature is not supported" / "Invalid parameter: temperature"。pi 只在
 * anthropic-messages 一种协议里按 `compat.supportsTemperature` 门控该参数，其余协议盲传，
 * 所以这层自愈只能由 Gateway 做。
 *
 * 为什么是「失败后去参重试」而不是「按能力位预判」：Catalog / pi 都没有「模型是否接受
 * temperature」的能力数据，按 reasoning 位预判等于 Cortex 自建能力映射表（计划 §1 禁止），
 * 且会误伤 temperature 与推理并存的模型（gemini / zai 等）。上游亲口拒绝才降级，不会误判；
 * 代价只是首次调用多一个往返，且 temperature 本就是「可选增强」（丢掉只影响草稿多样性）。
 */
function isTemperatureRejection(error: string | undefined): boolean {
  if (!error) return false;
  return /temperature/i.test(error) && /unsupported|not\s+support|invalid|does not accept/i.test(error);
}

/** 去掉 temperature 的重试请求（浅拷贝，绝不改动调用方传入的对象）。 */
function withoutTemperature(req: GatewayCompleteRequest): GatewayCompleteRequest {
  const rest = { ...req };
  delete rest.temperature;
  return rest;
}

/** 单发补全。任何失败都以 ok:false 返回，**不抛错**（调用方一律需要确定性降级路径）。 */
export async function runGatewayComplete(
  req: GatewayCompleteRequest,
  options: GatewayCallOptions = {},
): Promise<GatewayOutcome> {
  const runtime = options.runtime ?? getPiGatewayRuntime();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 注册取消控制器必须**先于** resolveModel：解析要读 Catalog、查 pi 运行时、检查认证，
  // 其中 pi 运行时首次加载是秒级的 ESM 动态 import。若等解析完再注册，这段窗口里 abort
  // 会静默落空（registry 里根本没有这个 requestId），用户点了取消却看着它继续跑。
  const { signal, release } = prepareSignal(req.requestId, options);
  try {
    const resolved = await resolveModel(req, runtime);
    if (!resolved.ok) {
      return { ok: false, text: "", truncated: false, error: resolved.error, errorKind: resolved.errorKind };
    }
    if (signal.aborted) return ABORTED_OUTCOME;

    /** 单次出站（异常也吞成 ok:false 结果，让下面的 temperature 自愈重试统一判定）。 */
    const attempt = async (request: GatewayCompleteRequest): Promise<GatewayOutcome> => {
      try {
        const message = await runtime.completeSimple(
          resolved.model,
          buildPiContext(request),
          buildStreamOptions(request, resolved.catalogModel, signal, timeoutMs),
        );
        return finalize(message);
      } catch (err) {
        const error = safeErrorMessage(err, "模型调用失败");
        return { ok: false, text: "", truncated: false, error, errorKind: classifyGatewayError(err, error) };
      }
    };

    let outcome = await attempt(req);
    // 上游拒绝 temperature（gpt-5.x 等推理模型）→ 去掉该参数原样重试一次，见 isTemperatureRejection。
    if (!outcome.ok && req.temperature !== undefined && isTemperatureRejection(outcome.error) && !signal.aborted) {
      outcome = await attempt(withoutTemperature(req));
    }
    return outcome;
  } catch (err) {
    const error = safeErrorMessage(err, "模型调用失败");
    return { ok: false, text: "", truncated: false, error, errorKind: classifyGatewayError(err, error) };
  } finally {
    release();
  }
}

/**
 * 流式补全。`onEvent` 收到的是**增量**（`text` / `thinking` 的 delta）与一条终态 `done`。
 * 返回值与单发同构，便于调用方用同一套错误处理。
 */
export async function runGatewayStream(
  req: GatewayCompleteRequest,
  onEvent: (event: GatewayStreamEvent) => void,
  options: GatewayCallOptions = {},
): Promise<GatewayOutcome> {
  const runtime = options.runtime ?? getPiGatewayRuntime();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 同 runGatewayComplete：先注册取消控制器再解析模型，否则解析窗口内的 abort 会落空。
  const { signal, release } = prepareSignal(req.requestId, options);
  /** 任何提前返回都必须先推一条 done，否则订阅方的流永远等不到收尾。 */
  const fail = (outcome: GatewayOutcome): GatewayOutcome => {
    onEvent({ type: "done", ok: false, error: outcome.error, errorKind: outcome.errorKind });
    return outcome;
  };
  try {
    const resolved = await resolveModel(req, runtime);
    if (!resolved.ok) {
      return fail({ ok: false, text: "", truncated: false, error: resolved.error, errorKind: resolved.errorKind });
    }
    if (signal.aborted) return fail(ABORTED_OUTCOME);

    /**
     * 单次流式出站。emitted 记录是否已向订阅方推过增量——推过就绝不重试
     * （UI 已渲染半截内容，重试会拼出两份正文）；参数被拒发生在请求握手阶段，
     * 典型情况下一个增量都不会产出，重试是安全的。
     */
    const attempt = async (
      request: GatewayCompleteRequest,
    ): Promise<{ outcome: GatewayOutcome; emitted: boolean }> => {
      let emitted = false;
      try {
        const stream = await runtime.streamSimple(
          resolved.model,
          buildPiContext(request),
          buildStreamOptions(request, resolved.catalogModel, signal, timeoutMs),
        );
        for await (const event of stream) {
          if (event.type === "text_delta") {
            emitted = true;
            onEvent({ type: "text", delta: event.delta });
          } else if (event.type === "thinking_delta") {
            emitted = true;
            onEvent({ type: "thinking", delta: event.delta });
          }
        }
        return { outcome: finalize(await stream.result()), emitted };
      } catch (err) {
        const error = safeErrorMessage(err, "模型调用失败");
        return {
          outcome: { ok: false, text: "", truncated: false, error, errorKind: classifyGatewayError(err, error) },
          emitted,
        };
      }
    };

    let attempted = await attempt(req);
    // 同 runGatewayComplete：上游拒绝 temperature 且尚未外发任何增量 → 去参重试一次。
    if (
      !attempted.outcome.ok &&
      !attempted.emitted &&
      req.temperature !== undefined &&
      isTemperatureRejection(attempted.outcome.error) &&
      !signal.aborted
    ) {
      attempted = await attempt(withoutTemperature(req));
    }
    const outcome = attempted.outcome;
    const usage = outcome.usage;
    if (usage) onEvent({ type: "usage", usage });
    onEvent(
      outcome.ok
        ? { type: "done", ok: true, text: outcome.text }
        : { type: "done", ok: false, error: outcome.error, errorKind: outcome.errorKind },
    );
    return outcome;
  } catch (err) {
    const error = safeErrorMessage(err, "模型调用失败");
    const errorKind = classifyGatewayError(err, error);
    onEvent({ type: "done", ok: false, error, errorKind });
    return { ok: false, text: "", truncated: false, error, errorKind };
  } finally {
    release();
  }
}

/**
 * pi 的终态 AssistantMessage → GatewayOutcome。
 *
 * 空响应也算失败：拿到 200 却没有任何内容说明链路配置有问题（常见于网关拦截），
 * 沿用被取代的 postChatCompletion 的「模型未返回内容」文案 —— 上游（研究引擎）在按这句话
 * 做错误归类，改字面量会静默改掉它的分支。
 */
function finalize(message: AssistantMessage): GatewayOutcome {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const { error, errorKind } = classifyAssistantFailure(message);
    return { ok: false, text: "", truncated: false, error, errorKind };
  }
  const text = assistantText(message);
  const usage = toGatewayUsage(message.usage);
  if (!text.trim()) {
    return {
      ok: false,
      text: "",
      truncated: false,
      ...(usage ? { usage } : {}),
      error: message.stopReason === "length" ? "模型输出被 token 上限截断（未产出任何内容），请提高 maxTokens" : "模型未返回内容",
      errorKind: "provider",
    };
  }
  return { ok: true, text, truncated: message.stopReason === "length", ...(usage ? { usage } : {}) };
}

/** GatewayOutcome → IPC 契约的 GatewayCompleteResult（丢掉 truncated，见文件头说明）。 */
export function toIpcResult(outcome: GatewayOutcome): GatewayCompleteResult {
  return outcome.ok
    ? { ok: true, text: outcome.text, ...(outcome.usage ? { usage: outcome.usage } : {}) }
    : { ok: false, error: outcome.error ?? "模型调用失败", errorKind: outcome.errorKind ?? "unknown" };
}
