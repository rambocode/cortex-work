import type { Toast } from "@cortex-work/core/types";

export function ToastStack({ items }: { items: Toast[] }) {
  if (items.length === 0) return null;
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className={`toast t-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
