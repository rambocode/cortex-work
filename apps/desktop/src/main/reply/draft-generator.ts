// 草稿生成器（U7 / R4）：封装 workflow/run-prompt-headless 的 runPromptHeadless，用应用默认
// agent 单发生成一条回复草稿，无会话。
//
// 关键取舍（KTD3，用户已明确本期不改权限行为）：
//   - agent CLI 无 temperature 参数，故 ReplyClone 的 0.3/0.9 温度分层改用 prompt 避重列表实现多样性
//     （避重列表由 controller 传入 buildReplyPrompt.avoidReplies）。
//   - runPromptHeadless 只接受单段 prompt 字符串，无独立 system 通道；此处把 system + user 拼接下发
//     （system 语义靠拼接段首交代，见 buildReplyPrompt 的 SYSTEM_PROMPT）。
//   - providerId 由调用方从「默认 agent 快照」解析后传入（runPromptHeadless 不自解析默认 agent）。
//   - 传入 signal 支持取消：controller 在 esc / 重入时 abort，kill 在途 CLI。
//   - 输出经 cleanAgentOutput 清洗（剥 markdown 围栏 / 特殊 token / 开场白 / 引号）后返回；清洗后为空
//     视为「空候选」抛 EmptyDraftError，由 controller 推气泡错误态（不静默回 idle）。

import {
  runPromptHeadless,
  resolveDefaultWorkspaceRoot,
} from "../workflow/run-prompt-headless";
import type { ReplyPrompt } from "@cortex-work/core/reply/prompt-builder";
import type { ReplySyncSnapshot } from "../ipc/reply-types";
import { cleanAgentOutput } from "./controller-state";

/** 清洗后草稿为空（模型只吐了围栏 / 寒暄 / 空白）。controller 据此推「空候选」错误态。 */
export class EmptyDraftError extends Error {
  constructor() {
    super("agent 返回空草稿");
    this.name = "EmptyDraftError";
  }
}

/**
 * 从默认 agent 快照解析出 runPromptHeadless 的 providerId：
 *   - pi 自定义供应商：快照带持久化的 providerId（在 providerSettings 中可查）；
 *   - 内置 agent（claude/codex/pi）：providerId 即 agent 名（defaultAgent）。
 * 快照缺失（renderer 尚未推送设置）返回 null → controller 推「未配置默认 agent」错误态。
 */
export function resolveReplyProviderId(snapshot: ReplySyncSnapshot | null): string | null {
  if (!snapshot) return null;
  const explicit = snapshot.providerId?.trim();
  if (explicit) return explicit;
  return snapshot.defaultAgent || null;
}

/** 生成器依赖注入口（测试可替换 runPrompt / workspaceRoot 解析）。 */
export interface DraftGeneratorDeps {
  runPrompt?: typeof runPromptHeadless;
  resolveWorkspaceRoot?: () => Promise<string>;
}

export interface GenerateDraftParams {
  prompt: ReplyPrompt;
  providerId: string;
  model?: string;
  signal?: AbortSignal;
}

/**
 * 单发生成一条草稿：拼接 system+user → runPromptHeadless（默认 agent，传 signal 支持取消）→
 * cleanAgentOutput 清洗 → 非空返回，空则抛 EmptyDraftError。
 */
export async function generateDraft(
  params: GenerateDraftParams,
  deps: DraftGeneratorDeps = {},
): Promise<string> {
  const runPrompt = deps.runPrompt ?? runPromptHeadless;
  const resolveRoot = deps.resolveWorkspaceRoot ?? resolveDefaultWorkspaceRoot;

  const workspaceRoot = await resolveRoot();
  // system 无独立通道 → 段首拼接（buildReplyPrompt.system 已交代「我/对方」续写语义与「只输出正文」约束）
  const combined = `${params.prompt.system}\n\n${params.prompt.user}`;

  const { text } = await runPrompt({
    prompt: combined,
    workspaceRoot,
    providerId: params.providerId,
    model: params.model,
    signal: params.signal,
  });

  const cleaned = cleanAgentOutput(text);
  if (cleaned.length === 0) throw new EmptyDraftError();
  return cleaned;
}
