// 全屏三栏「项目」工作台容器（U5）。fixed 全窗覆盖层（.pw-projects-page，见 cortex-desktop.css），
// 由 PersonalWorkspace 在 settings 覆盖层**之前**渲染（栈式：工作台内可叠开设置）。
// 薄容器：持有 UI 瞬态选中态（选中节点 / 选中任务，不复制服务端态，KTD8）+ 根挂订阅；
// 三列由 U6 ProjectTree（左）/ U7 TaskListColumn（中）/ U8 TaskDetail（右）填充。
import { useEffect, useState } from "react";
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
  // 根挂载订阅：后台结构化 / agent 委派回写 → invalidate 刷新三栏（KTD8；历史 notes 零挂载 bug 在先）。
  useTasksChangeSubscription();

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
        {/* 右列：任务详情（U8）。复用 TaskDetail（结构编辑 + 渐进披露富字段）；onBack 清空选中回空态。 */}
        <div className="pw-projects-detail">
          {selectedTask ? (
            <TaskDetail task={selectedTask} onBack={() => setSelectedTaskId(null)} onToast={onToast} />
          ) : (
            <div className="pw-projects-detail-empty">从中间选择一个任务查看详情</div>
          )}
        </div>
      </div>
    </div>
  );
}
