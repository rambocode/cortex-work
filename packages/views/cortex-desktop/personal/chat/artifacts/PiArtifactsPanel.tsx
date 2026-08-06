// pi 会话产物面板（右栏 rightView:"piArtifacts"）:pill 栏切换产物 + 按 kind 分派视图。
// 数据源 usePiArtifactsStore(按当前活跃会话取);产物为空时由 PersonalRightPanel 自动收起。
//
// 命名注意:与 rightView:"artifact"(设计稿/演示文稿,落盘型)是两个概念,本面板一律 PiArtifact 前缀。

import React, { useCallback, useMemo, useState } from "react";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import { usePiArtifactsStore, type PiArtifact } from "@cortex-work/core/store/piArtifacts";
import { Icon } from "@cortex-work/ui/icons";

import { ConsoleBlock } from "./ConsoleBlock";
import { SandboxedIframe } from "./SandboxedIframe";
import type { PiSandboxConsoleEntry } from "./sandboxHtml";
import { MarkdownView } from "../../markdown/MarkdownView";

/** HTML 产物:沙箱持续预览 + console 折叠条 + 手动刷新（refreshTick 参与 key 重挂）。 */
function HtmlArtifactView({ artifact, sessionId }: { artifact: PiArtifact; sessionId: string }): React.JSX.Element {
  const bridge = useDesktopBridge();
  const [entries, setEntries] = useState<PiSandboxConsoleEntry[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const onConsole = useCallback((e: PiSandboxConsoleEntry) => setEntries((prev) => [...prev, e]), []);
  const onError = useCallback(
    (message: string) => setEntries((prev) => [...prev, { level: "error", text: message }]),
    [],
  );
  const onOpenExternal = useCallback((url: string) => void bridge?.openExternal?.(url), [bridge]);
  return (
    <div className="pw-pa-html">
      <SandboxedIframe
        sandboxId={`pa-${sessionId}-${artifact.filename}`}
        mode="html"
        code={artifact.content}
        // version + refreshTick 共同驱动重挂:产物更新自动刷新,刷新按钮手动重跑。
        version={artifact.version * 1000 + refreshTick}
        className="pw-pa-iframe"
        title={artifact.filename}
        onConsole={onConsole}
        onError={onError}
        onOpenExternal={onOpenExternal}
      />
      <div className="pw-pa-html-foot">
        <ConsoleBlock entries={entries} />
        <button
          type="button"
          className="pw-icon-btn"
          title="重新运行"
          onClick={() => {
            setEntries([]);
            setRefreshTick((t) => t + 1);
          }}
        >
          <Icon.Retry size={13} />
        </button>
      </div>
    </div>
  );
}

/** SVG 产物:sandbox=""（连脚本都不给）的 srcdoc 预览,杜绝 SVG 内嵌脚本执行。 */
function SvgArtifactView({ artifact }: { artifact: PiArtifact }): React.JSX.Element {
  const srcDoc = useMemo(
    () => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff}svg{max-width:100%;max-height:100vh}</style></head><body>${artifact.content}</body></html>`,
    [artifact.content],
  );
  return (
    <iframe
      key={`${artifact.filename}-v${artifact.version}`}
      className="pw-pa-iframe"
      title={artifact.filename}
      sandbox=""
      srcDoc={srcDoc}
    />
  );
}

/** 文本类产物:等宽展示 + 一键复制。 */
function TextArtifactView({ artifact }: { artifact: PiArtifact }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div className="pw-pa-text">
      <button
        type="button"
        className="pw-icon-btn pw-pa-copy"
        title="复制内容"
        onClick={() => {
          void navigator.clipboard?.writeText(artifact.content).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? <Icon.Check size={13} /> : <Icon.Copy size={13} />}
      </button>
      <pre className="pw-pa-pre">{artifact.content}</pre>
    </div>
  );
}

/** 面板主体。产物列表为空时渲染空态（自动收起由 PersonalRightPanel 负责,这里兜底一帧）。 */
export function PiArtifactsPanel(): React.JSX.Element {
  const sessionId = usePersonalStore((s) => s.activeSessionId);
  const sessionState = usePiArtifactsStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const setActive = usePiArtifactsStore((s) => s.setActive);

  const artifacts = useMemo(
    () => (sessionState ? sessionState.order.map((f) => sessionState.byName[f]).filter(Boolean) : []),
    [sessionState],
  ) as PiArtifact[];
  // 激活项缺省落最后一个（最新创建的产物最可能是用户想看的）。
  const active =
    (sessionState?.activeFilename ? sessionState.byName[sessionState.activeFilename] : undefined) ??
    artifacts[artifacts.length - 1];

  if (!sessionId || !active) {
    // 空态也要套 .pw-pa-panel:右栏宽度档位与拖拽条显隐按 :has(.pw-pa-panel) 匹配,
    // 缺壳会让空态一帧回落到 320px 窄档再跳宽,视觉抖动。
    return (
      <div className="pw-pa-panel">
        <div className="pw-pa-empty">本会话还没有产物</div>
      </div>
    );
  }

  return (
    <div className="pw-pa-panel">
      {artifacts.length > 1 && (
        <div className="pw-pa-pills">
          {artifacts.map((a) => (
            <button
              key={a.filename}
              type="button"
              className={`pw-pa-pill${a.filename === active.filename ? " is-active" : ""}`}
              onClick={() => setActive(sessionId, a.filename)}
            >
              <span className="pw-pa-pill-name">{a.filename}</span>
              {a.version > 1 && <span className="pw-pa-pill-ver">v{a.version}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="pw-pa-body">
        {active.kind === "html" ? (
          <HtmlArtifactView artifact={active} sessionId={sessionId} />
        ) : active.kind === "svg" ? (
          <SvgArtifactView artifact={active} />
        ) : active.kind === "markdown" ? (
          // pw-todo-md 是全仓 markdown 排版样式的作用域 class(标题/表格/代码块等,
          // .pw-note-editor-preview 同款复用先例);缺它内容会渲染成无样式裸文本。
          <div className="pw-pa-md pw-todo-md">
            <MarkdownView content={active.content} />
          </div>
        ) : (
          <TextArtifactView artifact={active} />
        )}
      </div>
    </div>
  );
}
