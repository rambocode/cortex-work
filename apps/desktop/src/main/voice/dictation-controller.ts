/** 系统级听写的纯会话裁决器；实际录音/转写在不抢焦的听写栏 renderer 执行。 */
export type DictationPhase = "idle" | "recording" | "transcribing";

/** 主进程下发给听写栏的状态载荷。token 把 renderer 的异步结果绑定到这一次录音。 */
export interface DictationState {
  phase: DictationPhase;
  token: number;
}

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
    // 旧 renderer 回调可能在新一轮已经开始后才抵达。它不能取消、也不能影响新一轮状态。
    if (this._phase !== "transcribing" || token !== this.token) return false;
    const accepted = this.targetPid != null && currentPid === this.targetPid;
    this.cancel();
    return accepted;
  }

  /** 当前轮是否仍在等待指定 token 的转写结果。 */
  isTranscribing(token: number): boolean {
    return this._phase === "transcribing" && token === this.token;
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
  pushState(state: DictationPhase, alwaysVisible: boolean, token: number): void;
  /** 可选的转写 LLM 纠错;实现方必须失败回退原文,绝不 reject(见 whisper/polish.ts)。 */
  polish?(text: string): Promise<string>;
}

export type DictationResult =
  | { ok: true; text: string; token: number }
  | { ok: false; token: number; reason?: string };

/**
 * 切换听写的主进程编排器。录音和转写放在浮层 renderer，主进程只负责固定目标 pid、
 * 下发阶段状态、在结果返回后复查 pid，并让 helper 私密粘贴到原应用。
 */
export class DictationController {
  private readonly session = new DictationSession();
  // holdStart 要先完成 settings/AX 的异步读取才能进入 recording；期间收到 keyUp 不可丢失。
  private holdStartPromise: Promise<void> | null = null;
  private holdEndRequested = false;
  private holdGeneration = 0;
  // 普通切换听写也会异步读取设置和 AX pid；快按第二次应作为停止记账，不能再并发启动一轮录音。
  private toggleStartPromise: Promise<void> | null = null;
  private toggleStopRequested = false;
  private toggleGeneration = 0;

  constructor(private readonly deps: DictationControllerDeps) {}

  private async alwaysVisible(): Promise<boolean> {
    return (await this.deps.settings()).dictationBarAlwaysVisible;
  }

  private pushState(state: DictationPhase, alwaysVisible: boolean): void {
    this.deps.pushState(state, alwaysVisible, this.session.currentToken);
  }

  async toggle(): Promise<void> {
    if (this.session.phase === "idle") {
      if (this.holdStartPromise) return;
      if (this.toggleStartPromise) {
        this.toggleStopRequested = true;
        return;
      }
      const generation = ++this.toggleGeneration;
      this.toggleStopRequested = false;
      const pending = this.startToggleRecording(generation);
      this.toggleStartPromise = pending;
      void pending.finally(() => {
        if (this.toggleStartPromise === pending) this.toggleStartPromise = null;
      });
      return pending;
    }
    const visible = await this.alwaysVisible();
    if (this.session.phase === "recording") {
      this.session.beginTranscribing();
      this.pushState("transcribing", visible);
      return;
    }
    // 转写尚未完成时再次切换等同取消；世代 token 会拦住随后抵达的旧结果。
    this.session.cancel();
    this.pushState("idle", visible);
  }

  /**
   * 按住键按下：异步固定目标前台 pid 后才下发 recording。若 keyUp 已先到，仍会在 recording
   * 建立后立即切到 transcribing，保证短按不会留下一条常开麦克风流。
   */
  holdStart(): Promise<void> {
    if (this.holdStartPromise || this.toggleStartPromise || this.session.phase !== "idle") return Promise.resolve();
    const generation = ++this.holdGeneration;
    this.holdEndRequested = false;
    const pending = this.startHoldRecording(generation);
    this.holdStartPromise = pending;
    void pending.finally(() => {
      if (this.holdStartPromise === pending) this.holdStartPromise = null;
    });
    return pending;
  }

  /** 按住键松开：初始化未完成时记账，已录音时只结束当前这一轮。 */
  async holdEnd(): Promise<void> {
    if (this.session.phase === "recording") {
      this.session.beginTranscribing();
      const token = this.session.currentToken;
      const visible = await this.alwaysVisible();
      // await settings 期间可能已取消或进入下一轮；旧 keyUp 不得反向推进新一轮。
      if (this.session.isTranscribing(token)) this.deps.pushState("transcribing", visible, token);
      return;
    }
    if (this.holdStartPromise) this.holdEndRequested = true;
  }

  private async startHoldRecording(generation: number): Promise<void> {
    const visible = await this.alwaysVisible();
    let snapshot: Record<string, unknown> = {};
    try {
      snapshot = await this.deps.helper.axCapture();
    } catch {
      // 与切换模式一致：AX 不可用时仍允许 renderer 完成转写，但后续写回会安全拒绝。
    }
    // cancel/其它模式启动后，旧的异步 AX 回调不得反过来新建一轮 recording。
    if (generation !== this.holdGeneration || this.session.phase !== "idle") return;

    this.session.beginRecording(readPid(snapshot));
    this.pushState("recording", visible);
    if (this.holdEndRequested && generation === this.holdGeneration) {
      this.session.beginTranscribing();
      this.pushState("transcribing", visible);
    }
  }

  /** 为切换听写建立唯一的异步录音初始化；第二次 toggle 会由 stop latch 在初始化后立即结束。 */
  private async startToggleRecording(generation: number): Promise<void> {
    const visible = await this.alwaysVisible();
    let snapshot: Record<string, unknown> = {};
    try {
      snapshot = await this.deps.helper.axCapture();
    } catch {
      // 没有辅助功能权限或 helper 暂不可用时仍可显示录音栏，但最终写回会因无 pid 被拒绝。
    }
    if (generation !== this.toggleGeneration || this.session.phase !== "idle") return;

    this.session.beginRecording(readPid(snapshot));
    this.pushState("recording", visible);
    if (this.toggleStopRequested && generation === this.toggleGeneration) {
      this.session.beginTranscribing();
      this.pushState("transcribing", visible);
    }
  }

  /** 处理听写栏的最终结果；只接受当前 transcribing token，失败、空文本和 pid 漂移均安全丢弃。 */
  async handleResult(result: DictationResult): Promise<void> {
    // token 不匹配表示它来自已取消/已完成/下一轮之前的 renderer 异步任务；绝不能改当前状态。
    if (!this.session.isTranscribing(result.token)) return;
    const visible = await this.alwaysVisible();
    // settings 也可能是异步读取；等待期间若用户开始下一轮，旧结果到此为止。
    if (!this.session.isTranscribing(result.token)) return;
    if (!result.ok || !result.text.trim()) {
      this.session.cancel();
      this.pushState("idle", visible);
      return;
    }
    // LLM 纠错放在 pid 复查**之前**:修正耗时不能夹在「校验前台 → paste」之间,
    // 否则用户切窗后口述内容仍会写进新前台应用。修正期间换轮由下方 token 守卫兜住。
    let finalText = result.text.trim();
    if (this.deps.polish) {
      finalText = (await this.deps.polish(finalText)).trim() || finalText;
      if (!this.session.isTranscribing(result.token)) return;
    }
    let now: Record<string, unknown> = {};
    try {
      now = await this.deps.helper.axCapture();
      // AX 读取期间也可能切换轮次，必须再校验，不能让旧结果取消或覆盖新状态。
      if (!this.session.isTranscribing(result.token)) return;
      const accepted = this.session.canCommit(result.token, readPid(now));
      // canCommit 已同步结束当前轮；先下发 idle，再等待可能较慢的 helper.paste，避免晚到的
      // paste Promise 在用户开始下一轮后覆盖其 renderer 状态。
      this.pushState("idle", visible);
      if (accepted) await this.deps.helper.paste(finalText);
    } catch {
      // 仅当前结果有资格到这里；若 await 期间已换轮，canCommit 的同 token 守卫会保留新状态。
      if (!this.session.isTranscribing(result.token)) return;
      this.session.cancel();
      this.pushState("idle", visible);
    }
  }

  async cancel(): Promise<void> {
    this.holdGeneration += 1;
    this.holdEndRequested = false;
    this.toggleGeneration += 1;
    this.toggleStopRequested = false;
    this.session.cancel();
    this.pushState("idle", await this.alwaysVisible());
  }
}

function readPid(snapshot: Record<string, unknown>): number | null {
  const pid = snapshot.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
