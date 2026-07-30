// 更新内容弹窗：点击标题栏「更新」按钮（或设置卡片「查看更新内容」）后弹出。
// 展示新版本号 + markdown 更新内容（release notes），底部按 phase 切换下载/进度/重启/重试。
// 复用 .pw-dlg 模态外壳（照搬 AutomationDialog）+ MarkdownView 渲染 notes。
// state 由调用方下传（经 useUpdateState 持有），弹窗自身不订阅；footer 纯由实时
// state.phase 渲染（无打开时快照），故下载中途完成时弹窗实时切到「重启更新」。
// 统一关闭语义：关闭按钮 / Esc / 遮罩点击 → onClose；下载由 main 持有，关闭不取消。

import { useEffect } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core";
import type { UpdateState } from "@cortex-work/core";
import { MarkdownView } from "./personal/markdown/MarkdownView";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

function clampPercent(p: number | undefined): number {
  return Math.max(0, Math.min(100, Math.round(p ?? 0)));
}

// 字节数格式化:B/KB/MB/GB 自适应,1000 进制(与 macOS Finder 口径一致),1 位小数。
// 导出供单测;字节单位文案跨语言通用,不走 i18n。
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let v = n;
  for (const unit of units) {
    v /= 1000;
    if (v < 1000 || unit === "GB") return `${v.toFixed(1)} ${unit}`;
  }
  return `${v.toFixed(1)} GB`;
}

// 下载明细行:"12.3 MB / 54.9 MB (1.2 MB/s)"。差量下载时 total 即差量字节数,
// 用户由此能直观看到「本次只需下载差量而非整包」。缺 transferred/total(旧主
// 进程未透传字节字段)时返回 null,UI 降级只显示百分比。
export function formatProgressDetail(state: UpdateState): string | null {
  if (state.transferred == null || state.total == null) return null;
  const base = `${formatBytes(state.transferred)} / ${formatBytes(state.total)}`;
  return state.bytesPerSecond != null && state.bytesPerSecond > 0
    ? `${base} (${formatBytes(state.bytesPerSecond)}/s)`
    : base;
}

// 底部操作区：按 phase 决定主操作 + 次操作（关闭/稍后）。
function DialogFooter({
  state,
  t,
  onDownload,
  onInstall,
  onClose,
}: {
  state: UpdateState;
  t: Translate;
  onDownload: () => void;
  onInstall: () => void;
  onClose: () => void;
}) {
  if (state.phase === "downloading") {
    const pct = clampPercent(state.percent);
    const detail = formatProgressDetail(state);
    return (
      <div className="pw-upd-foot">
        <div className="pw-upd-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="pw-upd-progress-bar" style={{ width: `${pct}%` }} />
        </div>
        {detail ? <div className="pw-upd-bytes">{detail}</div> : null}
        <button className="pw-tl-gen pw-btn-primary" disabled>
          {t("updateDialog.downloading", { percent: pct })}
        </button>
        <button className="pw-tl-gen" onClick={onClose}>
          {t("updateDialog.close")}
        </button>
      </div>
    );
  }

  if (state.phase === "downloaded") {
    return (
      <div className="pw-upd-foot">
        <button className="pw-tl-gen pw-btn-primary" onClick={onInstall}>
          <Icon.Retry size={12} />
          {t("updateDialog.restart")}
        </button>
        <button className="pw-tl-gen" onClick={onClose}>
          {t("updateDialog.later")}
        </button>
      </div>
    );
  }

  // error（调用方仅在有 version 时打开弹窗，等同「下载失败」）：展示错误文案 + 重试下载。
  const isError = state.phase === "error";
  return (
    <div className="pw-upd-foot">
      {isError && state.error ? <div className="pw-upd-err">{t("updateDialog.errorPrefix") + state.error}</div> : null}
      <button className="pw-tl-gen pw-btn-primary" onClick={onDownload}>
        <Icon.Retry size={12} />
        {isError ? t("updateDialog.retry") : t("updateDialog.download")}
      </button>
      <button className="pw-tl-gen" onClick={onClose}>
        {t("updateDialog.later")}
      </button>
    </div>
  );
}

export function UpdateDialog({
  state,
  onDownload,
  onInstall,
  onClose,
}: {
  state: UpdateState;
  onDownload: () => void;
  onInstall: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const translate = t as Translate;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const version = state.version ?? "";
  const notes = state.releaseNotes ?? translate("updateDialog.noNotes");

  return (
    <div className="pw-dlg-overlay" onClick={onClose}>
      <div
        className="pw-dlg pw-upd-dlg"
        role="dialog"
        aria-label={translate("updateDialog.title", { version })}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="pw-dlg-x" title={translate("updateDialog.close")} onClick={onClose}>
          <Icon.X size={15} />
        </button>
        <div className="pw-upd-dlg-h">{translate("updateDialog.title", { version })}</div>
        {/* 中部正文独立滚动，标题与底部按钮固定，长 notes 不会顶飞操作。 */}
        <div className="pw-upd-notes">
          <div className="pw-todo-md">
            <MarkdownView content={notes} />
          </div>
        </div>
        <DialogFooter state={state} t={translate} onDownload={onDownload} onInstall={onInstall} onClose={onClose} />
      </div>
    </div>
  );
}
