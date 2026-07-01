// 全屏三栏「项目」工作台容器（U5）。fixed 全窗覆盖层（.pw-projects-page，见 cortex-desktop.css），
// 由 PersonalWorkspace 在 settings 覆盖层**之前**渲染（栈式：工作台内可叠开设置）。
// 薄容器：持有 UI 瞬态选中态（选中节点 / 选中任务，不复制服务端态，KTD8）+ 根挂订阅；
// 三列由 U6 ProjectTree（左）/ U7 TaskListColumn（中）/ U8 TaskDetail（右）填充。
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { usePersonalStore } from "@cortex-work/core";
import { useTasks, useTasksChangeSubscription } from "@cortex-work/core/personal/tasks";
import { ProjectTree } from "./ProjectTree";
import { TaskListColumn } from "./TaskListColumn";
import { TaskDetail } from "./TaskDetail";

// 左树当前选择：内置视图（今日 / 收件箱）或某个 project/folder 节点。
// U6 ProjectTree 产出、U7 TaskListColumn 消费（folder/project 统一走 descendantProjectIds 聚合）。
export type WorkbenchSelection =
  | { kind: "today" }
  | { kind: "inbox" }
  | { kind: "project"; id: string }
  | { kind: "folder"; id: string };

// onToast 由 PersonalWorkspace 透传（工作台内委派/新建等动作需给用户反馈，而工作台是 fixed
// 覆盖层、盖住底层的 toast 宿主，故须自持 toast 通道）。
export function ProjectsWorkbench({ onToast }: { onToast: (text: string) => void }) {
  const closeProjects = usePersonalStore((s) => s.closeProjects);
  const detailWidth = usePersonalStore((s) => s.projectsDetailWidth) ?? 380;
  const setDetailWidth = usePersonalStore((s) => s.setProjectsDetailWidth);
  // 根挂载订阅：后台结构化 / agent 委派回写 → invalidate 刷新三栏（KTD8；历史 notes 零挂载 bug 在先）。
  useTasksChangeSubscription();

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

  const [selection, setSelection] = useState<WorkbenchSelection>({ kind: "today" });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // 右列详情：把选中 id 解析为任务对象（已删/悬空 → undefined，右列回空态）。
  const { data: tasksData } = useTasks();
  const selectedTask = selectedTaskId ? (tasksData ?? []).find((t) => t.id === selectedTaskId) : undefined;

  // ESC 关闭工作台（回到打开前的底层视图）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeProjects();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeProjects]);

  return (
    <div className="pw-projects-page">
      <div className="pw-projects-head">
        <span className="pw-projects-title">项目</span>
        <div className="spacer" />
        <button className="pw-icon-btn" title="关闭（Esc）" onClick={closeProjects}>
          <Icon.X size={16} />
        </button>
      </div>
      <div className="pw-projects-cols">
        {/* 左列：项目树（U6）。切换节点/内置视图时清空右列选中任务（KTD8：选中态是 UI 瞬态）。 */}
        <div className="pw-projects-tree">
          <ProjectTree
            selection={selection}
            onSelect={(sel) => {
              setSelection(sel);
              setSelectedTaskId(null);
            }}
          />
        </div>
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
