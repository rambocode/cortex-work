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
// 2. **工具集永远为空**：postChatCompletion 的请求体里没有 tools / functions / tool_choice，
//    这是 spec §6.1 第 4 条的 prompt injection 防线——处理 public_web 内容的模型调用不得挂载
//    文件、Memory、发送、终端或写工具。选用 postChatCompletion 而不是自己拼请求，正是因为
//    它结构上就不支持工具，"忘了关工具"这个错误无法发生。
// 3. **凭据与 prompt 正文永不进日志**：日志一律经 redactResearchLog，错误信息只保留错误类型
//    与状态码，绝不回显响应体（响应体可能含被回显的 prompt）。
//
// 关于出站范围：**没有出站策略枚举**（原 KTD5 的 ModelDataPolicy 已移除）。证据正文一律允许
// 发给用户为研究选定的模型；「数据会不会离开本机」由那个模型自身决定——选 loopback 上的本地
// 模型就不出站（selection.isLocal 如实反映这一点，UI 据它向用户说明）。原先那套「用户既选
// 模型又选策略」的设计能产出自相矛盾的组合（选了云模型又选 local_only → 研究直接不可用），
// 而它拦住的正文本来就是用户主动交给这个模型去读的。
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import {
  selectResearchModel,
  type ModelSelection,
  type ResearchModelPreference,
} from "@cortex-work/core/research/model-selection";
import { truncateToChars } from "@cortex-work/core/research/search-api";
import { postChatCompletion, postChatCompletionStream } from "../ipc/openai-chat";
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

/// 网关依赖。providerSettings 是快照而非读取函数：一次编排期间选型必须稳定，
/// 否则用户中途改设置会让同一个 Session 的前后两次调用发往不同供应商。
export interface ModelGatewayDeps {
  providerSettings: ProviderSettings;
  /// 研究专用的模型偏好（研究设置的 modelProviderId / modelId）。缺省 = 跟随全局默认模型。
  /// 同样是快照，理由同上。
  preference?: ResearchModelPreference;
  /// 补全实现的注入口（测试传替身）。默认 postChatCompletion。
  complete?: typeof postChatCompletion;
  /// 流式补全实现的注入口（测试传替身）。默认 postChatCompletionStream，只在调用方传了
  /// onDelta 时才会被用到。
  completeStream?: typeof postChatCompletionStream;
  /// fetch 的注入口，透传给 postChatCompletion；用于「零真实网络」的验收测试。
  fetchFn?: typeof fetch;
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
/// 无状态、可复用：一个实例服务一个 Session 的全部模型调用（选型因此稳定）。
export class ResearchModelGateway {
  constructor(private readonly deps: ModelGatewayDeps) {}

  /// 只做选型不出站，供 UI 预检与编排层「这次能不能用 LLM」的提前判断。
  preflight(): ModelSelection {
    return selectResearchModel({
      providers: this.deps.providerSettings.providers,
      ...(this.deps.preference ? { preference: this.deps.preference } : {}),
      ...(this.deps.providerSettings.defaultProviderId
        ? { fallbackProviderId: this.deps.providerSettings.defaultProviderId }
        : {}),
      ...(this.deps.providerSettings.defaultModel
        ? { fallbackModel: this.deps.providerSettings.defaultModel }
        : {}),
    });
  }

  /// 发起一次模型调用。**任何失败都返回 ok:false 而不抛错**：
  /// 调用方（Planner / Report Generator）一律有确定性降级路径，抛错只会让整个 Session 失败。
  async call(input: ModelCallInput): Promise<ModelCallResult> {
    // 1. 前置选型：失败即刻返回，此时一个字节都还没出站。
    const selection = this.preflight();
    if (!selection.ok) return { ok: false, code: selection.code, message: selection.message };

    const provider = this.deps.providerSettings.providers.find((p) => p.id === selection.providerId);
    if (!provider) {
      // 选型结果指向一个不存在的 provider 只可能是 core 与本文件的实现漂移，fail-closed。
      return { ok: false, code: "no_provider_configured", message: "选中的模型供应商已不存在" };
    }

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
      baseUrl: provider.baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      model: selection.model,
      messages: [
        { role: "system" as const, content: input.systemPrompt },
        { role: "user" as const, content: userPrompt },
      ],
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
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
/// 为什么不透传 err.message：postChatCompletion 的错误里带响应体前 200 字符，而不少网关会把
/// 请求体（即 prompt）回显在错误响应里；直接透传等于把用户的正文写进日志和 UI。
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
