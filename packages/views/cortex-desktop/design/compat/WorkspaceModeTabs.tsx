// Kun chat/WorkspaceModeTabs 的替身：Kun 里是 Code/写作/设计 三工作区切换 tab。
// cortex 的设计工作台是整窗覆盖层,无三工作区语义,故这里只渲染一个「返回工作区」按钮
// (onCodeOpen 已被 DesignWorkspace 接成 closeDesign),让用户能退出设计模式。
import { ChevronLeft } from "lucide-react";

type WorkspaceModeTabsProps = {
  activeView?: string;
  onCodeOpen?: () => void;
  onWriteOpen?: () => void;
  onDesignOpen?: () => void;
} & Record<string, unknown>;

export function WorkspaceModeTabs({ onCodeOpen }: WorkspaceModeTabsProps) {
  return (
    <button
      type="button"
      onClick={() => onCodeOpen?.()}
      className="ds-no-drag flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] text-ds-muted transition hover:bg-[var(--ds-sidebar-row-hover)]"
    >
      <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      <span>返回工作区</span>
    </button>
  );
}
