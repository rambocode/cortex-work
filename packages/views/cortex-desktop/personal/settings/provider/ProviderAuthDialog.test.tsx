// OAuth 通用交互对话框的回归测试。
//
// 重点是「一个对话框吃下所有 provider」：登录方式选择(select) → 打开浏览器(auth_url) →
// 设备码(device_code) → 复制粘贴回调码(manual_code) → 文本/密钥输入 → 进度 → 取消 / 重试 / 完成，
// 全部由 pi 的 prompt/notify 两个原语驱动，且**全流程可纯键盘完成**。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import type { ProviderAuthEvent } from "@cortex-work/core/desktop/provider-catalog";
import { ProviderAuthDialog } from "./ProviderAuthDialog";

function renderUI(ui: ReactElement, bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

/** 可手动推事件的假桥，模拟主进程的 providerAuth:event 流。 */
function makeBridge(over: Partial<DesktopBridge> = {}) {
  let emit: ((e: ProviderAuthEvent) => void) | undefined;
  const respond = vi.fn(async () => ({ ok: true }));
  const cancel = vi.fn(async () => ({ ok: true }));
  const login = vi.fn(async () => ({ ok: true }));
  const bridge = {
    providerAuthLogin: login,
    providerAuthRespond: respond,
    providerAuthCancel: cancel,
    providerAuthStatus: vi.fn(async () => ({ statuses: [], health: { available: true }, hiddenProviderIds: [] })),
    onProviderAuthEvent: (cb: (e: ProviderAuthEvent) => void) => {
      emit = cb;
      return () => undefined;
    },
    ...over,
  } as unknown as DesktopBridge;
  return { bridge, login, respond, cancel, emit: (e: ProviderAuthEvent) => emit?.(e) };
}

afterEach(() => cleanup());

describe("ProviderAuthDialog 通用登录流程", () => {
  it("打开即发起登录，并展示等待态", async () => {
    const { bridge, login } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="anthropic" providerName="Anthropic" onClose={() => {}} />, bridge);
    await waitFor(() => expect(login).toHaveBeenCalledWith("anthropic"));
    expect(screen.getByText("等待供应商响应…")).toBeInTheDocument();
  });

  it("select：登录方式选择，点选即 respond 回对应 requestId", async () => {
    const { bridge, respond, emit } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="anthropic" providerName="Anthropic" onClose={() => {}} />, bridge);
    await waitFor(() => expect(screen.getByText("等待供应商响应…")).toBeInTheDocument());
    emit({
      type: "prompt",
      providerId: "anthropic",
      prompt: {
        requestId: "r1",
        kind: "select",
        label: "选择登录方式",
        options: [
          { value: "browser", label: "浏览器登录" },
          { value: "device", label: "设备码" },
        ],
      },
    });
    fireEvent.click(await screen.findByText("设备码"));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("r1", "device"));
  });

  it("auth_url + device_code：给出浏览器入口与可复制的设备码", async () => {
    const { bridge, emit } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="p" providerName="P" onClose={() => {}} />, bridge);
    await waitFor(() => expect(screen.getByText("等待供应商响应…")).toBeInTheDocument());
    emit({
      type: "prompt",
      providerId: "p",
      prompt: { requestId: "r2", kind: "text", label: "等待授权", authUrl: "https://auth.example/x", deviceCode: "WDJB-MJHT" },
    });
    const link = (await screen.findByText("在浏览器中打开")).closest("a") as HTMLAnchorElement;
    expect(link.href).toBe("https://auth.example/x");
    expect(screen.getByText("WDJB-MJHT")).toBeInTheDocument();
  });

  it("manual_code：粘贴回调码后回车提交（键盘可完成）", async () => {
    const { bridge, respond, emit } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="p" providerName="P" onClose={() => {}} />, bridge);
    await waitFor(() => expect(screen.getByText("等待供应商响应…")).toBeInTheDocument());
    emit({
      type: "prompt",
      providerId: "p",
      prompt: { requestId: "r3", kind: "manual_code", label: "授权码" },
    });
    const input = await screen.findByLabelText("授权码");
    // prompt 到达后焦点自动落到输入框：纯键盘用户不必先 Tab 找控件。
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "code-123" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(respond).toHaveBeenCalledWith("r3", "code-123"));
  });

  it("secret 输入走 password 控件（一次性密钥也不该被肩窥）", async () => {
    const { bridge, emit } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="p" providerName="P" onClose={() => {}} />, bridge);
    await waitFor(() => expect(screen.getByText("等待供应商响应…")).toBeInTheDocument());
    emit({ type: "prompt", providerId: "p", prompt: { requestId: "r4", kind: "secret", label: "客户端密钥" } });
    expect(((await screen.findByLabelText("客户端密钥")) as HTMLInputElement).type).toBe("password");
  });

  it("notify：展示进度与提示", async () => {
    const { bridge, emit } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="p" providerName="P" onClose={() => {}} />, bridge);
    await waitFor(() => expect(screen.getByText("等待供应商响应…")).toBeInTheDocument());
    emit({ type: "notify", providerId: "p", notice: { level: "info", message: "正在换取令牌", progress: 0.5 } });
    expect(await screen.findByText("正在换取令牌")).toBeInTheDocument();
  });

  it("done：显示成功并提供关闭", async () => {
    const onClose = vi.fn();
    const { bridge, emit } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="p" providerName="P" onClose={onClose} />, bridge);
    await waitFor(() => expect(screen.getByText("等待供应商响应…")).toBeInTheDocument());
    emit({
      type: "done",
      providerId: "p",
      status: { providerId: "p", configured: true, type: "oauth", source: "safe-storage" },
    });
    expect(await screen.findByText("登录成功")).toBeInTheDocument();
    // 顶部 X 与底部按钮都叫「关闭」，成功态点底部那个（顶部走取消路径）。
    const closes = screen.getAllByRole("button", { name: "关闭" });
    fireEvent.click(closes[closes.length - 1]!);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("error：显示原因并可重试（重试重新发起 login）", async () => {
    const { bridge, login, emit } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="p" providerName="P" onClose={() => {}} />, bridge);
    await waitFor(() => expect(login).toHaveBeenCalledTimes(1));
    emit({ type: "error", providerId: "p", message: "token 交换失败" });
    expect(await screen.findByText(/token 交换失败/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(login).toHaveBeenCalledTimes(2));
  });

  it("取消：通知主进程撤销本轮登录并关闭", async () => {
    const onClose = vi.fn();
    const { bridge, cancel } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="p" providerName="P" onClose={onClose} />, bridge);
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("p"));
    expect(onClose).toHaveBeenCalled();
  });

  it("别的 Provider 的事件不串台", async () => {
    const { bridge, emit } = makeBridge();
    renderUI(<ProviderAuthDialog providerId="p" providerName="P" onClose={() => {}} />, bridge);
    await waitFor(() => expect(screen.getByText("等待供应商响应…")).toBeInTheDocument());
    emit({ type: "prompt", providerId: "other", prompt: { requestId: "x", kind: "text", label: "不该出现" } });
    expect(screen.queryByLabelText("不该出现")).toBeNull();
  });

  it("桥不支持登录流程 → 明确提示而不是空转", async () => {
    renderUI(<ProviderAuthDialog providerId="p" providerName="P" onClose={() => {}} />, {} as DesktopBridge);
    expect(await screen.findByText("当前环境不支持该供应商的登录流程。")).toBeInTheDocument();
  });
});
