import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { AutomationRun, DesktopBridge } from "@cortex-work/core";

// MarkdownView 依赖 mermaid(模块级单例),测试中以 mock 接管,避免真实渲染开销。
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }) },
}));

const { AutomationHeroCard } = await import("./AutomationHeroCard");

afterEach(() => cleanup());

const bridge = { openExternal: vi.fn() } as unknown as DesktopBridge;
function renderHero(node: React.ReactNode) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {node}
    </CoreProvider>,
  );
}

const run = (over: Partial<AutomationRun> = {}): AutomationRun => ({
  id: "r1",
  automationId: "a1",
  startedAt: 0,
  endedAt: 37_000,
  status: "ok",
  trigger: "schedule",
  agent: "claude",
  prompt: "p",
  output: "成功输出正文",
  ...over,
});

describe("AutomationHeroCard", () => {
  it("无 latestRun → 渲染空态、无操作区", () => {
    const { getByText, container } = renderHero(<AutomationHeroCard onRerun={() => {}} />);
    expect(getByText("暂无运行结果")).toBeTruthy();
    expect(container.querySelector(".pw-auto-hero-acts")).toBeNull();
  });

  it("成功 run → 徽章「成功」、正文为 output", () => {
    const { getByText } = renderHero(<AutomationHeroCard latestRun={run()} onRerun={() => {}} />);
    expect(getByText("成功")).toBeTruthy();
    expect(getByText("成功输出正文")).toBeTruthy();
  });

  it("失败 run(有 error)→ 徽章「失败」、正文为 error、套 is-err", () => {
    const { getByText, container } = renderHero(
      <AutomationHeroCard latestRun={run({ status: "error", error: "模型超时" })} onRerun={() => {}} />,
    );
    expect(getByText("失败")).toBeTruthy();
    expect(getByText("模型超时")).toBeTruthy();
    expect(container.querySelector(".pw-auto-hero-body.is-err")).not.toBeNull();
  });

  it("点重新运行触发 onRerun", () => {
    const onRerun = vi.fn();
    const { getByTitle } = renderHero(<AutomationHeroCard latestRun={run()} onRerun={onRerun} />);
    fireEvent.click(getByTitle("重新运行"));
    expect(onRerun).toHaveBeenCalledTimes(1);
  });

  it("不渲染「在会话中打开」(KTD7 本期延后)", () => {
    const { queryByTitle } = renderHero(<AutomationHeroCard latestRun={run()} onRerun={() => {}} />);
    expect(queryByTitle("在会话中打开")).toBeNull();
  });
});
