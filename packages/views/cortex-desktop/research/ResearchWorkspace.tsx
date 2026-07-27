// Deep Research 整窗覆盖层（fixed inset-0），三栏：左会话列表 / 中运行视图 / 右引用详情面板。
// 结构照 WritingWorkspace / DesignWorkspace 的覆盖层惯例，文案硬编码 zh-Hans（个人工作区惯例）。
//
// 数据流：
//   会话列表与事件落状态（applyEvent）由**常驻**的 useResearchLiveSync 负责，不在本组件
//   （core/research/live-sync.ts；本组件绝不许再调 applyEvent，增量事件扇出两次会翻倍）；
//   选中会话 → bridge.get(id, "full") 拿计划/轮次/报告（**不是 evidence**）；
//   运行中 → round / done / status 事件触发防抖重拉 "full"（详情只在 main，事件里不带）；
//   证据正文 → 只在用户点击报告里的引用后，由本组件经 get(id, "evidence") 按需拉并缓存。
// 「什么时候拉、拉到什么级别」全部收在本组件一处，别的地方不要再发起 get，
// 否则很容易出现某个角落顺手拉了 evidence 把正文带进内存（spec §16 / §19.3.2）。
//
// 右栏是**引用详情面板，默认隐藏**：早先它常驻 340px 展示完整来源列表，日常使用价值低
// 且长期挤占中栏报告宽度。现在只有点击报告里的引用（正文 chip 或文末参考来源条目）才
// 展开，且只显示被点的那一条。evidence 缓存必须留在本组件（而不是面板内）：
// 右栏关闭即卸载，面板内缓存会随之丢失，每次重开都得重拉几 MB 正文。
//
// **启动研究由本组件负责，不在创建表单里**：表单在 onCreated 之后立刻卸载，而 run 必须
// 发生在「会话已经进入 ui-store 的列表」之后——否则编排发出的事件会被 applyEvent 当作
// 未知会话丢弃（那正是「点了开始后页面毫无反应」的根因）。
//
// bridge 为 null（Web 端没有桌面桥）时渲染降级提示，不做任何订阅与请求。
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type {
  EvidenceChunk,
  ResearchDocument,
} from "@cortex-work/core/research/evidence";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import type { ResearchReport, ResearchSessionSummary } from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { ResearchCreateForm } from "./ResearchCreateForm";
import type { ResearchExportTarget } from "./ResearchRunView";
import { ResearchRunView } from "./ResearchRunView";
import { ResearchSessionList } from "./ResearchSessionList";
import { ResearchSourcePanel, type FocusedCitation } from "./ResearchSourcePanel";
import type { ResearchModelDisplay } from "./modelDisplay";
import type { DisplayRef } from "./reportDisplay";
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

/// 事件触发重拉详情的防抖窗口。
///
/// 一轮里 round / status / activity 会密集到达，每条都去 get("full") 等于把 SQLite 当轮询接口打。
/// 500ms 对人眼已经是「立刻」，对数据库则是把几十次查询压成一次。
const DETAIL_REFRESH_DEBOUNCE_MS = 500;

/// 哪些事件意味着「main 那边的详情变了，该重新拉一次」。
/// stage 不在其中：它只改阶段徽标，计划 / 轮次 / 报告都没动（reporting 由 status 事件覆盖）。
function shouldRefreshDetail(event: { type: string }): boolean {
  return event.type === "round" || event.type === "done" || event.type === "status";
}

/// Deep Research 工作区根组件：列表 + 新建表单 + 运行视图的编排者。
/// **detail 级别的分工是硬约束**：这里只在选中会话时拉 "full"；"evidence" 只在用户
/// 点击报告里的引用后按需拉取（见 openCitation），别处不得发起 get。
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

  // ── 右栏引用详情面板 ─────────────────────────────────────────────────────
  // focus 为 null 即「右栏隐藏」。focus 里带 sessionId：拉取与展示都以它为准，
  // 避免「点击后立刻切会话」时把旧会话的引用显示到新会话上。
  const [focus, setFocus] = useState<(FocusedCitation & { sessionId: string }) | null>(null);
  // evidence 按 sessionId 缓存：右栏关闭即卸载，缓存若放面板内会随卸载丢失。
  // 不进 ui-store——正文可能是几 MB，唯一消费者就是这里，放全局只会拖累每个 selector。
  const [evidenceCache, setEvidenceCache] = useState<
    Record<string, { documents: ResearchDocument[]; chunks: EvidenceChunk[] }>
  >({});
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  // 在途拉取的 sessionId：连点两条 chip 不该并发拉两次同一份 evidence。
  const evidenceInflightRef = useRef<string | null>(null);

  // 详情重拉的防抖计时器。放 ref 而不是 state：它只影响副作用的时序，不该触发渲染。
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 拉一次 "full" 详情并落 store。**只有这里和右栏能发 get**（见文件头的分工约束）。
  const fetchDetail = useCallback(
    (sessionId: string) => {
      if (!bridge) return;
      void bridge
        .get(sessionId, "full")
        .then((view) => useResearchUiStore.getState().setDetail(sessionId, view))
        .catch((e: unknown) =>
          useResearchUiStore.getState().setError(`加载研究详情失败：${errText(e)}`),
        );
    },
    [bridge],
  );

  // 按需拉 evidence 并写入缓存（spec §16：只允许在用户点击引用之后走到这里）。
  // 已在缓存或同会话在途时直接跳过——连点 chip / 重开右栏都不该再发请求。
  const loadEvidence = useCallback(
    (sessionId: string) => {
      if (!bridge) return;
      if (evidenceCache[sessionId] || evidenceInflightRef.current === sessionId) return;
      evidenceInflightRef.current = sessionId;
      setEvidenceLoading(true);
      setEvidenceError(null);
      void bridge
        .get(sessionId, "evidence")
        .then((view) =>
          setEvidenceCache((c) => ({
            ...c,
            [sessionId]: { documents: view.documents ?? [], chunks: view.chunks ?? [] },
          })),
        )
        .catch((e: unknown) => setEvidenceError(`加载来源失败：${errText(e)}`))
        .finally(() => {
          evidenceInflightRef.current = null;
          setEvidenceLoading(false);
        });
    },
    [bridge, evidenceCache],
  );

  /// 点击报告里的引用：展开右栏并聚焦该条。聚焦先行（右栏立刻出现、显示加载中），
  /// evidence 随后按需拉；已缓存则零请求。
  const openCitation = useCallback(
    (ref: DisplayRef) => {
      const sessionId = useResearchUiStore.getState().activeSessionId;
      if (!sessionId) return;
      setFocus({
        sessionId,
        index: ref.index,
        chunkId: ref.chunkId,
        ...(ref.title ? { title: ref.title } : {}),
        ...(ref.url ? { url: ref.url } : {}),
      });
      setEvidenceError(null);
      loadEvidence(sessionId);
    },
    [loadEvidence],
  );

  // 挂载：订阅事件，**只为触发详情重拉**。
  //
  // 列表灌入与 applyEvent 已由常驻的 useResearchLiveSync（core/research/live-sync.ts）接管——
  // 它挂在 PersonalWorkspace 上，不随本组件开合而断。本组件**绝不能再调 applyEvent**：
  // report_delta 是增量拼接、activity 是环形追加，扇出两次报告正文就会翻倍。
  // 这里订阅的唯一目的是「main 侧详情变了，重拉一次 full」，那是幂等的。
  // 清理函数必须调用 onEvent 返回的退订函数，否则反复开合会累积监听器。
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const off = bridge.onEvent((event) => {
      // 详情（真实计划 / 轮次 / 报告）不在事件里，只能重新拉。只拉当前选中的那个会话——
      // 后台跑着的其它会话没人在看，拉回来只是白占内存。
      if (!shouldRefreshDetail(event)) return;
      if (useResearchUiStore.getState().activeSessionId !== event.sessionId) return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        if (alive) fetchDetail(event.sessionId);
      }, DETAIL_REFRESH_DEBOUNCE_MS);
    });

    return () => {
      alive = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      off();
    };
  }, [bridge, fetchDetail]);

  // 选中会话时补 "full" 详情。
  //
  // **stale-while-revalidate**：缓存里的先渲染（没有空白闪烁），同时无条件再拉一次。
  // 曾经这里是「缓存里有 plan 就不拉了」，而 create 时就落了一份种子计划——结果真实计划、
  // 轮次与报告在整个生命周期里都不会出现，只能重启应用。
  const selectSession = useCallback(
    (sessionId: string) => {
      const store = useResearchUiStore.getState();
      store.selectSession(sessionId);
      setCreating(false);
      // 换会话即清掉启动失败提示：它只属于刚才那个会话。
      setStartError(null);
      // 聚焦的引用同样只属于旧会话：右栏随之关闭（缓存按 sessionId 隔离，保留）。
      setFocus(null);
      fetchDetail(sessionId);
    },
    [fetchDetail],
  );

  const deleteSession = useCallback(
    (sessionId: string) => {
      if (!bridge) return;
      void bridge
        .delete(sessionId)
        // 先等 main 删成功再改本地：乐观删除一旦失败，会话会从列表消失但其实还在跑。
        .then(() => {
          useResearchUiStore.getState().removeSession(sessionId);
          // 顺手清掉该会话的 evidence 缓存：几 MB 正文不该为一个已删除的会话滞留内存。
          setEvidenceCache((c) => {
            if (!(sessionId in c)) return c;
            const next = { ...c };
            delete next[sessionId];
            return next;
          });
          setFocus((f) => (f?.sessionId === sessionId ? null : f));
        })
        .catch((e: unknown) =>
          useResearchUiStore.getState().setError(`删除失败：${errText(e)}`),
        );
    },
    [bridge],
  );

  /// 新建 / 重跑产出会话后的统一落位：插列表 + 选中 + 清错。**不启动**。
  const onCreated = useCallback((summary: ResearchSessionSummary) => {
    const store = useResearchUiStore.getState();
    store.upsertSession(summary);
    store.selectSession(summary.sessionId);
    setCreating(false);
    setStartError(null);
    setFocus(null);
  }, []);

  const onReportRegenerated = useCallback(
    (report: ResearchReport, sessionId: string) => {
      const store = useResearchUiStore.getState();
      const current = store.detailCache[sessionId];
      if (current) store.setDetail(sessionId, { ...current, report });
      else fetchDetail(sessionId);
    },
    [fetchDetail],
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
              onCitationClick={openCitation}
              startError={
                startError && startError.sessionId === activeSessionId ? startError.message : null
              }
            />
          )}
        </div>

        {/* 右栏只在有聚焦引用时渲染：默认隐藏，中栏报告占满宽度。
            focus.sessionId 必须仍等于当前选中会话——点击后立刻切会话的竞态下，
            旧会话的引用不该显示在新会话上（selectSession 也会清 focus，这里是双保险）。 */}
        {focus && focus.sessionId === activeSessionId ? (
          <div className="pw-res-col-right">
            <ResearchSourcePanel
              citation={focus}
              evidence={evidenceCache[focus.sessionId] ?? null}
              loading={evidenceLoading && !evidenceCache[focus.sessionId]}
              error={evidenceError}
              onRetry={() => loadEvidence(focus.sessionId)}
              onClose={() => setFocus(null)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
