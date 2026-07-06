// 写作工作台的 agent 运行时接线:把写作助手的每个回合跑在 cortex 既有的 startCli CLI 管线上。
// 与 design-run-manager 同构,但有一处实质差异——**传 resumeSessionId 做多轮续接**:写作助手是
// 多轮改稿对话,依赖 agent 的对话记忆(design 各回合彼此独立故刻意不续接)。职责:
//   1) installWritingRuntime(bridge):一次性装配 CLI 事件订阅(按 writing: runId 前缀过滤,
//      与个人会话事件流硬隔离——messages.ts 侧有对称的 writing:/writing- 前缀守卫)。
//   2) sendWritingMessage:构造 CliStartRequest(sessionId=writing-<threadUuid>、
//      runId=writing:<spaceId>:<uid>、cwd=空间根、accept-edits 免审批写空间文件、auto 审批、
//      第二轮起带 resumeSessionId 续接),把 CliStreamEvent 折叠进 useWritingRunStore 的轻量消息镜像。
//   3) cancelRunsForSpace(spaceId):只 kill 该空间的 run(runId 中的 spaceId 过滤),
//      当前空间之外(含并存的其它空间 run 与 design: run)一律不受影响(R14)。
// 模块级注册表(activeRuns / resumeByThread)持有运行态:组件(覆盖层)卸载不中断,重进后镜像完整(R16)。
import { create } from "zustand";
import type { DesktopBridge } from "../../desktop/bridge";
import type { CliStartRequest, CliStreamEvent } from "../../desktop/types";

// 写作 run 的 runId 前缀契约(与 messages.ts 的 phantom-run 守卫、事件过滤共同依赖)。
// runId 形如 writing:<spaceId>:<uid>;sessionId 另用 writing-<threadUuid> 前缀。
export const WRITING_RUN_PREFIX = "writing:";

// 判定一个 runId 是否属于写作工作台(事件订阅侧据此过滤,只收自家 run)。
export function isWritingRunId(runId: string): boolean {
  return runId.startsWith(WRITING_RUN_PREFIX);
}

// ── 轻量消息模型:折叠 CliStreamEvent 供右栏面板渲染(精简自 design compat/chat-store 思路)──
export type WritingMessage =
  | { id: string; role: "user"; text: string; displayText?: string }
  | { id: string; role: "assistant"; text: string }
  | { id: string; role: "tool"; name: string; detail?: string; status: "running" | "success" | "error" }
  | { id: string; role: "system"; text: string; severity?: "error" };

// 面板消费的 store:消息按 threadId 分桶 + 每空间活跃 run 计数(停止按钮/忙碌态 per-space 门控)。
export interface WritingRunStoreState {
  messagesByThread: Record<string, WritingMessage[]>;
  // 每空间在跑的 run 计数:>0 即该空间忙碌(R14 的 per-space 隔离依赖它,不用全局 busy)。
  runningBySpace: Record<string, number>;

  // 追加一条消息到指定 thread(用户/工具/系统块)。
  pushMessage: (threadId: string, msg: WritingMessage) => void;
  // 更新某条消息的文本(assistant 流式累积用;找不到 id 则忽略)。
  updateMessageText: (threadId: string, id: string, text: string) => void;
  // 更新某条 tool 消息的状态(phase:end 落定 success/error;找不到则忽略)。
  patchToolStatus: (threadId: string, id: string, status: "running" | "success" | "error") => void;
  // 空间活跃 run 计数增减(delta ±1);降到 0 以下夹到 0。
  bumpSpaceRunning: (spaceId: string, delta: number) => void;
  // 把某空间的活跃计数直接清 0(cancel 兜底,避免进程组已死但 exit 事件丢失时卡忙碌)。
  resetSpaceRunning: (spaceId: string) => void;
}

export const useWritingRunStore = create<WritingRunStoreState>((set) => ({
  messagesByThread: {},
  runningBySpace: {},

  pushMessage: (threadId, msg) =>
    set((s) => ({
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: [...(s.messagesByThread[threadId] ?? []), msg],
      },
    })),

  updateMessageText: (threadId, id, text) =>
    set((s) => {
      const list = s.messagesByThread[threadId];
      if (!list) return {};
      return {
        messagesByThread: {
          ...s.messagesByThread,
          [threadId]: list.map((m) => (m.id === id && m.role === "assistant" ? { ...m, text } : m)),
        },
      };
    }),

  patchToolStatus: (threadId, id, status) =>
    set((s) => {
      const list = s.messagesByThread[threadId];
      if (!list) return {};
      return {
        messagesByThread: {
          ...s.messagesByThread,
          [threadId]: list.map((m) => (m.id === id && m.role === "tool" ? { ...m, status } : m)),
        },
      };
    }),

  bumpSpaceRunning: (spaceId, delta) =>
    set((s) => ({
      runningBySpace: {
        ...s.runningBySpace,
        [spaceId]: Math.max(0, (s.runningBySpace[spaceId] ?? 0) + delta),
      },
    })),

  resetSpaceRunning: (spaceId) =>
    set((s) => ({ runningBySpace: { ...s.runningBySpace, [spaceId]: 0 } })),
}));

// ── 模块级运行态(组件卸载不丢)────────────────────────────────────────────
// 单个写作 run 的上下文;liveMsgId 为当前流式 assistant 块的 id(未开流时 undefined)。
type WritingRunContext = {
  spaceId: string;
  threadId: string;
  sessionId: string;
  liveMsgId?: string;
  sawStreamedText: boolean;
};

let installedBridge: DesktopBridge | null = null;
let unsubscribes: Array<() => void> = [];
// runId → run 上下文。渲染端权威;主进程崩溃/退出由 cli:exit 兜底清理。
const activeRuns = new Map<string, WritingRunContext>();
// threadId → agent 侧真实 sessionId(从 init 事件捕获)。下一轮 sendWritingMessage 据此续接;
// 也供 U8 持久化进 thread 元数据,重装后经 setResumeSessionId 回灌。
const resumeByThread = new Map<string, string>();

function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// 工具 input 序列化(循环引用兜底为空串),供聊天面板展示工具调用参数。
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// 某空间是否有写作回合在跑(右栏停止按钮/发送门控用)。
export function writingSpaceBusy(spaceId: string): boolean {
  return (useWritingRunStore.getState().runningBySpace[spaceId] ?? 0) > 0;
}

// 取某 thread 的续接 sessionId(U8 持久化进 thread 元数据用)。
export function getResumeSessionId(threadId: string): string | undefined {
  return resumeByThread.get(threadId);
}

// 回灌续接 sessionId(重装/重启后从持久化的 thread 元数据恢复,让下一轮仍能 resume)。
export function setResumeSessionId(threadId: string, sessionId: string): void {
  resumeByThread.set(threadId, sessionId);
}

// ── CLI 事件折叠:CliStreamEvent → 轻量消息镜像 ──────────────────────────────
function handleWritingCliEvent(runId: string, ev: CliStreamEvent): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  const store = useWritingRunStore.getState();
  switch (ev.type) {
    case "init":
      // 捕获 agent 侧真实 sessionId 供下一轮续接(写作与 design 的关键差异)。
      if (ev.sessionId) resumeByThread.set(run.threadId, ev.sessionId);
      return;
    case "text": {
      // 流式正文累积进当前 assistant 块(无则新建)。
      run.sawStreamedText = true;
      if (!run.liveMsgId) {
        run.liveMsgId = uid("a");
        store.pushMessage(run.threadId, { id: run.liveMsgId, role: "assistant", text: ev.delta });
        return;
      }
      const list = useWritingRunStore.getState().messagesByThread[run.threadId] ?? [];
      const prev = list.find((m) => m.id === run.liveMsgId);
      const prevText = prev && prev.role === "assistant" ? prev.text : "";
      store.updateMessageText(run.threadId, run.liveMsgId, prevText + ev.delta);
      return;
    }
    case "thinking":
      // v1 不单独展示推理流,刻意丢弃。
      return;
    case "tool": {
      const toolId = ev.toolCallId ?? `${runId}:${ev.name}`;
      if (ev.phase === "end") {
        // 落定时只更新状态(不覆写 detail)。
        store.patchToolStatus(run.threadId, toolId, ev.isError ? "error" : "success");
        return;
      }
      // 工具开始:先结束当前流式正文块(保持时间线顺序 文本→工具→文本)。
      run.liveMsgId = undefined;
      // claude/codex 带结构化 input(序列化展示);pi 只带已提取的 detail 字符串。
      const detail =
        ev.input !== undefined
          ? typeof ev.input === "string"
            ? ev.input
            : safeStringify(ev.input)
          : ev.detail;
      // pi adapter 只发 tool start(无 phase),没有对应 end 事件 → 状态直接落定 success,
      // 否则芯片永远停在 running;claude/codex 有 phase:start 才先置 running、等 end 翻转。
      const status: "running" | "success" = ev.phase === "start" ? "running" : "success";
      store.pushMessage(run.threadId, { id: toolId, role: "tool", name: ev.name, detail, status });
      return;
    }
    case "result": {
      // 有的 agent(尤其 pi)不走流式 text,最终输出只在 result.text 里。若本回合没有流式文本,
      // 把 result.text 补成一条 assistant 块,否则面板看不到回复。
      run.liveMsgId = undefined;
      if (ev.ok && !run.sawStreamedText && ev.text?.trim()) {
        store.pushMessage(run.threadId, { id: uid("a"), role: "assistant", text: ev.text });
      }
      if (!ev.ok && ev.error) {
        store.pushMessage(run.threadId, {
          id: uid("err"),
          role: "system",
          text: ev.error,
          severity: "error",
        });
      }
      return;
    }
    default:
      return;
  }
}

function handleWritingCliExit(runId: string, code: number | null, error?: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  activeRuns.delete(runId);
  const store = useWritingRunStore.getState();
  if (code !== 0 && (code !== null || error)) {
    store.pushMessage(run.threadId, {
      id: uid("exit"),
      role: "system",
      text: error ?? `写作回合异常退出(code=${code})`,
      severity: "error",
    });
  }
  // 该空间活跃计数减一(降到 0 即空间空闲)。
  store.bumpSpaceRunning(run.spaceId, -1);
}

// ── 回合派发 ────────────────────────────────────────────────────────────
export interface SendWritingMessageParams {
  spaceId: string; // 空间 id(参与 runId 组装,cancelRunsForSpace 据此过滤)
  threadId: string; // 会话 threadUuid(参与 sessionId 组装)
  cwd: string; // 空间根目录(agent 工作目录)
  prompt: string; // 拼装后的完整 prompt(含上下文/引用/改稿约定,U8 composeWritingPrompt 产出)
  displayText?: string; // 转录展示用的用户正文(剥掉上下文噪音)
  agent: string; // 选定 agent(claude/codex/pi,U8 面板选择)
  model?: string;
  provider?: CliStartRequest["provider"]; // pi 专用供应商配置
}

// 派发一个写作回合:构造 CliStartRequest 交 startCli,并把用户消息落进镜像。成功返回 true。
export async function sendWritingMessage(params: SendWritingMessageParams): Promise<boolean> {
  const bridge = installedBridge;
  const store = useWritingRunStore.getState();
  if (!bridge) {
    store.pushMessage(params.threadId, {
      id: uid("err"),
      role: "system",
      text: "写作助手需要桌面端环境(bridge 未注入)",
      severity: "error",
    });
    return false;
  }

  const sessionId = `writing-${params.threadId}`;
  const runId = `${WRITING_RUN_PREFIX}${params.spaceId}:${uid("r")}`;
  // 第二轮起带 resumeSessionId 续接(依赖 agent 对话记忆);首轮无,由 cli.ts resume 丢失兜底新建。
  const resumeSessionId = resumeByThread.get(params.threadId);

  // 用户消息先落镜像(displayText 优先展示,否则回落完整 prompt)。
  store.pushMessage(params.threadId, {
    id: uid("u"),
    role: "user",
    text: params.prompt,
    ...(params.displayText ? { displayText: params.displayText } : {}),
  });

  const req: CliStartRequest = {
    runId,
    sessionId,
    agent: params.agent,
    cwd: params.cwd,
    prompt: params.prompt,
    ...(params.model ? { model: params.model } : {}),
    ...(params.provider ? { provider: params.provider } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    // accept-edits:免审批写空间内文件(agent 用 Write/Edit 工具直接改稿),不放开任意命令;
    // print 模式无交互审批,approvalPolicy 必须 auto。
    permissionMode: "accept-edits",
    approvalPolicy: "auto",
  };

  activeRuns.set(runId, {
    spaceId: params.spaceId,
    threadId: params.threadId,
    sessionId,
    sawStreamedText: false,
  });
  store.bumpSpaceRunning(params.spaceId, 1);
  try {
    await bridge.startCli(req);
    return true;
  } catch (err) {
    activeRuns.delete(runId);
    store.bumpSpaceRunning(params.spaceId, -1);
    store.pushMessage(params.threadId, {
      id: uid("err"),
      role: "system",
      text: err instanceof Error ? err.message : String(err),
      severity: "error",
    });
    return false;
  }
}

// 停止指定空间的全部写作 run(右栏停止按钮,R14)。只按 runId 中的 spaceId 过滤 kill,
// 并存的其它空间 run 与 design: run 一律不动。exit 事件会逐个清理,这里兜底立即复位忙碌态。
export async function cancelRunsForSpace(spaceId: string): Promise<void> {
  const bridge = installedBridge;
  if (!bridge) return;
  const ids = [...activeRuns.entries()]
    .filter(([, ctx]) => ctx.spaceId === spaceId)
    .map(([id]) => id);
  await Promise.allSettled(ids.map((id) => bridge.killCli(id)));
  for (const id of ids) activeRuns.delete(id);
  useWritingRunStore.getState().resetSpaceRunning(spaceId);
}

// ── 装配 ────────────────────────────────────────────────────────────────
// WritingWorkspace 容器挂载时调用;幂等(同 bridge 重复调用跳过)。
export function installWritingRuntime(bridge: DesktopBridge | null | undefined): void {
  if (!bridge || installedBridge === bridge) return;
  // 先卸载旧订阅(HMR/bridge 重建场景)。
  for (const un of unsubscribes) un();
  unsubscribes = [];
  installedBridge = bridge;

  // CLI 事件订阅:只认 writing: 前缀,与个人会话/设计事件流互不干扰。
  unsubscribes.push(
    bridge.onCliEvent((runId, event) => {
      if (!isWritingRunId(runId)) return;
      handleWritingCliEvent(runId, event);
    }),
    bridge.onCliExit((exit) => {
      if (!isWritingRunId(exit.runId)) return;
      handleWritingCliExit(exit.runId, exit.code, exit.error);
    }),
  );
}

// 测试专用:复位模块级运行态 + store(避免用例间串扰)。
export function __resetWritingRunManagerForTest(): void {
  for (const un of unsubscribes) un();
  unsubscribes = [];
  installedBridge = null;
  activeRuns.clear();
  resumeByThread.clear();
  useWritingRunStore.setState({ messagesByThread: {}, runningBySpace: {} });
}
