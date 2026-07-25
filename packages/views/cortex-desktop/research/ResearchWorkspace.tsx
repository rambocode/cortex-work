// Deep Research 整窗覆盖层（fixed inset-0），三栏：左会话列表 / 中运行视图 / 右来源面板。
// 结构照 WritingWorkspace / DesignWorkspace 的覆盖层惯例，文案硬编码 zh-Hans（个人工作区惯例）。
//
// 数据流：
//   挂载 → bridge.list() 灌入 ui-store → bridge.onEvent 订阅，事件经 applyEvent 落状态；
//   选中会话 → bridge.get(id, "full") 拿计划/轮次/报告（**不是 evidence**）；
//   证据正文 → 只由右栏在用户展开时经 get(id, "evidence") 按需拉。
// 「什么时候拉、拉到什么级别」全部收在本组件与右栏两处，别的地方不要再发起 get，
// 否则很容易出现某个角落顺手拉了 evidence 把正文带进内存（spec §16 / §19.3.2）。
//
// bridge 为 null（Web 端没有桌面桥）时渲染降级提示，不做任何订阅与请求。
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import type { ResearchSessionSummary } from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import { ResearchCreateForm } from "./ResearchCreateForm";
import { ResearchRunView } from "./ResearchRunView";
import { ResearchSessionList } from "./ResearchSessionList";
import { ResearchSourcePanel } from "./ResearchSourcePanel";
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
}

/// 统一的错误消息提取（Error / 任意抛出物都能变成一句可展示的话）。
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// Deep Research 工作区根组件：列表 + 新建表单 + 运行视图的编排者。
/// **detail 级别的分工是硬约束**：这里只在选中会话时拉 "full"，"evidence" 一律由
/// ResearchSourcePanel 在用户点开来源时按需拉取，别处不得发起 get。
export function ResearchWorkspace({
  bridge,
  onClose,
  model,
}: ResearchWorkspaceProps): ReactElement {
  const sessions = useResearchUiStore((s) => s.sessions);
  const activeSessionId = useResearchUiStore((s) => s.activeSessionId);
  const detailCache = useResearchUiStore((s) => s.detailCache);
  const progressMap = useResearchUiStore((s) => s.progress);
  const warningMap = useResearchUiStore((s) => s.warnings);
  const loading = useResearchUiStore((s) => s.loading);
  const error = useResearchUiStore((s) => s.error);
  const [creating, setCreating] = useState(false);
  // 「会话建好了但没跑起来」的原因，连同它属于哪个会话一起记——创建表单在 onCreated 时就被
  // 卸载，它自己的错误 state 会随之消失，原因必须由这里保管并显示在会话视图上。
  const [startError, setStartError] = useState<{ sessionId: string; message: string } | null>(null);

  // 挂载：拉列表 + 订阅事件。两件事放一个 effect，保证订阅在列表回来之前就已建立——
  // 反过来（先拿列表再订阅）会漏掉这段窗口期内发生的事件。
  // 清理函数必须调用 onEvent 返回的退订函数，否则整窗反复开合会累积监听器。
  useEffect(() => {
    if (!bridge) return;
    const store = useResearchUiStore.getState();
    let alive = true;
    const off = bridge.onEvent((event) => useResearchUiStore.getState().applyEvent(event));

    store.setLoading(true);
    store.setError(null);
    void bridge
      .list()
      .then((list) => {
        if (!alive) return;
        useResearchUiStore.getState().setSessions(list);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        useResearchUiStore.getState().setError(`加载研究列表失败：${errText(e)}`);
      })
      .finally(() => {
        if (alive) useResearchUiStore.getState().setLoading(false);
      });

    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  // 选中会话时补 "full" 详情。已缓存过 plan 的不再重复拉——
  // 运行中的增量变化由事件推送，不靠轮询详情。
  const selectSession = useCallback(
    (sessionId: string) => {
      const store = useResearchUiStore.getState();
      store.selectSession(sessionId);
      setCreating(false);
      // 换会话即清掉启动失败提示：它只属于刚才那个会话。
      setStartError(null);
      if (!bridge || store.detailCache[sessionId]?.plan) return;
      void bridge
        .get(sessionId, "full")
        .then((view) => useResearchUiStore.getState().setDetail(sessionId, view))
        .catch((e: unknown) =>
          useResearchUiStore.getState().setError(`加载研究详情失败：${errText(e)}`),
        );
    },
    [bridge],
  );

  const deleteSession = useCallback(
    (sessionId: string) => {
      if (!bridge) return;
      void bridge
        .delete(sessionId)
        // 先等 main 删成功再改本地：乐观删除一旦失败，会话会从列表消失但其实还在跑。
        .then(() => useResearchUiStore.getState().removeSession(sessionId))
        .catch((e: unknown) =>
          useResearchUiStore.getState().setError(`删除失败：${errText(e)}`),
        );
    },
    [bridge],
  );

  const onCreated = useCallback((summary: ResearchSessionSummary, startError?: string) => {
    const store = useResearchUiStore.getState();
    store.upsertSession(summary);
    store.selectSession(summary.sessionId);
    setCreating(false);
    // 只对刚创建的这个会话记错：切到别的会话时清掉（见 selectSession），
    // 否则一条「启动失败」会跟着用户在所有会话之间飘。
    setStartError(startError ? { sessionId: summary.sessionId, message: startError } : null);
  }, []);

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
              onCreated={onCreated}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <ResearchRunView
              bridge={bridge}
              session={activeSession}
              view={activeView}
              progress={activeSessionId ? progressMap[activeSessionId] : undefined}
              warnings={activeSessionId ? warningMap[activeSessionId] : undefined}
              onExportMarkdown={exportMarkdown}
              // 重跑产出的新会话走与新建完全相同的落位逻辑（插列表 + 选中 + 清错）。
              onRerun={onCreated}
              startError={
                startError && startError.sessionId === activeSessionId ? startError.message : null
              }
            />
          )}
        </div>

        <div className="pw-res-col-right">
          <ResearchSourcePanel bridge={bridge} session={activeSession} />
        </div>
      </div>
    </div>
  );
}
