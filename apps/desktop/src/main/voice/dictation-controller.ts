/** 系统级听写的纯会话裁决器；实际录音/转写在不抢焦的听写栏 renderer 执行。 */
export type DictationPhase = "idle" | "recording" | "transcribing";

/**
 * 把异步转写的生命周期与前台应用校验收口，避免迟到结果或用户切换应用后仍写入剪贴板。
 * 副作用（窗口命令、helper.paste）由后续主进程控制器根据这里的裁决执行。
 */
export class DictationSession {
  private _phase: DictationPhase = "idle";
  private token = 0;
  private targetPid: number | null = null;

  get phase(): DictationPhase {
    return this._phase;
  }

  /** 当前录音/转写轮次的世代标识，供同一轮的 renderer 结果做迟到校验。 */
  get currentToken(): number {
    return this.token;
  }

  /** 开始录音会使上一轮的异步结果失效，并固定本轮的目标前台进程。 */
  beginRecording(targetPid: number | null): number {
    this.token += 1;
    this.targetPid = targetPid;
    this._phase = "recording";
    return this.token;
  }

  /** 停止录音后等待 renderer 返回转写文本；非法时序安全退回 idle。 */
  beginTranscribing(): number {
    if (this._phase !== "recording") return this.cancel();
    this._phase = "transcribing";
    return this.token;
  }

  /**
   * 判定某个异步转写结果能否粘贴。无目标 pid 也一律拒绝，宁可丢结果也不能泄露到未知 app。
   * 无论接受或拒绝，当前轮已经结束，随即复位以允许下一次听写。
   */
  canCommit(token: number, currentPid: number | null): boolean {
    const accepted =
      this._phase === "transcribing" && token === this.token && this.targetPid != null && currentPid === this.targetPid;
    this.cancel();
    return accepted;
  }

  /** 取消录音或作废未完成转写；递增 token 使迟到回调不再可写回。 */
  cancel(): number {
    this.token += 1;
    this.targetPid = null;
    this._phase = "idle";
    return this.token;
  }
}

export interface DictationControllerDeps {
  /** Cortex_Helper 的 AX pid 快照和私密 stdin 粘贴能力。 */
  helper: {
    axCapture(): Promise<Record<string, unknown>>;
    paste(text: string): Promise<Record<string, unknown>>;
  };
  /** 每次操作读取最新设置，避免常驻 controller 持有过期快照。 */
  settings(): { dictationBarAlwaysVisible: boolean } | Promise<{ dictationBarAlwaysVisible: boolean }>;
  /** 仅主进程能把状态下发给不抢焦的听写栏窗口。 */
  pushState(state: DictationPhase, alwaysVisible: boolean): void;
}

export type DictationResult = { ok: true; text: string } | { ok: false; reason?: string };

/**
 * 切换听写的主进程编排器。录音和转写放在浮层 renderer，主进程只负责固定目标 pid、
 * 下发阶段状态、在结果返回后复查 pid，并让 helper 私密粘贴到原应用。
 */
export class DictationController {
  private readonly session = new DictationSession();

  constructor(private readonly deps: DictationControllerDeps) {}

  private async alwaysVisible(): Promise<boolean> {
    return (await this.deps.settings()).dictationBarAlwaysVisible;
  }

  async toggle(): Promise<void> {
    const visible = await this.alwaysVisible();
    if (this.session.phase === "idle") {
      let snapshot: Record<string, unknown> = {};
      try {
        snapshot = await this.deps.helper.axCapture();
      } catch {
        // 没有辅助功能权限或 helper 暂不可用时仍可显示录音栏，但最终写回会因无 pid 被拒绝。
        // 这样用户可见地完成一次转写，不会把异常冒泡到 globalShortcut 回调导致主进程报错。
      }
      this.session.beginRecording(readPid(snapshot));
      this.deps.pushState("recording", visible);
      return;
    }
    if (this.session.phase === "recording") {
      this.session.beginTranscribing();
      this.deps.pushState("transcribing", visible);
      return;
    }
    // 转写尚未完成时再次切换等同取消；世代 token 会拦住随后抵达的旧结果。
    this.session.cancel();
    this.deps.pushState("idle", visible);
  }

  /** 处理听写栏的最终结果；失败、空文本和 pid 漂移均安全丢弃。 */
  async handleResult(result: DictationResult): Promise<void> {
    const visible = await this.alwaysVisible();
    if (!result.ok || !result.text.trim()) {
      this.session.cancel();
      this.deps.pushState("idle", visible);
      return;
    }
    const token = this.session.currentToken;
    let now: Record<string, unknown> = {};
    try {
      now = await this.deps.helper.axCapture();
      if (this.session.canCommit(token, readPid(now))) await this.deps.helper.paste(result.text.trim());
      else this.session.cancel();
    } catch {
      this.session.cancel();
    }
    this.deps.pushState("idle", visible);
  }

  async cancel(): Promise<void> {
    this.session.cancel();
    this.deps.pushState("idle", await this.alwaysVisible());
  }
}

function readPid(snapshot: Record<string, unknown>): number | null {
  const pid = snapshot.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
