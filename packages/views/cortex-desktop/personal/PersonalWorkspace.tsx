// 个人工作区三栏容器：项目/Session 列表（左）+ CLI 会话（中）+ Prompt 库（右）。
// 仅桌面端可用（依赖 DesktopBridge）；web 端显示降级提示但保留 tab 可切回团队。

import { useEffect, useMemo } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useAutomationEvents,
  useCortexUIStore,
  useDesktopBridge,
  useNotesChangeSubscription,
  usePersonalCliEvents,
  usePersonalPersistence,
  usePushSettingsSync,
  usePersonalPiEvents,
  usePersonalPiUi,
  usePersonalStore,
  useSpotlightHandoff,
} from "@cortex-work/core";
import { useResponsiveLeftCollapsed } from "../useResponsiveLeftCollapsed";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { PersonalSidebar } from "./PersonalSidebar";
import { PersonalChatArea } from "./PersonalChatArea";
import { PersonalProcessPanel } from "./PersonalProcessPanel";
import { PersonalRightPanel } from "./PersonalRightPanel";
import { PersonalCenterHeader } from "./PersonalTopBar";
import { TerminalPanel } from "./TerminalPanel";
import { TimelineView } from "./TimelineView";
import { NewSessionLanding } from "./NewSessionLanding";
import { AutomationView } from "./AutomationView";
import { WorkflowView } from "./WorkflowView";
import { DesignWorkspace } from "../design/DesignWorkspace";
import { WritingWorkspace } from "../writing/WritingWorkspace";
import { normalizeResearchEngineSettings } from "@cortex-work/core/research/settings";
import { ResearchWorkspace } from "../research/ResearchWorkspace";
import { resolveResearchModelDisplay } from "../research/modelDisplay";
import { FlashNoteEditor } from "./FlashNoteEditor";
import { PiToolConfirmDialog } from "./PiToolConfirmDialog";
import { PersonalSettingsView } from "./SettingsMenu";
import { SessionSearchDialog } from "./SessionSearchDialog";
import { useDelegateIntentListener } from "@cortex-work/core/personal/taskDelegate";

// 进入落地页(homeOpen 转真,含首屏挂载)即收起右栏:无项目时默认不显示,选项目
// 不自动弹出。依赖只含 homeOpen,故 rightOpen 在落地页内被显式置真(点 Task / 顶栏
// 开关)不会触发 effect 复跑,面板保持打开;离开落地页(homeOpen 转假)不强制开关,
// 交还原有门控。setRightOpen 为 zustand 稳定引用,不引起多余重跑。
export function useCloseRightPanelOnHome(homeOpen: boolean) {
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  useEffect(() => {
    if (homeOpen) setRightOpen(false);
  }, [homeOpen, setRightOpen]);
}

export function usePersonalRolesLibrary(): void {
  const bridge = useDesktopBridge();
  const setRoles = usePersonalStore((s) => s.setRoles);

  useEffect(() => {
    let disposed = false;
    bridge?.listRoles?.()
      .then((roles) => {
        if (!disposed) setRoles(roles);
      })
      .catch(() => {});
    const off = bridge?.onRolesChanged?.((roles) => {
      if (!disposed) setRoles(roles);
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, [bridge, setRoles]);
}

export function PersonalWorkspace({
  onToast,
  onOpenFlashNote,
  onOpenProjectsWindow,
}: {
  onToast: (text: string) => void;
  // 闪记浮层入口(壳注入,透传给 composer 图标;web/旧壳缺省 → 隐藏)。
  onOpenFlashNote?: () => void;
  // 「项目管理」独立窗口入口（壳注入 window.desktopAPI.projectsWindow.open；web/旧壳缺省 → 隐藏入口）。
  // 由壳就近注入，views 不直接触碰 window.desktopAPI（遵 core/views 硬边界，KTD2）。
  onOpenProjectsWindow?: () => void;
}) {
  const bridge = useDesktopBridge();
  const rightOpen = useCortexUIStore((s) => s.rightOpen);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const leftCollapsed = useCortexUIStore((s) => s.leftCollapsed);
  const homeOpen = usePersonalStore((s) => s.homeOpen);
  // 研究引擎的模型偏好与全局供应商配置：两者一起决定「本次研究会用哪个模型、正文会不会
  // 出本机」，由下面的 useMemo 解析成一行告知文案交给新建表单。
  // 用选择器订阅而不是 getState()：后者在渲染期读快照是 React 反模式，且设置改动后不会
  // 触发重渲染。归一化保证旧存档缺字段时也有稳妥默认值。
  const researchEngineSettings = usePersonalStore((s) => s.generalSettings.researchEngine);
  const providerSettings = usePersonalStore((s) => s.providerSettings);
  const automationOpen = usePersonalStore((s) => s.automationOpen);
  // loop 工作流主区视图（优先级最高；bridge.workflowList 为 null 时不可能为 true）。
  const workflowOpen = usePersonalStore((s) => s.workflowOpen);
  // 设计工作台主区视图(desktop-only;侧栏入口按 bridge 存在性 gate)。
  const designOpen = usePersonalStore((s) => s.designOpen);
  // 写作工作区整窗覆盖层(desktop-only;瞬态,与设计/设置同级 z-40)。
  const writingOpen = usePersonalStore((s) => s.writingOpen);
  // 深度研究整窗覆盖层(CRE,desktop-only;入口门控在侧栏,此处只负责渲染)。
  const researchOpen = usePersonalStore((s) => s.researchOpen);
  const closeResearch = usePersonalStore((s) => s.closeResearch);
  // 解析「本次研究会用哪个模型 + 数据会去哪」。走 core 的 selectResearchModel（经
  // resolveResearchModelDisplay），与设置页、以及主进程编排层用的是同一套三级回落规则，
  // 所以界面显示的就是实际会用的那个，不会出现「设置里写着 A、实际跑 B」。
  const researchModel = useMemo(
    () => {
      const research = normalizeResearchEngineSettings(researchEngineSettings);
      return resolveResearchModelDisplay(providerSettings, {
        ...(research.modelProviderId ? { providerId: research.modelProviderId } : {}),
        ...(research.modelId ? { modelId: research.modelId } : {}),
      });
    },
    [researchEngineSettings, providerSettings],
  );
  // 设置整页：全屏覆盖层叠加在工作区之上（不卸载 pw-main → 终端 PTY 存活）。
  const settingsOpen = usePersonalStore((s) => s.settingsOpen);
  const noteEditorId = usePersonalStore((s) => s.noteEditorId);
  const closeNoteEditor = usePersonalStore((s) => s.closeNoteEditor);
  const timelineProject = usePersonalStore((s) =>
    s.timelineProjectId ? s.projects.find((p) => p.id === s.timelineProjectId) : undefined,
  );
  const setAgentsAvailable = usePersonalStore((s) => s.setAgentsAvailable);
  const setDerivedAgents = usePersonalStore((s) => s.setDerivedAgents);
  const requestBrowserUrl = usePersonalStore((s) => s.requestBrowserUrl);
  usePersonalPersistence();
  // pushSettings 跨窗口镜像：项目管理窗口经窄通道改推送开关时，主窗口 store 必须同步跟进——
  // 否则主窗口后续任一全量落盘会用陈旧值把该开关静默改回去（clobber）。
  usePushSettingsSync();
  usePersonalCliEvents();
  // pi RPC 会话事件流（与 CLI 事件并列挂载一次）；bridge 无 onPiEvent 时内部空转。
  usePersonalPiEvents();
  // pi extension UI 请求（工具确认弹窗）订阅;bridge 无 onPiUiRequest 时空转。
  usePersonalPiUi();
  // 与 CLI 事件同处挂载:hydrate 后消费 Spotlight 意图,新建会话并发首条消息。
  useSpotlightHandoff();
  // 订阅自动化的 changed / run-event（驱动列表刷新 + 完成 toast）。bridge 不支持时内部空转。
  useAutomationEvents();
  // 角色库用于 @mention 解析/自动补全，必须在聊天入口加载，而不是等设置页挂载。
  usePersonalRolesLibrary();
  // 订阅 notes:changed（闪记浮层/后台落盘 → invalidate 刷新收件箱与时间线）。漏挂会导致
  // 浮层新增的闪记在主窗口「有时候没显示」，须重获焦点才刷新。bridge 缺方法时内部空转。
  useNotesChangeSubscription();
  // 监听「项目管理」独立窗口经 main 转发来的委派意图：主窗口本地 createSession+send 并导航到会话
  // （sessions 是 renderer 本地 Zustand、不跨窗口，故委派必须在主窗口这一侧执行，KTD10）。
  useDelegateIntentListener(onToast);
  // 进入落地页默认收起右栏（无项目不显示、选项目不自动弹出）。
  useCloseRightPanelOnHome(homeOpen);
  // 窗口宽度 < 760pt 时自动收缩左栏；恢复宽度后自动展开。
  useResponsiveLeftCollapsed();

  // 启动时探测本机已安装的 agent CLI（claude/codex…）,供新建会话默认值与
  // agent 下拉禁用态使用;探测失败静默,UI 退化为不标注未安装。
  useEffect(() => {
    bridge?.detectAgents?.().then(setAgentsAvailable).catch(() => {});
  }, [bridge, setAgentsAvailable]);

  // 启动时加载用户 JSON 派生的 agent(agents.local.json),供 agent 选择器列出新 agent(U7)。
  // 桥不可用/读失败静默退化为无派生(选择器仅内置三者)。
  useEffect(() => {
    bridge?.listAgentProfiles?.().then(setDerivedAgents).catch(() => {});
  }, [bridge, setDerivedAgents]);

  // 订阅主进程「打开浏览器面板」请求:agent 的 browser_navigate 在面板未开时触发。
  // 须 setRightOpen(true) 展开右栏 + requestBrowserUrl 切 browser 视图并导航——二者缺一面板不可见
  // (与现有「点 URL 开浏览器」一致,见 chatMarkdown/PersonalChatArea)。bridge 无该方法时空转。
  useEffect(
    () =>
      bridge?.onBrowserOpenPanel?.((url) => {
        setRightOpen(true);
        requestBrowserUrl(url);
      }),
    [bridge, requestBrowserUrl, setRightOpen],
  );

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
      {/* 折叠态隐藏左栏菜单；折叠/搜索控制改由中栏顶栏渲染（见 PersonalCenterHeader）。 */}
      {leftCollapsed ? null : (
        <PersonalSidebar
          onToast={onToast}
          onOpenFlashNote={onOpenFlashNote}
          onOpenProjectsWindow={onOpenProjectsWindow}
        />
      )}
      <div className="pw-main">
        <div className="pw-upper">
          <div className="pw-center-col">
            <PersonalCenterHeader />
            {workflowOpen ? (
              <WorkflowView onToast={onToast} />
            ) : automationOpen ? (
              <AutomationView onToast={onToast} />
            ) : noteEditorId ? (
              <FlashNoteEditor noteId={noteEditorId} onClose={closeNoteEditor} onToast={onToast} />
            ) : homeOpen ? (
              <NewSessionLanding onToast={onToast} />
            ) : timelineProject ? (
              <TimelineView project={timelineProject} onToast={onToast} />
            ) : (
              <PersonalChatArea onToast={onToast} />
            )}
            {/* 右侧执行过程区（浮起 overlay，position:absolute 脱离 .pw-center-col 的 flex:1 规则，
                锚到 .pw-center-col 的 relative）。独立门控：与上面的视图切换、rightOpen/rightView 解耦，
                由组件自身依据「中栏显示会话区 + 当前会话有过程」判定是否渲染。 */}
            <PersonalProcessPanel />
          </div>
          {/* 工作流/自动化/设计视图时隐藏右栏（画布编辑器自带右栏,不需要辅助面板）。*/}
          {!workflowOpen && !automationOpen && !designOpen && rightOpen ? <PersonalRightPanel onToast={onToast} /> : null}
        </div>
        <TerminalPanel onToast={onToast} />
      </div>
      {/* 「项目管理」三栏工作台已迁为独立桌面窗口（projects.html，见 projects-window.ts），
          不再在主窗口内以覆盖层渲染（U3）。 */}
      {/* 设计工作台:整窗覆盖层(fixed inset-0),接管个人工作区侧栏,自成三栏。与 settings 同级。
          settingsOpen 时不渲染(否则 z-40 覆盖层盖在设置页上拦截点击,设置的「返回」点不到);
          设计 run 由 design-run-manager 独立持有,卸载不中断,返回后设计恢复。 */}
      {designOpen && !settingsOpen ? <DesignWorkspace /> : null}
      {/* 写作工作区:整窗覆盖层,与设计同构。settingsOpen 时不渲染(同设计,避免 z-40 覆盖层
          盖住设置页拦截点击);写作 run 由 writing-run-manager 独立持有(U7),卸载不中断。 */}
      {writingOpen && !settingsOpen ? <WritingWorkspace /> : null}
      {/* 深度研究:整窗覆盖层,与设计/写作同构。settingsOpen 时让位(否则 z-40 盖住设置页拦点击)。
          研究会话真源在主进程(SQLite + 编排器),覆盖层卸载不会中断正在跑的研究,重开后由
          bridge.list() + research:event 重新灌入 ui-store。桥经 CoreProvider 注入,组件不摸 window。 */}
      {researchOpen && !settingsOpen ? (
        <ResearchWorkspace
          bridge={bridge.research ?? null}
          onClose={closeResearch}
          // 「本次研究用哪个模型」由设置决定，这里解析成只读告知交给表单显示。
          // 这里是唯一读设置的地方——views 的研究组件本身不碰 personal store。
          model={researchModel}
        />
      ) : null}
      {settingsOpen ? <PersonalSettingsView /> : null}
      <PiToolConfirmDialog />
      <SessionSearchDialog />
    </>
  );
}
