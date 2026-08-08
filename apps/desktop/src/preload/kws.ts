// 唤醒词(KWS)隐藏窗口的 preload 窄桥。该 renderer 只做端侧推理:能读唤醒词配置、上报
// 命中与运行状态、接收挂起/恢复指令——不持有 personal 桥、无文件/网络能力。音频永不过桥:
// 采集与推理都留在窗口内,kws:hit 只携带一个概率分数(隐私边界)。

import { ipcRenderer, type IpcRendererEvent } from "electron";
import type { WakeWordSettings } from "../main/ipc/types";

export type KwsRunState = "starting" | "running" | "suspended" | "degraded";

export const kws = {
  getConfig: (): Promise<WakeWordSettings> => ipcRenderer.invoke("kws:get-config"),
  reportHit: (score: number): void => ipcRenderer.send("kws:hit", score),
  reportState: (state: KwsRunState): void => ipcRenderer.send("kws:state", state),
  onControl: (cb: (action: "suspend" | "resume") => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, action: unknown): void => {
      if (action === "suspend" || action === "resume") cb(action);
    };
    ipcRenderer.on("kws:control", listener);
    return () => ipcRenderer.removeListener("kws:control", listener);
  },
  onConfigChanged: (cb: (settings: WakeWordSettings) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, settings: WakeWordSettings): void => cb(settings);
    ipcRenderer.on("kws:config-changed", listener);
    return () => ipcRenderer.removeListener("kws:config-changed", listener);
  },
};
