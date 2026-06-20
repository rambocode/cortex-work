// 应用更新状态订阅 hook：主进程是 update 状态的唯一 owner，本 hook 在渲染层维持
// 其本地镜像。先订阅 onUpdateState 推送，再用 updateGetState 补拉挂载前错过的状态，
// pushed 标志确保晚返回的补拉不覆盖已到达的推送。UpdateButton / SettingsMenu /
// UpdateDialog 共用此单一来源，避免多处各自订阅导致状态漂移。
// 这是对 main 单例状态的本地镜像（非服务端数据），故不进 React Query / Zustand。
// web 端 / 旧壳无 bridge 时返回 idle，调用方据此降级不渲染。

import { useEffect, useState } from "react";
import { useDesktopBridge } from "../provider";
import type { UpdateState } from "./types";

export function useUpdateState(): UpdateState {
  const bridge = useDesktopBridge();
  const [state, setState] = useState<UpdateState>({ phase: "idle" });

  useEffect(() => {
    if (!bridge?.updateGetState || !bridge.onUpdateState) return;
    let alive = true;
    let pushed = false;
    const off = bridge.onUpdateState((s) => {
      pushed = true;
      setState(s);
    });
    bridge
      .updateGetState()
      .then((s) => {
        // 补拉只兜底挂载前错过的状态;推送一旦到达则以推送为准。
        if (alive && !pushed) setState(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  return state;
}
