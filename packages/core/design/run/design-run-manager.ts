// 设计工作台的 agent 运行时接线：把设计回合跑在 cortex 既有的 startCli CLI 管线上,
// 替代 Kun 的 HTTP/SSE runtime。职责：
//   1) installDesignRuntime(bridge)：一次性装配平台端口(文件系统/存储)、runtime 端口
//      (getSettings→personal designSettings)、CLI 事件订阅(按 `design:` runId 前缀过滤,
//      与个人会话事件流硬隔离——messages.ts 侧有对称的前缀守卫)。
//   2) sendDesignMessage：DesignTurnSubmitSendMessage 兼容的回合派发——构造 CliStartRequest
//      (accept-edits 免审批写工作区、auto 审批策略、同 doc 会话续接),把 CliStreamEvent
//      折叠进 compat/chat-store 镜像(design 树的画布实时应用/转录渲染都读它)。
//   3) 取消/收尾:killCli + 镜像回合状态复位。
import type { DesktopBridge } from "../../desktop/bridge";
import type { CliStartRequest, CliStreamEvent } from "../../desktop/types";
import { usePersonalStore } from "../../store/personal";
import { setDesignRuntimeClient } from "../compat/runtime-client";
import { setDesignRuntimeProvider } from "../compat/agent-registry";
import { useChatStore } from "../compat/chat-store";
import type { ChatBlock, NormalizedThread } from "../compat/agent-types";
import type { AppSettingsV1 } from "../compat/app-settings";
import type { SendMessageOverrides } from "../compat/chat-store-types";
import { useDesignWorkspaceStore } from "../design-workspace-store";
import { installDesignPlatform } from "../platform/bridge-adapter";
import { designUiStorage } from "../platform/design-ui-storage";

// 活跃设计 run 注册表(runId → 上下文)。渲染端权威;主进程崩溃/退出由 cli:exit 兜底清理。
type DesignRunContext = {
  sessionId: string;
  docId: string;
  turnId: string;
};

let installedBridge: DesktopBridge | null = null;
let unsubscribes: Array<() => void> = [];
const activeRuns = new Map<string, DesignRunContext>();
// agent 原生会话 id(init 事件回传),按逻辑会话记忆用于 --resume 多轮续接。
const agentSessionBySession = new Map<string, string>();

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 设计 run 的 runId 前缀契约(与 messages.ts 的 phantom-run 守卫、事件过滤共同依赖)。
export const DESIGN_RUN_PREFIX = "design:";

export function isDesignRunId(runId: string): boolean {
  return runId.startsWith(DESIGN_RUN_PREFIX);
}

// 当前是否有设计回合在跑(右栏 busy 态用)。
export function designRunBusy(): boolean {
  return activeRuns.size > 0;
}

// ── CLI 事件折叠：CliStreamEvent → chat 镜像 ──────────────────────────────
function handleDesignCliEvent(runId: string, ev: CliStreamEvent): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  const mirror = useChatStore.getState();
  switch (ev.type) {
    case "init":
      // 记住 agent 原生会话 id,同 doc 的下一回合据此 --resume。
      if (ev.sessionId) agentSessionBySession.set(run.sessionId, ev.sessionId);
      return;
    case "text":
      mirror.appendLiveAssistant(ev.delta);
      return;
    case "thinking":
      // v1 不单独展示推理流(镜像无 liveReasoning 字段);刻意丢弃。
      return;
    case "tool": {
      const toolId = ev.toolCallId ?? `${runId}:${ev.name}`;
      if (ev.phase !== "end") {
        // 工具开始前先把已流出的正文落定,保持时间线顺序(文本→工具→文本)。
        mirror.foldLiveAssistant(run.turnId);
        mirror.pushBlock({
          kind: "tool",
          id: toolId,
          summary: ev.detail ? `${ev.name} · ${ev.detail}` : ev.name,
          status: "running",
          meta: ev.input ? { input: ev.input } : undefined,
        } as ChatBlock);
      } else {
        mirror.patchBlock(toolId, {
          status: ev.isError ? "error" : "success",
          detail: typeof ev.output === "string" ? ev.output.slice(0, 4000) : undefined,
        } as Partial<ChatBlock>);
      }
      return;
    }
    case "result":
      mirror.foldLiveAssistant(run.turnId);
      if (!ev.ok && ev.error) {
        mirror.pushBlock({
          kind: "system",
          id: uid("err"),
          text: ev.error,
          severity: "error",
        } as ChatBlock);
      }
      return;
    default:
      return;
  }
}

function handleDesignCliExit(runId: string, code: number | null, error?: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  activeRuns.delete(runId);
  const mirror = useChatStore.getState();
  mirror.foldLiveAssistant(run.turnId);
  if (code !== 0 && (code !== null || error)) {
    mirror.pushBlock({
      kind: "system",
      id: uid("exit"),
      text: error ?? `设计回合异常退出(code=${code})`,
      severity: "error",
    } as ChatBlock);
  }
  if (activeRuns.size === 0) mirror.endTurn();
}

// ── 回合派发 ────────────────────────────────────────────────────────────
// DesignTurnSubmitSendMessage 兼容签名:design 树的 prompt 控制器/编排层直接调用。
export async function sendDesignMessage(
  text: string,
  _mode?: string,
  overrides?: SendMessageOverrides,
): Promise<boolean> {
  const bridge = installedBridge;
  const mirror = useChatStore.getState();
  if (!bridge) {
    mirror.pushBlock({
      kind: "system",
      id: uid("err"),
      text: "设计 agent 需要桌面端环境(bridge 未注入)",
      severity: "error",
    } as ChatBlock);
    return false;
  }
  const personal = usePersonalStore.getState();
  const ws = useDesignWorkspaceStore.getState();
  const docId = ws.activeDocumentId ?? "scratch";
  // 工作区根:design store 已解析值 → 设置项 → 主进程默认根(Documents/cortex/design)。
  const cwd =
    ws.workspaceRoot ||
    personal.designSettings.defaultWorkspaceRoot ||
    (await bridge.designWorkspaceRoot?.()) ||
    "";
  if (!cwd) {
    mirror.pushBlock({
      kind: "system",
      id: uid("err"),
      text: "未能确定设计工作目录,请在设置→设计里配置",
      severity: "error",
    } as ChatBlock);
    return false;
  }

  const sessionId = `design-${docId}`;
  const runId = `${DESIGN_RUN_PREFIX}${docId}:${uid("r")}`;
  const turnId = uid("turn");
  const userBlockId = uid("u");

  // 注册/激活会话线程:DesignAIRail 用 designThreads.find(id===activeThreadId) 决定是否
  // 渲染 blocks,缺这条线程则聊天面板永远显示空态(即使镜像里已有消息)。
  if (!mirror.threads.some((t) => t.id === sessionId)) {
    mirror.setThreads([
      ...mirror.threads,
      {
        id: sessionId,
        title: "",
        updatedAt: new Date().toISOString(),
        model: personal.designSettings.model || personal.lastModel || "",
        mode: "agent",
      } as NormalizedThread,
    ]);
  }
  mirror.setActiveThread(sessionId);
  mirror.pushBlock({
    kind: "user",
    id: userBlockId,
    turnId,
    text,
    // displayText 供转录/标题派生展示(完整 prompt 往往含大量上下文)。
    meta: overrides?.displayText ? { displayText: overrides.displayText } : undefined,
  } as ChatBlock);
  mirror.beginTurn(turnId, userBlockId);

  // agent/model:设计设置显式指定优先,否则沿用个人工作区「最后一次使用」。
  const agent = personal.lastAgent ?? "claude";
  const model = personal.designSettings.model || personal.lastModel;
  const req: CliStartRequest = {
    runId,
    sessionId,
    agent,
    cwd,
    prompt: text,
    ...(model ? { model } : {}),
    ...(overrides?.reasoningEffort ? {} : {}),
    // accept-edits:免审批写工作区文件(设计回合只需 Write/Edit HTML+MD),
    // 不放开任意命令;print 模式无交互审批,approvalPolicy 必须 auto。
    permissionMode: "accept-edits",
    approvalPolicy: "auto",
    ...(agentSessionBySession.has(sessionId)
      ? { resumeSessionId: agentSessionBySession.get(sessionId) }
      : {}),
  };

  activeRuns.set(runId, { sessionId, docId, turnId });
  try {
    await bridge.startCli(req);
    return true;
  } catch (err) {
    activeRuns.delete(runId);
    mirror.pushBlock({
      kind: "system",
      id: uid("err"),
      text: err instanceof Error ? err.message : String(err),
      severity: "error",
    } as ChatBlock);
    if (activeRuns.size === 0) mirror.endTurn();
    return false;
  }
}

// 停止当前全部设计 run(右栏停止按钮)。cli.ts 侧 killCli 会抑制安全重试并整组 SIGTERM。
export async function cancelActiveDesignRuns(): Promise<void> {
  const bridge = installedBridge;
  if (!bridge) return;
  const ids = [...activeRuns.keys()];
  await Promise.allSettled(ids.map((id) => bridge.killCli(id)));
  // exit 事件会逐个清理;这里兜底立即复位 busy,避免进程组已死但事件丢失时卡忙碌态。
  activeRuns.clear();
  useChatStore.getState().endTurn();
}

// ── 装配 ────────────────────────────────────────────────────────────────
// DesignWorkspace 容器挂载时调用;幂等(同 bridge 重复调用跳过)。
export function installDesignRuntime(bridge: DesktopBridge | null | undefined): void {
  if (!bridge || installedBridge === bridge) return;
  // 先卸载旧订阅(HMR/bridge 重建场景)。
  for (const un of unsubscribes) un();
  unsubscribes = [];
  installedBridge = bridge;

  // 平台端口:文件系统(kunGuiPort)+ UI 态存储(designUi 分片)。
  installDesignPlatform(bridge, designUiStorage);

  // runtime 端口:设置读取直连 personal store 的 designSettings 分片;SSE 无对等物(no-op),
  // design 树的流式消费改走 chat 镜像(上面的事件折叠)。
  setDesignRuntimeClient({
    startSse: async (_t, _s, streamId) => ({ streamId: streamId ?? "cli" }),
    onSseEvent: () => () => {},
    stopSse: () => {},
    invalidateSettings: () => {},
    getSettings: async () =>
      ({ design: usePersonalStore.getState().designSettings }) as AppSettingsV1,
  });

  // provider 端口:design 树少量直连调用(线程详情/发消息)的最小实现。
  setDesignRuntimeProvider({
    createThread: async () => {
      const docId = useDesignWorkspaceStore.getState().activeDocumentId ?? "scratch";
      // NormalizedThread 字段面很宽,这里只保证 id/title 可用(消费点仅读这两项)。
      return { id: `design-${docId}`, title: "" } as unknown as NormalizedThread;
    },
    sendUserMessage: async (_threadId, text, overrides) => {
      await sendDesignMessage(text, "agent", overrides);
    },
    uploadAttachment: async () => {
      throw new Error("设计工作台暂不支持附件上传");
    },
    getThreadDetail: async (threadId) => {
      const s = useChatStore.getState();
      return {
        thread: { id: threadId, title: "" } as unknown as NormalizedThread,
        blocks: s.activeThreadId === threadId ? s.blocks : [],
      };
    },
  });

  // CLI 事件订阅:只认 design: 前缀,与个人会话事件流互不干扰。
  unsubscribes.push(
    bridge.onCliEvent((runId, event) => {
      if (!isDesignRunId(runId)) return;
      handleDesignCliEvent(runId, event);
    }),
    bridge.onCliExit((exit) => {
      if (!isDesignRunId(exit.runId)) return;
      handleDesignCliExit(exit.runId, exit.code, exit.error);
    }),
  );

  // 默认设计根缺省时一次性物化(设置页显示实际路径、fs 白名单天然覆盖)。
  void (async () => {
    const p = usePersonalStore.getState();
    if (!p.designSettings.defaultWorkspaceRoot && bridge.designWorkspaceRoot) {
      try {
        const root = await bridge.designWorkspaceRoot();
        usePersonalStore.getState().setDesignSettings({ defaultWorkspaceRoot: root });
      } catch {
        /* 拿不到默认根时留空,派发回合时再兜底 */
      }
    }
  })();
}
