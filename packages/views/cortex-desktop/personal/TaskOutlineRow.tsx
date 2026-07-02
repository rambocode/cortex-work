// 中列大纲行（U6 从 TaskListColumn 拆出，防单文件逼近 1200 行上限）：
// OmniFocus 式任务行 —— 圆形完成勾选 + 行内可编辑标题 + 元数据 chips（R16）+ 备注预览/图标 + 旗标（R17）
// + 折叠三角（子任务）+ 行内 inspector（选中时）。以及 R15 上下文补行 ContextRow。
// 服务端态经上层 hooks 写回（useUpdateTask / RQ cache），本组件只渲染与转发回调，无本地服务端副本。
import { Icon } from "@cortex-work/ui/icons";
import { TaskInlineInspector } from "./TaskInlineInspector";
import { useTaskDraftField } from "./useTaskDraftField";
import { fmtDur } from "./taskFormat";
import type { DisplayFieldPrefs, EditFieldPrefs } from "./workbenchFieldPrefs";
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
  onTitleBlur,
  displayFields,
  editFields,
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
  // U12 空白新建撤销：标题失焦时上报（去空格后的标题, 焦点是否转入本行其它控件），供中列判定撤销刚新建的空白任务。
  onTitleBlur?: (title: string, toInsideRow: boolean) => void;
  // 字段显隐偏好（工具栏「设置显示 / 编辑字段」）：display 管本行精简态 chips/备注/状态提示，
  // edit 透传给行内 inspector。缺省（未注入）一律视为全开，保证旧调用零回归。
  displayFields?: DisplayFieldPrefs;
  editFields?: EditFieldPrefs;
}) {
  const overdue = !!task.dueDate && task.dueDate < today;
  const delegated = task.status === "waiting" && !!task.delegation;
  const done = task.status === "done";
  const dropped = task.status === "dropped";
  // 字段显隐判定：未注入偏好（displayFields 为 undefined）时一律视为开启（全开缺省）。
  const showField = (k: keyof DisplayFieldPrefs) => displayFields?.[k] !== false;
  const notePreview = showField("note") ? noteFirstLine(task.notes) : "";
  // 标题左缘偏移：inspector / 备注预览据此与标题文字左对齐（U9）。
  const lead = titleLeadOffset(depth);

  // 只读 chip（U10 未选中行）：纯展示已设置字段的实色 chip，无交互；点击由行级 onClick 选中该行。
  const roChip = (key: string, icon: React.ReactNode, label: string, danger?: boolean) => (
    <span key={key} className={`pw-task-chip is-set${danger ? " is-danger" : ""}`} title={label}>
      {icon}
      <span>{label}</span>
    </span>
  );

  // U10：未选中行点击行任意处 = 选中该行；各交互控件（折叠/勾选/动作按钮）用此包裹 onClick，
  // stopPropagation 保留自身行为、不冒泡触发选中（选中行无行级 onClick，包裹无副作用）。
  const stop = (handler: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    handler();
  };

  return (
    <div
      className={`pw-task-row${isSelected ? " is-selected" : ""}${done ? " is-done" : ""}${dropped ? " is-dropped" : ""}`}
      data-task-id={task.id}
    >
      {/* U10 未选中 = 只读精简态：整行可点击选中（含标题/空白/只读 chip）；选中行不挂行级 onClick，
          交由内部 input / inspector 编辑。role/tabIndex/键盘让整行在未选中态可聚焦并回车/空格选中。 */}
      <div
        className="pw-task-row-main"
        {...(isSelected
          ? {}
          : {
              role: "button",
              tabIndex: 0,
              onClick: onOpen,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen();
                }
              },
            })}
      >
        {/* 子任务缩进：按 depth 留白（U3；U6 视觉细调）。*/}
        {depth > 0 && <span className="pw-task-indent" style={{ width: depth * INDENT_STEP }} aria-hidden />}
        {/* 折叠箭头：有子任务才显，否则占位对齐。*/}
        {hasChildren ? (
          <button
            className={`pw-task-twisty${collapsed ? "" : " is-open"}`}
            title={collapsed ? "展开子任务" : "折叠子任务"}
            aria-expanded={!collapsed}
            onClick={stop(onToggleCollapse)}
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
          onClick={(e) => e.stopPropagation()}
          title={done ? "取消完成" : "完成"}
        />
        {/* U10 标题：选中行 = 可编辑 input（草稿 hook，聚焦即选中）；未选中行 = 纯文本，
            点击经行级 onClick 选中该行而不进入编辑，视觉与 input 保持一致避免选中瞬间跳动。 */}
        {isSelected ? (
          <TaskTitleInput taskId={task.id} value={task.title} struck={done || dropped} onFocus={onOpen} onSave={onRename} onTitleBlur={onTitleBlur} />
        ) : (
          <span
            className={`pw-task-title-input pw-task-title-static${done || dropped ? " is-struck" : ""}${task.title ? "" : " is-empty"}`}
          >
            {task.title || "未命名的动作"}
          </span>
        )}
        {/* U10 元数据 chips：仅未选中行渲染，且只显示「已设置」字段的实色 chip（无灰占位、不可点击编辑，
            点击经行级 onClick 选中该行）。选中行的字段编辑交由下方行内 inspector（含占位 + 就地编辑）。 */}
        {!isSelected && (
          <div className="pw-task-chips">
            {/* 各 chip 先过 showField 字段显隐偏好（工具栏「设置显示字段」），再按「已设置」实值判定。 */}
            {showField("project") && !groupedByProject && projectName && roChip("project", <Icon.Task size={11} />, projectName)}
            {showField("tags") && task.tags.length > 0 && roChip("tags", <Icon.Tags size={11} />, task.tags.join("、"))}
            {showField("duration") && task.estimatedDuration != null && roChip("duration", <Icon.Clock size={11} />, fmtDur(task.estimatedDuration))}
            {showField("defer") && task.deferDate && roChip("defer", <Icon.Fwd size={11} />, `推迟 ${task.deferDate}`)}
            {showField("due") && task.dueDate && roChip("due", <Icon.Clock size={11} />, `截止 ${task.dueDate}`, overdue)}
            {showField("repeat") && task.repeat != null && roChip("repeat", <Icon.Retry size={11} />, "重复")}
            {showField("reminder") && task.reminder?.at != null && roChip("reminder", <Icon.Bell size={11} />, "已设提醒")}
            {showField("status") && delegated && <span className="pw-task-chip is-set is-wait">委派中</span>}
            {showField("status") && task.status === "in-progress" && <span className="pw-task-chip is-set is-run">进行中</span>}
          </div>
        )}
        {/* 完成 rollup 建议（R5/KTD4）：全部子任务已完成时浮现，点击确认才置父 done（不自动）。*/}
        {suggestComplete && !done && (
          <button className="pw-task-badge is-suggest" title="全部子任务已完成，点击完成此任务" onClick={stop(onCompleteSuggested)}>
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
        <button className="pw-icon-btn" title="添加子任务" onClick={stop(onAddSubtask)}>
          <Icon.Plus size={13} />
        </button>
        {/* 委派仅对 active 任务开放（waiting 已在跑，避免二次委派）。*/}
        {task.status === "active" && (
          <button className="pw-icon-btn" title="交给 agent 执行" onClick={stop(onDelegate)}>
            <Icon.Bot size={13} />
          </button>
        )}
        {/* 旗标图标（R17）：常显，已标记高亮。*/}
        <button
          className={`pw-icon-btn pw-task-flag${task.flagged ? " is-on" : ""}`}
          title={task.flagged ? "取消标记" : "标记"}
          onClick={stop(onToggleFlag)}
        >
          ⚑
        </button>
        <button className="pw-icon-btn" title="删除" onClick={stop(onDelete)}>
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
          <TaskInlineInspector task={task} today={today} onToast={onToast} editFields={editFields} />
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
  onTitleBlur,
}: {
  taskId: string;
  value: string;
  // 完成或丢弃 → 标题划线（R17）。
  struck: boolean;
  onFocus: () => void;
  onSave: (title: string) => void;
  onTitleBlur?: (title: string, toInsideRow: boolean) => void;
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
      onBlur={(e) => {
        draft.onBlur();
        // U12 空白新建撤销：失焦后把「去空格标题」与「焦点是否转入本行其它控件」上报给中列判定。
        // relatedTarget 落在本行内（如行内 inspector 的按钮）→ 用户仍在编辑本任务，中列据此不撤销；
        // 焦点真正离开本行（切别的行/空白），或 ESC 编程式 blur（relatedTarget 为空）才进入撤销判定。
        const row = e.currentTarget.closest(".pw-task-row");
        const toInsideRow = e.relatedTarget instanceof Node && !!row?.contains(e.relatedTarget);
        onTitleBlur?.(e.currentTarget.value.trim(), toInsideRow);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          draft.commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
