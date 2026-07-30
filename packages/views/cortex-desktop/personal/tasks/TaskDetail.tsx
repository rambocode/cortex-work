// 右列任务详情态：薄壳（U5/KTD7）——头部（返回 / 标题 / 源码切换）+ 共享结构字段面板
// TaskFieldsPanel（layout=column）+ 内联正文编辑器 NoteCodeMirrorEditor。
// 结构字段（状态/项目/日期/标记/标签/富字段）已抽入 TaskFieldsPanel，与中列行内 inspector 共用同一实现，
// 防两套逻辑漂移。正文复用与闪记同一套 markdown 编辑器（CM6 + 实时预览），Cmd/Ctrl+S 或点返回即保存。
import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useUpdateTask } from "@cortex-work/core/personal/tasks";
import { TaskFieldsPanel } from "./TaskFieldsPanel";
import type { TaskMeta } from "@cortex-work/core/desktop/types";
import { NoteCodeMirrorEditor, type NoteEditorAppearance } from "../editor/NoteCodeMirrorEditor";
import { useTaskDraftField } from "./useTaskDraftField";

export function TaskDetail({
  task,
  onBack,
  onToast,
}: {
  task: TaskMeta;
  onBack: () => void;
  onToast: (text: string) => void;
}) {
  const updateTask = useUpdateTask();

  // title/notes 走共享草稿守卫（U1/KTD6）：切任务重置、未聚焦时跟随外部值（跨列/跨窗口热更）、
  // 聚焦中不被冲掉、blur 保存后不回弹。备注 CodeMirror 支持受控 value 热更（NoteCodeMirrorEditor
  // 内置 external-sync effect），故无需 key 重挂——只要草稿在未聚焦时跟随 external 即可。
  const title = useTaskDraftField({
    taskId: task.id,
    external: task.title,
    // 空标题不落库（保留原标题）；trim 归一。
    onCommit: (t) => {
      if (t) updateTask.mutate({ id: task.id, patch: { title: t } });
    },
    normalize: (v) => v.trim(),
  });
  const notes = useTaskDraftField({
    taskId: task.id,
    external: task.notes ?? "",
    onCommit: (n) => updateTask.mutate({ id: task.id, patch: { notes: n } }),
  });
  const [mode, setMode] = useState<NoteEditorAppearance>("live");
  const [loadFailed, setLoadFailed] = useState(false);

  const back = () => {
    title.commit();
    notes.commit();
    onBack();
  };

  return (
    <div className="pw-task-detail">
      <div className="pw-task-detail-head">
        <button className="pw-icon-btn" title="返回列表" onClick={back}>
          <Icon.ChevronLeft size={16} />
        </button>
        <input
          className="pw-task-detail-title"
          value={title.value}
          onFocus={title.onFocus}
          onChange={(e) => title.setValue(e.target.value)}
          onBlur={title.onBlur}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              title.commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="任务标题"
        />
        <button
          className="pw-icon-btn"
          title={mode === "live" ? "切换源码模式" : "切换实时预览"}
          onClick={() => setMode(mode === "live" ? "source" : "live")}
        >
          <Icon.Eye size={14} />
        </button>
      </div>

      {/* 结构 + 富字段：共享面板（column 布局，与中列行内 inspector 同源）。 */}
      <TaskFieldsPanel task={task} layout="column" onToast={onToast} />

      {/* focusin/focusout 冒泡到本 div → 追踪 CM 聚焦态（备注编辑器是唯一可聚焦子元素）：
          聚焦中忽略外部更新、失焦即提交草稿。未聚焦时 notes.value 跟随 external，
          NoteCodeMirrorEditor 的 external-sync effect 据此热更文档（保选区，跨列/跨窗口可见）。
          注意：焦点句柄挂在 body 而非新建 wrapper，避免打断 `.pw-task-detail-body > .pw-note-cm-host`
          的直接子选择器（否则 CM 失去 flex/min-height → 高度塌陷）。 */}
      <div className="pw-task-detail-body" onFocus={notes.onFocus} onBlur={notes.onBlur}>
        {/* 备注分区标签（对齐设计稿右列检查器末段）。正文仍用 CodeMirror（较设计稿纯 textarea 更强：
            实时预览 + 源码切换），在检查器内以有界高度呈现（滚动交给外层 .pw-projects-detail）。 */}
        <span className="pw-task-note-label">备注</span>
        {loadFailed ? (
          <div className="pw-empty-hint">编辑器加载失败，可返回后重试。</div>
        ) : (
          <NoteCodeMirrorEditor
            value={notes.value}
            appearance={mode}
            onChange={notes.setValue}
            onSave={() => {
              notes.commit();
              onToast("已保存");
            }}
            onLoadError={() => {
              setLoadFailed(true);
              onToast("编辑器加载失败");
            }}
          />
        )}
      </div>
    </div>
  );
}
