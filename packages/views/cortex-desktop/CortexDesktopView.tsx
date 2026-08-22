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
import { PersonalWorkspace } from "./personal/layout/PersonalWorkspace";
import { Pet } from "./pet/Pet";
import { LoginGate, type AuthedResult } from "./auth/LoginGate";
import { TeamChatArea } from "./team/TeamChatArea";
import { TeamRealtimeMount } from "./team/TeamRealtimeMount";
import { PetBridge } from "./pet/PetBridge";
import { VoiceAssistantController } from "./personal/voice-assistant/VoiceAssistantController";
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
  // 团队工作区应用内登录（W1）：桌面壳注入。缺省（web/旧壳未接线）→ 不拦截、不渲染登录卡，
  // 走 env 注入的向后兼容路径。enabled=是否已登录并启用真实后端。
  auth?: {
    enabled: boolean;
    userName?: string;
    userEmail?: string;
    defaultBaseUrl: string;
    onAuthenticated: (cfg: AuthedResult) => void;
    onLogout: () => void;
    // 真实 workspace 切换(壳改 wsId + 持久化);缺省 → OrgSwitcher 内兜底 toast。
    onWorkspaceSwitch?: (ws: { id: string; name: string; slug?: string }) => void;
  };
}

export function CortexDesktopView({ nativeTitlebar = false, onOpenFlashNote, onOpenProjectsWindow, auth }: CortexDesktopViewProps) {
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

  // 团队通讯录/会话真实化(U7/U8):必须把 apiClient 传给 query options,
  // 否则 queryFn 永远走 mock 回落路径(apiClient 为 null 的 Web/离线场景仍回落 mock)。
  const { data: contacts = [] } = useQuery(contactListOptions(wsId, apiClient));
  const { data: issues } = useQuery(issueListOptions(wsId, apiClient));
  const { data: agents } = useQuery(agentListOptions(wsId, apiClient));
  const { data: usageDaily } = useQuery(dashboardUsageDailyOptions(wsId, apiClient, 30));
  const contact: Contact | undefined = contacts.find((c) => c.id === activeContactId);
  // conversationOptions 需要当前 contact 判定分身会话(kind==="avatar")→ 走真实 sessions/messages。
  const { data: convo } = useQuery(conversationOptions(wsId, activeContactId, apiClient, contact));
  const { sendMessage, approveChange } = useCortexActions(wsId);
  const personal = workspace === "personal";
  // 团队工作区未登录锁定态（W1）:仅替换主内容区为登录卡,侧栏与「团队/个人」切换 tab
  // 保持可用——个人工作区必须不受任何登录门控影响(用户可随时切回)。锁定时通讯录传空,
  // 避免未登录还展示 mock 假联系人造成误导。
  const teamLocked = !personal && !!auth && !auth.enabled;

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
          {/* 团队实时层:WS 直连后端做流式折帧与 invalidation;未登录(teamLocked)不建连。 */}
          {teamLocked ? null : <TeamRealtimeMount />}
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
              contacts={teamLocked ? [] : contacts}
              activeId={activeContactId}
              onSelect={setActiveContact}
              mode={tweaks.sidebar}
              search={search}
              onSearch={setSearch}
              onToast={pushToast}
              activeSection={activeSection}
              onNavigate={setSection}
              onLogout={auth?.onLogout}
              onWorkspaceSwitch={auth?.onWorkspaceSwitch}
              sectionCounts={{
                tasks: issues?.total,
                agents: agents?.filter((a) => !a.archived_at).length,
                usage: usageDaily ? `${usageDaily.reduce((sum, row) => sum + row.task_count, 0)}` : undefined,
              }}
            />
            {teamLocked ? (
              // 未登录:主内容区呈现登录卡(侧栏仍在,可切回个人工作区)。
              <LoginGate defaultBaseUrl={auth!.defaultBaseUrl} onAuthenticated={auth!.onAuthenticated} />
            ) : activeSection === "chat" ? (
              <>
                {/* 团队 Contact（kind 有值:成员/分身）→ TeamChatArea（降级/排队/工作区选择）;
                    kind 缺省（mock/legacy）→ 原 ChatArea,零回归。 */}
                {contact?.kind ? (
                  <TeamChatArea
                    contact={contact}
                    convo={convo}
                    onSelectFile={handleSelectFile}
                    activeFile={activeFile}
                    onSend={(text) => sendMessage(activeContactId, contact, text)}
                    onApprove={handleApprove}
                    onToast={pushToast}
                  />
                ) : (
                <ChatArea
                  contact={contact}
                  convo={convo}
                  onSelectFile={handleSelectFile}
                  activeFile={activeFile}
                  onSend={(text) => sendMessage(activeContactId, contact, text)}
                  onApprove={handleApprove}
                  onToast={pushToast}
                />
                )}
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
          {/* PetBridge 两端都挂:它是宠物状态机的宿主(活动信号只在这个窗口里发生),
              桌面端额外负责把状态转发给独立的 pet-overlay 窗口。
              宠物本体只在 Web 端内嵌渲染;桌面端已挪去 overlay 窗口(可在整屏任意位置显示)。 */}
          <PetBridge />
          {/* 语音助手 headless 控制器:管线(录音/STT/send/TTS)在主窗口,语音球在
              pet-overlay 窗口纯展示。桥无语音助手能力(Web)时内部整体降级为 no-op。 */}
          <VoiceAssistantController />
          {desktopBridge ? null : <Pet />}
        </div>
      </div>
    </div>
  );
}
