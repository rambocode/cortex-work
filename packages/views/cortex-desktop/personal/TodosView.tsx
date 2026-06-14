// 个人工作区 Tasks：元数据存 personal-workspace.json，详情正文存项目 tasks/<id>.md。
// 项目模式下自动扫描项目 tasks/ 目录,未登记的 md 也列出;支持单文件删除与
// 按周期（周/月/年）压缩归档（taskArchive.ts,总结用后台配置的模型）。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import { MarkdownView } from "./MarkdownView";
import {
  ARCHIVE_GRANULARITIES,
  archiveTaskFiles,
  groupTaskFiles,
  staleTodoIds,
  unregisteredTaskFiles,
  type ArchiveGranularity,
  type TaskFileGroup,
} from "@cortex-work/core";
import type { ProjectMeta, TaskFileInfo, TaskFilesResult, TodoMeta } from "@cortex-work/core";
import { relTime } from "./PersonalSidebar";

export const TODO_DRAG_MIME = "application/x-cortex-todo";

function TodoStatusButton({ todo }: { todo: TodoMeta }) {
  const updateTodo = usePersonalStore((s) => s.updateTodo);
  const done = todo.status === "done";
  return (
    <button
      className={`pw-todo-check ${done ? "is-done" : ""}`}
      title={done ? "标记为未完成" : "标记完成"}
      onClick={() => updateTodo(todo.id, { status: done ? "open" : "done" })}
    >
      <Icon.Check size={12} />
    </button>
  );
}

// Markdown 详情（todo 与普通 tasks 文件共用）:读 path 预览,可就地编辑保存。
function MarkdownDetail({
  path,
  title,
  editable,
  onToast,
  onSaved,
}: {
  path: string;
  title: string;
  editable: boolean;
  onToast: (text: string) => void;
  onSaved?: () => void;
}) {
  const bridge = useDesktopBridge();
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  // 就地编辑（无浮层）：editing 时预览原位切换为透明背景的 textarea。
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 行号槽随 textarea 纵向滚动同步（textarea 关闭软换行,行号才能始终对齐）。
  const gutterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    setEditing(false);
    if (!bridge || !path) {
      setContent("");
      return;
    }
    bridge
      .readFile(path)
      .then((res) => {
        if (cancelled) return;
        setContent(res.content);
        setTruncated(res.truncated);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, path]);

  const canEdit = editable && content !== null && !truncated;

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
      onSaved?.();
      onToast(`已保存 ${title}`);
    } catch (err) {
      onToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pw-todo-detail">
      <div className="pw-todo-detail-h">
        <span>{path ? "Markdown 详情" : "详情文件未创建"}</span>
        <div className="spacer" />
        {truncated ? <span className="pw-readonly">文件过大 · 只读</span> : null}
        {editable ? (
          editing ? (
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
            <button className="pw-icon-btn" title="编辑详情" onClick={startEdit} disabled={!canEdit}>
              <Icon.Edit size={13} />
            </button>
          )
        ) : null}
      </div>
      {error ? (
        <div className="pw-editor-error">{error}</div>
      ) : content === null ? (
        <div className="pw-editor-loading">加载中…</div>
      ) : editing ? (
        <div className="pw-todo-edit">
          <div className="pw-todo-edit-gutter" ref={gutterRef} aria-hidden="true">
            {Array.from({ length: draft.split("\n").length }, (_, i) => (
              <span key={i}>{i + 1}</span>
            ))}
          </div>
          <textarea
            className="pw-todo-edit-ta"
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
        <div className="pw-todo-md" onDoubleClick={startEdit} title={editable ? "双击编辑 Markdown" : "首页只读"}>
          <MarkdownView content={content} />
        </div>
      ) : (
        <div className="pw-empty-hint" onDoubleClick={startEdit}>
          没有详情内容{canEdit ? "，双击开始编辑" : ""}
        </div>
      )}
    </div>
  );
}

function TodoRow({
  todo,
  project,
  onOpen,
  onToast,
  editable,
}: {
  todo: TodoMeta;
  project: ProjectMeta;
  onOpen: () => void;
  onToast: (text: string) => void;
  editable: boolean;
}) {
  const bridge = useDesktopBridge();
  const updateTodo = usePersonalStore((s) => s.updateTodo);
  const removeTodo = usePersonalStore((s) => s.removeTodo);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(todo.title);

  useEffect(() => setTitleDraft(todo.title), [todo.title]);

  const commitTitle = () => {
    const title = titleDraft.trim();
    if (title && title !== todo.title) updateTodo(todo.id, { title });
    setRenaming(false);
  };

  const remove = async () => {
    removeTodo(todo.id);
    if (bridge && todo.detailPath) {
      try {
        await bridge.deleteFile(todo.detailPath);
      } catch (err) {
        onToast(`已删除元数据，详情文件删除失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    onToast(`已删除 ${todo.title}`);
  };

  return (
    <div className={`pw-todo-row ${todo.status === "done" ? "is-done" : ""}`}>
      <div
        className="pw-todo-row-main"
        data-editable={editable}
        draggable={editable}
        onDragStart={(e) => {
          if (!editable) {
            e.preventDefault();
            return;
          }
          e.dataTransfer.setData(
            TODO_DRAG_MIME,
            JSON.stringify({
              id: todo.id,
              title: todo.title,
              projectId: project.id,
              projectName: project.name,
              detailPath: todo.detailPath,
            }),
          );
          e.dataTransfer.effectAllowed = "copy";
        }}
      >
        {editable ? (
          <TodoStatusButton todo={todo} />
        ) : (
          <span className={`pw-todo-dot ${todo.status === "done" ? "is-done" : ""}`} aria-hidden="true" />
        )}
        {renaming ? (
          <input
            className="pw-todo-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setTitleDraft(todo.title);
                setRenaming(false);
              }
            }}
            autoFocus
          />
        ) : (
          <button
            className="pw-todo-title"
            onClick={onOpen}
            onDoubleClick={() => {
              if (editable) setRenaming(true);
            }}
            title={editable ? "点击查看详情，双击改名" : "点击查看详情"}
          >
            <span>{todo.title}</span>
            <small>{relTime(todo.updatedAt)}</small>
          </button>
        )}
        {editable ? (
          <>
            <button className="pw-icon-btn" title="改名" onClick={() => setRenaming(true)}>
              <Icon.Edit size={12} />
            </button>
            <button className="pw-icon-btn" title="删除" onClick={() => void remove()}>
              <Icon.X size={12} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// tasks/ 目录里未登记为 todo 的普通 md 文件行（含归档文件,单文件可删）。
function FileRow({
  file,
  project,
  editable,
  onOpen,
  onToast,
  onDeleted,
}: {
  file: TaskFileInfo;
  project: ProjectMeta;
  editable: boolean;
  onOpen: () => void;
  onToast: (text: string) => void;
  onDeleted: () => void;
}) {
  const bridge = useDesktopBridge();

  const remove = async () => {
    if (!bridge) return;
    try {
      await bridge.deleteFile(file.path);
      onDeleted();
      onToast(`已删除 ${file.name}`);
    } catch (err) {
      onToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="pw-todo-row is-file">
      <div
        className="pw-todo-row-main"
        data-editable={editable}
        draggable={editable}
        onDragStart={(e) => {
          if (!editable) {
            e.preventDefault();
            return;
          }
          // 复用 todo 拖拽管线:composer 端按 detailPath 读文件、按 id 去重。
          e.dataTransfer.setData(
            TODO_DRAG_MIME,
            JSON.stringify({
              id: file.path,
              title: file.name.replace(/\.md$/i, ""),
              projectId: project.id,
              projectName: project.name,
              detailPath: file.path,
            }),
          );
          e.dataTransfer.effectAllowed = "copy";
        }}
      >
        <span className="pw-todo-file-ic" aria-hidden="true">
          <Icon.File size={13} />
        </span>
        <button className="pw-todo-title" onClick={onOpen} title="点击查看详情">
          <span>{file.name.replace(/\.md$/i, "")}</span>
          <small>{relTime(file.mtimeMs)}</small>
        </button>
        {editable ? (
          <button className="pw-icon-btn" title="删除文件" onClick={() => void remove()}>
            <Icon.X size={12} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

// 「清理」下拉:选周期粒度 → 列周期分组 → 点击执行压缩归档。
function ArchiveMenu({
  project,
  files,
  todos,
  onToast,
  onDone,
}: {
  project: ProjectMeta;
  files: TaskFileInfo[];
  todos: TodoMeta[];
  onToast: (text: string) => void;
  onDone: () => void;
}) {
  const bridge = useDesktopBridge();
  const removeTodo = usePersonalStore((s) => s.removeTodo);
  const [open, setOpen] = useState(false);
  const [granularity, setGranularity] = useState<ArchiveGranularity | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCloseTimer = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const groups = useMemo(() => (granularity ? groupTaskFiles(files, granularity) : []), [files, granularity]);

  const close = () => {
    if (busyKey) return;
    setOpen(false);
    setGranularity(null);
  };

  // 点击菜单外部自动关闭（归档执行中保持打开,避免误关后看不到进度）。
  useEffect(() => {
    if (!open || busyKey) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setGranularity(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, busyKey]);

  // 鼠标移出菜单区域后短暂延迟自动收起；重新移入则取消（归档执行中保持打开）。
  useEffect(() => cancelCloseTimer, []);

  const onMenuLeave = () => {
    if (!open || busyKey) return;
    cancelCloseTimer();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
      setGranularity(null);
    }, 250);
  };
  const onMenuEnter = () => cancelCloseTimer();

  const run = async (group: TaskFileGroup) => {
    if (!bridge || busyKey) return;
    setBusyKey(group.key);
    try {
      const result = await archiveTaskFiles({
        bridge,
        projectPath: project.path,
        projectName: project.name,
        group,
        todos,
      });
      result.removedTodoIds.forEach(removeTodo);
      onToast(
        `已归档 ${result.archivedCount} 个文件 → archive/${group.key}.md` +
          (result.skippedOpen ? `（跳过 ${result.skippedOpen} 个未完成）` : ""),
      );
      setOpen(false);
      setGranularity(null);
      onDone();
    } catch (err) {
      onToast(`归档失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div
      className="pw-tb-menu-wrap pw-archive-menu"
      ref={wrapRef}
      onMouseLeave={onMenuLeave}
      onMouseEnter={onMenuEnter}
    >
      <button
        className={`pw-icon-btn ${open ? "is-on" : ""}`}
        title="压缩清理（按周/月/年归档 tasks 文件）"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon.Clock size={13} />
        <Icon.Chevron size={9} />
      </button>
      {open ? (
        <div className="pw-tb-menu" role="menu">
          {granularity === null ? (
            ARCHIVE_GRANULARITIES.map((g) => (
              <button key={g.value} className="pw-tb-menu-item" role="menuitem" onClick={() => setGranularity(g.value)}>
                <Icon.Clock size={14} />
                <span>{g.label}压缩</span>
              </button>
            ))
          ) : (
            <>
              <button className="pw-tb-menu-item" role="menuitem" onClick={() => setGranularity(null)} disabled={!!busyKey}>
                <Icon.Back size={13} />
                <span>返回</span>
              </button>
              <div className="pw-tb-menu-sep" />
              {groups.length === 0 ? <div className="pw-archive-empty">没有可归档的文件</div> : null}
              {groups.map((group) => (
                <button
                  key={group.key}
                  className="pw-tb-menu-item"
                  role="menuitem"
                  disabled={!!busyKey}
                  onClick={() => void run(group)}
                  title={`把 ${group.files.length} 个文件总结为 archive/${group.key}.md 并删除原文件（未完成任务跳过）`}
                >
                  <Icon.Task size={14} />
                  <span>{group.key}</span>
                  <small className="pw-archive-count">
                    {busyKey === group.key ? "归档中…" : `${group.files.length} 个文件`}
                  </small>
                </button>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

type SelectedItem = { kind: "todo"; id: string } | { kind: "file"; path: string; name: string };

function TodoGroup({
  project,
  todos,
  editable,
  taskFiles,
  onOpenTodo,
  onOpenFile,
  onFilesChanged,
  onToast,
}: {
  project: ProjectMeta;
  todos: TodoMeta[];
  editable: boolean;
  // 当前项目才有:tasks/ 目录扫描结果（其余项目为 null,只显示登记的 todo）
  taskFiles: TaskFilesResult | null;
  onOpenTodo: (todoId: string) => void;
  onOpenFile: (file: TaskFileInfo) => void;
  onFilesChanged: () => void;
  onToast: (text: string) => void;
}) {
  const bridge = useDesktopBridge();
  const addTodo = usePersonalStore((s) => s.addTodo);
  const updateTodo = usePersonalStore((s) => s.updateTodo);
  const removeTodo = usePersonalStore((s) => s.removeTodo);
  const [collapsed, setCollapsed] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);

  const sorted = useMemo(
    () =>
      [...todos].sort((a, b) => {
        if (a.status !== b.status) return a.status === "open" ? -1 : 1;
        return b.updatedAt - a.updatedAt;
      }),
    [todos],
  );
  const openCount = todos.filter((x) => x.status === "open").length;
  // tasks/ 目录里未登记为 todo 的普通 md（自动提取展示）。
  const extraFiles = useMemo(
    () => (taskFiles ? unregisteredTaskFiles(taskFiles.files, todos) : []),
    [taskFiles, todos],
  );
  const archived = taskFiles?.archived ?? [];

  const create = async () => {
    const title = draft.trim();
    if (!bridge || !title || creating) return;
    setCreating(true);
    const todo = addTodo(project.id, title, "");
    try {
      const detailPath = await bridge.createTaskFile(project.path, todo.id, title);
      updateTodo(todo.id, { detailPath });
      setDraft("");
      onOpenTodo(todo.id);
      onToast(`已创建 ${title}`);
    } catch (err) {
      removeTodo(todo.id);
      onToast(`创建 Task 失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="pw-todo-group">
      <header className="pw-todo-group-h">
        <button className="pw-todo-group-toggle" onClick={() => setCollapsed((v) => !v)} title={project.path}>
          <span className="chev" data-collapsed={collapsed}>
            <Icon.Chevron size={11} />
          </span>
          <Icon.Folder size={13} />
          <span>{project.name}</span>
          <small>{openCount} open</small>
        </button>
        {editable && taskFiles ? (
          <ArchiveMenu project={project} files={taskFiles.files} todos={todos} onToast={onToast} onDone={onFilesChanged} />
        ) : null}
      </header>
      {!collapsed ? (
        <>
          {editable ? (
            <div className="pw-todo-new">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                }}
                placeholder="新建 Task"
                disabled={!bridge || creating}
              />
              <button className="pw-icon-btn" title="新建 Task" disabled={!draft.trim() || creating} onClick={() => void create()}>
                <Icon.Plus size={13} />
              </button>
            </div>
          ) : null}
          <div className="pw-todo-list">
            {sorted.map((todo) => (
              <TodoRow
                key={todo.id}
                todo={todo}
                project={project}
                onOpen={() => onOpenTodo(todo.id)}
                onToast={onToast}
                editable={editable}
              />
            ))}
            {extraFiles.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                project={project}
                editable={editable}
                onOpen={() => onOpenFile(file)}
                onToast={onToast}
                onDeleted={onFilesChanged}
              />
            ))}
            {sorted.length === 0 && extraFiles.length === 0 ? (
              <div className="pw-empty-hint">这个项目还没有 Task</div>
            ) : null}
          </div>
          {archived.length > 0 ? (
            <div className="pw-archive-sec">
              <button className="pw-todo-group-toggle pw-archive-toggle" onClick={() => setShowArchive((v) => !v)}>
                <span className="chev" data-collapsed={!showArchive}>
                  <Icon.Chevron size={10} />
                </span>
                <span>归档</span>
                <small>{archived.length}</small>
              </button>
              {showArchive
                ? archived.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      project={project}
                      editable={editable}
                      onOpen={() => onOpenFile(file)}
                      onToast={onToast}
                      onDeleted={onFilesChanged}
                    />
                  ))
                : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function TodosView({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const todos = usePersonalStore((s) => s.todos);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const activeSessionProjectId = usePersonalStore((s) => s.sessions.find((x) => x.id === activeSessionId)?.projectId);
  const homeOpen = usePersonalStore((s) => s.homeOpen);
  const currentProjectId = activeSessionProjectId ?? activeProjectId;
  const projectMode = !homeOpen && !!currentProjectId;
  const [selected, setSelected] = useState<SelectedItem | null>(null);

  // 首页点 Task:消费 store 请求,在右栏打开该文件详情（仿 gitDiffRequest;首页为只读模式）。
  const taskDetailRequest = usePersonalStore((s) => s.taskDetailRequest);
  const consumeTaskDetailRequest = usePersonalStore((s) => s.consumeTaskDetailRequest);
  useEffect(() => {
    if (!taskDetailRequest) return;
    const req = consumeTaskDetailRequest();
    if (req) setSelected({ kind: "file", path: req.path, name: req.name });
  }, [taskDetailRequest, consumeTaskDetailRequest]);

  // 项目模式:扫描当前项目 tasks/ 目录（自动提取 md 文档）,watch 自动刷新。
  const currentProject = projectMode ? projects.find((p) => p.id === currentProjectId) : undefined;
  const currentProjectPath = currentProject?.path;
  const [taskFiles, setTaskFiles] = useState<TaskFilesResult | null>(null);

  const refreshFiles = useCallback(() => {
    if (!bridge?.listTaskFiles || !currentProjectPath || !currentProjectId) {
      setTaskFiles(null);
      return;
    }
    const projectId = currentProjectId;
    bridge
      .listTaskFiles(currentProjectPath)
      .then((result) => {
        setTaskFiles(result);
        // 对账:外部删除 tasks/*.md 后,清理 detailPath 已悬空的 todo 元数据
        // （store 与磁盘是两套数据源,watch 只刷新文件扫描,不回收 todo）。
        const { todos: allTodos, removeTodo } = usePersonalStore.getState();
        for (const id of staleTodoIds(result, allTodos, projectId)) removeTodo(id);
      })
      .catch(() => setTaskFiles(null));
  }, [bridge, currentProjectPath, currentProjectId]);

  useEffect(() => {
    refreshFiles();
    if (!bridge?.watchDir || !bridge.onDirChanged || !bridge.unwatchDir || !currentProjectPath || !currentProject) return;
    const watchId = `tasks:${currentProject.id}`;
    void bridge.watchDir(watchId, currentProjectPath).catch(() => {});
    const off = bridge.onDirChanged((id) => {
      if (id === watchId) refreshFiles();
    });
    return () => {
      off();
      bridge.unwatchDir?.(watchId);
    };
  }, [bridge, currentProject, currentProjectPath, refreshFiles]);

  const orderedProjects = useMemo(() => {
    const scopedProjects = projectMode ? projects.filter((project) => project.id === currentProjectId) : projects;
    const rows = scopedProjects.map((project) => ({ project, todos: todos.filter((x) => x.projectId === project.id) }));
    rows.sort((a, b) => {
      if (!homeOpen && currentProjectId) {
        if (a.project.id === currentProjectId) return -1;
        if (b.project.id === currentProjectId) return 1;
      }
      const au = a.todos.reduce((n, t) => Math.max(n, t.updatedAt), a.project.addedAt);
      const bu = b.todos.reduce((n, t) => Math.max(n, t.updatedAt), b.project.addedAt);
      return bu - au;
    });
    return rows;
  }, [projects, todos, homeOpen, currentProjectId, projectMode]);

  const visibleTodos = orderedProjects.flatMap((row) => row.todos);
  const selectedTodo = selected?.kind === "todo" ? visibleTodos.find((todo) => todo.id === selected.id) : undefined;
  const selectedProject = selectedTodo ? projects.find((project) => project.id === selectedTodo.projectId) : undefined;

  // 选中目标失效（todo 被删 / 文件被删或归档）时自动退出详情。
  useEffect(() => {
    if (!selected) return;
    if (selected.kind === "todo" && !selectedTodo) setSelected(null);
    if (selected.kind === "file" && taskFiles) {
      const exists = [...taskFiles.files, ...taskFiles.archived].some((f) => f.path === selected.path);
      if (!exists) setSelected(null);
    }
  }, [selected, selectedTodo, taskFiles]);

  if (selected?.kind === "file") {
    const fileTitle = selected.name.replace(/\.md$/i, "");
    return (
      <div className="pw-rp-view pw-todos is-detail">
        <div className="pw-panel-h">
          <button className="pw-icon-btn" title="关闭详情" onClick={() => setSelected(null)}>
            <Icon.Back size={14} />
          </button>
          <Icon.File size={14} />
          <span className="pw-panel-title">{fileTitle}</span>
          <div className="spacer" />
          {!projectMode ? <span className="pw-readonly">首页只读</span> : null}
          {currentProject ? <span className="pw-todo-total">{currentProject.name}</span> : null}
        </div>
        <MarkdownDetail path={selected.path} title={fileTitle} editable={projectMode} onToast={onToast} />
      </div>
    );
  }

  if (selectedTodo && selectedProject) {
    return (
      <div className="pw-rp-view pw-todos is-detail">
        <div className="pw-panel-h">
          <button className="pw-icon-btn" title="关闭详情" onClick={() => setSelected(null)}>
            <Icon.Back size={14} />
          </button>
          <Icon.Task size={14} />
          <span className="pw-panel-title">{selectedTodo.title}</span>
          <div className="spacer" />
          {!projectMode ? <span className="pw-readonly">首页只读</span> : null}
          <span className="pw-todo-total">{selectedProject.name}</span>
        </div>
        <MarkdownDetail
          path={selectedTodo.detailPath}
          title={selectedTodo.title}
          editable={projectMode}
          onToast={onToast}
          onSaved={() => usePersonalStore.getState().updateTodo(selectedTodo.id, {})}
        />
      </div>
    );
  }

  return (
    <div className="pw-rp-view pw-todos">
      <div className="pw-panel-h">
        <Icon.Task size={14} />
        <span className="pw-panel-title">Tasks</span>
        <div className="spacer" />
        {!projectMode ? <span className="pw-readonly">首页只读</span> : null}
        <span className="pw-todo-total">{visibleTodos.filter((x) => x.status === "open").length} open</span>
      </div>
      {projects.length === 0 ? (
        <div className="pw-panel-empty">
          <Icon.Folder size={22} />
          <div>先添加项目，再为项目创建 Task</div>
        </div>
      ) : (
        <div className="pw-todo-scroll">
          {orderedProjects.map(({ project, todos: projectTodos }) => (
            <TodoGroup
              key={project.id}
              project={project}
              todos={projectTodos}
              editable={projectMode}
              taskFiles={project.id === currentProjectId ? taskFiles : null}
              onOpenTodo={(todoId) => setSelected({ kind: "todo", id: todoId })}
              onOpenFile={(file) => setSelected({ kind: "file", path: file.path, name: file.name })}
              onFilesChanged={refreshFiles}
              onToast={onToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}
