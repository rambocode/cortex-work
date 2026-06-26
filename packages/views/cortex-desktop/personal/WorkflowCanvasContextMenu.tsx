// WorkflowCanvasContextMenu.tsx — 画布右键菜单（fixed 定位 + backdrop 关闭 + 防溢出）。
// 复用 FileContextMenu 的范式：useLayoutEffect 测量后回收边界、点 backdrop / Escape 关闭。
// 两种用法：空白处右键(添加便签) 与 便签节点右键(改色 + 删除)，均由 items / colorPicker 配置。

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { NodeIconComponent } from "./workflow-flow";
import { STICKY_NOTE_COLORS } from "./workflow-sticky";

export type CanvasMenuItem = {
  label: string;
  icon?: NodeIconComponent;
  /** 危险动作（删除）：红色样式。 */
  danger?: boolean;
  onSelect: () => void;
};

export function WorkflowCanvasContextMenu({
  x,
  y,
  items,
  colorPicker,
  onClose,
}: {
  /** 触发点屏幕坐标。 */
  x: number;
  y: number;
  items: CanvasMenuItem[];
  /** 可选：便签改色行（当前色 + 选色回调）。 */
  colorPicker?: { current: string; onPick: (color: string) => void };
  onClose: () => void;
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // 防溢出：测量菜单尺寸，超出视口右/下边界则回收（留 8px 余量）。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  // Escape 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* backdrop：点击或再次右键关闭 */}
      <div
        className="fixed inset-0 z-[70]"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        className="fixed z-[71] min-w-[160px] rounded-lg border border-ds-border bg-ds-card p-1 shadow-lg"
        style={{ left: pos.left, top: pos.top }}
      >
        {colorPicker ? (
          <div className="flex items-center gap-1 px-2 py-1.5">
            {STICKY_NOTE_COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                aria-label={`颜色 ${c.label}`}
                title={c.label}
                onClick={() => {
                  colorPicker.onPick(c.value);
                  onClose();
                }}
                className={`h-5 w-5 rounded-full border transition hover:scale-110 ${
                  c.value === colorPicker.current
                    ? "border-ds-ink"
                    : "border-black/10"
                }`}
                style={{ background: c.value }}
              />
            ))}
          </div>
        ) : null}
        {colorPicker && items.length ? (
          <div className="my-1 h-px bg-ds-border" />
        ) : null}
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              it.onSelect();
              onClose();
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition ${
              it.danger
                ? "text-red-600 hover:bg-red-500/10"
                : "text-ds-ink hover:bg-ds-hover"
            }`}
          >
            {it.icon ? (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <it.icon size={14} sw={1.8} />
              </span>
            ) : null}
            {it.label}
          </button>
        ))}
      </div>
    </>
  );
}
