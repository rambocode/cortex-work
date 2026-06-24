// 自动化详情「运行历史」(纯展示):区头计数 + 搜索框;每行可就地展开预览(KTD2),
// 点「查看完整」回调整页运行详情;行尾删除;客户端分页「加载更多」。
// 数据全量在内存(useAutomationRuns),此处只做过滤/揭示,不触发额外请求。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { AutomationRun } from "@cortex-work/core";
import { STATUS_CLASS, STATUS_LABEL, fmtDateTime, fmtDuration } from "./automationFormat";

// 分页每页条数:首屏 + 每次「加载更多」均按此增量。
const RUNS_PAGE_SIZE = 10;
// 行内展开预览的截断长度。
const PREVIEW_LEN = 160;

const triggerLabel = (t: AutomationRun["trigger"]) => (t === "manual" ? "手动" : "定时");

// 行的可搜索文本:时间 + 状态 + 触发类型 + 输出/错误正文,统一小写做包含匹配(对齐设计稿搜索)。
function searchText(run: AutomationRun): string {
  return [fmtDateTime(run.startedAt), STATUS_LABEL[run.status], triggerLabel(run.trigger), run.error || run.output]
    .join(" ")
    .toLowerCase();
}

function preview(run: AutomationRun): string {
  const body = (run.error || run.output || "").trim();
  if (!body) return "（无输出）";
  return body.length > PREVIEW_LEN ? `${body.slice(0, PREVIEW_LEN)}…` : body;
}

export function AutomationRunHistory({
  runs,
  onOpenRun,
  onDeleteRun,
}: {
  runs: AutomationRun[];
  onOpenRun: (id: string) => void;
  onDeleteRun: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(RUNS_PAGE_SIZE);
  const [openId, setOpenId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => (q ? runs.filter((r) => searchText(r).includes(q)) : runs), [runs, q]);
  const shown = filtered.slice(0, visibleCount);

  return (
    <div className="pw-auto-runs-section">
      <div className="pw-auto-runs-head">
        <span className="pw-auto-runs-t">运行历史</span>
        <span className="pw-auto-runs-c">{q ? `${filtered.length} / ${runs.length} 条` : `${runs.length} 次运行`}</span>
        <span className="pw-auto-search">
          <Icon.Search size={14} />
          <input
            value={query}
            placeholder="搜索日期、状态或内容…"
            onChange={(e) => {
              setQuery(e.target.value);
              setVisibleCount(RUNS_PAGE_SIZE);
            }}
          />
        </span>
      </div>

      {runs.length === 0 ? (
        <div className="pw-auto-runs-empty">暂无运行记录</div>
      ) : filtered.length === 0 ? (
        <div className="pw-auto-runs-empty">没有匹配的运行记录</div>
      ) : (
        <div className="pw-auto-runs">
          {shown.map((run) => {
            const open = openId === run.id;
            return (
              <div key={run.id} className={`pw-auto-run ${open ? "is-open" : ""}`}>
                <div className="pw-auto-run-line">
                  <button
                    className="pw-auto-run-h"
                    onClick={() => setOpenId((cur) => (cur === run.id ? null : run.id))}
                  >
                    <span className={`pw-auto-badge ${STATUS_CLASS[run.status]}`}>{STATUS_LABEL[run.status]}</span>
                    <span className="pw-auto-run-time">{fmtDateTime(run.startedAt)}</span>
                    <span className="pw-auto-run-tag">{triggerLabel(run.trigger)}</span>
                    <span className="pw-auto-run-dur">{fmtDuration(run)}</span>
                    <Icon.ChevronRight size={13} className="pw-auto-run-chev" />
                  </button>
                  <button
                    type="button"
                    className="pw-auto-run-del"
                    title="删除此记录"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteRun(run.id);
                    }}
                  >
                    <Icon.Trash size={13} />
                  </button>
                </div>
                {open ? (
                  <div className="pw-auto-run-detail">
                    <p className="pw-auto-run-preview">{preview(run)}</p>
                    <button className="pw-auto-run-open" onClick={() => onOpenRun(run.id)}>
                      查看完整
                      <Icon.Fwd size={12} />
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {filtered.length > visibleCount ? (
            <button
              type="button"
              className="pw-auto-run-more"
              onClick={() => setVisibleCount((c) => c + RUNS_PAGE_SIZE)}
            >
              加载更多（剩 {filtered.length - visibleCount} 条）
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
