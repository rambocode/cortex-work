import { app } from "electron";
import { createHash } from "crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getCortexRuntimeHandle } from "./cortex-runtime";
import { runPromptHeadless } from "./workflow/run-prompt-headless";
import { getPersistedState } from "./ipc/store";
import { createLogger } from "./log";
import { ApiClient } from "@cortex-work/core/api";
import { loadAuthConfig } from "./ipc/auth-config";

const log = createLogger("im-runtime-pump");
const HISTORY_LIMIT = 20;

interface RuntimeMessage {
  delivery_id: string;
  message: {
    channel_id: string; user_id: string; chat_id?: string; thread_id?: string; content: string;
    target: { kind: "personal" | "team"; workspace_id?: string; agent_id?: string; project_id?: string };
    execution?: { agent?: string; provider_id?: string; model?: string; cwd?: string };
  };
}
interface TranscriptTurn { role: "user" | "assistant"; content: string; at: string }

let controller: AbortController | null = null;

function sessionKey(message: RuntimeMessage["message"]): string {
  const peer = message.thread_id || message.chat_id || message.user_id;
  return createHash("sha256").update(`${message.channel_id}\0${peer}`).digest("hex");
}
function transcriptPath(key: string): string { return join(app.getPath("userData"), "im-sessions", `${key}.json`); }
function loadTranscript(key: string): TranscriptTurn[] {
  try { const value = JSON.parse(readFileSync(transcriptPath(key), "utf8")); return Array.isArray(value) ? value.slice(-HISTORY_LIMIT) : []; } catch { return []; }
}
function saveTranscript(key: string, turns: TranscriptTurn[]): void {
  const path = transcriptPath(key); mkdirSync(join(path, ".."), { recursive: true }); const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(turns.slice(-HISTORY_LIMIT), null, 2), "utf8"); renameSync(tmp, path);
}
function renderPrompt(history: TranscriptTurn[], content: string): string {
  const transcript = history.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`).join("\n\n");
  return `You are replying to a user through an instant-messaging channel. Continue the conversation using the history below. Return only the final user-facing reply. Do not mention this routing instruction.\n\nConversation history:\n${transcript || "(empty)"}\n\nUser: ${content}`;
}
async function resolveExecution(message: RuntimeMessage["message"]): Promise<{ workspaceRoot: string; providerId: string; model?: string }> {
  const state = await getPersistedState();
  const project = message.target.project_id ? state.projects.find((item) => item.id === message.target.project_id) : undefined;
  const workspaceRoot = message.execution?.cwd || project?.path || state.generalSettings?.workspaceRoot || homedir();
  const agent = message.execution?.agent || state.lastAgent || "pi";
  const providerId = message.execution?.provider_id || (agent === "pi" ? state.lastProviderId : undefined) || agent;
  return { workspaceRoot, providerId, model: message.execution?.model || state.lastModel };
}
async function reply(deliveryID: string, content: string): Promise<void> {
  const handle = getCortexRuntimeHandle(); if (!handle) throw new Error("Cortex Runtime disconnected");
  const response = await fetch(`${handle.address}/v1/im/replies`, { method: "POST", headers: { Authorization: `Bearer ${handle.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ delivery_id: deliveryID, content }) });
  if (!response.ok) throw new Error(`IM reply failed (${response.status})`);
}
async function runTeamAgent(message: RuntimeMessage["message"]): Promise<string> {
  const auth=loadAuthConfig();if(!auth?.baseUrl||!auth.token)throw new Error("团队工作区尚未登录");if(!message.target.workspace_id||!message.target.agent_id)throw new Error("团队渠道缺少 Workspace ID 或 Agent ID");
  const api=new ApiClient({baseUrl:auth.baseUrl,token:auth.token,workspaceId:message.target.workspace_id,platform:"desktop"});
  const invoked=await api.invokeAvatar(message.target.agent_id,message.content);const turnId=invoked.turn_id||invoked.task_id;if(!invoked.conversation_id||!turnId)throw new Error("团队 Agent 未返回会话标识");
  const deadline=Date.now()+30*60_000;for(;;){const detail=await api.getAvatarConversationTurn(invoked.conversation_id,turnId);const turn=detail.turn;if(turn.outcome){
      if(turn.outcome!=="done"&&turn.outcome!=="unanswerable")throw new Error(`团队 Agent 执行结束: ${turn.outcome}`);return turn.messages.filter((item)=>item.type==="text"&&item.content).map((item)=>item.content).join("").trim();}
    if(Date.now()>deadline)throw new Error("团队 Agent 执行超时");await new Promise((resolve)=>setTimeout(resolve,1_000));}
}
async function handleMessage(event: RuntimeMessage): Promise<void> {
  const key = sessionKey(event.message); const history = loadTranscript(key); const now = new Date().toISOString();
  const execution = await resolveExecution(event.message);
  try {
    const text=event.message.target.kind==="team"?await runTeamAgent(event.message):(await runPromptHeadless({ prompt: renderPrompt(history, event.message.content), ...execution })).text;
    saveTranscript(key, [...history, { role: "user", content: event.message.content, at: now }, { role: "assistant", content: text, at: new Date().toISOString() }]);
    await reply(event.delivery_id, text || "抱歉，本次没有生成可发送的回复。");
  } catch (error) {
    log.error("IM Agent 执行失败", { channelId: event.message.channel_id, error: error instanceof Error ? error.message : String(error) });
    await reply(event.delivery_id, "抱歉，Cortex 当前无法完成这次请求，请稍后重试。");
  }
}
async function pump(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const handle = getCortexRuntimeHandle(); if (!handle) return;
    try {
      const response = await fetch(`${handle.address}/v1/im/events/next`, { headers: { Authorization: `Bearer ${handle.token}` }, signal });
      if (response.status === 204) continue;
      if (!response.ok) throw new Error(`event poll failed (${response.status})`);
      void handleMessage(await response.json() as RuntimeMessage);
    } catch (error) {
      if (signal.aborted) return;
      log.warn("IM 事件轮询失败", { error: error instanceof Error ? error.message : String(error) });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
export function startImRuntimePump(): void { if (controller) return; controller = new AbortController(); void pump(controller.signal); }
export function stopImRuntimePump(): void { controller?.abort(); controller = null; }
