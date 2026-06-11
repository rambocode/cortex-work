// 个人工作区 Todos：元数据存 personal-workspace.json，详情正文存项目 tasks/<id>.md。

import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { ProjectMeta, TodoMeta } from "@cortex-work/core";
import { relTime } from "./PersonalSidebar";

export const TODO_DRAG_MIME = "application/x-cortex-todo";

function TodoStatusButton({ todo, editable }: { todo: TodoMeta; editable: boolean }) {
  const updateTodo = usePersonalStore((s) => s.updateTodo);
  const done = todo.status === "done";
  return (
    <button
      className={`pw-todo-check ${done ? "is-done" : ""}`}
      title={editable ? (done ? "标记为未完成" : "标记完成") : "首页只读"}
      disabled={!editable}
      onClick={() => updateTodo(todo.id, { status: done ? "open" : "done" })}
    >
      <Icon.Check size={12} />
    </button>
  );
}

function TodoDetail({ todo, editable, onToast }: { todo: TodoMeta; editable: boolean; onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const updateTodo = usePersonalStore((s) => s.updateTodo);
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
    if (!bridge || !todo.detailPath) {
      setContent("");
      return;
    }
    bridge
      .readFile(todo.detailPath)
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
  }, [bridge, todo.detailPath]);

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
      await bridge.writeFile(todo.detailPath, draft);
      setContent(draft);
      setEditing(false);
      updateTodo(todo.id, {});
      onToast(`已保存 ${todo.title}`);
    } catch (err) {
      onToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pw-todo-detail">
      <div className="pw-todo-detail-h">
        <span>{todo.detailPath ? "Markdown 详情" : "详情文件未创建"}</span>
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
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
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
        <TodoStatusButton todo={todo} editable={editable} />
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

function TodoGroup({
  project,
  todos,
  editable,
  onOpenTodo,
  onToast,
}: {
  project: ProjectMeta;
  todos: TodoMeta[];
  editable: boolean;
  onOpenTodo: (todoId: string) => void;
  onToast: (text: string) => void;
}) {
  const bridge = useDesktopBridge();
  const addTodo = usePersonalStore((s) => s.addTodo);
  const updateTodo = usePersonalStore((s) => s.updateTodo);
  const removeTodo = usePersonalStore((s) => s.removeTodo);
  const [collapsed, setCollapsed] = useState(false);
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
      onToast(`创建 Todo 失败：${err instanceof Error ? err.message : String(err)}`);
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
                placeholder="新建 Todo"
                disabled={!bridge || creating}
              />
              <button className="pw-icon-btn" title="新建 Todo" disabled={!draft.trim() || creating} onClick={() => void create()}>
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
            {sorted.length === 0 ? <div className="pw-empty-hint">这个项目还没有 Todo</div> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function TodosView({ onToast }: { onToast: (text: string) => void }) {
  const projects = usePersonalStore((s) => s.projects);
  const todos = usePersonalStore((s) => s.todos);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const activeSessionProjectId = usePersonalStore((s) => s.sessions.find((x) => x.id === activeSessionId)?.projectId);
  const homeOpen = usePersonalStore((s) => s.homeOpen);
  const currentProjectId = activeSessionProjectId ?? activeProjectId;
  const projectMode = !homeOpen && !!currentProjectId;
  const [selectedTodoId, setSelectedTodoId] = useState<string | null>(null);

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
  const selectedTodo = selectedTodoId ? visibleTodos.find((todo) => todo.id === selectedTodoId) : undefined;
  const selectedProject = selectedTodo ? projects.find((project) => project.id === selectedTodo.projectId) : undefined;

  useEffect(() => {
    if (selectedTodoId && !selectedTodo) setSelectedTodoId(null);
  }, [selectedTodo, selectedTodoId]);

  if (selectedTodo && selectedProject) {
    return (
      <div className="pw-rp-view pw-todos is-detail">
        <div className="pw-panel-h">
          <button className="pw-icon-btn" title="关闭详情" onClick={() => setSelectedTodoId(null)}>
            <Icon.Back size={14} />
          </button>
          <Icon.Task size={14} />
          <span className="pw-panel-title">{selectedTodo.title}</span>
          <div className="spacer" />
          {!projectMode ? <span className="pw-readonly">首页只读</span> : null}
          <span className="pw-todo-total">{selectedProject.name}</span>
        </div>
        <TodoDetail todo={selectedTodo} editable={projectMode} onToast={onToast} />
      </div>
    );
  }

  return (
    <div className="pw-rp-view pw-todos">
      <div className="pw-panel-h">
        <Icon.Task size={14} />
        <span className="pw-panel-title">Todos</span>
        <div className="spacer" />
        {!projectMode ? <span className="pw-readonly">首页只读</span> : null}
        <span className="pw-todo-total">{visibleTodos.filter((x) => x.status === "open").length} open</span>
      </div>
      {projects.length === 0 ? (
        <div className="pw-panel-empty">
          <Icon.Folder size={22} />
          <div>先添加项目，再为项目创建 Todo</div>
        </div>
      ) : (
        <div className="pw-todo-scroll">
          {orderedProjects.map(({ project, todos: projectTodos }) => (
            <TodoGroup
              key={project.id}
              project={project}
              todos={projectTodos}
              editable={projectMode}
              onOpenTodo={setSelectedTodoId}
              onToast={onToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}
