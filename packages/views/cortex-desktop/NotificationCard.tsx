import { Icon, type IconName } from "@cortex-work/ui/icons";

export interface NotificationCardProps {
  kind: "info" | "success" | "error";
  // 无 title 时作为卡片主行(向后兼容旧的单行 toast)。
  text?: string;
  title?: string;
  description?: string;
  // 图标名(string),用 IconName 收窄;未知名防御回退 Info。
  iconName?: string;
  // 默认显示关闭按钮(传 false 隐藏)。
  dismissible?: boolean;
  closeLabel: string;
  onClose: () => void;
}

// 全局提醒卡片:应用内 ToastStack 与独立通知窗体共用的纯展示组件(无 store/IPC 依赖)。
// 样式由各自上下文的 CSS 提供(.toast* 类):应用内走 cortex-desktop.css,独立窗体走
// notification-window.css(两处 .toast* 须保持同源)。
export function NotificationCard({
  kind,
  text,
  title,
  description,
  iconName,
  dismissible,
  closeLabel,
  onClose,
}: NotificationCardProps) {
  const IconComp = Icon[(iconName ?? "Info") as IconName] ?? Icon.Info;
  return (
    <div className={`toast t-${kind}`}>
      <span className="toast-icon" aria-hidden="true">
        <IconComp size={16} />
      </span>
      <div className="toast-body">
        {title ? (
          <>
            <div className="toast-title">{title}</div>
            {description ? <div className="toast-desc">{description}</div> : null}
          </>
        ) : (
          <div className="toast-text">{text}</div>
        )}
      </div>
      {dismissible !== false ? (
        <button type="button" className="toast-close" aria-label={closeLabel} onClick={onClose}>
          <Icon.X size={14} />
        </button>
      ) : null}
    </div>
  );
}
