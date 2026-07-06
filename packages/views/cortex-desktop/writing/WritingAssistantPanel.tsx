// 写作工作区右栏:写作助手面板。一个自足的对话回合承载体——
//   顶栏:新建会话 / 会话切换下拉 + 当前文件相对路径;
//   时间线:渲染 run-manager 折叠出的轻量消息(user/assistant/tool/system);
//   空态三卡:总结当前文档 / 拟一个大纲 / 润色选中文本(点击填输入框、不自动发;润色无选区禁用);
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
  DEFAULT_MODEL,
  resolveDefaultAgent,
  usePersonalStore,
  useDesktopBridge,
} from "@cortex-work/core";
import type {
  AgentKind,
  CliStartRequest,
  DerivedAgentMeta,
  ProviderSettings,
} from "@cortex-work/core";
import type { WritingSpacesState } from "@cortex-work/core/writing/spaces";
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
import { AgentSelect } from "../personal/AgentSelect";
import { MarkdownView } from "../personal/MarkdownView";
import { useDismissableMenu } from "../personal/useDismissableMenu";

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
  onToast?: (msg: string) => void;
}

// 按选定 agent 解析发送用的 model / provider:pi 从 providerSettings 取默认供应商 + 其模型并拍平
// 传给主进程(与新会话落地页 draftDefaultsForAgent 同源);其余内置 agent 用各自 DEFAULT_MODEL、无 provider。
function resolveAgentDispatch(
  agent: AgentKind,
  providerSettings: ProviderSettings,
): { model?: string; provider?: CliStartRequest["provider"] } {
  if (agent !== "pi") {
    return { model: DEFAULT_MODEL[agent] };
  }
  const enabled = providerSettings.providers.filter((p) => p.enabled);
  const provider = enabled.find((p) => p.id === providerSettings.defaultProviderId) ?? enabled[0];
  if (!provider) return {}; // 未配置 pi 供应商:交由主进程回退/报错
  const model =
    provider.models.find((m) => m.id === providerSettings.defaultModel)?.id ?? provider.models[0]?.id;
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

export function WritingAssistantPanel({
  space,
  activeFilePath,
  selection,
  hasPendingReview = false,
  onFlushBeforeSend,
  onToast,
}: Props): ReactElement {
  const bridge = useDesktopBridge();
  const agentsAvailable = usePersonalStore((s) => s.agentsAvailable);
  const derivedAgents = usePersonalStore((s) => s.derivedAgents);
  const generalSettings = usePersonalStore((s) => s.generalSettings);
  const providerSettings = usePersonalStore((s) => s.providerSettings);

  const spaceId = space?.id ?? null;

  // ── composer 本地态 ──────────────────────────────────────────────────
  const [input, setInput] = useState("");
  const [quotes, setQuotes] = useState<WritingQuote[]>([]);
  // 选定 agent(始终存内置 base)+ 派生 id(选派生时)。初值取用户默认 agent。
  const [agent, setAgent] = useState<AgentKind>(() =>
    resolveDefaultAgent({ generalSettings, agentsAvailable }),
  );
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

  const removeQuote = useCallback((id: string): void => {
    setQuotes((prev) => prev.filter((q) => q.id !== id));
  }, []);

  const onChangeAgent = useCallback((a: AgentKind, derived?: DerivedAgentMeta): void => {
    setAgent(derived?.base ?? a);
    setDerivedAgentId(derived?.id);
  }, []);

  const newConversation = useCallback((): void => {
    if (!spaceId) return;
    createThread(spaceId);
    setInput("");
    setQuotes([]);
    threadMenu.setOpen(false);
  }, [spaceId, createThread, threadMenu]);

  // 最新态走 ref,避免 doSend 依赖频繁变化的闭包(发送是异步多步,期间不重建回调)。
  const stateRef = useRef({ input, quotes, agent, derivedAgentId, space, activeFilePath });
  stateRef.current = { input, quotes, agent, derivedAgentId, space, activeFilePath };

  // 发送一个回合:拼 prompt → flush 编辑器 → sendWritingMessage。成功后清输入框与引用条。
  const doSend = useCallback(async (): Promise<void> => {
    const { input: curInput, quotes: curQuotes, agent: curAgent, space: curSpace, activeFilePath: curFile } =
      stateRef.current;
    if (!curSpace) return;
    const body = curInput.trim();
    if (!body && curQuotes.length === 0) return;
    // 二次防御:门控在按钮 disabled 已拦,这里兜底(异步期间态可能变化)。
    if (hasPendingReview || busy) return;

    const thread = ensureActiveThread(curSpace.id);
    // 首条消息:用用户正文派生会话标题(空正文不改,保留默认名)。
    const existing = useWritingRunStore.getState().messagesByThread[thread.id] ?? [];
    if (existing.length === 0 && body) setThreadTitle(thread.id, deriveThreadTitle(body));

    const prompt = composeWritingPrompt(body, curQuotes, {
      workspaceRoot: curSpace.root,
      activeFilePath: curFile,
    });
    // 关键时序:先 flush 编辑器自动保存,再起 run —— 否则 agent 读到旧盘面,改动基线错位。
    try {
      await onFlushBeforeSend?.();
    } catch (err) {
      onToast?.(`保存当前文件失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const dispatch = resolveAgentDispatch(curAgent, providerSettings);
    const ok = await sendWritingMessage({
      spaceId: curSpace.id,
      threadId: thread.id,
      cwd: curSpace.root,
      prompt,
      displayText: body || "(仅引用片段)",
      agent: curAgent,
      ...(dispatch.model ? { model: dispatch.model } : {}),
      ...(dispatch.provider ? { provider: dispatch.provider } : {}),
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
      {/* 顶栏:会话切换下拉 + 新建会话 + 当前文件路径 */}
      <div className="pw-wa-head">
        <div className="pw-wa-head-row">
          <div className="pw-tb-menu-wrap" ref={threadMenu.wrapRef}>
            <button
              type="button"
              className="pw-wa-thread-pill"
              aria-haspopup="menu"
              aria-expanded={threadMenu.open}
              onClick={() => threadMenu.setOpen((v) => !v)}
              title="切换会话"
            >
              <Icon.Sparkle size={14} />
              <span className="pw-wa-thread-title">{activeThread?.title ?? "写作助手"}</span>
              <span className={`pw-sh-chev ${threadMenu.open ? "is-open" : ""}`}>
                <Icon.Chevron size={11} />
              </span>
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
            <Icon.Plus size={15} />
          </button>
        </div>
        <div className="pw-wa-file" title={activeFilePath ?? undefined}>
          {fileLabel}
        </div>
      </div>

      {/* 时间线 / 空态三卡 */}
      <div className="pw-wa-body">
        {showEmptyState ? (
          <div className="pw-wa-empty">
            <div className="pw-wa-empty-card">
              <div className="pw-wa-empty-icon">
                <Icon.Sparkle size={18} />
              </div>
              <h3 className="pw-wa-empty-title">写作助手</h3>
              <p className="pw-wa-empty-sub">让 agent 直接改稿,改动以行级红绿 diff 逐块审阅。</p>
            </div>
            <div className="pw-wa-cards">
              <button
                type="button"
                className="pw-wa-card"
                onClick={() => fillPrompt(`请总结当前文档《${fileLabel}》的主要内容与结构。`)}
              >
                <span className="pw-wa-card-t">总结当前文档</span>
                <span className="pw-wa-card-s">快速把握全文要点</span>
              </button>
              <button
                type="button"
                className="pw-wa-card"
                onClick={() => fillPrompt(`请为当前文档《${fileLabel}》拟一个结构清晰的大纲。`)}
              >
                <span className="pw-wa-card-t">拟一个大纲</span>
                <span className="pw-wa-card-s">先搭骨架再填内容</span>
              </button>
              {/* 润色:无选区禁用(R10);点击引用选区并填入润色 prompt(不自动发)。 */}
              <button
                type="button"
                className="pw-wa-card"
                disabled={!hasSelection}
                title={hasSelection ? undefined : "先在编辑器里选中一段文字"}
                onClick={() => {
                  quoteSelection();
                  fillPrompt("请润色我选中的这段文字,保持原意、让表达更流畅。");
                }}
              >
                <span className="pw-wa-card-t">润色选中文本</span>
                <span className="pw-wa-card-s">
                  {hasSelection ? "打磨措辞与节奏" : "选中文字后可用"}
                </span>
              </button>
            </div>
          </div>
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
                  {q.lineStart != null && q.lineEnd != null ? ` · ${q.lineStart}-${q.lineEnd}行` : ""}
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
          placeholder="让写作助手改稿…Enter 发送 · Shift+Enter 换行"
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
          <AgentSelect
            agent={agent}
            derivedAgentId={derivedAgentId}
            agentsAvailable={agentsAvailable}
            derivedAgents={derivedAgents}
            onSwitch={onChangeAgent}
            menuPlacement="up"
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

// 单条消息渲染:user/assistant 走文本(assistant 用 Markdown),tool 显示名+状态,system 显示错误。
function WritingMessageRow({ message }: { message: WritingMessage }): ReactElement {
  if (message.role === "user") {
    return (
      <div className="pw-wa-msg is-user">
        <div className="pw-wa-msg-body">{message.displayText ?? message.text}</div>
      </div>
    );
  }
  if (message.role === "assistant") {
    return (
      <div className="pw-wa-msg is-assistant">
        <div className="pw-wa-msg-body pw-note-md">
          <MarkdownView content={message.text} />
        </div>
      </div>
    );
  }
  if (message.role === "tool") {
    return (
      <div className="pw-wa-msg is-tool" data-status={message.status}>
        <Icon.Terminal size={12} />
        <span className="pw-wa-tool-name">{message.name}</span>
        {message.status === "running" ? <span className="pw-wa-tool-dot">运行中</span> : null}
      </div>
    );
  }
  // system(错误)
  return (
    <div className="pw-wa-msg is-system" data-severity={message.severity}>
      {message.text}
    </div>
  );
}
