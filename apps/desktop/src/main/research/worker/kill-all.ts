// Research Worker 的全局注册表与一键清理。
//
// 存在的理由：utilityProcess 的子进程**不会**随 Electron 主进程退出自动消失（尤其是
// `before-quit` 里没走完的路径、崩溃退出、开发态热重启）。留下的 Worker 会继续占着内存与
// 网络连接，下次启动还会看到一堆同名进程。因此退出钩子必须能一把杀干净。
//
// **本模块只导出，不接线**：注册进 app 的 before-quit / will-quit 钩子是上层（register.ts /
// main/index.ts）的职责，那属于另一个实现单元。
import type { WorkerTransport } from "./transport";

/// 可被清理的对象。只要求一个 kill 方法，ResearchWorkerProcess 的 transport 与测试替身都满足。
export type KillableWorker = Pick<WorkerTransport, "kill">;

/// 活跃 Worker 集合。用 Set 而不是数组：注销是按对象身份做的，Set 的删除是 O(1) 且天然去重。
const activeWorkers = new Set<KillableWorker>();

/// 注册一个 Worker，使其被退出钩子覆盖。启动成功后调用。
export function registerResearchWorker(worker: KillableWorker): void {
  activeWorkers.add(worker);
}

/// 注销（正常停止后调用），避免注册表无限增长。
export function unregisterResearchWorker(worker: KillableWorker): void {
  activeWorkers.delete(worker);
}

/// 杀掉全部已注册的 Worker，返回清理数量。
///
/// 单个 kill 抛错必须继续杀完剩下的：退出钩子只有一次机会，因为一个已死进程的报错就漏掉
/// 其余进程，正是「退出后仍有残留 Worker」的典型成因。
export function killAllResearchWorkers(): number {
  const workers = [...activeWorkers];
  activeWorkers.clear();
  for (const worker of workers) {
    try {
      worker.kill(true);
    } catch {
      // 已经退出的进程 kill 会抛，忽略。
    }
  }
  return workers.length;
}
