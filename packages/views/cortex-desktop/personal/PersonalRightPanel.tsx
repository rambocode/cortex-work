// 个人工作区右栏容器。视图（文件 / Skills）由顶栏面板按钮的下拉菜单选择
// （状态在 usePersonalStore.rightView）,面板内不再有 tab 行。
//   文件   → FilesView（项目全部文件 + 最近变更/diff）
//   Skills → PromptPanel（Prompt 库,可拖入聊天）
// 仅查看文件（Tasks 详情 / 文件预览）时左缘可拖拽调宽（宽度经 --rp-custom-width
// 注入,只作用于详情态的 CSS 档位,返回列表恢复固定 320px）;双击恢复自动宽度。
// 拖拽条的显示时机由 CSS :has 控制（见 .pw-rp-resizer）。

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import { FilesView } from "./FilesView";
import { PromptPanel } from "./PromptPanel";
import { TasksView } from "./TasksView";
import { NotesView } from "./NotesView";
import { BrowserView } from "./BrowserView";
import { ArtifactEditorPanel } from "../design/ArtifactEditorPanel";
import { SlidesDeckHeadActions } from "../design/slides/SlidesDeckHeadActions";
import { ResearchArtifactPanel } from "../research/ResearchArtifactPanel";
import type { ResearchExportTarget } from "../research/ResearchRunView";
import type { ResearchModelDisplay } from "../research/modelDisplay";

// 右栏视图 → 顶部头标题（内容沿用现有视图名）。
const RIGHT_VIEW_TITLE: Record<string, string> = {
  files: "文件",
  skills: "Skills",
  todos: "Tasks",
  notes: "闪记",
  browser: "浏览器",
  artifact: "产物",
  research: "深度研究",
};

// 导出供测试引用,调参不破坏断言。
export const RP_MIN_WIDTH = 280;
// 左侧内容(中栏)至少保留的宽度。拖拽上限至少保留拖拽开始时已经渲染出来的宽度,
// 避免第一帧把面板夹小造成可见边界向右跳。
export const RP_LEFT_RESERVED = 250;
// 产物编辑器(演示文稿 / 设计稿)与深度研究面板例外:两者默认就展得很宽,若沿用 250px 的保留,
// 中栏会被压成放不下消息气泡与输入框控件的窄条,故把中栏下限抬到 660px。
// 与 CSS 里 .pw-prompts:has(.pw-artifact-editor) / :has(.pw-research-panel) 的默认宽度公式
// 是同一个数,改一处要改三处(两条 CSS 规则 + 本常量)。
export const RP_LEFT_RESERVED_ARTIFACT = 660;

/// 这些视图按「宽面板」档位给中栏保留 660px；其余走 RP_LEFT_RESERVED。
function isWidePanel(view: string): boolean {
  return view === "artifact" || view === "research";
}

export function PersonalRightPanel({
  onToast,
  researchModel,
  researchExportTargets,
}: {
  onToast: (text: string) => void;
  // 研究面板的两个展示型注入（由 PersonalWorkspace 按设置解析）：
  // views 层不读个人工作区的设置 store，保持研究组件可在任意宿主里复用。
  researchModel?: ResearchModelDisplay;
  researchExportTargets?: readonly ResearchExportTarget[];
}) {
  const view = usePersonalStore((s) => s.rightView);
  const width = usePersonalStore((s) => s.rightPanelWidth);
  const maximized = usePersonalStore((s) => s.rightPanelMaximized);
  const setMaximized = usePersonalStore((s) => s.setRightPanelMaximized);
  const setWidth = usePersonalStore((s) => s.setRightPanelWidth);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const bridge = useDesktopBridge();
  const cancelResizeRef = useRef<(() => void) | null>(null);
  const activeSession = usePersonalStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId),
  );
  const activeArtifact = activeSession?.activeArtifact;
  const researchRefs = activeSession?.researchSessions;
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);

  // 面板内「回看另一条研究」的临时选择（D6：只切展示，不写回会话归属）。
  // 换会话即失效——上一条对话看到哪儿，不该带进下一条对话。
  const [viewingResearchId, setViewingResearchId] = useState<string | null>(null);
  useEffect(() => setViewingResearchId(null), [activeSessionId]);
  const researchSessionId =
    viewingResearchId ??
    activeSession?.activeResearchSessionId ??
    researchRefs?.[researchRefs.length - 1]?.sessionId ??
    null;

  // 放大只对产物编辑器开放:切到文件/Tasks 等窄面板还盖着中栏,用户会以为会话不见了。
  useEffect(() => {
    if (view !== "artifact" && maximized) setMaximized(false);
  }, [maximized, setMaximized, view]);

  useEffect(() => {
    if (view === "artifact" && !activeArtifact) setRightOpen(false);
    // 研究面板同理：会话解除全部研究绑定后面板没有可展示的内容，自动收起而不是留一个空壳。
    if (view === "research" && !researchSessionId) setRightOpen(false);
  }, [activeArtifact, researchSessionId, setRightOpen, view]);
  useEffect(() => () => cancelResizeRef.current?.(), []);

  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      cancelResizeRef.current?.();
      const aside = e.currentTarget.parentElement;
      if (!aside) return;
      const rect = aside.getBoundingClientRect();
      const startX = e.clientX;
      const parentRect = aside.parentElement?.getBoundingClientRect();
      const parentWidth = parentRect?.width || window.innerWidth;
      const startWidth = rect.width || RP_MIN_WIDTH;
      // 用位移增量算宽度,不依赖 rect.left/right 是否等于视觉拖拽条位置。正常状态给
      // 左侧保留空间;若起始布局已经超过这个保留区,本次拖拽允许到父容器宽度,不能反向夹小。
      const reserved = isWidePanel(view) ? RP_LEFT_RESERVED_ARTIFACT : RP_LEFT_RESERVED;
      const reservedMax = Math.max(RP_MIN_WIDTH, parentWidth - reserved);
      const max = startWidth > reservedMax
        ? Math.max(RP_MIN_WIDTH, startWidth, parentWidth)
        : reservedMax;
      // || 兜底:未布局时 rect 宽为 0（如测试环境）。只有实际水平移动后才会提交。
      let nextWidth = startWidth;
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        if (ev.clientX === startX && !moved) return;
        moved = true;
        nextWidth = Math.round(
          Math.min(max, Math.max(RP_MIN_WIDTH, startWidth + (startX - ev.clientX))),
        );
        // 拖拽中直接写 DOM 的 CSS 变量,绕过 React 重渲染 —— 否则每帧都 setWidth 会
        // 重渲染整棵右栏(含 BrowserView/webview),造成拖动抖动。松手才提交一次 store。
        aside.style.setProperty("--rp-custom-width", `${nextWidth}px`);
      };
      let finished = false;
      const finishResize = (commit: boolean) => {
        if (finished) return;
        finished = true;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onBlur);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        // 拖拽结束:恢复内嵌浏览器(webview/iframe)的指针事件。
        document.body.classList.remove("pw-rp-resizing");
        // 提交最终宽度:持久化 + 让后续渲染沿用(与拖拽中直写的 DOM 变量值一致,无跳变)。
        if (commit && moved) setWidth(nextWidth);
        if (cancelResizeRef.current === cancelResize) cancelResizeRef.current = null;
      };
      const onUp = () => finishResize(true);
      const onBlur = () => finishResize(true);
      const cancelResize = () => finishResize(false);
      cancelResizeRef.current = cancelResize;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // 拖拽期间禁用内嵌浏览器帧的指针事件,否则鼠标移到 webview/iframe 上时
      // 事件被其捕获,document 收不到 mouseup —— 表现为「松手无效、宽度一直跟随鼠标」。
      document.body.classList.add("pw-rp-resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onBlur);
    },
    [setWidth, view],
  );

  return (
    <aside
      className={`right pw-prompts${maximized ? " is-maximized" : ""}`}
      style={
        width
          ? ({ "--rp-custom-width": `${width}px` } as React.CSSProperties)
          : undefined
      }
    >
      <div
        className="pw-rp-resizer"
        title="拖动调整宽度,双击恢复自动"
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(undefined)}
      />
      <div className="pw-col-head pw-rp-head">
        {/* 演示文稿产物:标题与播放/导出并入这一行,面板内不再叠第二条工具栏(省一行高度)。 */}
        {view === "artifact" && activeArtifact?.kind === "slides" ? (
          <SlidesDeckHeadActions fallbackTitle={activeArtifact.title} />
        ) : (
          <>
            <span className="pw-col-head-title">{RIGHT_VIEW_TITLE[view] ?? "面板"}</span>
            <div className="spacer" />
          </>
        )}
        {view === "artifact" ? (
          <button
            className="pw-icon-btn"
            title={maximized ? "还原面板" : "放大面板"}
            onClick={() => setMaximized(!maximized)}
          >
            {maximized ? <Icon.Minimize size={14} /> : <Icon.Maximize size={14} />}
          </button>
        ) : null}
        <button className="pw-icon-btn" title="关闭面板" onClick={() => setRightOpen(false)}>
          <Icon.X size={14} />
        </button>
      </div>
      {view === "artifact" ? (
        activeArtifact ? <ArtifactEditorPanel artifact={activeArtifact} /> : null
      ) : view === "research" ? (
        <ResearchArtifactPanel
          bridge={bridge?.research ?? null}
          sessionId={researchSessionId}
          refs={researchRefs ?? []}
          onSelect={setViewingResearchId}
          {...(researchModel ? { model: researchModel } : {})}
          {...(researchExportTargets ? { exportTargets: researchExportTargets } : {})}
        />
      ) : view === "files" ? (
        <FilesView onToast={onToast} />
      ) : view === "todos" ? (
        <TasksView onToast={onToast} />
      ) : view === "notes" ? (
        <NotesView onToast={onToast} />
      ) : view === "browser" ? (
        <BrowserView onToast={onToast} />
      ) : (
        <PromptPanel onToast={onToast} bare />
      )}
    </aside>
  );
}
