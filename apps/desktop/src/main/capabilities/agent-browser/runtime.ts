export type AgentBrowserRuntimeState = "disabled" | "checking" | "downloading" | "ready" | "error";

export interface AgentBrowserRuntimeStatus {
  state: AgentBrowserRuntimeState;
  message: string;
}

export type AgentBrowserCommandRunner = (
  binary: string,
  args: string[],
  signal: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;

export function parseAgentBrowserDoctorOutput(output: string): { ready: boolean; message: string } {
  try {
    const payload = JSON.parse(output) as { checks?: Array<{ id?: string; status?: string; message?: string }> };
    const chrome = payload.checks?.find((check) => check.id === "chrome.installed");
    return {
      ready: chrome?.status === "pass",
      message: chrome?.message ?? "未找到 Chrome 安装状态",
    };
  } catch {
    return { ready: false, message: "无法解析 agent-browser doctor 输出" };
  }
}

export class AgentBrowserRuntime {
  private status: AgentBrowserRuntimeStatus = { state: "checking", message: "正在检查 Chrome" };
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly resolveBinary: () => string | null,
    private readonly run: AgentBrowserCommandRunner,
    private readonly onStatus?: (status: AgentBrowserRuntimeStatus) => void,
  ) {}

  getStatus(): AgentBrowserRuntimeStatus {
    return this.status;
  }

  private update(status: AgentBrowserRuntimeStatus): void {
    this.status = status;
    this.onStatus?.(status);
  }

  async ensure(enabled: boolean, force = false): Promise<void> {
    if (!enabled) {
      this.controller?.abort();
      this.active = null;
      this.update({ state: "disabled", message: "已关闭" });
      return;
    }
    if (this.active) return this.active;
    if (!force && this.status.state === "ready") return;

    const binary = this.resolveBinary();
    if (!binary) {
      this.update({ state: "error", message: "当前平台缺少内置 agent-browser" });
      return;
    }

    const controller = new AbortController();
    this.controller = controller;
    this.active = this.ensureInternal(binary, controller.signal).finally(() => {
      if (this.controller === controller) {
        this.controller = null;
        this.active = null;
      }
    });
    return this.active;
  }

  private async ensureInternal(binary: string, signal: AbortSignal): Promise<void> {
    try {
      this.update({ state: "checking", message: "正在检查 Chrome" });
      const first = await this.run(binary, ["doctor", "--offline", "--quick", "--json"], signal);
      const diagnosis = parseAgentBrowserDoctorOutput(first.stdout);
      if (diagnosis.ready) {
        this.update({ state: "ready", message: diagnosis.message });
        return;
      }

      this.update({ state: "downloading", message: "正在后台下载 Chrome for Testing" });
      await this.run(binary, ["install"], signal);
      const verified = parseAgentBrowserDoctorOutput(
        (await this.run(binary, ["doctor", "--offline", "--quick", "--json"], signal)).stdout,
      );
      if (!verified.ready) throw new Error(verified.message);
      this.update({ state: "ready", message: verified.message });
    } catch (error) {
      if (signal.aborted) return;
      this.update({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
}
