// 三栏「项目」工作台容器。自 U3 起运行在「项目管理」独立桌面窗口（projects.html）的根，
// 不再是主窗口内的 fixed 覆盖层；关窗交给系统红绿灯（KTD8：ESC 不再关窗、头部 X 已退役）。
// 薄容器：持有 UI 瞬态选中态（选中节点 / 选中任务，不复制服务端态，KTD8）+ 左树浏览历史（KTD7）
// + 边栏显隐（KTD9 窗口专属窄通道）+ 根挂订阅；三列由 ProjectTree（左）/ TaskListColumn（中）/
// TaskDetail（右）填充，顶部由 WorkbenchToolbar 自绘（U4）。
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core";
import {
  useTasks,
  useTasksChangeSubscription,
  useTaskResourcesSubscription,
  useAddTask,
  useTaskProjects,
} from "@cortex-work/core/personal/tasks";
import { subtreeNodeIds, descendantProjectIds } from "@cortex-work/core/personal/taskProjectTree";
import type { TaskProject } from "@cortex-work/core/desktop/types";
import { ProjectTree } from "./ProjectTree";
import { TaskListColumn } from "./TaskListColumn";
import { TaskDetail } from "./TaskDetail";
import { ProjectWorkspaceHeader } from "./ProjectWorkspaceHeader";
import { ProjectStagesBar, type StageViewMode } from "./ProjectStagesBar";
import { StageTimeline } from "./StageTimeline";
import { WorkbenchToolbar } from "./WorkbenchToolbar";
import { WorkbenchSettingsView } from "./WorkbenchSettingsView";
import { QuickOpenDialog } from "./QuickOpenDialog";
import type { QuickOpenResult } from "./quickOpenSearch";
import {
  parseDisplayFields,
  parseEditFields,
  type DisplayFieldPrefs,
  type EditFieldPrefs,
} from "./workbenchFieldPrefs";
import type { ViewOptions } from "./ViewOptionsPopover";

// 左树当前选择：内置视图（今日 / 收件箱）或某个 project/folder 节点。
// U6 ProjectTree 产出、U7 TaskListColumn 消费（folder/project 统一走 descendantProjectIds 聚合）。
export type WorkbenchSelection =
  | { kind: "today" }
  | { kind: "inbox" }
  | { kind: "project"; id: string }
  | { kind: "folder"; id: string };

// ── 浏览历史（KTD7，组件级瞬态，不持久化）纯逻辑 ────────────────────────────
// 单向前后栈：entries[index] 即当前选择。用户主动选择 → push（截断前进分支）；后退 / 前进只挪 index、
// 不 push（往返不膨胀栈）；指向已删除 project/folder 的死条目由 pruneHistory 剪除并重映射 index。
export interface SelectionHistory {
  entries: WorkbenchSelection[];
  index: number;
}

// 两个选择是否等价（今日 / 收件箱无 id；project/folder 比 kind + id）。用于「重选当前不 push」去重。
export function sameSelection(a: WorkbenchSelection, b: WorkbenchSelection): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "project" || a.kind === "folder") && (b.kind === "project" || b.kind === "folder")) {
    return a.id === b.id;
  }
  return true;
}

// 选择是否仍指向存活节点：内置视图恒存活；project/folder 需其 id 仍在项目表中（已删 → 死条目）。
export function selectionAlive(sel: WorkbenchSelection, projects: TaskProject[]): boolean {
  if (sel.kind === "project" || sel.kind === "folder") return projects.some((p) => p.id === sel.id);
  return true;
}

// push 一次用户主动选择：与当前相同则原样返回（不膨胀栈）；否则截断 index 之后的前进分支再追加。
export function pushSelection(hist: SelectionHistory, sel: WorkbenchSelection): SelectionHistory {
  const cur = hist.entries[hist.index];
  if (cur && sameSelection(cur, sel)) return hist;
  const kept = hist.entries.slice(0, hist.index + 1);
  return { entries: [...kept, sel], index: kept.length };
}

export function goBackHistory(hist: SelectionHistory): SelectionHistory {
  return hist.index > 0 ? { ...hist, index: hist.index - 1 } : hist;
}
export function goForwardHistory(hist: SelectionHistory): SelectionHistory {
  return hist.index < hist.entries.length - 1 ? { ...hist, index: hist.index + 1 } : hist;
}

// 剪除死条目（KTD7）：过滤掉指向已删除节点的条目，并把 index 重映射到「不早于原位置的最近存活项」。
// 当前选中若被删已由 ProjectTree.deleteNode 先行改选，故 current 恒存活；全空兜底回今日。
export function pruneHistory(hist: SelectionHistory, projects: TaskProject[]): SelectionHistory {
  const liveIdx: number[] = [];
  hist.entries.forEach((e, i) => {
    if (selectionAlive(e, projects)) liveIdx.push(i);
  });
  if (liveIdx.length === hist.entries.length) return hist; // 无死条目，原样
  const entries = liveIdx.map((i) => hist.entries[i]!); // i 源自 entries 遍历，恒有值
  if (entries.length === 0) return { entries: [{ kind: "today" }], index: 0 };
  const before = liveIdx.filter((i) => i <= hist.index).length; // 原位置及之前的存活条目数
  const index = Math.min(entries.length - 1, Math.max(0, before - 1));
  return { entries, index };
}

// ── 边栏显隐窄通道（KTD9）─────────────────────────────────────────────────
// 项目管理窗口刻意不挂 usePersonalPersistence 全量持久化（否则会以陈旧全量快照 clobber 主窗口写入）；
// 边栏显隐是纯窗口视图态，用本窗口 localStorage 作专属窄通道读写，不进 toPersistedState。
// 跨进程 KV 通道未建立前，localStorage 是最小、隔离且够用的落点（views 层可用浏览器 API）。
const SIDEBAR_KEY = "cortex.projects.sidebarVisible";
// 项目详情「列表 / timeline」视图偏好（同款窗口专属窄通道）。
const STAGE_VIEW_KEY = "cortex.projects.stageView";
function readSidebarVisible(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "0"; // 缺省（首开）显示边栏
  } catch {
    return true;
  }
}

// ── 显示弹层视图态窄通道（KTD9）───────────────────────────────────────────────
// 四档过滤 + 结构开关同属窗口专属视图态，用同款 localStorage 窄通道读写（不进 toPersistedState，
// 避免双窗口 clobber）。缺省：剩余档（对齐旧「进行中」直觉）、显示收件箱、不展开文件夹组头。
const VIEW_OPTIONS_KEY = "cortex.projects.viewOptions";
const DEFAULT_VIEW_OPTIONS: ViewOptions = { filter: "remaining", showInbox: true, showFolders: false };
function readViewOptions(): ViewOptions {
  try {
    const raw = window.localStorage.getItem(VIEW_OPTIONS_KEY);
    if (!raw) return DEFAULT_VIEW_OPTIONS;
    const parsed = JSON.parse(raw) as Partial<ViewOptions>;
    // 逐字段补默认：容忍旧结构/缺字段，避免坏值致空档。
    return {
      filter: parsed.filter ?? DEFAULT_VIEW_OPTIONS.filter,
      showInbox: parsed.showInbox ?? DEFAULT_VIEW_OPTIONS.showInbox,
      showFolders: parsed.showFolders ?? DEFAULT_VIEW_OPTIONS.showFolders,
    };
  } catch {
    return DEFAULT_VIEW_OPTIONS;
  }
}

// ── 字段显隐偏好窄通道（KTD9）──────────────────────────────────────────────
// 「设置显示字段 / 设置编辑字段」同属窗口专属视图态，沿用同款 localStorage 窄通道
// （不进 toPersistedState，避免双窗口 clobber）。容错解析在 workbenchFieldPrefs 纯函数中。
const DISPLAY_FIELDS_KEY = "cortex.projects.displayFields";
const EDIT_FIELDS_KEY = "cortex.projects.editFields";
// localStorage 本身可能抛（隐私模式等），与坏 JSON 一样兜底回全默认。
function readDisplayFields(): DisplayFieldPrefs {
  try {
    return parseDisplayFields(window.localStorage.getItem(DISPLAY_FIELDS_KEY));
  } catch {
    return parseDisplayFields(null);
  }
}
function readEditFields(): EditFieldPrefs {
  try {
    return parseEditFields(window.localStorage.getItem(EDIT_FIELDS_KEY));
  } catch {
    return parseEditFields(null);
  }
}

// 聚焦目标（工具栏「聚焦」，OmniFocus 语义）：左树只显示该节点子树。窗口级瞬态，刻意不持久化——
// 重启即回全树（持久化会带来「我的项目怎么没了」困惑与启动期焦点存活校验）。
export type WorkbenchFocus = { kind: "project" | "folder"; id: string } | null;

// onToast 由窗口根透传（工作台内委派/新建等动作需给用户反馈）。
export function ProjectsWorkbench({ onToast }: { onToast: (text: string) => void }) {
  // 详情列宽：默认 322，并把持久化旧值夹进 [322,720]——老用户可能存过 <322 的宽度（旧下限 320），
  // 读回时统一抬到新下限，避免残留过窄。
  const storedDetailWidth = usePersonalStore((s) => s.projectsDetailWidth);
  const detailWidth = Math.min(720, Math.max(322, storedDetailWidth ?? 322));
  const setDetailWidth = usePersonalStore((s) => s.setProjectsDetailWidth);
  // 根挂载订阅：后台结构化 / agent 委派回写 → invalidate 刷新三栏（KTD8；历史 notes 零挂载 bug 在先）。
  useTasksChangeSubscription();
  // 资源（成员/岗位/模板）变更订阅：跨窗口 CRUD 后 invalidate 重拉（设置视图与任务字段共用）。
  useTaskResourcesSubscription();

  const projects = useTaskProjects().data ?? [];
  const addTask = useAddTask();

  // 右列拖拽调宽：详情是最右列，故宽 = 窗口右缘到鼠标 x 的距离；夹在 [322, 720]。
  // 拖动期间全局监听 mousemove/up，禁选中文本；松手写入持久客户端态。
  const onResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(720, Math.max(322, window.innerWidth - ev.clientX));
      setDetailWidth(w);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // 左树浏览历史（KTD7）：selection 即 entries[index]，不再单独持有 selection state。
  const [hist, setHist] = useState<SelectionHistory>({ entries: [{ kind: "today" }], index: 0 });
  const selection = hist.entries[hist.index] ?? { kind: "today" };
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // R11：刚新建任务的 id——无视当前过滤强制可见并选中。用户切档/换选/导航即失效（见下）。
  const [forcedVisibleId, setForcedVisibleId] = useState<string | null>(null);
  // U12：新建期空白任务 id——其标题失焦（含 ESC）时若仍空白且未设其它信息，则由中列撤销该新建。
  const [pendingNewTaskId, setPendingNewTaskId] = useState<string | null>(null);

  // 选中语义分两路：普通选中（行点击）受过滤（R18 可将其清除）；新建选中强制可见（R11）。
  const selectTask = (id: string | null) => {
    setSelectedTaskId(id);
    setForcedVisibleId(null);
    // 仅当换选到「别的任务」或清空时放弃新建期判定；重选当前 pending 任务须保留——
    // 空白新建后标题 autoFocus 会经 onFocus→onOpenTask 回选自身，若无条件清除会在用户失焦前就抹掉 pending。
    setPendingNewTaskId((cur) => (cur === id ? cur : null));
  };
  // pending=true（U12）表示新建的是空白任务：记为 pendingNewTaskId 以启用离焦撤销；有标题的快速新增传 false。
  const selectCreated = (id: string, pending = false) => {
    setSelectedTaskId(id);
    setForcedVisibleId(id);
    setPendingNewTaskId(pending ? id : null);
  };

  // projects 变化即剪除历史死条目（KTD7）：删除项目后后退不落到空组。
  useEffect(() => {
    setHist((h) => pruneHistory(h, projects));
  }, [projects]);

  // 用户主动选择左树节点/内置视图 → 入栈；切换选择即清空右列选中任务（选中态是 UI 瞬态，KTD8）。
  const navigateTo = (sel: WorkbenchSelection) => {
    selectTask(null);
    setHist((h) => pushSelection(h, sel));
  };
  const canGoBack = hist.index > 0;
  const canGoForward = hist.index < hist.entries.length - 1;
  // 后退 / 前进只挪 index（不 push），并清空右列选中（切换了浏览位置）。
  const goBack = () => {
    selectTask(null);
    setHist(goBackHistory);
  };
  const goForward = () => {
    selectTask(null);
    setHist(goForwardHistory);
  };

  // ── 聚焦（工具栏「聚焦」，OmniFocus 语义）────────────────────────────────
  // 窗口级瞬态（见 WorkbenchFocus 注释）。进入条件：当前选中 project/folder；聚焦中可再点退出。
  const [focus, setFocus] = useState<WorkbenchFocus>(null);
  const canFocus = focus != null || selection.kind === "project" || selection.kind === "folder";
  const onToggleFocus = () => {
    if (focus) {
      setFocus(null);
      return;
    }
    if (selection.kind === "project" || selection.kind === "folder") {
      setFocus({ kind: selection.kind, id: selection.id });
    }
  };
  // 焦点目标被删 → 自动解焦（历史死条目由 pruneHistory 独立剪除，二者互不依赖）。
  useEffect(() => {
    if (focus && !projects.some((p) => p.id === focus.id)) setFocus(null);
  }, [projects, focus]);
  // 聚焦态下 selection 漂出焦点子树（后退/前进、showInbox 重定向等）→ 拉回焦点根。
  // pushSelection 对相同选择原样返回，setHist 收敛，不会形成更新循环。
  useEffect(() => {
    if (!focus) return;
    const sub = subtreeNodeIds(projects, focus.id);
    const inside = (selection.kind === "project" || selection.kind === "folder") && sub.has(selection.id);
    if (!inside) setHist((h) => pushSelection(h, { kind: focus.kind, id: focus.id }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, selection, projects]);

  // 边栏显隐（KTD9 窄通道）：初值读 localStorage，变化即回写。
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(readSidebarVisible);
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, sidebarVisible ? "1" : "0");
    } catch {
      // 无本地存储（隐私模式等）不阻断交互，仅丢失本次持久化。
    }
  }, [sidebarVisible]);

  // 显示弹层视图态（KTD9 窄通道）：四档过滤 + 结构开关。初值读 localStorage，变化即回写。
  const [viewOptions, setViewOptions] = useState<ViewOptions>(readViewOptions);
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_OPTIONS_KEY, JSON.stringify(viewOptions));
    } catch {
      // 同 sidebar：无本地存储不阻断，仅丢失本次持久化。
    }
  }, [viewOptions]);

  // 字段显隐偏好（KTD9 窄通道）：设置显示 / 编辑字段。初值读 localStorage，变化即回写。
  const [displayFields, setDisplayFields] = useState<DisplayFieldPrefs>(readDisplayFields);
  const [editFields, setEditFields] = useState<EditFieldPrefs>(readEditFields);
  useEffect(() => {
    try {
      window.localStorage.setItem(DISPLAY_FIELDS_KEY, JSON.stringify(displayFields));
    } catch {
      // 同 sidebar：无本地存储不阻断，仅丢失本次持久化。
    }
  }, [displayFields]);
  useEffect(() => {
    try {
      window.localStorage.setItem(EDIT_FIELDS_KEY, JSON.stringify(editFields));
    } catch {
      // 同上。
    }
  }, [editFields]);

  // 切换过滤档即撤销「强制可见」（R11/R18 边界）：新建任务的过滤豁免只在当前档有效；
  // 用户切档后该任务回归常规过滤，若因此隐藏则由中栏 onSelectedHidden 走 R18 清除。
  useEffect(() => {
    setForcedVisibleId(null);
  }, [viewOptions.filter]);

  // 「显示收件箱」关闭且正选中收件箱 → 重定向今日（R10/R18 同款悬空处理）。
  // ProjectTree 关闭态已隐藏 inbox 入口，此处兜住「在 inbox 时关开关」的即时重定向。
  useEffect(() => {
    if (!viewOptions.showInbox && selection.kind === "inbox") {
      selectTask(null);
      setHist((h) => pushSelection(h, { kind: "today" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewOptions.showInbox, selection]);

  // 新建动作（R11）：project 选中 → 落该 project；否则落收件箱。建后强制可见选中、标题进入编辑态。
  const onNewAction = async () => {
    const projectId = selection.kind === "project" ? selection.id : undefined;
    try {
      const created = await addTask.mutateAsync({ title: "", projectId, source: "manual" });
      selectCreated(created.id, true); // U12：空白新建 → 标记新建期，标题离焦仍空白即撤销
    } catch {
      onToast("新建任务失败，请重试");
    }
  };

  // ESC 语义（KTD8）：行内编辑中 → 退出编辑（blur 当前输入）；无编辑时 → 清除选中回空态；绝不关窗。
  // keydown 由子输入冒泡至根（ProjectTree 的 InlineInput 自行拦截 ESC 并 stopPropagation，走各自取消）。
  const onRootKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== "Escape") return;
    const active = document.activeElement as HTMLElement | null;
    const editing =
      !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
    if (editing) {
      active!.blur();
      return;
    }
    if (selectedTaskId) selectTask(null);
  };

  // 右列详情：把选中 id 解析为任务对象（已删/悬空 → undefined，右列回空态）。
  const { data: tasksData } = useTasks();
  const selectedTask = selectedTaskId ? (tasksData ?? []).find((t) => t.id === selectedTaskId) : undefined;

  // 项目详情态：选中 project 时中列换渲染「头部 + 阶段栏 + 列表/timeline」。
  // 头部进度的分母 = 项目子树（含子项目）全部任务，与 IFocus「done/总数」口径一致。
  const selectedProject = selection.kind === "project" ? projects.find((p) => p.id === selection.id) : undefined;
  const projectScopeTasks = (() => {
    if (!selectedProject) return [];
    const ids = new Set(descendantProjectIds(projects, selectedProject.id));
    return (tasksData ?? []).filter((t) => t.projectId && ids.has(t.projectId));
  })();

  // 工作台全局设置视图（阶段模板 / 项目资源）：全窗口覆盖，窗口级瞬态不持久化。
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── 项目详情（选中 project 时中列 = 项目头部 + 阶段栏 + 列表/timeline）──────────
  // 阶段过滤（null=全部）是选中项目内的瞬态：换选即回「全部」。
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  useEffect(() => setActiveStageId(null), [selection]);
  // 列表/timeline 视图偏好：跨项目共享的窗口视图态，走 localStorage 窄通道（同 sidebar）。
  const [stageView, setStageView] = useState<StageViewMode>(() => {
    try {
      return window.localStorage.getItem(STAGE_VIEW_KEY) === "timeline" ? "timeline" : "list";
    } catch {
      return "list";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(STAGE_VIEW_KEY, stageView);
    } catch {
      // 同 sidebar：无本地存储不阻断。
    }
  }, [stageView]);

  // ── 快速入口（工具栏「快速入口」/ ⌘O，命令面板）──────────────────────────
  const [quickOpen, setQuickOpen] = useState(false);
  // ⌘O / Ctrl+O 全局唤起：根 onKeyDown 只在焦点落在容器内时触发，故挂 window 级监听；
  // preventDefault 拦掉浏览器默认「打开文件」。输入框聚焦中也可唤起（快速入口是全局导航）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // 快速入口跳转落点：
  //   project/folder → 左树导航到该节点；
  //   task → 导航到所属存活项目；无项目（或项目已删）落**收件箱**（刻意不落「今日」——今日 scope 按
  //     isTodayEligible 过滤，forcedVisibleId 只并入命中集不扩 scope，落今日会渲染不出），
  //     收件箱被「显示」开关隐藏时自动开启；随后 selectCreated(id,false) 复用 R11 强制可见通道选中。
  //   目标落在聚焦子树外 → 先退出聚焦（否则拉回 effect 会把跳转顶掉）。
  const revealFromQuickOpen = (r: QuickOpenResult) => {
    const exitFocusIfOutside = (nodeId: string | undefined) => {
      if (!focus) return;
      const sub = subtreeNodeIds(projects, focus.id);
      if (!nodeId || !sub.has(nodeId)) setFocus(null);
    };
    if (r.kind === "task") {
      const t = (tasksData ?? []).find((x) => x.id === r.id);
      const pid = t?.projectId && projects.some((p) => p.id === t.projectId) ? t.projectId : undefined;
      exitFocusIfOutside(pid);
      if (!pid && !viewOptions.showInbox) setViewOptions((v) => ({ ...v, showInbox: true }));
      setHist((h) => pushSelection(h, pid ? { kind: "project", id: pid } : { kind: "inbox" }));
      selectCreated(r.id, false);
    } else {
      exitFocusIfOutside(r.id);
      navigateTo({ kind: r.kind, id: r.id });
    }
  };

  return (
    <div className="pw-projects-page" onKeyDown={onRootKeyDown}>
      {/* 顶部 OmniFocus 式自绘工具栏（U4）：drag 区 + 红绿灯让位 + 边栏/历史/显示/新建/快速入口/聚焦/字段设置。 */}
      <WorkbenchToolbar
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={goBack}
        onForward={goForward}
        viewOptions={viewOptions}
        onViewOptionsChange={setViewOptions}
        onNewAction={onNewAction}
        onQuickOpen={() => setQuickOpen(true)}
        focusActive={focus != null}
        canFocus={canFocus}
        onToggleFocus={onToggleFocus}
        displayFields={displayFields}
        onDisplayFieldsChange={setDisplayFields}
        editFields={editFields}
        onEditFieldsChange={setEditFields}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {/* 全局设置视图（阶段模板 / 项目资源）：覆盖三列、保留工具栏。 */}
      {settingsOpen ? <WorkbenchSettingsView onClose={() => setSettingsOpen(false)} onToast={onToast} /> : null}
      {/* 快速入口命令面板：跳转语义见 revealFromQuickOpen；选中后关闭面板。 */}
      <QuickOpenDialog
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        onPick={(r) => {
          revealFromQuickOpen(r);
          setQuickOpen(false);
        }}
      />
      <div className="pw-projects-cols">
        {/* 左列：项目树（U6）。边栏隐藏态下不渲染此列（R8）；showInbox 控制收件箱入口显隐（R10）；
            focus 非空时只渲染焦点子树（工具栏「聚焦」）。 */}
        {sidebarVisible ? (
          <div className="pw-projects-tree">
            <ProjectTree
              selection={selection}
              onSelect={navigateTo}
              onToast={onToast}
              showInbox={viewOptions.showInbox}
              focus={focus}
            />
          </div>
        ) : null}
        {/* 中列：任务清单（U7）。按左树选择聚合，四档过滤（U5），行内动作直达；点标题 → 右列详情（U8）。
            选中 project 时升级为项目详情（参照 IFocus）：头部（名称/进度/齿轮）+ 阶段栏（tab 过滤 +
            列表/timeline 切换）+ 主体（列表内嵌 hideHead，或阶段 timeline）。 */}
        {selectedProject ? (
          <div className="pw-projects-center">
            <ProjectWorkspaceHeader project={selectedProject} tasks={projectScopeTasks} onToast={onToast} />
            <ProjectStagesBar
              project={selectedProject}
              activeStageId={activeStageId}
              onStageChange={setActiveStageId}
              view={stageView}
              onViewChange={setStageView}
              onToast={onToast}
            />
            {stageView === "timeline" ? (
              <StageTimeline stages={selectedProject.stages ?? []} activeStageId={activeStageId} />
            ) : (
              <TaskListColumn
                selection={selection}
                selectedTaskId={selectedTaskId}
                filter={viewOptions.filter}
                forcedVisibleId={forcedVisibleId}
                pendingNewTaskId={pendingNewTaskId}
                onOpenTask={selectTask}
                onCreated={selectCreated}
                onPendingConsumed={() => setPendingNewTaskId(null)}
                onSelectedHidden={() => selectTask(null)}
                onToast={onToast}
                displayFields={displayFields}
                editFields={editFields}
                hideHead
                stageFilter={activeStageId}
              />
            )}
          </div>
        ) : (
          <TaskListColumn
            selection={selection}
            selectedTaskId={selectedTaskId}
            filter={viewOptions.filter}
            forcedVisibleId={forcedVisibleId}
            pendingNewTaskId={pendingNewTaskId}
            onOpenTask={selectTask}
            onCreated={selectCreated}
            onPendingConsumed={() => setPendingNewTaskId(null)}
            onSelectedHidden={() => selectTask(null)}
            onToast={onToast}
            displayFields={displayFields}
            editFields={editFields}
          />
        )}
        {/* 右列拖拽调宽手柄：在详情列左缘。*/}
        <div className="pw-col-resize" onMouseDown={onResizeStart} title="拖动调整详情宽度" />
        {/* 右列：任务详情（U8）。复用 TaskDetail（结构编辑 + 渐进披露富字段）；onBack 清空选中回空态。 */}
        <div className="pw-projects-detail" style={{ width: detailWidth }}>
          {selectedTask ? (
            <TaskDetail task={selectedTask} onBack={() => selectTask(null)} onToast={onToast} />
          ) : (
            // 空态（对齐设计稿右列检查器）：居中图标 + 两行提示。
            <div className="pw-projects-detail-empty">
              <Icon.Task size={30} className="pw-projects-detail-empty-icon" />
              <div className="pw-projects-detail-empty-text">
                选择一个任务
                <br />
                查看详情
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
