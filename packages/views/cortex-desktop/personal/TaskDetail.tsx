// 右列任务详情态：薄壳（U5/KTD7）——头部（返回 / 标题 / 源码切换）+ 共享结构字段面板
// TaskFieldsPanel（layout=column）+ 内联正文编辑器 NoteCodeMirrorEditor。
// 结构字段（状态/项目/日期/标记/标签/富字段）已抽入 TaskFieldsPanel，与中列行内 inspector 共用同一实现，
// 防两套逻辑漂移。正文复用与闪记同一套 markdown 编辑器（CM6 + 实时预览），Cmd/Ctrl+S 或点返回即保存。
import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useUpdateTask } from "@cortex-work/core/personal/tasks";
import { TaskFieldsPanel } from "./TaskFieldsPanel";
import type { TaskMeta } from "@cortex-work/core/desktop/types";
import { NoteCodeMirrorEditor, type NoteEditorAppearance } from "./editor/NoteCodeMirrorEditor";

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

  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [mode, setMode] = useState<NoteEditorAppearance>("live");
  const [loadFailed, setLoadFailed] = useState(false);

  // 切换到另一条任务时重置草稿（同 id 保留正在编辑的草稿，不被后台 invalidate 冲掉）。
  useEffect(() => {
    setTitle(task.title);
    setNotes(task.notes ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const saveTitle = () => {
    const t = title.trim();
    if (t && t !== task.title) updateTask.mutate({ id: task.id, patch: { title: t } });
  };
  const saveNotes = () => {
    if (notes !== (task.notes ?? "")) updateTask.mutate({ id: task.id, patch: { notes } });
  };
  const back = () => {
    saveTitle();
    saveNotes();
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
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              saveTitle();
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

      <div className="pw-task-detail-body">
        {/* 备注分区标签（对齐设计稿右列检查器末段）。正文仍用 CodeMirror（较设计稿纯 textarea 更强：
            实时预览 + 源码切换），在检查器内以有界高度呈现（滚动交给外层 .pw-projects-detail）。 */}
        <span className="pw-task-note-label">备注</span>
        {loadFailed ? (
          <div className="pw-empty-hint">编辑器加载失败，可返回后重试。</div>
        ) : (
          <NoteCodeMirrorEditor
            key={task.id}
            value={notes}
            appearance={mode}
            onChange={setNotes}
            onSave={() => {
              saveNotes();
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
