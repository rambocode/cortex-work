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
  useDeepenNotes,
  useGeneratePlan,
} from "@cortex-work/core";
import type { DesktopBridge, NoteMeta, ProjectMeta } from "@cortex-work/core";
import { MarkdownView } from "./MarkdownView";
import { noteTitle, STATUS_LABEL } from "./noteDisplay";
import { relTime } from "./PersonalSidebar";

// 深化产物文档(磁盘 .md)内联查看/编辑:readFile 预览 + textarea 编辑 + writeFile 写回
// (白名单内,经 fs.assertAllowed 放行)。读盘失败 → 友好降级提示,不崩(链接悬挂降级:
// 某文档被外部删除时其余仍可达,缺失项给提示)。仿 TodosView.MarkdownDetail。
function NoteDocView({
  path,
  bridge,
  onToast,
}: {
  path: string;
  bridge: DesktopBridge | null;
  onToast: (text: string) => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    setEditing(false);
    if (!bridge) {
      setError("当前环境不支持打开文档");
      return;
    }
    bridge
      .readFile(path)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setTruncated(res.truncated);
      })
      .catch(() => {
        // 链接悬挂降级:文档被外部删除/不可读 → 友好提示,不崩,其余产物仍可达。
        if (!cancelled) setError("文档不可用（可能已被移动或删除）");
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, path]);

  const canEdit = !!bridge && content !== null && !truncated;

  const startEdit = () => {
    if (!canEdit) return;
    setDraft(content ?? "");
    setEditing(true);
  };

  const save = async () => {
    if (!bridge || truncated || saving) return;
    setSaving(true);
    try {
      await bridge.writeFile(path, draft);
      setContent(draft);
      setEditing(false);
      onToast("已保存文档");
    } catch (err) {
      onToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pw-note-doc">
      <div className="pw-note-doc-h">
        <Icon.File size={12} />
        <span className="pw-note-doc-name">{path.slice(path.lastIndexOf("/") + 1)}</span>
        <div className="spacer" />
        {truncated ? <span className="pw-readonly">文件过大 · 只读</span> : null}
        {error ? null : editing ? (
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
          <button className="pw-icon-btn" title="编辑文档" onClick={startEdit} disabled={!canEdit}>
            <Icon.Edit size={13} />
          </button>
        )}
      </div>
      {error ? (
        <div className="pw-empty-hint">{error}</div>
      ) : content === null ? (
        <div className="pw-editor-loading">加载中…</div>
      ) : editing ? (
        <div className="pw-note-doc-edit">
          <div className="pw-note-doc-gutter" ref={gutterRef} aria-hidden="true">
            {Array.from({ length: draft.split("\n").length }, (_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </div>
          <textarea
            className="pw-note-doc-ta"
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
      ) : content.trim() ? (
        <div className="pw-todo-md pw-note-md" onDoubleClick={startEdit} title={canEdit ? "双击编辑文档" : undefined}>
          <MarkdownView content={content} />
        </div>
      ) : (
        <div className="pw-empty-hint" onDoubleClick={startEdit}>
          空文档{canEdit ? "，双击开始编辑" : ""}
        </div>
      )}
    </div>
  );
}

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
  const bridge = useDesktopBridge();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  const generatePlan = useGeneratePlan();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);
  const [saving, setSaving] = useState(false);
  const [planning, setPlanning] = useState(false);
  // 内联打开的深化产物文档(磁盘 .md);null = 未展开任何产物。
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);

  // 切换闪记时复位编辑态 + 收起内联产物(避免上一条状态串场)。
  useEffect(() => {
    setEditing(false);
    setDraft(note.content);
    setOpenDoc(null);
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

  // 放弃深化(R17 不留僵尸闪记):若深化会话在 mid-deepen 重载/崩溃后只命中 finalizeRun
  // 「run 已丢失」回退分支,applyDeepenFinalize 不触发,闪记会永久卡 deepening 且被
  // prepareDeepenNotes 硬拦无法重试。提供用户可控回落出口:置回 draft 后可重新深化。
  // 刻意不做自动回落,以免误丢已产出的文档链接(docPaths/conversationIds 全部保留)。
  const abandonDeepen = async () => {
    try {
      await updateNote.mutateAsync({ id: note.id, patch: { status: "draft" } });
      onToast("已放弃深化,闪记回到草稿");
    } catch (err) {
      onToast(`放弃深化失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const statusLabel = STATUS_LABEL[note.status];
  const docPaths = note.docPaths ?? [];
  // 深化(来源)会话 = conversationIds(深化新会话);可逐段跳回(契约 U10#2)。
  const conversationIds = note.conversationIds ?? [];
  const requestFilePreview = usePersonalStore((s) => s.requestFilePreview);
  const setActiveSession = usePersonalStore((s) => s.setActiveSession);
  const sessions = usePersonalStore((s) => s.sessions);

  // 生成 plan(契约 5.7,显式触发):brainstorm 已产出(deepened)才提供;复用编排再开一段
  // (同 conversationId 目录写 plan.md),plan.md 追加进 docPaths、不改 status、不做链式自动。
  const canGeneratePlan = note.status === "deepened" && conversationIds.length > 0;
  const onGeneratePlan = async () => {
    if (planning) return;
    setPlanning(true);
    try {
      await generatePlan(note.id, onToast);
    } catch (err) {
      onToast(`生成 plan 失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPlanning(false);
    }
  };

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
              {note.status === "deepening" ? (
                <button
                  className="pw-tl-gen"
                  title="放弃深化,把闪记回落为草稿后可重新深化"
                  onClick={() => void abandonDeepen()}
                  disabled={updateNote.isPending}
                >
                  <Icon.Back size={12} />
                  放弃深化
                </button>
              ) : null}
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
        {/* 已深化产物入口(U10):docPaths 内联查看/编辑(磁盘 .md,走 fs 写,白名单内),
            另提供「在文件视图打开」副入口;深化(来源)会话经 conversationIds 跳回。
            「生成 plan」对已 brainstorm 的闪记显式触发(同会话目录写 plan.md)。
            产物文档某项被外部删除时其余仍可达,缺失项给友好提示(NoteDocView 内降级)。 */}
        {note.status === "deepened" || docPaths.length > 0 || conversationIds.length > 0 ? (
          <div className="pw-note-links">
            <div className="pw-note-links-h">
              <span>深化产物</span>
              <div className="spacer" />
              {canGeneratePlan ? (
                <button className="pw-tl-gen" onClick={() => void onGeneratePlan()} disabled={planning}>
                  <Icon.Sparkle size={12} />
                  {planning ? "生成中…" : "生成 plan"}
                </button>
              ) : null}
            </div>
            {docPaths.length > 0 ? (
              <ul className="pw-note-links-list">
                {docPaths.map((p) => {
                  const name = p.slice(p.lastIndexOf("/") + 1);
                  const isOpen = openDoc === p;
                  return (
                    <li key={p}>
                      <div className={`pw-note-doc-row ${isOpen ? "is-open" : ""}`}>
                        <button
                          className="pw-note-link"
                          title={p}
                          onClick={() => setOpenDoc(isOpen ? null : p)}
                        >
                          <Icon.File size={12} />
                          <span>{name}</span>
                        </button>
                        <button
                          className="pw-icon-btn"
                          title={`在文件视图打开 ${name}`}
                          onClick={() =>
                            note.projectId
                              ? requestFilePreview({ projectId: note.projectId, path: p, name })
                              : onToast("该闪记无项目,无法在文件视图打开产物文档")
                          }
                        >
                          <Icon.Reply size={12} />
                        </button>
                      </div>
                      {isOpen ? <NoteDocView path={p} bridge={bridge} onToast={onToast} /> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="pw-empty-hint">产物文档暂不可用</div>
            )}
            {conversationIds.length > 0 ? (
              <div className="pw-note-links-sessions">
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
              </div>
            ) : null}
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
  const deepenNotes = useDeepenNotes();
  // 点击列表某条闪记 → 进入中心区宽写作面(占据 .pw-center-col);
  // 右栏内 NoteDetail 仅保留给跨栏 requestNoteDetail 速览(时间线卡片跳转,不抢占中心区)。
  const openNoteEditor = usePersonalStore((s) => s.openNoteEditor);

  // 双态:null → 列表;否则详情。
  const [selected, setSelected] = useState<{ kind: "note"; id: string } | null>(null);
  // 多选(限同项目内):selectedProjectKey 锁定当前选择所在项目(undefined=未归类组)。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | undefined>(undefined);
  // 深化触发在途态(仿 NoteDetail 的 planning/saving):onDeepen 进行中禁用按钮,
  // 堵住「触发后到 notesUpdate(deepening) 落库前」的极窄窗口被极快二次点击绕过 already-deepening 拦截。
  const [deepening, setDeepening] = useState(false);

  // 跨栏跳转:消费 store 请求,在右栏打开该闪记详情(消费即清,仿 TodosView)。
  const noteDetailRequest = usePersonalStore((s) => s.noteDetailRequest);
  const consumeNoteDetailRequest = usePersonalStore((s) => s.consumeNoteDetailRequest);
  const noteEditorId = usePersonalStore((s) => s.noteEditorId);
  useEffect(() => {
    if (!noteDetailRequest) return;
    const req = consumeNoteDetailRequest();
    // 若中心区写作面正在编辑同一条闪记,不再在右栏开一份并行详情,避免两面同编互相覆盖
    // (code-review:adversarial)。其他闪记仍照常右栏速览。
    if (req && req.noteId !== noteEditorId) setSelected({ kind: "note", id: req.noteId });
  }, [noteDetailRequest, consumeNoteDetailRequest, noteEditorId]);

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

  // 深化(U8):拼种子 → 建会话即发(首条防丢) → 切到新会话 → 源闪记置「深化中」。
  // 成功后清空多选(深化中的闪记禁止再次触发);失败/阻止由编排内 onToast 提示,选择保留。
  const onDeepen = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0 || deepening) return;
    setDeepening(true);
    try {
      await deepenNotes(ids, onToast);
      // 成功触发后清空多选并退出列表多选态（已切到新会话）。
      setSelectedIds(new Set());
      setSelectedProjectKey(undefined);
    } catch (err) {
      onToast(`深化失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDeepening(false);
    }
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
              onOpen={(noteId) => openNoteEditor(noteId)}
              onMoveTo={(noteId, projectId) => void moveTo(noteId, projectId)}
            />
          ))}
        </div>
      )}
      {selectedIds.size > 0 ? (
        <div className="pw-note-bar">
          <span>已选 {selectedIds.size} 条</span>
          <div className="spacer" />
          <button
            className="pw-tl-gen"
            onClick={() => { setSelectedIds(new Set()); setSelectedProjectKey(undefined); }}
            disabled={deepening}
          >
            取消
          </button>
          <button className="pw-tl-gen" onClick={() => void onDeepen()} disabled={deepening}>
            <Icon.Sparkle size={12} />
            {deepening ? "深化中…" : `深化 ${selectedIds.size} 条`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
