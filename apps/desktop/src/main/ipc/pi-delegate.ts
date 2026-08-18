// Pi 长驻会话的 delegate 运行时：把角色投影为 Pi child 请求，桥接 child 事件/UI，
// 并统一收口取消、超时、gateway 与能力会话清理。
//
// 本模块不反向 import pi-session.ts。父会话独有的请求准备、能力注册表与 transient UI
// 注册表通过最小依赖接口注入，避免 IPC registry 与 delegate runtime 形成循环依赖。

import { randomUUID } from "crypto";
import { join, resolve } from "path";

import type { WebContents } from "electron";

import type { PiSessionEngine } from "../agents/pi-inproc";
import { openPiGatewaySession } from "../agents/pi-gateway/client";
import { mcpServerToBridge, type BridgeServer } from "../agents/pi-mcp-bridge";
import {
  ensureDesignDelegateMcpServerConfig,
  registerDesignDelegateSession,
  unregisterDesignDelegateSession,
  type DesignDelegateSessionState,
} from "../capabilities/design-delegate/server";
import {
  registerDelegateSession,
  unregisterDelegateSession,
  type DelegateSessionState,
  type SubAgentResult,
} from "../capabilities/delegate/server";
import { ensureSlidesMcpServerConfig } from "../capabilities/slides/server";
import {
  registerSlidesSession,
  unregisterSlidesSession,
  type SlidesSessionState,
} from "../capabilities/slides/session";
import { createLogger } from "../log";
import { documentsCortexDir } from "../paths";
import {
  assertConversationArtifactRequestShape,
  assertConversationArtifactRunIdentity,
  isKnownConversationArtifactRoot,
  validateConversationArtifact,
} from "./artifact-workspace";
import { assertSpawnCwd, resolveSpawnCwd } from "./cli";
import { sendRunEvent } from "./run-events";
import { assertAllowed } from "./fs";
import { getPersistedState } from "./store";
import {
  PI_PLAN_TOOL_WHITELIST,
  type CliStreamEvent,
  type PiOpenRequest,
  type PiSessionEvent,
  type PiUiRequest,
  type PiUiResponsePayload,
  type RoleConfig,
} from "./types";

// 沿用迁移前的日志 scope，确保结构性提取不改变现有日志筛选与诊断行为。
const log = createLogger("pi-session");

const DELEGATE_TIMEOUT_MS = 30 * 60_000;
const MAX_DELEGATE_OUTPUT = 200_000;
const DELEGATE_UI_ROUTE_PREFIX = "delegate:";

/** 可接收 transient UI 应答的最小会话形状；父注册表不需要知道完整 gateway engine。 */
export type TransientPiUiSession = Pick<PiSessionEngine, "respondUi">;

/**
 * delegate runtime 需要回调父会话模块的最小依赖集合。
 *
 * `prepareOpenRequest` 可能抛出 provider、路径或必需能力准备错误；调用方不应在这里降级。
 * 三个清理/注册函数必须保持幂等，以承受取消、超时和异步 open 完成之间的竞态。
 */
export interface PiDelegateRuntimeDeps {
  prepareOpenRequest(
    request: PiOpenRequest,
    options?: { profile?: "parent" | "child" },
  ): Promise<PiOpenRequest>;
  cleanupCapabilitySessions(uiSessionId: string): void;
  registerTransientUiRequest(
    uiSessionId: string,
    requestId: string,
    session: TransientPiUiSession,
    owner: WebContents,
  ): void;
  clearTransientUiRequestsForSession(session: TransientPiUiSession): void;
}

/** 父 Pi 会话每一轮持有一份 runtime；`state` 是 delegate MCP host 的登记对象。 */
export interface PiDelegateRuntime {
  controller: AbortController;
  state: DelegateSessionState;
  disposed: boolean;
}

/**
 * Pi artifact 会话持有的能力代际。design-delegate 与 slides 注册表都只保存这里的 state 引用，
 * `disposePiArtifactRuntime` 因而可以用 expected-state 语义撤销旧代，而不会误删同 session 新代。
 */
export interface PiArtifactRuntime {
  controller: AbortController;
  designState: DesignDelegateSessionState;
  slidesState?: SlidesSessionState;
  /** 已在主进程验证、必须交给 gateway 的内置 MCP；任一缺失都会让 open 失败。 */
  requiredBridgeServers: BridgeServer[];
  disposed: boolean;
}

/** routed id 只属于 delegate child；迟到应答不能回落到父 gateway engine。 */
export function isPiDelegateUiRequestId(requestId: string): boolean {
  return requestId.startsWith(DELEGATE_UI_ROUTE_PREFIX);
}

/**
 * 短生命周期 child 的 UI 路由器。renderer 只认识父 uiSessionId，因此不能把 child 的 native
 * request id 直接登记到父 transient map：两个并行 worker session 理论上可能产生相同 id。
 * 每个 child 使用独立 adapter + 全局 routed id，回写时再翻译成该 engine 的 native id。
 */
function createDelegateUiRouter(): {
  adapter: TransientPiUiSession;
  add: (routedId: string, nativeId: string) => void;
  attach: (session: PiSessionEngine) => void;
  respondNative: (nativeId: string, payload: PiUiResponsePayload) => void;
} {
  const nativeIds = new Map<string, string>();
  const pendingResponses: Array<{ nativeId: string; payload: PiUiResponsePayload }> = [];
  let session: PiSessionEngine | undefined;
  const respondNative = (nativeId: string, payload: PiUiResponsePayload) => {
    if (session) session.respondUi(nativeId, payload);
    else pendingResponses.push({ nativeId, payload });
  };
  return {
    add: (routedId, nativeId) => nativeIds.set(routedId, nativeId),
    attach: (next) => {
      session = next;
      for (const response of pendingResponses.splice(0)) {
        next.respondUi(response.nativeId, response.payload);
      }
    },
    respondNative,
    adapter: {
      respondUi: (routedId, payload) => {
        const nativeId = nativeIds.get(routedId);
        if (!nativeId) return;
        nativeIds.delete(routedId);
        respondNative(nativeId, payload);
      },
    },
  };
}

/** Pi gateway 事件映射到 delegate host 已有的 CliStreamEvent 契约；终态由返回值统一收口。 */
function mapPiDelegateEvent(ev: PiSessionEvent): CliStreamEvent | null {
  switch (ev.type) {
    case "text":
      return { type: "text", delta: ev.delta };
    case "reasoning":
      return { type: "thinking", delta: ev.delta };
    case "tool-start":
      return {
        type: "tool",
        name: ev.name,
        detail: ev.detail,
        input: ev.input,
        phase: "start",
        toolCallId: ev.toolCallId,
      };
    case "tool-end":
      return {
        type: "tool",
        name: ev.name,
        output: ev.output,
        isError: ev.isError,
        phase: "end",
        toolCallId: ev.toolCallId,
      };
    case "todo":
      return { type: "todo", todos: ev.todos };
    case "retry":
      return { type: "retry", attempt: ev.attempt, maxAttempts: ev.maxAttempts, reason: ev.error };
    case "turn-end":
      return { type: "turn" };
    case "notify":
      return ev.message ? { type: "text", delta: ev.message } : null;
    // error/result/crashed/settled 由 runPiDelegateSubAgent 的单一 settle 点处理，不能先把子卡片
    // 收尾一次、再由 delegate server 的 tool_result 收尾第二次。其余是 child UI 不消费的会话态。
    case "error":
    case "result":
    case "crashed":
    case "settled":
    case "compaction":
    case "queue":
    case "session-info":
    case "thinking-level":
    case "artifact":
      return null;
  }
}

function delegateChildRequest(parent: PiOpenRequest, role: RoleConfig, childSessionId: string): PiOpenRequest {
  const readOnly = role.toolPolicy === "readOnly";
  return {
    uiSessionId: childSessionId,
    cwd: parent.cwd,
    // 非 Pi 角色的模型已在 createPiDelegateRuntime 清掉；原生 Pi 角色可显式覆盖，未覆盖才继承
    // 父 Pi 模型。只传 providerId；preparePiOpenRequest 会在主进程重新解析 endpoint，绝不沿用
    // 父请求里可能来自 renderer 或旧代的 provider 对象。
    model: role.model ?? parent.model,
    providerId: parent.providerId,
    providerFingerprint: parent.providerFingerprint,
    thinkingLevel: role.effort ?? parent.thinkingLevel,
    useOwnSkills: parent.useOwnSkills,
    skillPaths: parent.skillPaths,
    appendSystemPrompt: role.systemPrompt || undefined,
    // inherit 角色沿用父审批。readOnly 则以 worker 的工具白名单物理裁掉写工具；没有写工具可调时
    // 审批 hook 也应关闭，避免扩展 UI 误给用户一个“批准后可写”的错误暗示。
    toolWhitelist: readOnly ? [...PI_PLAN_TOOL_WHITELIST] : parent.toolWhitelist,
    enableToolApproval: readOnly ? false : parent.enableToolApproval,
    approvalTools: readOnly ? undefined : parent.approvalTools,
  };
}

/**
 * 执行一次 Pi delegate child。open/ready/prompt 任一阶段都可能与父取消或 30 分钟超时竞态；
 * settle 是唯一出口，负责 transient UI、gateway session、MCP session 映射和监听器的完整释放。
 */
function runPiDelegateSubAgent(options: {
  parent: PiOpenRequest;
  sender: WebContents;
  role: RoleConfig;
  task: string;
  onEvent: (ev: CliStreamEvent) => void;
  signal: AbortSignal;
  childSessionId: string;
  deps: PiDelegateRuntimeDeps;
}): Promise<SubAgentResult> {
  const { parent, sender, role, task, onEvent, signal, childSessionId, deps } = options;
  if (signal.aborted) return Promise.resolve({ text: "", ok: false, error: "已取消" });

  let child: PiSessionEngine | undefined;
  let output = "";
  let lastError: string | undefined;
  let settled = false;
  const uiRouter = createDelegateUiRouter();

  return new Promise<SubAgentResult>((resolveResult) => {
    const release = () => {
      deps.clearTransientUiRequestsForSession(uiRouter.adapter);
      try {
        child?.stop();
      } catch (error) {
        log.warn(`Pi delegate child 停止失败(${childSessionId}): ${String(error)}`);
      } finally {
        child = undefined;
        deps.cleanupCapabilitySessions(childSessionId);
      }
    };
    const settle = (result: SubAgentResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      release();
      resolveResult({ ...result, text: result.text.trim() });
    };
    const onAbort = () => settle({ text: output, ok: false, error: "已取消" });
    const timer = setTimeout(
      () => settle({ text: output, ok: false, error: `子 Agent 超时（${Math.round(DELEGATE_TIMEOUT_MS / 60_000)} 分钟）` }),
      DELEGATE_TIMEOUT_MS,
    );
    signal.addEventListener("abort", onAbort, { once: true });

    const handleEvent = (ev: PiSessionEvent) => {
      if (settled) return;
      if (ev.type === "text") {
        if (output.length < MAX_DELEGATE_OUTPUT) {
          output = (output + ev.delta).slice(0, MAX_DELEGATE_OUTPUT);
        }
      } else if (ev.type === "error") {
        lastError = ev.error;
      } else if (ev.type === "retry" || (ev.type === "result" && ev.willRetry)) {
        // 自动重试会重跑整次生成，失败尝试的正文/错误不能混进最终 tool_result。
        output = "";
        lastError = undefined;
      }

      const mapped = mapPiDelegateEvent(ev);
      // role-based delegate host 会再次补 roleId/subagentCallId；design-delegate 则直接转发本事件。
      // 在最底层先补 roleId，确保两条调用链都能把并行 child 的过程隔离到正确页面段。
      if (mapped) onEvent({ ...mapped, roleId: role.id });

      if (ev.type === "crashed") {
        settle({ text: output, ok: false, error: ev.error ?? "Pi 子 Agent 已退出" });
      } else if (ev.type === "settled") {
        // result 既可能来自 message_end(stop/length)，也可能是仍有 extension follow-up 排队时的
        // agent_end；只有 agent_settled 才保证重试/自动压缩/队列全部为空，能安全 stop 短会话。
        settle(lastError
          ? { text: output, ok: false, error: lastError }
          : { text: output, ok: true });
      }
    };

    const handleUiRequest = (request: PiUiRequest) => {
      if (settled) return;
      if (sender.isDestroyed()) {
        uiRouter.respondNative(request.id, { cancelled: true });
        return;
      }
      const routedId = `${DELEGATE_UI_ROUTE_PREFIX}${childSessionId}:${randomUUID()}`;
      uiRouter.add(routedId, request.id);
      deps.registerTransientUiRequest(parent.uiSessionId, routedId, uiRouter.adapter, sender);
      try {
        sender.send("pi:uiRequest", {
          uiSessionId: parent.uiSessionId,
          request: { ...request, id: routedId } as PiUiRequest,
        });
      } catch (error) {
        // WebContents 可能在 isDestroyed 检查后立刻销毁。主动回 cancelled 解锁 worker；transient
        // 表中的迟到项会在 child settle 时按 adapter 清掉，不把窗口竞态变成永久悬挂。
        log.warn(`Pi delegate UI 请求转发失败(${childSessionId}): ${String(error)}`);
        uiRouter.adapter.respondUi(routedId, { cancelled: true });
      }
    };

    void (async () => {
      try {
        const request = await deps.prepareOpenRequest(
          delegateChildRequest(parent, role, childSessionId),
          { profile: "child" },
        );
        if (settled || signal.aborted) {
          deps.cleanupCapabilitySessions(childSessionId);
          return;
        }
        assertSpawnCwd(request.cwd);
        const opened = await openPiGatewaySession({
          request,
          onEvent: (ev) => handleEvent(ev),
          onUiRequest: handleUiRequest,
        });
        if (settled || signal.aborted) {
          opened.stop();
          deps.cleanupCapabilitySessions(childSessionId);
          return;
        }
        child = opened;
        uiRouter.attach(opened);
        const ready = await opened.ready();
        if (settled || signal.aborted) return;

        // delegate server 已先发应用侧 childSessionId；这里补原生 Pi session id/provider/model，
        // 让 renderer 建立的 side session 明确归属 Pi，而不是沿用角色目录里可能存在的 codex/claude。
        onEvent({
          type: "init",
          sessionId: ready.sessionId,
          roleId: role.id,
          stage: "subagent",
          stageLabel: role.label,
          childSessionId,
          childAgentSessionId: ready.sessionId,
          subagentAgentId: "pi",
          subagentBaseAgent: "pi",
          subagentModel: request.model,
          subagentProviderId: request.providerId,
          subagentReadOnly: role.toolPolicy === "readOnly",
        });

        // prompt 应答只是受理 ack，真实终态由 handleEvent 的 result/error/crashed/settled 决定。
        void opened.prompt(task, randomUUID()).then(
          (response) => {
            if (!settled && !response.success) {
              settle({ text: output, ok: false, error: response.error ?? "Pi 子 Agent 启动失败" });
            }
          },
          (error: unknown) => {
            if (!settled) settle({ text: output, ok: false, error: error instanceof Error ? error.message : String(error) });
          },
        );
      } catch (error) {
        settle({ text: output, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

/** 主进程边界复验 artifact 引用；renderer 传入的 root/cwd/entryPath 一律不作为授权依据。 */
async function validatePiArtifactOpenRequest(request: PiOpenRequest): Promise<void> {
  const artifact = request.artifactContext;
  if (!artifact) return;
  request.cwd = resolveSpawnCwd(request.cwd);
  const persistedState = await getPersistedState();
  const fallbackRoot = join(documentsCortexDir(), "design");
  if (!isKnownConversationArtifactRoot(artifact.workspaceRoot, persistedState, fallbackRoot)) {
    throw new Error("产物工作区未注册");
  }
  if (resolve(request.cwd) !== resolve(artifact.workspaceRoot)) {
    throw new Error("产物 cwd 不匹配");
  }
  await assertAllowed(artifact.workspaceRoot);
  request.artifactContext = await validateConversationArtifact(artifact);
}

/**
 * 把一个产品内置 MCP 提升为 required bridge。host 启动异常、不可用或配置无法转换时都响亮失败；
 * artifact 写能力不能像用户自配 MCP 那样 best-effort 丢失后继续让模型运行。
 */
async function requireArtifactBridge(
  label: string,
  sessionId: string,
  ensure: (sessionId: string | undefined) => Promise<import("./types").McpServerConfig | null>,
): Promise<BridgeServer> {
  let config: import("./types").McpServerConfig | null;
  try {
    config = await ensure(sessionId);
  } catch (error) {
    throw new Error(`Pi ${label} MCP 启动失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bridge = config ? mcpServerToBridge(config) : null;
  if (!bridge) throw new Error(`Pi ${label} MCP 不可用，无法建立产物会话`);
  return bridge;
}

function artifactDesignRole(label: string): RoleConfig {
  return {
    id: label,
    label,
    agent: "pi",
    systemPrompt: "",
    createdAt: "",
    updatedAt: "",
  };
}

/**
 * 登记一个 artifact 回合代际。此函数无 I/O，必须在 gateway prepare/tools-list 之前调用；
 * design child 不继承 artifactContext，因此拿不到父 deck/design MCP，只能经父审批调用常规写工具。
 */
function registerPiArtifactGeneration(
  request: PiOpenRequest,
  sender: WebContents,
  deps: PiDelegateRuntimeDeps,
  runId: string,
): PiArtifactRuntime | undefined {
  const artifact = request.artifactContext;
  if (!artifact) return undefined;
  const controller = new AbortController();
  const designState: DesignDelegateSessionState = {
    sessionId: request.uiSessionId,
    runId,
    signal: controller.signal,
    abort: () => controller.abort(),
    pushEvent: (event) => {
      try {
        sendRunEvent(sender, {
          v: 1,
          domain: "artifact",
          runId: designState.runId,
          sessionId: request.uiSessionId,
          event,
        });
      } catch (error) {
        // WebContents 可在 isDestroyed 检查后销毁；事件丢弃即可，child 的取消由 destroyed 级联负责。
        log.warn(`Pi artifact delegate 事件转发失败(${request.uiSessionId}): ${String(error)}`);
      }
    },
    // Pi 主会话没有 CLI inactivity watchdog；每个 child 自带 30 分钟硬超时。
    bumpWatchdog: () => {},
    callCount: { n: 0 },
    runSubAgent: (label, prompt, onEvent, signal) =>
      runPiDelegateSubAgent({
        parent: request,
        sender,
        role: artifactDesignRole(label),
        task: prompt,
        onEvent,
        signal: signal ?? controller.signal,
        childSessionId: randomUUID(),
        deps,
      }),
  };
  registerDesignDelegateSession(designState);

  const slidesState: SlidesSessionState | undefined = artifact.kind === "slides"
    ? {
        sessionId: request.uiSessionId,
        runId,
        documentId: artifact.documentId,
        workspaceRoot: request.cwd,
      }
    : undefined;
  if (slidesState) registerSlidesSession(slidesState);

  return {
    controller,
    designState,
    slidesState,
    requiredBridgeServers: [],
    disposed: false,
  };
}

/**
 * 校验并预注册 artifact open 代际，再启动必需 MCP。调用方必须在通用 prepare 前 await 本函数；
 * 任一步失败都会撤销已登记的 capability state，不留下可被后续 tools/list 命中的权限尾巴。
 */
export async function createPiArtifactRuntime(
  request: PiOpenRequest,
  sender: WebContents,
  deps: PiDelegateRuntimeDeps,
): Promise<PiArtifactRuntime | undefined> {
  if (!request.artifactContext) return undefined;
  await validatePiArtifactOpenRequest(request);
  const artifact = request.artifactContext;
  const initialRunId = `artifact:${artifact.kind}:${artifact.documentId}:open`;
  const runtime = registerPiArtifactGeneration(request, sender, deps, initialRunId)!;
  try {
    const required = [
      requireArtifactBridge(
        "design-delegate",
        request.uiSessionId,
        ensureDesignDelegateMcpServerConfig,
      ),
      ...(artifact.kind === "slides"
        ? [requireArtifactBridge("slides", request.uiSessionId, ensureSlidesMcpServerConfig)]
        : []),
    ];
    runtime.requiredBridgeServers = await Promise.all(required);
    return runtime;
  } catch (error) {
    disposePiArtifactRuntime(runtime);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** prompt IPC 的 runId/artifactContext 必须成对且身份一致；普通会话也不能伪造 artifact 前缀。 */
export function assertPiArtifactPromptIdentity(request: PiOpenRequest, runId: string | undefined): void {
  const candidate = runId ?? "";
  assertConversationArtifactRequestShape(candidate, request.artifactContext);
  if (request.artifactContext) {
    assertConversationArtifactRunIdentity(request.artifactContext, request.cwd, candidate);
  }
}

/**
 * 每次 prompt 换一份 callCount/AbortController 代际。required bridge 属于已开的 gateway 工具集，
 * 不随 prompt 重建；注册表 state 必须重建，保证上一轮 child/迟到注销不能影响本轮。
 */
export function renewPiArtifactRuntime(
  request: PiOpenRequest,
  sender: WebContents,
  deps: PiDelegateRuntimeDeps,
  runId: string,
  previous: PiArtifactRuntime | undefined,
): PiArtifactRuntime | undefined {
  disposePiArtifactRuntime(previous);
  const next = registerPiArtifactGeneration(request, sender, deps, runId);
  if (next && previous) next.requiredBridgeServers = previous.requiredBridgeServers;
  return next;
}

/** 取消 artifact child 并按 expected-state 撤销 design/slides 能力；可重复调用。 */
export function disposePiArtifactRuntime(runtime: PiArtifactRuntime | undefined): void {
  if (!runtime || runtime.disposed) return;
  runtime.disposed = true;
  try {
    runtime.controller.abort();
  } finally {
    unregisterDesignDelegateSession(runtime.designState.sessionId, runtime.designState);
    if (runtime.slidesState) {
      unregisterSlidesSession(runtime.slidesState.sessionId, runtime.slidesState);
    }
  }
}

/**
 * 为父 Pi 会话创建并登记一轮 delegate runtime。没有角色时返回 `undefined`；创建过程不执行 I/O，
 * child 的准备/启动错误会由 `runSubAgent` 收敛成失败结果。
 */
export function createPiDelegateRuntime(
  request: PiOpenRequest,
  sender: WebContents,
  deps: PiDelegateRuntimeDeps,
): PiDelegateRuntime | undefined {
  if (!request.delegateRoles?.length) return undefined;
  // 非 Pi 角色的 agent/model 属另一套 runtime/provider，主进程必须清掉并强制改走 Pi gateway；
  // 原本就是 Pi 的角色则保留显式 model/effort override，未配置时才由 child 继承父会话。
  request.delegateRoles = request.delegateRoles.map((role) =>
    role.agent === "pi" ? role : { ...role, agent: "pi", model: undefined },
  );
  const controller = new AbortController();
  const state: DelegateSessionState = {
    sessionId: request.uiSessionId,
    runId: request.uiSessionId,
    roles: request.delegateRoles,
    signal: controller.signal,
    abort: () => controller.abort(),
    pushEvent: (event) => {
      sendRunEvent(sender, { v: 1, domain: "chat", runId: state.runId, sessionId: request.uiSessionId, event });
    },
    // 信封归一 P2:子会话完整过程走独立信封(sessionId=childSessionId,runId=callId,事件已剥
    // 父会话过滤标记),渲染端不再从父流的标记推断子归属。
    pushChildEvent: (childSessionId, callId, event) => {
      sendRunEvent(sender, { v: 1, domain: "chat", runId: callId, sessionId: childSessionId, event });
    },
    // Pi 主会话的 renderer 看门狗只更新时间、不因静默杀进程；child 自带硬超时，因此这里无需续租。
    bumpWatchdog: () => {},
    maxParallel: request.delegatePolicy?.maxParallel ?? 256,
    maxChildRuns: request.delegatePolicy?.maxChildRuns ?? 25,
    childRunCount: 0,
    activeRuns: 0,
    waiters: [],
    runSubAgent: (role, task, onEvent, childSessionId, signal) =>
      runPiDelegateSubAgent({
        parent: request,
        sender,
        role,
        task,
        onEvent,
        signal: signal ?? controller.signal,
        childSessionId,
        deps,
      }),
  };
  registerDelegateSession(state);
  return { controller, state, disposed: false };
}

/** 取消全部在途 child 并注销 delegate host 状态；可重复调用，后续调用无副作用。 */
export function disposePiDelegateRuntime(runtime: PiDelegateRuntime | undefined): void {
  if (!runtime || runtime.disposed) return;
  runtime.disposed = true;
  try {
    runtime.controller.abort();
  } finally {
    unregisterDelegateSession(runtime.state.sessionId, runtime.state);
  }
}
