// 标题栏「更新」按钮:主进程检测到新版本后出现在右上角。
// 点击下载（显示进度）→ 完成后变「重启更新」→ 点击 quitAndInstall。
// 检测失败静默;下载失败保留入口提供重试。web 端 / 旧壳无 bridge 时不渲染。

import { useEffect, useState } from "react";
import { useDesktopBridge } from "@cortex-work/core";
import type { UpdateState } from "@cortex-work/core";

interface UpdateButtonUi {
  label: string;
  title: string;
  action: "download" | "install" | null;
}

// 状态 → 按钮 UI 的纯映射（可单测）。返回 null 表示不显示按钮。
export function updateButtonUi(state: UpdateState): UpdateButtonUi | null {
  switch (state.phase) {
    case "available":
      return {
        label: "更新",
        title: `发现新版本 v${state.version ?? ""},点击下载`,
        action: "download",
      };
    case "downloading":
      return {
        label: `更新 ${Math.max(0, Math.min(100, Math.round(state.percent ?? 0)))}%`,
        title: `正在下载 v${state.version ?? ""}…`,
        action: null,
      };
    case "downloaded":
      return {
        label: "重启更新",
        title: `v${state.version ?? ""} 已就绪,点击重启安装`,
        action: "install",
      };
    case "error":
      // 有 version 说明已发现新版（多为下载失败）,保留入口可重试;
      // 纯检查失败不打扰用户。
      return state.version
        ? { label: "重试更新", title: state.error ?? "更新失败", action: "download" }
        : null;
    default:
      return null;
  }
}

export function UpdateButton() {
  const bridge = useDesktopBridge();
  const [state, setState] = useState<UpdateState>({ phase: "idle" });

  useEffect(() => {
    if (!bridge?.updateGetState || !bridge.onUpdateState) return;
    // 先订阅推送;补拉只兜底挂载前错过的状态,推送一旦到达则以推送为准,
    // 避免晚返回的补拉覆盖更新的状态。
    let alive = true;
    let pushed = false;
    const off = bridge.onUpdateState((s) => {
      pushed = true;
      setState(s);
    });
    bridge
      .updateGetState()
      .then((s) => {
        if (alive && !pushed) setState(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  if (!bridge?.updateDownload || !bridge.updateInstall) return null;
  const ui = updateButtonUi(state);
  if (!ui) return null;

  return (
    <button
      className="tb-update"
      title={ui.title}
      disabled={!ui.action}
      onClick={() => {
        if (ui.action === "download") void bridge.updateDownload?.();
        else if (ui.action === "install") void bridge.updateInstall?.();
      }}
    >
      {ui.label}
    </button>
  );
}
