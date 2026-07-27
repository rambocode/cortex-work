// 个人工作区会话消息层。消息流存 React Query cache（key 按 sessionId 隔离），
// CLI 流式事件（经 DesktopBridge）增量写入缓存：
//   typing 占位 → 首个事件后替换为流式 text / agentLog → result/exit 落定。
// 多轮：init 捕获 agent session id 写回 SessionMeta，下一轮 resume。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ChatFileRef, ChatImageRef, Message, TodoListItem, TypingActivity } from "../types";
import type {
  AgentKind,
  ConversationArtifactRef,
  AskQuestionAnswers,
  AskQuestionEnvelope,
  CliStreamEvent,
  DerivedAgentMeta,
  HiddenHistoryMeta,
  PendingDocFile,
  PendingImage,
  PermissionMode,
  PiOpenRequest,
  PiSessionEvent,
  PiUiResponsePayload,
  ProjectMeta,
  SessionMeta,
  ThinkingLevel,
} from "../desktop/types";
import { DEFAULT_PI_EXTENSIONS, PI_PLAN_TOOL_WHITELIST } from "../desktop/types";
import { mapThinkingForAgent, type AgentThinkingValue } from "../desktop/agent-thinking";
import type { DesktopBridge } from "../desktop/bridge";
import { isOrchestrationSend, renderSkillBlock, resolveEnabledSkillRecords, type InjectableSkill } from "./skill-injection";
import { useDesktopBridge } from "../provider";
import { usePersonalStore } from "../store/personal";
import { usePetStore } from "../store/pet";
import { extractChangedFile, promptTitle, clipSummary, recordTimelineEvent } from "./timeline";
import { applyDeepenFinalize } from "./notes";
import { t } from "../i18n";
import { languageInstruction } from "../i18n/native";
import { useCortexUIStore } from "../store/ui";
import { buildMemoryAppend } from "../memory/inject";
// 会话内前置检索（可选开关）：发送前联网抓一次资料，失败静默降级，见其文件头。
import { retrieveChatEvidence } from "../research/chat-retrieval";
import {
  abortPi,
  closePiSession,
  compactPi,
  ensurePiSession,
  forkPi,
  getForkMessagesPi,
  isPiSessionOpen,
  markPiSessionGone,
  piRpcAvailable,
  piRpcUnavailableMessage,
  promptPi,
  setModelPi,
  setThinkingLevelPi,
  setPiLifecycleHooks,
  steerPi,
  touchPiSession,
} from "./pi-session";
import { derivePiCapabilities, toAdapterPermissions } from "./permissionMode";
import { speakText } from "./tts";
import { parseMentions } from "./mention";
import { normalizeLoadedChat, sanitizeBranchGroups, type BranchGroup, type LoadedChat } from "./branches";

// 全局桥引用：usePersonalCliEvents（个人工作区根部挂载一次）写入，
// 供模块级缓存写入函数做消息落盘。
let bridgeRef: DesktopBridge | null = null;

export const personalChatKeys = {
  detail: (sessionId: string) => ["personal", "convo", sessionId] as const,
};

// 分支组(刷新重新生成的多版本回复)query key:与消息流分离缓存、一起落盘(chat JSON v2,
// 见 branches.ts 文件头)。加载经 ensureBranchesLoaded / usePersonalBranches 的 queryFn 自足
// 读盘,gcTime Infinity——flushChat 会把该 key 当前值写回磁盘,若被 gc 后按空保存会静默丢分支。
export const personalBranchKeys = {
  detail: (sessionId: string) => ["personal", "branches", sessionId] as const,
};

// 瞬态「执行过程流」query key:tool→agentLog 折叠与 reasoning 思考流落在这条独立通道,
// 与持久消息流 personalChatKeys.detail 分离,**永不落盘**（无 saveChat 通道）。命名空间仿
// personalChatKeys,按 sessionId 隔离。
export const personalProcessKeys = {
  detail: (sessionId: string) => ["personal", "process", sessionId] as const,
};

// 瞬态「运行事件流」query key:原始 CliStreamEvent 按会话累积(跨多轮),供运行过程详情弹层
// (AgentTranscriptDialog)展示工具输入/输出与统计。与折叠后的 process 流分离:process 只留摘要
// 且成功轮收起/下一轮即清,而详情视图需要完整原始事件。**永不落盘**,内存上限见 MAX_RUN_EVENTS。
export const personalRunEventsKeys = {
  detail: (sessionId: string) => ["personal", "runEvents", sessionId] as const,
};

// 运行事件流单条记录:原始归一化事件 + 归属 runId + 到达时间(统计耗时用)。
export interface RunEvent {
  runId: string;
  ts: number;
  ev: CliStreamEvent;
}

// 运行事件流内存上限(环形):超限丢最旧。与 adapter 侧 output 8KB 截断双保险,防长会话内存膨胀。
const MAX_RUN_EVENTS = 1000;

export interface PromptAttachment {
  id: string;
  name: string;
  path: string;
  kind: "prompt";
  content: string;
}

export interface TodoAttachment {
  id: string;
  name: string;
  path: string;
  kind: "todo";
  projectName: string;
  content: string;
}

export type PersonalAttachment = PromptAttachment | TodoAttachment;

// skill 附件的磁盘目录:path 去掉最后一段。用纯字符串计算而非 node:path(core 包硬边界:
// 不得依赖 Node API)。路径缺失或无目录可推导(空串/仅文件名/根下文件)时返回 undefined。
function skillBaseDir(path: string): string | undefined {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : undefined;
}

// 把拖入的 skill / todo 附件序列化为 system prompt 上下文块。
// skill 块必须带 path/base_dir:仅内联正文时 agent 不知 SKILL.md 在磁盘何处,无法解析
// 其中对同目录脚本/文档的相对引用(拖拽链路 PromptPanel → ComposerShell 一路携带 path,
// 此处是唯一消费点)。无路径的旧数据回退旧格式。
export function buildAttachmentSystemPrompt(attachments: PersonalAttachment[]): string | undefined {
  if (attachments.length === 0) return undefined;
  const blocks = attachments.map((a) => {
    if (a.kind === "prompt") {
      const baseDir = skillBaseDir(a.path);
      return baseDir
        ? `<skill name="${a.name}" path="${a.path}" base_dir="${baseDir}">\n${a.content}\n</skill>`
        : `<skill name="${a.name}">\n${a.content}\n</skill>`;
    }
    return [
      `<todo name="${a.name}" project="${a.projectName}">`,
      `# ${a.name}`,
      "",
      a.content,
      "</todo>",
    ].join("\n");
  });
  // 存在带路径的 skill 时追加一次公共说明,指导 agent 按 base_dir 解析 skill 内的相对引用
  if (attachments.some((a) => a.kind === "prompt" && skillBaseDir(a.path))) {
    blocks.push("注：skill 内的相对路径均基于其 base_dir；被引用的脚本/文档可直接按路径读取。");
  }
  return blocks.join("\n\n");
}

// 附件块(拖入 skill/todo)并入本轮 CLI prompt 文本,而非 appendSystemPrompt:
// claude --resume / codex exec resume 只回放对话历史,不回放上一轮 system prompt——附件块若走
// append,只在拖入那一轮对 agent 可见,续轮 skill 流程整体丢失(实测第二轮 agent 已按常识自由发挥)。
// 进 prompt 文本后随 CLI 历史持久;显示层 appendUserMessage 仍存原始 text,不受影响。
// 编辑重发/分支的历史行定位按「\n\n+原文」后缀匹配该前缀形态(session-trim.ts,与 pi 的
// piEntryMatchesText 同一模式)。
export function buildTurnPromptText(text: string, attachmentPrompt: string | undefined): string {
  if (!attachmentPrompt) return text;
  return [attachmentPrompt, text].filter(Boolean).join("\n\n");
}

// 个人工作区项目清单 → system prompt 块（让 agent 知道用户有哪些本地项目及绝对路径）。
// 排除归档项目;无可用项目返回 undefined。Spotlight 默认「不使用项目」时 cwd 是 no-project
// 目录,但此块仍列出项目,便于 agent 按需进入某项目。
export function buildProjectSystemPrompt(projects: ProjectMeta[]): string | undefined {
  const active = projects.filter((p) => p.archivedAt == null);
  if (active.length === 0) return undefined;
  const lines = active.map((p) => `- ${p.name}: ${p.path}`).join("\n");
  return [
    "<personal_workspace_projects>",
    "以下是用户「个人工作区」中登记的本地项目(名称: 绝对路径)。",
    "当前会话默认不在任何项目目录下工作;如需操作某项目,请使用其绝对路径。",
    lines,
    "</personal_workspace_projects>",
  ].join("\n");
}

function realHHMM(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

// agent 报错/提示消息统一用此命名空间（uid("err")）：只作当场可见反馈，**永不落盘**——
// sanitizeForSave 在落盘/加载两侧据此剥离（同时迁移旧档里已记录的报错）。失败信息不丢，
// 改投主进程文件日志（见 appendMsg），保留可排查性。
const ERR_UID_PREFIX = "err";
function isTransientErrorMessage(m: Message): m is Extract<Message, { kind: "text" }> {
  return m.kind === "text" && typeof m.uid === "string" && m.uid.startsWith(`${ERR_UID_PREFIX}-`);
}

// ── run 注册表（runId → 流式渲染状态） ────────────────────────────────────
interface RunState {
  sessionId: string;
  agent: AgentKind; // 消息 who
  typingUid: string;
  // 持久消息流（personalChatKeys.detail）的文本折叠游标。lastKind 仍跟踪「整体到达顺序」
  // （text/tool 交替），用于判定「text 到达且上块是 tool」时对过程流收尾 agentLog。
  // logUid 已迁出到 processCursor —— 单游标不再隐式承载两条流（KTD6）。
  cursor: FoldCursor;
  // 瞬态过程流（personalProcessKeys.detail）的 agentLog 折叠游标:只持当前打开的 agentLog 块。
  processCursor: ProcessCursor;
  sawText: boolean; // 本轮是否产出过文本（result 文本兜底判断）
  buffer: string;
  gotResult: boolean;
  resultOk?: boolean;
  // 启动状态机:starting(进程启动中)→ thinking(收到 init,等首个输出)。
  phase: "starting" | "thinking";
  // 最近一次收到事件的时间,看门狗据此判定卡死。
  lastEventAt: number;
  watchdog?: ReturnType<typeof setInterval>;
  // 时间线采集：prompt 首行 / 起始时间 / 项目路径 / 写类工具触碰的文件。
  promptText?: string;
  startedAt?: number;
  cwd?: string;
  // 会话产物使用独立 resume 槽，避免普通聊天与不同产物共用 agent 上下文。
  artifactResumeKey?: string;
  // Artifact 能力会注入带 roleId 的设计子代理；刷新恢复时即使尚未重建 resume key，
  // 也必须把这些帧当作嵌套事件，避免子结果收尾父回合。
  nestedRoleEvents?: boolean;
  changedFiles?: Set<string>;
  resultExitFallback?: ReturnType<typeof setTimeout>;
  // 本轮运行模式(plan/accept-edits/full-auto):用于检测「被模式拦截的工具尝试」→ 切档提示。
  permissionMode?: PermissionMode;
  // 本轮已检测到的被拦工具(写/执行类),轮结束时据此弹切档提示。只记首个,避免重复。
  blockedTool?: { name: string; category: "edit" | "exec" | "tool" };
  // 传输通道:cli=单发 startCli（claude/codex）;pi=RPC 长驻会话。pi 的看门狗绝不杀进程。
  transport?: "cli" | "pi";
  // 本轮是否走主进程三段编排（orchestrate:start）。为 true 时取消/超时必须走 killOrchestration
  // （编排子进程注册在主进程独立 Set，cli:kill 对其无效，会留孤儿进程）。
  orchestrated?: boolean;
  // 本轮是否走圆桌多角色编排（roundtable:start）。为 true 时取消走 killRoundtable。
  // 每个角色的输出各自有独立的消息块，由 roleCursors 跟踪。
  roundtable?: boolean;
  // 本轮是否走委派（delegate）：主 agent 经 ask_<id> 工具自主委派给被 @ 的协作者。
  // 主 agent 在 running map → 取消/超时走标准 killCli（不像 roundtable 需 killRoundtable）；
  // 但子 agent 事件同样带 roleId，故渲染复用 roundtable 的 roleHeader/roleCursors 逻辑。
  delegate?: boolean;
  // 圆桌模式下各角色的文本折叠游标（roleId → FoldCursor），每角色独立累积消息。
  roleCursors?: Map<string, FoldCursor>;
  roleHeaders?: Map<string, Extract<Message, { kind: "roleHeader" }>>;
  emittedRoleHeaders?: Set<string>;
  // 当前活跃的角色 id（最近一个 init[roleId] 设定的），用于路由后续 text/tool/thinking 事件。
  activeRoleId?: string;
  // pi 思考流（reasoning）的折叠块（独立于 text/tool 游标:思考通常先于正文,累进同一块）。
  reasoningUid?: string;
  reasoningText?: string;
  // typing 活动行(TypingActivity)的进度状态:本轮已完成工具步数 / 当前工具起始时刻。
  stepCount?: number;
  toolStartedAt?: number;
}

const runs = new Map<string, RunState>();

export function runUsesNestedRoleEvents(
  run: Pick<RunState, "roundtable" | "delegate" | "artifactResumeKey" | "nestedRoleEvents">,
): boolean {
  return !!(
    run.roundtable ||
    run.delegate ||
    run.artifactResumeKey ||
    run.nestedRoleEvents
  );
}

// pi 同会话「发送在途」同步锁:覆盖 running 置位前的异步窗口（ensureChatLoaded 等 await）,
// 防并发/抖动 send 同会话造孤儿 run + 永不自杀的看门狗。beginPiRun 置 running 后即交棒释放。
const piSendStarting = new Set<string>();

// 看门狗阈值:启动阶段(一个事件都没收到)5 分钟;运行中静默 30 分钟
// (长任务——尤其 pi 开「子 agent 编排」时走本 CLI 单发看门狗路径——可能长时间执行不产生
// 事件,原 90s/300s 会把执行到一半的长任务误杀;大幅放宽,让长任务跑完,靠主进程活跃度看门狗
// 兜底回收真正卡死的进程)。二者仍须 < cli.ts 的 DEFAULT_CLI_INACTIVITY_TIMEOUT_MS(40 分钟),
// 保持「渲染端先触发友好文案、主进程只在渲染端失联时兜底」的分层不变量。
export const RUN_START_TIMEOUT_MS = 5 * 60_000;
export const RUN_STALL_TIMEOUT_MS = 30 * 60_000;
export const RESULT_EXIT_GRACE_MS = 1_000;

// 纯工具轮（本轮成功收尾但 agent 始终无任何文本输出）在中栏补的终态占位,
// 避免「问了没回」的观感（R3/KTD5/C1）。过程流里的工具步骤照常落右侧过程区,
// 中栏只补这一条结果文本。CLI 与 pi 两条分支各自判定后共用此文案。
export const PURE_TOOL_TURN_PLACEHOLDER = "✓ 已完成本轮操作。";

const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

// 解析本次 spawn 实际使用的 agent id(U7)。会话带 derivedAgentId 且该 id 仍在派生列表 → 用派生 id
//(后端 getAgentDef 按 id 解析);否则(无派生 / 派生 id 已失效,如用户删了 agents.local.json 条目)→
// 回退会话 base agent(session.agent),避免后端「未知 agent」报错(RISK-3)。
export function resolveSpawnAgentId(
  session: Pick<SessionMeta, "agent" | "derivedAgentId">,
  derivedAgents: DerivedAgentMeta[] | undefined,
): string {
  if (session.derivedAgentId && derivedAgents?.some((d) => d.id === session.derivedAgentId)) {
    return session.derivedAgentId;
  }
  return session.agent;
}

// 各 agent 归一化工具名的「写类」「执行类」集合（claude: Write/Edit/MultiEdit/NotebookEdit/Bash;
// codex: Shell;小写匹配）。用于检测「被运行模式拦截的工具尝试」:
//   plan 拦写类+执行类+任意非白名单工具;accept-edits 仅拦执行类;full-auto 不拦。
const MODE_EDIT_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
const MODE_EXEC_TOOLS = new Set(["bash", "shell"]);
// pi plan 档用 --tools 白名单(read/grep/find/ls)硬限制工具集,故「不在白名单」即「被拦」——
// 含扩展自定义工具(如记忆扩展的索引工具)。其它 agent 的 plan 走各自原生机制,不套用此白名单。
const PI_PLAN_WHITELIST = new Set(PI_PLAN_TOOL_WHITELIST.map((s) => s.toLowerCase()));
// 返回被拦类别:edit=写类(可切 accept-edits/full-auto);exec=执行类(仅 full-auto);
// tool=非白名单工具/扩展工具(仅 full-auto 能放行任意工具,accept-edits 仍按白名单/审批限制)。
export function restrictedToolForMode(
  toolName: string,
  mode: PermissionMode | undefined,
  agent?: AgentKind,
): "edit" | "exec" | "tool" | null {
  if (!mode || mode === "full-auto") return null;
  const n = toolName.toLowerCase();
  if (MODE_EXEC_TOOLS.has(n)) return "exec"; // bash/shell 在 plan 与 accept-edits 下都被拦
  if (mode === "plan") {
    if (MODE_EDIT_TOOLS.has(n)) return "edit"; // 写类仅 plan 拦
    // pi plan 档:白名单外的工具(扩展工具/其它内置写工具)一律被 --tools 拦,归 tool 类。
    if (agent === "pi" && !PI_PLAN_WHITELIST.has(n)) return "tool";
  }
  return null;
}

// 轮结束时:若本轮检测到被运行模式拦截的工具尝试**且本轮失败**,在 composer 上方挂切档提示
//（带原 prompt 供自动重发）。**必须 gate 在 turnFailed 上**:只读/工作区沙箱里很多工具尝试其实
// 成功（plan 下 ls、accept-edits 下多数命令），仅凭「尝试了写/执行工具」会误报;真正「被拦住没干成」
// 才会让这一轮失败。漏报(被拦但模型绕过仍完成)可接受,优先避免噪音。
function maybeEmitModeBlockHint(run: RunState, turnFailed: boolean): void {
  if (!turnFailed || !run.blockedTool || !run.promptText) return;
  if (!run.permissionMode || run.permissionMode === "full-auto") return;
  usePersonalStore.getState().setModeBlockHint(run.sessionId, {
    fromMode: run.permissionMode,
    category: run.blockedTool.category,
    promptText: run.promptText,
    toolName: run.blockedTool.name,
  });
}

function externalAgentUnavailableMessage(agent: Exclude<AgentKind, "pi">): string {
  return t("chat:core.externalUnavailable", { name: AGENT_NAME[agent] });
}

// 启动阶段等待超此阈值仍无任何响应 → 在 typing 文案追加可操作提示(避免用户对着干等的
// 秒数无所适从)。codex 首响应可能很慢,90s 才超时,这里更早给出「放弃/换 agent」出口提示。
export const RUN_START_HINT_MS = 30_000;

// typing 占位文案:阶段 + 等待时长(5 秒以上才显示,避免一闪而过的数字)。启动阶段久等
// 追加可操作提示(深化卡住时引导用户去详情「放弃深化」后重试或换 agent)。
export function typingText(agent: AgentKind, phase: "starting" | "thinking", waitedMs: number): string {
  const base =
    phase === "starting"
      ? t("chat:core.typing.starting", { name: AGENT_NAME[agent] })
      : t("chat:core.typing.thinking", { name: AGENT_NAME[agent] });
  const secs = Math.floor(waitedMs / 1000);
  const text = secs >= 5 ? `${base}${t("chat:core.typing.waited", { secs })}` : base;
  if (phase === "starting" && waitedMs >= RUN_START_HINT_MS) {
    return `${text}${t("chat:core.typing.startHint")}`;
  }
  return text;
}

// 工具名在「执行过程」面板与状态文案的清洗:claude 把内置 MCP 工具写成 mcp__<server>__<tool>,
// 去前缀让用户一眼看出用了哪个内置能力(文档抽取 extract_document / 浏览器 browser_*);非 MCP
// 工具(bash 等)原样。这是文档抽取等 MCP 能力的可观测性入口——工具被调用即在面板可读地呈现。
export function cleanToolName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return m ? m[1]! : name;
}

function typingToolText(agent: AgentKind, tool: string, detail?: string): string {
  tool = cleanToolName(tool);
  const name = AGENT_NAME[agent];
  return detail
    ? t("chat:core.typing.workingDetail", { name, tool, detail })
    : t("chat:core.typing.working", { name, tool });
}

function typingToolDoneText(agent: AgentKind, tool: string): string {
  return t("chat:core.typing.toolDone", { name: AGENT_NAME[agent], tool: cleanToolName(tool) });
}

function stopWatchdog(run: RunState): void {
  if (run.watchdog) {
    clearInterval(run.watchdog);
    run.watchdog = undefined;
  }
}

function stopResultExitFallback(run: RunState): void {
  if (run.resultExitFallback) {
    clearTimeout(run.resultExitFallback);
    run.resultExitFallback = undefined;
  }
}

function stopRunTimers(run: RunState): void {
  stopWatchdog(run);
  stopResultExitFallback(run);
}

// typing 是瞬态消息(sanitizeForSave 会丢弃),只改缓存不调度落盘,避免每秒空写。
// 纯文本更新同时清 activity:走到这条路径(看门狗滚动等待、纯工具轮终态占位、CLI 分支)都意味着
// 回到「非结构化」状态,残留 activity 会让渲染层继续显示过期的工具/思考行。
function updateTypingMsg(qc: QueryClient, sessionId: string, typingUid: string, text: string): void {
  qc.setQueryData<Message[]>(personalChatKeys.detail(sessionId), (prev) =>
    (prev ?? []).map((m) => (m.uid === typingUid && m.kind === "typing" ? { ...m, text, activity: undefined } : m)),
  );
}

// typing 活动行的结构化更新:一次 setQueryData 同写 text(aria/回退)与 activity(渲染层排版)。
// 与 updateTypingMsg 同为瞬态只写缓存,不调度落盘。
function setTypingActivity(
  qc: QueryClient,
  sessionId: string,
  typingUid: string,
  text: string,
  activity: TypingActivity,
): void {
  qc.setQueryData<Message[]>(personalChatKeys.detail(sessionId), (prev) =>
    (prev ?? []).map((m) => (m.uid === typingUid && m.kind === "typing" ? { ...m, text, activity } : m)),
  );
}

// thinking 尾部片段:取最后 2 个非空行压平为单行,再截尾到 140 字 —— 活动行只展示「正在想什么」
// 的最新一瞥,完整思考流在执行过程面板里。
export function thinkingSnippet(full: string): string {
  const lines = full
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-2).join(" ").replace(/\s+/g, " ");
  return tail.length > 140 ? tail.slice(-140) : tail;
}

export function sessionResumeId(session: SessionMeta): string | undefined {
  return session.agentSessionIds?.[session.agent] ?? (session.agent === "claude" ? session.claudeSessionId : undefined);
}

export function artifactResumeKey(
  session: SessionMeta,
  artifact: ConversationArtifactRef,
): string {
  return [
    artifact.workspaceRoot,
    artifact.documentId,
    session.derivedAgentId ?? session.agent,
    session.providerId ?? "",
    session.model ?? "",
  ].join("\u0000");
}

export function agentSessionPatch(session: SessionMeta, agent: AgentKind, id: string): Partial<SessionMeta> {
  const agentSessionIds = { ...session.agentSessionIds, [agent]: id };
  return agent === "claude" ? { agentSessionIds, claudeSessionId: id } : { agentSessionIds };
}

export function clearAgentSessionPatch(session: SessionMeta, agent: AgentKind): Partial<SessionMeta> {
  const agentSessionIds = { ...session.agentSessionIds };
  delete agentSessionIds[agent];
  return agent === "claude" ? { agentSessionIds, claudeSessionId: undefined } : { agentSessionIds };
}

export function clearArtifactSessionPatch(
  session: SessionMeta,
  key: string,
): Partial<SessionMeta> {
  return {
    artifactSessionIds: Object.fromEntries(
      Object.entries(session.artifactSessionIds ?? {}).filter(([candidate]) => candidate !== key),
    ),
  };
}

export function isMissingAgentSessionError(error?: string): boolean {
  return /thread\/resume failed|no rollout found for thread id/i.test(error ?? "");
}

export interface PersonalChatSlice {
  allMessages: Message[];
  hiddenMessages: Message[];
  visibleMessages: Message[];
  messages: Message[];
  hiddenCount: number;
  hiddenHistory?: HiddenHistoryMeta;
}

function clampIndex(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.trunc(n), max));
}

export function splitPersonalMessages(messages: Message[], hiddenHistory?: HiddenHistoryMeta): PersonalChatSlice {
  let hiddenEnd = 0;
  if (hiddenHistory) {
    const throughIndex = hiddenHistory.throughUid
      ? messages.findIndex((m) => m.uid === hiddenHistory.throughUid)
      : -1;
    hiddenEnd = throughIndex >= 0 ? throughIndex + 1 : clampIndex(hiddenHistory.count, messages.length);
  }
  const hiddenMessages = hiddenEnd > 0 ? messages.slice(0, hiddenEnd) : [];
  const visibleMessages = hiddenEnd > 0 ? messages.slice(hiddenEnd) : messages;
  return {
    allMessages: messages,
    hiddenMessages,
    visibleMessages,
    messages: visibleMessages,
    hiddenCount: hiddenMessages.length,
    hiddenHistory,
  };
}

// 渲染窗口:对消息集取尾部 limit 条,返回切片 + 仍被折叠的更早条数。纯函数,无副作用。
// 配合 useRenderWindow,让历史会话默认只渲染最新 limit 条(其余「展开更多」逐步加载),
// 把首屏渲染量从 O(全部) 降到 O(limit),规避长会话一次性全量渲染导致的卡顿/闪退。
export function windowTailMessages(
  source: Message[],
  limit: number,
): { rendered: Message[]; collapsedEarlier: number } {
  const start = Math.min(source.length, Math.max(0, source.length - limit));
  return { rendered: start > 0 ? source.slice(start) : source, collapsedEarlier: start };
}

// 落盘会被 sanitizeForSave 丢弃的瞬态/过程消息（typing/reasoning/agentLog/报错提示）——隐藏游标的
// count 必须以「落盘后存活」的消息为基准计数,否则下次加载（这些已剥离、数组变短）后按旧 count
// 切分会偏移可见/隐藏边界（R11 的 count 兜底路径）。
function survivesSanitize(m: Message): boolean {
  return (
    m.kind !== "typing" && m.kind !== "reasoning" && m.kind !== "agentLog" && !isTransientErrorMessage(m)
  );
}

export function createHiddenHistory(messages: Message[], now = Date.now()): HiddenHistoryMeta {
  const last = messages[messages.length - 1];
  // count 以「落盘后存活」的消息计:与重启后从磁盘加载的（已剥离 agentLog/reasoning）数组同空间,
  // 保证 throughUid 失配时 count 兜底切分仍落在用户语义一致的边界。
  const count = messages.reduce((n, m) => (survivesSanitize(m) ? n + 1 : n), 0);
  const hiddenHistory: HiddenHistoryMeta = { count, hiddenAt: now };
  if (last?.uid) hiddenHistory.throughUid = last.uid;
  return hiddenHistory;
}

// 旧档迁移:把「记录于剥离前数组空间」的 hiddenHistory.count 回算到「剥离后数组空间」,
// 保证清洗掉 agentLog 后按 count 兜底切分的隐藏/可见边界对用户语义不变（R11，count 兜底路径）。
// 仅在缺 throughUid（throughUid 命中路径本就位置无关、无损）时需要;throughUid 在则原样返回。
export function adjustHiddenHistoryForSanitize(
  original: Message[],
  hiddenHistory?: HiddenHistoryMeta,
): HiddenHistoryMeta | undefined {
  if (!hiddenHistory) return hiddenHistory;
  if (hiddenHistory.throughUid && original.some((m) => m.uid === hiddenHistory.throughUid)) {
    return hiddenHistory; // throughUid 命中:位置无关,无需回算。
  }
  // count 落在剥离前数组的 [0, count) 区间;回算为该区间内「落盘后存活」的条数。
  const boundary = clampIndex(hiddenHistory.count, original.length);
  let adjusted = 0;
  for (let i = 0; i < boundary; i++) {
    if (survivesSanitize(original[i]!)) adjusted += 1;
  }
  return { ...hiddenHistory, count: adjusted };
}

// 加载某会话原始（未剥离）历史时,若其 hiddenHistory.count 因 agentLog 剥离会偏移则回算并写回 store。
// 幂等:throughUid 命中、或原数组本就无可剥离条目时,adjusted === 原 count,不触发 updateSession。
function maybeMigrateHiddenHistory(sessionId: string, original: Message[]): void {
  const store = usePersonalStore.getState();
  const session = store.sessions.find((x) => x.id === sessionId);
  const hh = session?.hiddenHistory;
  if (!hh) return;
  const adjusted = adjustHiddenHistoryForSanitize(original, hh);
  if (adjusted && adjusted.count !== hh.count) {
    store.updateSession(sessionId, { hiddenHistory: adjusted });
  }
}

// ── 消息持久化（节流落盘） ────────────────────────────────────────────────
const SAVE_THROTTLE_MS = 600;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 过程流延迟清理 timer 句柄:**独立于 RunState**（finalizeRun 已 runs.delete,挂 run 上则清理出口
// 无从 clearTimeout，KTD4/KTD8）。仿 saveTimers 的独立 Map 范式。当前实现里 finalizeRun 成功路径
// 选择「保留至切走/下一轮」而非倒计时销毁,故默认不排 timer;但保留此 Map + clearTimeout 出口,
// 杜绝「会话已删、游离 timer 触发把数据写回已删会话 process key」的复活（任一立即清空出口先
// clearTimeout 再清 process key）。
const processCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 落盘前清理瞬态(与 survivesSanitize 同一判定,复用以杜绝两者漂移):
//  - typing 丢弃(瞬态占位);
//  - reasoning 丢弃——模型思考只显示本次,不作为长期记录(也避免 pi 长思考流撑大 chat JSON);
//  - agentLog 丢弃——agent 中间执行过程（工具步骤）改走右侧瞬态过程流、**永不落盘**;
//  - 报错/提示（uid("err")）丢弃——agent 报错只作当场可见反馈,不入会话记录(避免污染),失败信息
//    改投主进程日志(见 appendMsg)。
// 此过滤既保证新会话过程/报错不入档,也作为「破坏性旧档迁移」:旧档被加载后任意一次 flushChat 即把
// chat JSON 原地重写为不含 agentLog/报错的版本（无 .bak、不可逆，KTD2）。
// 加载历史时同样过此函数,故旧数据里遗留的 reasoning/agentLog/报错会被顺带清掉。
// ⚠️ todoList **刻意保留**(任务清单快照落盘,重开会话可回顾),不要把它加进剥离名单;
// 落盘时把 active 归一为 false——快照语义,避免历史加载后 in_progress 项残留转圈态。
export function sanitizeForSave(messages: Message[]): Message[] {
  return messages
    .filter(survivesSanitize)
    .map((m) => (m.kind === "todoList" && m.active ? { ...m, active: false } : m));
}

export function flushChat(qc: QueryClient, sessionId: string): void {
  const timer = saveTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(sessionId);
  }
  const messages = qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId));
  if (!bridgeRef || !messages) return;
  const branchGroups = qc.getQueryData<BranchGroup[]>(personalBranchKeys.detail(sessionId));
  if (branchGroups === undefined) {
    // 分支态尚未加载(旧流程可能未经 ensureChatLoaded 直接落盘):先补载再落盘,
    // 避免把磁盘上 v2 档的分支按「无分支」覆盖丢失。补载失败(旧壳无 loadChat 等)按无分支
    // 兜底写入缓存,保证递归第二趟必然走到真正落盘、不死循环。
    const bridge = bridgeRef;
    void ensureBranchesLoaded(qc, bridge, sessionId)
      .catch(() => qc.setQueryData<BranchGroup[]>(personalBranchKeys.detail(sessionId), []))
      .then(() => flushChat(qc, sessionId));
    return;
  }
  // 归档分支的 tail 与主消息流同标准清理;有分支写 v2、无分支仍写 v1 裸数组(主进程 chat:save 打包)。
  const cleanedGroups = branchGroups.length ? sanitizeBranchGroups(branchGroups, sanitizeForSave) : undefined;
  void bridgeRef.saveChat(sessionId, sanitizeForSave(messages), cleanedGroups);
}

function scheduleChatSave(qc: QueryClient, sessionId: string): void {
  if (!bridgeRef) return;
  const prev = saveTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  saveTimers.set(
    sessionId,
    setTimeout(() => flushChat(qc, sessionId), SAVE_THROTTLE_MS),
  );
}

function setMessages(qc: QueryClient, sessionId: string, updater: (prev: Message[]) => Message[]): void {
  qc.setQueryData<Message[]>(personalChatKeys.detail(sessionId), (prev) => updater(prev ?? []));
  scheduleChatSave(qc, sessionId);
}

// 免落盘 setter:只写瞬态过程流 query key,**绝不**调 scheduleChatSave/任何 bridge.save*。
// 过程流（tool→agentLog、reasoning）经此落地,与硬绑 personalChatKeys.detail + scheduleChatSave
// 的 setMessages 彻底分离——这是「过程永不落盘」的结构保证（KTD1/R10）。
function setProcessMessages(qc: QueryClient, sessionId: string, updater: (prev: Message[]) => Message[]): void {
  qc.setQueryData<Message[]>(personalProcessKeys.detail(sessionId), (prev) => updater(prev ?? []));
}

// 运行事件流单段正文上限:text/thinking 增量合并段超过该长度即截断(防超长回复撑爆内存)。
const MAX_RUN_SEGMENT = 8_000;

// 追加一条原始运行事件到瞬态运行事件流(免落盘,仿 setProcessMessages):超过 MAX_RUN_EVENTS
// 丢最旧。text/thinking 是逐 token 增量,逐条记会挤掉工具事件——合并进「段」:与末条同
// runId 同类型时原地追加 delta(截断上限内),异类/新轮才另起一条,保留 思考→工具→回复 的时间线。
function recordRunEvent(qc: QueryClient, sessionId: string, runId: string, ev: CliStreamEvent): void {
  qc.setQueryData<RunEvent[]>(personalRunEventsKeys.detail(sessionId), (prev) => {
    const arr = prev ?? [];
    if (ev.type === "text" || ev.type === "thinking") {
      if (!ev.delta) return arr; // 空增量(如编排段边界信号)不产段
      const last = arr[arr.length - 1];
      if (last && last.runId === runId && last.ev.type === ev.type) {
        // 命中同类型打开段:原地合并(替换末条,保持数组长度,不触发环形裁剪)。
        const prevDelta = (last.ev as { delta: string }).delta;
        const combined =
          prevDelta.length >= MAX_RUN_SEGMENT
            ? prevDelta
            : (prevDelta + ev.delta).length > MAX_RUN_SEGMENT
              ? (prevDelta + ev.delta).slice(0, MAX_RUN_SEGMENT) + "…"
              : prevDelta + ev.delta;
        const next = arr.slice();
        next[next.length - 1] = { ...last, ts: Date.now(), ev: { type: ev.type, delta: combined } };
        return next;
      }
      const opened = [...arr, { runId, ts: Date.now(), ev: { type: ev.type, delta: ev.delta } }];
      return opened.length > MAX_RUN_EVENTS ? opened.slice(opened.length - MAX_RUN_EVENTS) : opened;
    }
    const next = [...arr, { runId, ts: Date.now(), ev }];
    return next.length > MAX_RUN_EVENTS ? next.slice(next.length - MAX_RUN_EVENTS) : next;
  });
}

// 立即清空某会话的运行事件流(会话删除/editResend 截断出口用)。运行事件跨轮累积,故普通
// 「下一轮开始」不清(与 clearProcess 生命周期不同);只在历史被重写/会话消亡时整条移除。
export function clearRunEvents(qc: QueryClient, sessionId: string): void {
  qc.removeQueries({ queryKey: personalRunEventsKeys.detail(sessionId), exact: true });
}

// pi RPC 事件 → 运行事件流记录:转成与 claude/codex 同形态的 CliStreamEvent,落同一通道,
// 详情弹层无需区分 agent。text/reasoning 增量转 text/thinking(recordRunEvent 内合并成段);
// 状态类事件(queue/compaction 等)不记。
// result:失败轮的失败已由 error 事件记录(ok:false),此处跳过避免重复终态行。
function piEventToRunRecord(ev: PiSessionEvent, resultOk: boolean): CliStreamEvent | null {
  switch (ev.type) {
    case "text":
      return { type: "text", delta: ev.delta };
    case "reasoning":
      return { type: "thinking", delta: ev.delta };
    case "tool-start":
      return { type: "tool", name: ev.name, detail: ev.detail, input: ev.input, phase: "start", toolCallId: ev.toolCallId };
    case "tool-end":
      return { type: "tool", name: ev.name, phase: "end", toolCallId: ev.toolCallId, output: ev.output, isError: ev.isError };
    case "todo":
      return { type: "todo", todos: ev.todos };
    case "error":
      return { type: "result", ok: false, error: ev.error };
    case "result":
      if (ev.willRetry) return null;
      return resultOk ? { type: "result", ok: true } : null;
    default:
      return null;
  }
}

// 立即清空某会话的过程流（异常终态/会话删除/editResend 截断出口用，KTD8）。先取消该 session 任何
// 游离的延迟清理 timer（杜绝 timer 复活已删/已清会话的 process key），再整条移除 process query
// （removeQueries 而非写空数组:彻底回收,不留 inactive 空缓存;活跃 observer 会读回 EMPTY_MESSAGES）。
export function clearProcess(qc: QueryClient, sessionId: string): void {
  const timer = processCleanupTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    processCleanupTimers.delete(sessionId);
  }
  qc.removeQueries({ queryKey: personalProcessKeys.detail(sessionId), exact: true });
}

// finalizeRun 成功路径:把过程流里仍 active 的 agentLog/reasoning 收尾打勾（completed），**保留不清**。
// 大多数情况收尾已在 result/turn-end 分支由 finalizeProcessAgentLog/finalizeRunReasoning 完成,
// 此处兜底任何残留 active 块（如无 result 直接 exit 收尾的恢复型 run），使收起入口里步骤呈完成态。
function finalizeProcessForRetain(qc: QueryClient, sessionId: string): void {
  const prev = qc.getQueryData<Message[]>(personalProcessKeys.detail(sessionId));
  if (!prev || prev.length === 0) return; // 无过程（纯文本轮）→ 不创建空缓存。
  setProcessMessages(qc, sessionId, (cur) =>
    cur.map((m) => {
      if (m.kind === "agentLog" && m.active) {
        return {
          ...m,
          active: false,
          completed: true,
          title: "Agent 执行完成",
          items: m.items.map((it) => (it.ic === "running" ? { ...it, ic: "check" as const } : it)),
        };
      }
      if (m.kind === "reasoning" && m.active) {
        return { ...m, active: false, completed: true };
      }
      return m;
    }),
  );
}

function appendMsg(qc: QueryClient, sessionId: string, msg: Message): void {
  setMessages(qc, sessionId, (prev) => [...prev, msg]);
  // agent 报错/提示不落盘（sanitizeForSave 剥离），但失败信息写主进程文件日志（脱敏由主进程负责），
  // 保留可排查性。每条报错只 append 一次 → 只记一行。fire-and-forget，web 端 bridgeRef 为 null 即跳过。
  if (isTransientErrorMessage(msg)) {
    const detail = typeof msg.text === "string" ? msg.text : "";
    void bridgeRef?.logMessage?.("error", `[personal:${msg.who}] session=${sessionId} ${detail}`);
  }
}

function dropMsg(qc: QueryClient, sessionId: string, msgUid: string): void {
  setMessages(qc, sessionId, (prev) => prev.filter((m) => m.uid !== msgUid));
}

// 清掉某 session 的全部 typing 占位 + 把仍在运行的 agentLog/reasoning 收尾。
function clearTransient(qc: QueryClient, sessionId: string): void {
  setMessages(qc, sessionId, (prev) =>
    prev
      .filter((m) => m.kind !== "typing")
      .map((m) => {
        if (m.kind === "agentLog" && m.active) {
          return { ...m, active: false, completed: true, title: t("chat:core.agentLogDone") };
        }
        if (m.kind === "reasoning" && m.active) {
          return { ...m, active: false, completed: true };
        }
        // 崩溃/兜底出口:todoList 卡停转圈(finalizeRun 主路径按 runId 精确收尾,这里兜全量)。
        if (m.kind === "todoList" && m.active) {
          return { ...m, active: false };
        }
        return m;
      }),
  );
}

// ── 流式块折叠（按到达顺序的尾部折叠） ─────────────────────────────────────
// text 块与 agentLog 块按事件到达顺序交替成多个独立块：同类事件并入当前打开块,
// 异类则收尾旧块、开新块（语义对齐 open-design 的 buildBlocks——只与紧邻上一块同类合并）。
// 连续工具仍并入同一张 agentLog 卡片;连续文本增量仍并入同一个 text 块。
export interface FoldCursor {
  lastKind?: "text" | "tool"; // 当前打开块的类型
  textUid?: string; // 当前打开的 text 块 uid（lastKind==="text" 时有效）
  logUid?: string; // 当前打开的 agentLog 块 uid（lastKind==="tool" 时有效）
  segmentText: string; // 当前打开 text 块已累加文本
}

export interface FoldCtx {
  agent: AgentKind;
  time: string;
  newUid: (prefix: string) => string;
  textMeta?: Pick<
    Extract<Message, { kind: "text" }>,
    "roleId" | "roleLabel" | "roleColor"
  >;
}

export function emptyFoldCursor(): FoldCursor {
  return { segmentText: "" };
}

// 过程流（agentLog）折叠游标。只持当前打开的 agentLog 块。复用 FoldCursor 的 tool 分支折叠语义:
// lastKind 在过程流里只会是 "tool"（text 不入过程流）;logUid 指向当前打开的 agentLog。
// text 到达跨流收尾后由调用方重置为空（lastKind/logUid 清空），下一个 tool 开新卡片。
export type ProcessCursor = FoldCursor;

export function emptyProcessCursor(): ProcessCursor {
  return { segmentText: "" };
}

// 收尾一个 agentLog 块:全部 items 翻 check 并标记完成（停 spinner）。
export function finalizeAgentLog(messages: Message[], logUid: string): Message[] {
  return messages.map((m) =>
    m.uid === logUid && m.kind === "agentLog"
      ? {
          ...m,
          active: false,
          completed: true,
          title: t("chat:core.agentLogDone"),
          items: m.items.map((it) => ({ ...it, ic: "check" as const })),
        }
      : m,
  );
}

function finalizeReasoning(messages: Message[], reasoningUid?: string): Message[] {
  return messages.map((m) => {
    if (m.kind !== "reasoning") return m;
    if (reasoningUid ? m.uid !== reasoningUid : !m.active) return m;
    return { ...m, active: false, completed: true };
  });
}

// 折叠单个 text/tool 事件到消息数组尾部,返回新数组 + 新游标（纯函数,便于单测）。
// 仅处理 text / tool;init/result/error 由 handleCliEvent 处理。
export function foldCliEvent(
  messages: Message[],
  ev: CliStreamEvent,
  cursor: FoldCursor,
  ctx: FoldCtx,
): { messages: Message[]; cursor: FoldCursor } {
  if (ev.type === "text") {
    // 续写当前 text 块。
    if (cursor.lastKind === "text" && cursor.textUid) {
      const segmentText = cursor.segmentText + ev.delta;
      const next = messages.map((m) =>
        m.uid === cursor.textUid && m.kind === "text" ? { ...m, text: segmentText } : m,
      );
      return { messages: next, cursor: { ...cursor, segmentText } };
    }
    // 异类切换:开新 text 块。**不在此处收尾 agentLog**——B1 下 agentLog 在独立的过程流数组里,
    // 这里的 messages 不含该 logUid,旧的同数组收尾会成为静默 no-op（KTD6）。跨流收尾由调用方
    // （handleCliEvent/handlePiEvent）对 process key 单独执行。
    const textUid = ctx.newUid("at");
    const textMsg: Message = {
      kind: "text",
      who: ctx.agent,
      time: ctx.time,
      text: ev.delta,
      uid: textUid,
      ...ctx.textMeta,
    };
    return {
      messages: [...messages, textMsg],
      cursor: { lastKind: "text", textUid, logUid: undefined, segmentText: ev.delta },
    };
  }

  if (ev.type === "tool") {
    const displayName = cleanToolName(ev.name);
    const itemText = ev.detail ? `${displayName} · ${ev.detail}` : displayName;
    // 并入当前 agentLog 卡片:既有 items 翻 check,追加新 running 项。
    if (cursor.lastKind === "tool" && cursor.logUid) {
      const next = messages.map((m) =>
        m.uid === cursor.logUid && m.kind === "agentLog"
          ? {
              ...m,
              items: [
                ...m.items.map((it) => ({ ...it, ic: "check" as const })),
                { ic: "running" as const, text: itemText },
              ],
            }
          : m,
      );
      return { messages: next, cursor };
    }
    // 异类切换（或起手）:开新 agentLog 卡片。前一个 text 块无需收尾。
    const logUid = ctx.newUid("log");
    const logMsg: Message = {
      kind: "agentLog",
      who: ctx.agent,
      time: ctx.time,
      title: t("chat:core.agentLogExecuting"),
      active: true,
      uid: logUid,
      items: [{ ic: "running", text: itemText }],
    };
    return {
      messages: [...messages, logMsg],
      cursor: { lastKind: "tool", logUid, textUid: undefined, segmentText: "" },
    };
  }

  return { messages, cursor };
}

// 把一个 text 事件折叠进**持久消息流**,并回写 run.cursor。tool 不再走这条（改走过程流）。
// run.cursor.lastKind 仍跟踪整体到达顺序:tool 事件会把它翻到 "tool"（见 markCursorTool）,
// 故下一个 text 在 foldCliEvent 里被判为异类切换、开新文本块（语义与原交错折叠一致）。
function foldTextIntoCache(
  qc: QueryClient,
  sessionId: string,
  run: RunState,
  delta: string,
  textMeta?: FoldCtx["textMeta"],
): void {
  let nextCursor = run.cursor;
  setMessages(qc, sessionId, (prev) => {
    const folded = foldCliEvent(prev, { type: "text", delta }, run.cursor, {
      agent: run.agent,
      time: realHHMM(),
      newUid: uid,
      textMeta,
    });
    nextCursor = folded.cursor;
    return folded.messages;
  });
  run.cursor = nextCursor;
}

// 把一个 tool 事件折叠进**瞬态过程流**（agentLog 卡片）,回写 run.processCursor。复用 foldCliEvent
// 的 tool 折叠分支（连续 tool 并入同卡、起手开新卡）。同时把消息流游标翻到 "tool",保证下一个
// text 在持久流里开新块。
function foldToolIntoProcess(qc: QueryClient, sessionId: string, run: RunState, ev: CliStreamEvent): void {
  let nextCursor = run.processCursor;
  setProcessMessages(qc, sessionId, (prev) => {
    const folded = foldCliEvent(prev, ev, run.processCursor, { agent: run.agent, time: realHHMM(), newUid: uid });
    nextCursor = folded.cursor;
    return folded.messages;
  });
  run.processCursor = nextCursor;
  // 持久流游标:工具打断文本——下一个 text 开新块（textUid 清空、lastKind 翻 tool）。
  run.cursor = { ...run.cursor, lastKind: "tool", textUid: undefined, segmentText: "" };
}

// todos 整表浅比较:text+status 序列全同视为无变化(吸收 codex item.updated 的重复帧,
// 避免空刷 setMessages 触发重渲染与落盘节流)。
function todosEqual(a: TodoListItem[], b: TodoListItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.text !== b[i]!.text || a[i]!.status !== b[i]!.status) return false;
  }
  return true;
}

// 任务清单折叠:todo 事件(整表快照)进**持久消息流**。同一 runId 的卡片原地覆盖 todos
//(agent 反复调用是在更新同一份清单),未命中则 append 新卡(新 run 开新卡)。区别于
// agentLog(瞬态过程流):todoList 落盘(sanitizeForSave 保留),重开会话可回顾任务拆解。
function foldTodoIntoCache(qc: QueryClient, sessionId: string, run: RunState, runId: string, todos: TodoListItem[]): void {
  setMessages(qc, sessionId, (prev) => {
    const idx = prev.findIndex((m) => m.kind === "todoList" && m.runId === runId);
    if (idx >= 0) {
      const cur = prev[idx] as Extract<Message, { kind: "todoList" }>;
      if (todosEqual(cur.todos, todos) && cur.active) return prev;
      const next = prev.slice();
      next[idx] = { ...cur, todos, active: true };
      return next;
    }
    return [
      ...prev,
      { kind: "todoList", who: run.agent, time: realHHMM(), runId, todos, active: true, uid: uid("todo") },
    ];
  });
  // 游标打断(关键):清单卡落到数组尾部后,后续 text 必须开新块——否则 foldCliEvent 会按 textUid
  // 原地续写卡片**之前**的旧 text 块,视觉上正文长不到卡片之后。与 foldToolIntoProcess 同款处理。
  run.cursor = { ...run.cursor, lastKind: "tool", textUid: undefined, segmentText: "" };
}

// 跨流收尾:text 到达且过程流当前有打开的 agentLog 时,对 **process key** 收尾该卡片并清 logUid
//（KTD6——纯函数只做同流折叠,跨流收尾在调用方）。返回是否执行了收尾。
function finalizeProcessAgentLog(qc: QueryClient, sessionId: string, run: RunState): void {
  if (run.processCursor.lastKind !== "tool" || !run.processCursor.logUid) return;
  const logUid = run.processCursor.logUid;
  setProcessMessages(qc, sessionId, (prev) => finalizeAgentLog(prev, logUid));
  run.processCursor = emptyProcessCursor();
}

function clearRunSessionId(run: RunState): void {
  const sess = usePersonalStore.getState().sessions.find((item) => item.id === run.sessionId);
  if (!sess) return;
  const patch = run.artifactResumeKey
    ? clearArtifactSessionPatch(sess, run.artifactResumeKey)
    : clearAgentSessionPatch(sess, run.agent);
  usePersonalStore.getState().updateSession(run.sessionId, patch);
}

function ensureRoleHeader(
  qc: QueryClient,
  sessionId: string,
  run: RunState,
  roleId: string,
): Extract<Message, { kind: "roleHeader" }> {
  if (!run.roleHeaders) run.roleHeaders = new Map();
  let header = run.roleHeaders.get(roleId);
  if (!header) {
    const roleConfig = usePersonalStore.getState().roles.find((role) => role.id === roleId);
    header = {
      kind: "roleHeader",
      who: run.agent,
      time: realHHMM(),
      uid: uid("rh"),
      roleId,
      roleLabel: roleConfig?.label ?? roleId,
      roleColor: roleConfig?.color,
      roleAvatar: roleConfig?.avatar,
    };
    run.roleHeaders.set(roleId, header);
  }
  if (!run.emittedRoleHeaders) run.emittedRoleHeaders = new Set();
  if (!run.emittedRoleHeaders.has(roleId)) {
    appendMsg(qc, sessionId, header);
    run.emittedRoleHeaders.add(roleId);
  }
  return header;
}

function handleCliEvent(qc: QueryClient, runId: string, ev: CliStreamEvent, sessionIdHint?: string): void {
  // 设计工作台(design:)与写作工作台(writing:/writing-)的 run 由各自的 run-manager
  // 独立消费,绝不能进入下面的 recovered-run 重建路径——否则会以 sessionIdHint 伪造
  // 个人会话运行态(phantom run),污染会话列表与过程流。writing- 一并挡是防御:
  // 写作 runId 恒为 writing: 前缀,但 sessionId 用 writing- 前缀,守卫两者杜绝任何漏网。
  if (runId.startsWith("design:") || runId.startsWith("slides:") || runId.startsWith("writing:") || runId.startsWith("writing-"))
    return;
  let run = runs.get(runId);
  if (!run) {
    // renderer 被 HMR/刷新重载,内存注册表丢失 —— 用主进程回显的 sessionId 重建,
    // 让仍在跑的流继续渲染,而不是永远卡在「运行中」。
    if (!sessionIdHint) return;
    const sess = usePersonalStore.getState().sessions.find((x) => x.id === sessionIdHint);
    const artifactMatch = /^artifact:(design|slides):([^:]+):/.exec(runId);
    const recoveredArtifact = artifactMatch && sess
      ? [sess.activeArtifact, ...(sess.artifacts ?? [])]
          .filter((artifact): artifact is ConversationArtifactRef => !!artifact)
          .find(
            (artifact) =>
              artifact.kind === artifactMatch[1] &&
              artifact.documentId === artifactMatch[2],
          )
      : undefined;
    run = {
      sessionId: sessionIdHint,
      agent: sess?.agent ?? "claude",
      typingUid: "recovered-no-typing",
      cursor: emptyFoldCursor(),
      processCursor: emptyProcessCursor(),
      sawText: false,
      buffer: "",
      gotResult: false,
      phase: "thinking",
      lastEventAt: Date.now(),
      artifactResumeKey:
        sess && recoveredArtifact
          ? artifactResumeKey(sess, recoveredArtifact)
          : undefined,
      nestedRoleEvents: !!artifactMatch,
    };
    runs.set(runId, run);
    usePersonalStore.getState().setRunning(sessionIdHint, runId);
  }
  const { sessionId } = run;
  run.lastEventAt = Date.now();
  // 运行事件流采集(详情弹层数据源):所有事件类型统一在此入口记录一次(text/thinking 在内部跳过)。
  recordRunEvent(qc, sessionId, runId, ev);

  if (ev.type === "init") {
    // 圆桌编排：roleId 标注角色起始，在聊天流插入 roleHeader 分隔符，初始化该角色折叠游标。
    if ("roleId" in ev && ev.roleId && runUsesNestedRoleEvents(run)) {
      run.phase = "thinking";
      run.activeRoleId = ev.roleId;
      if (!run.roleCursors) run.roleCursors = new Map();
      if (!run.roleCursors.has(ev.roleId)) {
        run.roleCursors.set(ev.roleId, emptyFoldCursor());
      }
      // 收尾上一个角色仍 active 的过程块
      finalizeProcessAgentLog(qc, sessionId, run);
      finalizeRunReasoning(qc, run);
      // 插入 roleHeader（角色分隔标题）
      const roleLabel = ev.stageLabel ?? ev.roleId;
      const roles = usePersonalStore.getState().roles;
      const roleConfig = roles.find((r) => r.id === ev.roleId);
      if (!run.roleHeaders) run.roleHeaders = new Map();
      run.roleHeaders.set(ev.roleId, {
        kind: "roleHeader",
        who: run.agent,
        time: realHHMM(),
        uid: uid("rh"),
        roleId: ev.roleId,
        roleLabel,
        roleColor: roleConfig?.color,
        roleAvatar: roleConfig?.avatar,
      });
      updateTypingMsg(qc, sessionId, run.typingUid, `${roleLabel} 思考中…`);
      return;
    }
    // 进程已起来:启动中 → 思考中。
    run.phase = "thinking";
    updateTypingMsg(qc, sessionId, run.typingUid, typingText(run.agent, "thinking", 0));
    // 编排子段（ev.stage 存在）与委派轮次的 init 携带的是一次性子会话 thread_id，绝不能写进主会话
    // resume id：否则下一轮普通对话会 resume 到该一次性上下文，丢失主对话历史。它们均 fresh spawn
    // 不 resume，故只推进 phase/typing，不落 session patch。
    if (!ev.stage && !run.delegate) {
      const sess = usePersonalStore.getState().sessions.find((x) => x.id === sessionId);
      if (sess) {
        const patch = run.artifactResumeKey
          ? {
              artifactSessionIds: {
                ...sess.artifactSessionIds,
                [run.artifactResumeKey]: ev.sessionId,
              },
            }
          : agentSessionPatch(sess, run.agent, ev.sessionId);
        usePersonalStore.getState().updateSession(sessionId, patch);
      }
    }
    return;
  }

  if (ev.type === "retry") {
    // 主进程安全重试(U7):上一 attempt 在产出任何可见内容前瞬态失败、即将重试。刷新「思考中」占位,
    // 避免 typing 看起来卡死;重试发生在无可见输出时,故不动 buffer/折叠状态。
    run.phase = "thinking";
    updateTypingMsg(qc, sessionId, run.typingUid, typingText(run.agent, "thinking", 0));
    return;
  }

  if (ev.type === "usage") {
    // 流式 usage/cost(U3):M1 仅采集(主进程已 trace 记录),UI 展示延后到后续里程碑;持久权威在
    // usage.ts 磁盘路径(KTD3)。此处显式忽略以表意「按设计暂不展示」,而非遗漏。
    return;
  }

  if (ev.type === "turn") {
    // 轮边界(R2):仅 trace,不渲染。
    return;
  }
  if (ev.type === "thinking") {
    // 三段编排段边界信号:orchestrate.ts sendStageStart 发的 { delta:"", stage, stageLabel }。
    // 在过程流插入一个段标题块,让用户一眼看出当前在「意图理解/子 agent 执行/整理回复」哪一段;
    // 同时收尾上一段仍 active 的 reasoning/agentLog(强制下段开新块)。不进 foldReasoning——空 delta
    // 会创建空 reasoning 块。普通 thinking 不带 stage/stageLabel,走下方原逻辑。
    if (ev.stage && ev.stageLabel) {
      usePetStore.getState().set("thinking");
      // 先收尾上一段仍 active 的 reasoning/agentLog（强制下段开新块、及时打勾）。
      finalizeProcessAgentLog(qc, sessionId, run);
      finalizeRunReasoning(qc, run);
      // refine（整理回复）段的输出直接进聊天正文，过程面板里其后没有任何内容——插段标题会悬空成
      // 「假进行中」（与已完成 badge 矛盾，见用户反馈）。故只给 intent/subagent 两段（过程留在面板）
      // 插标题；refine 段仅做上面的收尾，不插标题。
      if (ev.stage === "refine") return;
      const stage = ev.stage;
      const label = ev.stageLabel;
      setProcessMessages(qc, sessionId, (prev) => [
        ...prev,
        { kind: "stageTitle", who: run.agent, time: realHHMM(), stage, label, uid: uid("stg") },
      ]);
      return;
    }
    // 思考/执行过程(codex reasoning + commentary、claude thinking)落**右侧运行过程流**(不进对话回复、
    // 不落盘),与 pi 的 reasoning 折叠同一通道。用户要求:过程在右侧,回复只留 final answer。
    // 阶段切换收尾:收到思考前先收尾打开的工具卡,使新思考块按时序追加到工具之后(think→tool→think
    // 交错时不再把后段思考并回前一个思考块,保留完整的「思考→工具→再思考→再工具」时间线)。
    usePetStore.getState().set("thinking");
    finalizeProcessAgentLog(qc, sessionId, run);
    foldReasoning(qc, run, ev.delta);
    return;
  }

  if (ev.type === "todo") {
    // 任务清单快照(claude TodoWrite / codex update_plan):编排中间段(intent/subagent)的清单
    // 属于过程,不进聊天正文——与下方 text 的 stage 守卫同理;非编排 run 无 stage,正常折叠。
    if (ev.stage === "intent" || ev.stage === "subagent") return;
    // 清单更新是显式阶段边界:先收尾打开的思考块/工具卡,再原地覆盖(或追加)todo 卡。
    finalizeRunReasoning(qc, run);
    finalizeProcessAgentLog(qc, sessionId, run);
    foldTodoIntoCache(qc, sessionId, run, runId, ev.todos);
    return;
  }

  if (ev.type === "tool") {
    // phase:"end"(工具完成帧)只进上面的运行事件流,不进 agentLog 折叠——否则每个工具在过程
    // 面板出现两次(start+end 各折一条)。同时跳过 typing/变更文件/拦截检测等 start 专属副作用。
    // 也修复既有潜伏 bug:orchestrate 的 pi 路径(mapPiToCliEvent)一直在产 end 事件并被翻倍折叠。
    if (ev.phase === "end") return;
    usePetStore.getState().set("working");
    updateTypingMsg(qc, sessionId, run.typingUid, typingToolText(run.agent, ev.name, ev.detail));
    // 阶段切换收尾:收到工具前先收尾打开的思考块,使新工具卡按时序追加到思考之后(保留交错时间线)。
    finalizeRunReasoning(qc, run);
    // 时间线：写类工具的 file_path 记为变更文件。
    const changed = extractChangedFile(ev.name, ev.detail, run.cwd ?? "");
    if (changed) (run.changedFiles ??= new Set()).add(changed);
    // 运行模式拦截检测:plan/accept-edits 下出现被禁工具(写/执行)→ 记首个,轮结束弹切档提示。
    if (!run.blockedTool) {
      const cat = restrictedToolForMode(ev.name, run.permissionMode, run.agent);
      if (cat) run.blockedTool = { name: ev.name, category: cat };
    }
    foldToolIntoProcess(qc, sessionId, run, ev);
    return;
  }

  if (ev.type === "text") {
    // 三段编排的中间段文本是「过程」，必须进右侧过程流、绝不落聊天正文：
    //   - intent（意图理解）：改写后的提示词
    //   - subagent（子 agent 执行）：子任务的执行输出
    // 只有 refine 段（或非编排 run，ev.stage 为 undefined）才是面向用户的最终回复。
    // 不做这步则三段文本会全部拼进聊天正文，正文被污染——这是「接通渲染端」最关键的一步。
    if (ev.stage === "intent" || ev.stage === "subagent") {
      usePetStore.getState().set("thinking");
      finalizeProcessAgentLog(qc, sessionId, run);
      foldReasoning(qc, run, ev.delta); // 与 reasoning 同通道，进过程流
      return;
    }
    // 圆桌模式：文本折叠到当前活跃角色的独立游标，每个角色输出各自成独立消息块。
    // 临时交换 run.cursor 到角色游标，复用 foldTextIntoCache，结束后换回。
    if (runUsesNestedRoleEvents(run) && ev.roleId) {
      const roleId = ev.roleId;
      if (!run.roleCursors) run.roleCursors = new Map();
      const roleCursor = run.roleCursors.get(roleId) ?? emptyFoldCursor();
      const roleHeader = ensureRoleHeader(qc, sessionId, run, roleId);
      const mainCursor = run.cursor;
      run.cursor = roleCursor;
      usePetStore.getState().set("replying");
      dropMsg(qc, sessionId, run.typingUid);
      run.buffer += ev.delta;
      run.sawText = true;
      finalizeRunReasoning(qc, run);
      finalizeProcessAgentLog(qc, sessionId, run);
      foldTextIntoCache(qc, sessionId, run, ev.delta, {
        roleId,
        roleLabel: roleHeader.roleLabel,
        roleColor: roleHeader.roleColor,
      });
      run.roleCursors.set(roleId, run.cursor);
      run.cursor = mainCursor;
      return;
    }
    usePetStore.getState().set("replying");
    dropMsg(qc, sessionId, run.typingUid);
    run.buffer += ev.delta; // 全轮文本累加（供 TTS / 时间线 summary），独立于块拆分
    run.sawText = true;
    // 跨流收尾:正文(final answer)开始时,收尾右侧过程流里仍 active 的 reasoning 块与 tool agentLog。
    finalizeRunReasoning(qc, run);
    finalizeProcessAgentLog(qc, sessionId, run);
    foldTextIntoCache(qc, sessionId, run, ev.delta);
    return;
  }

  if (ev.type === "result") {
    // 圆桌编排：带 roleId 的 result 是单角色完成/失败信号，不触发 finalizeRun。
    // 失败时在聊天流追加该角色的错误标注，后续角色继续执行。
    if ("roleId" in ev && ev.roleId && runUsesNestedRoleEvents(run)) {
      finalizeProcessAgentLog(qc, sessionId, run);
      finalizeRunReasoning(qc, run);
      if (run.activeRoleId === ev.roleId) run.activeRoleId = undefined;
      if (!ev.ok) {
        const roleHeader = ensureRoleHeader(qc, sessionId, run, ev.roleId);
        appendMsg(qc, sessionId, {
          kind: "text",
          who: run.agent,
          time: realHHMM(),
          text: `⚠️ 角色执行失败: ${ev.error ?? "未知错误"}`,
          uid: uid("rerr"),
          roleId: ev.roleId,
          roleLabel: roleHeader.roleLabel,
          roleColor: roleHeader.roleColor,
        });
      }
      return;
    }
    run.gotResult = true;
    run.resultOk = ev.ok;
    // 收尾过程流当前打开的 agentLog：全部步骤打勾（被文本打断的旧卡片已在折叠时收尾）。
    finalizeProcessAgentLog(qc, sessionId, run);
    if (!ev.ok) {
      dropMsg(qc, sessionId, run.typingUid);
      if (run.agent === "codex" && isMissingAgentSessionError(ev.error)) {
        clearRunSessionId(run);
        appendMsg(qc, sessionId, {
          kind: "text",
          who: run.agent,
          time: realHHMM(),
          text: t("chat:core.codexSessionLost"),
          uid: uid("err"),
        });
        notifyTurnComplete(false);
        scheduleResultExitFallback(qc, runId, sessionId);
        return;
      }
      // pi 兜底 Agent 鉴权类错误:补一句去哪里配供应商 / API Key。
      const piAuthHint =
        run.agent === "pi" && /api.?key|auth|credential|unauthorized|401|provider/i.test(ev.error ?? "")
          ? t("chat:core.piAuthHint")
          : "";
      appendMsg(qc, sessionId, {
        kind: "text",
        who: run.agent,
        time: realHHMM(),
        text: t("chat:core.execError", { error: ev.error || t("chat:core.unknownError"), authHint: piAuthHint }),
        uid: uid("err"),
      });
    } else if (!run.sawText && ev.text) {
      // 没收到增量文本（极少数情况），用 result 的最终文本兜底。
      dropMsg(qc, sessionId, run.typingUid);
      appendMsg(qc, sessionId, { kind: "text", who: run.agent, time: realHHMM(), text: ev.text, uid: uid("at") });
    } else if (ev.ok && !run.sawText && !ev.text) {
      // 纯工具轮成功:只更新瞬态 typing 占位,不追加持久 text。finalizeRun/exit 会清掉 typing。
      updateTypingMsg(qc, sessionId, run.typingUid, PURE_TOOL_TURN_PLACEHOLDER);
    }
    notifyTurnComplete(ev.ok);
    scheduleResultExitFallback(qc, runId, sessionId);
  }
}

// 回合完成系统通知（通用设置开关 + 仅窗口失焦时打扰）。Notification 是标准 Web API,
// 在 Electron renderer 与浏览器均可用;不可用/被拒时静默。
function notifyTurnComplete(ok: boolean): void {
  try {
    if (!usePersonalStore.getState().generalSettings.notifications.turnComplete) return;
    if (typeof document !== "undefined" && document.hasFocus()) return;
    if (typeof Notification === "undefined" || Notification.permission === "denied") return;
    const fire = () =>
      new Notification(t("chat:core.notify.title"), {
        body: ok ? t("chat:core.notify.turnComplete") : t("chat:core.notify.turnError"),
      });
    if (Notification.permission === "granted") fire();
    else void Notification.requestPermission().then((p) => (p === "granted" ? fire() : undefined));
  } catch {
    /* 通知不可用时静默 */
  }
}

function scheduleResultExitFallback(qc: QueryClient, runId: string, sessionId: string): void {
  const run = runs.get(runId);
  if (!run) return;
  stopResultExitFallback(run);
  run.resultExitFallback = setTimeout(() => {
    finalizeRun(qc, runId, 0, undefined, sessionId);
  }, RESULT_EXIT_GRACE_MS);
}

function finalizeRun(
  qc: QueryClient,
  runId: string,
  code: number | null,
  error?: string,
  sessionIdHint?: string,
): void {
  const run = runs.get(runId);
  if (!run) {
    // 注册表丢失（重载/看门狗已超时清理）时按 sessionId 兜底,保证 UI 不卡死。
    if (sessionIdHint) {
      clearTransient(qc, sessionIdHint);
      clearProcess(qc, sessionIdHint); // 立即清空出口（run-not-found 兜底，KTD8）。
      const store = usePersonalStore.getState();
      if (store.runningBySession[sessionIdHint] === runId) store.setRunning(sessionIdHint, undefined);
      flushChat(qc, sessionIdHint);
      usePetStore.getState().set("idle");
    }
    return;
  }
  stopRunTimers(run);
  runs.delete(runId);
  const { sessionId } = run;
  dropMsg(qc, sessionId, run.typingUid);
  usePersonalStore.getState().setRunning(sessionId, undefined);
  // 任务清单卡收尾:该 run 的 todoList 卡 active 置 false(run 结束,in_progress 项停转圈)。
  // 未完成项保持原状态展示——「运行结束但没做完」应直观暴露,不自动打勾。
  setMessages(qc, sessionId, (prev) =>
    prev.map((m) => (m.kind === "todoList" && m.runId === runId && m.active ? { ...m, active: false } : m)),
  );

  if (!run.gotResult && (error || (code !== null && code !== 0))) {
    const missingCodexSession = run.agent === "codex" && isMissingAgentSessionError(error);
    if (missingCodexSession) clearRunSessionId(run);
    const friendly = missingCodexSession
      ? t("chat:core.codexSessionLostBody")
      : error && /ENOENT/.test(error)
        ? t("chat:core.cliMissing")
        : error || t("chat:core.processExit", { code: code ?? "?" });
    appendMsg(qc, sessionId, {
      kind: "text",
      who: run.agent,
      time: realHHMM(),
      text: t("chat:core.errorPrefix", { message: friendly }),
      uid: uid("err"),
    });
  }
  // 过程流终态处理（KTD4/KTD8）:成功轮收尾打勾后**保留**（收起为可重开入口,数据在内存,不落盘,
  // 切走/下一轮才清,见 clearProcess 各出口）;失败/异常退出轮立即清空（错误文案已走 text 进消息流）。
  const runOk = run.gotResult && run.resultOk !== false && !error && (code === null || code === 0);
  if (runOk) finalizeProcessForRetain(qc, sessionId);
  else clearProcess(qc, sessionId);
  // 会话产物成功落定后重新聚焦编辑器。生成期间用户可能收起/切走右栏；仅当前仍停留在
  // 该会话时自动打开，后台会话完成不能抢走用户正在查看的其它会话。
  if (runOk && run.artifactResumeKey) {
    const store = usePersonalStore.getState();
    if (store.activeSessionId === sessionId) {
      const artifactMatch = /^artifact:(design|slides):([^:]+):/.exec(runId);
      const session = store.sessions.find((item) => item.id === sessionId);
      const artifact = artifactMatch && session
        ? [session.activeArtifact, ...(session.artifacts ?? [])]
            .filter((item): item is ConversationArtifactRef => !!item)
            .find(
              (item) =>
                item.kind === artifactMatch[1] &&
                item.documentId === artifactMatch[2],
            )
        : undefined;
      if (artifact) {
        store.updateSession(sessionId, { activeArtifact: artifact });
        store.setRightView("artifact");
        useCortexUIStore.getState().setRightOpen(true);
      }
    }
  }
  // 一轮结束立即冲刷落盘，不等节流窗口。
  flushChat(qc, sessionId);
  // 成功收尾 → 开心一下;失败/中断 → 回闲置。
  usePetStore.getState().set(run.gotResult && run.resultOk !== false ? "happy" : "idle");

  // 运行模式拦截:本轮若有被 plan/accept-edits 拦下的工具尝试**且本轮失败**,挂切档提示。
  maybeEmitModeBlockHint(run, !runOk);

  // TTS：开启自动朗读时,把这一轮的回复读出来（失败静默,不影响会话）。
  const tts = usePersonalStore.getState().ttsSettings;
  if (tts.autoSpeak && run.gotResult && run.buffer.trim()) {
    speakText(bridgeRef, tts, run.buffer).catch(() => {
      // TTS 端点不可用等,静默跳过
    });
  }

  // 时间线：记录这一轮 run 事件（恢复型 run 无 prompt,用回复首行兜底）。
  // 不使用项目的会话（无 projectId）不归入任何项目时间线,跳过。
  const session = usePersonalStore.getState().sessions.find((x) => x.id === sessionId);
  if (session && session.projectId) {
    const title = run.promptText ? promptTitle(run.promptText) : promptTitle(run.buffer || t("chat:core.recoveredTurn"));
    recordTimelineEvent(qc, bridgeRef, session.projectId, {
      id: `run-${runId}`,
      projectId: session.projectId,
      sessionId,
      ts: Date.now(),
      kind: "run",
      title,
      summary: clipSummary(run.buffer),
      files: run.changedFiles?.size ? [...run.changedFiles] : undefined,
      meta: {
        agent: run.agent,
        ok: run.gotResult && run.resultOk !== false && !error && (code === null || code === 0),
        durationMs: run.startedAt ? Date.now() - run.startedAt : undefined,
      },
    });
  }

  // 深化副作用:仅当该 session 有关联闪记（深化中 deepening / 生成 plan 的 deepened）时才动作
  //（普通会话完全 no-op,applyDeepenFinalize 内部 gate）。终态失败（spawn/鉴权/超时/放弃）→
  // 回落 draft（plan run 的 deepened 不回落）;否则 fs.exists 探测确定产出路径 → 置已深化/追加
  // docPaths;普通澄清轮 → 保持原状态。鉴权失败走 result(ok:false)（gotResult=true、resultOk=false）;
  // spawn/超时/非零退出走 (!gotResult && (error||非零 code))。
  const terminalFailure =
    (!run.gotResult && (!!error || (code !== null && code !== 0))) ||
    (run.gotResult && run.resultOk === false);
  void applyDeepenFinalize(bridgeRef, {
    sessionId,
    cwd: run.cwd,
    terminalFailure,
  });
}

function handleCliExit(
  qc: QueryClient,
  runId: string,
  code: number | null,
  error?: string,
  sessionIdHint?: string,
): void {
  // 与 handleCliEvent 的守卫对称:design run 与 writing run(writing:/writing-)的退出
  // 由各自的 run-manager 处理,不得走 finalizeRun 的 sessionIdHint 兜底(会对
  // design-<docId> / writing-<threadUuid> 会话 flushChat,用个人消息缓存覆写工作台转录)。
  if (runId.startsWith("design:") || runId.startsWith("slides:") || runId.startsWith("writing:") || runId.startsWith("writing-"))
    return;
  finalizeRun(qc, runId, code, error, sessionIdHint);
}

export function __handleCliEventForTest(
  qc: QueryClient,
  runId: string,
  ev: CliStreamEvent,
  sessionIdHint?: string,
): void {
  handleCliEvent(qc, runId, ev, sessionIdHint);
}

export function __handleCliExitForTest(
  qc: QueryClient,
  runId: string,
  code: number | null,
  error?: string,
  sessionIdHint?: string,
): void {
  handleCliExit(qc, runId, code, error, sessionIdHint);
}

// 立即清空某会话过程流（测试驱动 editResend/新一轮清理语义的轻量入口）。
export function __clearProcessForTest(qc: QueryClient, sessionId: string): void {
  clearProcess(qc, sessionId);
}

// 测试模拟「会话已结束后挂的游离延迟清理 timer」:排一个会把数据写回 process key 的 timer 进
// processCleanupTimers。用于断言「立即清空出口（clearProcess/reapSessionRun）先 clearTimeout,
// 推进 fake timer 后过程流不被复活写回」（KTD8 复活防护）。
export function __scheduleStrayProcessTimerForTest(qc: QueryClient, sessionId: string, delayMs: number): void {
  const prev = processCleanupTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  processCleanupTimers.set(
    sessionId,
    setTimeout(() => {
      // 若未被取消即触发,会把一条「复活」过程行写回——正确实现里应被出口的 clearTimeout 拦截。
      setProcessMessages(qc, sessionId, (prev2) => [
        ...prev2,
        { kind: "reasoning", who: "pi", time: realHHMM(), text: "复活", active: false, completed: true, uid: uid("revive") },
      ]);
      processCleanupTimers.delete(sessionId);
    }, delayMs),
  );
}

// 当前挂着延迟清理 timer 的会话数（测试断言 timer 被取消）。
export function __processCleanupTimerCountForTest(): number {
  return processCleanupTimers.size;
}

export function __resetPersonalMessageRunsForTest(): void {
  for (const run of runs.values()) stopRunTimers(run);
  runs.clear();
  piSendStarting.clear();
  // 过程流延迟清理 timer:全部取消并清表（杜绝跨用例游离 timer 复活已清会话 process key）。
  // 过程流数据本身随每个用例新建的 QueryClient 自然丢弃。
  for (const timer of processCleanupTimers.values()) clearTimeout(timer);
  processCleanupTimers.clear();
  // 落盘节流 timer 同理清掉,避免跨用例触发已替换桥的 saveChat。
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  bridgeRef = null;
}

// 测试注入全局桥引用:用于断言「过程流落地从不触发 bridge.save*」「旧档加载后 flushChat 原地清洗」。
// 生产经 usePersonalCliEvents/usePersonalPiEvents 设置;测试无法挂 hook,故提供显式 setter。
export function __setBridgeForTest(bridge: DesktopBridge | null): void {
  bridgeRef = bridge;
}

// 测试触发一次节流落盘冲刷（同步把当前消息流经 sanitizeForSave 写给 bridge.saveChat）。
export function __flushChatForTest(qc: QueryClient, sessionId: string): void {
  flushChat(qc, sessionId);
}

// ── pi RPC 会话（pi --mode rpc）的事件折叠 + 轮生命周期 ─────────────────────
// 复用上面单发的 runs / RunState / foldIntoCache / finalizeRun:pi 与单发语义重叠的
// text/tool/result 走同一折叠管线;pi 专属 reasoning/compaction/retry/queue/thinking-level/
// crashed 单独处理。关键发散:pi 进程长驻,看门狗只刷新 typing 等待时长、绝不 killCli;一轮
// 由 result 事件（agent_end）收尾,不等 exit。

/**
 * 开启一个 pi 轮:创建 RunState（transport:"pi"）+ 只刷新等待时长的看门狗 + setRunning。
 * runId/typingUid 由调用方（send）生成;调用方负责已 appendMsg 用户消息 + typing 占位。
 */
export function beginPiRun(
  qc: QueryClient,
  opts: {
    runId: string;
    sessionId: string;
    typingUid: string;
    cwd?: string;
    promptText?: string;
    phase?: "starting" | "thinking";
  },
): void {
  const run: RunState = {
    sessionId: opts.sessionId,
    agent: "pi",
    typingUid: opts.typingUid,
    cursor: emptyFoldCursor(),
    processCursor: emptyProcessCursor(),
    sawText: false,
    buffer: "",
    gotResult: false,
    phase: opts.phase ?? "starting",
    lastEventAt: Date.now(),
    promptText: opts.promptText,
    startedAt: Date.now(),
    cwd: opts.cwd,
    transport: "pi",
  };
  runs.set(opts.runId, run);
  // pi 看门狗:只滚动显示等待时长,绝不杀进程（长驻;一轮靠 result/abort 收尾,无静默超时杀）。
  run.watchdog = setInterval(() => {
    const cur = runs.get(opts.runId);
    if (!cur) return;
    if (!cur.cursor.lastKind && !cur.reasoningUid && !cur.gotResult && cur.startedAt) {
      updateTypingMsg(qc, cur.sessionId, cur.typingUid, typingText("pi", cur.phase, Date.now() - cur.startedAt));
    }
  }, 1000);
  usePersonalStore.getState().setRunning(opts.sessionId, opts.runId);
  usePetStore.getState().set("thinking");
}

// 冷启动会话:piOpen 完成后从「启动中」翻到「思考中」（复用会话则一开始即 thinking）。
export function flipPiRunToThinking(qc: QueryClient, runId: string): void {
  const run = runs.get(runId);
  if (!run || run.phase === "thinking") return;
  run.phase = "thinking";
  updateTypingMsg(qc, run.sessionId, run.typingUid, typingText("pi", "thinking", 0));
}

// 思考流折叠:首个 reasoning delta 开块,后续累进同一 reasoning 块。落在**过程流**（不落盘）。
function foldReasoning(qc: QueryClient, run: RunState, delta: string): void {
  const { sessionId } = run;
  if (run.reasoningUid) {
    const text = (run.reasoningText ?? "") + delta;
    run.reasoningText = text;
    const ruid = run.reasoningUid;
    setProcessMessages(qc, sessionId, (prev) =>
      prev.map((m) => (m.uid === ruid && m.kind === "reasoning" ? { ...m, text, active: true } : m)),
    );
    return;
  }
  const ruid = uid("re");
  run.reasoningUid = ruid;
  run.reasoningText = delta;
  setProcessMessages(qc, sessionId, (prev) => [
    ...prev,
    {
      kind: "reasoning",
      who: run.agent,
      time: realHHMM(),
      text: delta,
      active: true,
      uid: ruid,
    },
  ]);
}

// reasoning 收尾:翻完成态。改写**过程流**（KTD6——reasoning 收尾的 setMessages 目标改到 process key）。
function finalizeRunReasoning(qc: QueryClient, run: RunState): void {
  if (!run.reasoningUid) return;
  const reasoningUid = run.reasoningUid;
  setProcessMessages(qc, run.sessionId, (prev) => finalizeReasoning(prev, reasoningUid));
  run.reasoningUid = undefined;
  run.reasoningText = undefined;
}

// tool-end:把当前 agentLog 卡片里最后一个 running 项翻 check;出错则文本前缀 ⚠️。落在**过程流**。
// 顺序工具精确;并发工具（罕见）best-effort 翻最后一个,不影响整体可读性。
function finalizeLastToolItem(qc: QueryClient, run: RunState, isError: boolean): void {
  if (run.processCursor.lastKind !== "tool" || !run.processCursor.logUid) return;
  const logUid = run.processCursor.logUid;
  setProcessMessages(qc, run.sessionId, (prev) =>
    prev.map((m) => {
      if (m.uid !== logUid || m.kind !== "agentLog") return m;
      const items = [...m.items];
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it && it.ic === "running") {
          const text = isError && typeof it.text === "string" ? `⚠️ ${it.text}` : it.text;
          items[i] = { ...it, ic: "check", text };
          break;
        }
      }
      return { ...m, items };
    }),
  );
}

function appendPiError(qc: QueryClient, run: RunState, error: string): void {
  // 鉴权类错误补一句去哪配供应商（与单发 result 错误分支同款）。
  const piAuthHint = /api.?key|auth|credential|unauthorized|401|provider/i.test(error)
    ? t("chat:core.piAuthHint")
    : "";
  appendMsg(qc, run.sessionId, {
    kind: "text",
    who: run.agent,
    time: realHHMM(),
    text: t("chat:core.execError", { error: error || t("chat:core.unknownError"), authHint: piAuthHint }),
    uid: uid("err"),
  });
}

// 取某会话当前活跃的 pi run（一个会话同时至多一轮）。
function piRunFor(sessionId: string): { runId: string; run: RunState } | undefined {
  const runId = usePersonalStore.getState().runningBySession[sessionId];
  if (!runId) return undefined;
  const run = runs.get(runId);
  return run ? { runId, run } : undefined;
}

// pi 硬失败（坏 key/限流/provider 挂）时,单发 pi 适配器实测:进程 exit 0、错误只在
// message_end{stopReason:error},agent_end 可能不发（见 apps/desktop/src/main/agents/pi.ts:15）。
// RPC 用 agent_end 作终结符,故 error 后给一段宽限:无 result/retry 跟进则自行收尾,防永久卡 running。
const PI_ERROR_FINALIZE_GRACE_MS = 4_000;

// pi 归一化事件 → 消息缓存。无活跃 run 也要处理的状态/瞬态事件先分流;其余折叠进当前轮。
function handlePiEvent(qc: QueryClient, sessionId: string, ev: PiSessionEvent, evRunId?: string): void {
  const store = usePersonalStore.getState();
  // 阶段4:任何事件 = 活跃,刷新空闲回收计时器（避免运行中被误回收）。
  touchPiSession(bridgeRef, sessionId);
  // 阶段4 代际守卫:事件带 runId 且与当前活跃轮不符 → 迟到/串台事件（崩溃重开/editResend 重入的
  // 旧轮事件），丢弃,不折叠进新轮。状态/瞬态事件（queue/compaction/crashed 等不折叠进 run）放行。
  const activeRunId = store.runningBySession[sessionId];
  if (evRunId && activeRunId && evRunId !== activeRunId && ev.type !== "crashed") return;
  // 任何新事件都说明本轮仍活跃 → 取消下面 error 分支挂的「防卡死」兜底收尾。
  const activeAny = piRunFor(sessionId);
  if (activeAny) stopResultExitFallback(activeAny.run);
  switch (ev.type) {
    case "queue":
      store.setPiRuntime(sessionId, { steering: ev.steering, followUp: ev.followUp });
      return;
    case "compaction":
      store.setPiRuntime(sessionId, { compacting: ev.phase === "start" });
      return;
    case "retry":
      store.setPiRuntime(sessionId, { retry: { attempt: ev.attempt, max: ev.maxAttempts } });
      // 重试也进运行事件流(详情弹层的重试可见性)。
      if (activeRunId) {
        recordRunEvent(qc, sessionId, activeRunId, {
          type: "retry",
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
        });
      }
      return;
    case "thinking-level":
      store.setPiRuntime(sessionId, { thinkingLevel: ev.level });
      return;
    case "session-info":
      return; // 预留:暂不据此改标题（避免覆盖用户改名）。
    case "notify": {
      // 扩展命令（如 /memory-index-sessions）经 ctx.ui.notify 的输出——不走 agent 文本流,直接作为
      // 一条 pi 消息呈现。置 sawText 以免随后的（补发）result 收尾再加「纯工具轮」占位。
      // 同时标记本轮为扩展命令 → 抑制右侧「执行过程」面板的空态「运行中」闪现（无过程步骤可展示）。
      store.setPiRuntime(sessionId, { extensionCommand: true });
      const msg = ev.message.trim();
      if (msg) {
        // notify 多是终端风格输出（树形 ├─/└─、对齐、多行）。聊天正文走 react-markdown,单个 \n 会被
        // 折叠成空格 → 多行挤成一行。故含换行的 notify 包进 ```text 代码块（等宽 + 保留换行/对齐）;
        // 单行则按普通文本（保留 emoji 友好排版）。
        const text = msg.includes("\n") ? `\`\`\`text\n${msg}\n\`\`\`` : msg;
        appendMsg(qc, sessionId, { kind: "text", who: "pi", time: realHHMM(), text, uid: uid("pi") });
        const a = piRunFor(sessionId);
        if (a) a.run.sawText = true;
      }
      return;
    }
    case "crashed": {
      markPiSessionGone(sessionId);
      const active = piRunFor(sessionId);
      if (active) {
        stopRunTimers(active.run);
        runs.delete(active.runId);
      }
      clearTransient(qc, sessionId);
      clearProcess(qc, sessionId); // 立即清空出口（pi crashed，KTD8）。
      appendMsg(qc, sessionId, {
        kind: "text",
        who: "pi",
        time: realHHMM(),
        // 阶段4:崩溃后会话内存态丢,但 sessionFile 已持久 → 下次发送惰性重开 + switchSession 恢复上下文。
        text: t("chat:core.piExited", {
          detail: ev.error ? t("chat:core.piExitedDetail", { error: ev.error }) : "",
        }),
        uid: uid("err"),
      });
      store.setRunning(sessionId, undefined);
      store.setPiRuntime(sessionId, undefined);
      store.clearPiUiForSession(sessionId); // 清该会话悬挂的确认弹窗（进程已死,回写无意义）。
      flushChat(qc, sessionId);
      usePetStore.getState().set("idle");
      return;
    }
  }

  const active = piRunFor(sessionId);
  if (!active) return; // 轮已结束/未开始,丢弃残余流（与停止后丢弃 stdout 对称）。
  const { runId, run } = active;
  run.lastEventAt = Date.now();
  if (run.phase === "starting") run.phase = "thinking";
  // 运行事件流采集(详情弹层数据源):pi 事件转成与 claude/codex 同形态的记录后统一入通道。
  const runRecord = piEventToRunRecord(ev, run.resultOk !== false);
  if (runRecord) recordRunEvent(qc, sessionId, runId, runRecord);

  switch (ev.type) {
    case "reasoning":
      usePetStore.getState().set("thinking");
      // 先折叠再取片段:snippet 从累进后的 reasoningText 尾部派生,活动行与过程面板同步。
      foldReasoning(qc, run, ev.delta);
      setTypingActivity(qc, sessionId, run.typingUid, typingText(run.agent, "thinking", 0), {
        phase: "thinking",
        snippet: thinkingSnippet(run.reasoningText ?? ""),
        stepCount: run.stepCount,
        startedAt: run.startedAt,
      });
      return;
    case "text":
      usePetStore.getState().set("replying");
      dropMsg(qc, sessionId, run.typingUid);
      finalizeRunReasoning(qc, run);
      run.buffer += ev.delta;
      run.sawText = true;
      // 跨流收尾:上块是 tool 时,对 process key 收尾打开的 agentLog（KTD6）。
      finalizeProcessAgentLog(qc, sessionId, run);
      foldTextIntoCache(qc, sessionId, run, ev.delta);
      return;
    case "tool-start": {
      usePetStore.getState().set("working");
      finalizeRunReasoning(qc, run);
      const changed = extractChangedFile(ev.name, ev.detail, run.cwd ?? "");
      if (changed) (run.changedFiles ??= new Set()).add(changed);
      foldToolIntoProcess(qc, sessionId, run, { type: "tool", name: ev.name, detail: ev.detail });
      // 活动行进入工具相:记起始时刻供渲染层做慢工具「已运行 Ns」心跳。
      run.toolStartedAt = Date.now();
      setTypingActivity(qc, sessionId, run.typingUid, typingToolText(run.agent, ev.name, ev.detail), {
        phase: "tool",
        toolName: cleanToolName(ev.name),
        detail: ev.detail,
        stepCount: run.stepCount ?? 0,
        startedAt: run.startedAt,
        toolStartedAt: run.toolStartedAt,
      });
      return;
    }
    case "todo":
      // 任务清单快照(pi todo_write):与 handleCliEvent 的 todo 分支同语义——收尾打开的
      // 思考块/工具卡,原地覆盖(或追加)todo 卡。
      finalizeRunReasoning(qc, run);
      finalizeProcessAgentLog(qc, sessionId, run);
      foldTodoIntoCache(qc, sessionId, run, runId, ev.todos);
      return;
    case "tool-end":
      finalizeLastToolItem(qc, run, ev.isError);
      // 短暂 ✓ 完成态:被下一个 reasoning/tool/text 事件覆盖;若直接 result 则由占位/正文兜底。
      run.stepCount = (run.stepCount ?? 0) + 1;
      run.toolStartedAt = undefined;
      setTypingActivity(qc, sessionId, run.typingUid, typingToolDoneText(run.agent, ev.name), {
        phase: "toolDone",
        toolName: cleanToolName(ev.name),
        stepCount: run.stepCount,
        startedAt: run.startedAt,
      });
      return;
    case "turn-end":
      finalizeProcessAgentLog(qc, sessionId, run);
      return;
    case "error":
      run.resultOk = false;
      dropMsg(qc, sessionId, run.typingUid);
      finalizeRunReasoning(qc, run);
      if (/^aborted$/i.test(ev.error)) {
        appendMsg(qc, sessionId, { kind: "text", who: run.agent, time: realHHMM(), text: t("chat:core.aborted"), uid: uid("err") });
      } else {
        appendPiError(qc, run, ev.error);
      }
      // 防卡死:挂宽限兜底,若 pi 不发后续 agent_end/retry 则自行收尾（下个事件会取消它）。
      run.resultExitFallback = setTimeout(
        () => finalizeRun(qc, runId, 0, undefined, sessionId),
        PI_ERROR_FINALIZE_GRACE_MS,
      );
      return;
    case "result": {
      if (ev.willRetry) {
        // 自动重试:保留 run 等下一轮事件,不收尾（retry 事件已驱动状态指示）。
        // 复位上一尝试的失败态 + 折叠游标 + buffer,避免成功的重试被误判失败或文本续错块。
        finalizeRunReasoning(qc, run);
        run.gotResult = false;
        run.resultOk = undefined;
        run.cursor = emptyFoldCursor();
        run.processCursor = emptyProcessCursor();
        run.buffer = "";
        run.sawText = false;
        // 活动行进度同步复位:重试是重新执行本轮,步数/工具计时不应从上次尝试续算。
        run.stepCount = undefined;
        run.toolStartedAt = undefined;
        return;
      }
      // 部分 reasoning 模型会以 stop 正常结束，却只产出思考流、完全没有最终正文。此前该路径
      // 被当成成功轮直接清空，用户看到的就是“思考结束后没有回复”。它不同于有工具步骤的纯工具轮：
      // 给出可见的瞬态错误提示，避免静默结束，同时不把内部 reasoning 暴露成最终答案。
      const missingFinalReply =
        run.resultOk !== false &&
        !run.sawText &&
        !!run.reasoningUid &&
        run.processCursor.lastKind !== "tool" &&
        !run.stepCount;
      finalizeRunReasoning(qc, run);
      run.gotResult = true;
      if (run.resultOk === undefined) run.resultOk = true;
      if (missingFinalReply) {
        run.resultOk = false;
        appendMsg(qc, sessionId, {
          kind: "text",
          who: run.agent,
          time: realHHMM(),
          text: t("chat:core.piEmptyReply"),
          uid: uid("err"),
        });
      }
      // 过程流当前打开的 agentLog 收尾打勾。
      finalizeProcessAgentLog(qc, sessionId, run);
      // 纯工具轮占位（R3/KTD5/C1）:pi 的 result 是 {willRetry},无 ok/text 字段,故按
      // resultOk!==false（非失败）+ !sawText（全程无 agent 文本）判定,且须在本 case 内、
      // finalizeRun 之前执行——finalizeRun 会 runs.delete,之后 run 状态不可再读。
      if (run.resultOk !== false && !run.sawText) {
        updateTypingMsg(qc, sessionId, run.typingUid, PURE_TOOL_TURN_PLACEHOLDER);
      }
      store.setPiRuntime(sessionId, undefined);
      notifyTurnComplete(run.resultOk !== false);
      finalizeRun(qc, runId, 0, undefined, sessionId);
      return;
    }
  }
}

export function __handlePiEventForTest(qc: QueryClient, sessionId: string, ev: PiSessionEvent, runId?: string): void {
  handlePiEvent(qc, sessionId, ev, runId);
}

// 强制回收某会话的 renderer run:停看门狗/兜底 + 删 run + 清 running/runtime + 收瞬态。
// 用于「删除/关闭一个仍在跑的 pi 会话」——pi 看门狗无超时自杀,不回收会永久空转 interval
// 并向已删会话缓存写 typing（见 closePiSession 调用点）。对无活跃 run 的会话幂等 no-op。
export function reapSessionRun(qc: QueryClient, sessionId: string): void {
  for (const [id, r] of runs) {
    if (r.sessionId === sessionId) {
      // 核心路径埋点（U7）:强制回收一个仍在跑的 run（典型为删/关 pi 会话,看门狗无超时自杀）。
      // 仅观测,经注入 logger 记录;web 端 bridgeRef=null 安全 no-op。
      void bridgeRef?.logMessage?.(
        "warn",
        `[personal:reap] force-reclaim run=${id} agent=${r.agent} phase=${r.phase} transport=${r.transport ?? "cli"}`,
      );
      stopRunTimers(r);
      runs.delete(id);
    }
  }
  const store = usePersonalStore.getState();
  store.setRunning(sessionId, undefined);
  store.setPiRuntime(sessionId, undefined);
  store.clearPiUiForSession(sessionId); // 删/关会话时清其悬挂确认弹窗。
  clearTransient(qc, sessionId);
  // 删会话立即清空过程流并取消任何游离的延迟清理 timer（杜绝 timer 复活已删会话 process key，KTD8）。
  clearProcess(qc, sessionId);
  // 运行事件流随会话消亡整条回收(跨轮累积的数据只在此与 editResend 出口清)。
  clearRunEvents(qc, sessionId);
}

// pi:prompt 只收 message 字符串,无 appendSystemPrompt 通道（与单发 startCli 不同）。
// 故把项目/skills/todos 注入内联到消息前（阶段2 取舍:pi 把它当消息一部分;后续可给
// pi:prompt 加系统提示通道）。run.promptText 仍存纯文本（标题/时间线用）。
function buildPiPromptMessage(text: string, appendSystemPrompt?: string): string {
  return appendSystemPrompt ? `${appendSystemPrompt}\n\n${text}` : text;
}

// 全局追加系统提示词（U3/U4）:对 claude/codex/pi 三端统一注入,经每轮 appendSystemPrompt 下发
// （pi 走 buildPiPromptMessage 前缀,claude --append-system-prompt,codex promptWithSkills 前置）。
// 与 pi 专属、会话级的 piSystemPrompt 解耦并存。组装顺序:全局指令 → 语言指令(U4) → 用户记忆。
// 皆空 → undefined。
export function buildGlobalAppend(): string | undefined {
  const parts: string[] = [];
  const gi = usePersonalStore.getState().generalSettings.globalInstruction?.trim();
  if (gi) parts.push(gi);
  // 语言指令(U4):按当前 UI 语言注入,让 agent 用该语言回复。在 send 派发时刻读取 tweaks.language
  // （与调用方传入的 extraSystemPrompt 捕获时刻可能相差一次语言切换,有意为之以反映最新语言）。
  parts.push(languageInstruction(useCortexUIStore.getState().tweaks.language));
  // 用户记忆:跨会话持久记忆（做梦整理 + 手写）,memoryEnabled 关闭或全空时返回 undefined。
  // 在此单点注入即覆盖 chat 的 pi/claude/codex 三端（writing/design 在各自 run-manager 注入）。
  const memory = buildMemoryAppend();
  if (memory) parts.push(memory);
  return parts.length ? parts.join("\n\n") : undefined;
}

// 插件 Skill:解析注入 pi 的 --skill 目录集合。过滤/去重逻辑(禁用、工作区未授信、name 去重、
// useOwnSkills 短路、降级)已下沉到 skill-injection.ts 的 resolveEnabledSkillRecords(唯一实现、
// 跨 agent 共用),此处取其 dir 维持 pi 路径与既有调用方/测试的 string[] 契约不变。
//
// U6 去重(KTD5):pi 在 useOwnSkills===true 时会 drop --no-skills 放开自身原生发现(commit d1a0bec),
// 此时 pi 私有原生根(origin==="agent",如 ~/.pi/agent/skills、~/.agents/skills)下的 skill 由 pi 自己
// 发现——若再 --skill 显式注入同目录会触发 pi name collision 警告(保留先发现者,功能不坏但有噪)。
// 故 useOwnSkills===true 时剔除 origin==="agent" 的记录,只 --skill 注入共享根/插件根(pi 原生不扫);
// useOwnSkills!==true(原生关,恒带 --no-skills)时保留全部,否则 agent 原生根 skill 会彻底丢失。
export async function resolveEnabledSkillPaths(
  bridge: DesktopBridge,
  projectPath: string,
  useOwnSkills: boolean | undefined,
  agent?: AgentKind,
): Promise<string[]> {
  const records = await resolveEnabledSkillRecords(bridge, projectPath, useOwnSkills, agent);
  const deduped = useOwnSkills === true ? records.filter((s) => s.origin !== "agent") : records;
  return deduped.map((s) => s.dir);
}

// U5:单发(bridge.startCli)路径的 skill 注入分派。三类 agent 走各自的原生机制:
//  - claude:走原生目录发现 —— 把已启用 skill 记录经 startCli 的 skillRecords 交主进程建桥接目录
//    (U2 buildClaudeSkillBridge + --add-dir),claude 自己加载/展开 `/<name>`。故**不再**把 skill
//    列表渲染成 prose 并入 appendSystemPrompt(R5),appendWithSkills 只保留原始 appendSystemPrompt。
//  - codex:无目录桥接,维持现状 —— renderSkillBlock 渲染成 prose 并入 appendSystemPrompt,不带 skillRecords。
//  - pi:把共享记录与本轮第一方产物 skill 变成 skillPaths,由 adapter 逐项生成 --skill；不 prose 注入。
// ⚠️ 仅用于单发分支;圆桌编排(bridge.startOrchestration)分支不走此函数,继续沿用现状批量 prose
// 注入(见 System-Wide Impact / U5 Approach)。纯函数,便于单测。
export function buildSingleSendSkillInjection(
  agent: string,
  appendSystemPrompt: string | undefined,
  records: InjectableSkill[],
  options?: {
    useOwnSkills?: boolean;
    artifactSkill?: { name: string; path: string };
  },
): {
  appendWithSkills: string | undefined;
  skillRecords: InjectableSkill[] | undefined;
  skillPaths: string[] | undefined;
} {
  if (agent === "pi") {
    const paths = records
      .filter((record) => options?.useOwnSkills !== true || record.origin !== "agent")
      .map((record) => record.dir);
    if (options?.artifactSkill) paths.push(options.artifactSkill.path);
    return {
      appendWithSkills: appendSystemPrompt,
      skillRecords: undefined,
      skillPaths: [...new Set(paths)],
    };
  }
  const useClaudeNativeSkills = agent === "claude";
  const skillBlock = useClaudeNativeSkills ? "" : renderSkillBlock(records);
  const appendWithSkills = [appendSystemPrompt, skillBlock].filter(Boolean).join("\n\n") || undefined;
  return {
    appendWithSkills,
    skillRecords: useClaudeNativeSkills ? records : undefined,
    skillPaths: undefined,
  };
}

// 扩展市场（U3）:据 piExtensions 配置解析出注入 pi 的 -e 路径集合。
// 装≠启用 + 信任门:仅「在 enabled 且 在 trusted」的已装扩展才注入（启用集是 -e 的唯一来源,
// pi settings 自动发现已被 --no-extensions 抑制）。路径取持久化的 record.path（pi list 给出、安装时存）。
// v1 仅用户级(global);projectPath 预留给后续项目级按 cwd 过滤。失踪/坏路径的剔除在注入层 U7 兜底。
// useOwnSkills===false 不影响扩展（扩展是独立开关,非 skill）。返回排序去重的路径集。
export function resolveEnabledExtensionPaths(_projectPath: string): string[] {
  const cfg = { ...DEFAULT_PI_EXTENSIONS, ...usePersonalStore.getState().generalSettings.piExtensions };
  const enabled = new Set(cfg.enabled);
  const trusted = new Set(cfg.trusted);
  const paths = new Set<string>();
  for (const r of cfg.installed) {
    if (r.scope !== "global") continue; // v1 仅用户级
    const key = `${r.scope}:${r.ref}`;
    if (enabled.has(key) && trusted.has(key)) paths.add(r.path);
  }
  return [...paths].sort();
}

function appendUserMessage(
  qc: QueryClient,
  sessionId: string,
  text: string,
  attachments: PersonalAttachment[],
  images?: ChatImageRef[],
  files?: ChatFileRef[],
): void {
  appendMsg(qc, sessionId, {
    kind: "text",
    who: "me",
    time: realHHMM(),
    text,
    // 拖入的 skill/todo 仅注入 system prompt;这里同步把引用元数据存进消息,让会话气泡能回显。
    attachments: attachments.length ? attachments.map((a) => ({ name: a.name, kind: a.kind })) : undefined,
    // 已落盘的图片引用(path/name/mime/宽高;不含 dataUrl),气泡缩略图据此经 image:read 回读渲染。
    images: images?.length ? images : undefined,
    // 已落盘的文档引用(path/name/mime/字节数;不含内容),气泡据此回显「附带了什么文档」,
    // 内容由 agent 经 extract_document 按需读取。
    files: files?.length ? files : undefined,
    uid: uid("u"),
  });
}

// 把本轮附带的文档清单注入 system prompt:告诉 agent 有哪些文档及其绝对路径,并提示用
// extract_document 工具按需读取(否则 agent 不知道有文件可读)。与图片把路径注入 prompt 同理。
export function buildDocFilesSystemPrompt(files: ChatFileRef[]): string | undefined {
  if (files.length === 0) return undefined;
  const list = files.map((f) => `- ${f.name} (path: ${f.path})`).join("\n");
  return [
    "<attached-documents>",
    "用户在本条消息中附带了以下文档。需要其内容时,调用 extract_document 工具并传入对应 path 读取",
    "(支持 PDF / Word / Excel / PPT / 纯文本;扫描件可能无文本)。不要臆测文档内容。",
    list,
    "</attached-documents>",
  ].join("\n");
}

// pi 轮启动/受理失败:收尾本轮（drop typing + ⚠️ + 清 running）。
function failPiTurn(qc: QueryClient, sessionId: string, runId: string, err: unknown): void {
  const run = runs.get(runId);
  if (run) {
    stopRunTimers(run);
    runs.delete(runId);
    dropMsg(qc, sessionId, run.typingUid);
  }
  clearTransient(qc, sessionId);
  clearProcess(qc, sessionId); // 立即清空出口（failPiTurn，KTD8）。
  const msg = err instanceof Error ? err.message : String(err);
  appendMsg(qc, sessionId, {
    kind: "text",
    who: "pi",
    time: realHHMM(),
    text: t("chat:core.piStartFailed", { message: msg }),
    uid: uid("err"),
  });
  usePersonalStore.getState().setRunning(sessionId, undefined);
  usePersonalStore.getState().setPiRuntime(sessionId, undefined);
  usePetStore.getState().set("idle");
  flushChat(qc, sessionId);
}

async function buildPiOpenForSession(
  bridge: DesktopBridge,
  session: SessionMeta,
  projectPath: string,
): Promise<Omit<PiOpenRequest, "uiSessionId" | "cwd">> {
  // provider/model 解析:复用单发 isPi 分支策略（只取已启用 provider;停用/失效落空走 pi 内置默认）。
  const providerSettings = usePersonalStore.getState().providerSettings;
  const provider = providerSettings.providers.find(
    (p) => p.id === (session.providerId ?? providerSettings.defaultProviderId) && p.enabled,
  );
  const model = session.model ?? providerSettings.defaultModel ?? provider?.models[0]?.id;
  // pi 深度定制开关（阶段3）:从通用设置读,塞进 piOpen,主进程据此生成审批/样例 extension。
  // 会话开启时生效（extension 在 open 时加载）;改设置需重开会话才应用。
  const piCustom = usePersonalStore.getState().generalSettings.piCustomization;
  // 执行/目录两轴 → 线格式 → pi 能力派生:plan 收窄只读白名单;ask 注入审批 extension(写/执行类前审批);
  // auto + 非 plan 沿用 piCustom。仅工作目录/外部沙箱 → confineToCwd 注入 cwd 路径闸。
  // 切档/切审批经 extensionFingerprint 触发会话重开。
  const piPerm = toAdapterPermissions(session.execPermission, session.dirPermission);
  const piCaps = derivePiCapabilities(piPerm.permissionMode, piPerm.approvalPolicy, piCustom);
  // 持久 system prompt（阶段4）:用户配置的人设/规则,经 --append-system-prompt 系统级注入。
  // 与每轮临时 appendSystemPrompt（buildPiPromptMessage 内联）解耦——后者走 prompt 文本,前者走会话启动参数。
  const piSystemPrompt = usePersonalStore.getState().generalSettings.piSystemPrompt;
  // 思考强度初值（阶段5）:会话级优先,缺省回退全局默认;再缺省 = 不传 --thinking = pi 内置默认。
  const thinkingLevel = session.thinkingLevel ?? usePersonalStore.getState().generalSettings.piThinkingDefault;
  // 插件 Skill（U5）:解析已启用 + 授信 + 去重的 skill 目录,经 --skill 注入;集合变化经
  // extensionFingerprint 触发会话重开。useOwnSkills===false → 会话级一键关 → []。
  const skillPaths = await resolveEnabledSkillPaths(bridge, projectPath, session.useOwnSkills, session.agent);
  // 扩展市场（U3）:解析已启用+已授信的扩展 -e 路径;集合变化经 extensionFingerprint 触发重开。
  const extensionPaths = resolveEnabledExtensionPaths(projectPath);
  return {
    model,
    useOwnSkills: session.useOwnSkills,
    skillPaths,
    extensionPaths,
    provider: provider
      ? {
          id: provider.id,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          endpointFormat: provider.endpointFormat,
          // ProviderModelOption 用 label,pi 端用 name → 此处映射;并带上 per-model 能力标记
          // (reasoning/vision/contextTokens),供 renderPiExtension 渲染高级配置。
          models: provider.models.map((m) => ({
            id: m.id,
            name: m.label,
            reasoning: m.reasoning,
            vision: m.vision,
            contextTokens: m.contextTokens,
          })),
        }
      : undefined,
    // 审批开关/清单由运行模式派生（full-auto 档内部已沿用 piCustom 设置,故此处不再单独读）。
    // 空数组 [] 原样穿透(=不审批任何工具),undefined→默认三件 是 renderApprovalExtension 的职责。
    enableToolApproval: piCaps.enableToolApproval,
    approvalTools: piCaps.approvalTools,
    // plan 档只读工具白名单(缺省 undefined → 全工具)。经 buildRpcArgs → --tools 注入。
    toolWhitelist: piCaps.toolWhitelist,
    // 目录执行权限「仅工作目录」/「外部沙箱」→ pi:open 注入 cwd 路径闸 extension(pi 无原生沙箱)。
    confineToCwd: piCaps.confineToCwd,
    enableSampleTools: piCustom?.sampleTools || undefined,
    enableSampleCommands: piCustom?.sampleCommands || undefined,
    appendSystemPrompt: piSystemPrompt || undefined,
    thinkingLevel,
    // 会话级联网:主进程据此把研究引擎 MCP 并进桥接扩展。pi 工具集在 open 时冻结,
    // 故该值计入 extensionFingerprint(见 ./pi-session)——中途切开关会触发会话重开。
    webSearch: session.webSearch === true,
  };
}

// 会话预热:用户在输入框敲下首字符时提前拉起 pi 进程,消除首轮冷启 ~800ms 的「启动中」等待。
// 只做 ensurePiSession(惰性去重内建,与随后的 send 并发安全);**不** beginPiRun、不 setRunning、
// 不发 prompt —— 绝不污染 runningBySession/过程面板门控。失败静默(尽力而为,send 时会正常重试并报错)。
export async function prewarmPiSession(
  _qc: QueryClient, // 预留:与 sendPiTurn 签名对齐,当前预热不写缓存
  bridge: DesktopBridge,
  session: SessionMeta,
  projectPath: string,
): Promise<void> {
  if (session.agent !== "pi" || !piRpcAvailable(bridge)) return;
  if (isPiSessionOpen(session.id) || piSendStarting.has(session.id)) return;
  if (usePersonalStore.getState().runningBySession[session.id]) return;
  try {
    const piOpen = await buildPiOpenForSession(bridge, session, projectPath);
    const opened = await ensurePiSession(
      bridge,
      { uiSessionId: session.id, cwd: projectPath, ...piOpen },
      { resumeFrom: session.piSessionFile },
    );
    // 与 sendPiTurn 同口径持久 sessionFile,保证后续任何重开都能恢复上下文。
    if (opened.sessionFile && opened.sessionFile !== session.piSessionFile) {
      usePersonalStore.getState().updateSession(session.id, { piSessionFile: opened.sessionFile });
    }
    touchPiSession(bridge, session.id); // 预热即活跃,启动空闲回收计时。
  } catch {
    // 预热失败静默:不打扰输入,真正 send 会重走 ensurePiSession 并正常报错。
  }
}

// 发起一轮 pi RPC:beginPiRun（典型不杀进程的看门狗）+ 惰性 ensurePiSession（冷启就绪后翻
// 「思考中」）+ promptPi。失败 → failPiTurn。调用方已 appendMsg 用户消息 + typing 占位。
async function sendPiTurn(
  qc: QueryClient,
  bridge: DesktopBridge,
  session: SessionMeta,
  projectPath: string,
  text: string,
  appendSystemPrompt: string | undefined,
  ids: { runId: string; typingUid: string },
  imagePaths?: string[],
): Promise<void> {
  const { runId, typingUid } = ids;
  const reuse = isPiSessionOpen(session.id); // 复用已开会话:一开即「思考中」;冷启显「启动中」。
  beginPiRun(qc, {
    runId,
    sessionId: session.id,
    typingUid,
    cwd: projectPath,
    promptText: text,
    phase: reuse ? "thinking" : "starting",
  });
  piSendStarting.delete(session.id); // running 已置位,发送在途锁交棒（之后并发 send 被 running 挡）。

  try {
    const piOpen = await buildPiOpenForSession(bridge, session, projectPath);
    const opened = await ensurePiSession(
      bridge,
      {
        uiSessionId: session.id,
        cwd: projectPath,
        ...piOpen,
      },
      // 阶段4 恢复:此前持久化过 sessionFile（崩溃/空闲/LRU/app 重启后会话内存态没了）→
      // 重开后 switchSession 从磁盘 JSONL 恢复上下文（best-effort）。首轮全新会话无 file → 不恢复。
      { resumeFrom: session.piSessionFile },
    );
    // 持久 sessionFile 到 SessionMeta,供后续任何重开恢复。
    if (opened.sessionFile && opened.sessionFile !== session.piSessionFile) {
      usePersonalStore.getState().updateSession(session.id, { piSessionFile: opened.sessionFile });
    }
    flipPiRunToThinking(qc, runId); // 冷启就绪 → typing 翻「思考中」。
    touchPiSession(bridge, session.id); // 阶段4:发起一轮 = 活跃,启动/重置空闲计时。
    // 传 runId（阶段4 代际）:主进程绑定到本轮,事件回带,renderer 守卫丢弃旧轮串台事件。
    await promptPi(bridge, session.id, buildPiPromptMessage(text, appendSystemPrompt), runId, imagePaths);
    autoTitle(bridge, session, text); // pi 走 fallback 截断标题（autoTitle 内部仅 claude 跑 haiku）。
  } catch (err) {
    failPiTurn(qc, session.id, runId, err);
  }
}

// 编辑重发的 pi 分支:经 getForkMessages 定位编辑轮在 pi 侧的 entryId 并 fork（替代单发的
// trimAgentSession 截断会话文件）。pi 侧 entry.text 可能含内联系统提示前缀,故按「后缀匹配」+
// 同文序号定位。映射失败/会话未开 → 返回 false（调用方退化为只截断 UI + 重发,不 fork）。
export function piEntryMatchesText(entryText: string, originalText: string): boolean {
  const a = entryText.trim();
  const b = originalText.trim();
  if (a === b) return true;
  // pi 侧 entry 可能含 buildPiPromptMessage 内联的系统提示前缀（`${appendSystemPrompt}\n\n${text}`）。
  // 收紧:要求「\n\n + 原文」结尾（前缀块与原文以 \n\n 分隔），比裸 endsWith 稳——避免误命中
  // 「尾串恰好等于原文但中间无分隔」的别条。
  return a.endsWith(`\n\n${b}`);
}

export async function forkPiAtEditedMessage(
  bridge: DesktopBridge,
  sessionId: string,
  prevMessages: Message[],
  msgUid: string,
): Promise<boolean> {
  if (!isPiSessionOpen(sessionId) || !bridge.piGetForkMessages) return false;
  const original = prevMessages.find((m) => m.uid === msgUid);
  const originalText = original?.kind === "text" && typeof original.text === "string" ? original.text : undefined;
  if (!originalText) return false;
  const data = (await getForkMessagesPi(bridge, sessionId)) as
    | { messages?: Array<{ entryId: string; text: string }> }
    | undefined;
  const entries = data?.messages ?? [];
  const matches = entries.filter((e) => piEntryMatchesText(e.text, originalText));
  if (matches.length === 0) return false;
  // 同文序号:UI 里相同原文的第几条 → fork 列表里相同原文的第几条（越界回退到末条）。
  const ordinal = sameTextOrdinal(prevMessages, msgUid, originalText);
  const target = matches[ordinal >= 0 && ordinal < matches.length ? ordinal : matches.length - 1];
  if (!target) return false;
  await forkPi(bridge, sessionId, target.entryId);
  return true;
}

// ── session 标题自动生成 ──────────────────────────────────────────────────
const DEFAULT_TITLE = /^Session \d+$/;

function fallbackTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 16 ? clean.slice(0, 16) + "…" : clean || t("chat:core.newSession");
}

function sanitizeTitle(raw: string): string {
  // 取最后一个非空行（防模型偶尔带前言）,去引号/标点收尾。
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = (lines[lines.length - 1] ?? "").replace(/^["'“”《]+|["'“”》。,.!?]+$/g, "").trim();
  return last.length > 24 ? last.slice(0, 24) : last;
}

/// 用首条消息的截断文本给会话占位改名，仅在「仍是默认标题且用户没手改过」时。
///
/// 抽出来是因为有两条路径要用同一套条件：正常发送（autoTitle,占位之后还要跑 haiku 概括）
/// 与本地追加（appendLocalUserMessage,只要占位这一步）。条件写两份迟早漂移成
/// 「一条路径会顶掉用户手改的标题」。
///
/// 返回改名前的会话与刚写入的占位标题（调用方还要读 agent 决定后续动作、
/// 并在异步概括回来时比对占位值是否仍在），不满足条件返回 null。
function applyFallbackTitle(
  session: SessionMeta,
  text: string,
): { previous: SessionMeta; title: string } | null {
  const liveSession = usePersonalStore.getState().sessions.find((item) => item.id === session.id);
  if (!liveSession || liveSession.titleManuallyEdited || !DEFAULT_TITLE.test(liveSession.title)) {
    return null;
  }
  const title = fallbackTitle(text);
  usePersonalStore.getState().updateSession(session.id, { title });
  return { previous: liveSession, title };
}

// 首条消息发出后:先用截断文本占位,再用 haiku 异步生成概括标题（不阻塞会话）。
function autoTitle(bridge: DesktopBridge, session: SessionMeta, text: string): void {
  const applied = applyFallbackTitle(session, text);
  if (!applied) return;
  const fallback = applied.title;
  if (applied.previous.agent !== "claude") return;
  void bridge
    .oneshotCli({
      // 不传 cwd:在中性目录运行,不加载项目上下文,不与正式会话抢资源。
      prompt: t("chat:core.autoTitlePrompt", { text: text.slice(0, 500) }),
      model: "haiku",
    })
    .then((raw) => {
      const title = sanitizeTitle(raw);
      if (!title) return;
      const store = usePersonalStore.getState();
      const current = store.sessions.find((x) => x.id === session.id);
      // 仅当标题仍是占位值时替换,避免覆盖之后的修改。
      if (current && !current.titleManuallyEdited && current.title === fallback) {
        store.updateSession(session.id, { title });
      }
    })
    .catch(() => {
      // 生成失败保留截断占位标题。
    });
}

export const __autoTitleForTest = autoTitle;

/// 只往会话流追加一条用户消息并落盘，**不 spawn 任何 CLI**。
///
/// 用于「这条消息本身不是给 agent 的」派发场景：`/skill:research` 的活由 CRE 引擎干，
/// 会话里不产生 agent 轮次；但用户回头翻这个会话时得看得见自己当时要研究什么，
/// 所以消息仍要进流、要落盘、也要参与首条消息改名。
///
/// **绝不要图省事改成调 send**：那会让每次发起研究都白烧一轮 agent 的钱，
/// 而界面上看不出任何异常（回归测试钉着这条）。
export async function appendLocalUserMessage(
  qc: QueryClient,
  bridge: DesktopBridge,
  session: SessionMeta,
  text: string,
): Promise<void> {
  // 历史尚未加载时先补载,否则这条消息会被随后 resolve 的磁盘历史整个盖掉
  // （与 send 路径同一个坑,见 ensureChatLoaded 的注释）。
  await ensureChatLoaded(qc, bridge, session.id);
  appendUserMessage(qc, session.id, text, []);
  // 立即落盘而不等节流:用户点完就可能切走会话或关窗,这条消息没有后续事件再触发保存。
  flushChat(qc, session.id);
  // 只做占位改名,不跑 haiku 概括——研究目标本身就是一句凝练的话，
  // 再花一次模型调用去概括它不划算。
  applyFallbackTitle(session, text);
}

/// 往会话流追加一条**非用户侧**的本地消息并落盘，**不 spawn 任何 CLI**。
///
/// 与 appendLocalUserMessage 的差别只在 who：这条是「系统/引擎说的话」，
/// 渲染成 agent 侧气泡（PersonalChatArea 只按 who === "me" 区分两侧），
/// 且不参与会话改名——研究完成回执不该顶掉用户自己写的标题。
///
/// 唯一用途：CRE 研究结束后把结论指针（状态 / 统计 / 报告文件路径）回流到发起它的会话，
/// 否则用户切走再回来，聊天流里只剩自己问的那句话，看不出结果落在哪。
export async function appendLocalAgentMessage(
  qc: QueryClient,
  bridge: DesktopBridge,
  sessionId: string,
  who: string,
  text: string,
): Promise<void> {
  await ensureChatLoaded(qc, bridge, sessionId);
  appendMsg(qc, sessionId, { kind: "text", who, time: realHHMM(), text, uid: uid("res") });
  // 立即落盘:研究结束时用户很可能不在这个会话里,没有后续事件再触发保存。
  flushChat(qc, sessionId);
}

// ── Hooks ─────────────────────────────────────────────────────────────────

// 全局只挂一次（PersonalWorkspace 根部）：订阅主进程 CLI 事件。
export function usePersonalCliEvents(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  useEffect(() => {
    if (!bridge) return;
    bridgeRef = bridge;
    const offEvent = bridge.onCliEvent((runId, ev, sessionId) => handleCliEvent(qc, runId, ev, sessionId));
    const offExit = bridge.onCliExit((exit) => handleCliExit(qc, exit.runId, exit.code, exit.error, exit.sessionId));
    // ws 传输心跳(U5):codex app-server 长 MCP 工具静默期,主进程定期推 keepalive。仅刷新该 run 的
    // lastEventAt(等同收到一次 cli:event 的活跃信号),让 300s 静默看门狗不误杀长工具;不改变其它状态。
    const offKeepalive = bridge.onCliKeepalive?.((runId) => {
      const run = runs.get(runId);
      if (run) run.lastEventAt = Date.now();
    });
    return () => {
      bridgeRef = null;
      offEvent();
      offExit();
      offKeepalive?.();
    };
  }, [bridge, qc]);
}

// 全局只挂一次（PersonalWorkspace 根部，与 usePersonalCliEvents 并列）：订阅 pi RPC 事件流。
// 单订阅按 uiSessionId 分派到 handlePiEvent（多会话隔离）。bridge 无 onPiEvent（web/旧壳）时
// 整体 no-op，pi 退回单发或隐藏运行时控制。
export function usePersonalPiEvents(): void {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();
  useEffect(() => {
    if (!bridge?.onPiEvent) return;
    // bridgeRef 通常已由 usePersonalCliEvents 设置;此处兜底确保 handlePiEvent 的落盘可用。
    bridgeRef = bridge;
    // 阶段4:给 pi-session 进程层注入「是否有活跃轮」谓词 + 回收收尾回调（进程层不能反向依赖 store/qc）。
    // 空闲回收/LRU 据此跳过繁忙会话,被迫逐出时经 reapSessionRun 收尾 renderer run。
    setPiLifecycleHooks({
      isBusy: (sessionId) => !!usePersonalStore.getState().runningBySession[sessionId],
      onReclaim: (sessionId) => reapSessionRun(qc, sessionId),
    });
    const off = bridge.onPiEvent((sessionId, ev, runId) => handlePiEvent(qc, sessionId, ev, runId));
    return () => off();
  }, [bridge, qc]);
}

// 全局只挂一次（PersonalWorkspace 根部）：订阅 pi extension UI 请求 → 入队 store，由确认弹窗消费。
// bridge 无 onPiUiRequest（web/旧壳）时整体 no-op（pi extension 的 confirm 走 pi 侧 timeout 默认）。
export function usePersonalPiUi(): void {
  const bridge = useDesktopBridge();
  useEffect(() => {
    if (!bridge?.onPiUiRequest) return;
    const off = bridge.onPiUiRequest((uiSessionId, request) => {
      // confirm（阶段3 模态）与 askquestion（输入框上方富卡片）入队渲染。
      if (request.method === "confirm" || request.method === "askquestion") {
        usePersonalStore.getState().pushPiUiRequest({ uiSessionId, request });
      } else if (request.method === "select" || request.method === "input" || request.method === "editor") {
        // 同属阻断式(pi await 应答)但本阶段未渲染 UI → 立即回 cancelled 解除 pi 侧 await,
        // 否则该轮永久卡死。fire-and-forget 类(notify/setStatus/setWidget/...)无需回写,忽略。
        respondPiUi(bridge, uiSessionId, request.id, { cancelled: true });
      }
    });
    return () => off();
  }, [bridge]);
}

// 回应一条 pi extension UI 请求:回写给 pi（confirm/value/cancelled）+ 出队。失败静默（会话已退则作废）。
export function respondPiUi(
  bridge: DesktopBridge | null,
  uiSessionId: string,
  id: string,
  payload: PiUiResponsePayload,
): void {
  usePersonalStore.getState().resolvePiUiRequest(uiSessionId, id);
  void bridge?.piUiResponse?.(uiSessionId, id, payload).catch(() => undefined);
}

function cancelPendingPiUiForSession(bridge: DesktopBridge | null | undefined, sessionId: string): void {
  for (const p of usePersonalStore.getState().piUiPending.filter((x) => x.uiSessionId === sessionId)) {
    respondPiUi(bridge ?? null, sessionId, p.request.id, { cancelled: true });
  }
  usePersonalStore.getState().clearPiUiForSession(sessionId);
}

// 把 AskQuestionCard 每组的选择（选项下标 或 自定义文本）按 KTD-5 互斥规则归一成 AskQuestionAnswers
// JSON 串,经 {value} 回写 pi。custom 非空优先（自定义=「其他」);否则取选项 label。纯函数:无
// react-dom/localStorage/process.env 依赖,可独立单测（喂结构断言结构）。
export function serializeAskQuestionAnswers(
  envelope: AskQuestionEnvelope,
  selections: Record<string, { optionIndex?: number; custom?: string }>,
): string {
  const answers: AskQuestionAnswers["answers"] = [];
  for (const group of envelope.groups) {
    const sel = selections[group.id];
    if (!sel) continue;
    const custom = typeof sel.custom === "string" ? sel.custom.trim() : "";
    if (custom) {
      answers.push({ groupId: group.id, value: custom, isCustom: true });
    } else if (sel.optionIndex != null && sel.optionIndex >= 0 && sel.optionIndex < group.options.length) {
      answers.push({ groupId: group.id, value: group.options[sel.optionIndex]!.label, isCustom: false });
    }
  }
  return JSON.stringify({ answers });
}

// 确保某 session 的消息缓存已从磁盘加载（发送前调用，防止首条写入被覆盖）。
//
// 用 ensureQueryData 而非自起一次 loadChat:与 usePersonalChat 的 useQuery 共享同一在途
// 请求（React Query 按 queryKey 去重）。否则「即建即发」场景（Spotlight 接力、新会话落地页
// NewSessionLanding —— 均 createSession 后同一 tick 立刻 send）会有两个并发的 loadChat:
// ensureChatLoaded 自己的先 resolve、追加首条用户消息后,useQuery 那个晚到的 loadChat 才
// resolve 空历史,把刚写入的用户消息覆盖成空——表现为主窗体会话里看不到用户发出的那条消息。
export async function ensureChatLoaded(qc: QueryClient, bridge: DesktopBridge, sessionId: string): Promise<void> {
  // 历史加载也做瞬态清理（双保险:崩溃时可能存了未收尾状态）。v2 档经 normalizeLoadedChat 拆出消息;
  // 分支组并行补载(flushChat 落盘时两者一起写回,缺一会丢数据)。
  await Promise.all([
    qc.ensureQueryData<Message[]>({
      queryKey: personalChatKeys.detail(sessionId),
      queryFn: async () =>
        sanitizeForSave(normalizeLoadedChat((await bridge.loadChat(sessionId)) as LoadedChat).messages),
    }),
    ensureBranchesLoaded(qc, bridge, sessionId),
  ]);
}

// 分支组补载:自足读盘(与消息流共用 chat JSON,normalize 后只取 branchGroups)。
// gcTime Infinity 的理由见 personalBranchKeys 注释。
export async function ensureBranchesLoaded(qc: QueryClient, bridge: DesktopBridge, sessionId: string): Promise<void> {
  await qc.ensureQueryData<BranchGroup[]>({
    queryKey: personalBranchKeys.detail(sessionId),
    queryFn: async () => normalizeLoadedChat((await bridge.loadChat(sessionId)) as LoadedChat).branchGroups,
    gcTime: Infinity,
  });
}

// 分支组写入(缓存 + 节流落盘,仿 setMessages)。
export function setBranchGroups(qc: QueryClient, sessionId: string, groups: BranchGroup[]): void {
  qc.setQueryData<BranchGroup[]>(personalBranchKeys.detail(sessionId), groups);
  scheduleChatSave(qc, sessionId);
}

// 当前会话分支组(UI 分页器数据源)。queryFn 自足读盘,平时被 ensureChatLoaded/写入侧 setQueryData 喂新。
export function usePersonalBranches(sessionId: string | undefined): BranchGroup[] {
  const bridge = useDesktopBridge();
  const { data } = useQuery<BranchGroup[]>({
    queryKey: personalBranchKeys.detail(sessionId ?? "none"),
    queryFn: async () => {
      if (!bridge || !sessionId) return [];
      return normalizeLoadedChat((await bridge.loadChat(sessionId)) as LoadedChat).branchGroups;
    },
    enabled: !!sessionId,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? EMPTY_BRANCH_GROUPS;
}
const EMPTY_BRANCH_GROUPS: BranchGroup[] = [];

export function __ensureChatLoadedForTest(
  qc: QueryClient,
  bridge: DesktopBridge,
  sessionId: string,
): Promise<void> {
  return ensureChatLoaded(qc, bridge, sessionId);
}

// 流式期间每个 token 都 setQueryData 触发本 hook 重渲染;节流到一帧 ~80ms,把长会话
// 每秒数十次的列表 reconcile 降到约 12 次(终态由 trailing 帧保证与 cache 完全一致)。
// 内存关键:配合消息组件 React.memo,长会话不再每 token 全列表重渲染 + markdown 全量重解析。
const CHAT_RENDER_THROTTLE_MS = 80;

// 稳定空数组:data 为空时复用同一引用,避免每次 render 新建 [] 触发下游 memo 失效。
const EMPTY_MESSAGES: Message[] = [];

// 通用「值节流」:value 引用变化时,距上次提交满 delay 立即提交,否则排一帧 trailing。
function useThrottledValue<T>(value: T, delay: number): T {
  const [shown, setShown] = useState(value);
  const lastRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const commit = () => {
      lastRef.current = Date.now();
      setShown(value);
    };
    const since = Date.now() - lastRef.current;
    if (since >= delay) {
      commit();
    } else {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(commit, delay - since);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [value, delay]);
  return shown;
}

export function usePersonalChat(sessionId: string | undefined): PersonalChatSlice {
  const bridge = useDesktopBridge();
  const hiddenHistory = usePersonalStore(
    (s) => (sessionId ? s.sessions.find((x) => x.id === sessionId)?.hiddenHistory : undefined),
  );
  const { data } = useQuery<Message[]>({
    queryKey: personalChatKeys.detail(sessionId ?? "none"),
    // 历史消息从磁盘加载（web 端无桥,恒为空）;加载时清理瞬态状态。
    queryFn: async () => {
      if (!bridge || !sessionId) return [];
      // v2 档拆出消息数组(v1 裸数组原样透传)。
      const original = normalizeLoadedChat((await bridge.loadChat(sessionId)) as LoadedChat).messages;
      // 旧档迁移:剥离 agentLog 前先按原数组回算隐藏游标 count（throughUid 命中则无需，
      // 缺 throughUid 的 count 兜底路径会因数组变短而偏移）。一次性写回，幂等。
      maybeMigrateHiddenHistory(sessionId, original);
      return sanitizeForSave(original);
    },
    enabled: !!sessionId,
    staleTime: Infinity,
    // gcTime 继承全局默认(10min):切走的会话消息可被回收,不再永久驻留(磁盘是真相,
    // 切回时重新 loadChat)。长会话 + 多会话场景下这是内存只增不减的主因之一。
  });
  const all = data ?? EMPTY_MESSAGES;
  const shown = useThrottledValue(all, CHAT_RENDER_THROTTLE_MS);
  return useMemo(() => splitPersonalMessages(shown, hiddenHistory), [shown, hiddenHistory]);
}

// 瞬态执行过程流（agentLog 步骤 + reasoning 思考）。读 personalProcessKeys.detail(sessionId),
// 套用与消息流同款渲染节流（CHAT_RENDER_THROTTLE_MS）避免高频 tool/reasoning 每 token 触发右区
// 全量重渲（KTD7）。**不落盘、不从磁盘加载**:无 queryFn、staleTime Infinity——只被流式 setQueryData
// 写入,空集复用稳定引用。U2 接管 gcTime/保活;U4 消费此 hook 渲染右侧过程区。
export function usePersonalProcess(sessionId: string | undefined): Message[] {
  const { data } = useQuery<Message[]>({
    queryKey: personalProcessKeys.detail(sessionId ?? "none"),
    // 过程流只活在内存:不从磁盘加载（恒初始为空数组,等流式写入）。
    queryFn: () => EMPTY_MESSAGES,
    enabled: !!sessionId,
    staleTime: Infinity,
    // gcTime 显式设 Infinity,覆盖全局 10min 默认（R7/KTD8）:后台长轮会话切走后其 process query
    // 变 inactive,若沿用 10min 默认会在 pi 看门狗无上限的长轮中途被回收,切回时过程无从重现。
    // 过程流的真正回收由各清理出口的 clearProcess(removeQueries) 负责（异常终态/会话删除/切走+下一轮）,
    // 不依赖 gc——故这里设 Infinity 不会泄漏:有出口闭环兜底。
    gcTime: Infinity,
  });
  const all = data ?? EMPTY_MESSAGES;
  return useThrottledValue(all, CHAT_RENDER_THROTTLE_MS);
}

// 瞬态运行事件流(原始 CliStreamEvent,详情弹层数据源)。生命周期同 usePersonalProcess:
// 不落盘、恒初始为空、gcTime Infinity(回收由 clearRunEvents 出口闭环负责)。事件已在写入侧
// 过滤掉逐 token 增量(text/thinking),频率低,套同款渲染节流足够。
const EMPTY_RUN_EVENTS: RunEvent[] = [];
export function usePersonalRunEvents(sessionId: string | undefined): RunEvent[] {
  const { data } = useQuery<RunEvent[]>({
    queryKey: personalRunEventsKeys.detail(sessionId ?? "none"),
    queryFn: () => EMPTY_RUN_EVENTS,
    enabled: !!sessionId,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return useThrottledValue(data ?? EMPTY_RUN_EVENTS, CHAT_RENDER_THROTTLE_MS);
}

// 渲染窗口默认尺寸与每次「展开更多」步长。
export const RENDER_WINDOW_INITIAL = 20;
export const RENDER_WINDOW_STEP = 20;

export interface RenderWindow {
  rendered: Message[];
  collapsedEarlier: number;
  canExpandMore: boolean;
  expandMore: () => void;
  expandNonce: number;
  stickKey: string;
}

// 历史会话分页渲染窗口:默认只渲染 source 尾部 RENDER_WINDOW_INITIAL 条,「展开更多」每次 +STEP。
//  - resetKey 变(切会话 / /clear 游标变)→ 窗口回到尾部默认值、锚点计数归零;
//  - source 尾部追加(流式新消息)→ 窗口同步增长,避免已渲染内容被新消息挤出顶部;
//  - expandMore 递增窗口并 bump expandNonce,供 MessageStream 区分「头部插入(保锚点)」与「尾部追加(贴底)」。
// 纯视图裁剪:不改持久化与 AI 上下文,只削减 DOM 渲染与 markdown 解析量。
export function useRenderWindow(resetKey: string, source: Message[]): RenderWindow {
  const [visibleCount, setVisibleCount] = useState(RENDER_WINDOW_INITIAL);
  const [expandNonce, setExpandNonce] = useState(0);
  const prevLen = useRef(source.length);
  // 是否已收到该 resetKey 下的首批数据:首批到达(loadChat 0→N)只建基线、不当作流式追加跟随,
  // 否则异步落地的整段历史会被误判为「追加」,把窗口撑到 20+N、裁剪失效。
  const baselineReady = useRef(false);

  useEffect(() => {
    setVisibleCount(RENDER_WINDOW_INITIAL);
    setExpandNonce(0);
    baselineReady.current = false;
    prevLen.current = source.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    const len = source.length;
    if (!baselineReady.current) {
      if (len > 0) baselineReady.current = true; // 首批数据落定,建立跟随基线
      prevLen.current = len;
      return;
    }
    if (len > prevLen.current) setVisibleCount((c) => c + (len - prevLen.current));
    prevLen.current = len;
  }, [source.length]);

  const { rendered, collapsedEarlier } = useMemo(
    () => windowTailMessages(source, visibleCount),
    [source, visibleCount],
  );

  const expandMore = useCallback(() => {
    setVisibleCount((c) => c + RENDER_WINDOW_STEP);
    setExpandNonce((n) => n + 1);
  }, []);

  // 贴底信号:source 总长 + 尾部 uid。新消息追加 → 变化 → 贴底;「展开更多」只改 visibleCount(尾部不动)→ 不变。
  const tail = rendered[rendered.length - 1];
  const stickKey = `${source.length}:${tail?.uid ?? source.length}`;

  return { rendered, collapsedEarlier, canExpandMore: collapsedEarlier > 0, expandMore, expandNonce, stickKey };
}

// 编辑重发:截断到目标消息之前(目标消息本身也移除,由重发的新消息替代)。
// 找不到目标返回 null(调用方放弃操作)。
export function truncateForEdit(messages: Message[], msgUid: string): Message[] | null {
  const idx = messages.findIndex((m) => m.uid === msgUid);
  return idx < 0 ? null : messages.slice(0, idx);
}

// 同文序号:相同原文的用户消息里,目标是第几条(0-based;未找到返回 -1)。
// 用于在 CLI 会话文件中精确定位「重复发过同样内容」时要截断的那一轮。
export function sameTextOrdinal(messages: Message[], msgUid: string, text: string): number {
  return messages
    .filter((m) => m.kind === "text" && m.who === "me" && m.text === text)
    .findIndex((m) => m.uid === msgUid);
}

export interface PersonalActions {
  send: (
    session: SessionMeta,
    projectPath: string,
    text: string,
    attachments: PersonalAttachment[],
    extraSystemPrompt?: string,
    // 待发图片(粘贴/拖拽/选择;send 内逐张落盘)。
    images?: PendingImage[],
    // 已落盘图片引用(编辑重发复用原消息的图,不重新落盘)。
    presavedImages?: ChatImageRef[],
    // 待发文档(send 内逐个落盘;内容不进消息,由 agent 经 extract_document 按需读取)。
    docFiles?: PendingDocFile[],
    // U6:单发原生 skill 触发。codex 随请求落到 CliStartRequest.invokedSkill,主进程按 transport
    // 决定 ws 结构化触发 / exec prose 回退(见 cli.ts U4)；Pi 的会话产物调用复用同一元数据，
    // 在发送边界转换成 skillPaths，确保 fresh artifact run 带 --skill。
    invokedSkill?: { name: string; path: string },
    // 已落盘文档引用(编辑/刷新重发复用原消息的引用文件,不重新落盘;与 presavedImages 对称)。
    presavedDocs?: ChatFileRef[],
    // 当前会话绑定的设计/Slides 产物；有值时使用独立 cwd、run identity 与 resume 槽。
    artifact?: ConversationArtifactRef,
    // 返回是否「已消费」(真正发出/已落定):composer 据此决定是否清空待发图/文档(未消费则保留供重试)。
  ) => Promise<boolean>;
  stop: (sessionId: string) => Promise<void>;
  // pi 运行中插话:把引导注入当前轮（仅 pi 会话有效;非 pi/未运行 no-op）。
  steer: (sessionId: string, text: string) => Promise<void>;
  // pi 手动压缩上下文:对就绪会话触发一次压缩（compaction 事件回流点亮「压缩上下文…」状态;
  // 仅 pi 会话有效;非 pi/未就绪 no-op）。
  compact: (sessionId: string, customInstructions?: string) => Promise<void>;
  // pi 运行时切模型:更新会话记忆 + 会话已开则实时下发（未开仅记忆,下次 open 生效）。
  setPiModel: (session: SessionMeta, providerId: string, model: string) => void;
  // 通用思考强度:非 Pi 更新 effort;Pi 更新 thinkingLevel 并在会话已开时实时下发。
  setThinking: (session: SessionMeta, value: AgentThinkingValue) => void;
  // pi 运行时切思考强度:更新会话记忆 + 会话已开则实时下发（不重开;未开仅记忆,下次 open 经 --thinking 生效）。
  setPiThinking: (session: SessionMeta, level: ThinkingLevel) => void;
  // 编辑重发:清除目标用户消息及其后的全部消息,以新文本重新发送。
  editResend: (
    session: SessionMeta,
    projectPath: string,
    msgUid: string,
    text: string,
    attachments: PersonalAttachment[],
    artifactDispatch?: {
      extraSystemPrompt?: string;
      invokedSkill?: { name: string; path: string };
      artifact?: ConversationArtifactRef;
    },
  ) => Promise<void>;
  // /clear:默认隐藏当前历史;磁盘历史保留,重启后仍从隐藏游标后显示。
  clearView: (sessionId: string) => void;
  // 只往会话流追加一条用户消息并落盘,**不发给 agent**(见同名模块级函数的注释)。
  // 给 /skill:research 这类「活由别的引擎干、会话里只留一条痕迹」的派发用。
  appendLocalUserMessage: (session: SessionMeta, text: string) => Promise<void>;
  /// 追加一条 agent 侧的本地消息（不 spawn CLI、不改会话标题）。
  /// 用于 CRE 研究结束后把结论指针回流到发起会话，见 appendLocalAgentMessage。
  appendLocalAgentMessage: (sessionId: string, who: string, text: string) => Promise<void>;
}

export function usePersonalActions(): PersonalActions {
  const bridge = useDesktopBridge();
  const qc = useQueryClient();

  const send = useCallback<PersonalActions["send"]>(
    async (session, projectPath, text, attachments, extraSystemPrompt, images, presavedImages, docFiles, invokedSkill, presavedDocs, artifact) => {
      if (!bridge) return false;
      const hasImages = !!(images?.length || presavedImages?.length);
      const hasDocs = !!(docFiles?.length || presavedDocs?.length);
      // U6:codex `/skill:name`(无 args)时文本被收窄为空,但 invokedSkill 本身即本轮内容 →
      // 不能按「皆空」拒发,否则原生 skill 触发被静默丢弃(相较现状 prose 改写是回归)。
      if (!text.trim() && !hasImages && !hasDocs && !invokedSkill) return false; // 纯图/纯文档(无文本)允许发送;皆空才拒
      // 新一轮发送 → 清掉上一轮可能留下的运行模式拦截提示(用户已切档自动重发,或手动重发/换话题)。
      usePersonalStore.getState().setModeBlockHint(session.id, undefined);
      if (session.agent !== "pi" && usePersonalStore.getState().agentsAvailable?.[session.agent] === false) {
        await ensureChatLoaded(qc, bridge, session.id);
        appendUserMessage(
          qc,
          session.id,
          text,
          attachments,
          presavedImages?.length ? presavedImages : undefined,
          presavedDocs?.length ? presavedDocs : undefined,
        );
        appendMsg(qc, session.id, {
          kind: "text",
          who: session.agent,
          time: realHHMM(),
          text: externalAgentUnavailableMessage(session.agent),
          uid: uid("err"),
        });
        flushChat(qc, session.id);
        return false;
      }
      // 普通 Pi 对话依赖长驻 RPC；会话产物则刻意走隔离 cwd 的 fresh startCli，
      // 不应被无关的 piOpen/onPiEvent 能力门禁拦住。
      if (session.agent === "pi" && !artifact && !piRpcAvailable(bridge)) {
        await ensureChatLoaded(qc, bridge, session.id);
        // editResend 复用的已落盘图(presavedImages)仍回显,避免兜底分支静默丢图;
        // 新待发图此刻尚未落盘(imageSave 在下方),留在 composer(return false 保留)。
        appendUserMessage(
          qc,
          session.id,
          text,
          attachments,
          presavedImages?.length ? presavedImages : undefined,
          presavedDocs?.length ? presavedDocs : undefined,
        );
        appendMsg(qc, session.id, {
          kind: "text",
          who: "pi",
          time: realHHMM(),
          text: t("chat:core.piStartFailed", { message: piRpcUnavailableMessage(bridge) ?? "" }),
          uid: uid("err"),
        });
        flushChat(qc, session.id);
        return false; // 未发出 → composer 保留待发图片供重试
      }
      // pi 长驻会话:同会话已有在跑的一轮、或一轮正在启动(同步锁)时不再起新轮（pi 冷启 ~790ms
      // 窗口里 Enter 抖动/并发 send 会造孤儿 run + 永不自杀的看门狗;运行中 UI 也只应能停止/插话）。
      if (session.agent === "pi") {
        if (usePersonalStore.getState().runningBySession[session.id] || piSendStarting.has(session.id)) return false;
        piSendStarting.add(session.id);
      }

      // 图片落盘必须在 appendUserMessage / spawn 之前:逐张串行(保序)拿绝对路径组装单一真相
      // ChatImageRef[]。任一张失败 → 整轮中止(不 append、不 spawn),已落盘的前几张作孤儿随会话删除清理。
      // presavedImages(编辑重发复用的已存盘图)直接并入,不重新落盘。
      const imageRefs: ChatImageRef[] = presavedImages ? [...presavedImages] : [];
      if (images?.length) {
        if (!bridge.imageSave) {
          if (session.agent === "pi") piSendStarting.delete(session.id);
          await ensureChatLoaded(qc, bridge, session.id);
          appendMsg(qc, session.id, {
            kind: "text",
            who: session.agent,
            time: realHHMM(),
            text: t("chat:core.imageUnsupported"),
            uid: uid("err"),
          });
          flushChat(qc, session.id);
          return false;
        }
        try {
          for (const img of images) {
            const { path } = await bridge.imageSave({
              sessionId: session.id,
              fileName: img.name,
              mimeType: img.mimeType,
              data: img.data,
            });
            imageRefs.push({ path, name: img.name, mimeType: img.mimeType, width: img.width, height: img.height });
          }
        } catch (err) {
          if (session.agent === "pi") piSendStarting.delete(session.id);
          await ensureChatLoaded(qc, bridge, session.id);
          appendMsg(qc, session.id, {
            kind: "text",
            who: session.agent,
            time: realHHMM(),
            text: t("chat:core.imageSaveFailed", { error: err instanceof Error ? err.message : String(err) }),
            uid: uid("err"),
          });
          flushChat(qc, session.id);
          return false;
        }
      }
      const refs = imageRefs.length ? imageRefs : undefined;
      const cliImages = refs?.map((r) => ({ path: r.path, mimeType: r.mimeType }));
      const imagePaths = refs?.map((r) => r.path);

      // 文档落盘(在 appendUserMessage / spawn 之前):逐个经 doc:save 拿绝对路径组装 ChatFileRef[]。
      // 内容不进消息,agent 经 extract_document 按需读取。任一失败 → 整轮中止(已落盘的随会话删除清理)。
      // presavedDocs(编辑/刷新重发复用的已存盘文档)直接并入,不重新落盘。
      const fileRefs: ChatFileRef[] = presavedDocs ? [...presavedDocs] : [];
      if (docFiles?.length) {
        if (!bridge.docSave) {
          if (session.agent === "pi") piSendStarting.delete(session.id);
          await ensureChatLoaded(qc, bridge, session.id);
          appendMsg(qc, session.id, {
            kind: "text",
            who: session.agent,
            time: realHHMM(),
            text: t("chat:core.docUnsupported"),
            uid: uid("err"),
          });
          flushChat(qc, session.id);
          return false;
        }
        try {
          for (const d of docFiles) {
            const { path, sizeBytes } = await bridge.docSave({
              sessionId: session.id,
              fileName: d.name,
              mimeType: d.mimeType,
              srcPath: d.srcPath,
              data: d.data,
            });
            fileRefs.push({ path, name: d.name, mimeType: d.mimeType, sizeBytes });
          }
        } catch (err) {
          if (session.agent === "pi") piSendStarting.delete(session.id);
          await ensureChatLoaded(qc, bridge, session.id);
          appendMsg(qc, session.id, {
            kind: "text",
            who: session.agent,
            time: realHHMM(),
            text: t("chat:core.docSaveFailed", { error: err instanceof Error ? err.message : String(err) }),
            uid: uid("err"),
          });
          flushChat(qc, session.id);
          return false;
        }
      }
      const docRefs = fileRefs.length ? fileRefs : undefined;

      const runId = artifact
        ? `artifact:${artifact.kind}:${artifact.documentId}:${uid("run")}`
        : uid("run");
      const typingUid = uid("typing");

      // 历史尚未加载时先加载,避免首条写入把磁盘历史盖掉。
      await ensureChatLoaded(qc, bridge, session.id);

      // 开始新一轮即清上一轮保留的过程流（R8/KTD4 的「下一轮即清」保留边界;CLI 与 pi 同此入口）,
      // 否则新轮的 tool/reasoning 会追加在旧轮已收起的步骤之后。
      clearProcess(qc, session.id);

      appendUserMessage(qc, session.id, text, attachments, refs, docRefs);
      appendMsg(qc, session.id, {
        kind: "typing",
        who: session.agent,
        text: typingText(session.agent, "starting", 0),
        uid: typingUid,
      });

      const attachmentPrompt = buildAttachmentSystemPrompt(attachments);
      const docPrompt = docRefs ? buildDocFilesSystemPrompt(docRefs) : undefined;
      const globalAppend = buildGlobalAppend();
      // 会话内前置检索（可选，默认关）：需要「该会话开了联网」+ 全局「总是先检索再回答」两者
      // 同时成立，才在每轮发送前先联网抓一次资料并注入 system prompt。
      // **必须在这里 await 而不是并进 buildGlobalAppend**：后者是同步函数，被三处调用，
      // 改成异步会波及整条发送链路；而检索本身只在 chat 的这一个发送点需要。
      // 失败/超时静默降级（见 retrieveChatEvidence 的注释），绝不阻断本轮发送。
      const evidenceAppend = await retrieveChatEvidence({
        gather: bridge.research?.gather?.bind(bridge.research),
        settings: usePersonalStore.getState().generalSettings.researchEngine,
        sessionWebSearch: session.webSearch === true,
        query: text,
      });
      // 组装顺序:全局指令/语言(U3/U4,三端统一) → 项目信息(Spotlight) → 文档清单;皆空仍传 undefined。
      // 附件块刻意不在此列:claude --resume / codex exec resume 只回放对话历史,不回放上一轮 system
      // prompt,附件走 append 只在拖入那一轮生效,续轮 skill 指令即丢失 → 经 buildTurnPromptText 并入
      // prompt 文本随历史持久。
      // 证据段排在最后：它是本轮一次性资料，优先级低于全局指令与记忆（那两者是长期约束）。
      const appendSystemPrompt =
        [globalAppend, extraSystemPrompt, docPrompt, evidenceAppend].filter(Boolean).join("\n\n") ||
        undefined;
      // pi 例外:RPC 长驻会话,注入前缀随进程内历史持久,维持既有「附件并入 append 前缀」行为
      // (buildPiPromptMessage);其编辑重发定位(piEntryMatchesText 后缀匹配)已覆盖该形态。
      const piAppendSystemPrompt =
        [globalAppend, extraSystemPrompt, attachmentPrompt, docPrompt, evidenceAppend]
          .filter(Boolean)
          .join("\n\n") || undefined;
      // claude/codex 单发与编排:附件块前缀进 prompt 文本(run.promptText / 显示层仍存原始 text)。
      const cliText = buildTurnPromptText(text, attachmentPrompt);

      // 委派（delegate）@mention 优先级高于 pi 专有路径：消息含 @mention 时任何 agent 都走单发
      // startCli + delegate 工具注入（主 agent 经 ask_<id> 自主委派），不走 pi RPC。提前检测以避免
      // pi 分支 return 后再也走不到 delegate 注入。
      const earlyMentions = parseMentions(text, usePersonalStore.getState().roles);
      const hasDelegateMentions = earlyMentions.length > 0 && !!bridge.startCli;
      // 三段编排开关（claude/codex/pi 通用，12790c0 起 pi 也参与）:开启后走下面统一 orchestrate 管线。
      const useOrchestration = !artifact && session.subagentOrchestration && bridge.startOrchestration;

      // pi 走 RPC 长驻会话（steer/abort/fork);claude/codex 仍走下面单发 startCli 管线。有 @mention 委派
      // 或开启三段编排时,pi 也改走下面单发/编排管线（per-turn delegate 工具集 / 编排各段都需 fresh
      // spawn，RPC 工具集在 pi:open 时冻结无法逐轮变化）。
      if (session.agent === "pi" && !artifact && !hasDelegateMentions && !useOrchestration) {
        await sendPiTurn(qc, bridge, session, projectPath, text, piAppendSystemPrompt, { runId, typingUid }, imagePaths);
        return true;
      }
      // pi 委派路径不走 sendPiTurn → piSendStarting 锁必须立即释放，
      // 否则该 session 后续所有 send 都被 line 2162 守卫静默拒绝。
      if (session.agent === "pi") piSendStarting.delete(session.id);

      const run: RunState = {
        sessionId: session.id,
        agent: session.agent,
        typingUid,
        cursor: emptyFoldCursor(),
        processCursor: emptyProcessCursor(),
        sawText: false,
        buffer: "",
        gotResult: false,
        phase: "starting",
        lastEventAt: Date.now(),
        promptText: text,
        startedAt: Date.now(),
        cwd: artifact?.workspaceRoot ?? projectPath,
        artifactResumeKey: artifact ? artifactResumeKey(session, artifact) : undefined,
        nestedRoleEvents: !!artifact,
        // 派生后的访问范围:供 restrictedToolForMode/maybeEmitModeBlockHint 判断受限工具与切档提示。
        // session/sendSession 仅差 agentSessionId 清理 patch（不触权限两轴），故据 session 派生即可。
        permissionMode: toAdapterPermissions(session.execPermission, session.dirPermission).permissionMode,
      };
      runs.set(runId, run);
      // 看门狗:每秒刷新 typing 等待时长;启动/静默超时则杀进程并提示重试。
      run.watchdog = setInterval(() => {
        const cur = runs.get(runId);
        if (!cur) return;
        const silent = Date.now() - cur.lastEventAt;
        const limit = cur.phase === "starting" ? RUN_START_TIMEOUT_MS : RUN_STALL_TIMEOUT_MS;
        if (!cur.gotResult && silent >= limit) {
          // 核心路径埋点（U7）:看门狗超时（启动/静默）属终态失败,经注入 logger 记录以便排查
          //（仅观测,不改回收/超时控制逻辑;web 端 bridgeRef=null 安全 no-op）。
          void bridgeRef?.logMessage?.(
            "warn",
            `[personal:watchdog] timeout agent=${cur.agent} phase=${cur.phase} silentMs=${silent} limitMs=${limit} orchestrated=${!!cur.orchestrated}`,
          );
          stopWatchdog(cur);
          runs.delete(runId);
          dropMsg(qc, cur.sessionId, cur.typingUid);
          clearTransient(qc, cur.sessionId);
          clearProcess(qc, cur.sessionId); // 立即清空出口（watchdog 超时，KTD8）。
          appendMsg(qc, cur.sessionId, {
            kind: "text",
            who: cur.agent,
            time: realHHMM(),
            text:
              cur.phase === "starting"
                ? t("chat:core.startTimeout", { secs: Math.round(limit / 1000), name: AGENT_NAME[cur.agent] })
                : t("chat:core.stallTimeout", { secs: Math.round(limit / 1000) }),
            uid: uid("err"),
          });
          usePersonalStore.getState().setRunning(cur.sessionId, undefined);
          if (cur.orchestrated) cancelPendingPiUiForSession(bridge, cur.sessionId);
          usePetStore.getState().set("idle");
          flushChat(qc, cur.sessionId);
          // 深化:启动/静默超时属终态失败,回落该 session 的 deepening 闪记（普通会话 no-op）。
          void applyDeepenFinalize(bridge, {
            sessionId: cur.sessionId,
            cwd: cur.cwd,
            terminalFailure: true,
          });
          // 编排/圆桌轮走各自 kill 通道（子进程在主进程独立注册表，cli:kill 杀不到，会留孤儿进程）。
          // 用 send 入参 bridge（闭包内可见,与相邻 applyDeepenFinalize/stop 路径一致;bridgeRef 仅 pi 事件
          // 挂载后才有值,watchdog 里不可靠）。
          if (cur.roundtable) void bridge.killRoundtable?.(runId);
          else if (cur.orchestrated) void bridge.killOrchestration?.(runId);
          else void bridge.killCli(runId);
          return;
        }
        // 仍在等首个输出:typing 占位上滚动显示已等待时长。
        if (!cur.cursor.lastKind && !cur.gotResult && cur.startedAt) {
          updateTypingMsg(qc, cur.sessionId, cur.typingUid, typingText(cur.agent, cur.phase, Date.now() - cur.startedAt));
        }
      }, 1000);
      usePersonalStore.getState().setRunning(session.id, runId);
      if (session.agent === "pi") piSendStarting.delete(session.id); // Pi 编排轮已进入 runs/running 管线。
      usePetStore.getState().set("thinking");

      try {
        const resumeKey = artifact ? artifactResumeKey(session, artifact) : undefined;
        let resumeSessionId = resumeKey
          ? session.artifactSessionIds?.[resumeKey]
          : sessionResumeId(session);
        let sendSession = session;
        if (resumeSessionId && bridge.agentSessionExists) {
          const exists = await bridge.agentSessionExists({ agent: session.agent, agentSessionId: resumeSessionId });
          if (!exists) {
            const patch = resumeKey
              ? clearArtifactSessionPatch(session, resumeKey)
              : clearAgentSessionPatch(session, session.agent);
            usePersonalStore.getState().updateSession(session.id, patch);
            sendSession = { ...session, ...patch };
            resumeSessionId = undefined;
          }
        }

        // 执行/目录两轴 → 线格式:发送边界唯一派生点,编排(段2)与单发(claude/codex)两路共用。
        // adapter 据此翻译成各 CLI 原生标志;exec=plan→{plan,auto},否则 dir 定范围、exec 定审批。
        const adapterPerm = toAdapterPermissions(sendSession.execPermission, sendSession.dirPermission);
        // 派生 agent(U7):spawn 用 derivedAgentId(后端 getAgentDef 按 id 解析),失效则回退 base(见
        // resolveSpawnAgentId 的 RISK-3 兜底)。
        const spawnAgent = resolveSpawnAgentId(sendSession, usePersonalStore.getState().derivedAgents);
        // 子 agent 编排（U1）：会话开关开启、bridge 支持、且本轮无 @mention 委派时，走主进程三段编排
        // （意图理解→子 agent 执行→二次加工，见 orchestrate.ts）。claude/codex/pi 通用——pi 经
        // buildPiOpenForSession 提供 piOpen（含 --skill/cwd 路径闸/审批等）。delegate @mention 优先级更高,落 else 单发。
        // 编排无状态、各段 fresh spawn，故不传 resumeSessionId；看门狗/stop 据 run.orchestrated 改走 killOrchestration。
        // 已知限制：本版编排不透传图片（images 仅单发支持）。
        // 路由判断收敛到 isOrchestrationSend(code review 修复):PersonalChatArea.tsx 的 skill 派发
        // 也据此函数判断走原生调用还是 prose 回退,单一来源避免两处条件手工同步、静默漂移。
        // bridge.startOrchestration 的 truthy 已经过 isOrchestrationSend 的 hasStartOrchestration 参数
        // 校验,但 TS 无法跨函数边界做该窄化,故此处补一次直接判空(不改变判断逻辑,只为类型收窄)。
        if (
          isOrchestrationSend(sendSession.subagentOrchestration, !!bridge.startOrchestration, hasDelegateMentions) &&
          bridge.startOrchestration
        ) {
          run.orchestrated = true;
          const isPiOrchestration = sendSession.agent === "pi";
          const piOpen = isPiOrchestration ? await buildPiOpenForSession(bridge, sendSession, projectPath) : undefined;
          // 跨 agent skill 注入(U2):claude/codex 用 prose 注入;Pi 用 --skill 路径注入(piOpen.skillPaths),
          // 不双注入(R3)。
          const skillBlock = isPiOrchestration
            ? undefined
            : renderSkillBlock(
                await resolveEnabledSkillRecords(bridge, projectPath, sendSession.useOwnSkills, sendSession.agent),
              );
          const appendWithSkills =
            [appendSystemPrompt, skillBlock].filter(Boolean).join("\n\n") || undefined;
          await bridge.startOrchestration({
            orchestrationRunId: runId,
            sessionId: sendSession.id,
            agent: isPiOrchestration ? "pi" : spawnAgent,
            cwd: artifact?.workspaceRoot ?? projectPath,
            // 编排各段 fresh spawn 无历史,附件块随 prompt 文本直达(cliText)。
            prompt: cliText,
            model: sendSession.model,
            effort: sendSession.effort,
            // 仅段2透传：让子 agent 真实执行尊重会话执行/目录权限，并带 skills/附件/项目上下文。
            permissionMode: adapterPerm.permissionMode,
            approvalPolicy: adapterPerm.approvalPolicy,
            appendSystemPrompt: appendWithSkills,
            piOpen,
          });
        } else {
          // 跨 agent skill 注入:普通 Pi 对话已在上面 sendPiTurn return；会话产物 Pi 为隔离 cwd /
          // resume 槽而走本 fresh startCli 分支。派发(U5):claude 走原生目录发现，codex 走 prose +
          // invokedSkill，Pi 走 skillPaths；三路互斥，避免重复注入。
          const enabledSkillRecords = await resolveEnabledSkillRecords(
            bridge,
            projectPath,
            sendSession.useOwnSkills,
            sendSession.agent,
          );
          const { appendWithSkills, skillRecords, skillPaths } = buildSingleSendSkillInjection(
            sendSession.agent,
            appendSystemPrompt,
            enabledSkillRecords,
            {
              useOwnSkills: sendSession.useOwnSkills,
              ...(artifact && invokedSkill ? { artifactSkill: invokedSkill } : {}),
            },
          );
          // 委派（delegate，@mention 触发）：主 agent 单发 startCli + 注入 cortex-delegate 工具集，
          // 经 ask_<id> 自主委派给被 @ 的协作者。子 agent 事件带 roleId（渲染端 roleHeader 分隔），
          // 取消/超时走标准 killCli（主 agent 在 running map；onExit→abort 收口在途子 agent）。
          if (hasDelegateMentions) {
            run.delegate = true;
            run.roleCursors = new Map();
          }
          // Pi 只要走 fresh startCli（@mention 委派或隔离产物）都必须继承当前供应商；否则即使
          // 普通长驻会话已配置 API key，fresh 进程仍会退回 Pi 默认 provider 并报未登录。
          let piProvider:
            | { id: string; baseUrl: string; apiKey?: string; models: { id: string; name?: string }[] }
            | undefined;
          let resolvedModel = sendSession.model;
          if (sendSession.agent === "pi") {
            const ps = usePersonalStore.getState().providerSettings;
            const p = ps.providers.find((x) => x.id === (sendSession.providerId ?? ps.defaultProviderId) && x.enabled);
            resolvedModel = sendSession.model ?? ps.defaultModel ?? p?.models[0]?.id;
            piProvider = p
              ? { id: p.id, baseUrl: p.baseUrl, apiKey: p.apiKey, models: p.models.map((m) => ({ id: m.id, name: m.label })) }
              : undefined;
          }
          // 委派引导（system prompt）：告知主 agent 本轮可委派的协作者 + task 必须自包含
          //（子 agent 是独立进程，看不到主 agent 当前对话上下文，凡未写进 task 的信息都拿不到）。
          const delegateGuide = hasDelegateMentions
            ? `本轮你可以把子任务委派给以下协作者（调用对应的 ask_ 工具），它们各自独立执行并把结果返回给你供你整合：` +
              earlyMentions.map((m) => `「${m.role.label}」`).join("、") +
              `。重要：协作者是独立进程，看不到你当前对话的任何上下文——委派时必须在 task 参数里写清完整任务，并附上它所需的全部数据/材料。`
            : undefined;
          const appendWithDelegate =
            [appendWithSkills, delegateGuide].filter(Boolean).join("\n\n") || undefined;
          await bridge.startCli({
            runId,
            sessionId: sendSession.id,
            agent: spawnAgent,
            cwd: artifact?.workspaceRoot ?? projectPath,
            // 附件块前缀进 prompt(cliText):随 claude/codex CLI 会话历史持久,续轮 resume 仍可见。
            prompt: cliText,
            ...(artifact ? { artifactContext: artifact } : {}),
            model: resolvedModel,
            effort: sendSession.effort,
            // 委派 fresh spawn，不续接（per-turn 独立编排）；普通对话照常 resume。
            resumeSessionId: hasDelegateMentions ? undefined : resumeSessionId,
            appendSystemPrompt: appendWithDelegate,
            useOwnSkills: sendSession.useOwnSkills,
            skillPaths,
            // U5:claude 走原生目录发现时把已启用 skill 记录交主进程建桥接目录(U2);codex 为 undefined
            // (走上面 appendWithSkills 的 prose 注入,无目录桥接)。
            skillRecords,
            // U6:codex 单发原生 skill 触发(发送侧解析 /skill:name 命中时填入)。主进程按 transport
            // 决定 ws 结构化触发 / exec prose 回退(cli.ts U4);claude/pi 及非 skill 发送恒 undefined。
            invokedSkill: sendSession.agent === "codex" ? invokedSkill : undefined,
            images: cliImages,
            // 执行/目录权限派生的线格式:claude/codex adapter 翻译成原生标志;缺省 full-auto/auto(历史默认)。
            // 逐轮 fresh spawn,改值下一轮即生效,无需重开。
            permissionMode: adapterPerm.permissionMode,
            approvalPolicy: adapterPerm.approvalPolicy,
            // 委派：本轮被 @ 的协作者 → cli.ts 据此 per-turn 注册 ask_<id> 工具集（claude/codex 经
            // builtinServers；pi 阶段2 另生成桥接）。无 @mention 时 undefined，正常单发。
            delegateRoles: hasDelegateMentions ? earlyMentions.map((m) => m.role) : undefined,
            // 会话级联网:主进程据此决定是否注入研究引擎 MCP（web_search / web_read）。
            // 逐轮 fresh spawn,改开关下一轮即生效,无需重开。
            webSearch: sendSession.webSearch === true,
            // Pi fresh 单发的 provider（生成 provider extension）；claude/codex 为 undefined。
            provider: piProvider,
          });
        }
        // 主对话 spawn 成功后再异步生成标题（CLI 缺失时不会白跑）。
        autoTitle(bridge, sendSession, text);
      } catch (err) {
        handleCliExit(qc, runId, null, err instanceof Error ? err.message : String(err));
      }
      return true; // 用户消息 + 图片已落定(spawn 失败也已提示),视为已消费 → composer 清空待发图
    },
    [bridge, qc],
  );

  const editResend = useCallback<PersonalActions["editResend"]>(
    async (session, projectPath, msgUid, text, attachments, artifactDispatch) => {
      if (!bridge || !text.trim()) return;
      // 运行中不允许编辑历史(先停止再说),避免与流式写入打架。
      if (usePersonalStore.getState().runningBySession[session.id]) return;
      await ensureChatLoaded(qc, bridge, session.id);
      const prev = qc.getQueryData<Message[]>(personalChatKeys.detail(session.id)) ?? [];
      const truncatedRaw = truncateForEdit(prev, msgUid);
      if (truncatedRaw === null) return;
      // 截断写回缓存前先 sanitize:旧档残留的 agentLog/reasoning 若随 truncated 写回会在中栏「闪回」
      // 工具步骤(过程已外移右侧浮层、且不落盘,中栏不应再现)。sanitize 后中栏只剩问答正文。
      // 注:trimAgentSession 的「编辑首条 → 清空」判定仍用清洗后的 truncated 长度——清洗只剥离瞬态/过程
      // 块,不改变「编辑点前是否有真实问答」的语义。
      const truncated = sanitizeForSave(truncatedRaw);
      // editResend **不走** clearTransient（KTD8 单独处理）:它被 running 守卫(:1951),不存在「运行中
      // 过程残留」,故截断前显式清掉上一轮收起的残留过程入口（避免旧轮过程入口在新一轮前误闪现）。
      clearProcess(qc, session.id);
      // 历史被截断重写 → 运行事件流与新历史不再对应,整条清掉重新累积。
      clearRunEvents(qc, session.id);
      // 复用被编辑消息自身的已落盘图片/文档引用(不重新落盘、不删旧文件),随重发带回 agent——
      // 修复「编辑重发丢引用文件」:文档经 presavedDocs 通道原样带回,doc system prompt 会重新注入。
      const editedMsg = prev.find((m) => m.uid === msgUid);
      const originalImages = editedMsg?.kind === "text" ? editedMsg.images : undefined;
      const originalFiles = editedMsg?.kind === "text" ? editedMsg.files : undefined;

      // pi:在 pi 侧 fork 到分支点（替代 trimAgentSession 截断会话文件）,再以新文本重发。
      // 映射失败/会话未开 → best-effort 退化:只截断 UI + 重发;不再把降级细节写进聊天正文。
      if (session.agent === "pi") {
        // 防御性:editResend 因 :1525 running 守卫在待答期不可达,但万一卡已 resolve 仍有残留,fork 前清掉,
        // 避免旧轮卡串入新轮（覆盖「卡已 resolve、新一轮未起」的窗口）。
        usePersonalStore.getState().clearPiUiForSession(session.id);
        const forked = await forkPiAtEditedMessage(bridge, session.id, prev, msgUid).catch(() => false);
        // truncated 已过 sanitizeForSave，旧的报错提示（含历史 piForkFailed）已被剥离，无需再单独清理。
        qc.setQueryData<Message[]>(personalChatKeys.detail(session.id), truncated);
        flushChat(qc, session.id);
        let sendSession = session;
        if (!forked) {
          await closePiSession(bridge, session.id);
          usePersonalStore.getState().setPiRuntime(session.id, undefined);
          usePersonalStore.getState().updateSession(session.id, { piSessionFile: undefined });
          sendSession = { ...session, piSessionFile: undefined };
        }
        await send(
          sendSession,
          projectPath,
          text,
          attachments,
          artifactDispatch?.extraSystemPrompt,
          undefined,
          originalImages,
          undefined,
          artifactDispatch?.invokedSkill,
          originalFiles,
          artifactDispatch?.artifact,
        );
        return;
      }

      // 同步清理 agent 侧记忆,让它和 UI 一致:
      // - 编辑的是第一条 → 直接丢弃 resume id,重开全新会话(记忆天然干净);
      // - 否则尽力截断 CLI 会话文件中该轮及其后内容(.bak 备份;按原文+同文序号
      //   严格匹配,失败则静默退化为带旧记忆 resume)。
      let sendSession = session;
      const original = prev.find((m) => m.uid === msgUid);
      const originalText = original?.kind === "text" && typeof original.text === "string" ? original.text : undefined;
      const resumeId = sessionResumeId(session);
      if (truncated.length === 0) {
        const patch = clearAgentSessionPatch(session, session.agent);
        usePersonalStore.getState().updateSession(session.id, patch);
        sendSession = { ...session, ...patch };
      } else if (resumeId && originalText && bridge.trimAgentSession) {
        await bridge
          .trimAgentSession({
            agent: session.agent,
            agentSessionId: resumeId,
            promptText: originalText,
            occurrence: sameTextOrdinal(prev, msgUid, originalText),
          })
          .catch(() => false);
      }

      qc.setQueryData<Message[]>(personalChatKeys.detail(session.id), truncated);
      flushChat(qc, session.id);
      await send(
        sendSession,
        projectPath,
        text,
        attachments,
        artifactDispatch?.extraSystemPrompt,
        undefined,
        originalImages,
        undefined,
        artifactDispatch?.invokedSkill,
        originalFiles,
        artifactDispatch?.artifact,
      );
    },
    [bridge, qc, send],
  );

  const stop = useCallback<PersonalActions["stop"]>(
    async (sessionId) => {
      const store = usePersonalStore.getState();
      const runId = store.runningBySession[sessionId];
      if (!bridge || !runId) return;
      const session = store.sessions.find((x) => x.id === sessionId);
      const r = runs.get(runId);
      if (r?.orchestrated) {
        cancelPendingPiUiForSession(bridge, sessionId);
        await bridge.killOrchestration?.(runId);
      } else if (session?.agent === "pi") {
        // 待答的 askquestion/confirm 卡:abort **不会** reject pi 端 ctx.ui 的 await（rpc-mode 仅在传 signal
        // 时挂 abort 监听）,故停止前必须对该会话每张待答卡显式回 {cancelled} 解锁 pi 的 execute 并出队,
        // 否则残卡 + pi 永久 await。待答期 stop 是唯一可达的中断路径（editResend 被 running 守卫挡住）。
        cancelPendingPiUiForSession(bridge, sessionId);
        // pi:优雅打断当前轮（不杀长驻进程;收尾由 error/result 事件驱动,下面 4 秒兜底复位）。
        // try/catch 兼顾同步抛（会话未就绪）与异步拒（会话已退出）,均靠兜底复位 UI。
        try {
          await abortPi(bridge, sessionId);
        } catch {
          /* 会话未就绪/已退出,忽略,靠下面兜底 */
        }
      } else {
        // 编排/圆桌轮走各自 kill 通道（独立注册表）；普通单发走 killCli。
        const r = runs.get(runId);
        if (r?.roundtable) await bridge.killRoundtable?.(runId);
        else if (r?.orchestrated) await bridge.killOrchestration?.(runId);
        else await bridge.killCli(runId);
      }
      // 兜底:若 4 秒内没收到收尾事件（进程早已不在/事件丢失）,强制复位 UI。
      // 仅当本次捕获的 runId 仍是当前轮才清,且只删该 runId（不扫该会话全部 run,避免误掐
      // 期间已开的新一轮）。
      setTimeout(() => {
        const store = usePersonalStore.getState();
        if (store.runningBySession[sessionId] === runId) {
          const r = runs.get(runId);
          if (r) {
            stopRunTimers(r);
            runs.delete(runId);
          }
          store.setRunning(sessionId, undefined);
          store.setPiRuntime(sessionId, undefined);
          clearTransient(qc, sessionId);
          clearProcess(qc, sessionId); // 立即清空出口（stop 4s 兜底，KTD8）。
          flushChat(qc, sessionId);
        }
      }, 4000);
    },
    [bridge, qc],
  );

  const steer = useCallback<PersonalActions["steer"]>(
    async (sessionId, text) => {
      if (!bridge || !text.trim()) return;
      const session = usePersonalStore.getState().sessions.find((x) => x.id === sessionId);
      if (session?.agent !== "pi") return;
      // 会话尚未就绪（冷启 ~790ms 窗口）时不回显也不注入:否则会留一条 pi 永不响应的孤立气泡。
      if (!isPiSessionOpen(sessionId)) return;
      // 把插话作为用户消息回显（让会话能看到注入了什么）,再注入当前轮;队列计数由 queue 事件回显。
      appendMsg(qc, sessionId, { kind: "text", who: "me", time: realHHMM(), text, uid: uid("u") });
      touchPiSession(bridge, sessionId); // 阶段4:插话 = 活跃。
      try {
        await steerPi(bridge, sessionId, text);
      } catch {
        /* 会话已退出:忽略 */
      }
    },
    [bridge, qc],
  );

  // 手动压缩上下文:仅对就绪 pi 会话生效（未就绪由 UI 禁用项 + tooltip 引导）。压缩中由 compaction
  // start/end 事件点亮 PersonalTopBar 的「压缩上下文…」chip;完成/失败都补一条可读反馈消息——
  // 否则短会话 pi 抛「Nothing to compact」被吞,用户只觉得「点了没反应」。
  const compact = useCallback<PersonalActions["compact"]>(
    async (sessionId, customInstructions) => {
      if (!bridge) return;
      const session = usePersonalStore.getState().sessions.find((x) => x.id === sessionId);
      if (session?.agent !== "pi") return;
      if (!isPiSessionOpen(sessionId)) return; // 未开/未就绪 → 无活跃会话可压缩（UI 已禁用并提示）
      touchPiSession(bridge, sessionId); // 压缩 = 活跃,重置空闲计时
      try {
        await compactPi(bridge, sessionId, customInstructions);
        appendMsg(qc, sessionId, { kind: "text", who: "pi", time: realHHMM(), text: "✅ 已压缩上下文", uid: uid("pi") });
      } catch (e) {
        // 压缩失败给可读反馈:上下文过短 / 已压缩 / 其它错误。不再静默吞。
        const raw = e instanceof Error ? e.message : String(e);
        const text = /nothing to compact/i.test(raw)
          ? "ℹ️ 无需压缩：当前上下文较短"
          : /already compacted/i.test(raw)
            ? "ℹ️ 当前已是压缩后的上下文"
            : `压缩失败：${raw}`;
        appendMsg(qc, sessionId, { kind: "text", who: "pi", time: realHHMM(), text, uid: uid("err") });
      }
      flushChat(qc, sessionId);
    },
    [bridge, qc],
  );

  const setPiModel = useCallback<PersonalActions["setPiModel"]>(
    (session, providerId, model) => {
      const prev = { providerId: session.providerId, model: session.model };
      usePersonalStore.getState().updateSession(session.id, { providerId, model });
      // 会话已开 → 实时切换（pi 长驻进程无需重启）;未开仅记忆,下次 open 即用新模型。
      // 实时下发失败不再静默吞:回滚会话记忆 + 提示,避免「UI 显新模型、pi 实际仍旧模型」漂移。
      if (session.agent === "pi" && bridge && isPiSessionOpen(session.id)) {
        void setModelPi(bridge, session.id, providerId, model).catch(() => {
          usePersonalStore.getState().updateSession(session.id, prev);
          appendMsg(qc, session.id, {
            kind: "text",
            who: "pi",
            time: realHHMM(),
            text: t("chat:core.switchModelFailed"),
            uid: uid("err"),
          });
        });
      }
    },
    [bridge, qc],
  );

  const setPiThinking = useCallback<PersonalActions["setPiThinking"]>(
    (session, level) => {
      const prev = { thinkingLevel: session.thinkingLevel };
      usePersonalStore.getState().updateSession(session.id, { thinkingLevel: level });
      // 会话已开 → 运行时切档（不重启,不进指纹）;未开仅记忆,下次 open 经 --thinking 生效。
      // 下发失败回滚 + 提示,避免「UI 显新档、pi 实际仍旧档」漂移。
      if (session.agent === "pi" && bridge && isPiSessionOpen(session.id)) {
        void setThinkingLevelPi(bridge, session.id, level).catch(() => {
          usePersonalStore.getState().updateSession(session.id, prev);
          appendMsg(qc, session.id, {
            kind: "text",
            who: "pi",
            time: realHHMM(),
            text: t("chat:core.switchThinkingFailed"),
            uid: uid("err"),
          });
        });
      }
    },
    [bridge, qc],
  );

  const setThinking = useCallback<PersonalActions["setThinking"]>(
    (session, value) => {
      if (session.agent === "pi") {
        setPiThinking(session, value as ThinkingLevel);
        return;
      }
      usePersonalStore.getState().updateSession(session.id, mapThinkingForAgent(session.agent, value));
    },
    [setPiThinking],
  );

  const clearView = useCallback<PersonalActions["clearView"]>(
    (sessionId) => {
      const messages = qc.getQueryData<Message[]>(personalChatKeys.detail(sessionId)) ?? [];
      usePersonalStore.getState().updateSession(sessionId, { hiddenHistory: createHiddenHistory(messages) });
    },
    [qc],
  );

  // 无桥（Web 端）时静默 no-op：与本文件其它动作同一约定，调用方不必先判桥。
  const appendLocal = useCallback<PersonalActions["appendLocalUserMessage"]>(
    async (session, text) => {
      if (!bridge) return;
      await appendLocalUserMessage(qc, bridge, session, text);
    },
    [bridge, qc],
  );

  const appendLocalAgent = useCallback<PersonalActions["appendLocalAgentMessage"]>(
    async (sessionId, who, text) => {
      if (!bridge) return;
      await appendLocalAgentMessage(qc, bridge, sessionId, who, text);
    },
    [bridge, qc],
  );

  return {
    send,
    stop,
    steer,
    compact,
    setPiModel,
    setThinking,
    setPiThinking,
    editResend,
    clearView,
    appendLocalUserMessage: appendLocal,
    appendLocalAgentMessage: appendLocalAgent,
  };
}
