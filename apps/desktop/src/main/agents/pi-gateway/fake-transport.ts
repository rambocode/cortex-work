// 测试专用的手写 `PiGatewayTransport` 替身（零 mock 框架）。
//
// 放在源码目录而不是某个 test 文件里，是因为 client 与将来的接线层（U4）两侧测试都要用它；
// 它不被任何生产代码引用（生产入口是 `forkPiHostTransport`），main 打包时也不会被带上
// ——electron-vite 只打包从 `main/index.ts` 可达的模块。
import { decodeLine, type HostMessage } from "./protocol";
import type { PiGatewayTransport } from "./transport";

/** 可手动驱动的假承载：记录写出的行，并能真实触发 line / exit / error 回调。 */
export class FakePiGatewayTransport implements PiGatewayTransport {
  readonly writes: string[] = [];
  killed = 0;
  forceKilled = 0;
  /** 置真后 writeLine 抛错，用来覆盖「管道已断」这条竞态路径。 */
  writeThrows = false;

  private lineCb: (line: string) => void = () => {};
  private exitCb: (code: number | null, stderrTail?: string) => void = () => {};
  private errorCb: (err: Error) => void = () => {};

  writeLine(line: string): void {
    if (this.writeThrows) throw new Error("EPIPE");
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

  // ── 测试驱动接口 ──────────────────────────────────────────────────────────────────

  /** 模拟 worker 发来一条消息（对象会被序列化成协议行）。 */
  emit(msg: unknown): void {
    this.lineCb(typeof msg === "string" ? msg : JSON.stringify(msg));
  }

  emitExit(code: number | null, stderrTail?: string): void {
    this.exitCb(code, stderrTail);
  }

  emitError(err: Error): void {
    this.errorCb(err);
  }

  /** 解析出写给 worker 的全部消息。 */
  sent(): HostMessage[] {
    return this.writes.map((line) => decodeLine<HostMessage>(line)).filter((m): m is HostMessage => m !== null);
  }

  /** 取最后一条写给 worker 的消息。 */
  last(): HostMessage | undefined {
    return this.sent().at(-1);
  }

  /** 取第一条 `kind` 匹配的消息（配合类型收窄断言用）。 */
  firstOf<K extends HostMessage["kind"]>(kind: K): Extract<HostMessage, { kind: K }> | undefined {
    return this.sent().find((m): m is Extract<HostMessage, { kind: K }> => m.kind === kind);
  }

  /**
   * 对最后一条待应答消息回一条成功 reply。
   * 会话侧按 id 关联，故这里必须原样带回那条消息的 id——写错 id 的表现是「命令永远超时」。
   */
  replyOk(result?: unknown): void {
    const id = this.lastPendingId();
    this.emit({ id, kind: "reply", ok: true, ...(result === undefined ? {} : { result }) });
  }

  /** 对最后一条待应答消息回一条失败 reply（worker 侧转发层失败）。 */
  replyErr(error: string): void {
    this.emit({ id: this.lastPendingId(), kind: "reply", ok: false, error });
  }

  private lastPendingId(): string {
    const msg = [...this.sent()].reverse().find((m) => m.kind === "open" || m.kind === "call");
    if (!msg) throw new Error("测试用例里还没有任何待应答消息");
    return msg.id;
  }
}
