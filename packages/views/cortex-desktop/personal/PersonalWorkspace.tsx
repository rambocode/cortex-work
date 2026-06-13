// 个人工作区三栏容器：项目/Session 列表（左）+ CLI 会话（中）+ Prompt 库（右）。
// 仅桌面端可用（依赖 DesktopBridge）；web 端显示降级提示但保留 tab 可切回团队。

import { useEffect } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useAutomationEvents,
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
import { AutomationView } from "./AutomationView";

export function PersonalWorkspace({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const rightOpen = useCortexUIStore((s) => s.rightOpen);
  const homeOpen = usePersonalStore((s) => s.homeOpen);
  const automationOpen = usePersonalStore((s) => s.automationOpen);
  const timelineProject = usePersonalStore((s) =>
    s.timelineProjectId ? s.projects.find((p) => p.id === s.timelineProjectId) : undefined,
  );
  const setAgentsAvailable = usePersonalStore((s) => s.setAgentsAvailable);
  usePersonalPersistence();
  usePersonalCliEvents();
  // 订阅自动化的 changed / run-event（驱动列表刷新 + 完成 toast）。bridge 不支持时内部空转。
  useAutomationEvents();

  // 启动时探测本机已安装的 agent CLI（claude/codex…）,供新建会话默认值与
  // agent 下拉禁用态使用;探测失败静默,UI 退化为不标注未安装。
  useEffect(() => {
    bridge?.detectAgents?.().then(setAgentsAvailable).catch(() => {});
  }, [bridge, setAgentsAvailable]);

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
          {automationOpen ? (
            <AutomationView onToast={onToast} />
          ) : homeOpen ? (
            <HomeView onToast={onToast} />
          ) : timelineProject ? (
            <TimelineView project={timelineProject} onToast={onToast} />
          ) : (
            <PersonalChatArea onToast={onToast} />
          )}
          {!automationOpen && rightOpen ? <PersonalRightPanel onToast={onToast} /> : null}
        </div>
        <TerminalPanel onToast={onToast} />
      </div>
    </>
  );
}
