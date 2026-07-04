import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  contactKeys,
  contactListOptions,
  conversationOptions,
  issueListOptions,
  agentListOptions,
  dashboardUsageDailyOptions,
  useCoreContext,
  useCortexActions,
  useCortexUIStore,
  useDesktopBridge,
  useSpotlightIntentRouter,
  useWorkspaceId,
} from "@cortex-work/core";
import type { Contact } from "@cortex-work/core/types";
import { useTranslation } from "@cortex-work/core/i18n";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { ChatArea } from "./ChatArea";
import { RightPanel } from "./RightPanel";
import { ToastStack } from "./ToastStack";
import { SectionPage } from "./Sections";
import { PersonalWorkspace } from "./personal/PersonalWorkspace";
import { Pet } from "./pet/Pet";
import { PetBridge } from "./pet/PetBridge";
import { useTweaksPersistence } from "./useTweaksPersistence";

const SECTION_TITLE_KEY: Partial<Record<string, string>> = {
  tasks: "sectionTitle.tasks",
  agents: "sectionTitle.agents",
  usage: "sectionTitle.usage",
  settings: "sectionTitle.settings",
};

export interface CortexDesktopViewProps {
  // Reserve space at the titlebar's left for native macOS traffic lights
  // (desktop with a frameless window). Web / non-mac leaves it false.
  nativeTitlebar?: boolean;
  // 闪记浮层入口(桌面端由壳注入 window.desktopAPI.notesOverlay.show;web 端缺省 → 隐藏入口)。
  // 由壳就近注入,views 不直接触碰 window.desktopAPI(遵 core/views 硬边界)。
  onOpenFlashNote?: () => void;
  // 「项目管理」独立窗口入口(桌面端由壳注入 window.desktopAPI.projectsWindow.open;web 端缺省 → 隐藏)。
  onOpenProjectsWindow?: () => void;
}

export function CortexDesktopView({ nativeTitlebar = false, onOpenFlashNote, onOpenProjectsWindow }: CortexDesktopViewProps) {
  const { t } = useTranslation();
  const wsId = useWorkspaceId();
  const { apiClient } = useCoreContext();
  const desktopBridge = useDesktopBridge();
  const qc = useQueryClient();
  // 始终挂载:接收菜单栏 Spotlight 发起意图,切到个人工作区并暂存待 handoff 消费。
  useSpotlightIntentRouter();
  // 外观项（主题/字号/密度/色调/侧栏）持久化 + 应用到根节点。
  useTweaksPersistence();

  const {
    workspace,
    activeSection,
    activeContactId,
    activeFile,
    search,
    rightOpen,
    leftCollapsed,
    openTabs,
    tweaks,
    toasts,
    setSection,
    setActiveContact,
    setSearch,
    setRightOpen,
    toggleRight,
    openFileTab,
    closeFileTab,
    pushToast,
  } = useCortexUIStore();

  const { data: contacts = [] } = useQuery(contactListOptions(wsId));
  const { data: issues } = useQuery(issueListOptions(wsId, apiClient));
  const { data: agents } = useQuery(agentListOptions(wsId, apiClient));
  const { data: usageDaily } = useQuery(dashboardUsageDailyOptions(wsId, apiClient, 30));
  const { data: convo } = useQuery(conversationOptions(wsId, activeContactId));
  const { sendMessage, approveChange } = useCortexActions(wsId);

  const contact: Contact | undefined = contacts.find((c) => c.id === activeContactId);
  const personal = workspace === "personal";

  // Mark the opened conversation as read — an optimistic write to the contacts
  // cache (server state), not a copy into Zustand.
  useEffect(() => {
    qc.setQueryData<Contact[]>(contactKeys.list(wsId), (prev) =>
      prev?.map((c) => (c.id === activeContactId ? { ...c, unread: 0, mention: false } : c)),
    );
  }, [activeContactId, wsId, qc]);

  const handleSelectFile = (path: string) => {
    openFileTab(path);
    setRightOpen(true);
  };

  const handleApprove = (uid: string, decision: "approve" | "reject") => {
    const text = approveChange(activeContactId, contact, uid, decision);
    pushToast(text, { kind: decision === "approve" ? "success" : "info" });
  };

  return (
    <div className="fit-root">
      <div
        className="app-frame"
        data-density={tweaks.density}
        data-palette={tweaks.palette}
        data-sidebar={tweaks.sidebar}
        data-right={rightOpen ? "on" : "off"}
        data-left-collapsed={leftCollapsed ? "on" : undefined}
        data-native-titlebar={nativeTitlebar ? "mac" : undefined}
      >
        <div className="app">
          {personal ? (
            // 个人工作区:取消贯穿全宽的标题栏,三栏各自顶天、各有自己的顶部头。
            <div className="body">
              <PersonalWorkspace onToast={pushToast} onOpenFlashNote={onOpenFlashNote} onOpenProjectsWindow={onOpenProjectsWindow} />
            </div>
          ) : (
          <>
          <TitleBar
            contact={contact}
            rightOpen={rightOpen}
            onToggleRight={toggleRight}
            onToast={pushToast}
            activeSection={activeSection}
            onNavigate={setSection}
            sectionTitle={
              activeSection === "chat" || !SECTION_TITLE_KEY[activeSection]
                ? undefined
                : t(SECTION_TITLE_KEY[activeSection]!)
            }
          />
          <div className="body">
            <Sidebar
              contacts={contacts}
              activeId={activeContactId}
              onSelect={setActiveContact}
              mode={tweaks.sidebar}
              search={search}
              onSearch={setSearch}
              onToast={pushToast}
              activeSection={activeSection}
              onNavigate={setSection}
              sectionCounts={{
                tasks: issues?.total,
                agents: agents?.filter((a) => !a.archived_at).length,
                usage: usageDaily ? `${usageDaily.reduce((sum, row) => sum + row.task_count, 0)}` : undefined,
              }}
            />
            {activeSection === "chat" ? (
              <>
                <ChatArea
                  contact={contact}
                  convo={convo}
                  onSelectFile={handleSelectFile}
                  activeFile={activeFile}
                  onSend={(text) => sendMessage(activeContactId, contact, text)}
                  onApprove={handleApprove}
                  onToast={pushToast}
                />
                {rightOpen ? (
                  <RightPanel
                    contact={contact}
                    activeFile={activeFile}
                    openTabs={openTabs}
                    onSelectTab={openFileTab}
                    onCloseTab={closeFileTab}
                    onClose={() => setRightOpen(false)}
                    onToast={pushToast}
                  />
                ) : null}
              </>
            ) : (
              <SectionPage section={activeSection} />
            )}
          </div>
          </>
          )}
          <ToastStack items={toasts} />
          {/* 桌面端:宠物本体挪去独立 pet-overlay 窗口(脱离主窗体,可在整个屏幕任意位置显示),
              这里只挂 PetBridge 转发 usePetStore 变化。Web 端 desktopBridge 为 null,
              仍渲染内嵌 <Pet/>,行为不变。 */}
          {desktopBridge ? <PetBridge /> : <Pet />}
        </div>
      </div>
    </div>
  );
}
