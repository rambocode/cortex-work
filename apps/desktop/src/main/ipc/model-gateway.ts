// Pi Model Gateway IPC 域（阶段③）：全仓文本补全的唯一出口。
//
// 本文件只做「过桥」：参数搬运 + 事件按 requestId 回推。真正的寻址、取消、错误分类在
// `providers/gateway.ts`（主进程内部消费方直接调那里，不绕 IPC）。
//
// ── 事件形状契约（两侧必须同改） ──────────────────────────────────────────────
// 流式增量以**单对象** `{ requestId, event }` 经 `modelGateway:event` 推回，
// preload 的 `onModelGatewayEvent` 负责解包成两个回调参数
//（`packages/core/desktop/bridge.ts` + `src/preload/index.ts`，归 team-lead 维护）。
// 改这个形状必须两侧同步，否则渲染端会拿到「requestId 是整个对象、event 是 undefined」
// 且**不报错**——这类错配只会表现为「流式什么都收不到」，极难定位。
//
// 约束：业务模块（Reply / Research / Writing / workflow / Automation）不得再自行
// 拼接 Provider URL；TTS/ASR 的 `/v1/audio/*` 不在收编范围（静态检查见
// `providers/no-direct-endpoint.test.ts`，那里显式豁免音频路径并写明理由）。

import { ipcMain } from "electron";

import { abortGatewayRequest, runGatewayComplete, runGatewayStream, toIpcResult } from "../providers/gateway";
import { PROVIDER_IPC } from "../providers/contract";
import type { GatewayCompleteRequest, GatewayCompleteResult, GatewayStreamEvent } from "../providers/contract";

/**
 * 跨 IPC 的流式调用**必须**带 requestId。
 *
 * `GatewayCompleteRequest.requestId` 在契约里是可选的，因为主进程内部消费方
 *（openai-chat.ts → Reply / Research / Writing…）直接传 `AbortSignal`，不需要它。
 * 但 `AbortSignal` 过不了 IPC，所以对渲染端来说 requestId 是**唯一**的取消句柄，
 * 同时也是事件分发的路由键（同一窗口可能有多路并发流）。
 * 缺了它，这次调用既不可取消、增量也无处投递 —— 那不是「少个可选参数」，
 * 而是一个从一开始就不完整的请求，所以在边界上直接拒绝，不让它跑起来再静默失灵。
 */
function missingRequestId(): GatewayCompleteResult {
  return { ok: false, error: "流式调用缺少 requestId（无法取消，也无法分发增量）", errorKind: "config" };
}

/** 注册 Gateway 通道（complete / stream / abort）。 */
export function registerModelGatewayHandlers(): void {
  // 单发不要求 requestId：不带就是「发出去就等结果、不打算中途取消」，语义完整。
  ipcMain.handle(
    PROVIDER_IPC.gatewayComplete,
    async (_e, req: GatewayCompleteRequest): Promise<GatewayCompleteResult> =>
      toIpcResult(await runGatewayComplete(req)),
  );

  // 流式：增量经 `modelGateway:event` 单向推回，invoke 的返回值是终态汇总。
  ipcMain.handle(
    PROVIDER_IPC.gatewayStream,
    async (event, req: GatewayCompleteRequest): Promise<GatewayCompleteResult> => {
      const requestId = req.requestId?.trim();
      if (!requestId) return missingRequestId();

      const sender = event.sender;
      const push = (streamEvent: GatewayStreamEvent): void => {
        // 窗口已销毁时静默丢弃：请求本身仍会跑到终态并被 finally 注销，不泄漏 controller。
        if (!sender.isDestroyed()) {
          sender.send(PROVIDER_IPC.gatewayEvent, { requestId, event: streamEvent });
        }
      };
      return toIpcResult(await runGatewayStream({ ...req, requestId }, push));
    },
  );

  ipcMain.handle(PROVIDER_IPC.gatewayAbort, (_e, requestId: string) => ({
    ok: abortGatewayRequest(requestId),
  }));
}
