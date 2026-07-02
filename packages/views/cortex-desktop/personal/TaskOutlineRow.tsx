// 中列大纲行（U6 从 TaskListColumn 拆出，防单文件逼近 1200 行上限）：
// OmniFocus 式任务行 —— 圆形完成勾选 + 行内可编辑标题 + 元数据 chips（R16）+ 备注预览/图标 + 旗标（R17）
// + 折叠三角（子任务）+ 行内 inspector（选中时）。以及 R15 上下文补行 ContextRow。
// 服务端态经上层 hooks 写回（useUpdateTask / RQ cache），本组件只渲染与转发回调，无本地服务端副本。
import { Icon } from "@cortex-work/ui/icons";
import { TaskInlineInspector } from "./TaskInlineInspector";
import { useTaskDraftField } from "./useTaskDraftField";
import { fmtDur } from "./taskFormat";
import type { TaskMeta } from "@cortex-work/core/desktop/types";

// 子任务缩进步距（px）。每深一层左移一档，OmniFocus 风格（U3；U6 视觉细调）。
export const INDENT_STEP = 22;

// 标题输入左缘相对「行内容起点」的固定偏移（px）：折叠三角(16) + gap(8) + 勾选圈(16) + gap(8)。
// 供行内 inspector / 备注预览左缘与标题文字对齐（U9）。depth>0 时再叠加缩进档宽 + 其后一档 flex gap。
const TITLE_LEAD = 48;

// 计算某深度行的标题左缘偏移：depth==0 只有三角+勾选(48)；depth>0 前置缩进 span 及其 flex gap。
function titleLeadOffset(depth: number): number {
  return depth > 0 ? depth * INDENT_STEP + 8 + TITLE_LEAD : TITLE_LEAD;
}

// 备注首行预览（R17）：取第一条非空白行的纯文本；空则返回空串（调用方据此不渲染）。
function noteFirstLine(notes?: string): string {
  if (!notes) return "";
  const line = notes.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim() : "";
}

// R15 上下文补行：父被过滤档滤掉但其子命中时，灰显父标题占位以保留缩进层级。
// 无勾选、无操作、不可选中；纯上下文，避免误改被滤父。补行不承担折叠——其命中子由
// buildTaskTree 直接嵌在其下逐行渲染，无需在补行上再挂折叠箭头。
export function ContextRow({ task, depth }: { task: TaskMeta; depth: number }) {
  return (
    <div className="pw-task-row is-context" aria-hidden>
      <div className="pw-task-row-main">
        {depth > 0 && <span className="pw-task-indent" style={{ width: depth * INDENT_STEP }} aria-hidden />}
        <span className="pw-task-twisty pw-task-twisty-spacer" aria-hidden />
        <span className="pw-task-check pw-task-check-ghost" aria-hidden />
        <span className="pw-task-title-input pw-task-context-title">{task.title || "未命名的动作"}</span>
      </div>
    </div>
  );
}

// 精简任务行：完成勾选 + 标题按钮（点开详情）+ 元数据 chips（R16）+ 备注/旗标图标（R17）+ 快捷动作。
// 相比 TasksView 的 TaskRow 去掉结构化建议 chips（工作台不做捕获结构化，那是右栏主界面的职责）。
export function TaskOutlineRow({
  task,
  today,
  depth,
  hasChildren,
  collapsed,
  onToggleCollapse,
  isSelected,
  onToast,
  suggestComplete,
  projectName,
  groupedByProject,
  onOpen,
  onRename,
  onToggleDone,
  onToggleFlag,
  onDelete,
  onAddSubtask,
  onCompleteSuggested,
  onDelegate,
}: {
  task: TaskMeta;
  today: string;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  isSelected: boolean;
  onToast: (text: string) => void;
  suggestComplete: boolean;
  projectName?: string;
  // 该行是否处于「按项目分组」的组内（组头已显项目名）→ 隐藏行内项目 chip 与其占位，避免重复（R16）。
  groupedByProject: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onToggleDone: () => void;
  onToggleFlag: () => void;
  onDelete: () => void;
  onAddSubtask: () => void;
  onCompleteSuggested: () => void;
  onDelegate: () => void;
}) {
  const overdue = !!task.dueDate && task.dueDate < today;
  const delegated = task.status === "waiting" && !!task.delegation;
  const done = task.status === "done";
  const dropped = task.status === "dropped";
  const notePreview = noteFirstLine(task.notes);
  // 标题左缘偏移：inspector / 备注预览据此与标题文字左对齐（U9）。
  const lead = titleLeadOffset(depth);

  // 行内 chip（R16）：已设置 = is-set 高亮；未设置占位 = is-placeholder 灰显。
  // 点击一律 onOpen 选中该行 → 展开行内 inspector 就地编辑该字段（选中态由 inspector 承接编辑）。
  const chip = (key: string, icon: React.ReactNode, label: string, isSet: boolean, danger?: boolean) => (
    <button
      key={key}
      type="button"
      className={`pw-task-chip${isSet ? " is-set" : " is-placeholder"}${danger ? " is-danger" : ""}`}
      onClick={onOpen}
      title={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div
      className={`pw-task-row${isSelected ? " is-selected" : ""}${done ? " is-done" : ""}${dropped ? " is-dropped" : ""}`}
      data-task-id={task.id}
    >
      <div className="pw-task-row-main">
        {/* 子任务缩进：按 depth 留白（U3；U6 视觉细调）。*/}
        {depth > 0 && <span className="pw-task-indent" style={{ width: depth * INDENT_STEP }} aria-hidden />}
        {/* 折叠箭头：有子任务才显，否则占位对齐。*/}
        {hasChildren ? (
          <button
            className={`pw-task-twisty${collapsed ? "" : " is-open"}`}
            title={collapsed ? "展开子任务" : "折叠子任务"}
            aria-expanded={!collapsed}
            onClick={onToggleCollapse}
          >
            <Icon.Chevron size={11} />
          </button>
        ) : (
          <span className="pw-task-twisty pw-task-twisty-spacer" aria-hidden />
        )}
        <input
          type="checkbox"
          className="pw-task-check"
          checked={done}
          onChange={onToggleDone}
          title={done ? "取消完成" : "完成"}
        />
        {/* 行内可编辑标题（问题2）：空标题显「未命名的动作」占位；聚焦即选中该行（展开 inspector）。*/}
        <TaskTitleInput taskId={task.id} value={task.title} struck={done || dropped} onFocus={onOpen} onSave={onRename} />
        {/* 元数据 chips（R16 → U9）：未选中行常显已设置字段（is-set 实色），未设置字段常显灰占位
            （is-placeholder，弱灰视觉），对齐 OmniFocus「自定义流体」默认态。占位不再仅悬停出现。
            选中行的字段编辑交由行内 inspector（下方），此处不重复渲染，避免双份 chip。 */}
        {!isSelected && (
          <div className="pw-task-chips">
            {!groupedByProject && projectName && chip("project", <Icon.Task size={11} />, projectName, true)}
            {task.tags.length > 0 && chip("tags", <Icon.Tags size={11} />, task.tags.join("、"), true)}
            {task.estimatedDuration != null && chip("duration", <Icon.Clock size={11} />, fmtDur(task.estimatedDuration), true)}
            {task.deferDate && chip("defer", <Icon.Fwd size={11} />, `推迟 ${task.deferDate}`, true)}
            {task.dueDate && chip("due", <Icon.Clock size={11} />, `截止 ${task.dueDate}`, true, overdue)}
            {task.repeat != null && chip("repeat", <Icon.Retry size={11} />, "重复", true)}
            {task.reminder?.at != null && chip("reminder", <Icon.Bell size={11} />, "已设提醒", true)}
            {delegated && <span className="pw-task-chip is-set is-wait">委派中</span>}
            {task.status === "in-progress" && <span className="pw-task-chip is-set is-run">进行中</span>}
            {/* 未设置字段的灰占位（U9）：默认常显，点击即进入对应字段编辑（选中行展开 inspector）。*/}
            {!groupedByProject && !projectName && chip("project-ph", <Icon.Task size={11} />, "项目", false)}
            {task.tags.length === 0 && chip("tags-ph", <Icon.Tags size={11} />, "标签", false)}
            {task.estimatedDuration == null && chip("duration-ph", <Icon.Clock size={11} />, "持续时间", false)}
            {!task.deferDate && chip("defer-ph", <Icon.Fwd size={11} />, "推迟至", false)}
            {!task.dueDate && chip("due-ph", <Icon.Clock size={11} />, "截止", false)}
            {task.repeat == null && chip("repeat-ph", <Icon.Retry size={11} />, "重复", false)}
            {task.reminder?.at == null && chip("reminder-ph", <Icon.Bell size={11} />, "通知", false)}
          </div>
        )}
        {/* 完成 rollup 建议（R5/KTD4）：全部子任务已完成时浮现，点击确认才置父 done（不自动）。*/}
        {suggestComplete && !done && (
          <button className="pw-task-badge is-suggest" title="全部子任务已完成，点击完成此任务" onClick={onCompleteSuggested}>
            ✓ 完成此任务
          </button>
        )}
        <div className="spacer" />
        {/* 备注图标（R17）：有备注时常显作指示。*/}
        {notePreview && (
          <span className="pw-task-note-flag" title="有备注" aria-label="有备注">
            <Icon.Comment size={12} />
          </span>
        )}
        {/* 添加子任务（U4）。*/}
        <button className="pw-icon-btn" title="添加子任务" onClick={onAddSubtask}>
          <Icon.Plus size={13} />
        </button>
        {/* 委派仅对 active 任务开放（waiting 已在跑，避免二次委派）。*/}
        {task.status === "active" && (
          <button className="pw-icon-btn" title="交给 agent 执行" onClick={onDelegate}>
            <Icon.Bot size={13} />
          </button>
        )}
        {/* 旗标图标（R17）：常显，已标记高亮。*/}
        <button
          className={`pw-icon-btn pw-task-flag${task.flagged ? " is-on" : ""}`}
          title={task.flagged ? "取消标记" : "标记"}
          onClick={onToggleFlag}
        >
          ⚑
        </button>
        <button className="pw-icon-btn" title="删除" onClick={onDelete}>
          <Icon.Trash size={13} />
        </button>
      </div>
      {/* 备注首行预览（R17）：标题下弱化一行，左缘与标题文字对齐（U9）；选中行由 inspector 承接备注编辑，仍保留预览作上下文。*/}
      {notePreview && (
        <div className="pw-task-note-preview" style={{ marginLeft: lead }}>
          {notePreview}
        </div>
      )}
      {/* 行内 inspector（问题2）：选中时在标题行下展开紧凑属性栏（图 #2 样式），作为主编辑面；
          左缘与标题文字对齐（U9：marginLeft=标题左缘偏移，含子任务缩进层级）。
          右列 TaskDetail 仍随同一 selectedTaskId 显示完整面板，两处经同一 useUpdateTask + RQ cache 同步。 */}
      {isSelected && (
        <div className="pw-task-inspector" style={{ marginLeft: lead }}>
          <TaskInlineInspector task={task} today={today} onToast={onToast} />
        </div>
      )}
    </div>
  );
}

// 行内可编辑标题：受控草稿走共享守卫 hook（U1/KTD6）——切任务重置、未聚焦时跟随外部值
// （跨列/跨窗口热更）、聚焦中不被冲掉。失焦 / 回车保存（trim 归一）。聚焦即选中该行。
function TaskTitleInput({
  taskId,
  value,
  struck,
  onFocus,
  onSave,
}: {
  taskId: string;
  value: string;
  // 完成或丢弃 → 标题划线（R17）。
  struck: boolean;
  onFocus: () => void;
  onSave: (title: string) => void;
}) {
  const draft = useTaskDraftField({
    taskId,
    external: value,
    onCommit: onSave,
    normalize: (v) => v.trim(),
  });
  return (
    <input
      className={`pw-task-title-input${struck ? " is-struck" : ""}`}
      value={draft.value}
      placeholder="未命名的动作"
      autoFocus={!value}
      onFocus={() => {
        draft.onFocus();
        onFocus();
      }}
      onChange={(e) => draft.setValue(e.target.value)}
      onBlur={draft.onBlur}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          draft.commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
