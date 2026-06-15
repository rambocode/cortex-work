// 闪记（Flash Notes）收件箱右栏视图。按项目分组展示闪记,双态切换(列表/详情):
//   列表 → 按项目分组,「未归类」分组无内容时隐藏标题;同项目内可多选触发「深化」。
//   详情 → textarea 受控编辑(Cmd/Ctrl+S 存、Esc 取消) + MarkdownView 预览。
// 取数走 React Query(useAllNotes,key 以 projectId),不复制 Zustand 副本;写回走
// bridge.notesUpdate / notesDelete(经 mutation hook 成功后 invalidate)。删除仅删自身,
// 不波及深化产物文档/会话(R18)。已深化徽标 + 跳转入口骨架由本组件统一拥有(U10 复用)。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useDesktopBridge,
  usePersonalStore,
  useAllNotes,
  useUpdateNote,
  useDeleteNote,
} from "@cortex-work/core";
import type { NoteMeta, ProjectMeta } from "@cortex-work/core";
import { MarkdownView } from "./MarkdownView";
import { relTime } from "./PersonalSidebar";

// 闪记标题 = 正文首个非空行截断(列表行/分组展示用)。
function noteTitle(content: string): string {
  const line = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (!line) return "（空白闪记）";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

const STATUS_LABEL: Record<NoteMeta["status"], string | null> = {
  draft: null,
  deepening: "深化中",
  deepened: "已深化",
};

// 闪记详情:textarea 受控编辑 + 预览,Cmd/Ctrl+S 存、Esc 取消;删除仅删自身。
function NoteDetail({
  note,
  project,
  onBack,
  onToast,
}: {
  note: NoteMeta;
  project?: ProjectMeta;
  onBack: () => void;
  onToast: (text: string) => void;
}) {
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);
  const [saving, setSaving] = useState(false);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  // 切换闪记时复位编辑态(避免上一条草稿串场)。
  useEffect(() => {
    setEditing(false);
    setDraft(note.content);
  }, [note.id, note.content]);

  const startEdit = () => {
    setDraft(note.content);
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateNote.mutateAsync({ id: note.id, patch: { content: draft } });
      setEditing(false);
      onToast("已保存闪记");
    } catch (err) {
      onToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      // 仅删闪记自身,不触碰深化产物文档/会话(R18)。
      await deleteNote.mutateAsync(note.id);
      onToast("已删除闪记");
      onBack();
    } catch (err) {
      onToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const statusLabel = STATUS_LABEL[note.status];
  const docPaths = note.docPaths ?? [];
  const requestFilePreview = usePersonalStore((s) => s.requestFilePreview);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);

  return (
    <div className="pw-rp-view pw-notes is-detail">
      <div className="pw-panel-h">
        <button className="pw-icon-btn" title="关闭详情" onClick={onBack}>
          <Icon.Back size={14} />
        </button>
        <Icon.Pin size={14} />
        <span className="pw-panel-title">{noteTitle(note.content)}</span>
        <div className="spacer" />
        {statusLabel ? <span className="pw-note-badge" data-status={note.status}>{statusLabel}</span> : null}
        {project ? <span className="pw-todo-total">{project.name}</span> : <span className="pw-readonly">未归类</span>}
      </div>
      <div className="pw-note-detail">
        <div className="pw-note-detail-h">
          <small>{relTime(note.updatedAt)}</small>
          <div className="spacer" />
          {editing ? (
            <>
              <button className="pw-tl-gen" onClick={() => setEditing(false)} disabled={saving}>
                取消
              </button>
              <button className="pw-tl-gen" onClick={() => void save()} disabled={saving}>
                <Icon.Check size={12} />
                {saving ? "保存中…" : "保存"}
              </button>
            </>
          ) : (
            <>
              <button className="pw-icon-btn" title="编辑" onClick={startEdit}>
                <Icon.Edit size={13} />
              </button>
              <button className="pw-icon-btn" title="删除" onClick={() => void remove()}>
                <Icon.Trash size={13} />
              </button>
            </>
          )}
        </div>
        {editing ? (
          <div className="pw-note-edit">
            <div className="pw-note-edit-gutter" ref={gutterRef} aria-hidden="true">
              {Array.from({ length: draft.split("\n").length }, (_, i) => (
                <span key={i}>{i + 1}</span>
              ))}
            </div>
            <textarea
              className="pw-note-edit-ta"
              wrap="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onScroll={(e) => {
                if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void save();
                }
              }}
              autoFocus
            />
          </div>
        ) : note.content.trim() ? (
          <div className="pw-todo-md pw-note-md" onDoubleClick={startEdit} title="双击编辑">
            <MarkdownView content={note.content} />
          </div>
        ) : (
          <div className="pw-empty-hint" onDoubleClick={startEdit}>
            空白闪记,双击开始编辑
          </div>
        )}
        {/* 已深化产物入口(U10 复用):docPaths 跳右栏文件预览,来源会话跳回会话。
            深化产物 U9 后才有数据,缺失友好降级。 */}
        {note.status === "deepened" || docPaths.length > 0 ? (
          <div className="pw-note-links">
            <div className="pw-note-links-h">深化产物</div>
            {docPaths.length > 0 ? (
              <ul className="pw-note-links-list">
                {docPaths.map((p) => {
                  const name = p.slice(p.lastIndexOf("/") + 1);
                  return (
                    <li key={p}>
                      <button
                        className="pw-note-link"
                        title={p}
                        onClick={() =>
                          note.projectId
                            ? requestFilePreview({ projectId: note.projectId, path: p, name })
                            : onToast("该闪记无项目,无法打开产物文档")
                        }
                      >
                        <Icon.File size={12} />
                        <span>{name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="pw-empty-hint">产物文档暂不可用</div>
            )}
            {note.sourceSessionId ? (
              <button
                className="pw-note-link"
                title="回到来源会话"
                onClick={() => setActiveSession(note.sourceSessionId!)}
              >
                <Icon.Reply size={12} />
                <span>来源会话</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 单条闪记行:复选框(多选,限同项目) + 标题(点开详情) + 状态徽标。
function NoteRow({
  note,
  selected,
  onToggleSelect,
  onOpen,
}: {
  note: NoteMeta;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
}) {
  const statusLabel = STATUS_LABEL[note.status];
  const title = noteTitle(note.content);
  return (
    <div className={`pw-note-row ${selected ? "is-selected" : ""}`}>
      <div className="pw-note-row-main">
        <button
          className={`pw-note-check ${selected ? "is-on" : ""}`}
          title={`选择「${title}」`}
          aria-pressed={selected}
          onClick={onToggleSelect}
        >
          <Icon.Check size={11} />
        </button>
        <button className="pw-note-title" onClick={onOpen} title="点击查看详情">
          <span>{title}</span>
          <small>{relTime(note.updatedAt)}</small>
        </button>
        {statusLabel ? <span className="pw-note-badge" data-status={note.status}>{statusLabel}</span> : null}
      </div>
    </div>
  );
}

// 「移到项目」下拉:把未归类闪记归档到某项目(hover 自动收起)。
function MoveToProjectMenu({
  projects,
  onPick,
}: {
  projects: ProjectMeta[];
  onPick: (projectId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  useEffect(() => cancelCloseTimer, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onMenuLeave = () => {
    cancelCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 220);
  };
  const onMenuEnter = () => cancelCloseTimer();

  return (
    <div className="pw-tb-menu-wrap" ref={wrapRef} onMouseLeave={onMenuLeave} onMouseEnter={onMenuEnter}>
      <button className={`pw-icon-btn ${open ? "is-on" : ""}`} title="移到项目" onClick={() => setOpen((v) => !v)}>
        <Icon.Folder size={13} />
        <Icon.Chevron size={9} />
      </button>
      {open ? (
        <div className="pw-tb-menu" role="menu">
          {projects.length === 0 ? (
            <div className="pw-archive-empty">没有可归档的项目</div>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                className="pw-tb-menu-item"
                role="menuitem"
                onClick={() => {
                  onPick(p.id);
                  setOpen(false);
                }}
              >
                <Icon.Folder size={14} />
                <span>{p.name}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// 项目分组(含「未归类」)。selectedIds 限同项目内,选中态用于「深化」触发。
function NoteGroup({
  group,
  notes,
  liveProjects,
  selectedIds,
  selectable,
  onToggleSelect,
  onOpen,
  onMoveTo,
}: {
  // group=undefined 即「未归类」分组。
  group: ProjectMeta | undefined;
  notes: NoteMeta[];
  liveProjects: ProjectMeta[];
  selectedIds: Set<string>;
  selectable: boolean;
  onToggleSelect: (note: NoteMeta) => void;
  onOpen: (noteId: string) => void;
  onMoveTo: (noteId: string, projectId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="pw-todo-group pw-note-group">
      <header className="pw-todo-group-h">
        <button className="pw-todo-group-toggle" onClick={() => setCollapsed((v) => !v)} title={group?.path}>
          <span className="chev" data-collapsed={collapsed}>
            <Icon.Chevron size={11} />
          </span>
          {group ? <Icon.Folder size={13} /> : <Icon.Pin size={13} />}
          <span>{group ? group.name : "未归类"}</span>
          <small>{notes.length}</small>
        </button>
        {/* 未归类闪记单条「移到项目」入口(选中条数为 1 时不展示,统一逐条归档)。 */}
      </header>
      {!collapsed ? (
        <div className="pw-todo-list">
          {notes.map((n) => (
            <div className="pw-note-row-wrap" key={n.id}>
              <NoteRow
                note={n}
                selected={selectedIds.has(n.id)}
                onToggleSelect={() => (selectable ? onToggleSelect(n) : undefined)}
                onOpen={() => onOpen(n.id)}
              />
              {!group ? (
                <MoveToProjectMenu projects={liveProjects} onPick={(projectId) => onMoveTo(n.id, projectId)} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function NotesView({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const { data: notes = [], isLoading } = useAllNotes();
  const updateNote = useUpdateNote();

  // 双态:null → 列表;否则详情。
  const [selected, setSelected] = useState<{ kind: "note"; id: string } | null>(null);
  // 多选(限同项目内):selectedProjectKey 锁定当前选择所在项目(undefined=未归类组)。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | undefined>(undefined);

  // 跨栏跳转:消费 store 请求,在右栏打开该闪记详情(消费即清,仿 TodosView)。
  const noteDetailRequest = usePersonalStore((s) => s.noteDetailRequest);
  const consumeNoteDetailRequest = usePersonalStore((s) => s.consumeNoteDetailRequest);
  useEffect(() => {
    if (!noteDetailRequest) return;
    const req = consumeNoteDetailRequest();
    if (req) setSelected({ kind: "note", id: req.noteId });
  }, [noteDetailRequest, consumeNoteDetailRequest]);

  // 仅活跃(未归档)项目可作归档目标。
  const liveProjects = useMemo(() => projects.filter((p) => p.archivedAt == null), [projects]);

  // 按项目分组:每个项目一组 + 未归类组(放最后)。
  const groups = useMemo(() => {
    const byProject = new Map<string, NoteMeta[]>();
    const unassigned: NoteMeta[] = [];
    for (const n of notes) {
      if (n.projectId) {
        const arr = byProject.get(n.projectId) ?? [];
        arr.push(n);
        byProject.set(n.projectId, arr);
      } else {
        unassigned.push(n);
      }
    }
    const sortByCreated = (a: NoteMeta, b: NoteMeta) => b.createdAt - a.createdAt;
    const rows: { project: ProjectMeta | undefined; notes: NoteMeta[] }[] = [];
    for (const project of projects) {
      const group = byProject.get(project.id);
      if (group && group.length > 0) rows.push({ project, notes: [...group].sort(sortByCreated) });
    }
    // 未归类组无内容时整组省略(隐藏标题)。
    if (unassigned.length > 0) rows.push({ project: undefined, notes: [...unassigned].sort(sortByCreated) });
    return rows;
  }, [notes, projects]);

  const selectedNote = selected ? notes.find((n) => n.id === selected.id) : undefined;
  const selectedProject = selectedNote?.projectId
    ? projects.find((p) => p.id === selectedNote.projectId)
    : undefined;

  // 选中目标失效(被删/归档串场)时自动退出详情(仿 TodosView)。
  useEffect(() => {
    if (selected && !selectedNote && !isLoading) setSelected(null);
  }, [selected, selectedNote, isLoading]);

  // 多选限同项目内:选不同项目的闪记 → 互斥重置为新项目单选。
  const toggleSelect = (note: NoteMeta) => {
    const key = note.projectId ?? "__unassigned__";
    setSelectedIds((prev) => {
      if (key !== selectedProjectKey) {
        // 切换到新项目 → 重置选择。
        setSelectedProjectKey(key);
        return new Set([note.id]);
      }
      const next = new Set(prev);
      if (next.has(note.id)) next.delete(note.id);
      else next.add(note.id);
      if (next.size === 0) setSelectedProjectKey(undefined);
      return next;
    });
  };

  const moveTo = async (noteId: string, projectId: string) => {
    try {
      await updateNote.mutateAsync({ id: noteId, patch: { projectId } });
      onToast("已移到项目");
    } catch (err) {
      onToast(`移动失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 占位深化(本单元):U8 接管时替换为真实深化编排。
  const onDeepen = () => {
    onToast(`深化将在下一步接入（已选 ${selectedIds.size} 条）`);
  };

  if (selectedNote) {
    return (
      <NoteDetail
        note={selectedNote}
        project={selectedProject}
        onBack={() => setSelected(null)}
        onToast={onToast}
      />
    );
  }

  return (
    <div className="pw-rp-view pw-notes">
      <div className="pw-panel-h">
        <Icon.Pin size={14} />
        <span className="pw-panel-title">闪记</span>
        <div className="spacer" />
        <span className="pw-todo-total">{notes.length} 条</span>
      </div>
      {isLoading ? (
        <div className="pw-editor-loading">加载中…</div>
      ) : notes.length === 0 ? (
        <div className="pw-panel-empty">
          <Icon.Pin size={22} />
          <div>还没有闪记</div>
        </div>
      ) : (
        <div className="pw-todo-scroll">
          {groups.map(({ project, notes: groupNotes }) => (
            <NoteGroup
              key={project?.id ?? "__unassigned__"}
              group={project}
              notes={groupNotes}
              liveProjects={liveProjects}
              selectedIds={selectedIds}
              selectable={!!bridge?.notesUpdate}
              onToggleSelect={toggleSelect}
              onOpen={(noteId) => setSelected({ kind: "note", id: noteId })}
              onMoveTo={(noteId, projectId) => void moveTo(noteId, projectId)}
            />
          ))}
        </div>
      )}
      {selectedIds.size > 0 ? (
        <div className="pw-note-bar">
          <span>已选 {selectedIds.size} 条</span>
          <div className="spacer" />
          <button className="pw-tl-gen" onClick={() => { setSelectedIds(new Set()); setSelectedProjectKey(undefined); }}>
            取消
          </button>
          <button className="pw-tl-gen" onClick={onDeepen}>
            <Icon.Sparkle size={12} />
            深化 {selectedIds.size} 条
          </button>
        </div>
      ) : null}
    </div>
  );
}
