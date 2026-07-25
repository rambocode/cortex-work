// 测试专用的手写 WorkerTransport 替身（零 mock 框架）。
//
// 放在源码目录而不是某个 test 文件里，是因为 rpc-client 与 process-manager 两套测试都要用它；
// 它不被任何生产代码引用（生产入口是 forkUtilityWorkerTransport），main 打包时也不会被带上
// ——electron-vite 只打包从 main/index.ts 可达的模块。
import type { WorkerTransport } from "./transport";

/// 可手动驱动的假 transport：记录写出的行，并能真实触发 line / exit / error 回调。
export class FakeWorkerTransport implements WorkerTransport {
  readonly writes: string[] = [];
  killed = 0;
  forceKilled = 0;
  private lineCb: (line: string) => void = () => {};
  private exitCb: (code: number | null, stderrTail?: string) => void = () => {};
  private errorCb: (err: Error) => void = () => {};

  writeLine(line: string): void {
    this.writes.push(line);
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  onExit(cb: (code: number | null, stderrTail?: string) => void): void {
    this.exitCb = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCb = cb;
  }

  kill(force?: boolean): void {
    this.killed += 1;
    if (force) this.forceKilled += 1;
  }

  // ── 测试驱动接口 ──────────────────────────────────────────────
  emitLine(line: string): void {
    this.lineCb(line);
  }

  emitExit(code: number | null, stderrTail?: string): void {
    this.exitCb(code, stderrTail);
  }

  emitError(err: Error): void {
    this.errorCb(err);
  }

  /// 取最后一条写出的行并解析成对象。
  lastMessage(): Record<string, unknown> {
    return JSON.parse(this.writes[this.writes.length - 1] ?? "{}") as Record<string, unknown>;
  }
}
