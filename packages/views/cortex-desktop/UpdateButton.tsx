// 标题栏「更新」按钮:主进程检测到新版本后出现在右上角。
// 点击打开更新内容弹窗（展示版本号 + release notes），下载/重启在弹窗内手动触发。
// 下载中按钮内联显示进度;检测失败静默,下载失败保留入口提供重试。
// web 端 / 旧壳无 bridge 时不渲染。

import { useState } from "react";
import { useTranslation, useDesktopBridge, useUpdateState } from "@cortex-work/core";
import type { UpdateState } from "@cortex-work/core";
import { UpdateDialog } from "./UpdateDialog";

interface UpdateButtonUi {
  label: string;
  title: string;
}

// i18n 注入点:组件传入 react-i18next 的 t;纯映射单测不传则回退到中文字面量,
// 保持原有断言（zh 为源语言,值与未改造前一致）。
type Translate = (key: string, opts?: Record<string, unknown>) => string;

const ZH_FALLBACK: Record<string, string> = {
  "updateButton.update": "更新 {{version}}",
  "updateButton.updateAvailableTitle": "发现新版本 v{{version}},点击查看更新内容",
  "updateButton.downloading": "更新 {{percent}}%",
  "updateButton.downloadingTitle": "正在下载 v{{version}}…",
  "updateButton.restartUpdate": "重启更新",
  "updateButton.downloadedTitle": "v{{version}} 已就绪,点击重启安装",
  "updateButton.retryUpdate": "重试更新",
  "updateButton.errorTitle": "更新失败",
};

function fallbackT(key: string, opts?: Record<string, unknown>): string {
  let out = ZH_FALLBACK[key] ?? key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) out = out.replace(`{{${k}}}`, String(v));
  }
  return out;
}

// 状态 → 按钮 UI 的纯映射（可单测）。返回 null 表示不显示按钮（点击统一打开弹窗）。
export function updateButtonUi(state: UpdateState, translate?: Translate): UpdateButtonUi | null {
  const t: Translate = translate ?? fallbackT;
  switch (state.phase) {
    case "available":
      return {
        label: t("updateButton.update", { version: state.version ?? "" }).trim(),
        title: t("updateButton.updateAvailableTitle", { version: state.version ?? "" }),
      };
    case "downloading":
      return {
        // 下载中按钮内联显示进度,标题栏保留一目了然的进度指示。
        label: t("updateButton.downloading", {
          percent: Math.max(0, Math.min(100, Math.round(state.percent ?? 0))),
        }),
        title: t("updateButton.downloadingTitle", { version: state.version ?? "" }),
      };
    case "downloaded":
      return {
        label: t("updateButton.restartUpdate"),
        title: t("updateButton.downloadedTitle", { version: state.version ?? "" }),
      };
    case "error":
      // 有 version 说明已发现新版（多为下载失败）,保留入口可重试;
      // 纯检查失败不打扰用户。
      return state.version
        ? { label: t("updateButton.retryUpdate"), title: state.error ?? t("updateButton.errorTitle") }
        : null;
    default:
      return null;
  }
}

export function UpdateButton() {
  const { t } = useTranslation();
  const bridge = useDesktopBridge();
  const state = useUpdateState();
  const [open, setOpen] = useState(false);

  if (!bridge?.updateDownload || !bridge.updateInstall) return null;
  const ui = updateButtonUi(state, t as Translate);
  if (!ui) return null;

  return (
    <>
      <button className="tb-update" title={ui.title} onClick={() => setOpen(true)}>
        {ui.label}
      </button>
      {open ? (
        <UpdateDialog
          state={state}
          onDownload={() => void bridge.updateDownload?.()}
          onInstall={() => void bridge.updateInstall?.()}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
