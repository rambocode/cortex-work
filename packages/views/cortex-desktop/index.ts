export { CortexDesktopView } from "./CortexDesktopView";
export { ContactRow } from "./Sidebar";
export { AgentTracePanel } from "./personal/AgentTracePanel";
// 「项目管理」独立窗口 renderer 复用：三栏工作台 + 通用 toast 宿主（apps/desktop projects-window.tsx）。
export { ProjectsWorkbench } from "./personal/ProjectsWorkbench";
export { ToastStack } from "./ToastStack";
// 全局提醒卡片(应用内 + 独立通知窗体共用,见 notification-window.tsx)。
export { NotificationCard } from "./NotificationCard";
export type { NotificationCardProps } from "./NotificationCard";
