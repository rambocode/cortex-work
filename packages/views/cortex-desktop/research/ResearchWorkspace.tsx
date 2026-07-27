// Deep Research 整窗覆盖层（fixed inset-0），三栏：左会话列表 / 中运行视图 / 右引用详情面板。
// 结构照 WritingWorkspace / DesignWorkspace 的覆盖层惯例，文案硬编码 zh-Hans（个人工作区惯例）。
//
// 数据流：
//   会话列表与事件落状态（applyEvent）由**常驻**的 useResearchLiveSync 负责，不在本组件
//   （core/research/live-sync.ts；本组件绝不许再调 applyEvent，增量事件扇出两次会翻倍）；
//   详情拉取（选中拉 "full"、事件防抖重拉、evidence 按需加载与缓存）全部收在
//   useResearchSessionDetail 一处，本组件与会话右栏面板共用它，避免两份时序实现漂移；
//   「什么时候拉、拉到什么级别」的硬约束见该文件头（spec §16 / §19.3.2）。
//
// 右栏是**引用详情面板，默认隐藏**：早先它常驻 340px 展示完整来源列表，日常使用价值低
// 且长期挤占中栏报告宽度。现在只有点击报告里的引用（正文 chip 或文末参考来源条目）才
// 展开，且只显示被点的那一条。
//
// **启动研究由本组件负责，不在创建表单里**：表单在 onCreated 之后立刻卸载，而 run 必须
// 发生在「会话已经进入 ui-store 的列表」之后——否则编排发出的事件会被 applyEvent 当作
// 未知会话丢弃（那正是「点了开始后页面毫无反应」的根因）。
//
// bridge 为 null（Web 端没有桌面桥）时渲染降级提示，不做任何订阅与请求。
import { useCallback, useState, type ReactElement } from "react";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import type { ResearchReport, ResearchSessionSummary } from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { ResearchCreateForm } from "./ResearchCreateForm";
import type { ResearchExportTarget } from "./ResearchRunView";
import { ResearchRunView } from "./ResearchRunView";
import { ResearchSessionList } from "./ResearchSessionList";
import { ResearchSourcePanel } from "./ResearchSourcePanel";
import { useResearchSessionDetail } from "./useResearchSessionDetail";
import type { ResearchModelDisplay } from "./modelDisplay";
import "./research.css";

/// 工作区 props。bridge 由宿主壳注入（组件不摸 window），onClose 供整窗覆盖层关闭。
export interface ResearchWorkspaceProps {
  /// 桌面桥；Web 端传 null，组件走降级分支。
  bridge: ResearchBridgeLike | null;
  onClose: () => void;
  /// 本次研究将使用的模型（展示名 + 是否本机 + 出站说明），来自设置。
  /// 由宿主注入：views 不读个人工作区的设置 store，保持可复用。
  model?: ResearchModelDisplay;
  /// 新建表单的预填目标（「转为深度研究」等反向入口带上下文进来）。
  initialObjective?: string;
  /// 报告的额外去向（存为写作文档 / 闪记 / 演示大纲…）。
  /// 由宿主注入：研究工作区不该知道其它工作区的存在（见 ResearchRunView 的同名 prop 注释）。
  exportTargets?: readonly ResearchExportTarget[];
}

/// 统一的错误消息提取（Error / 任意抛出物都能变成一句可展示的话）。
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// Deep Research 工作区根组件：列表 + 新建表单 + 运行视图的编排者。
/// 详情拉取的时序与级别分工全在 useResearchSessionDetail（与会话右栏面板共用同一份）。
export function ResearchWorkspace({
  bridge,
  onClose,
  model,
  initialObjective,
  exportTargets,
}: ResearchWorkspaceProps): ReactElement {
  const sessions = useResearchUiStore((s) => s.sessions);
  const activeSessionId = useResearchUiStore((s) => s.activeSessionId);
  const detailCache = useResearchUiStore((s) => s.detailCache);
  const progressMap = useResearchUiStore((s) => s.progress);
  const warningMap = useResearchUiStore((s) => s.warnings);
  const activityMap = useResearchUiStore((s) => s.activities);
  const draftMap = useResearchUiStore((s) => s.reportDraft);
  const loading = useResearchUiStore((s) => s.loading);
  const error = useResearchUiStore((s) => s.error);
  // 带着预填目标进来（「转为深度研究」）时直接落在新建表单上：
  // 用户的意图已经明确，还让他先点一次「新建」是多余的一步。
  const [creating, setCreating] = useState(() => !!initialObjective);
  // 「会话建好了但没跑起来」的原因，连同它属于哪个会话一起记——创建表单在 onCreated 时就被
  // 卸载，它自己的错误 state 会随之消失，原因必须由这里保管并显示在会话视图上。
  const [startError, setStartError] = useState<{ sessionId: string; message: string } | null>(null);

  // 详情拉取与引用详情（含 evidence 按需加载与缓存）全部交给共用 hook——
  // 会话右栏面板用的是同一份，两处时序不会漂移。选中会话变化时它自己会重拉并清聚焦。
  const detail = useResearchSessionDetail(bridge, activeSessionId);

  /// 选中会话：切 store 的选中项即可，详情由 hook 的 sessionId 变化驱动。
  const selectSession = useCallback((sessionId: string) => {
    useResearchUiStore.getState().selectSession(sessionId);
    setCreating(false);
    // 换会话即清掉启动失败提示：它只属于刚才那个会话。
    setStartError(null);
  }, []);

  const deleteSession = useCallback(
    (sessionId: string) => {
      if (!bridge) return;
      void bridge
        .delete(sessionId)
        // 先等 main 删成功再改本地：乐观删除一旦失败，会话会从列表消失但其实还在跑。
        .then(() => {
          useResearchUiStore.getState().removeSession(sessionId);
          // 顺手清掉该会话的 evidence 缓存：几 MB 正文不该为一个已删除的会话滞留内存。
          detail.dropEvidence(sessionId);
        })
        .catch((e: unknown) =>
          useResearchUiStore.getState().setError(`删除失败：${errText(e)}`),
        );
    },
    [bridge, detail],
  );

  /// 新建 / 重跑产出会话后的统一落位：插列表 + 选中 + 清错。**不启动**。
  /// 聚焦的引用由 hook 随 sessionId 变化自行清空。
  const onCreated = useCallback((summary: ResearchSessionSummary) => {
    const store = useResearchUiStore.getState();
    store.upsertSession(summary);
    store.selectSession(summary.sessionId);
    setCreating(false);
    setStartError(null);
  }, []);

  const onReportRegenerated = useCallback(
    (report: ResearchReport, sessionId: string) => {
      const store = useResearchUiStore.getState();
      const current = store.detailCache[sessionId];
      if (current) store.setDetail(sessionId, { ...current, report });
      else detail.refresh(sessionId);
    },
    [detail],
  );

  /// 新建完成：落位之后立刻启动。
  ///
  /// 顺序是硬约束——upsertSession 必须先于 bridge.run 完成，否则编排一开始发出的事件会落到
  /// 一个「列表里还没有」的会话上，被 ui-store 直接丢弃。
  ///
  /// run 现在是**启动即返回**的（main 侧 fire-and-forget），所以这里的 catch 只可能抓到
  /// 启动前就能判定的失败（研究未开启 / 搜索服务未配置）。这条原因必须由本组件保管：
  /// 创建表单在 onCreated 的那一刻就被卸载，它自己的 state 里那条提示还没来得及被看见就没了。
  const onCreatedAndStart = useCallback(
    (summary: ResearchSessionSummary) => {
      onCreated(summary);
      if (!bridge) return;
      void bridge.run(summary.sessionId).catch((e: unknown) => {
        setStartError({ sessionId: summary.sessionId, message: `启动失败：${errText(e)}` });
      });
    },
    [bridge, onCreated],
  );

  // 导出报告：浏览器下载。jsdom 与老壳可能没有 createObjectURL，缺失时静默跳过
  // （调用方也可以自己传 onExportMarkdown 覆盖，例如走 bridge 写盘）。
  const exportMarkdown = useCallback((markdown: string, session: ResearchSessionSummary) => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `research-${session.sessionId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  if (!bridge) {
    return (
      <div className="pw-res-root">
        <div className="pw-res-fallback">
          <div className="pw-res-fallback-title">深度研究只在桌面端可用</div>
          <div className="pw-res-fallback-desc">
            研究引擎需要本机的抓取、存储与模型能力，网页版无法提供。请在 Cortex 桌面端打开。
          </div>
          <button type="button" className="pw-res-btn is-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId) ?? null;
  const activeView = activeSessionId ? detailCache[activeSessionId] : undefined;

  return (
    <div className="pw-res-root">
      {/* ds-window-controls-safe-inset：mac 隐藏式标题栏下给红绿灯让位（见 cortex-desktop.css）。 */}
      <div className="pw-res-titlebar ds-window-controls-safe-inset">
        <span className="pw-res-titlebar-t">深度研究</span>
        <button type="button" className="pw-res-btn" onClick={onClose}>
          关闭
        </button>
      </div>

      {error ? <div className="pw-res-error is-banner">{error}</div> : null}

      <div className="pw-res-cols">
        <div className="pw-res-col-left">
          <ResearchSessionList
            sessions={sessions}
            activeSessionId={activeSessionId}
            loading={loading}
            onSelect={selectSession}
            onCreate={() => setCreating(true)}
            onDelete={deleteSession}
          />
        </div>

        <div className="pw-res-col-center">
          {creating ? (
            <ResearchCreateForm
              bridge={bridge}
              {...(model ? { model } : {})}
              {...(initialObjective ? { initialObjective } : {})}
              onCreated={onCreatedAndStart}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <ResearchRunView
              bridge={bridge}
              session={activeSession}
              view={activeView}
              progress={activeSessionId ? progressMap[activeSessionId] : undefined}
              warnings={activeSessionId ? warningMap[activeSessionId] : undefined}
              activities={activeSessionId ? activityMap[activeSessionId] : undefined}
              reportDraft={activeSessionId ? draftMap[activeSessionId] : undefined}
              onExportMarkdown={exportMarkdown}
              {...(exportTargets ? { exportTargets } : {})}
              // 重跑产出的新会话走与新建完全相同的落位逻辑（插列表 + 选中 + 清错）。
              onRerun={onCreated}
              onReportRegenerated={onReportRegenerated}
              onCitationClick={detail.openCitation}
              startError={
                startError && startError.sessionId === activeSessionId ? startError.message : null
              }
            />
          )}
        </div>

        {/* 右栏只在有聚焦引用时渲染：默认隐藏，中栏报告占满宽度。
            focus.sessionId 必须仍等于当前选中会话——点击后立刻切会话的竞态下，
            旧会话的引用不该显示在新会话上（selectSession 也会清 focus，这里是双保险）。 */}
        {detail.focus && detail.focus.sessionId === activeSessionId ? (
          <div className="pw-res-col-right">
            <ResearchSourcePanel
              citation={detail.focus}
              evidence={detail.evidence}
              loading={detail.evidenceLoading}
              error={detail.evidenceError}
              onRetry={detail.retryEvidence}
              onClose={detail.closeCitation}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
