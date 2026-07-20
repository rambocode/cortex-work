import { describe, expect, it, vi } from "vitest";
import { AgentBrowserRuntime, parseAgentBrowserDoctorOutput } from "./runtime";

const readyDoctor = JSON.stringify({ checks: [{ id: "chrome.installed", status: "pass", message: "Chrome ready" }] });
const missingDoctor = JSON.stringify({ checks: [{ id: "chrome.installed", status: "fail", message: "Chrome missing" }] });

describe("agent-browser runtime", () => {
  it("parses the Chrome readiness check from doctor JSON", () => {
    expect(parseAgentBrowserDoctorOutput(readyDoctor)).toEqual({ ready: true, message: "Chrome ready" });
    expect(parseAgentBrowserDoctorOutput(missingDoctor)).toEqual({ ready: false, message: "Chrome missing" });
    expect(parseAgentBrowserDoctorOutput("not-json")).toEqual({ ready: false, message: "无法解析 agent-browser doctor 输出" });
  });

  it("does not install when Chrome is already available", async () => {
    const run = vi.fn(async () => ({ stdout: readyDoctor, stderr: "" }));
    const runtime = new AgentBrowserRuntime(() => "/bin/agent-browser", run);
    await runtime.ensure(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(runtime.getStatus()).toMatchObject({ state: "ready" });
  });

  it("installs Chrome in the background when missing", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: missingDoctor, stderr: "" })
      .mockResolvedValueOnce({ stdout: "installed", stderr: "" })
      .mockResolvedValueOnce({ stdout: readyDoctor, stderr: "" });
    const onStatus = vi.fn();
    const runtime = new AgentBrowserRuntime(() => "/bin/agent-browser", run, onStatus);

    await runtime.ensure(true);

    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ["doctor", "--offline", "--quick", "--json"],
      ["install"],
      ["doctor", "--offline", "--quick", "--json"],
    ]);
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "downloading" }));
    expect(runtime.getStatus()).toMatchObject({ state: "ready" });
  });

  it("reports disabled and never launches a process when switched off", async () => {
    const run = vi.fn();
    const runtime = new AgentBrowserRuntime(() => "/bin/agent-browser", run);
    await runtime.ensure(false);
    expect(run).not.toHaveBeenCalled();
    expect(runtime.getStatus()).toEqual({ state: "disabled", message: "已关闭" });
  });
});
