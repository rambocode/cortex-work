// 研究记忆候选的审阅卡（U10 / KTD10）。
//
// **这个 UI 就是 KTD10 那道闸的人机界面**：研究结论只有在用户在这里逐条点「批准」之后，
// 才会真正写进长期记忆。所以它必须做到三件事：
//   1. 每条都能看到**它到底会往记忆里写什么**（原文照展，不做省略号截断后就没法核对）；
//   2. 每条都能看到**有几条证据支撑**（一条孤证与三条互证的可信度差别很大）；
//   3. 已批准的条目能**撤销**——批错了要有退路，否则用户会倾向于一条都不批。
//
// 文案硬编码 zh-Hans（个人工作区惯例，同 ResearchSettingsSection）。
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useDesktopBridge } from "@cortex-work/core";
import type {
  ResearchMemoryCandidateView,
  ResearchMemoryReviewAction,
} from "@cortex-work/core/desktop/research-bridge";

import { SettingCard } from "./settingsControls";

/// 状态 → 中文标签。撤销与拒绝分开显示：前者是「批过又收回」，后者是「从没批过」，
/// 用户回看时这两件事的含义不同。
const STATUS_LABEL: Record<string, string> = {
  pending: "待批准",
  approved: "已写入记忆",
  rejected: "已拒绝",
  revoked: "已撤销",
  stale: "来源已过期",
};

export function ResearchMemoryCandidates(): ReactElement | null {
  const bridge = useDesktopBridge();
  const research = bridge?.research;
  const [items, setItems] = useState<ResearchMemoryCandidateView[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    const list = research?.listMemoryCandidates;
    if (!list) return;
    void list
      .call(research)
      .then(setItems)
      .catch((e: unknown) => setError(`读取候选失败：${e instanceof Error ? e.message : String(e)}`));
  }, [research]);

  useEffect(reload, [reload]);

  const review = useCallback(
    (candidateId: string, action: ResearchMemoryReviewAction) => {
      const fn = research?.reviewMemoryCandidate;
      if (!fn) return;
      setBusyId(candidateId);
      setError(null);
      void fn
        .call(research, candidateId, action)
        // 重拉而不是本地改状态：真源在 main（SQLite + 记忆文件），
        // 本地猜测会在写盘失败时显示成功。
        .then(reload)
        .catch((e: unknown) => setError(`操作失败：${e instanceof Error ? e.message : String(e)}`))
        .finally(() => setBusyId(null));
    },
    [research, reload],
  );

  // 桥不支持（Web 端 / 旧壳）时整卡不渲染，而不是显示一个空卡。
  if (typeof research?.listMemoryCandidates !== "function") return null;

  const pending = items?.filter((item) => item.candidate.status === "pending") ?? [];
  const approved = items?.filter((item) => item.candidate.status === "approved") ?? [];

  return (
    <SettingCard title="研究记忆候选">
      <div className="pw-srow-desc">
        深度研究完成后，从报告里**被引用过的结论**归纳成候选。只有你在这里点「批准」的条目
        才会写进长期记忆；做梦整理不会改动它们。
      </div>

      {error ? <div className="pw-res-error">{error}</div> : null}

      {items === null ? (
        <div className="pw-srow-desc">正在读取…</div>
      ) : pending.length === 0 && approved.length === 0 ? (
        <div className="pw-srow-desc">
          还没有候选。开启「记忆沉淀」后，下一次深度研究完成时会在这里出现。
        </div>
      ) : null}

      {pending.map((item) => (
        <div key={item.candidate.candidateId} className="pw-mem-cand">
          <div className="pw-mem-cand-text">{item.candidate.text}</div>
          <div className="pw-srow-desc">
            {item.knowledge ? `来自研究：${item.knowledge.subject} · ` : ""}
            {item.candidate.citationChunkIds.length} 条证据支撑
            {item.knowledge?.confidence === "high" ? " · 多来源互证" : ""}
          </div>
          <div className="pw-srow-c pw-srow-c-end">
            <button
              type="button"
              className="pw-btn-sm"
              disabled={busyId !== null}
              onClick={() => review(item.candidate.candidateId, "reject")}
            >
              拒绝
            </button>
            <button
              type="button"
              className="pw-btn-sm"
              disabled={busyId !== null}
              onClick={() => review(item.candidate.candidateId, "approve")}
            >
              {busyId === item.candidate.candidateId ? "处理中…" : "批准写入记忆"}
            </button>
          </div>
        </div>
      ))}

      {approved.length > 0 ? (
        <div className="pw-srow-desc">已写入记忆（可撤销）：</div>
      ) : null}
      {approved.map((item) => (
        <div key={item.candidate.candidateId} className="pw-mem-cand">
          <div className="pw-mem-cand-text">{item.candidate.text}</div>
          <div className="pw-srow-desc">
            {STATUS_LABEL[item.candidate.status] ?? item.candidate.status}
            {item.candidate.approvedAt ? ` · ${item.candidate.approvedAt.slice(0, 10)}` : ""}
          </div>
          <div className="pw-srow-c pw-srow-c-end">
            <button
              type="button"
              className="pw-btn-sm"
              disabled={busyId !== null}
              onClick={() => review(item.candidate.candidateId, "revoke")}
            >
              {busyId === item.candidate.candidateId ? "处理中…" : "撤销"}
            </button>
          </div>
        </div>
      ))}
    </SettingCard>
  );
}
