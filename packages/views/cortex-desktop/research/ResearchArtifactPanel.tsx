// 会话右栏的深度研究面板：`/skill:research` 发起的研究在这里展示进度与报告。
//
// 与「产物面板」（演示文稿 / 设计稿）同构——同为右栏视图、同为 660px 中栏保留宽度，
// 而不再是从前那个互斥的整窗覆盖层：研究是分钟级长任务，用户要能一边看报告一边继续对话。
//
// **绝不调用 ui-store.applyEvent**（风险点 1）：事件落状态是常驻的 useResearchLiveSync
// （core/research/live-sync.ts）的独占职责。report_delta 是增量拼接、activity 是环形追加，
// 都不幂等，这里再扇出一次报告正文就会翻倍。本面板对事件的唯一用途是触发详情重拉，
// 那条路径由 useResearchSessionDetail 承担，是幂等的。
//
// 布局与整窗覆盖层的差别：右栏只有一栏可用，所以引用详情不另开第三栏，
// 而是盖在面板内部的绝对定位抽屉里（.pw-research-panel-source）。
import { useCallback, useMemo, useState, type ReactElement } from "react";
import type { ConversationResearchRef } from "@cortex-work/core";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import type { ResearchReport, ResearchSessionSummary } from "@cortex-work/core/research/types";
import type { ResearchBridgeLike } from "./bridge-like";
import type { ResearchExportTarget } from "./ResearchRunView";
import { ResearchRunView } from "./ResearchRunView";
import { ResearchSessionList } from "./ResearchSessionList";
import { ResearchSourcePanel } from "./ResearchSourcePanel";
import { useResearchSessionDetail } from "./useResearchSessionDetail";
import type { ResearchModelDisplay } from "./modelDisplay";
import "./research.css";

/// 面板 props。数据入口只有两处：ui-store（研究本身的状态）与 refs（会话的归属关系）。
export interface ResearchArtifactPanelProps {
  /// 桌面桥；Web 端传 null，面板走降级分支。
  bridge: ResearchBridgeLike | null;
  /// 当前展示的研究会话 id；null 表示本会话还没有研究（空态）。
  sessionId: string | null;
  /// 本会话经 /skill:research 发起过的研究引用。**只读**：面板不写归属，
  /// 切换展示一律经 onSelect 交给宿主（D6：看别人的研究不等于本会话发起过）。
  refs: readonly ConversationResearchRef[];
  /// 请求切换展示的研究。宿主决定是持久化还是只切当前展示。
  onSelect: (sessionId: string) => void;
  /// 本次研究使用的模型（展示名 + 出站说明），由宿主按设置解析后注入。
  model?: ResearchModelDisplay;
  /// 报告的额外去向（存为写作文档 / 闪记…）。研究面板不该知道别的工作区存在，故由宿主注入。
  exportTargets?: readonly ResearchExportTarget[];
}

/// 导出报告为 Markdown 下载。jsdom 与老壳可能没有 createObjectURL，缺失时静默跳过。
function downloadMarkdown(markdown: string, session: ResearchSessionSummary): void {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `research-${session.sessionId}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

/// 会话右栏的研究面板。
export function ResearchArtifactPanel({
  bridge,
  sessionId,
  refs,
  onSelect,
  model,
  exportTargets,
}: ResearchArtifactPanelProps): ReactElement {
  const sessions = useResearchUiStore((s) => s.sessions);
  const detailCache = useResearchUiStore((s) => s.detailCache);
  const progressMap = useResearchUiStore((s) => s.progress);
  const warningMap = useResearchUiStore((s) => s.warnings);
  const activityMap = useResearchUiStore((s) => s.activities);
  const draftMap = useResearchUiStore((s) => s.reportDraft);
  // 「全部研究」抽屉：主路径是会话流里的研究卡片，这里只是回看旧研究的兜底入口，
  // 故默认收起——右栏本来就窄，常驻一份列表会把报告挤没。
  const [allOpen, setAllOpen] = useState(false);

  const detail = useResearchSessionDetail(bridge, sessionId);

  const session = useMemo(
    () => sessions.find((s) => s.sessionId === sessionId) ?? null,
    [sessions, sessionId],
  );

  /// 抽屉里选中一条：收起抽屉并请求宿主切换展示。**不写 refs**（见 props 注释）。
  const selectFromDrawer = useCallback(
    (id: string) => {
      setAllOpen(false);
      onSelect(id);
    },
    [onSelect],
  );

  /// 重跑产出的是**新的** sessionId。插进 ui-store 后切过去展示；是否记进会话归属由宿主定。
  const onRerun = useCallback(
    (created: ResearchSessionSummary) => {
      useResearchUiStore.getState().upsertSession(created);
      onSelect(created.sessionId);
    },
    [onSelect],
  );

  /// 报告重生成：能就地替换详情缓存就替换，否则重拉一次。
  /// sessionId 由回调显式回传——生成可能几分钟，期间用户可能已经切走。
  const onReportRegenerated = useCallback(
    (report: ResearchReport, target: string) => {
      const store = useResearchUiStore.getState();
      const current = store.detailCache[target];
      if (current) store.setDetail(target, { ...current, report });
      else detail.refresh(target);
    },
    [detail],
  );

  if (!bridge) {
    return (
      <div className="pw-research-panel">
        <div className="pw-res-empty">深度研究只在桌面端可用。</div>
      </div>
    );
  }

  return (
    <div className="pw-research-panel">
      {/* 模型是**只读告知**：用哪个模型在设置里定，这里只让「正文会不会出本机」保持可见。 */}
      {model ? (
        <div className={`pw-research-panel-model is-${model.isLocal ? "local" : "remote"}`}>
          <span className="pw-research-panel-model-t">
            {model.label ?? "尚未配置可用的模型"}
          </span>
          <span className="pw-research-panel-model-egress">{model.egressZh}</span>
        </div>
      ) : null}

      <div className="pw-research-panel-bar">
        <button
          type="button"
          className="pw-res-btn is-ghost"
          aria-expanded={allOpen}
          onClick={() => setAllOpen((v) => !v)}
        >
          {`全部研究 (${sessions.length})`}
        </button>
        {/* 本会话有多条研究时给一排快捷切换；只有一条时这排是废话，不渲染。 */}
        {refs.length > 1 ? (
          <div className="pw-research-panel-refs">
            {refs.map((ref) => (
              <button
                key={ref.sessionId}
                type="button"
                className={`pw-research-panel-ref${ref.sessionId === sessionId ? " is-active" : ""}`}
                title={ref.objective}
                onClick={() => onSelect(ref.sessionId)}
              >
                {ref.objective}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {allOpen ? (
        <div className="pw-research-panel-drawer">
          <ResearchSessionList
            sessions={sessions}
            activeSessionId={sessionId}
            onSelect={selectFromDrawer}
            // 发起研究的入口是输入框的 /skill:research，面板里不再开第二个表单；
            // 删除同理不在这里给——右栏删掉的研究，会话流里的卡片会变成死链。
            hideCreate
          />
        </div>
      ) : null}

      <div className="pw-research-panel-body">
        {sessionId ? (
          <ResearchRunView
            bridge={bridge}
            session={session}
            view={detailCache[sessionId]}
            progress={progressMap[sessionId]}
            warnings={warningMap[sessionId]}
            activities={activityMap[sessionId]}
            reportDraft={draftMap[sessionId]}
            onExportMarkdown={downloadMarkdown}
            {...(exportTargets ? { exportTargets } : {})}
            onRerun={onRerun}
            onReportRegenerated={onReportRegenerated}
            onCitationClick={detail.openCitation}
          />
        ) : (
          <div className="pw-res-empty">
            本会话还没有深度研究。在输入框用 /skill:research 发起一次。
          </div>
        )}
      </div>

      {/* 引用详情：右栏没有第三栏可开，改为盖在面板内的抽屉。
          focus 自带 sessionId，切换展示时由 hook 清空，不会把旧研究的引用显示到新研究上。 */}
      {detail.focus && detail.focus.sessionId === sessionId ? (
        <div className="pw-research-panel-source">
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
  );
}
