// Pi Model Gateway IPC 域（阶段③）：全仓文本补全的唯一出口。
//
// ⚠️ 骨架占位 —— 待实现（实现计划 §4.1）。
// 约束：业务模块（Reply / Research / Timeline / Writing / workflow / Automation）不得再自行
// 拼接 Provider URL；TTS/ASR 的 `/v1/audio/*` 不在收编范围（静态检查须显式豁免音频路径）。

import { ipcMain } from "electron";

import { PROVIDER_IPC } from "../providers/contract";
import type { GatewayCompleteResult } from "../providers/contract";

const NOT_IMPLEMENTED = "model gateway not implemented";

/** 注册 Gateway 通道（complete / stream / abort）。 */
export function registerModelGatewayHandlers(): void {
  ipcMain.handle(
    PROVIDER_IPC.gatewayComplete,
    (): GatewayCompleteResult => ({ ok: false, error: NOT_IMPLEMENTED, errorKind: "unknown" }),
  );
  ipcMain.handle(PROVIDER_IPC.gatewayStream, () => ({ ok: false, error: NOT_IMPLEMENTED }));
  ipcMain.handle(PROVIDER_IPC.gatewayAbort, () => ({ ok: false, error: NOT_IMPLEMENTED }));
}
