// 个人工作区右栏容器。视图（文件 / Skills）由顶栏面板按钮的下拉菜单选择
// （状态在 usePersonalStore.rightView）,面板内不再有 tab 行。
//   文件   → FilesView（项目全部文件 + 最近变更/diff）
//   Skills → PromptPanel（Prompt 库,可拖入聊天）
// 仅查看文件（Tasks 详情 / 文件预览）时左缘可拖拽调宽（宽度经 --rp-custom-width
// 注入,只作用于详情态的 CSS 档位,返回列表恢复固定 320px）;双击恢复自动宽度。
// 拖拽条的显示时机由 CSS :has 控制（见 .pw-rp-resizer）。

import { useCallback, useEffect } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { FilesView } from "./FilesView";
import { PromptPanel } from "./PromptPanel";
import { TasksView } from "./TasksView";
import { NotesView } from "./NotesView";
import { BrowserView } from "./BrowserView";
import { ArtifactEditorPanel } from "../design/ArtifactEditorPanel";

// 右栏视图 → 顶部头标题（内容沿用现有视图名）。
const RIGHT_VIEW_TITLE: Record<string, string> = {
  files: "文件",
  skills: "Skills",
  todos: "Tasks",
  notes: "闪记",
  browser: "浏览器",
  artifact: "产物",
};

// 导出供测试引用,调参不破坏断言。
export const RP_MIN_WIDTH = 280;
// 左侧内容(中栏)至少保留的宽度。拖拽上限至少保留拖拽开始时已经渲染出来的宽度,
// 避免第一帧把面板夹小造成可见边界向右跳。
export const RP_LEFT_RESERVED = 250;

export function PersonalRightPanel({
  onToast,
}: {
  onToast: (text: string) => void;
}) {
  const view = usePersonalStore((s) => s.rightView);
  const width = usePersonalStore((s) => s.rightPanelWidth);
  const setWidth = usePersonalStore((s) => s.setRightPanelWidth);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const activeArtifact = usePersonalStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId)?.activeArtifact
  );
  useEffect(() => {
    if (view === "artifact" && !activeArtifact) setRightOpen(false);
  }, [activeArtifact, setRightOpen, view]);

  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const aside = e.currentTarget.parentElement;
      if (!aside) return;
      const rect = aside.getBoundingClientRect();
      const startX = e.clientX;
      const parentRect = aside.parentElement?.getBoundingClientRect();
      const parentWidth = parentRect?.width || window.innerWidth;
      const startWidth = rect.width || RP_MIN_WIDTH;
      // 用位移增量算宽度,不依赖 rect.left/right 是否等于视觉拖拽条位置。正常状态给
      // 左侧保留空间;若起始布局已经超过这个保留区,本次拖拽允许到父容器宽度,不能反向夹小。
      const reservedMax = Math.max(RP_MIN_WIDTH, parentWidth - RP_LEFT_RESERVED);
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
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        // 拖拽结束:恢复内嵌浏览器(webview/iframe)的指针事件。
        document.body.classList.remove("pw-rp-resizing");
        // 提交最终宽度:持久化 + 让后续渲染沿用(与拖拽中直写的 DOM 变量值一致,无跳变)。
        if (moved) setWidth(nextWidth);
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // 拖拽期间禁用内嵌浏览器帧的指针事件,否则鼠标移到 webview/iframe 上时
      // 事件被其捕获,document 收不到 mouseup —— 表现为「松手无效、宽度一直跟随鼠标」。
      document.body.classList.add("pw-rp-resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp, { once: true });
    },
    [setWidth],
  );

  return (
    <aside
      className="right pw-prompts"
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
        <span className="pw-col-head-title">{RIGHT_VIEW_TITLE[view] ?? "面板"}</span>
        <div className="spacer" />
        <button className="pw-icon-btn" title="关闭面板" onClick={() => setRightOpen(false)}>
          <Icon.X size={14} />
        </button>
      </div>
      {view === "artifact" ? (
        activeArtifact ? <ArtifactEditorPanel artifact={activeArtifact} /> : null
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
