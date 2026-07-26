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
import type { AgentKind, CliStartRequest, CliStreamEvent } from "../../desktop/types";
import { usePersonalStore, resolveDefaultAgent, type PersonalState } from "../../store/personal";
import { buildMemoryAppend } from "../../memory/inject";
import { setDesignRuntimeClient } from "../compat/runtime-client";
import { setDesignRuntimeProvider } from "../compat/agent-registry";
import { useChatStore } from "../compat/chat-store";
import type { ChatBlock, NormalizedThread } from "../compat/agent-types";
import type { AppSettingsV1 } from "../compat/app-settings";
import type { SendMessageOverrides } from "../compat/chat-store-types";
import { useDesignWorkspaceStore } from "../design-workspace-store";
import { designDocumentKind } from "../design-types";
import { installDesignPlatform } from "../platform/bridge-adapter";
import { designUiStorage } from "../platform/design-ui-storage";
import { createToolBlockIdTracker } from "./tool-block-ids";

// 活跃设计 run 注册表(runId → 上下文)。渲染端权威;主进程崩溃/退出由 cli:exit 兜底清理。
type DesignRunContext = {
  sessionId: string;
  docId: string;
  turnId: string;
};

let installedBridge: DesktopBridge | null = null;
let unsubscribes: Array<() => void> = [];
const activeRuns = new Map<string, DesignRunContext>();
// 工具 block id 分配器:adapter 不给 toolCallId 时按 (runId, name) FIFO 配对,
// 避免同回合十几次同名调用(codex 把所有 MCP 都叫 "MCP")撞成同一个 block。
const toolBlockIds = createToolBlockIdTracker();

// 工具输出存进 block.meta 的截断上限:芯片只需要摘要,大输出会白占渲染端内存。
const MAX_TOOL_OUTPUT_IN_META = 4_000;

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 工具 input 序列化(循环引用兜底为空对象),供 delegate_task 的 label 落进 detail 供 per-page 映射。
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// 设计 run 的 runId 前缀契约(与 messages.ts 的 phantom-run 守卫、事件过滤共同依赖)。
export const DESIGN_RUN_PREFIX = "design:";
// Slides(演示文稿)回合前缀:同属设计工作台 run 管线,但主进程只对该前缀注入
// cortex-slides MCP 工具(见 apps/desktop main/ipc/cli.ts),普通 design 回合不注入。
export const SLIDES_RUN_PREFIX = "slides:";

export function isDesignRunId(runId: string): boolean {
  return runId.startsWith(DESIGN_RUN_PREFIX) || runId.startsWith(SLIDES_RUN_PREFIX);
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
      // 设计回合不续接,init 仅标记会话已启动(不记录 sessionId)。
      return;
    case "text":
      mirror.appendLiveAssistant(ev.delta);
      return;
    case "thinking":
      // v1 不单独展示推理流(镜像无 liveReasoning 字段);刻意丢弃。
      return;
    case "tool": {
      if (ev.phase === "end") {
        const toolId = toolBlockIds.end(runId, ev.name, ev.toolCallId);
        // 落定时不覆写 detail(保留 input 里的 label,供 per-page 状态映射);只更新状态。
        // output 合进 meta:slides 的芯片详情要靠它显示「第3、7页 · rev 72」(主进程已算好页码)。
        // **必须先读旧 meta 再合并** —— patchBlock 是浅合并,直接传 meta 会把 toolName 冲掉,
        // 而 delegate_task 的 per-page 映射正依赖 meta.toolName。
        const prev = useChatStore.getState().blocks.find((b) => b.id === toolId);
        const prevMeta = (prev?.kind === "tool" ? prev.meta : undefined) ?? {};
        const output =
          typeof ev.output === "string" && ev.output
            ? ev.output.length > MAX_TOOL_OUTPUT_IN_META
              ? ev.output.slice(0, MAX_TOOL_OUTPUT_IN_META) + "…"
              : ev.output
            : undefined;
        mirror.patchBlock(toolId, {
          status: ev.isError ? "error" : "success",
          ...(output ? { meta: { ...prevMeta, output } } : {}),
        } as Partial<ChatBlock>);
        return;
      }
      const toolId = toolBlockIds.start(runId, ev.name, ev.toolCallId);
      // 工具开始前先把已流出的正文落定,保持时间线顺序(文本→工具→文本)。
      mirror.foldLiveAssistant(run.turnId);
      // detail 存入 input 的 JSON:多页并行的 deriveParallelDesignPageStatesFromBlocks 靠
      // toolName==='delegate_task' + detail.label(page:<artifactId>)把子 agent 进度回映到对应页。
      // 新 adapter 带 input(对象,序列化后含 delegate_task 的 label 供 per-page 映射);
      // 旧 adapter 可能只有 detail。两者都存进 detail 供聊天面板展示。
      const inputJson =
        ev.input !== undefined
          ? typeof ev.input === "string"
            ? ev.input
            : safeStringify(ev.input)
          : ev.detail;
      // phase:start 先置 running、等 end 翻转；无 phase 的旧 adapter 按单帧已完成处理。
      const initialStatus: "running" | "success" = ev.phase === "start" ? "running" : "success";
      mirror.pushBlock({
        kind: "tool",
        id: toolId,
        summary: ev.name,
        status: initialStatus,
        detail: inputJson,
        // toolName 供 delegate_task 识别;child.childLabel 兜底另一条映射路径。
        meta: { toolName: ev.name, ...(ev.input ? { input: ev.input } : {}) },
      } as ChatBlock);
      return;
    }
    case "result": {
      // 有的 agent(尤其 pi)不走流式 text 事件,最终输出只在 result.text 里。若本回合没有
      // 流式文本累积(liveAssistant 空),把 result.text 补成一条 assistant 块,否则聊天看不到回复。
      const hadStreamed = useChatStore.getState().liveAssistant.trim().length > 0;
      mirror.foldLiveAssistant(run.turnId);
      if (ev.ok && !hadStreamed && ev.text?.trim()) {
        mirror.pushBlock({
          kind: "assistant",
          id: uid("a"),
          turnId: run.turnId,
          text: ev.text,
        } as ChatBlock);
      }
      if (!ev.ok && ev.error) {
        mirror.pushBlock({
          kind: "system",
          id: uid("err"),
          text: ev.error,
          severity: "error",
        } as ChatBlock);
      }
      return;
    }
    default:
      return;
  }
}

function handleDesignCliExit(runId: string, code: number | null, error?: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  activeRuns.delete(runId);
  // 回合结束清掉待配对的工具队列(进程被杀时可能有 start 永远等不到 end)。
  toolBlockIds.clearRun(runId);
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

// 解析设计回合实际使用的 agent(纯函数,便于测试):
//   · designSettings.agent(设计助手栏显式选择)优先;
//   · 非 pi 且已从 PATH 卸载(agentsAvailable[picked]===false,陈旧持久值)→ 回落系统默认,
//     避免 spawn 一个已不存在的 CLI;
//   · 未显式选择("" 或未知值)→ 跟随系统「新会话默认 Agent」(resolveDefaultAgent);
//   · derivedAgentId 只在仍存在于当前派生列表(agents.local.json 可能被改)时才返回,否则视为失效。
// 返回 base agent(供 model/provider 配对)与可选 derivedId(供 spawn 时覆盖 req.agent)。
export function resolveDesignRunAgent(
  s: Pick<PersonalState, "designSettings" | "generalSettings" | "agentsAvailable" | "derivedAgents">,
): { agent: AgentKind; derivedId?: string } {
  const picked = s.designSettings.agent;
  const isKnownKind = picked === "claude" || picked === "codex" || picked === "pi";
  // 显式选择无条件生效,**不做可用性静默回落**:agentsAvailable 来自启动期探测,可能因超时
  // 误判 false;此前「不可用→悄悄换默认 agent」会造成 UI 显示 claude、实际 spawn codex 的
  // 静默分歧(权限/模型行为全对不上,极难排查)。真不可用时由主进程 spawn 前的
  // assertAgentAvailable 给出明确可读错误,好于换人。
  const agent: AgentKind = isKnownKind ? picked : resolveDefaultAgent(s);
  const derivedId = s.designSettings.derivedAgentId;
  const validDerived =
    derivedId && (s.derivedAgents ?? []).some((d) => d.id === derivedId) ? derivedId : undefined;
  return { agent, derivedId: validDerived };
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
  // Slides 设计稿的回合用 slides: 前缀 —— 主进程据此注入 cortex-slides MCP 工具;
  // 普通 board 设计稿保持 design: 前缀(注入 design-delegate)。
  const activeDoc = ws.documents.find((d) => d.id === ws.activeDocumentId);
  const runPrefix =
    activeDoc && designDocumentKind(activeDoc) === "slides" ? SLIDES_RUN_PREFIX : DESIGN_RUN_PREFIX;
  const runId = `${runPrefix}${docId}:${uid("r")}`;
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
    // displayText 供转录/标题派生展示(完整 prompt 往往含大量上下文)；附件引用只用于回显。
          meta:
            overrides?.displayText !== undefined || overrides?.attachments?.length
              ? {
                  ...(overrides.displayText !== undefined
                    ? { displayText: overrides.displayText }
                    : {}),
                  ...(overrides.attachments?.length ? { attachments: overrides.attachments } : {}),
                }
              : undefined,
  } as ChatBlock);
  mirror.beginTurn(turnId, userBlockId);

  // agent:设计助手栏显式选择优先(designSettings.agent),未设置/陈旧则跟随系统「新会话默认 Agent」。
  // derivedId 存在时仅覆盖 spawn 的 req.agent,下方 model/provider 配对仍用 base agent。
  const { agent, derivedId } = resolveDesignRunAgent(personal);
  // model + provider 必须**与解析出的 agent 配对**(mirror initialModelDraft):
  //   · pi:选一个已启用供应商(设计设置 > lastProviderId > defaultProviderId > 首个),并**必须**配上
  //     该供应商的一个模型(设计设置 > 同为 pi 时的 lastModel > 供应商默认模型 > 首个模型)——
  //     pi 缺 model 会回落到内置默认 openai-codex(常 deactivated),LLM 调用直接失败、一个文件都不写。
  //   · claude/codex:用各自 CLI 自带鉴权,不挂 provider;model 仅取设计设置显式值(否则用 CLI 默认,
  //     绝不继承 lastModel——那可能是 pi 的模型名,传给 claude 会因未知模型瞬间退出)。
  const enabledProviders = (personal.providerSettings?.providers ?? []).filter((p) => p.enabled !== false);
  const providerProfile =
    agent === "pi"
      ? enabledProviders.find(
          (p) =>
            p.id ===
            (personal.designSettings.providerId ||
              personal.lastProviderId ||
              personal.providerSettings?.defaultProviderId),
        ) ?? enabledProviders[0]
      : undefined;
  const provider = providerProfile
    ? {
        id: providerProfile.id,
        baseUrl: providerProfile.baseUrl,
        apiKey: providerProfile.apiKey,
        models: providerProfile.models.map((m) => ({ id: m.id, name: m.label })),
      }
    : undefined;
  const model =
    agent === "pi"
      ? personal.designSettings.model ||
        (personal.lastAgent === "pi" ? personal.lastModel : undefined) ||
        personal.providerSettings?.defaultModel ||
        providerProfile?.models?.[0]?.id ||
        undefined
      : personal.designSettings.model || undefined;
  // 用户记忆注入:设计回合不做 session 续接(见下方注释),记忆经 appendSystemPrompt 每轮下发,
  // 正好补上「agent 无对话记忆」的用户背景空缺(开关关/全空 → undefined 不带字段)。
  const memoryAppend = buildMemoryAppend();
  // 图片先落盘拿绝对路径,再交给各 agent 的原生图片通道(claude 路径进 prompt / codex -i /
  // pi RPC base64)。逐张串行保序;任一张失败即中止本轮 —— 与其让 agent 看到残缺的图组,
  // 不如让用户知道图没带上(已落盘的前几张是孤儿,随会话清理)。
  let imageRefs: Array<{ path: string; mimeType: string }> | undefined;
  if (overrides?.images?.length) {
    if (!bridge.imageSave) {
      mirror.pushBlock({
        kind: "system",
        id: uid("err"),
        text: "当前环境不支持发送图片(bridge 缺少 imageSave)",
        severity: "error",
      } as ChatBlock);
      return false;
    }
    try {
      const refs: Array<{ path: string; mimeType: string }> = [];
      for (const img of overrides.images) {
        const { path } = await bridge.imageSave({
          sessionId,
          fileName: img.name,
          mimeType: img.mimeType,
          data: img.data,
        });
        refs.push({ path, mimeType: img.mimeType });
      }
      imageRefs = refs;
    } catch (err) {
      mirror.pushBlock({
        kind: "system",
        id: uid("err"),
        text: `图片保存失败:${err instanceof Error ? err.message : String(err)}`,
        severity: "error",
      } as ChatBlock);
      return false;
    }
  }
  const req: CliStartRequest = {
    runId,
    sessionId,
    // 派生 agent(agents.local.json)用其 id spawn;内置直接用 base kind。
    agent: derivedId ?? agent,
    cwd,
    prompt: text,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(memoryAppend ? { appendSystemPrompt: memoryAppend } : {}),
    ...(imageRefs?.length ? { images: imageRefs } : {}),
    ...(overrides?.webSearch ? { webSearch: true } : {}),
    ...(overrides?.reasoningEffort ? {} : {}),
    // accept-edits:免审批写工作区文件(设计回合只需 Write/Edit HTML+MD),
    // 不放开任意命令;print 模式无交互审批,approvalPolicy 必须 auto。
    permissionMode: "accept-edits",
    approvalPolicy: "auto",
    // 不做 session 续接:设计各回合(spec/系统/logo/每页)彼此独立,上下文靠磁盘上的
    // design.md / DESIGN_SYSTEM.md / 兄弟页清单传递,不依赖 agent 对话记忆。续接反而
    // 会因 agent 未持久化上一回合会话而报「No session found」直接失败(pi 尤甚)。
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
  for (const id of ids) toolBlockIds.clearRun(id);
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
