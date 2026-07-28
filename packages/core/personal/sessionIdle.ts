// 等某个会话跑完当前这一轮。
//
// 用途:UI 侧「自动替用户发一轮」的派发点(演示文稿批准提纲后的续跑,见
// design/slides/slides-turn-dispatch)。这类动作的触发时机由用户点击决定,而点击很可能落在
// agent 还在流式输出的当口 —— 直接发会在同一会话里起第二条并发 run,两轮输出交错,
// resume 会话 id 也会互相覆盖。
import { usePersonalStore } from "../store/personal";

/** 卡死兜底:超过它就放弃等待,由调用方决定是提示用户还是照发。 */
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;

/**
 * 等到 `sessionId` 没有正在跑的 run。已空闲则同步 resolve(不订阅、不进微任务队列尾)。
 * 返回 false 表示等到超时仍在跑。
 */
export function waitForSessionIdle(
  sessionId: string,
  timeoutMs = SESSION_IDLE_TIMEOUT_MS,
): Promise<boolean> {
  if (!usePersonalStore.getState().runningBySession[sessionId]) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (idle: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(idle);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // store 无 subscribeWithSelector 中间件,只能收全量 state 自行取字段(廉价:一次属性读取)。
    const unsubscribe = usePersonalStore.subscribe((state) => {
      if (!state.runningBySession[sessionId]) finish(true);
    });
  });
}
