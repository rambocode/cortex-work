// 写作工作区右栏:写作助手面板(布局对齐 Kun WriteAssistantPanel)。一个自足的对话回合承载体——
//   顶栏:折叠按钮 + 「写作助手」标题 pill + 会话历史(文件夹图标下拉)+ 新建会话;下行为当前文件 pill;
//   时间线:渲染 run-manager 折叠出的轻量消息(user/assistant/tool/system);
//   空态:待命卡置顶 + 固定三卡贴底(总结/大纲/润色,见 WritingEmptyState);
//   引用条:编辑器选区快照 chip(创建时冻结文本+行号,可移除);
//   composer:textarea + 发送/中断 + AgentSelect(claude/codex/pi)。
//
// 后端复用 cortex 既有 CLI 管线:发送 = composeWritingPrompt 拼装 → 先调 U5 flush 钩子(确保 agent
// 读到最新盘面)→ sendWritingMessage(runId=writing:<spaceId>:*、sessionId=writing-<threadId>、
// resume 续接)。存在未处理审阅(hasPendingReview)或本空间有回合在跑(busy)时禁发(R13/R14)。
//
// 本组件为受控壳:space/activeFilePath/selection 由 WritingWorkspace(U9)注入;input/quotes/agent
// 等 composer 态在内部自持。会话目录走 useWritingThreadsStore,消息镜像走 useWritingRunStore。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  AGENT_MODELS,
  DEFAULT_AGENT_THINKING,
  DEFAULT_MODEL,
  agentThinkingOptions,
  mapThinkingForAgent,
  resolveDefaultAgent,
  usePersonalStore,
  useDesktopBridge,
} from "@cortex-work/core";
import type {
  AgentKind,
  AgentThinkingValue,
  CliStartRequest,
  DerivedAgentMeta,
  ProviderSettings,
} from "@cortex-work/core";
import type { WritingSpacesState } from "@cortex-work/core/writing/spaces";
import { useWritingSpacesStore } from "@cortex-work/core/writing/spaces";
import {
  builtinQuickActionText,
  resolveWritingQuickActions,
  type ResolvedWritingQuickAction,
} from "@cortex-work/core/writing/quick-actions";
import type {
  WritingRetrievalContext,
  WritingRetrievalRequest,
} from "@cortex-work/core/desktop/writing-retrieval-types";
import type { DesktopBridge } from "@cortex-work/core/desktop/bridge";
import {
  cancelRunsForSpace,
  getResumeSessionId,
  installWritingRuntime,
  sendWritingMessage,
  useWritingRunStore,
  type WritingMessage,
} from "@cortex-work/core/writing/run/writing-run-manager";
import {
  deriveThreadTitle,
  useWritingThreadsStore,
} from "@cortex-work/core/writing/threads";
import {
  composeWritingPrompt,
  quoteFromSelection,
  relativeWritingPath,
  type WritingQuote,
  type WritingSelectionSnapshot,
} from "@cortex-work/core/writing/prompt";
import { Icon } from "@cortex-work/ui/icons";
// 顶栏图标用 lucide-react,与写作模块其余组件(WritingToolbar/WritingSidebar)对齐 Kun 的惯例一致。
import { FolderOpen, PanelRightClose, Plus, Sparkles } from "lucide-react";
import { AgentSelect } from "../personal/AgentSelect";
import { ModelThinkingPill } from "../personal/ModelThinkingPill";
import { useDismissableMenu } from "../personal/useDismissableMenu";
import { WritingEmptyState } from "./WritingEmptyState";
import { WritingMessageRow } from "./WritingMessageRow";

type WritingSpace = WritingSpacesState["spaces"][number];

// 稳定空数组:消息选择器无会话时回落此引用,避免每次渲染新建数组触发无谓 re-render。
const EMPTY_MESSAGES: WritingMessage[] = [];

interface Props {
  // 当前活跃写作空间(id + root + name);null 表示尚未选空间。
  space: WritingSpace | null;
  // 当前编辑器打开文件绝对路径(用于上下文相对路径与引用来源);null 表示无打开文件。
  activeFilePath: string | null;
  // 当前编辑器选区快照(U9 注入):有文本时润色卡/引用按钮可用。缺省/空 = 无选区。
  selection?: WritingSelectionSnapshot | null;
  // 是否有未处理的 diff 审阅(U6);为 true 时禁发新回合(R13)。U6 就绪前由上层传 false。
  hasPendingReview?: boolean;
  // 发送前 flush 编辑器自动保存(U5 命令式钩子);确保 agent 起跑时读到最新盘面。
  onFlushBeforeSend?: () => Promise<void> | void;
  // edit 类快捷指令:对当前选区就地改写(→ 编辑器红绿 diff 审阅)。返回结果供面板提示。
  onRunInlineEdit?: (instruction: string) => Promise<{ ok: boolean; reason?: string }>;
  onToast?: (msg: string) => void;
  // 折叠右栏(顶栏折叠按钮,对齐 Kun PanelRightClose);由 WritingWorkspace 注入。
  onCollapse?: () => void;
}

// 面板层的模型选择覆盖(ModelThinkingPill 持久化的选择;缺省走各 agent 默认)。
interface AgentDispatchOverride {
  model?: string; // claude/codex:AGENT_MODELS value;pi:供应商模型 id
  piProviderId?: string; // pi 模型所属供应商 id(与 model 配对)
}

// 按选定 agent 解析发送用的 model / provider:优先面板选择(override),回落默认——
// pi 从 providerSettings 取(override 供应商 → 默认供应商 → 首个启用)并拍平传主进程
// (与新会话落地页 draftDefaultsForAgent 同源);其余内置 agent 用 override.model ?? DEFAULT_MODEL。
function resolveAgentDispatch(
  agent: AgentKind,
  providerSettings: ProviderSettings,
  override?: AgentDispatchOverride,
): { model?: string; provider?: CliStartRequest["provider"] } {
  if (agent !== "pi") {
    // 面板选择可能是旧档脏值(不在 AGENT_MODELS 中):校验后回落默认。
    const valid = AGENT_MODELS[agent].some((m) => m.value === override?.model);
    return { model: valid ? override!.model : DEFAULT_MODEL[agent] };
  }
  const enabled = providerSettings.providers.filter((p) => p.enabled);
  const provider =
    enabled.find((p) => p.id === override?.piProviderId) ??
    enabled.find((p) => p.id === providerSettings.defaultProviderId) ??
    enabled[0];
  if (!provider) return {}; // 未配置 pi 供应商:交由主进程回退/报错
  const model =
    provider.models.find((m) => m.id === override?.model)?.id ??
    provider.models.find((m) => m.id === providerSettings.defaultModel)?.id ??
    provider.models[0]?.id;
  return {
    ...(model ? { model } : {}),
    provider: {
      id: provider.id,
      baseUrl: provider.baseUrl,
      ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
      // provider 模型展示名字段在设置里叫 label,拍平进主进程 DTO 的 name。
      models: provider.models.map((m) => ({ id: m.id, ...(m.label ? { name: m.label } : {}) })),
    },
  };
}

// 检索注入参数(U4):top-k 片段数 + 硬超时。检索是「锦上添花」,不得拖慢发送,故 2s 未回即放弃。
const RETRIEVAL_TOP_K = 4;
const RETRIEVAL_TIMEOUT_MS = 2_000;

// 带超时的检索:成功回 context(可为 null),失败/超时/无 bridge 一律回 null → 静默不注入(R6)。
// 任何异常都吞掉:检索绝不能阻断或报错打断发送回合。
async function retrieveContextWithTimeout(
  bridge: DesktopBridge | null,
  req: WritingRetrievalRequest,
): Promise<WritingRetrievalContext | null> {
  if (!bridge?.writingRetrieve || !req.root || !req.query.trim()) return null;
  const call = bridge.writingRetrieve(req);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), RETRIEVAL_TIMEOUT_MS));
  try {
    const result = await Promise.race([call, timeout]);
    if (!result || result.ok !== true) return null;
    return result.context;
  } catch {
    return null;
  }
}

export function WritingAssistantPanel({
  space,
  activeFilePath,
  selection,
  hasPendingReview = false,
  onFlushBeforeSend,
  onRunInlineEdit,
  onToast,
  onCollapse,
}: Props): ReactElement {
  const bridge = useDesktopBridge();
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const derivedAgents = usePersonalStore((s) => s.derivedAgents);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const providerSettings = usePersonalStore((s) => s.providerSettings);

  // 检索上下文开关(U4,跨空间共享,持久化在 spaces store)。UI 入口已移到写作设置节(单一真源),
  // 面板不再放快捷开关;此处仅读值供发送时的检索注入门控。
  const retrievalEnabled = useWritingSpacesStore((s) => s.retrievalEnabled);
  // 选中工具栏「快捷指令」配置(空态建议卡 + 选区动作从此渲染)。
  const quickActions = useWritingSpacesStore((s) => s.quickActions);
  // 助手 composer 选择记忆(跨空间共享,持久化):按 agent 的模型/思考强度 + pi 供应商。
  const assistantAgent = useWritingSpacesStore((s) => s.assistantAgent);
  const modelByAgent = useWritingSpacesStore((s) => s.assistantModelByAgent);
  const thinkingByAgent = useWritingSpacesStore((s) => s.assistantThinkingByAgent);
  const piProviderId = useWritingSpacesStore((s) => s.assistantPiProviderId);
  const setAssistantAgent = useWritingSpacesStore((s) => s.setAssistantAgent);
  const setAssistantModel = useWritingSpacesStore((s) => s.setAssistantModel);
  const setAssistantThinking = useWritingSpacesStore((s) => s.setAssistantThinking);

  const spaceId = space?.id ?? null;

  // ── composer 本地态 ──────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const [quotes, setQuotes] = useState<WritingQuote[]>([]);
  // 选定 agent(始终存内置 base)+ 派生 id(选派生时)。初值优先上次持久化选择,否则用户默认 agent。
  const [agent, setAgent] = useState<AgentKind>(() => {
    const remembered = assistantAgent as AgentKind | null;
    if (remembered && remembered in DEFAULT_MODEL) return remembered;
    return resolveDefaultAgent({ generalSettings, agentsAvailable });
  });
  const [derivedAgentId, setDerivedAgentId] = useState<string | undefined>(undefined);

  const threadMenu = useDismissableMenu();

  // ── 会话目录(threads store)────────────────────────────────────────
  const threads = useWritingThreadsStore((s) => s.threads);
  const activeThreadId = useWritingThreadsStore((s) =>
    spaceId ? (s.activeThreadBySpace[spaceId] ?? null) : null,
  );
  const createThread = useWritingThreadsStore((s) => s.createThread);
  const ensureActiveThread = useWritingThreadsStore((s) => s.ensureActiveThread);
  const setActiveThread = useWritingThreadsStore((s) => s.setActiveThread);
  const setThreadTitle = useWritingThreadsStore((s) => s.setThreadTitle);
  const setThreadResume = useWritingThreadsStore((s) => s.setThreadResume);

  // 该空间的会话列表(倒序);当前会话对象。
  const spaceThreads = useMemo(
    () =>
      spaceId
        ? threads.filter((t) => t.spaceId === spaceId).sort((a, b) => b.updatedAt - a.updatedAt)
        : [],
    [threads, spaceId],
  );
  const activeThread = spaceThreads.find((t) => t.id === activeThreadId) ?? null;

  // ── 运行态镜像 ──────────────────────────────────────────────────────
  const messages = useWritingRunStore((s) =>
    activeThreadId ? (s.messagesByThread[activeThreadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  // 本空间是否有回合在跑(busy):>0 即忙碌。用于发送/中断门控(per-space,R14)。
  const busy = useWritingRunStore((s) => (spaceId ? (s.runningBySpace[spaceId] ?? 0) > 0 : false));

  // 装配写作运行时(幂等):bridge 就绪即订阅 writing: 前缀 CLI 事件。sendWritingMessage 依赖它。
  useEffect(() => {
    installWritingRuntime(bridge);
  }, [bridge]);

  // 进入空间时确保有活跃会话(无则建默认),使时间线/发送有归属 thread。
  useEffect(() => {
    if (spaceId) ensureActiveThread(spaceId);
  }, [spaceId, ensureActiveThread]);

  // 同步 run-manager 捕获到的 agent 真实 sessionId 进持久化会话目录(供重启后续接)。
  // 依赖 messages 变化触发(init 事件后 resume 才落定);仅在与已存不同时写,避免无谓更新。
  useEffect(() => {
    if (!activeThread) return;
    const resume = getResumeSessionId(activeThread.id);
    if (resume && resume !== activeThread.resumeSessionId) {
      setThreadResume(activeThread.id, resume);
    }
  }, [messages, activeThread, setThreadResume]);

  // 当前文件的相对展示路径(顶栏 + 上下文用);无文件回落占位。
  const fileLabel = useMemo(() => {
    if (!activeFilePath) return "未打开文件";
    return relativeWritingPath(space?.root ?? "", activeFilePath);
  }, [activeFilePath, space?.root]);

  const hasSelection = !!selection && selection.charCount > 0;
  // 发送门控:无空间 / 忙碌 / 有未处理审阅 / (无正文且无引用) 时不可发。
  const canSend =
    !!space && !busy && !hasPendingReview && (input.trim().length > 0 || quotes.length > 0);

  // ── 交互 ────────────────────────────────────────────────────────────
  // 三卡:把预置 prompt 追加进输入框(不自动发;已有内容则空行拼接)。
  const fillPrompt = useCallback((prompt: string): void => {
    setInput((prev) => (prev.trim() ? `${prev.trim()}\n\n${prompt}` : prompt));
  }, []);

  // 引用当前选区:冻结成 chip 追加进引用条(快照语义,后续文档变动不影响已建引用)。
  const quoteSelection = useCallback((): void => {
    if (!space || !activeFilePath || !selection) return;
    const quote = quoteFromSelection(selection, activeFilePath, space.root);
    if (!quote) return;
    setQuotes((prev) => [...prev, quote]);
  }, [space, activeFilePath, selection]);

  // 解析出可渲染的快捷指令(禁用项过滤、内置留空补 i18n 默认文案)。
  const resolvedActions = useMemo(
    () => resolveWritingQuickActions(quickActions, builtinQuickActionText),
    [quickActions],
  );

  // 派发一条快捷指令:
  //   edit → 对当前选区就地改写(需有选区;→ 红绿 diff 审阅);无 onRunInlineEdit 或失败给 toast。
  //   chat → 有选区则引用选区,再把 prompt 填进输入框(不自动发,沿用现行为)。
  const runQuickAction = useCallback(
    (action: ResolvedWritingQuickAction): void => {
      if (action.mode === "edit") {
        if (!hasSelection) {
          onToast?.("先在编辑器里选中一段文字");
          return;
        }
        void (async () => {
          const res = (await onRunInlineEdit?.(action.prompt)) ?? { ok: false, reason: "no-editor" };
          if (res.ok) return;
          const hint =
            res.reason === "mode"
              ? "就地改写请在源码/实时预览模式下使用"
              : res.reason === "unconfigured"
                ? "未配置写作模型,无法就地改写(见 设置 → 写作)"
                : res.reason === "same" || res.reason === "empty"
                  ? "模型未给出有效改写"
                  : `改写失败：${res.reason ?? ""}`;
          onToast?.(hint);
        })();
        return;
      }
      // chat:有选区先引用,再填入 prompt。
      if (hasSelection) quoteSelection();
      fillPrompt(action.prompt);
    },
    [hasSelection, onRunInlineEdit, onToast, quoteSelection, fillPrompt],
  );

  const removeQuote = useCallback((id: string): void => {
    setQuotes((prev) => prev.filter((q) => q.id !== id));
  }, []);

  const onChangeAgent = useCallback(
    (a: AgentKind, derived?: DerivedAgentMeta): void => {
      const base = derived?.base ?? a;
      setAgent(base);
      setDerivedAgentId(derived?.id);
      setAssistantAgent(base); // 持久化 agent 选择(重启后恢复)
    },
    [setAssistantAgent],
  );

  // ── 模型 + 思考强度 pill 推导(与 personal/ComposerShell 同构)────────────
  const isPi = agent === "pi";
  const agentModels = AGENT_MODELS[agent];
  const thinkingOptions = useMemo(() => agentThinkingOptions(agent), [agent]);
  // 思考强度:pi 回退全局 piThinkingDefault(与实际生效值一致),其余回退 default 档。
  const storedThinking = thinkingByAgent[agent] as AgentThinkingValue | undefined;
  const resolvedThinkingValue: AgentThinkingValue = isPi
    ? (storedThinking ?? generalSettings.piThinkingDefault ?? "off")
    : (storedThinking ?? DEFAULT_AGENT_THINKING);
  // pi 模型下拉:已启用 provider 的模型拍平为 `${providerId}::${modelId}` 选项。
  const piModelOptions = useMemo(
    () =>
      isPi
        ? providerSettings.providers
            .filter((p) => p.enabled)
            .flatMap((p) => p.models.map((m) => ({ value: `${p.id}::${m.id}`, label: m.label ?? m.id })))
        : [],
    [isPi, providerSettings],
  );
  // pill 展示值与发送实际生效值同源:经 resolveAgentDispatch 解析(选择缺失/脏值回落默认)。
  const piDispatchPreview = useMemo(
    () =>
      isPi
        ? resolveAgentDispatch("pi", providerSettings, {
            model: modelByAgent["pi"],
            ...(piProviderId ? { piProviderId } : {}),
          })
        : null,
    [isPi, providerSettings, modelByAgent, piProviderId],
  );
  const piModelValue = `${piDispatchPreview?.provider?.id ?? ""}::${piDispatchPreview?.model ?? ""}`;

  const onChangeModel = useCallback(
    (model: string): void => setAssistantModel(agent, model),
    [agent, setAssistantModel],
  );
  const onChangePiModel = useCallback(
    (provId: string, model: string): void => setAssistantModel("pi", model, provId),
    [setAssistantModel],
  );
  const onChangeThinking = useCallback(
    (value: AgentThinkingValue): void => setAssistantThinking(agent, value),
    [agent, setAssistantThinking],
  );

  const newConversation = useCallback((): void => {
    if (!spaceId) return;
    createThread(spaceId);
    setInput("");
    setQuotes([]);
    threadMenu.setOpen(false);
  }, [spaceId, createThread, threadMenu]);

  // 最新态走 ref,避免 doSend 依赖频繁变化的闭包(发送是异步多步,期间不重建回调)。
  // 含检索开关与 bridge:发送时按最新值决定是否检索注入(检索能力/开关随时可变);
  // 含模型/思考强度选择:发送时按最新 pill 选择解析 dispatch。
  const stateRef = useRef({
    input, quotes, agent, derivedAgentId, space, activeFilePath, retrievalEnabled, bridge,
    modelByAgent, thinkingByAgent, piProviderId,
  });
  stateRef.current = {
    input, quotes, agent, derivedAgentId, space, activeFilePath, retrievalEnabled, bridge,
    modelByAgent, thinkingByAgent, piProviderId,
  };

  // 发送一个回合:拼 prompt → flush 编辑器 → sendWritingMessage。成功后清输入框与引用条。
  const doSend = useCallback(async (): Promise<void> => {
    const {
      input: curInput,
      quotes: curQuotes,
      agent: curAgent,
      space: curSpace,
      activeFilePath: curFile,
      retrievalEnabled: curRetrievalEnabled,
      bridge: curBridge,
      modelByAgent: curModelByAgent,
      thinkingByAgent: curThinkingByAgent,
      piProviderId: curPiProviderId,
    } = stateRef.current;
    if (!curSpace) return;
    const body = curInput.trim();
    if (!body && curQuotes.length === 0) return;
    // 二次防御:门控在按钮 disabled 已拦,这里兜底(异步期间态可能变化)。
    if (hasPendingReview || busy) return;

    const thread = ensureActiveThread(curSpace.id);
    // 首条消息:用用户正文派生会话标题(空正文不改,保留默认名)。
    const existing = useWritingRunStore.getState().messagesByThread[thread.id] ?? [];
    if (existing.length === 0 && body) setThreadTitle(thread.id, deriveThreadTitle(body));

    // 检索上下文(U4):开关开启且有正文时,以用户正文查询 top-k 片段注入 prompt。
    // 超时/失败/无命中一律回 null → 静默不注入,绝不阻断发送(见 retrieveContextWithTimeout)。
    const retrieval =
      curRetrievalEnabled && body
        ? await retrieveContextWithTimeout(curBridge, {
            root: curSpace.root,
            query: body,
            k: RETRIEVAL_TOP_K,
          })
        : null;

    const prompt = composeWritingPrompt(body, curQuotes, {
      workspaceRoot: curSpace.root,
      activeFilePath: curFile,
      retrieval,
    });
    // 关键时序:先 flush 编辑器自动保存,再起 run —— 否则 agent 读到旧盘面,改动基线错位。
    try {
      await onFlushBeforeSend?.();
    } catch (err) {
      onToast?.(`保存当前文件失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // 模型:优先面板 pill 选择(脏值在 resolveAgentDispatch 内校验回落);
    // 思考强度:mapThinkingForAgent 映射(claude/codex → effort;pi 无 effort 通道,不透传)。
    const dispatch = resolveAgentDispatch(curAgent, providerSettings, {
      model: curModelByAgent[curAgent],
      ...(curPiProviderId ? { piProviderId: curPiProviderId } : {}),
    });
    const { effort } = mapThinkingForAgent(
      curAgent,
      curThinkingByAgent[curAgent] as AgentThinkingValue | undefined,
    );
    const ok = await sendWritingMessage({
      spaceId: curSpace.id,
      threadId: thread.id,
      cwd: curSpace.root,
      prompt,
      displayText: body || "(仅引用片段)",
      agent: curAgent,
      ...(dispatch.model ? { model: dispatch.model } : {}),
      ...(dispatch.provider ? { provider: dispatch.provider } : {}),
      ...(effort ? { effort } : {}),
    });
    if (ok) {
      setInput("");
      setQuotes([]);
    }
  }, [
    hasPendingReview,
    busy,
    ensureActiveThread,
    setThreadTitle,
    onFlushBeforeSend,
    providerSettings,
    onToast,
  ]);

  // 中断:只 kill 本空间的写作 run(其它空间与 design run 不受影响)。
  const doInterrupt = useCallback((): void => {
    if (spaceId) void cancelRunsForSpace(spaceId);
  }, [spaceId]);

  // Enter 发送 / Shift+Enter 换行。
  const onComposerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        if (canSend) void doSend();
      }
    },
    [canSend, doSend],
  );

  const showEmptyState = messages.length === 0;

  return (
    <aside className="pw-writing-assistant">
      {/* 顶栏(对齐 Kun):折叠 | 「写作助手」标题 pill | 会话历史(文件夹)| 新建会话;下行为文件 pill */}
      <div className="pw-wa-head">
        <div className="pw-wa-head-row">
          <button
            type="button"
            className="pw-wa-icon-btn"
            title="收起写作助手"
            aria-label="收起写作助手"
            onClick={onCollapse}
            disabled={!onCollapse}
          >
            <PanelRightClose size={16} strokeWidth={1.85} />
          </button>
          <div className="pw-wa-title-pill">
            <Sparkles size={15} strokeWidth={1.8} />
            <span className="pw-wa-title-text">写作助手</span>
          </div>
          {/* 会话历史下拉:Kun 此处是「更换 AI 工作目录」;cortex 空间管理在左栏,
              该位置映射为会话历史入口(原 thread pill 下拉迁移至此)。 */}
          <div className="pw-tb-menu-wrap" ref={threadMenu.wrapRef}>
            <button
              type="button"
              className={`pw-wa-icon-btn${threadMenu.open ? " is-active" : ""}`}
              title="会话历史"
              aria-label="会话历史"
              aria-haspopup="menu"
              aria-expanded={threadMenu.open}
              onClick={() => threadMenu.setOpen((v) => !v)}
              disabled={!space}
            >
              <FolderOpen size={16} strokeWidth={1.85} />
            </button>
            {threadMenu.open ? (
              <div className="pw-tb-menu pw-wa-thread-menu" role="menu">
                {spaceThreads.length === 0 ? (
                  <div className="pw-wa-thread-empty">暂无会话</div>
                ) : (
                  spaceThreads.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="menuitem"
                      className="pw-tb-menu-item"
                      onClick={() => {
                        if (spaceId) setActiveThread(spaceId, t.id);
                        threadMenu.setOpen(false);
                      }}
                    >
                      <span className="pw-wa-thread-menu-title">{t.title}</span>
                      {t.id === activeThreadId ? <Icon.Check size={13} /> : null}
                    </button>
                  ))
                )}
                <div className="pw-wa-thread-menu-foot">
                  <button type="button" className="pw-tb-menu-item" onClick={newConversation}>
                    <Icon.Plus size={13} />
                    <span>新建会话</span>
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="pw-wa-icon-btn"
            title="新建会话"
            aria-label="新建会话"
            onClick={newConversation}
            disabled={!space}
          >
            <Plus size={16} strokeWidth={2.1} />
          </button>
        </div>
        <div className="pw-wa-file" title={activeFilePath ?? undefined}>
          {fileLabel}
        </div>
      </div>

      {/* 时间线 / 空态三卡 */}
      <div className="pw-wa-body">
        {showEmptyState ? (
          // 空态对齐 Kun:待命卡置顶 + 固定三卡(总结/大纲/润色)贴底;其余快捷指令
          // 属于选区操作,由下方选区 chip 条(有选区即显示)承载,不进空态卡。
          <WritingEmptyState actions={resolvedActions} onRun={runQuickAction} />
        ) : (
          <div className="pw-wa-timeline">
            {messages.map((m) => (
              <WritingMessageRow key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>

      {/* composer:引用条 + 输入框 + 工具栏(引用选区 / AgentSelect / 发送·中断)*/}
      <div className="pw-wa-composer">
        {/* 选区动作条:有选区即显示全部快捷指令 chip(edit 就地改写 / chat 引用+填入)。
            空态也显示——空态卡已收敛为固定三卡,explain/reformat 等选区操作靠此条可达。 */}
        {hasSelection && resolvedActions.length > 0 ? (
          <div className="pw-wa-selbar" role="group" aria-label="选区快捷指令">
            {resolvedActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="pw-wa-selchip"
                title={action.mode === "edit" ? "就地改写(红绿 diff 审阅)" : "引用选中并填入指令"}
                onClick={() => runQuickAction(action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
        {hasPendingReview ? (
          <div className="pw-wa-blocked" role="alert">
            有未处理的改动审阅,请先接受或拒绝后再发送。
          </div>
        ) : null}
        {quotes.length > 0 ? (
          <div className="pw-wa-quotes">
            {quotes.map((q) => (
              <div key={q.id} className="pw-wa-quote">
                <Icon.Comment size={13} />
                <span className="pw-wa-quote-label">
                  {q.sourceTitle}
                  {q.sourceKind === "pdf" && q.pageStart != null
                    ? ` · 第${q.pageEnd != null && q.pageEnd !== q.pageStart ? `${q.pageStart}-${q.pageEnd}` : q.pageStart}页`
                    : q.lineStart != null && q.lineEnd != null
                      ? ` · ${q.lineStart}-${q.lineEnd}行`
                      : ""}
                </span>
                <button
                  type="button"
                  className="pw-wa-quote-x"
                  title="移除引用"
                  aria-label="移除引用"
                  onClick={() => removeQuote(q.id)}
                >
                  <Icon.Trash size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          className="pw-wa-input"
          value={input}
          placeholder="向智能体提问…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onComposerKeyDown}
          rows={3}
        />
        <div className="pw-wa-toolbar">
          <button
            type="button"
            className="pw-wa-icon-btn"
            title="引用当前选区"
            aria-label="引用当前选区"
            onClick={quoteSelection}
            disabled={!hasSelection}
          >
            <Icon.Comment size={15} />
          </button>
          {/* 检索开关已移入「设置 → 写作 → 写作建议 → 参考其他文档」(单一入口,对齐 Kun);
              此处不再放快捷开关。检索仍在发送时按 retrievalEnabled 注入(见 doSend)。 */}
          <AgentSelect
            agent={agent}
            derivedAgentId={derivedAgentId}
            agentsAvailable={agentsAvailable}
            derivedAgents={derivedAgents}
            onSwitch={onChangeAgent}
            menuPlacement="up"
          />
          {/* 模型 + 思考强度 pill(对齐 Kun「<模型> 超高」形态;cortex 无 max 档,最高「高」)。
              切 agent 后自动按新 agent 读各自的模型集与记忆值。 */}
          <ModelThinkingPill
            isPi={isPi}
            models={agentModels}
            model={modelByAgent[agent]}
            onChangeModel={onChangeModel}
            piModelOptions={piModelOptions}
            piModelValue={piModelValue}
            onChangePiModel={onChangePiModel}
            thinkingOptions={thinkingOptions}
            resolvedThinkingValue={resolvedThinkingValue}
            onChangeThinking={onChangeThinking}
            disabled={isPi ? piModelOptions.length === 0 : agentModels.length === 0}
          />
          <div className="spacer" />
          {busy ? (
            <button
              type="button"
              className="pw-wa-send is-stop"
              title="中断"
              aria-label="中断"
              onClick={doInterrupt}
            >
              <Icon.Stop size={15} />
            </button>
          ) : (
            <button
              type="button"
              className="pw-wa-send"
              title="发送"
              aria-label="发送"
              disabled={!canSend}
              onClick={() => void doSend()}
            >
              <Icon.Send size={15} />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

