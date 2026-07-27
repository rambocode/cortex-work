// 一条研究会话的「详情拉取」编排：什么时候拉、拉到什么级别，全收在这一个 hook 里。
//
// **detail 级别的分工是硬约束（spec §16 / §19.3.2）**：
//   - "full"（计划 / 轮次 / 报告）：选中会话时拉一次，运行中由事件触发防抖重拉；
//   - "evidence"（网页正文，可能几 MB）：**只允许在用户点击报告里的引用之后**按需拉。
// 别处不得再发起 get，否则很容易出现某个角落顺手拉了 evidence 把正文带进内存。
//
// **本 hook 绝不调用 ui-store.applyEvent**：那是常驻的 useResearchLiveSync
// （core/research/live-sync.ts）的独占职责。report_delta 是增量拼接、activity 是环形追加，
// 都不幂等，这里再扇出一次报告正文就会翻倍。这里订阅 onEvent 只为触发重拉详情——
// 重拉是幂等的，多拉一次最多浪费一次查询。
//
// 之所以抽成 hook 而不是留在组件里：整窗覆盖层与会话右栏面板要用同一套拉取时序，
// 两份实现必然漂移（其中一份忘了防抖就会把 SQLite 当轮询接口打）。
import { useCallback, useEffect, useRef, useState } from "react";
import type { EvidenceChunk, ResearchDocument } from "@cortex-work/core/research/evidence";
import { useResearchUiStore } from "@cortex-work/core/research/ui-store";
import type { ResearchBridgeLike } from "./bridge-like";
import type { DisplayRef } from "./reportDisplay";
import type { FocusedCitation } from "./ResearchSourcePanel";

/// 事件触发重拉详情的防抖窗口。
///
/// 一轮里 round / status / activity 会密集到达，每条都去 get("full") 等于把 SQLite 当轮询接口打。
/// 500ms 对人眼已经是「立刻」，对数据库则是把几十次查询压成一次。
export const DETAIL_REFRESH_DEBOUNCE_MS = 500;

/// 一份已拉回的证据（文档元信息 + 正文片段）。
export interface ResearchEvidence {
  documents: ResearchDocument[];
  chunks: EvidenceChunk[];
}

/// hook 的返回面。focus 为 null 即「引用详情未打开」。
export interface ResearchSessionDetailApi {
  /// 当前聚焦的引用（带 sessionId，避免「点完立刻切会话」时把旧引用显示到新会话上）。
  focus: (FocusedCitation & { sessionId: string }) | null;
  /// 聚焦引用所属会话的证据；null 表示还没拉回来。
  evidence: ResearchEvidence | null;
  evidenceLoading: boolean;
  evidenceError: string | null;
  /// 点击报告里的引用：聚焦先行（面板立刻出现并显示加载中），evidence 随后按需拉。
  openCitation: (ref: DisplayRef) => void;
  closeCitation: () => void;
  retryEvidence: () => void;
  /// 手动重拉一次 "full"（报告重生成等场景）。
  refresh: (sessionId: string) => void;
  /// 丢弃某个会话的 evidence 缓存（删除会话后调用）。
  /// 几 MB 正文不该为一个已经不存在的会话滞留在内存里。
  dropEvidence: (sessionId: string) => void;
}

/// 统一的错误消息提取（Error / 任意抛出物都能变成一句可展示的话）。
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// 哪些事件意味着「main 那边的详情变了，该重新拉一次」。
/// stage 不在其中：它只改阶段徽标，计划 / 轮次 / 报告都没动（reporting 由 status 事件覆盖）。
function shouldRefreshDetail(event: { type: string }): boolean {
  return event.type === "round" || event.type === "done" || event.type === "status";
}

/// 拉取并维护单条研究会话的详情。sessionId 为 null 时（未选中/无绑定）只订阅、不请求。
///
/// **stale-while-revalidate**：切到某个会话时，ui-store 里缓存的详情先渲染（没有空白闪烁），
/// 同时无条件再拉一次。曾经这里是「缓存里有 plan 就不拉了」，而 create 时就落了一份种子计划——
/// 结果真实计划、轮次与报告在整个生命周期里都不会出现，只能重启应用。
export function useResearchSessionDetail(
  bridge: ResearchBridgeLike | null,
  sessionId: string | null,
): ResearchSessionDetailApi {
  const [focus, setFocus] = useState<(FocusedCitation & { sessionId: string }) | null>(null);
  // evidence 按 sessionId 缓存在 hook 里而不是 ui-store：正文可能是几 MB，唯一消费者就是
  // 引用详情面板，放全局只会拖累每个 selector。
  const [evidenceCache, setEvidenceCache] = useState<Record<string, ResearchEvidence>>({});
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  // 在途拉取的 sessionId：连点两条 chip 不该并发拉两次同一份 evidence。
  const evidenceInflightRef = useRef<string | null>(null);
  // 详情重拉的防抖计时器。放 ref 而不是 state：它只影响副作用的时序，不该触发渲染。
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchDetail = useCallback(
    (target: string) => {
      if (!bridge) return;
      void bridge
        .get(target, "full")
        .then((view) => useResearchUiStore.getState().setDetail(target, view))
        .catch((e: unknown) =>
          useResearchUiStore.getState().setError(`加载研究详情失败：${errText(e)}`),
        );
    },
    [bridge],
  );

  // 按需拉 evidence 并写入缓存（spec §16：只允许在用户点击引用之后走到这里）。
  // 已在缓存或同会话在途时直接跳过——连点 chip / 反复开合引用详情都不该再发请求。
  const loadEvidence = useCallback(
    (target: string) => {
      if (!bridge) return;
      if (evidenceCache[target] || evidenceInflightRef.current === target) return;
      evidenceInflightRef.current = target;
      setEvidenceLoading(true);
      setEvidenceError(null);
      void bridge
        .get(target, "evidence")
        .then((view) =>
          setEvidenceCache((c) => ({
            ...c,
            [target]: { documents: view.documents ?? [], chunks: view.chunks ?? [] },
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

  // 换会话：先拉一次详情，并把聚焦的引用清掉——它只属于刚才那个会话。
  // 证据缓存按 sessionId 隔离，故保留（切回去时零请求）。
  useEffect(() => {
    setFocus(null);
    if (!sessionId) return;
    fetchDetail(sessionId);
  }, [sessionId, fetchDetail]);

  // 订阅事件，**只为触发详情重拉**（见文件头：绝不在这里调 applyEvent）。
  // 只拉当前这条会话——后台跑着的其它会话没人在看，拉回来只是白占内存。
  useEffect(() => {
    if (!bridge || !sessionId) return;
    let alive = true;
    const off = bridge.onEvent((event) => {
      if (!shouldRefreshDetail(event)) return;
      if (event.sessionId !== sessionId) return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        if (alive) fetchDetail(sessionId);
      }, DETAIL_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      alive = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      off();
    };
  }, [bridge, sessionId, fetchDetail]);

  const openCitation = useCallback(
    (ref: DisplayRef) => {
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
    [sessionId, loadEvidence],
  );

  const closeCitation = useCallback(() => setFocus(null), []);

  const retryEvidence = useCallback(() => {
    if (focus) loadEvidence(focus.sessionId);
  }, [focus, loadEvidence]);

  const dropEvidence = useCallback((target: string) => {
    setEvidenceCache((c) => {
      if (!(target in c)) return c;
      const next = { ...c };
      delete next[target];
      return next;
    });
    setFocus((f) => (f?.sessionId === target ? null : f));
  }, []);

  return {
    focus,
    evidence: focus ? evidenceCache[focus.sessionId] ?? null : null,
    // 已有缓存时不显示加载中：切回一条看过的引用应当是瞬时的。
    evidenceLoading: evidenceLoading && !(focus && evidenceCache[focus.sessionId]),
    evidenceError,
    openCitation,
    closeCitation,
    retryEvidence,
    refresh: fetchDetail,
    dropEvidence,
  };
}
