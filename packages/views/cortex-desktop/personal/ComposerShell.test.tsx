// ComposerShell 运行时插话（steer）门控（计划 U6）:仅 pi + running + onSteer 时,
// 运行中输入框可发插话(Enter/按钮 → onSteer);claude 运行中只剩停止按钮。

import type { ReactNode } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type AgentKind, type DesktopBridge } from "@cortex-work/core";
import { ComposerShell } from "./ComposerShell";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

function renderShell(props: {
  agent: AgentKind;
  running: boolean;
  onSteer?: (text: string) => void;
  onStop?: () => void;
  onSend?: (text: string) => void;
}) {
  const node: ReactNode = (
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <ComposerShell
        agent={props.agent}
        model={undefined}
        providerId={undefined}
        useOwnSkills={false}
        running={props.running}
        onSend={(t) => props.onSend?.(t)}
        onStop={props.onStop}
        onSteer={props.onSteer}
        onChangeModel={() => {}}
        onChangePiModel={() => {}}
        onToggleSkills={() => {}}
        onToast={() => {}}
      />
    </CoreProvider>
  );
  return render(node);
}

afterEach(() => {
  cleanup();
  usePersonalStore.setState({ providerSettings: { providers: [], defaultProviderId: undefined, defaultModel: undefined } });
});

describe("ComposerShell steer 门控（U6）", () => {
  it("底部工具条保留窄宽布局所需的稳定结构", () => {
    const { container } = renderShell({ agent: "codex", running: false });
    const foot = container.querySelector(".composer .comp-foot");
    const modelPill = container.querySelector(".composer .comp-foot .pw-model-pill");
    const send = container.querySelector(".composer .comp-foot .send");

    expect(foot).toBeInTheDocument();
    expect(modelPill).toBeInTheDocument();
    expect(send).toBeInTheDocument();
  });

  it("pi + running:输入回车 → onSteer(注入当前轮),不影响停止", () => {
    const onSteer = vi.fn();
    const onStop = vi.fn();
    renderShell({ agent: "pi", running: true, onSteer, onStop });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "往左走" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSteer).toHaveBeenCalledWith("往左走");
    // 停止按钮仍在。
    expect(screen.getByTitle("停止")).toBeInTheDocument();
  });

  it("pi + running:插话按钮存在,点击 → onSteer", () => {
    const onSteer = vi.fn();
    renderShell({ agent: "pi", running: true, onSteer, onStop: () => {} });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "改用方案B" } });
    fireEvent.click(screen.getByTitle(/插话/));
    expect(onSteer).toHaveBeenCalledWith("改用方案B");
  });

  it("claude + running:无插话能力,只显示停止按钮", () => {
    const onSteer = vi.fn();
    renderShell({ agent: "claude", running: true, onSteer, onStop: () => {} });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "x" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSteer).not.toHaveBeenCalled();
    expect(screen.queryByTitle(/插话/)).toBeNull();
    expect(screen.getByTitle("停止")).toBeInTheDocument();
  });

  it("pi 未运行:回车走正常发送,不 steer", () => {
    const onSteer = vi.fn();
    const onSend = vi.fn();
    renderShell({ agent: "pi", running: false, onSteer, onSend });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "新问题" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("新问题");
    expect(onSteer).not.toHaveBeenCalled();
  });
});
