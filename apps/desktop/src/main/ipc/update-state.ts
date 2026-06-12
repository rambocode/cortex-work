// 应用更新状态机:把 electron-updater 的事件归约为 UpdateState（纯函数,
// 便于单测）。约束:downloaded 不被复查的 checking/not-available 回退;
// 下载失败保留 version,UI 据此提供「重试」。

import type { UpdateState } from "./types";

export type UpdaterEvent =
  | { type: "checking" }
  | { type: "available"; version: string }
  | { type: "not-available" }
  | { type: "progress"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

export function reduceUpdate(state: UpdateState, event: UpdaterEvent): UpdateState {
  switch (event.type) {
    case "checking":
      // 仅从静止/失败态进入 checking;已发现/下载中/已下载的状态不回退。
      return state.phase === "idle" || state.phase === "error" ? { phase: "checking" } : state;
    case "available":
      // 同版本已下载完成时保持 downloaded（周期复查会再次发出 available）。
      if (state.phase === "downloaded" && state.version === event.version) return state;
      return { phase: "available", version: event.version };
    case "not-available":
      return state.phase === "idle" || state.phase === "checking" ? { phase: "idle" } : state;
    case "progress":
      return { phase: "downloading", version: state.version, percent: event.percent };
    case "downloaded":
      return { phase: "downloaded", version: event.version };
    case "error":
      return { phase: "error", version: state.version, error: event.message };
  }
}
