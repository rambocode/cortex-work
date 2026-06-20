import type { Toast } from "@cortex-work/core/types";
import { useCortexUIStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon, type IconName } from "@cortex-work/ui/icons";

// 全局通用提醒:右上角堆叠的 macOS 风格卡片。
// 兼容:无 title 时 text 作为主行;iconName 由 store 按 kind 推导,未知名回退 Info。
export function ToastStack({ items }: { items: Toast[] }) {
  const dismissToast = useCortexUIStore((s) => s.dismissToast);
  const { t } = useTranslation("common");
  if (items.length === 0) return null;
  return (
    <div className="toast-stack">
      {items.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
          onClose={() => dismissToast(toast.id)}
          closeLabel={t("toast.closeLabel")}
        />
      ))}
    </div>
  );
}

function ToastCard({ toast, onClose, closeLabel }: { toast: Toast; onClose: () => void; closeLabel: string }) {
  // 图标名来自 store(string),此处用 IconName 收窄;未知名防御回退 Info。
  const IconComp = Icon[(toast.iconName ?? "Info") as IconName] ?? Icon.Info;
  return (
    <div className={`toast t-${toast.kind}`}>
      <span className="toast-icon" aria-hidden="true">
        <IconComp size={16} />
      </span>
      <div className="toast-body">
        {toast.title ? (
          <>
            <div className="toast-title">{toast.title}</div>
            {toast.description ? <div className="toast-desc">{toast.description}</div> : null}
          </>
        ) : (
          <div className="toast-text">{toast.text}</div>
        )}
      </div>
      {toast.dismissible !== false ? (
        <button type="button" className="toast-close" aria-label={closeLabel} onClick={onClose}>
          <Icon.X size={14} />
        </button>
      ) : null}
    </div>
  );
}
