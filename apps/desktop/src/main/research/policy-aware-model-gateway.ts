// 研究引擎的模型出站闸（spec KTD5、§6.1、§19.2.5）。
//
// **这是 CRE 里唯一被允许发起模型请求的地方。** Planner / Report Generator 都只拿到本网关，
// 拿不到 provider 列表、apiKey 或 fetch —— 少一个绕过点，就少一条把用户正文送错地方的路径。
//
// 四条红线（改这个文件前先读一遍）：
//
// 1. **前置闸先于出站**：任何请求发出之前先跑 core 的 selectResearchModel。local_only 且没有
//    loopback provider 时立刻返回 local_model_unavailable，**绝不回落云 provider**
//    （spec §19.2.5 的验收方式就是「fetch 调用次数为 0」，见同名测试）。
// 2. **工具集永远为空**：postChatCompletion 的请求体里没有 tools / functions / tool_choice，
//    这是 spec §6.1 第 4 条的 prompt injection 防线——处理 public_web 内容的模型调用不得挂载
//    文件、Memory、发送、终端或写工具。选用 postChatCompletion 而不是自己拼请求，正是因为
//    它结构上就不支持工具，"忘了关工具"这个错误无法发生。
// 3. **metadata_only 下正文不得出站**：**主责在构造 prompt 的一侧**（report-generator 在
//    metadata_only 下根本不把 chunk.text 放进 prompt）；本网关的 assertNoEvidenceText 是
//    第二道纵深防御，调用方把「绝不能出现的正文」交给它做运行时比对。两层都在，缺一不可。
// 4. **凭据与 prompt 正文永不进日志**：日志一律经 redactResearchLog，错误信息只保留错误类型
//    与状态码，绝不回显响应体（响应体可能含被回显的 prompt）。
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import { selectResearchModel, type ModelSelection } from "@cortex-work/core/research/model-policy";
import { truncateToChars } from "@cortex-work/core/research/search-api";
import type { ModelDataPolicy } from "@cortex-work/core/research/types";
import { postChatCompletion } from "../ipc/openai-chat";
import { redactResearchLog } from "./redact-research";

/// 一次模型调用的用途。只用于日志与预算归因，不影响出站判定。
export type ModelCallPurpose = "initial_plan" | "gap_plan" | "report";

/// 一次模型调用的全部输入。
export interface ModelCallInput {
  purpose: ModelCallPurpose;
  /// 静态前缀（安全规则 + 输出 schema）。**永不截断**：截掉它等于拆掉注入防线，
  /// 同时它也是 prompt 缓存的命中前缀（见 planner/prompts.ts 的排布约定）。
  systemPrompt: string;
  /// 变量段。超限时从这里截断。
  userPrompt: string;
  policy: ModelDataPolicy;
  maxTokens?: number;
  signal?: AbortSignal;
  /// 出站字符上限，取 budget.maxEvidenceCharsToModel；缺省用 DEFAULT_MAX_PROMPT_CHARS。
  maxPromptChars?: number;
  /// 「绝不允许出现在 prompt 里」的证据正文样本（metadata_only 的运行时守卫）。
  /// 调用方把自己手上的 chunk 正文原样传进来即可，本网关不会把它们发出去。
  forbiddenEvidenceTexts?: readonly string[];
}

/// 网关依赖。providerSettings 是快照而非读取函数：一次编排期间选型必须稳定，
/// 否则用户中途改设置会让同一个 Session 的前后两次调用发往不同供应商。
export interface ModelGatewayDeps {
  providerSettings: ProviderSettings;
  /// 补全实现的注入口（测试传替身）。默认 postChatCompletion。
  complete?: typeof postChatCompletion;
  /// fetch 的注入口，透传给 postChatCompletion；用于「零真实网络」的验收测试。
  fetchFn?: typeof fetch;
  /// 单次调用超时；默认 60s（与 postChatCompletion 一致）。
  timeoutMs?: number;
  logger?: { warn(...args: unknown[]): void; info?(...args: unknown[]): void };
}

/// 调用结果。失败三态各有不同的 UI 引导：装本地模型 / 去设置里配供应商 / 重试。
export type ModelCallResult =
  | { ok: true; text: string; providerId: string; model: string; isLocal: boolean; truncated?: boolean }
  | {
      ok: false;
      code: "local_model_unavailable" | "no_provider_configured" | "call_failed";
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

/// 正文比对的滑窗长度与步长（按归一化后的 code point 计）。
///
/// 为什么是「采样滑窗」而不是整段 indexOf：prompt 里的正文往往是被摘录/改写过的片段，
/// 整段比对会漏；而逐字符建索引在几十 KB 的 prompt 上代价过高。24 字符的窗口足以排除
/// 「碰巧撞词」的误报，12 的步长保证任意 ≥36 字符的连续重叠必被命中。
const GUARD_WINDOW = 24;
const GUARD_STRIDE = 12;
/// 短于此长度的证据文本不参与比对：几个字的片段（标题里的通用词）会造成大量误报。
const GUARD_MIN_CHARS = 8;

/// 归一化：折叠全部空白。换行与缩进差异不该让守卫漏检。
function normalizeForGuard(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/// 检查 prompt 里是否混入了不允许出站的证据正文。
///
/// 返回 null 表示通过，返回字符串表示违规说明（**不含正文本身**，只给长度与用途）。
/// evidence_allowed 直接放行；其余策略下由调用方决定传入哪些正文样本。
///
/// 注意：本函数只在「模型是远端」时才有意义——local_only 选中的必然是 loopback provider，
/// 正文送进本机进程不构成出站（见 core 的 describeEgress：local_only 的 sendsToRemote 为 false）。
/// 因此调用点在 PolicyAwareModelGateway.call 里被 isLocal 短路，本函数自身不做该判断。
export function assertNoEvidenceText(
  prompt: string,
  policy: ModelDataPolicy,
  evidenceTexts: readonly string[],
): string | null {
  if (policy === "evidence_allowed") return null;

  const haystack = normalizeForGuard(prompt);
  if (haystack.length === 0) return null;

  for (const raw of evidenceTexts) {
    const needle = [...normalizeForGuard(raw)];
    if (needle.length < GUARD_MIN_CHARS) continue;
    const window = Math.min(GUARD_WINDOW, needle.length);
    for (let start = 0; start + window <= needle.length; start += GUARD_STRIDE) {
      const sample = needle.slice(start, start + window).join("");
      if (haystack.includes(sample)) {
        return `[policy_guard] 当前策略（${policy}）不允许证据正文出站，但 prompt 中检测到长度 ${needle.length} 的正文重叠`;
      }
    }
  }
  return null;
}

/// 策略感知的模型网关。
///
/// 无状态、可复用：一个实例服务一个 Session 的全部模型调用（选型因此稳定）。
export class PolicyAwareModelGateway {
  constructor(private readonly deps: ModelGatewayDeps) {}

  /// 只做选型不出站，供 UI 预检与编排层「这次能不能用 LLM」的提前判断。
  preflight(policy: ModelDataPolicy): ModelSelection {
    return selectResearchModel({
      policy,
      providers: this.deps.providerSettings.providers,
      ...(this.deps.providerSettings.defaultProviderId
        ? { preferredProviderId: this.deps.providerSettings.defaultProviderId }
        : {}),
      ...(this.deps.providerSettings.defaultModel
        ? { preferredModel: this.deps.providerSettings.defaultModel }
        : {}),
    });
  }

  /// 发起一次受策略约束的模型调用。**任何失败都返回 ok:false 而不抛错**：
  /// 调用方（Planner / Report Generator）一律有确定性降级路径，抛错只会让整个 Session 失败。
  async call(input: ModelCallInput): Promise<ModelCallResult> {
    // 1. 前置闸：选型失败即刻返回，此时一个字节都还没出站。
    const selection = this.preflight(input.policy);
    if (!selection.ok) return { ok: false, code: selection.code, message: selection.message };

    const provider = this.deps.providerSettings.providers.find((p) => p.id === selection.providerId);
    if (!provider) {
      // 选型结果指向一个不存在的 provider 只可能是 core 与本文件的实现漂移，fail-closed。
      return { ok: false, code: "no_provider_configured", message: "选中的模型供应商已不存在" };
    }

    // 2. 出站内容守卫。只在「模型在远端」时生效：本机模型收正文不构成出站。
    if (!selection.isLocal) {
      const violation = assertNoEvidenceText(
        `${input.systemPrompt}\n${input.userPrompt}`,
        input.policy,
        input.forbiddenEvidenceTexts ?? [],
      );
      if (violation) {
        this.deps.logger?.warn("[research] 模型出站被策略守卫拦下", redactResearchLog({
          purpose: input.purpose,
          policy: input.policy,
        }));
        return { ok: false, code: "call_failed", message: violation };
      }
    }

    // 3. 长度闸门：只截变量段，静态前缀原样保留。
    const limit = Math.max(1, input.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS);
    const { text: userPrompt, truncated } = truncatePrompt(input.userPrompt, limit);
    if (truncated) {
      this.deps.logger?.warn(
        "[research] 出站 prompt 超过预算已截断",
        redactResearchLog({ purpose: input.purpose, limit }),
      );
    }

    // 4. 真正出站。**这里刻意没有 tools/functions**（spec §6.1 第 4 条）。
    const complete = this.deps.complete ?? postChatCompletion;
    try {
      const text = await complete({
        baseUrl: provider.baseUrl,
        ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        model: selection.model,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: userPrompt },
        ],
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
        ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
      });
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
/// 请求体（即 prompt）回显在错误响应里；直接透传等于把刚刚拦住的正文写进日志和 UI。
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
