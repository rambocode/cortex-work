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
  useAddTask,
  useAddTaskProject,
  useTaskProjects,
} from "@cortex-work/core/personal/tasks";
import type { TaskProject } from "@cortex-work/core/desktop/types";
import { ProjectTree } from "./ProjectTree";
import { TaskListColumn } from "./TaskListColumn";
import { TaskDetail } from "./TaskDetail";
import { WorkbenchToolbar } from "./WorkbenchToolbar";

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
function readSidebarVisible(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "0"; // 缺省（首开）显示边栏
  } catch {
    return true;
  }
}

// onToast 由窗口根透传（工作台内委派/新建等动作需给用户反馈）。
export function ProjectsWorkbench({ onToast }: { onToast: (text: string) => void }) {
  const detailWidth = usePersonalStore((s) => s.projectsDetailWidth) ?? 380;
  const setDetailWidth = usePersonalStore((s) => s.setProjectsDetailWidth);
  // 根挂载订阅：后台结构化 / agent 委派回写 → invalidate 刷新三栏（KTD8；历史 notes 零挂载 bug 在先）。
  useTasksChangeSubscription();

  const projects = useTaskProjects().data ?? [];
  const addTask = useAddTask();
  const addProject = useAddTaskProject();

  // 右列拖拽调宽：详情是最右列，故宽 = 窗口右缘到鼠标 x 的距离；夹在 [320, 720]。
  // 拖动期间全局监听 mousemove/up，禁选中文本；松手写入持久客户端态。
  const onResizeStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(720, Math.max(320, window.innerWidth - ev.clientX));
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

  // projects 变化即剪除历史死条目（KTD7）：删除项目后后退不落到空组。
  useEffect(() => {
    setHist((h) => pruneHistory(h, projects));
  }, [projects]);

  // 用户主动选择左树节点/内置视图 → 入栈；切换选择即清空右列选中任务（选中态是 UI 瞬态，KTD8）。
  const navigateTo = (sel: WorkbenchSelection) => {
    setSelectedTaskId(null);
    setHist((h) => pushSelection(h, sel));
  };
  const canGoBack = hist.index > 0;
  const canGoForward = hist.index < hist.entries.length - 1;
  // 后退 / 前进只挪 index（不 push），并清空右列选中（切换了浏览位置）。
  const goBack = () => {
    setSelectedTaskId(null);
    setHist(goBackHistory);
  };
  const goForward = () => {
    setSelectedTaskId(null);
    setHist(goForwardHistory);
  };

  // 边栏显隐（KTD9 窄通道）：初值读 localStorage，变化即回写。
  const [sidebarVisible, setSidebarVisible] = useState<boolean>(readSidebarVisible);
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, sidebarVisible ? "1" : "0");
    } catch {
      // 无本地存储（隐私模式等）不阻断交互，仅丢失本次持久化。
    }
  }, [sidebarVisible]);

  // 新建动作（R11 落点语义 U5 完善）：project 选中 → 落该 project；否则落收件箱。建后选中打开详情。
  const onNewAction = async () => {
    const projectId = selection.kind === "project" ? selection.id : undefined;
    try {
      const created = await addTask.mutateAsync({ title: "", projectId, source: "manual" });
      setSelectedTaskId(created.id);
    } catch {
      onToast("新建任务失败，请重试");
    }
  };

  // 新建项目（R8）：隐藏态先自动展开边栏（使新项目可见/可命名），再建顶层 project 并选中。
  // inline 命名 UX 归后续单元，本单元建默认名占位、用户可在左树重命名。
  const onNewProject = async () => {
    setSidebarVisible(true);
    try {
      const created = await addProject.mutateAsync({ name: "新项目", kind: "project" });
      navigateTo({ kind: "project", id: created.id });
    } catch {
      onToast("新建项目失败，请重试");
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
    if (selectedTaskId) setSelectedTaskId(null);
  };

  // 右列详情：把选中 id 解析为任务对象（已删/悬空 → undefined，右列回空态）。
  const { data: tasksData } = useTasks();
  const selectedTask = selectedTaskId ? (tasksData ?? []).find((t) => t.id === selectedTaskId) : undefined;

  return (
    <div className="pw-projects-page" onKeyDown={onRootKeyDown}>
      {/* 顶部 OmniFocus 式自绘工具栏（U4）：drag 区 + 红绿灯让位 + 边栏/历史/新建/占位。 */}
      <WorkbenchToolbar
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={goBack}
        onForward={goForward}
        onNewAction={onNewAction}
        onNewProject={onNewProject}
      />
      <div className="pw-projects-cols">
        {/* 左列：项目树（U6）。边栏隐藏态下不渲染此列（R8）。 */}
        {sidebarVisible ? (
          <div className="pw-projects-tree">
            <ProjectTree selection={selection} onSelect={navigateTo} onToast={onToast} />
          </div>
        ) : null}
        {/* 中列：任务清单（U7）。按左树选择聚合，行内动作直达；点标题 → 右列详情（U8）。 */}
        <TaskListColumn
          selection={selection}
          selectedTaskId={selectedTaskId}
          onOpenTask={setSelectedTaskId}
          onToast={onToast}
        />
        {/* 右列拖拽调宽手柄：在详情列左缘。*/}
        <div className="pw-col-resize" onMouseDown={onResizeStart} title="拖动调整详情宽度" />
        {/* 右列：任务详情（U8）。复用 TaskDetail（结构编辑 + 渐进披露富字段）；onBack 清空选中回空态。 */}
        <div className="pw-projects-detail" style={{ width: detailWidth }}>
          {selectedTask ? (
            <TaskDetail task={selectedTask} onBack={() => setSelectedTaskId(null)} onToast={onToast} />
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
