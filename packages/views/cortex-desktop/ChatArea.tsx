import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Icon } from "@cortex-work/ui/icons";
import { whoMeta, useDesktopBridge, usePersonalProfile, usePersonalStore, type TurnProcessArchive } from "@cortex-work/core";
import { usePiArtifactsStore } from "@cortex-work/core/store/piArtifacts";
import { SandboxedIframe } from "./personal/chat/artifacts/SandboxedIframe";
import { MarkdownView } from "./personal/markdown/MarkdownView";
import { petActivity } from "@cortex-work/core/pet";
import { useTranslation } from "@cortex-work/core/i18n";
import type { Contact, Conversation, Message } from "@cortex-work/core/types";
import { renderRich } from "./rich";
import { getToolRenderer } from "./personal/chat/toolRenderers/registry";
import { chatMarkdownComponents, chatMarkdownUrlTransform } from "./personal/chat/chatMarkdown";
import { normalizeKnowledgeLinks } from "./personal/knowledge/KnowledgeDocRef";
import { ChatImages } from "./personal/chat/ChatImages";
import { ChatFiles } from "./personal/chat/ChatFiles";
import { SubagentCardMessage } from "./personal/chat/SubagentCardMessage";
import { ConversationProcessTimeline } from "./personal/chat/ConversationProcessTimeline";
import { UserMessageContent } from "./personal/chat/userMessageCollapse";

// 会话流的语法高亮插件。必须是模块级常量:TextMessage 被 memo 包裹,内联字面量每次渲染都是新引用,
// 会让 <Markdown> 的 props 恒变、白费 memo 短路(长会话流式输出时代价明显)。
// ignoreMissing:未注册语言原样保留,不报错、不吞内容(与 MarkdownView 口径一致)。
const MD_REHYPE_PLUGINS: import("react-markdown").Options["rehypePlugins"] = [
  [rehypeHighlight, { ignoreMissing: true }],
];

function ChatHeader({ contact, convo }: { contact: Contact; convo: Conversation | null | undefined }) {
  const { t } = useTranslation("chat");
  const isShared = contact.group === "shared";
  const isGroup = contact.group === "groups";
  const isMe = contact.id === "me";

  const dot = convo?.headerStatus?.dot;
  const dotColor =
    dot === "working" ? "var(--amber)" : dot === "review" ? "var(--blue)" : dot === "online" ? "var(--green)" : "#c5c2b8";

  return (
    <div className="chat-head">
      <div className="ch-avatar" style={{ background: contact.avatar.bg }}>
        {contact.avatar.initials}
        <span
          className={`agent-dot s-${contact.agentStatus}`}
          style={{
            position: "absolute",
            bottom: -1,
            right: -1,
            width: 9,
            height: 9,
            borderRadius: "50%",
            border: "2px solid rgba(255,255,255,0.95)",
          }}
        />
      </div>
      <div className="ch-meta">
        <div className="ch-name">
          {contact.name}
          {!isGroup && !isMe ? <span className="agent-tag">Agent</span> : null}
          {isShared ? (
            <span className="agent-tag" style={{ color: "var(--violet)", background: "var(--violet-soft)" }}>
              {t("chatHead.shared")}
            </span>
          ) : null}
          {isGroup ? (
            <span className="agent-tag" style={{ color: "var(--blue)", background: "var(--blue-soft)" }}>
              {t("chatHead.group")}
            </span>
          ) : null}
        </div>
        <div className="ch-status">
          <span className="dot" style={{ background: dotColor }} />
          <span>{convo?.headerStatus?.text || contact.statusText}</span>
        </div>
      </div>
      <div className="ch-spacer" />
      <div className="ch-meta-row">
        {convo?.metaRow?.map((kv, i) => (
          <span className="kv" key={i}>
            <span style={{ color: "var(--text-3)" }}>{kv.k}</span>
            <b>{kv.v}</b>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 2, marginLeft: 8 }}>
        <button className="icon-btn" title={t("chatHead.searchInConversation")}>
          <Icon.Search size={15} />
        </button>
        <button className="icon-btn" title={t("chatHead.mention")}>
          <Icon.At size={15} />
        </button>
        <button className="icon-btn" title={t("chatHead.more")}>
          <Icon.More size={15} />
        </button>
      </div>
    </div>
  );
}

function MessageAvatar({ who }: { who: string }) {
  // profile 仅影响 who="me";其余作者 whoMeta 忽略它（见 core/mock/data.ts）。
  const profile = usePersonalProfile();
  const meta = whoMeta(who, profile);
  // title:悬停 tip 显示发送者名——个人会话的消息头已隐藏名字(见 .pw-personal-chat),tip 是唯一查看入口。
  // 用户选了 emoji 图标(who="me" 且 emoji 模式):铺 emoji + pastel 底色;
  // 其余作者/首字符模式维持 initials + bg 不变。
  if (meta.avatar.emoji) {
    return (
      <div className="m-avatar has-emoji" style={{ background: meta.avatar.bg }} title={meta.name}>
        {meta.avatar.emoji}
      </div>
    );
  }
  return (
    <div className="m-avatar" style={{ background: meta.avatar.bg }} title={meta.name}>
      {meta.avatar.initials}
    </div>
  );
}

function MessageHeader({ who, time, hideTime = false }: { who: string; time: string; hideTime?: boolean }) {
  const { t } = useTranslation("chat");
  const profile = usePersonalProfile();
  const meta = whoMeta(who, profile);
  const isAgent = who.endsWith("-agent");
  return (
    <div className="m-head">
      <span className="who">{meta.name}</span>
      {isAgent ? (
        <span className={`agent-tag ${meta.agent === "shared" ? "shared" : meta.agent === "mine" ? "mine" : ""}`}>
          {meta.agent === "shared" ? t("messageHeader.sharedAgent") : t("messageHeader.agent")}
        </span>
      ) : null}
      {hideTime ? null : <span className="when">{time}</span>}
    </div>
  );
}

// React.memo:长会话流式时,foldCliEvent 对未变消息保留原引用,故只有正在输出的那一条
// 重渲染并重解析 markdown,其余全部短路。前提是 props 引用稳定——tail 改为接收 renderTail
// 函数(由父级 useCallback 稳定)在内部调用,避免父级每渲染预生成新的 tail ReactNode 破坏 memo。
const TextMessage = memo(function TextMessage({
  m,
  grouped,
  markdown = false,
  renderTail,
  hideTime = false,
  onOpenFile,
  projectPath,
}: {
  m: Extract<Message, { kind: "text" }>;
  grouped: boolean;
  // 个人工作区:agent 输出按 Markdown 渲染(用户自己的消息保持纯文本)。
  markdown?: boolean;
  renderTail?: (message: Extract<Message, { kind: "text" }>) => ReactNode;
  // 个人工作区:头部不显示时间(时间改放到底部操作行)。
  hideTime?: boolean;
  // 个人工作区:文件路径点击 → 右栏预览。团队侧不传 → 走原有纯渲染,零回归。
  onOpenFile?: (ref: string) => void;
  projectPath?: string;
}) {
  const bridge = useDesktopBridge();
  const profile = usePersonalProfile();
  const renderMd = markdown && m.who !== "me" && typeof m.text === "string";
  // 个人区(有 onOpenFile)即注入自定义 components:文件链接需 projectPath 才可点。
  // PersonalChatArea 会传 agent 的真实 cwd(项目 path 或无项目会话 noProjectDir);
  // 本地 HTML 预览(pre 渲染)不依赖该路径。团队侧不传 onOpenFile → undefined = 原渲染,零回归。
  const fileLinkComponents = onOpenFile
    ? chatMarkdownComponents({ onOpenFile, projectPath: projectPath ?? "", bridge })
    : undefined;
  // 知识库引用的链接目标常含空格（文档名如 `DX0B511 采集与上报链路.md`），不归一 remark 整条不解析。
  // useMemo:TextMessage 被 memo 包裹,流式输出时只有当前这条会重算,常量级开销可忽略。
  const mdText = useMemo(
    () => (renderMd ? normalizeKnowledgeLinks(m.text as string) : ""),
    [renderMd, m.text],
  );
  const messageContent = (
    <>
      {m.reply ? (
        <div className="reply-quote">
          <span className="rq-who">{whoMeta(m.reply.who, profile).name}</span>
          {m.reply.text}
        </div>
      ) : null}
      {renderMd ? (
        <div className="m-text md-body">
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={MD_REHYPE_PLUGINS}
            components={fileLinkComponents}
            urlTransform={onOpenFile ? chatMarkdownUrlTransform : undefined}
          >
            {mdText}
          </Markdown>
        </div>
      ) : (
        <div className="m-text">{renderRich(m.text)}</div>
      )}
      {m.attachments && m.attachments.length > 0 ? (
        <div className="attach-row msg-attach-row">
          {m.attachments.map((a, i) => (
            <span key={`${a.name}-${i}`} className="attach-pill">
              <span
                className="ap-thumb"
                style={{
                  background:
                    a.kind === "todo"
                      ? "linear-gradient(135deg,#4f7f62,#2d5c45)"
                      : "linear-gradient(135deg,#c96442,#a84e30)",
                }}
              >
                {a.kind === "todo" ? "TD" : "SK"}
              </span>
              <span>{a.name}</span>
            </span>
          ))}
        </div>
      ) : null}
      {m.images && m.images.length > 0 ? <ChatImages images={m.images} /> : null}
      {m.files && m.files.length > 0 ? <ChatFiles files={m.files} onOpenFile={onOpenFile} /> : null}
    </>
  );
  return (
    <div className={`msg ${grouped ? "is-grouped" : ""} ${m.who === "me" ? "is-me" : ""}`}>
      <MessageAvatar who={m.who} />
      <div className="m-body">
        {/* 规格 §2 时间戳规则:用户消息的时间挂在气泡右下(renderTail),Agent 消息的时间并入
            头像行,不再单独漂浮。hideTime 因此只作用于用户侧。 */}
        <MessageHeader who={m.who} time={m.time} hideTime={hideTime && m.who === "me"} />
        {m.who === "me" ? <UserMessageContent>{messageContent}</UserMessageContent> : messageContent}
        {renderTail?.(m)}
      </div>
    </div>
  );
});

// pi 思考流（reasoning）:可折叠的「思考过程」块,弱化样式区别于正文。
const ReasoningMessage = memo(function ReasoningMessage({
  m,
  grouped,
  collapsible = false,
}: {
  m: Extract<Message, { kind: "reasoning" }>;
  grouped: boolean;
  // 个人工作区:运行中默认展开,结束/历史默认收起,点击标题可展开/收起。
  collapsible?: boolean;
}) {
  const { t } = useTranslation("chat");
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    setUserOpen(null);
  }, [collapsible, m.uid, m.active]);
  const open = userOpen ?? (collapsible ? m.active === true : true);
  return (
    <div className={`msg ${grouped ? "is-grouped" : ""}`}>
      <MessageAvatar who={m.who} />
      <div className="m-body">
        <MessageHeader who={m.who} time={m.time} />
        <div className="reasoning-block">
          <div
            className="rb-h"
            onClick={() => setUserOpen(!open)}
            style={{ cursor: "pointer", userSelect: "none" }}
          >
            <Icon.Sparkle size={12} />
            <span>{t("reasoning.title")}</span>
            <span className="al-chev" data-open={open}>
              <Icon.Chevron size={11} />
            </span>
          </div>
          {open ? <div className="rb-body">{renderRich(m.text)}</div> : null}
        </div>
      </div>
    </div>
  );
});

const AgentLogMessage = memo(function AgentLogMessage({
  m,
  grouped,
  collapsible = false,
}: {
  m: Extract<Message, { kind: "agentLog" }>;
  grouped: boolean;
  // 个人工作区:运行中默认展开,结束后自动收起,点击标题可展开/收起。
  collapsible?: boolean;
}) {
  const { t } = useTranslation("chat");
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // active 状态翻转(完成)时清掉用户手动状态 → 回到「完成即收起」默认。
  useEffect(() => {
    setUserOpen(null);
  }, [m.active]);
  const open = collapsible ? (userOpen ?? !!m.active) : true;

  return (
    <div className={`msg ${grouped ? "is-grouped" : ""}`}>
      <MessageAvatar who={m.who} />
      <div className="m-body">
        <MessageHeader who={m.who} time={m.time} />
        <div className="agent-log">
          <div
            className="al-h"
            onClick={collapsible ? () => setUserOpen(!open) : undefined}
            style={collapsible ? { cursor: "pointer", userSelect: "none" } : undefined}
          >
            {m.active ? (
              <span className="spinner" />
            ) : (
              <span className="check">
                <Icon.CheckCircle size={14} />
              </span>
            )}
            <span style={{ color: "var(--text-1)", fontWeight: 500 }}>{m.title}</span>
            <span style={{ marginLeft: 6, color: "var(--text-3)" }}>
              · {m.active ? t("agentLog.running") : t("agentLog.done")}
              {collapsible ? ` · ${t("agentLog.steps", { count: m.items.length })}` : ""}
            </span>
            {collapsible ? (
              <span className="al-chev" data-open={open}>
                <Icon.Chevron size={11} />
              </span>
            ) : null}
          </div>
          {!open ? null : (
          <ul>
            {m.items.map((it, i) => {
              // toolRenderers 注册表:带 toolName 且已注册的工具走自定义渲染(如 artifacts 的
              // 可点击产物卡);渲染器接不住时经 fallback 回到默认文案,永不产生空行。
              const CustomRenderer = it.toolName ? getToolRenderer(it.toolName) : undefined;
              const defaultNode = <span>{renderRich(it.text)}</span>;
              return (
                <li key={i} className={it.ic === "running" ? "is-active" : ""}>
                  <span className="ic">
                    {it.ic === "check" ? (
                      <Icon.Check size={13} />
                    ) : it.ic === "running" ? (
                      <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                    ) : it.ic === "pending" ? (
                      <span
                        style={{ width: 7, height: 7, border: "1.5px dashed currentColor", borderRadius: "50%" }}
                      />
                    ) : it.ic === "dot" ? (
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          background: "currentColor",
                          borderRadius: "50%",
                          display: "inline-block",
                        }}
                      />
                    ) : null}
                  </span>
                  {CustomRenderer ? <CustomRenderer item={it} fallback={defaultNode} /> : defaultNode}
                </li>
              );
            })}
          </ul>
          )}
        </div>
      </div>
    </div>
  );
});

// pi 会话产物卡(piArtifact):在会话正文流里直接渲染产物本体——HTML/SVG 进沙箱 iframe、
// markdown 渲染、其余等宽文本。卡片自含 content 快照(落盘可回看);version 变化经 key 重挂
// iframe 实现 update 覆盖刷新。右上「侧栏打开」仅当 store 里还有该产物时显示(重启后 store
// 为空,卡片仍可独立渲染)。默认展开;点头部可收起(滚长会话时减轻 iframe 开销)。
const PiArtifactMessage = memo(function PiArtifactMessage({
  m,
  grouped,
}: {
  m: Extract<Message, { kind: "piArtifact" }>;
  grouped: boolean;
}) {
  const bridge = useDesktopBridge();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !m.deleted;
  const sessionId = usePersonalStore((s) => s.activeSessionId);
  const inStore = usePiArtifactsStore((s) => !!(sessionId && s.sessions[sessionId]?.byName[m.filename]));
  const requestOpen = usePiArtifactsStore((s) => s.requestOpen);
  const onOpenExternal = useCallback((url: string) => void bridge?.openExternal?.(url), [bridge]);

  return (
    <div className={`msg ${grouped ? "is-grouped" : ""}`}>
      <MessageAvatar who={m.who} />
      <div className="m-body">
        <MessageHeader who={m.who} time={m.time} />
        <div className={`pw-pam${m.deleted ? " is-deleted" : ""}`}>
          <div className="pw-pam-head" onClick={() => setUserOpen(!open)} role="button">
            <Icon.Code size={13} />
            <span className="pw-pam-name">{m.filename}</span>
            {m.version > 1 && <span className="pw-pam-ver">v{m.version}</span>}
            {m.deleted && <span className="pw-pam-del">已删除</span>}
            <span className="spacer" />
            {inStore && !m.deleted && (
              <button
                type="button"
                className="pw-icon-btn"
                title="在侧栏打开"
                onClick={(e) => {
                  e.stopPropagation();
                  if (sessionId) requestOpen(sessionId, m.filename);
                }}
              >
                <Icon.Sidebar size={13} />
              </button>
            )}
            <span className="al-chev" data-open={open}>
              <Icon.Chevron size={11} />
            </span>
          </div>
          {open && !m.deleted ? (
            <div className="pw-pam-body">
              {m.artifactKind === "html" ? (
                <SandboxedIframe
                  sandboxId={`pam-${m.uid ?? m.filename}`}
                  mode="html"
                  code={m.content}
                  version={m.version}
                  className="pw-pam-iframe"
                  title={m.filename}
                  onOpenExternal={onOpenExternal}
                />
              ) : m.artifactKind === "svg" ? (
                <iframe
                  key={`v${m.version}`}
                  className="pw-pam-iframe"
                  title={m.filename}
                  sandbox=""
                  srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff}svg{max-width:100%;max-height:100vh}</style></head><body>${m.content}</body></html>`}
                />
              ) : m.artifactKind === "markdown" ? (
                // pw-todo-md 提供全仓 markdown 排版样式(标题/表格等),缺它渲染成裸文本。
                <div className="pw-pam-md pw-todo-md">
                  <MarkdownView content={m.content} />
                </div>
              ) : (
                <pre className="pw-pam-pre">{m.content}</pre>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

// agent 任务清单卡片(todoList):同一 run 内整表覆盖更新的任务拆解与完成进度。
// 折叠是派生态:全部 completed → 默认收起为一行摘要(可点开回顾);有未完成项(含 run 中途
// 结束)→ 保持展开直观暴露。用户点击标题可手动覆盖,allDone 翻转时清覆盖回到默认。
const TodoListMessage = memo(function TodoListMessage({
  m,
  grouped,
}: {
  m: Extract<Message, { kind: "todoList" }>;
  grouped: boolean;
}) {
  const { t } = useTranslation("chat");
  const doneCount = m.todos.filter((it) => it.status === "completed").length;
  const allDone = m.todos.length > 0 && doneCount === m.todos.length;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    setUserOpen(null);
  }, [allDone]);
  const open = userOpen ?? !allDone;

  // 规格 §6:头部一行(图标 + 标题 + 计数 + 进度条 + 展开/收起)自身已足够传达状态,折叠态只留它。
  const progress = m.todos.length > 0 ? Math.round((doneCount / m.todos.length) * 100) : 0;

  return (
    <div className={`msg ${grouped ? "is-grouped" : ""}`}>
      <MessageAvatar who={m.who} />
      <div className="m-body">
        <MessageHeader who={m.who} time={m.time} />
        <div className="pw-tasklist" data-active={m.active === true} data-done={allDone}>
          <button
            type="button"
            className="pw-tasklist-head"
            aria-expanded={open}
            onClick={() => setUserOpen(!open)}
          >
            <span className="pw-tasklist-icon" aria-hidden="true">
              {allDone ? <Icon.CheckCircle size={13} /> : m.active ? <span className="spinner" /> : <Icon.Task size={13} />}
            </span>
            <span className="pw-tasklist-title">{t("todoList.title")}</span>
            <span className="pw-tasklist-count">
              {t("todoList.progress", { done: doneCount, total: m.todos.length })}
            </span>
            <span className="pw-tasklist-bar" aria-hidden="true">
              <i style={{ width: `${progress}%` }} />
            </span>
            <span className="pw-tasklist-toggle">
              {t(open ? "todoList.collapse" : "todoList.expand")}
              <span className="al-chev" data-open={open}>
                <Icon.Chevron size={11} />
              </span>
            </span>
          </button>
          {!open ? null : (
            <ul className="pw-tasklist-items">
              {m.todos.map((it, i) => (
                <li key={i} data-status={it.status}>
                  <span className="pw-tasklist-mark" aria-hidden="true">
                    {it.status === "completed" ? (
                      <Icon.Check size={12} />
                    ) : it.status === "in_progress" && m.active ? (
                      <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                    ) : (
                      <i />
                    )}
                  </span>
                  <span className="pw-tasklist-text">{it.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
});

const DiffMessage = memo(function DiffMessage({
  m,
  grouped,
  onSelectFile,
  activeFile,
}: {
  m: Extract<Message, { kind: "diff" }>;
  grouped: boolean;
  onSelectFile: (path: string) => void;
  activeFile: string;
}) {
  const { t } = useTranslation("chat");
  const statusChip =
    m.status === "applied"
      ? { text: t("diff.applied"), cls: "ok" }
      : m.status === "rejected"
        ? { text: t("diff.rejected"), cls: "no" }
        : { text: t("diff.pending"), cls: "pending" };

  return (
    <div className={`msg ${grouped ? "is-grouped" : ""}`}>
      <MessageAvatar who={m.who} />
      <div className="m-body">
        <MessageHeader who={m.who} time={m.time} />
        <div
          className={`diff-card ${m.status === "applied" ? "applied" : m.status === "rejected" ? "rejected" : ""}`}
        >
          <div className="dc-head">
            <div className="dc-icon">
              <Icon.Diff size={15} />
            </div>
            <div>
              <div className="dc-title">{m.title}</div>
              <div className="dc-sub">{m.sub}</div>
            </div>
            <span className={`dc-status-chip ${statusChip.cls}`}>{statusChip.text}</span>
          </div>
          <div className="dc-files">
            {m.files.map((f, i) => (
              <div
                key={i}
                className={`dc-file ${f.path === activeFile ? "is-active" : ""}`}
                onClick={() => onSelectFile(f.path)}
              >
                <Icon.File size={13} />
                <span className="path">{f.path}</span>
                <span className="add">+{f.add}</span>
                <span className="del">−{f.del}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

const ApproveMessage = memo(function ApproveMessage({
  m,
  grouped,
  onApprove,
}: {
  m: Extract<Message, { kind: "approve" }>;
  grouped: boolean;
  onApprove: (uid: string, decision: "approve" | "reject") => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className={`msg ${grouped ? "is-grouped" : ""}`}>
      <MessageAvatar who={m.who} />
      <div className="m-body">
        <MessageHeader who={m.who} time={m.time} />
        <div className="approve-card">
          <div className="ac-h">
            <Icon.Sparkle size={14} />
            <b>{t("approve.title")}</b>
            <span style={{ marginLeft: 6 }}>{t("approve.subtitle")}</span>
          </div>
          <div className="ac-body">{renderRich(m.body)}</div>
          <div className="ac-foot">
            <button className="btn danger-ghost" onClick={() => onApprove(m.uid!, "reject")}>
              <Icon.X size={13} />
              {t("approve.reject")}
            </button>
            <button className="btn primary" onClick={() => onApprove(m.uid!, "approve")}>
              <Icon.Check size={13} />
              {t("approve.approveRun")}
            </button>
            <div className="spacer" />
            <span className="hint">{t("approve.shortcutHint")}</span>
          </div>
        </div>
      </div>
    </div>
  );
});

// 秒级心跳:仅当传入起始时刻时启动 1s ticker,返回已流逝秒数。ticker 局部在 TypingMessage
// 内部,只重渲这一条消息,不放大到整条消息流。
function useElapsedSecs(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === undefined) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

// 慢工具心跳阈值:工具运行超过该秒数才显示「已运行 Ns」,短工具不闪计时噪音。
const SLOW_TOOL_HEARTBEAT_SECS = 8;
// 思考耗时显示阈值:与 typingText 的「已等待 5 秒」口径一致,避免一闪而过的数字。
const THINKING_ELAPSED_SECS = 5;

// typing 占位/活动行:无结构化 activity 时回退 dots+text(团队侧/CLI 零回归);有 activity 时
// 按 phase 排版 —— 思考尾部片段 / 当前工具+步数+慢工具心跳 / ✓ 工具完成。整行可点击展开
// 执行过程面板(onOpenProcess 由个人工作区注入,团队侧不传则不可点)。
const TypingMessage = memo(function TypingMessage({
  m,
  onOpenProcess,
}: {
  m: Extract<Message, { kind: "typing" }>;
  onOpenProcess?: () => void;
}) {
  const { t } = useTranslation("chat");
  const a = m.activity;
  const thinkingSecs = useElapsedSecs(a?.phase === "thinking" ? a.startedAt : undefined);
  const toolSecs = useElapsedSecs(a?.phase === "tool" ? a.toolStartedAt : undefined);

  let body: ReactNode;
  if (a?.phase === "thinking") {
    body = (
      <span className="ta-row is-thinking">
        <Icon.Sparkle size={12} />
        <span className="ta-snippet">{a.snippet || m.text}</span>
        {thinkingSecs >= THINKING_ELAPSED_SECS ? (
          <span className="ta-meta">{t("core.typing.thinkingFor", { secs: thinkingSecs })}</span>
        ) : null}
      </span>
    );
  } else if (a?.phase === "tool") {
    body = (
      <span className="ta-row is-tool">
        <span className="spinner" />
        <span className="ta-tool">{a.toolName}</span>
        {a.detail ? <span className="ta-detail">· {a.detail}</span> : null}
        <span className="ta-meta">{t("core.typing.stepN", { n: (a.stepCount ?? 0) + 1 })}</span>
        {toolSecs >= SLOW_TOOL_HEARTBEAT_SECS ? (
          <span className="ta-meta">· {t("core.typing.toolRunning", { secs: toolSecs })}</span>
        ) : null}
      </span>
    );
  } else if (a?.phase === "toolDone") {
    body = (
      <span className="ta-row is-done">
        <Icon.Check size={12} />
        <span className="ta-tool">{t("core.typing.toolDoneShort", { tool: a.toolName ?? "" })}</span>
        {a.stepCount ? <span className="ta-meta">{t("core.typing.stepN", { n: a.stepCount })}</span> : null}
      </span>
    );
  } else {
    body = (
      <>
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        <span>{m.text}</span>
      </>
    );
  }

  // aria:结构化视觉块对读屏隐藏,统一以 text 字段作为可读文本(role=status 由外层容器承担)。
  const content = (
    <div className="typing" role="status" aria-label={m.text}>
      <span aria-hidden="true" style={{ display: "contents" }}>
        {body}
      </span>
    </div>
  );

  return (
    <div className="msg">
      <MessageAvatar who={m.who} />
      <div className="m-body">
        {a && onOpenProcess ? (
          <button type="button" className="ta-open-btn" onClick={onOpenProcess} title={t("core.typing.openProcess")}>
            {content}
          </button>
        ) : (
          content
        )}
      </div>
    </div>
  );
});

// 圆桌编排角色切换分隔标题：显示当前发言角色名称与 emoji 头像，颜色对应角色标签色。
const RoleHeaderMessage = memo(function RoleHeaderMessage({
  m,
}: {
  m: Extract<Message, { kind: "roleHeader" }>;
}) {
  return (
    <div className="pw-role-header-msg">
      {m.roleAvatar && <span className="pw-role-header-avatar">{m.roleAvatar}</span>}
      <span className="pw-role-header-label" style={m.roleColor ? { color: m.roleColor } : undefined}>
        {m.roleLabel}
      </span>
    </div>
  );
});

function DaySep({ label }: { label: string }) {
  return (
    <div className="day-sep">
      <span>{label}</span>
    </div>
  );
}

const TurnUsageMessage = memo(function TurnUsageMessage({
  m,
}: {
  m: Extract<Message, { kind: "turnUsage" }>;
}) {
  const { t, i18n } = useTranslation("chat");
  const locale = i18n.resolvedLanguage === "zh-Hans" ? "zh-CN" : "en-US";
  const formatter = new Intl.NumberFormat(locale);
  const format = (value: number | undefined) =>
    typeof value === "number" ? formatter.format(value) : "—";
  return (
    <div className="m-turn-usage" aria-label={t("turnUsage.label")}>
      <span>{t("turnUsage.input", { count: format(m.inputTokens) })}</span>
      <span aria-hidden="true">·</span>
      <span>{t("turnUsage.output", { count: format(m.outputTokens) })}</span>
      <span>{t("turnUsage.unit")}</span>
    </div>
  );
});

// 个人工作区（PersonalChatArea）复用同一渲染管线，故导出。
export function MessageStream({
  contact,
  convo,
  onSelectFile,
  activeFile,
  onApprove,
  markdownBodies = false,
  collapsibleLogs = false,
  collapsibleReasoning = false,
  leadingContent,
  renderTextTail,
  hideTextTime = false,
  onOpenFile,
  projectPath,
  stickToBottomKey,
  preserveAnchorKey,
  onActivityClick,
  sessionId,
  processMessages = [],
  processArchives = [],
}: {
  contact: Contact;
  convo: Conversation | null | undefined;
  onSelectFile: (path: string) => void;
  activeFile: string;
  onApprove: (uid: string, decision: "approve" | "reject") => void;
  // 个人工作区:agent 文本按 Markdown 渲染、工具日志可折叠。团队侧保持原样。
  markdownBodies?: boolean;
  collapsibleLogs?: boolean;
  collapsibleReasoning?: boolean;
  leadingContent?: ReactNode;
  renderTextTail?: (message: Extract<Message, { kind: "text" }>) => ReactNode;
  // 个人工作区:文本消息头部不显示时间(时间改放到底部操作行)。
  hideTextTime?: boolean;
  // 个人工作区:文件路径点击 → 右栏预览(向下穿透给 TextMessage)。团队侧不传 → 零回归。
  onOpenFile?: (ref: string) => void;
  projectPath?: string;
  // 个人工作区:滚动语义由调用方声明式控制。
  //  - stickToBottomKey 变 → 贴底(打开会话 / 新消息);团队侧不传 → 回退原 msgCount 无条件贴底,零回归。
  //  - preserveAnchorKey 变 → 头部插入了更早历史,保持视觉锚点(补偿新增高度)而非贴底。
  stickToBottomKey?: unknown;
  preserveAnchorKey?: unknown;
  // 个人工作区:点 typing 活动行展开「执行过程」面板。团队侧不传 → 活动行不可点,零回归。
  onActivityClick?: () => void;
  // 个人工作区会话 id：子代理卡用它订阅该会话的瞬态运行事件，团队侧不传。
  sessionId?: string;
  // 个人工作区瞬态过程流：按 Kun 语义插在最新用户消息与回答之间；团队侧缺省为空。
  processMessages?: Message[];
  // 已落盘的历史轮过程归档（core 在每轮末打的快照）：按 anchorUid 插回对应用户消息之后，
  // 让重开会话/重启后仍能展开「已处理 Ns · N 步 · 调用了 N 个工具」与工具输入输出。团队侧不传。
  processArchives?: TurnProcessArchive[];
}) {
  const { t } = useTranslation("chat");
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const msgCount = convo?.messages?.length || 0;
  const atBottomRef = useRef(true); // 初始视为在底部(挂载即贴底看最新)
  const anchorRef = useRef<{ h: number; top: number } | null>(null);
  const prevAnchorKey = useRef(preserveAnchorKey);
  const personalMode = stickToBottomKey !== undefined;
  const stickDep = personalMode ? stickToBottomKey : msgCount;

  // 渲染体内同步快照:preserveAnchorKey 即将变化(=点了「展开更多」)时,趁 commit 前抓旧 DOM 几何;
  // 否则进 useLayoutEffect 时头部历史已插入、scrollHeight 已是新值,高度补偿就失效了。
  if (personalMode && preserveAnchorKey !== prevAnchorKey.current && scrollRef.current) {
    anchorRef.current = { h: scrollRef.current.scrollHeight, top: scrollRef.current.scrollTop };
  }

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return false;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    return true;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 展开更早历史:头部插入后保持视觉锚点(补偿新增高度),绝不贴底。
    if (personalMode && preserveAnchorKey !== prevAnchorKey.current) {
      prevAnchorKey.current = preserveAnchorKey;
      const snap = anchorRef.current;
      anchorRef.current = null;
      if (snap) el.scrollTop = snap.top + (el.scrollHeight - snap.h);
      return;
    }
    // 贴底:团队侧无条件(原行为);个人工作区仅当用户已在底部(上滑看历史时流式不打断)。
    if (!personalMode || atBottomRef.current) scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.id, stickDep, preserveAnchorKey]);

  useLayoutEffect(() => {
    const target = innerRef.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!personalMode || atBottomRef.current) scrollToBottom();
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [personalMode, scrollToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32; // 32px 容差
  };

  if (!convo) {
    return (
      <div className="msgs" ref={scrollRef}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "var(--text-3)",
            fontSize: 13,
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 12,
              background: contact.avatar.bg,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 600,
              fontSize: 16,
            }}
          >
            {contact.avatar.initials}
          </div>
          <div style={{ color: "var(--text-1)", fontSize: 14, fontWeight: 500 }}>{contact.name}</div>
          <div>{t("stream.empty")}</div>
        </div>
      </div>
    );
  }

  // 过程数据与正文分属不同 query key；渲染时才把过程条插回对应用户消息之后，恢复
  // 「问题→过程→回答」的阅读顺序。两类过程条：
  //  - 历史轮：processArchives（已落盘快照），按 anchorUid 精确插到那一轮的用户消息后；
  //  - 当前轮：processMessages（瞬态流），插到**最后一条**用户消息后。
  // 当前轮的锚点若已有归档（收尾后归档写入、瞬态流仍留着当回顾入口），只渲染瞬态那条，
  // 否则同一轮会出现两条一模一样的过程条。
  const streamMessages: Array<
    Message | { kind: "conversationProcess"; uid: string; archive?: TurnProcessArchive }
  > = [...convo.messages];
  let lastUserIndex = -1;
  for (let i = streamMessages.length - 1; i >= 0; i -= 1) {
    const message = streamMessages[i];
    if (message?.kind === "text" && message.who === "me") {
      lastUserIndex = i;
      break;
    }
  }
  const liveAnchorUid =
    lastUserIndex >= 0 ? (streamMessages[lastUserIndex] as Message).uid : undefined;
  if (processArchives.length > 0) {
    // 逐条按锚点插入。从后往前插，避免前面的插入把后面记下的下标顶偏。
    const inserts: Array<{ index: number; archive: TurnProcessArchive }> = [];
    for (const archive of processArchives) {
      if (processMessages.length > 0 && archive.anchorUid && archive.anchorUid === liveAnchorUid) continue;
      const anchorIndex = archive.anchorUid
        ? streamMessages.findIndex((item) => "uid" in item && item.uid === archive.anchorUid)
        : -1;
      // 锚点消息还在（正常情况）→ 插它后面；锚点已被隐藏/裁掉 → 跳过，不猜位置。
      if (anchorIndex < 0) continue;
      inserts.push({ index: anchorIndex + 1, archive });
    }
    for (const { index, archive } of inserts.sort((a, b) => b.index - a.index)) {
      streamMessages.splice(index, 0, {
        kind: "conversationProcess",
        uid: `conversation-process-${archive.runId}`,
        archive,
      });
    }
  }
  if (processMessages.length > 0) {
    // 归档插入可能已改变下标：按锚点 uid 重新定位当前轮的落点。
    const liveIndex = liveAnchorUid
      ? streamMessages.findIndex((item) => "uid" in item && item.uid === liveAnchorUid)
      : -1;
    streamMessages.splice(liveIndex >= 0 ? liveIndex + 1 : streamMessages.length, 0, {
      kind: "conversationProcess",
      uid: "conversation-process",
    });
  }

  let lastWho: string | null = null;
  return (
    <div className="msgs" ref={scrollRef} onScroll={onScroll}>
      <div className="msgs-inner" ref={innerRef}>
        {leadingContent}
        {streamMessages.map((m, i) => {
          const key = m.uid || i;
          if (m.kind === "conversationProcess") {
            // 过程流套进与普通消息同构的两列骨架，左缘由同一套 flex 布局产生，不靠 margin 魔数对齐
            //（个人区头像已隐藏，那一列宽度归零，但骨架保留，团队会话仍按头像列排版）。
            // 本回合的视觉起点由时间线自己的「已处理 Ns ›」承担，这里不再放消息头。
            // day 分隔符没有 who；过程流里不会出现它，但类型上要收敛掉。
            const processWho =
              processMessages.find((item): item is Extract<Message, { who: string }> => "who" in item)?.who ??
              contact.id;
            const processGrouped = lastWho === processWho;
            lastWho = processWho;
            return (
              <div className={`msg ${processGrouped ? "is-grouped" : ""}`} key={key}>
                <MessageAvatar who={processWho} />
                <div className="m-body">
                  <ConversationProcessTimeline
                    messages={processMessages}
                    sessionId={sessionId}
                    archive={m.archive}
                  />
                </div>
              </div>
            );
          }
          if (m.kind === "day") {
            lastWho = null;
            return <DaySep key={key} label={m.label} />;
          }
          // 兼容旧版本已写入缓存/磁盘的 provider 空帧：纯空 text 没有任何可见载荷，不应占一整行。
          // 带引用或附件的空正文仍是有效消息；空白字符也可能承担 Markdown 排版，不能 trim 后过滤。
          if (
            m.kind === "text" &&
            m.text === "" &&
            !m.reply &&
            !m.attachments?.length &&
            !m.images?.length &&
            !m.files?.length
          ) {
            return null;
          }
          // 规格 §2「统一左缘线」：个人会话里同一 Agent 的连续内容（正文、日志、任务清单）共用
          // 一个头像行，正文与卡片一律对齐 x=36px。团队会话保持原有的「日志/清单各带头像」分组。
          const grouped =
            lastWho === m.who &&
            m.kind !== "approve" &&
            m.kind !== "diff" &&
            (personalMode || (m.kind !== "agentLog" && m.kind !== "reasoning" && m.kind !== "todoList"));
          lastWho = m.who;
          switch (m.kind) {
            case "text":
              return (
                <TextMessage
                  key={key}
                  m={m}
                  grouped={grouped}
                  markdown={markdownBodies}
                  renderTail={renderTextTail}
                  hideTime={hideTextTime}
                  onOpenFile={onOpenFile}
                  projectPath={projectPath}
                />
              );
            case "reasoning":
              return <ReasoningMessage key={key} m={m} grouped={grouped} collapsible={collapsibleReasoning} />;
            case "agentLog":
              return <AgentLogMessage key={key} m={m} grouped={grouped} collapsible={collapsibleLogs} />;
            case "todoList":
              return <TodoListMessage key={key} m={m} grouped={grouped} />;
            case "piArtifact":
              return <PiArtifactMessage key={key} m={m} grouped={grouped} />;
            case "turnUsage":
              return <TurnUsageMessage key={key} m={m} />;
            case "diff":
              return <DiffMessage key={key} m={m} grouped={grouped} onSelectFile={onSelectFile} activeFile={activeFile} />;
            case "approve":
              return <ApproveMessage key={key} m={m} grouped={grouped} onApprove={onApprove} />;
            case "typing":
              // 有结构化过程段时由段标题承担唯一运行反馈，避免与 typing 活动行重复闪动。
              return processMessages.length > 0
                ? null
                : <TypingMessage key={key} m={m} onOpenProcess={onActivityClick ? () => onActivityClick() : undefined} />;
            case "roleHeader":
              return <RoleHeaderMessage key={key} m={m} />;
            case "subagentCard":
              // 同上：子代理卡也套进两列骨架，与正文/过程流共用同一条左缘（规格 §2/§5）。
              return (
                <div className={`msg ${grouped ? "is-grouped" : ""}`} key={key}>
                  <MessageAvatar who={m.who} />
                  <div className="m-body">
                    <SubagentCardMessage m={m} sessionId={sessionId} />
                  </div>
                </div>
              );
            case "stageTitle":
              return null;
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

interface Attachment {
  id: string;
  name: string;
  kind: string;
}

function Composer({
  contact,
  onSend,
  onToast,
}: {
  contact: Contact | undefined;
  onSend: (text: string) => void;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([
    { id: "a1", name: "sidebar-mockup.png", kind: "PNG" },
    { id: "a2", name: "SidebarShell.tsx", kind: "TS" },
  ]);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const placeholder =
    contact?.group === "groups"
      ? t("composer.groupPlaceholder", { name: contact.name })
      : t("composer.contactPlaceholder", { name: contact?.name || t("composer.contactFallback") });

  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
    setAttachments([]);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  useEffect(() => {
    if (!taRef.current) return;
    taRef.current.style.height = "auto";
    taRef.current.style.height = Math.min(140, taRef.current.scrollHeight) + "px";
  }, [text]);

  const ping = (label: string) => () => onToast(label);

  return (
    <div className="composer-wrap">
      <div className="composer">
        {attachments.length > 0 ? (
          <div className="attach-row">
            {attachments.map((a) => (
              <span key={a.id} className="attach-pill">
                <span
                  className="ap-thumb"
                  style={a.kind === "TS" ? { background: "linear-gradient(135deg,#c96442,#a84e30)" } : undefined}
                >
                  {a.kind}
                </span>
                <span>{a.name}</span>
                <button
                  className="attach-x"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  title={t("composer.remove")}
                >
                  <Icon.X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="input-area">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // 宠物:置一次性的「在打字」位;优先级由 core/pet/derive.ts 统一裁决。
              petActivity.flash("typing");
            }}
            onKeyDown={onKey}
            placeholder={placeholder}
            rows={1}
          />
        </div>
        <div className="comp-foot">
          <button className="pill" onClick={ping(t("composer.moreActions"))}>
            <Icon.Plus size={13} />
          </button>
          <button className="pill" onClick={ping(t("composer.mentionToast"))}>
            <Icon.At size={13} />
            {t("composer.mention")}
          </button>
          <button
            className="pill"
            onClick={() => {
              setAttachments((prev) => [
                ...prev,
                { id: "a" + Math.random().toString(36).slice(2), name: "screenshot.png", kind: "PNG" },
              ]);
              onToast(t("composer.attachmentToast"));
            }}
          >
            <Icon.Paperclip size={13} />
            {t("composer.attachment")}
          </button>
          <button className="pill" onClick={ping(t("composer.screenshotToast"))}>
            <Icon.Image size={13} />
            {t("composer.screenshot")}
          </button>
          <button className="pill" onClick={ping(t("composer.fileTreeToast"))}>
            <Icon.Folder size={13} />
            {t("composer.fileTree")}
          </button>
          <div className="spacer" />
          <button className="pill" onClick={ping(t("composer.modelToast"))}>
            <span className="lightning">
              <Icon.Lightning size={11} />
            </span>
            Sonnet 4.5 <Icon.Chevron size={10} />
          </button>
          <button className="pill" onClick={ping(t("composer.voiceToast"))}>
            <Icon.Mic size={13} />
          </button>
          <button
            className={`send ${text.trim() ? "" : "muted"}`}
            onClick={send}
            disabled={!text.trim()}
            title={t("composer.send")}
          >
            <Icon.Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ChatAreaProps {
  contact: Contact | undefined;
  convo: Conversation | null | undefined;
  onSelectFile: (path: string) => void;
  activeFile: string;
  onSend: (text: string) => void;
  onApprove: (uid: string, decision: "approve" | "reject") => void;
  onToast: (text: string) => void;
}

export function ChatArea({ contact, convo, onSelectFile, activeFile, onSend, onApprove, onToast }: ChatAreaProps) {
  if (!contact) return <main className="chat" />;
  return (
    <main className="chat">
      <ChatHeader contact={contact} convo={convo} />
      <MessageStream
        contact={contact}
        convo={convo}
        onSelectFile={onSelectFile}
        activeFile={activeFile}
        onApprove={onApprove}
      />
      <Composer contact={contact} onSend={onSend} onToast={onToast} />
    </main>
  );
}
