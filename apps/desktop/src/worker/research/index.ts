// Research Worker 进程入口（spec §12，承载偏离见 U0 spike S3）。
//
// 承载：Electron 的 utilityProcess **不允许 pipe stdin**（electron.d.ts:20716），故 spec §12.1 的
// 「stdin/stdout JSONL」在这里落地为 `process.parentPort` 的 postMessage：一条消息 = 一行 JSONL。
// 协议消息体与 spec 逐字一致，换成真 stdio 承载时本文件之外零改动。
//
// 两条硬约束：
//   1) **本目录禁止 import 任何 electron API**——它跑在子进程里，electron 模块不可用；
//      parentPort 是 Node 侧的 process 扩展，不需要 require("electron")。
//   2) **stdout 一个字节都不写**：诊断日志一律 process.stderr.write。main 会把 stderr 收进 2KB
//      尾环用于崩溃诊断；往 stdout 写东西在将来换 stdio 承载时会直接污染协议流。
import { runDoctor } from "./methods/doctor";
import { runFetchPrepare } from "./methods/fetch-prepare";
import { runHello } from "./methods/hello";
import { runRerank } from "./methods/rerank";
import { ResearchRpcServer } from "./rpc-server";

/// Worker 自身的版本。与 desktop 的 package.json 版本解耦：协议兼容性由 protocol_version 决定，
/// 这个字段只用于日志与设置页展示。
const WORKER_VERSION = "0.1.0";

/// 优雅退出的兜底等待：收到 shutdown 后给在途请求一点收尾时间，超时即自行退出。
const DEFAULT_GRACE_MS = 3_000;

/// 诊断日志。只写 stderr（见文件头注释）。
function log(message: string): void {
  process.stderr.write(`[research-worker] ${message}\n`);
}

/// parentPort 的最小形状。不从 electron 取类型：Worker 侧不 import electron，
/// 而 @types/node 的 process 上没有 parentPort 声明。
interface ParentPortLike {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start?(): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

const server = new ResearchRpcServer({
  write: (line) => parentPort?.postMessage(line),
  log,
  handlers: {
    hello: (params) => runHello(params, { workerVersion: WORKER_VERSION, browserAvailable: false }),
    doctor: (params) => runDoctor(params),
    fetch_prepare: (params, ctx) => runFetchPrepare(params, ctx),
    rerank: (params) => runRerank(params),
  },
  onShutdown: (graceMs) => {
    // ack 已经写出，但 postMessage 是异步投递的：立刻 exit 会让 main 收不到那条 ack。
    // 因此排一个定时器，给消息投递与在途请求收尾留出时间。
    const delay = Math.max(0, Math.min(graceMs ?? DEFAULT_GRACE_MS, DEFAULT_GRACE_MS));
    setTimeout(() => process.exit(0), delay).unref();
  },
});

if (parentPort) {
  parentPort.on("message", (message) => {
    // 承载层给的是完整的一条消息；补上换行交给行缓冲，复用同一套切分与容错逻辑。
    const data = message.data;
    server.feed(typeof data === "string" ? `${data}\n` : `${JSON.stringify(data)}\n`);
  });
  parentPort.start?.();
  log(`worker ${WORKER_VERSION} ready on node ${process.version}`);
} else {
  // 没有 parentPort 说明不是被 utilityProcess.fork 起来的（例如被直接 node 执行）。
  // 不退出、也不报错：打包校验脚本会直接 require 本文件来确认产物完整。
  log("parentPort 不可用，Worker 处于空闲模式（未被 utilityProcess 启动）");
}

// 进程级兜底：任何漏网异常都转成在途请求的 internal_error 响应，而不是让进程静默崩掉。
// 崩掉的代价是 main 侧 pending 全部等到 30 秒超时，用户看到的是「卡住」而非「出错」。
process.on("uncaughtException", (err) => {
  log(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  server.failAllPending("internal_error", `worker uncaughtException: ${String(err)}`);
});

process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection: ${String(reason)}`);
  server.failAllPending("internal_error", `worker unhandledRejection: ${String(reason)}`);
});
