// 左栏底部「AGENT 用量」面板（参考 fanbox）:
// Codex（5h 窗口/周配额官方快照 + plan 徽章）、Claude Code（官方限额窗口）、
// token 三连（近5h/今日/本周,本地会话日志统计）。展开时每 60s 刷新。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core";
import type { AgentUsage, UsageWindow } from "@cortex-work/core";

function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + "B";
  if (n >= 1e6) return Math.round(n / 1e6) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

function fmtReset(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return (sameDay ? "" : "周" + "日一二三四五六"[d.getDay()] + " ") + hm + " 重置";
}

function ago(t: number): string {
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

function Bar({ label, win, reset }: { label: string; win: UsageWindow; reset?: string }) {
  const pct = Math.min(100, Math.max(0, Math.round(win.usedPercent)));
  return (
    <>
      <div className="pw-usage-bar-row">
        <span className="pw-usage-bar-label">{label}</span>
        <span className={`pw-usage-bar ${pct >= 85 ? "danger" : ""}`}>
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="pw-usage-pct">{pct}%</span>
      </div>
      {reset ? <div className="pw-usage-meta">{reset}</div> : null}
    </>
  );
}

export function UsagePanel() {
  const bridge = useDesktopBridge();
  // 默认收起,点击标题展开后才拉取并轮询用量。
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AgentUsage | null>(null);

  useEffect(() => {
    if (!bridge || !open) return;
    let cancelled = false;
    const refresh = () => {
      bridge
        .agentUsage()
        .then((d) => {
          if (!cancelled) setData(d);
        })
        .catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [bridge, open]);

  if (!bridge) return null;
  const claude = data?.claude;
  const codex = data?.codex;
  const official = claude?.official;

  return (
    <div className="pw-usage">
      <button className="pw-usage-h" onClick={() => setOpen((v) => !v)}>
        <Icon.Lightning size={12} />
        <span>AGENT 用量</span>
        <span className="chev" data-open={open}>
          <Icon.Chevron size={10} />
        </span>
      </button>
      {!open ? null : !data ? (
        <div className="pw-usage-empty">统计中…</div>
      ) : !claude && !codex ? (
        <div className="pw-usage-empty">没找到 Claude / Codex 的本地会话记录</div>
      ) : (
        <div className="pw-usage-body">
          {codex ? (
            <>
              <div className="pw-usage-agent">
                Codex
                {codex.planType ? <i className="pw-usage-plan">{codex.planType}</i> : null}
              </div>
              {codex.primary ? <Bar label="5h 窗口" win={codex.primary} /> : null}
              {codex.secondary ? (
                <Bar label="周配额" win={codex.secondary} reset={fmtReset(codex.secondary.resetsAt)} />
              ) : null}
              {codex.primary?.stale || codex.secondary?.stale ? (
                <div className="pw-usage-meta">窗口已重置,跑一次 Codex 才有新数</div>
              ) : (
                <div className="pw-usage-meta">快照: {ago(codex.capturedAt)}的 Codex 会话</div>
              )}
            </>
          ) : null}
          {claude ? (
            <>
              <div className="pw-usage-agent">Claude Code</div>
              {official?.fiveHour ? (
                <Bar label="5h 窗口" win={official.fiveHour} reset={fmtReset(official.fiveHour.resetsAt)} />
              ) : null}
              {official?.sevenDay ? (
                <Bar label="周配额" win={official.sevenDay} reset={fmtReset(official.sevenDay.resetsAt)} />
              ) : null}
              {claude.week.total > 0 ? (
                <>
                  <div className="pw-usage-trio">
                    <span>
                      <b>{fmtTokens(claude.last5h.total)}</b>近5h
                    </span>
                    <span>
                      <b>{fmtTokens(claude.today.total)}</b>今日
                    </span>
                    <span>
                      <b>{fmtTokens(claude.week.total)}</b>本周
                    </span>
                  </div>
                  <div className="pw-usage-meta">token 总量 · 本地会话日志统计</div>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
