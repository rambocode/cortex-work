// pi-host worker 的进程入口（`utilityProcess.fork` 的目标）。
//
// ── 承载（KTD2，抄 `main/research/worker/transport.ts` 的实测结论，别重新摸索）──────────
// `utilityProcess` 的 **stdin 必须是 `ignore`**（electron.d.ts 明文）：配成别的值子进程直接
// 起不来，且表现为「code=0、无任何输出」——最难查的一种失败。所以协议不走 stdio，而是
// `child.postMessage(line)` ⇄ `process.parentPort.postMessage(line)`，一行 JSONL 进、一行出。
//
// 两条硬约束（与 `src/worker/research/index.ts` 同源，是这个目录的既定规则）：
//   1. **禁止 import 任何 electron API**。`parentPort` 是 Node 侧的 process 扩展，不需要
//      `require("electron")`；构建配置更把 `electron` 整个 alias 成会抛错的 stub
//      （见 `electron-stub.ts`），让「worker 不依赖 electron」成为可 grep 的事实。
//   2. **stdout 一个字节都不写**。诊断日志走 `WorkerLog` 协议消息回主进程落盘；
//      sink 就绪前的极早期日志退回 stderr（主进程收进 2KB 尾环供崩溃诊断）。
//
// ── 产物文件名 ───────────────────────────────────────────────────────────────────────
// `electron.pi-host.config.ts` 显式指定 `entryFileNames: "pi-host.js"`。
// ⚠️ `build.ssr: true` 会让 vite 忽略 `lib.fileName`（research worker 实测踩过，产物退回
// `index.js`），所以那个字段是**必须**的，不是冗余。主进程侧的入口解析按
// `pi-host.js` → `index.js` 两个名字依次找，两边都别改。

import { PiHost, attachHostLogSink, startPiHostRuntimeWarmup } from "./host";
import { cleanupExpiredToolContextDirectories } from "../../main/agents/pi-inproc/tool-context";

/**
 * `process.parentPort` 的最小形状。
 * 不从 electron 取类型（见文件头约束 1），而 @types/node 的 process 上没有这个声明。
 */
interface ParentPortLike {
  on(event: "message", listener: (message: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start?(): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (parentPort) {
  const write = (line: string): void => parentPort.postMessage(line);
  // 先接日志再建 host：建 host 的过程本身可能打日志，接晚了那几条只会落到 stderr 尾环里。
  attachHostLogSink(write);
  const host = new PiHost({ write });

  parentPort.on("message", (message) => {
    // 承载层给的是完整的一条消息。主进程发的是字符串；对象形态是防御性兼容
    //（将来若有人改成直接 postMessage 对象，这里不至于静默丢消息）。
    const data = message.data;
    host.handleLine(typeof data === "string" ? data : JSON.stringify(data));
  });
  parentPort.start?.();
  // fork 即预热：本进程常驻并承载多个会话，三包 ESM 闭包的加载在这里就开始付（一次性），
  // 首个 `open` 到达时 await 的是同一个在途 Promise（见 host.ts 的 startPiHostRuntimeWarmup）。
  startPiHostRuntimeWarmup();
  // 不读取残留正文，仅按目录 mtime 回收崩溃会话遗留的 hash 目录；清理失败不影响 worker 启动。
  void cleanupExpiredToolContextDirectories();
  process.stderr.write(`[pi-host] ready on node ${process.version}\n`);
} else {
  // 没有 parentPort = 不是被 utilityProcess.fork 起来的（例如打包校验脚本直接 require 本文件
  // 确认产物完整）。不退出也不报错，保持空闲。
  process.stderr.write("[pi-host] parentPort 不可用，处于空闲模式（未被 utilityProcess 启动）\n");
}

// ── 进程级兜底 ────────────────────────────────────────────────────────────────────────
// pi 的 agent loop、工具执行、磁盘 extension 全在这个进程里跑，漏网异常在所难免。
// 静默崩掉的代价是主进程只能报一句 `crashed`，用户看到「会话突然没了」而日志里没有原因；
// 所以这里必须把原因写出去（stderr 会进主进程的 2KB 尾环），再交给正常的崩溃路径。
process.on("uncaughtException", (err) => {
  process.stderr.write(`[pi-host] uncaughtException: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[pi-host] unhandledRejection: ${String(reason)}\n`);
});
