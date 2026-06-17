// PiToolConfirmDialog 工具确认弹窗（阶段3 U6）:读 store piUiPending 队首 confirm,
// 三态(允许/拒绝/取消)回写 piUiResponse 并出队;无 pending 不渲染。

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type DesktopBridge, type PiUiRequest } from "@cortex-work/core";
import { PiToolConfirmDialog } from "./PiToolConfirmDialog";

function makeBridge() {
  return {
    loadChat: async () => [],
    saveChat: async () => {},
    piUiResponse: vi.fn(async () => undefined),
  } as unknown as DesktopBridge & { piUiResponse: ReturnType<typeof vi.fn> };
}

function renderDialog(bridge: DesktopBridge) {
  return render(
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <PiToolConfirmDialog />
    </CoreProvider>,
  );
}

const confirmReq = (id: string): PiUiRequest => ({
  type: "extension_ui_request",
  id,
  method: "confirm",
  title: "允许执行 bash?",
  message: "rm -rf /tmp/x",
});

beforeEach(() => usePersonalStore.setState({ piUiPending: [] }));
afterEach(() => cleanup());

describe("PiToolConfirmDialog（阶段3 U6）", () => {
  it("无 pending 不渲染", () => {
    renderDialog(makeBridge());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("有 confirm pending → 渲染标题/正文", () => {
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: confirmReq("c1") }] });
    renderDialog(makeBridge());
    expect(screen.getByText("允许执行 bash?")).toBeInTheDocument();
    expect(screen.getByText("rm -rf /tmp/x")).toBeInTheDocument();
  });

  it("点「允许」→ piUiResponse{confirmed:true} + 出队", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: confirmReq("c1") }] });
    renderDialog(bridge);
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    expect((bridge as { piUiResponse: ReturnType<typeof vi.fn> }).piUiResponse).toHaveBeenCalledWith("s-pi", "c1", { confirmed: true });
    expect(usePersonalStore.getState().piUiPending).toHaveLength(0);
  });

  it("点「拒绝」→ piUiResponse{confirmed:false}", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: confirmReq("c1") }] });
    renderDialog(bridge);
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    expect((bridge as { piUiResponse: ReturnType<typeof vi.fn> }).piUiResponse).toHaveBeenCalledWith("s-pi", "c1", { confirmed: false });
  });

  it("ESC → piUiResponse{cancelled:true}", () => {
    const bridge = makeBridge();
    usePersonalStore.setState({ piUiPending: [{ uiSessionId: "s-pi", request: confirmReq("c1") }] });
    renderDialog(bridge);
    fireEvent.keyDown(window, { key: "Escape" });
    expect((bridge as { piUiResponse: ReturnType<typeof vi.fn> }).piUiResponse).toHaveBeenCalledWith("s-pi", "c1", { cancelled: true });
  });

  it("多请求:应答队首后显示下一个", () => {
    const bridge = makeBridge();
    const named = (id: string, title: string): PiUiRequest => ({
      type: "extension_ui_request",
      id,
      method: "confirm",
      title,
      message: "M",
    });
    usePersonalStore.setState({
      piUiPending: [
        { uiSessionId: "sA", request: named("c1", "请求A") },
        { uiSessionId: "sB", request: named("c2", "请求B") },
      ],
    });
    renderDialog(bridge);
    expect(screen.getByText("请求A")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "允许" }));
    expect(screen.getByText("请求B")).toBeInTheDocument();
    expect(screen.queryByText("请求A")).toBeNull();
  });
});
