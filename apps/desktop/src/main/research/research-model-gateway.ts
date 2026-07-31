// 研究引擎的模型调用网关（原 policy-aware-model-gateway.ts，spec §6.1、§19.2.5）。
//
// **这是 CRE 里唯一被允许发起模型请求的地方。** Planner / Report Generator 都只拿到本网关，
// 拿不到 provider 列表、apiKey 或 fetch —— 少一个绕过点，就少一条把用户正文送错地方的路径。
//
// 三条红线（改这个文件前先读一遍）：
//
// 1. **前置选型先于出站**：任何请求发出之前先跑 core 的 selectResearchModel。一个可用供应商
//    都没有时立刻返回 no_provider_configured，此时一个字节都还没出站
//    （spec §19.2.5 的验收方式就是「fetch 调用次数为 0」，见同名测试）。
// 2. **工具集永远为空**：这是 spec §6.1 第 4 条的 prompt injection 防线——处理 public_web 内容的
//    模型调用不得挂载文件、Memory、发送、终端或写工具。选用 postChatCompletion 而不是自己拼
//    请求，正是因为它结构上就不支持工具，"忘了关工具"这个错误无法发生。
//    阶段③·4.1 收编后这条保证的载体变了但强度未变：postChatCompletion 现在架在
//    providers/gateway.ts 上，而 `GatewayCompleteRequest`（contract.ts）没有任何 tools 字段、
//    Gateway 的 `buildPiContext()` 是构造 pi `Context` 的唯一处且从不写 `Context.tools`。
//    也就是说"挂载工具"在**类型层面**就无从表达。gateway.test.ts 有对应回归断言。
// 3. **凭据与 prompt 正文永不进日志**：日志一律经 redactResearchLog，错误信息只保留错误类型
//    与状态码，绝不回显响应体（响应体可能含被回显的 prompt）。
//
// 关于出站范围：**没有出站策略枚举**（原 KTD5 的 ModelDataPolicy 已移除）。证据正文一律允许
// 发给用户为研究选定的模型；「数据会不会离开本机」由那个模型自身决定——选 loopback 上的本地
// 模型就不出站（selection.isLocal 如实反映这一点，UI 据它向用户说明）。原先那套「用户既选
// 模型又选策略」的设计能产出自相矛盾的组合（选了云模型又选 local_only → 研究直接不可用），
// 而它拦住的正文本来就是用户主动交给这个模型去读的。
import { isLoopbackBaseUrl, type ModelSelection } from "@cortex-work/core/research/model-selection";
import { truncateToChars } from "@cortex-work/core/research/search-api";
import { postChatCompletion, postChatCompletionStream } from "../ipc/openai-chat";
import { getProviderCatalog } from "../providers/catalog";
import type { ModelRef } from "../providers/contract";
import type { PiGatewayRuntime } from "../providers/pi-runtime";
import { redactResearchLog } from "./redact-research";

/// 一次模型调用的用途。只用于日志与预算归因，不影响选型。
export type ModelCallPurpose = "initial_plan" | "gap_plan" | "report";

/// 一次模型调用的全部输入。
export interface ModelCallInput {
  purpose: ModelCallPurpose;
  /// 静态前缀（安全规则 + 输出 schema）。**永不截断**：截掉它等于拆掉注入防线，
  /// 同时它也是 prompt 缓存的命中前缀（见 planner/prompts.ts 的排布约定）。
  systemPrompt: string;
  /// 变量段。超限时从这里截断。
  userPrompt: string;
  maxTokens?: number;
  /// 本次调用的超时。报告生成明显长于 Planner，必须允许调用方按用途覆盖 60s 默认值。
  timeoutMs?: number;
  signal?: AbortSignal;
  /// 出站字符上限，取 budget.maxEvidenceCharsToModel；缺省用 DEFAULT_MAX_PROMPT_CHARS。
  maxPromptChars?: number;
  /// 流式增量回调。**传了才走 SSE**：Planner 那类要完整 JSON 才能解析的调用没有流式的意义，
  /// 多开一条 SSE 只会多一份容错分支。
  ///
  /// 收到的是**增量**而不是累计全文（底层 postChatCompletionStream 给的是累计，这里已经切好）：
  /// 累计全文一路传到 IPC 会让长报告的流量变成 O(n²)。
  onDelta?: (delta: string) => void;
}

/// 网关依赖。model 是**快照**而非读取函数：一次编排期间选型必须稳定，
/// 否则用户中途改设置会让同一个 Session 的前后两次调用发往不同供应商。
///
/// 阶段③·4.1 收编后这里不再收 provider 列表，只收一个已解析的 Catalog 模型引用：
/// 「引用有没有效、供应商认没认证」由 Pi Model Gateway 在出站前统一判（config 阻断态，
/// 计划 §5），本文件再判一次只会与它漂移；而**选哪个模型**由装配层（llm-hooks-wiring）
/// 从研究设置里定，同样不该散落在这里。
export interface ModelGatewayDeps {
  /// 本次 Session 使用的模型引用；null / 不完整 = 未配置，preflight 立刻失败，一个字节都不出站。
  model: ModelRef | null;
  /// 补全实现的注入口（测试传替身）。默认 postChatCompletion。
  complete?: typeof postChatCompletion;
  /// 流式补全实现的注入口（测试传替身）。默认 postChatCompletionStream，只在调用方传了
  /// onDelta 时才会被用到。
  completeStream?: typeof postChatCompletionStream;
  /// pi 运行时的注入口，透传给 postChatCompletion；用于「零真实网络」的验收测试。
  runtime?: PiGatewayRuntime;
  /// 单次调用超时；默认 60s（与 postChatCompletion 一致）。
  timeoutMs?: number;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 调用结果。失败两态各有不同的 UI 引导：去设置里配供应商 / 重试。
export type ModelCallResult =
  | { ok: true; text: string; providerId: string; model: string; isLocal: boolean; truncated?: boolean }
  | {
      ok: false;
      code: "no_provider_configured" | "call_failed";
      message: string;
      /// 选型成功但调用失败时带上，供日志定位「到底选中了谁」。
      /// 选型结果是配置不是用户数据，记录它没有隐私代价；缺了它，一句 call_failed
      /// 无法区分「provider 配错」「模型不是 chat 模型」「网络不通」，只能靠翻配置复现。
      providerId?: string;
      model?: string;
    };

/// prompt 的兜底上限（约 30k token）。调用方一般会传 budget.maxEvidenceCharsToModel。
const DEFAULT_MAX_PROMPT_CHARS = 120_000;

/// 截断标记。留在 prompt 尾部，让模型知道材料被截断过，不要假装读完了全部证据。
const TRUNCATION_MARK = "…[truncated]";

/// 研究模型网关。
///
/// 该 Provider 的 endpoint 是否指向本机（loopback）。
///
/// 只影响 isLocal 这个**展示位**（「正文会不会离开这台设备」），不影响能不能调用，
/// 所以 Catalog 读不到时一律吞掉异常并返回 false —— 拿不准必须按「会出站」说，
/// 绝不能因为读目录失败就给用户一个「数据不离开本机」的错误承诺，更不能让整条研究链路挂掉。
function isLocalProvider(providerId: string): boolean {
  try {
    const baseUrl = getProviderCatalog()?.providers.find((p) => p.id === providerId)?.baseUrl;
    return baseUrl ? isLoopbackBaseUrl(baseUrl) : false;
  } catch {
    return false;
  }
}

/// 无状态、可复用：一个实例服务一个 Session 的全部模型调用（选型因此稳定）。
export class ResearchModelGateway {
  constructor(private readonly deps: ModelGatewayDeps) {}

  /// 只做校验不出站，供 UI 预检与编排层「这次能不能用 LLM」的提前判断。
  ///
  /// isLocal 取自 Catalog 里该 Provider 的 baseUrl 是否指向 loopback —— 它是给用户的
  /// 「正文会不会离开这台设备」承诺，拿不准时必须报 false（isLoopbackBaseUrl 的既有语义）。
  preflight(): ModelSelection {
    const ref = this.deps.model;
    const providerId = ref?.providerId?.trim();
    const modelId = ref?.modelId?.trim();
    if (!providerId || !modelId) {
      return {
        ok: false,
        code: "no_provider_configured",
        message: "尚未配置研究使用的模型，请先在设置中选择。",
      };
    }
    return { ok: true, providerId, model: modelId, isLocal: isLocalProvider(providerId) };
  }

  /// 发起一次模型调用。**任何失败都返回 ok:false 而不抛错**：
  /// 调用方（Planner / Report Generator）一律有确定性降级路径，抛错只会让整个 Session 失败。
  async call(input: ModelCallInput): Promise<ModelCallResult> {
    // 1. 前置选型：失败即刻返回，此时一个字节都还没出站。
    const selection = this.preflight();
    if (!selection.ok) return { ok: false, code: selection.code, message: selection.message };

    // 2. 长度闸门：只截变量段，静态前缀原样保留。
    const limit = Math.max(1, input.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS);
    const { text: userPrompt, truncated } = truncatePrompt(input.userPrompt, limit);
    if (truncated) {
      this.deps.logger?.warn(
        "[research] 出站 prompt 超过预算已截断",
        redactResearchLog({ purpose: input.purpose, limit }),
      );
    }

    // 3. 真正出站。**这里刻意没有 tools/functions**（spec §6.1 第 4 条）。
    const params = {
      providerId: selection.providerId,
      modelId: selection.model,
      messages: [
        { role: "system" as const, content: input.systemPrompt },
        { role: "user" as const, content: userPrompt },
      ],
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.timeoutMs !== undefined
        ? { timeoutMs: input.timeoutMs }
        : this.deps.timeoutMs !== undefined
          ? { timeoutMs: this.deps.timeoutMs }
          : {}),
      ...(this.deps.runtime ? { runtime: this.deps.runtime } : {}),
    };
    try {
      const text = input.onDelta
        ? await this.completeStreaming(params, input.onDelta)
        : await (this.deps.complete ?? postChatCompletion)(params);
      return {
        ok: true,
        text,
        providerId: selection.providerId,
        model: selection.model,
        isLocal: selection.isLocal,
        ...(truncated ? { truncated: true } : {}),
      };
    } catch (err) {
      // 原始 message 可能带 Authorization 头或被供应商回显的 prompt 片段，一律不外传；
      // 但选中的 provider / model 是配置，带上它排查成本差一个数量级。
      return {
        ok: false,
        code: "call_failed",
        message: safeErrorMessage(err),
        providerId: selection.providerId,
        model: selection.model,
      };
    }
  }

  /// 走 SSE 拿正文，并把底层的**累计全文**切成增量交给调用方。
  ///
  /// 为什么在这里切：postChatCompletionStream 的 onDelta 给的是累计串（它自己的既有契约），
  /// 而增量才是能安全跨 IPC 传的形态。切一次比让每个调用方各自记 prev 长度可靠得多。
  private async completeStreaming(
    params: Parameters<typeof postChatCompletionStream>[0],
    onDelta: (delta: string) => void,
  ): Promise<string> {
    const stream = this.deps.completeStream ?? postChatCompletionStream;
    let emitted = 0;
    return stream({
      ...params,
      onDelta: (accumulated) => {
        // 防御：个别供应商会在重试时回吐一段更短的累计串，此时不倒着切。
        if (accumulated.length <= emitted) return;
        onDelta(accumulated.slice(emitted));
        emitted = accumulated.length;
      },
    });
  }
}

/// 按 code point 截断变量段，尾部留下可见的截断标记。
function truncatePrompt(text: string, maxChars: number): { text: string; truncated: boolean } {
  const points = [...text];
  if (points.length <= maxChars) return { text, truncated: false };
  const markLength = [...TRUNCATION_MARK].length;
  const keep = Math.max(0, maxChars - markLength);
  return { text: `${truncateToChars(text, keep)}${TRUNCATION_MARK}`, truncated: true };
}

/// 把异常收敛成一条**不含凭据、不含 prompt 正文**的可展示说明。
///
/// 为什么不透传 err.message：供应商的错误里常带响应体，而不少网关会把请求体（即 prompt）
/// 回显在错误响应里；直接透传等于把用户的正文写进日志和 UI。
function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "模型调用已取消或超时";
    const status = /HTTP (\d{3})/.exec(err.message)?.[1];
    if (status) return `模型接口返回 HTTP ${status}`;
    if (err.message.includes("模型未返回内容")) return "模型未返回内容";
    return `模型调用失败（${err.name}）`;
  }
  return "模型调用失败";
}
