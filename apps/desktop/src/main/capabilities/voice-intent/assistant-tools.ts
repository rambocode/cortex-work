// 语音助手控制 MCP server：把「退出语音助手 / 新建对话 / 屏幕上下文开关」暴露成 Agent
// 可调用的 function tool，由 LLM 理解自然口语（「好吧那你退下吧」「不聊了你走吧」…）后
// 主动调用——替代穷举词表的本地匹配，这是 xiaozhi 混合架构里 function_call 模式的本意。
// 精确短句（「退下」「退出」）仍由 voice-intent/understand.ts 的本地 fast-path 零延迟拦截，
// 两层互补：fast-path 管零延迟精确命令，本层管自然语言变体。
//
// 架构复用 automation/server.ts 范式（createMcpHost 独立实例 + buildXxxMcpServerConfig）。
// 与 automation 不同，本 server **无 per-session 状态**：动作是全局的（语音球只有一个），
// 安全门控在执行面——handler 经 dispatchVoiceAssistantIntentAction 验「语音助手确实激活」，
// 未激活时返回可读错误（普通打字轮 LLM 误调也无副作用）。oneshot / 委派子 agent / 自动化
// runner 拿不到注入配置，天然无这些工具。
//
// 执行链：LLM 调工具 → 主进程验激活态 → VoiceAssistantCommand{type:"intentAction"} 下发
// 主窗口控制器 → 控制器复用与 fast-path 意图相同的动作路径（退出走 exitAfterSpeech，
// 等本轮回复播完再关语音球——体验红线，见 docs/voice-intent.md 核心规则 6）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHost, type McpHostHandle } from "../mcp-host/server";
import type { McpServerConfig, VoiceAssistantIntentName } from "../../ipc/types";

// 注入用 server id（= MCP server 名）。须为 TOML 裸键安全（codex -c mcp_servers.<id>）。
export const VOICE_ASSISTANT_SERVER_ID = "cortex-voice-assistant";

const voiceHost = createMcpHost(VOICE_ASSISTANT_SERVER_ID);

type VoiceIntentAction = Exclude<VoiceAssistantIntentName, "continue_chat">;

// 动作下发器由 ipc/voice-assistant.ts 在 register 阶段装配（两段式,同 setVoiceAssistantWiring
// 惯例）——本模块被 cli.ts / pi-session.ts 引用,直接 import voice-assistant 会把 electron 窗口
// 依赖链拖进它们的单测。未装配(register 未跑)时视为未激活,工具返回可读错误。
let intentDispatcher: ((intent: VoiceIntentAction) => boolean) | null = null;

export function setVoiceAssistantIntentDispatcher(fn: (intent: VoiceIntentAction) => boolean): void {
  intentDispatcher = fn;
}

/** 工具名 → 本地动作。名字进模型上下文，须自描述且与 description 一致。 */
export const VOICE_ASSISTANT_TOOLS: ReadonlyArray<{
  name: string;
  intent: VoiceIntentAction;
  description: string;
  /** 调用成功后返回给模型的指引（模型的正文回复会被 TTS 朗读，指引它接一句自然的话）。 */
  successText: string;
  /** 仅 macOS 可用（屏幕上下文截图依赖 mac 的窗口捕捉链路）。 */
  macOnly?: boolean;
}> = [
  {
    name: "voice_exit_assistant",
    intent: "exit_assistant",
    description:
      "退出/关闭语音助手。仅当用户在语音对话中明确要求你退下、退出、关闭语音助手或结束语音对话时调用" +
      "（如「退下吧」「好吧那你退下吧」「不聊了」）。疑问句（「怎么退出语音助手？」）不要调用。" +
      "调用成功后本轮回复朗读完毕语音球会自动关闭。",
    successText: "已安排退出：本轮回复朗读完后语音助手将关闭。请用一句简短的话与用户告别。",
  },
  {
    name: "voice_new_conversation",
    intent: "new_conversation",
    description:
      "新建一段空白语音对话。仅当用户在语音对话中明确要求新建/开始/换一个新对话时调用。" +
      "注意：调用后从下一轮起进入新对话，本轮仍在当前对话中。",
    successText: "已切换到新对话（下一轮生效）。请简短告知用户可以开始新话题了。",
  },
  {
    name: "voice_enable_screen_context",
    intent: "enable_screen_context",
    description: "开启屏幕上下文：让用户后续的语音消息附带当前屏幕截图。仅当用户明确要求「看我屏幕」时调用。",
    successText: "屏幕上下文已开启。请简短确认。",
    macOnly: true,
  },
  {
    name: "voice_disable_screen_context",
    intent: "disable_screen_context",
    description: "关闭屏幕上下文：停止在语音消息中附带屏幕截图。仅当用户明确要求不再看屏幕时调用。",
    successText: "屏幕上下文已关闭。请简短确认。",
    macOnly: true,
  },
];

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}
function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function registerVoiceAssistantTools(mcp: McpServer): void {
  for (const tool of VOICE_ASSISTANT_TOOLS) {
    if (tool.macOnly && process.platform !== "darwin") continue;
    mcp.registerTool(
      tool.name,
      { description: tool.description, inputSchema: {} },
      async (): Promise<ToolResult> => {
        // 执行面门控（安全关键）：动作只在语音助手真正激活时可达。普通打字轮/编排轮里
        // LLM 误调只会拿到这句错误，不产生任何窗口副作用。
        if (!intentDispatcher?.(tool.intent)) {
          return errorResult("语音助手当前未激活，本工具仅在语音对话中可用。请直接回复用户即可。");
        }
        return textResult(tool.successText);
      },
    );
  }
}

// ── host 生命周期与注入配置（范式同 automation/server.ts） ────────────────────

export function startVoiceAssistantToolsHost(): Promise<McpHostHandle> {
  return voiceHost.start(registerVoiceAssistantTools);
}

export function stopVoiceAssistantToolsHost(): void {
  voiceHost.stop();
}

export function getVoiceAssistantToolsHostHandle(): McpHostHandle | null {
  return voiceHost.getHandle();
}

/**
 * 构建注入配置；host 不可用 / 无 sessionId → null（不注入）。
 *
 * 常驻注入聊天路径（pi RPC 桥接 + claude/codex builtinServers）而非只在语音轮注入：
 * pi RPC 会话的工具集在 open 时冻结，而语音助手可能在会话已开之后才激活——按轮注入
 * 对 pi 意味着每次语音激活都要重开会话。改为常驻 + 执行面门控（见 handler），代价只是
 * 工具列表多几项，与 automation/calendar 的注入策略同源。
 */
export function buildVoiceAssistantMcpServerConfig(sessionId: string | undefined): McpServerConfig | null {
  if (!sessionId) return null;
  const handle = voiceHost.getHandle();
  if (!handle || !handle.serverAvailable || handle.port <= 0) return null;
  return {
    id: VOICE_ASSISTANT_SERVER_ID,
    transport: "http",
    url: `http://127.0.0.1:${handle.port}/mcp`,
    headers: {
      Authorization: `Bearer ${handle.token}`,
      "X-Cortex-Session": sessionId,
    },
  };
}

/** 注入前确保 host 已起（首次调用时惰性启动，失败返回 null 不阻断会话）。 */
export async function ensureVoiceAssistantMcpServerConfig(
  sessionId: string | undefined,
): Promise<McpServerConfig | null> {
  if (!sessionId) return null;
  let cfg = buildVoiceAssistantMcpServerConfig(sessionId);
  if (cfg) return cfg;
  const handle = await startVoiceAssistantToolsHost();
  if (!handle.serverAvailable) return null;
  cfg = buildVoiceAssistantMcpServerConfig(sessionId);
  return cfg;
}
