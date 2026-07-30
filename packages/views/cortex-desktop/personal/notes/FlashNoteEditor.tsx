// 闪记宽写作面(占据主内容区 .pw-center-col)。点击某条闪记进入,提供「源码 / 实时预览 /
// 仅预览」三档 + 保存,返回回列表。源码/实时预览共用 NoteCodeMirrorEditor(同一 CM6 实例
// 经 appearance 切换);仅预览复用既有 MarkdownView(KTD1)。深化产物/状态/删除入口由
// NotesView.NoteDetail 迁移而来,行为不变(删除仅作用闪记自身)。
// 自动保存(去抖 + flush + 防回灌)由 useNoteAutosave 提供(U5)。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useAllNotes,
  useCancelDeepen,
  useDeleteNote,
  useGeneratePlan,
  useUpdateNote,
  usePersonalStore,
} from "@cortex-work/core";
import { MarkdownView } from "../markdown/MarkdownView";
import { MoveToProjectMenu } from "./MoveToProjectMenu";
import { NoteCodeMirrorEditor, type NoteEditorAppearance } from "../editor/NoteCodeMirrorEditor";
import { useNoteAutosave } from "./useNoteAutosave";
import { noteTitle, STATUS_LABEL } from "./noteDisplay";
import { relTime } from "../layout/PersonalSidebar";

type Mode = "source" | "live" | "preview";

const MODE_LABEL: Record<Mode, string> = {
  live: "实时预览",
  preview: "仅预览",
  source: "源码",
};
const MODE_ORDER: Mode[] = ["live", "preview", "source"];

const SAVE_HINT: Record<ReturnType<typeof useNoteAutosave>["status"], string> = {
  idle: "已保存",
  dirty: "未保存",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

export function FlashNoteEditor({
  noteId,
  onClose,
  onToast,
}: {
  noteId: string;
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const { data: notes = [], isError } = useAllNotes();
  const note = useMemo(() => notes.find((n) => n.id === noteId), [notes, noteId]);
  const projects = usePersonalStore((s) => s.projects);
  const project = note?.projectId ? projects.find((p) => p.id === note.projectId) : undefined;
  // 仅活跃(未归档)项目可作移动目标,与列表/详情语义一致。
  const liveProjects = useMemo(() => projects.filter((p) => p.archivedAt == null), [projects]);
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const generatePlan = useGeneratePlan();
  const cancelDeepen = useCancelDeepen();
  const requestFilePreview = usePersonalStore((s) => s.requestFilePreview);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const sessions = usePersonalStore((s) => s.sessions);

  const [mode, setMode] = useState<Mode>("live");
  const [planning, setPlanning] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  // CodeMirror 动态装载失败 → 强制只读「仅预览」(复用 MarkdownView,不依赖 CM),并提示。
  const [editorLoadFailed, setEditorLoadFailed] = useState(false);
  const effectiveMode: Mode = editorLoadFailed ? "preview" : mode;

  // 去抖自动保存(U5):draft 管理 + flush + 防回灌(仅按 note.id 复位,不被 note.content 回灌)。
  const { draft, setDraft, save, cancel, status } = useNoteAutosave({
    noteId,
    content: note?.content ?? "",
    onSave: async (content) => {
      await updateNote.mutateAsync({ id: noteId, patch: { content } });
    },
    onError: (err) => onToast(`保存失败：${err instanceof Error ? err.message : String(err)}`),
  });

  // 选中目标失效(被删/归档)时退出;查询失败也退出列表(避免永久卡「加载中」)。
  useEffect(() => {
    if (isError || (notes.length > 0 && !note)) onClose();
  }, [isError, notes.length, note, onClose]);

  const remove = async () => {
    try {
      cancel(); // 删除前取消挂起的去抖保存,避免卸载 flush 写回已删 id。
      await deleteNote.mutateAsync(noteId); // 仅删闪记自身,不波及深化产物文档/会话。
      onToast("已删除闪记");
      onClose();
    } catch (err) {
      onToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 改归属:projectId 为 undefined 即移到「无项目」(主进程字段级合并 + 落盘丢弃 undefined)。
  const moveTo = async (projectId: string | undefined) => {
    try {
      await updateNote.mutateAsync({ id: noteId, patch: { projectId } });
      onToast(projectId ? "已移到项目" : "已移到无项目");
    } catch (err) {
      onToast(`移动失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const abandonDeepen = async () => {
    if (abandoning) return;
    setAbandoning(true);
    try {
      // 复用 cancelDeepen:同时终止底层深化 run(僵尸 codex)并回落 draft,不只改状态。
      await cancelDeepen([noteId]);
      onToast("已放弃深化,闪记回到草稿");
    } catch (err) {
      onToast(`放弃深化失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAbandoning(false);
    }
  };

  if (!note) {
    return (
      <div className="pw-note-editor is-empty">
        <div className="pw-editor-loading">加载中…</div>
      </div>
    );
  }

  const statusLabel = STATUS_LABEL[note.status];
  const docPaths = note.docPaths ?? [];
  const conversationIds = note.conversationIds ?? [];
  const canGeneratePlan = note.status === "deepened" && conversationIds.length > 0;

  const onGeneratePlan = async () => {
    if (planning) return;
    setPlanning(true);
    try {
      await generatePlan(noteId, onToast);
    } catch (err) {
      onToast(`生成 plan 失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div className="pw-note-editor">
      <header className="pw-note-editor-h">
        <button className="pw-icon-btn" title="返回列表" onClick={onClose}>
          <Icon.Back size={15} />
        </button>
        <Icon.Pin size={14} />
        <span className="pw-note-editor-title">{noteTitle(draft)}</span>
        {statusLabel ? (
          <span className="pw-note-badge" data-status={note.status}>
            {statusLabel}
          </span>
        ) : null}
        {project ? (
          <span className="pw-todo-total">{project.name}</span>
        ) : (
          <span className="pw-readonly">无项目</span>
        )}
        {/* 移动到其它项目 / 移到无项目(currentProjectId 排除当前所属)。 */}
        <MoveToProjectMenu
          projects={liveProjects}
          currentProjectId={note.projectId}
          onPick={(projectId) => void moveTo(projectId)}
        />
        <div className="spacer" />
        {/* 三档切换(分段按钮,radio 语义)。编辑器装载失败时,源码/实时预览禁用(强制仅预览)。 */}
        <div className="pw-note-mode" role="group" aria-label="编辑模式">
          {MODE_ORDER.map((m) => (
            <button
              key={m}
              className={`pw-note-mode-btn ${effectiveMode === m ? "is-on" : ""}`}
              aria-pressed={effectiveMode === m}
              disabled={editorLoadFailed && m !== "preview"}
              title={editorLoadFailed && m !== "preview" ? "编辑器加载失败,暂仅可预览" : undefined}
              onClick={() => setMode(m)}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <span className="pw-note-save" data-status={status} title="保存状态">
          {SAVE_HINT[status]}
        </span>
        <button className="pw-icon-btn" title="删除闪记" onClick={() => void remove()}>
          <Icon.Trash size={14} />
        </button>
      </header>

      <div className="pw-note-editor-body">
        {effectiveMode === "preview" ? (
          <div className="pw-note-editor-preview">
            {editorLoadFailed ? (
              <div className="pw-empty-hint">编辑器加载失败,当前仅可预览。可返回后重试。</div>
            ) : null}
            {draft.trim() ? (
              // .pw-todo-md 承载 cortex 的 markdown 元素样式(标题字号/列表符号/间距/代码块),
              // MarkdownView 自身不加根 class,必须由此父级提供(对齐 NoteDetail)。
              <div className="pw-todo-md pw-note-md">
                <MarkdownView content={draft} />
              </div>
            ) : (
              <div className="pw-empty-hint">空白闪记</div>
            )}
          </div>
        ) : (
          <NoteCodeMirrorEditor
            key={noteId}
            value={draft}
            appearance={effectiveMode as NoteEditorAppearance}
            onChange={setDraft}
            onSave={() => void save()}
            onLoadError={() => {
              setEditorLoadFailed(true);
              onToast("编辑器加载失败,已切换到仅预览");
            }}
          />
        )}
      </div>

      {/* 深化产物 / 来源会话 / 生成 plan / 放弃深化(迁移自 NoteDetail,行为不变)。
          产物文档经 requestFilePreview 在右栏文件视图打开,不与中心区编辑器争夺。 */}
      {note.status === "deepening" || note.status === "deepened" || docPaths.length > 0 || conversationIds.length > 0 ? (
        <footer className="pw-note-editor-links">
          <div className="pw-note-links-h">
            <span>深化产物</span>
            <div className="spacer" />
            {note.status === "deepening" ? (
              <button className="pw-tl-gen" onClick={() => void abandonDeepen()} disabled={abandoning}>
                <Icon.Back size={12} />
                放弃深化
              </button>
            ) : null}
            {canGeneratePlan ? (
              <button className="pw-tl-gen" onClick={() => void onGeneratePlan()} disabled={planning}>
                <Icon.Sparkle size={12} />
                {planning ? "生成中…" : "生成 plan"}
              </button>
            ) : null}
          </div>
          <div className="pw-note-editor-links-row">
            {docPaths.map((p) => {
              const name = p.slice(p.lastIndexOf("/") + 1);
              return (
                <button
                  key={p}
                  className="pw-note-link"
                  title={`在文件视图打开 ${name}`}
                  onClick={() =>
                    note.projectId
                      ? requestFilePreview({ projectId: note.projectId, path: p, name })
                      : onToast("该闪记无项目,无法打开产物文档")
                  }
                >
                  <Icon.File size={12} />
                  <span>{name}</span>
                </button>
              );
            })}
            {conversationIds.map((cid, i) => {
              const sess = sessions.find((s) => s.id === cid);
              return (
                <button
                  key={cid}
                  className="pw-note-link"
                  title={sess ? `回到深化会话「${sess.title}」` : "深化会话(已不存在)"}
                  disabled={!sess}
                  onClick={() => setActiveSession(cid)}
                >
                  <Icon.Reply size={12} />
                  <span>
                    {conversationIds.length > 1 ? `深化会话 ${i + 1}` : "深化会话"}
                    {sess ? "" : "（已删除）"}
                  </span>
                </button>
              );
            })}
            {note.sourceSessionId ? (
              <button className="pw-note-link" title="回到来源会话" onClick={() => setActiveSession(note.sourceSessionId!)}>
                <Icon.Reply size={12} />
                <span>来源会话</span>
              </button>
            ) : null}
          </div>
          <small className="pw-note-editor-time">{relTime(note.updatedAt)}</small>
        </footer>
      ) : null}
    </div>
  );
}
