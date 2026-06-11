// 个人工作区三栏容器：项目/Session 列表（左）+ CLI 会话（中）+ Prompt 库（右）。
// 仅桌面端可用（依赖 DesktopBridge）；web 端显示降级提示但保留 tab 可切回团队。

import { Icon } from "@cortex-work/ui/icons";
import {
  useCortexUIStore,
  useDesktopBridge,
  usePersonalCliEvents,
  usePersonalPersistence,
  usePersonalStore,
} from "@cortex-work/core";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { PersonalSidebar } from "./PersonalSidebar";
import { PersonalChatArea } from "./PersonalChatArea";
import { PersonalRightPanel } from "./PersonalRightPanel";
import { TerminalPanel } from "./TerminalPanel";
import { TimelineView } from "./TimelineView";
import { HomeView } from "./HomeView";

export function PersonalWorkspace({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const rightOpen = useCortexUIStore((s) => s.rightOpen);
  const homeOpen = usePersonalStore((s) => s.homeOpen);
  const timelineProject = usePersonalStore((s) =>
    s.timelineProjectId ? s.projects.find((p) => p.id === s.timelineProjectId) : undefined,
  );
  usePersonalPersistence();
  usePersonalCliEvents();

  if (!bridge) {
    return (
      <>
        <aside className="sidebar">
          <WorkspaceTabs />
        </aside>
        <main className="chat">
          <div className="pw-center">
            <Icon.Terminal size={26} />
            <div className="pw-center-title">个人工作区仅桌面端可用</div>
            <div className="pw-center-hint">需要访问本地文件夹与 CLI,请使用 Cortex Desktop 客户端</div>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <PersonalSidebar onToast={onToast} />
      <div className="pw-main">
        <div className="pw-upper">
          {homeOpen ? (
            <HomeView onToast={onToast} />
          ) : timelineProject ? (
            <TimelineView project={timelineProject} onToast={onToast} />
          ) : (
            <PersonalChatArea onToast={onToast} />
          )}
          {rightOpen ? <PersonalRightPanel onToast={onToast} /> : null}
        </div>
        <TerminalPanel onToast={onToast} />
      </div>
    </>
  );
}
