// 左列多层项目树（U6）。可折叠嵌套 + 内置视图入口（今日 / 收件箱）+ 新建 / 重命名 / reparent / 删除。
// 服务端态（projects）走 React Query（useTaskProjects），本组件只持有 UI 瞬态：
//   展开态 / 正在新建 / 正在重命名。
// 展开态语义（U11）：默认**全部展开**——存储只记「被用户折叠的节点 id 集合」（collapsed），
//   未记录的节点一律视为展开，故新建项目 / 文件夹天然展开、无需登记。折叠态经 localStorage 窄通道
//   持久化（同 ProjectsWorkbench 的 sidebar/viewOptions 通道；views 层可用浏览器 API），跨开窗记忆。
// reparent 防环由 store 层强制拒绝并 reject，UI 只在候选列表用 isDescendant 预筛 + mutate onError 兜底提示,
//   绝不自行判定成环（防 UI/store 判定漂移）。
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useTaskProjects,
  useAddTaskProject,
  useUpdateTaskProject,
  useDeleteTaskProject,
  projectMode,
} from "@cortex-work/core/personal/tasks";
import {
  buildProjectTree,
  projectKind,
  isDescendant,
  type TaskProjectNode,
} from "@cortex-work/core/personal/taskProjectTree";
import type { TaskProject, TaskProjectKind, TaskProjectMode } from "@cortex-work/core/desktop/types";
import type { WorkbenchSelection } from "./ProjectsWorkbench";

// 每层缩进步长（px）。折叠箭头 / 占位固定宽，保证同层节点名对齐。
const INDENT = 16;

// ── 折叠态窄通道（U11）───────────────────────────────────────────────────────
// 默认全展开：只持久化「被用户折叠的节点 id」集合，未记录即展开（新项目天然展开）。
// 用 localStorage 作窗口专属窄通道（同 ProjectsWorkbench 的 SIDEBAR_KEY / VIEW_OPTIONS_KEY 惯例），
// 不进 store 全量持久化，避免双窗口 clobber。
const COLLAPSED_KEY = "cortex.projects.collapsedNodes";
function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? (arr.filter((x) => typeof x === "string") as string[]) : []);
  } catch {
    return new Set();
  }
}

// 就地输入框：新建 / 重命名共用。Enter 提交、Esc 取消、失焦即提交（空则调用方丢弃）。
// doneRef 去重：Enter 提交后 input 卸载会再触发一次 blur，若不拦截会重复提交（新建将建两条）。
function InlineInput({
  initial,
  placeholder,
  indent,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  indent: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const doneRef = useRef(false);
  const finish = (submit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    submit ? onSubmit(value) : onCancel();
  };
  return (
    <input
      className="pw-ptree-input"
      autoFocus
      value={value}
      placeholder={placeholder}
      style={{ marginLeft: indent }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
        e.stopPropagation(); // 别让方向键冒泡到树容器触发焦点移动
      }}
      onBlur={() => finish(true)}
    />
  );
}

// 「＋」新建菜单：始终可建 project；allowFolder 时额外可建 folder（顶层与 folder 节点下可建文件夹，
// project 节点下只允许子项目）。outside mousedown 关闭，与 MoveToProjectMenu / ProjectMenu 一致。
function AddMenu({
  allowFolder,
  title,
  onPick,
}: {
  allowFolder: boolean;
  title: string;
  onPick: (kind: TaskProjectKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="pw-tb-menu-wrap" ref={wrapRef}>
      <button
        className={`pw-icon-btn ${open ? "is-active" : ""}`}
        title={title}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon.Plus size={13} />
      </button>
      {open ? (
        <div className="pw-tb-menu" role="menu">
          <button
            className="pw-tb-menu-item"
            role="menuitem"
            onClick={() => {
              onPick("project");
              setOpen(false);
            }}
          >
            <Icon.Task size={14} />
            <span>新建项目</span>
          </button>
          {allowFolder ? (
            <button
              className="pw-tb-menu-item"
              role="menuitem"
              onClick={() => {
                onPick("folder");
                setOpen(false);
              }}
            >
              <Icon.Folder size={14} />
              <span>新建文件夹</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// 「移动到…」菜单：候选父排除自身及其子孙（成环，isDescendant 判定）与当前父（移动无意义）；
// 已在某父下时额外提供「提到顶层」（parentId:null）。
function MoveMenu({
  node,
  projects,
  onPick,
}: {
  node: TaskProject;
  projects: TaskProject[];
  onPick: (parentId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const targets = projects.filter(
    (p) => p.id !== node.id && p.id !== node.parentId && !isDescendant(projects, node.id, p.id),
  );
  const showTop = node.parentId != null;

  return (
    <div className="pw-tb-menu-wrap" ref={wrapRef}>
      <button
        className={`pw-icon-btn ${open ? "is-active" : ""}`}
        title="移动到…"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon.Fwd size={13} />
      </button>
      {open ? (
        <div className="pw-tb-menu" role="menu">
          {showTop ? (
            <button
              className="pw-tb-menu-item"
              role="menuitem"
              onClick={() => {
                onPick(null);
                setOpen(false);
              }}
            >
              <Icon.Expand size={14} />
              <span>提到顶层</span>
            </button>
          ) : null}
          {targets.length === 0 && !showTop ? (
            <div className="pw-empty-hint">没有可移动到的目标</div>
          ) : (
            targets.map((p) => (
              <button
                key={p.id}
                className="pw-tb-menu-item"
                role="menuitem"
                onClick={() => {
                  onPick(p.id);
                  setOpen(false);
                }}
              >
                {projectKind(p) === "folder" ? <Icon.Folder size={14} /> : <Icon.Task size={14} />}
                <span>{p.name}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// 「执行模式」上下文菜单（U8/KTD5）：仅 project 节点提供（folder 不容纳任务、模式无意义）。
// 并行 = 任务各自可用；顺序 = 仅首个未完结顶层任务及其子树可用。当前档打勾。
function ModeMenu({ mode, onPick }: { mode: TaskProjectMode; onPick: (mode: TaskProjectMode) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div className="pw-tb-menu-wrap" ref={wrapRef}>
      <button
        className={`pw-icon-btn ${open ? "is-active" : ""}`}
        title="执行模式（并行 / 顺序）"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {mode === "sequential" ? <Icon.Sort size={13} /> : <Icon.Split size={13} />}
      </button>
      {open ? (
        <div className="pw-tb-menu" role="menu">
          <button
            className="pw-tb-menu-item"
            role="menuitem"
            onClick={() => {
              onPick("parallel");
              setOpen(false);
            }}
          >
            <Icon.Split size={14} />
            <span>并行</span>
            {mode === "parallel" ? <Icon.Check size={13} /> : null}
          </button>
          <button
            className="pw-tb-menu-item"
            role="menuitem"
            onClick={() => {
              onPick("sequential");
              setOpen(false);
            }}
          >
            <Icon.Sort size={14} />
            <span>顺序</span>
            {mode === "sequential" ? <Icon.Check size={13} /> : null}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// 树节点上下文：集中透传给递归 TreeNode，避免逐层重复声明一长串 props。
interface NodeCtx {
  selection: WorkbenchSelection;
  onSelect: (sel: WorkbenchSelection) => void;
  projects: TaskProject[];
  // 折叠态集合（U11）：含于集合 = 被折叠，否则展开（默认全展开）。
  collapsed: Set<string>;
  toggle: (id: string) => void;
  creating: { parentId: string | null; kind: TaskProjectKind } | null;
  editingId: string | null;
  beginCreate: (parentId: string | null, kind: TaskProjectKind) => void;
  beginRename: (id: string) => void;
  submitCreate: (name: string) => void;
  cancelCreate: () => void;
  submitRename: (id: string, name: string) => void;
  cancelRename: () => void;
  moveNode: (id: string, parentId: string | null) => void;
  setMode: (id: string, mode: TaskProjectMode) => void;
  deleteNode: (id: string) => void;
  onNodeKeyDown: (e: React.KeyboardEvent, node: TaskProjectNode) => void;
}

function TreeNode({ node, depth, ctx }: { node: TaskProjectNode; depth: number; ctx: NodeCtx }) {
  // 删除就地二次确认（首点变红 ✓，再点真删；鼠标移开重置），复用 SessionRow 的范式，不弹对话框。
  const [confirming, setConfirming] = useState(false);
  const isFolder = projectKind(node) === "folder";
  // 执行模式仅对 project 有意义（folder 不容纳任务）；顺序项目在树节点上打标识（U8/R24）。
  const mode = projectMode(node);
  const isSequential = !isFolder && mode === "sequential";
  const hasChildren = node.children.length > 0;
  // 默认展开：仅当节点被登记进 collapsed 才视为折叠。
  const isExpanded = !ctx.collapsed.has(node.id);
  const selKind: "folder" | "project" = isFolder ? "folder" : "project";
  const active =
    (ctx.selection.kind === "folder" || ctx.selection.kind === "project") && ctx.selection.id === node.id;
  const editing = ctx.editingId === node.id;

  return (
    <div className="pw-project" role="none">
      <div
        className="pw-project-h"
        data-active={active}
        role="treeitem"
        aria-selected={active}
        aria-expanded={hasChildren ? isExpanded : undefined}
        tabIndex={0}
        style={{ paddingLeft: depth * INDENT }}
        onKeyDown={(e) => ctx.onNodeKeyDown(e, node)}
        onMouseLeave={() => setConfirming(false)}
      >
        {hasChildren ? (
          <button
            className="pw-project-chev"
            tabIndex={-1}
            title={isExpanded ? "折叠" : "展开"}
            onClick={() => ctx.toggle(node.id)}
          >
            <span className="chev">
              <Icon.Chevron size={11} />
            </span>
          </button>
        ) : (
          <span className="pw-ptree-chev-spacer" />
        )}
        {editing ? (
          <InlineInput
            initial={node.name}
            placeholder="重命名"
            indent={0}
            onSubmit={(v) => ctx.submitRename(node.id, v)}
            onCancel={ctx.cancelRename}
          />
        ) : (
          <button
            className="pw-project-toggle"
            tabIndex={-1}
            title={node.name}
            onClick={() => ctx.onSelect({ kind: selKind, id: node.id })}
          >
            {isFolder ? <Icon.Folder size={14} /> : <Icon.Task size={14} />}
            <span className="pw-project-name">{node.name}</span>
            {/* 顺序项目标识：与中栏组头模式标识呼应（U8/R24） */}
            {isSequential ? (
              <span className="pw-project-mode" title="顺序项目（仅首个可用）" aria-label="顺序项目">
                <Icon.Sort size={11} />
              </span>
            ) : null}
          </button>
        )}
        {!editing ? (
          <div className="pw-project-actions">
            {/* project 节点下只允许子项目；folder 节点下可建 folder/project */}
            <AddMenu allowFolder={isFolder} title="在其下新建" onPick={(k) => ctx.beginCreate(node.id, k)} />
            <button className="pw-icon-btn" title="重命名" tabIndex={-1} onClick={() => ctx.beginRename(node.id)}>
              <Icon.Edit size={13} />
            </button>
            {/* 执行模式切换仅 project 可用（folder 不容纳任务、模式无意义） */}
            {!isFolder ? <ModeMenu mode={mode} onPick={(m) => ctx.setMode(node.id, m)} /> : null}
            <MoveMenu node={node} projects={ctx.projects} onPick={(pid) => ctx.moveNode(node.id, pid)} />
            <button
              className={`pw-icon-btn pw-session-act ${confirming ? "is-danger" : ""}`}
              title={confirming ? "再点确认删除" : "删除"}
              tabIndex={-1}
              onClick={() => {
                if (!confirming) {
                  setConfirming(true);
                  return;
                }
                ctx.deleteNode(node.id);
              }}
            >
              {confirming ? <Icon.Check size={13} /> : <Icon.Trash size={13} />}
            </button>
          </div>
        ) : null}
      </div>
      {/* 在本节点下新建的就地输入：作为第一行子项（beginCreate 已自动展开父节点使其可见） */}
      {ctx.creating && ctx.creating.parentId === node.id ? (
        <InlineInput
          initial=""
          placeholder={ctx.creating.kind === "folder" ? "文件夹名称" : "项目名称"}
          indent={(depth + 1) * INDENT + 8}
          onSubmit={ctx.submitCreate}
          onCancel={ctx.cancelCreate}
        />
      ) : null}
      {isExpanded && hasChildren ? (
        <div role="group">
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} depth={depth + 1} ctx={ctx} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProjectTree({
  selection,
  onSelect,
  onToast,
  showInbox = true,
}: {
  selection: WorkbenchSelection;
  onSelect: (sel: WorkbenchSelection) => void;
  // 无 toast 宿主时静默（容器暂未接 toast）。
  onToast?: (text: string) => void;
  // 「显示收件箱」结构开关（U5/R10）：关闭时隐藏收件箱入口（容器负责重定向已选中的 inbox）。
  showInbox?: boolean;
}) {
  const projects = useTaskProjects().data ?? [];
  const addProject = useAddTaskProject();
  const updateProject = useUpdateTaskProject();
  const deleteProject = useDeleteTaskProject();

  // 折叠态集合（U11）：默认全展开，仅记被用户折叠的节点；初值读 localStorage 窄通道，变化即回写。
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      // 无本地存储（隐私模式等）不阻断交互，仅丢失本次持久化。
    }
  }, [collapsed]);
  // 同一时刻只允许一个新建输入 / 一个重命名输入，避免多输入并存的焦点争抢。
  const [creating, setCreating] = useState<{ parentId: string | null; kind: TaskProjectKind } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const roots = useMemo(() => buildProjectTree(projects), [projects]);

  // 折叠 ⇄ 展开：在 collapsed 集合中增删该 id（含 = 折叠）。
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // 确保某节点展开（从 collapsed 移除）；已展开则原样返回，避免多余渲染。
  const expand = (id: string) =>
    setCollapsed((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });

  const beginCreate = (parentId: string | null, kind: TaskProjectKind) => {
    if (parentId) expand(parentId); // 展开父节点，露出新建输入
    setEditingId(null);
    setCreating({ parentId, kind });
  };
  const submitCreate = (name: string) => {
    const trimmed = name.trim();
    if (trimmed && creating) {
      addProject.mutate({ name: trimmed, parentId: creating.parentId ?? undefined, kind: creating.kind });
      onToast?.(`已新建${creating.kind === "folder" ? "文件夹" : "项目"} ${trimmed}`);
    }
    setCreating(null);
  };

  const beginRename = (id: string) => {
    setCreating(null);
    setEditingId(id);
  };
  const submitRename = (id: string, name: string) => {
    const trimmed = name.trim();
    const cur = projects.find((p) => p.id === id);
    if (trimmed && cur && trimmed !== cur.name) updateProject.mutate({ id, patch: { name: trimmed } });
    setEditingId(null);
  };

  const moveNode = (id: string, parentId: string | null) => {
    // 成环最终由 store 拒绝：mutate onError 兜底提示（候选列表已用 isDescendant 预筛，正常走不到这里）。
    updateProject.mutate(
      { id, patch: { parentId } },
      { onError: () => onToast?.("不能移到自身或其子级") },
    );
  };
  // 切换执行模式（U8/KTD5）：复用 updateProject 写回，广播后中栏「可用/首先可用」档即时收窄/放宽。
  const setMode = (id: string, mode: TaskProjectMode) => {
    const cur = projects.find((p) => p.id === id);
    if (cur && projectMode(cur) === mode) return; // 同档不写，避免多余 mutate
    updateProject.mutate({ id, patch: { mode } });
    onToast?.(mode === "sequential" ? "已设为顺序项目" : "已设为并行项目");
  };
  const deleteNode = (id: string) => {
    // store 已做「子节点上提 + 任务回 Inbox」（KTD10），UI 无需额外处理。
    deleteProject.mutate(id);
    if (
      (selection.kind === "folder" || selection.kind === "project") &&
      selection.id === id
    ) {
      onSelect({ kind: "inbox" }); // 删的是当前选中节点 → 右侧回落到收件箱，避免悬空选择
    }
  };

  // 方向键在「可见 treeitem」间移动焦点（DOM 顺序即视觉顺序）；左右折叠 / 展开。基本可达性（v1）。
  const focusRel = (current: HTMLElement, dir: 1 | -1) => {
    const items = treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
    if (!items) return;
    const arr = Array.from(items);
    const next = arr[arr.indexOf(current) + dir];
    next?.focus();
  };
  const onNodeKeyDown = (e: React.KeyboardEvent, node: TaskProjectNode) => {
    const el = e.currentTarget as HTMLElement;
    const hasChildren = node.children.length > 0;
    const isExpanded = !collapsed.has(node.id);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRel(el, 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRel(el, -1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (hasChildren && !isExpanded) toggle(node.id);
        else if (hasChildren) focusRel(el, 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (hasChildren && isExpanded) toggle(node.id);
        else focusRel(el, -1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onSelect({ kind: projectKind(node) === "folder" ? "folder" : "project", id: node.id });
        break;
    }
  };

  const ctx: NodeCtx = {
    selection,
    onSelect,
    projects,
    collapsed,
    toggle,
    creating,
    editingId,
    beginCreate,
    beginRename,
    submitCreate,
    cancelCreate: () => setCreating(null),
    submitRename,
    cancelRename: () => setEditingId(null),
    moveNode,
    setMode,
    deleteNode,
    onNodeKeyDown,
  };

  return (
    <div className="pw-ptree">
      {/* 内置视图入口：今日 / 收件箱（固定，置于项目树上方） */}
      <div className="pw-ptree-views" role="tablist" aria-label="内置视图">
        <button
          className={`pw-task-tab pw-ptree-view${selection.kind === "today" ? " is-active" : ""}`}
          role="tab"
          aria-selected={selection.kind === "today"}
          onClick={() => onSelect({ kind: "today" })}
        >
          <Icon.Clock size={14} />
          <span>今日</span>
        </button>
        {showInbox ? (
          <button
            className={`pw-task-tab pw-ptree-view${selection.kind === "inbox" ? " is-active" : ""}`}
            role="tab"
            aria-selected={selection.kind === "inbox"}
            onClick={() => onSelect({ kind: "inbox" })}
          >
            <Icon.StickyNote size={14} />
            <span>收件箱</span>
          </button>
        ) : null}
      </div>
      {/* 项目区标题 + 常驻「＋」：不依赖选中即可建顶层 folder / project */}
      <div className="pw-ptree-head">
        <span className="pw-ptree-head-title">项目</span>
        <AddMenu allowFolder title="新建项目 / 文件夹" onPick={(k) => beginCreate(null, k)} />
      </div>
      <div className="pw-ptree-body" role="tree" aria-label="项目树" ref={treeRef}>
        {creating && creating.parentId === null ? (
          <InlineInput
            initial=""
            placeholder={creating.kind === "folder" ? "文件夹名称" : "项目名称"}
            indent={8}
            onSubmit={submitCreate}
            onCancel={() => setCreating(null)}
          />
        ) : null}
        {roots.map((n) => (
          <TreeNode key={n.id} node={n} depth={0} ctx={ctx} />
        ))}
        {roots.length === 0 && !creating ? (
          <div className="pw-ptree-empty">
            <div className="pw-empty-hint">还没有项目</div>
            <button className="pw-task-tab pw-ptree-view" onClick={() => beginCreate(null, "project")}>
              <Icon.Plus size={13} />
              <span>新建项目</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
