// 按 session 串行化文件写入,避免同一会话的 chat:save / chat:delete / image:save 交错。
// 从 chat.ts 抽出的共享模块 —— 跨文件复用必须是导出的单一队列,各 handler 不能各持私有 Map
//（否则 image:save 与 chat:delete 无法互斥,删除会话时在途落盘会留孤儿)。

// settle 后即从 Map 移除,避免出现过的 sessionId 永久驻留(防泄漏)。
const queues = new Map<string, Promise<unknown>>();

// 把 fn 排到该 session 的队尾;无论上一笔成功与否都接着跑(fn 不依赖上一笔返回值)。
// 返回 fn 自身的结果 Promise(image:save 需要拿回落盘路径;失败原样抛给调用方)。
export function enqueue<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // 队列排序与清理只看「是否 settle」,忽略 fn 的拒绝(拒绝交给 run 的调用方处理)。
  const tracked: Promise<unknown> = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(sessionId, tracked);
  void tracked.finally(() => {
    if (queues.get(sessionId) === tracked) queues.delete(sessionId);
  });
  return run;
}
