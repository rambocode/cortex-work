// 任务详情态：编辑任务的内联正文（TaskMeta.notes，KTD8）与标题。
// 复用与闪记同一套 markdown 编辑器 NoteCodeMirrorEditor（CM6 + 实时预览），value/onChange 受控，
// Cmd/Ctrl+S 或点返回即保存（updateTask 落 notes/title）。详情态根节点在 TasksView 侧带
// .pw-todos.is-detail，复用右栏「展宽 + 左缘拖拽」的既有 CSS 档位。
import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useUpdateTask } from "@cortex-work/core/personal/tasks";
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

  // 切换到另一条任务时重置草稿（同 id 时保留正在编辑的草稿，不被后台 invalidate 冲掉）。
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
      <div className="pw-task-detail-body">
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
