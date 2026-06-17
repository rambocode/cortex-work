// 个人工作区右栏容器。视图（文件 / Skills）由顶栏面板按钮的下拉菜单选择
// （状态在 usePersonalStore.rightView）,面板内不再有 tab 行。
//   文件   → FilesView（项目全部文件 + 最近变更/diff）
//   Skills → PromptPanel（Prompt 库,可拖入聊天）
// 仅查看文件（Tasks 详情 / 文件预览）时左缘可拖拽调宽（宽度经 --rp-custom-width
// 注入,只作用于详情态的 CSS 档位,返回列表恢复固定 320px）;双击恢复自动宽度。
// 拖拽条的显示时机由 CSS :has 控制（见 .pw-rp-resizer）。

import { useCallback } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { FilesView } from "./FilesView";
import { PromptPanel } from "./PromptPanel";
import { TasksDocsView } from "./TasksDocsView";
import { NotesView } from "./NotesView";

// 右栏视图 → 顶部头标题（内容沿用现有视图名）。
const RIGHT_VIEW_TITLE: Record<string, string> = {
  files: "文件",
  skills: "Skills",
  todos: "Tasks",
  notes: "闪记",
};

// 导出供测试引用,调参不破坏断言。
export const RP_MIN_WIDTH = 280;
// 拖宽上限:中间区域（与右栏同处 .pw-upper flex 容器）至少保留的宽度。
// 取 360（够中栏会话基本可读）——原 700 在常见笔记本窗口下会把拖宽上限压到
// 比详情默认 40vw 还小,导致向左拖（变宽）被钳死甚至回弹变窄,表现为「不能拖」。
export const RP_CENTER_RESERVED = 360;

export function PersonalRightPanel({
  onToast,
}: {
  onToast: (text: string) => void;
}) {
  const view = usePersonalStore((s) => s.rightView);
  const width = usePersonalStore((s) => s.rightPanelWidth);
  const setWidth = usePersonalStore((s) => s.setRightPanelWidth);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);

  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      const aside = e.currentTarget.parentElement;
      const startX = e.clientX;
      // || 兜底:未布局时 rect 宽为 0（如测试环境）。
      const startWidth = aside?.getBoundingClientRect().width || RP_MIN_WIDTH;
      const bound =
        aside?.parentElement?.getBoundingClientRect().width ||
        window.innerWidth;
      const max = Math.max(RP_MIN_WIDTH, bound - RP_CENTER_RESERVED);
      const onMove = (ev: MouseEvent) => {
        // 面板在右侧:向左拖增宽。
        const next = Math.round(
          Math.min(
            max,
            Math.max(RP_MIN_WIDTH, startWidth + (startX - ev.clientX)),
          ),
        );
        setWidth(next);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
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
      {view === "files" ? (
        <FilesView onToast={onToast} />
      ) : view === "todos" ? (
        <TasksDocsView onToast={onToast} />
      ) : view === "notes" ? (
        <NotesView onToast={onToast} />
      ) : (
        <PromptPanel onToast={onToast} bare />
      )}
    </aside>
  );
}
