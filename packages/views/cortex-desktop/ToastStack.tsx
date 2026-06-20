import type { Toast } from "@cortex-work/core/types";
import { useCortexUIStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { NotificationCard } from "./NotificationCard";

// 全局通用提醒:右上角堆叠的 macOS 风格卡片(应用内浮层)。
// 卡片渲染委托共享的 NotificationCard;独立通知窗体复用同一组件(见 notification-window.tsx)。
export function ToastStack({ items }: { items: Toast[] }) {
  const dismissToast = useCortexUIStore((s) => s.dismissToast);
  const { t } = useTranslation("common");
  if (items.length === 0) return null;
  return (
    <div className="toast-stack">
      {items.map((toast) => (
        <NotificationCard
          key={toast.id}
          kind={toast.kind}
          text={toast.text}
          title={toast.title}
          description={toast.description}
          iconName={toast.iconName}
          dismissible={toast.dismissible}
          closeLabel={t("toast.closeLabel")}
          onClose={() => dismissToast(toast.id)}
        />
      ))}
    </div>
  );
}
