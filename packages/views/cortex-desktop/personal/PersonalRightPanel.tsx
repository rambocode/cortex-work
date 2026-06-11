// 个人工作区右栏容器。视图（文件 / Skills）由顶栏面板按钮的下拉菜单选择
// （状态在 usePersonalStore.rightView）,面板内不再有 tab 行。
//   文件   → FilesView（项目全部文件 + 最近变更/diff）
//   Skills → PromptPanel（Prompt 库,可拖入聊天）

import { usePersonalStore } from "@cortex-work/core";
import { FilesView } from "./FilesView";
import { PromptPanel } from "./PromptPanel";

export function PersonalRightPanel({ onToast }: { onToast: (text: string) => void }) {
  const view = usePersonalStore((s) => s.rightView);
  return (
    <aside className="right pw-prompts">
      {view === "files" ? <FilesView onToast={onToast} /> : <PromptPanel onToast={onToast} bare />}
    </aside>
  );
}
