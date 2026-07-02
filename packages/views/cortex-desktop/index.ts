export { CortexDesktopView } from "./CortexDesktopView";
export { ContactRow } from "./Sidebar";
export { AgentTracePanel } from "./personal/AgentTracePanel";
// 「项目管理」独立窗口 renderer 复用：三栏工作台 + 通用 toast 宿主（apps/desktop projects-window.tsx）。
export { ProjectsWorkbench } from "./personal/ProjectsWorkbench";
export { ToastStack } from "./ToastStack";
// 关窗 flush 握手（R21/KTD6）：projects-window renderer 收到 main 的 flush-request 时统一提交
// 所有挂载中 pending 草稿（title/notes 仅 blur 落库，销毁 renderer 不触发 blur 会丢数据）。
export { flushPendingDrafts } from "./personal/useTaskDraftField";
// 全局提醒卡片(应用内 + 独立通知窗体共用,见 notification-window.tsx)。
export { NotificationCard } from "./NotificationCard";
export type { NotificationCardProps } from "./NotificationCard";
