// 连接测试控件的模型选择回归：
//   · 不传 modelIds 时行为与旧版逐字一致（无下拉，恒用传入的 modelId）；
//   · 传了多个候选时确认面板出现下拉，实际调用用的是所选模型；
//   · 初值优先「用户默认模型」（命中本 Provider 且在候选内时）——它比 models[0] 更接近
//     用户实际在聊的那一个，Coding Plan 类端点上二者的测试结论可能完全相反。

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { ProviderTestControl } from "./ProviderTestControl";

function makeBridge(connectionTest = vi.fn(async () => ({ ok: true, modelId: "m", latencyMs: 5 }))) {
  return {
    bridge: {
      providerConnectionTest: connectionTest,
      onProviderConnectionTestEvent: vi.fn(() => () => undefined),
    } as unknown as DesktopBridge,
    connectionTest,
  };
}

function renderControl(bridge: DesktopBridge, props: Parameters<typeof ProviderTestControl>[0]) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <ProviderTestControl {...props} />
    </CoreProvider>,
  );
}

/** 点「测试」进确认面板。 */
function openConfirm(): void {
  fireEvent.click(screen.getByRole("button", { name: /测试/ }));
}

beforeEach(() => {
  usePersonalStore.setState({ defaultModelRef: undefined });
});
afterEach(() => cleanup());

describe("ProviderTestControl 的测试模型选择", () => {
  it("不传 modelIds → 无下拉，调用用传入的 modelId（与旧版行为一致）", async () => {
    const { bridge, connectionTest } = makeBridge();
    renderControl(bridge, { providerId: "acme", modelId: "m-0" });
    openConfirm();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
    await screen.findByText(/连接正常|连接失败/);
    expect(connectionTest).toHaveBeenCalledWith("acme", "m-0", expect.any(String));
  });

  it("多候选时确认面板出现下拉，切换后调用用所选模型", async () => {
    const { bridge, connectionTest } = makeBridge();
    renderControl(bridge, { providerId: "acme", modelId: "m-0", modelIds: ["m-0", "m-1", "m-2"] });
    openConfirm();
    const select = screen.getByRole("combobox", { name: "选择用于本次测试的模型" });
    fireEvent.change(select, { target: { value: "m-2" } });
    fireEvent.click(screen.getByRole("button", { name: "确认测试" }));
    await screen.findByText(/连接正常|连接失败/);
    expect(connectionTest).toHaveBeenCalledWith("acme", "m-2", expect.any(String));
  });

  it("默认模型命中本 Provider 且在候选内 → 作为初始选择", () => {
    usePersonalStore.setState({ defaultModelRef: { providerId: "acme", modelId: "m-1" } });
    const { bridge } = makeBridge();
    renderControl(bridge, { providerId: "acme", modelId: "m-0", modelIds: ["m-0", "m-1"] });
    openConfirm();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("m-1");
  });

  it("默认模型属于别的 Provider → 回落传入的 modelId", () => {
    usePersonalStore.setState({ defaultModelRef: { providerId: "other", modelId: "m-1" } });
    const { bridge } = makeBridge();
    renderControl(bridge, { providerId: "acme", modelId: "m-0", modelIds: ["m-0", "m-1"] });
    openConfirm();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("m-0");
  });
});
