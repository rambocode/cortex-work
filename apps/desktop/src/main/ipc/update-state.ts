// 应用更新状态机:把 electron-updater 的事件归约为 UpdateState（纯函数,
// 便于单测）。约束:downloaded 不被复查的 checking/not-available 回退;
// 下载失败保留 version,UI 据此提供「重试」;available/downloaded 携带的
// releaseNotes 在 downloading/error 阶段保留,使更新内容弹窗全程可展示。

import type { UpdateState } from "./types";

export type UpdaterEvent =
  | { type: "checking" }
  | { type: "available"; version: string; releaseNotes?: string }
  | { type: "not-available" }
  | { type: "progress"; percent: number; transferred?: number; total?: number; bytesPerSecond?: number }
  | { type: "downloaded"; version: string; releaseNotes?: string }
  | { type: "error"; message: string };

// electron-updater 的 info.releaseNotes 形如 string | ReleaseNoteInfo[] | null。
// 归一化为 string | undefined:本项目 fullChangelog=false 且由发布侧以字符串
// 写入清单,数组分支无现实消费者,仅作类型完备兜底(此分支不可达)。
export function normalizeReleaseNotes(
  notes: string | Array<{ note?: string | null }> | null | undefined,
): string | undefined {
  if (notes == null) return undefined;
  if (typeof notes === "string") {
    const trimmed = notes.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const joined = notes
    .map((n) => n.note ?? "")
    .join("\n\n")
    .trim();
  return joined.length > 0 ? joined : undefined;
}

export function reduceUpdate(state: UpdateState, event: UpdaterEvent): UpdateState {
  switch (event.type) {
    case "checking":
      // 仅从静止/失败态进入 checking;已发现/下载中/已下载的状态不回退。
      return state.phase === "idle" || state.phase === "error" ? { phase: "checking" } : state;
    case "available":
      // 同版本已下载完成时保持 downloaded（周期复查会再次发出 available）。
      if (state.phase === "downloaded" && state.version === event.version) return state;
      return { phase: "available", version: event.version, releaseNotes: event.releaseNotes };
    case "not-available":
      return state.phase === "idle" || state.phase === "checking" ? { phase: "idle" } : state;
    case "progress":
      // 下载中保留已发现的 version 与 releaseNotes,弹窗在下载过程中仍能展示更新内容。
      // 字节字段直接透传:差量下载时 total 即差量大小,UI 据此可视化「本次实际下多少」。
      return {
        phase: "downloading",
        version: state.version,
        percent: event.percent,
        transferred: event.transferred,
        total: event.total,
        bytesPerSecond: event.bytesPerSecond,
        releaseNotes: state.releaseNotes,
      };
    case "downloaded":
      // downloaded 事件自带 releaseNotes;为稳妥,缺省时回退到此前保留的值。
      return { phase: "downloaded", version: event.version, releaseNotes: event.releaseNotes ?? state.releaseNotes };
    case "error":
      // 失败保留 version 与 releaseNotes,UI 据此提供「重试下载」并仍展示更新内容。
      return { phase: "error", version: state.version, error: event.message, releaseNotes: state.releaseNotes };
  }
}
