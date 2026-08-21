// research 面板的懒加载入口。原 PersonalWorkspace/PersonalRightPanel 两处的研究展示型
// 逻辑收拢到这里:模型显示与产物去向按设置解析（与设置页/主进程 llm-hooks-wiring 同一套
// 规则）,「回看另一条研究」的临时选择只切展示、不写回会话归属,换会话即失效。
// 注意:研究事件的常驻订阅(live-sync/completion-relay)仍在 PersonalWorkspace——
// 研究是分钟级任务,面板随视图切换卸载,订阅一断 report_delta 增量就永久丢了,绝不迁入。
import { useEffect, useMemo, useState } from "react";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import { normalizeResearchEngineSettings } from "@cortex-work/core/research/settings";
import { ResearchArtifactPanel } from "./ResearchArtifactPanel";
import { useResearchExportTargets } from "./useResearchExportTargets";
import { useResearchModelDisplay } from "./modelDisplay";

export default function ResearchPanelEntry() {
  const bridge = useDesktopBridge();
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const activeSession = usePersonalStore((s) =>
    s.sessions.find((session) => session.id === s.activeSessionId),
  );
  const refs = activeSession?.researchSessions;

  // 面板内「回看另一条研究」的临时选择（D6）:换会话即失效——上一条对话看到哪儿,
  // 不该带进下一条对话。
  const [viewingResearchId, setViewingResearchId] = useState<string | null>(null);
  useEffect(() => setViewingResearchId(null), [activeSessionId]);
  const researchSessionId =
    viewingResearchId ??
    activeSession?.activeResearchSessionId ??
    refs?.[refs.length - 1]?.sessionId ??
    null;

  // 「本次研究会用哪个模型、正文出不出本机」:按设置归一化解析,悬空显示未配置。
  const researchEngineSettings = usePersonalStore((s) => s.generalSettings.researchEngine);
  const researchModel = useResearchModelDisplay(
    useMemo(() => {
      const research = normalizeResearchEngineSettings(researchEngineSettings);
      return {
        ...(research.modelProviderId ? { providerId: research.modelProviderId } : {}),
        ...(research.modelId ? { modelId: research.modelId } : {}),
      };
    }, [researchEngineSettings]),
  );
  // 报告的产物去向（写作文档/闪记）:按本机可用能力动态增减。
  const researchExportTargets = useResearchExportTargets();

  return (
    <ResearchArtifactPanel
      bridge={bridge?.research ?? null}
      sessionId={researchSessionId}
      refs={refs ?? []}
      onSelect={setViewingResearchId}
      {...(researchModel ? { model: researchModel } : {})}
      {...(researchExportTargets ? { exportTargets: researchExportTargets } : {})}
    />
  );
}
