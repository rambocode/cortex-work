// javascript_repl 的渲染端执行宿主 hook。挂载在 PersonalWorkspace(工作区常驻组件,会话页
// 会随视图切换卸载,执行期间订阅不能断)。
//
// 【与主进程侧的对接契约 · 必读】
// - 订阅 bridge.onPiUiRequest,只认 method:"jsrepl"——它**绝不能**流进 PiToolConfirmDialog
//   弹窗流(usePersonalPiUi 只入队 confirm/askquestion,jsrepl 在那里被自然忽略,由本 hook 独立
//   订阅消费;preload 的 ipcRenderer.on 支持多监听器)。
// - code 视为不可信:只进无 allow-same-origin 的沙箱 iframe(replRuntime)。
// - 回写 piUiResponse {value: JSON({ok, output})};会话已亡时回写会 reject,必须 catch(worker
//   崩溃后主进程已摘除会话,迟到回写被幂等丢弃)。
// - 渲染端执行超时 30s(第一道闸);worker 侧 dialog 的 120s 是失联兜底,二者语义不同勿合并。

import { useEffect, useRef } from "react";
import type { DesktopBridge } from "@cortex-work/core";

import { runReplExec, type ReplExecHandle, type ReplExecResult } from "./replRuntime";

/** 渲染端单次执行超时。 */
export const REPL_EXEC_TIMEOUT_MS = 30_000;
/** 并发上限:超出排队(FIFO)。沙箱 iframe 不便宜,防模型连环调用打爆渲染进程。 */
export const REPL_MAX_CONCURRENT = 4;

/** 可注入的执行器(测试用 stub 替换真 iframe)。 */
export type ReplExecutor = (code: string, execId: string, timeoutMs: number) => ReplExecHandle;

interface QueueItem {
  uiSessionId: string;
  id: string;
  code: string;
}

/** 订阅 jsrepl 请求并调度执行。bridge 缺 onPiUiRequest(web 壳)时整体空转。 */
export function useReplExecHost(bridge: DesktopBridge | null, executor: ReplExecutor = runReplExec): void {
  // 执行簿记放 ref:订阅 effect 只随 bridge 重挂,不因执行状态变化反复解绑。
  const stateRef = useRef<{ inflight: Map<string, ReplExecHandle>; queue: QueueItem[] }>({
    inflight: new Map(),
    queue: [],
  });

  useEffect(() => {
    if (!bridge?.onPiUiRequest) return;
    const state = stateRef.current;

    const respond = (uiSessionId: string, id: string, result: ReplExecResult): void => {
      // 会话已亡(worker 崩溃/已关闭)时 reject——迟到回写被主进程幂等丢弃,静默即可。
      void bridge.piUiResponse?.(uiSessionId, id, { value: JSON.stringify(result) }).catch(() => undefined);
    };

    const pump = (): void => {
      while (state.inflight.size < REPL_MAX_CONCURRENT && state.queue.length) {
        const item = state.queue.shift()!;
        const handle = executor(item.code, item.id, REPL_EXEC_TIMEOUT_MS);
        state.inflight.set(item.id, handle);
        void handle.promise.then((result) => {
          state.inflight.delete(item.id);
          respond(item.uiSessionId, item.id, result);
          pump(); // 让出的并发位立即补队列
        });
      }
    };

    const off = bridge.onPiUiRequest((uiSessionId, request) => {
      if (request.method !== "jsrepl") return;
      state.queue.push({ uiSessionId, id: request.id, code: request.envelope.code });
      pump();
    });

    return () => {
      off();
      // 卸载:中止全部在途执行(abort 内部以 ok:false 结算 promise,进而回写「执行已中止」),
      // 清空队列——排队项未开始执行,直接回写中止,避免 pi 侧干等 120s 超时。
      for (const h of state.inflight.values()) h.abort();
      state.inflight.clear();
      for (const item of state.queue.splice(0)) {
        respond(item.uiSessionId, item.id, { ok: false, output: "执行宿主已卸载" });
      }
    };
  }, [bridge, executor]);
}
