// MediaSecretKeyField 密钥金库控件测试——「明文不落 store」红线回归。
// 核心断言：保存走 providerAuthSetSecrets、onChange 只收到 ${secret:NAME} 引用或空串,
// 明文绝不出现在任何 onChange 调用里;清除链路;金库不可用禁用态;桥缺失降级。

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";

import { MediaSecretKeyField } from "./MediaSecretKeyField";

const SECRET_NAME = "media.image.custom";

function makeBridge(o: { storageAvailable?: boolean; setSecretsOk?: boolean } = {}): {
  bridge: DesktopBridge;
  setSecrets: ReturnType<typeof vi.fn>;
} {
  const setSecrets = vi.fn(async () => (o.setSecretsOk === false ? { ok: false, error: "boom" } : { ok: true }));
  const bridge = {
    providerAuthStatus: vi.fn(async () => ({
      statuses: [],
      health: o.storageAvailable === false ? { available: false, reason: "libsecret 缺失" } : { available: true },
      hiddenProviderIds: [],
    })),
    providerAuthSetSecrets: setSecrets,
  } as unknown as DesktopBridge;
  return { bridge, setSecrets };
}

function renderUI(ui: ReactElement, bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      {ui}
    </CoreProvider>,
  );
}

afterEach(cleanup);

describe("MediaSecretKeyField", () => {
  it("保存:明文经 providerAuthSetSecrets 入金库,onChange 只收到 ${secret:NAME} 引用", async () => {
    const { bridge, setSecrets } = makeBridge();
    const onChange = vi.fn();
    renderUI(<MediaSecretKeyField secretName={SECRET_NAME} value="" onChange={onChange} />, bridge);

    const input = screen.getByLabelText("API 密钥");
    fireEvent.change(input, { target: { value: "sk-plain-secret" } });
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => expect(setSecrets).toHaveBeenCalledWith({ [SECRET_NAME]: "sk-plain-secret" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(`\${secret:${SECRET_NAME}}`));
    // 红线：明文绝不出现在任何写回 store 的值里
    for (const call of onChange.mock.calls) {
      expect(String(call[0])).not.toContain("sk-plain-secret");
    }
  });

  it("保存成功后清空本地明文草稿（不回显）", async () => {
    const { bridge } = makeBridge();
    const onChange = vi.fn();
    renderUI(<MediaSecretKeyField secretName={SECRET_NAME} value="" onChange={onChange} />, bridge);

    const input = screen.getByLabelText("API 密钥") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-plain-secret" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    // 保存后组件仍是输入态（value 由父层控制未变),但草稿必须已清空
    expect((screen.getByLabelText("API 密钥") as HTMLInputElement).value).toBe("");
  });

  it("已保存态展示遮蔽徽标,不渲染输入框、不回显引用", () => {
    const { bridge } = makeBridge();
    renderUI(
      <MediaSecretKeyField secretName={SECRET_NAME} value={`\${secret:${SECRET_NAME}}`} onChange={vi.fn()} />,
      bridge,
    );
    expect(screen.getByText("●●●● 已保存")).toBeInTheDocument();
    expect(screen.queryByLabelText("API 密钥", { selector: "input" })).toBeNull();
  });

  it("清除:setSecrets 写空串（=删除）且 apiKey 置空", async () => {
    const { bridge, setSecrets } = makeBridge();
    const onChange = vi.fn();
    renderUI(
      <MediaSecretKeyField secretName={SECRET_NAME} value={`\${secret:${SECRET_NAME}}`} onChange={onChange} />,
      bridge,
    );
    fireEvent.click(screen.getByText("清除"));
    await waitFor(() => expect(setSecrets).toHaveBeenCalledWith({ [SECRET_NAME]: "" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(""));
  });

  it("更换:进入输入态,取消可返回已保存态", () => {
    const { bridge } = makeBridge();
    renderUI(
      <MediaSecretKeyField secretName={SECRET_NAME} value={`\${secret:${SECRET_NAME}}`} onChange={vi.fn()} />,
      bridge,
    );
    fireEvent.click(screen.getByText("更换"));
    expect(screen.getByLabelText("API 密钥")).toBeInTheDocument();
    fireEvent.click(screen.getByText("取消"));
    expect(screen.getByText("●●●● 已保存")).toBeInTheDocument();
  });

  it("保存失败:展示错误,onChange 不被调用", async () => {
    const { bridge, setSecrets } = makeBridge({ setSecretsOk: false });
    const onChange = vi.fn();
    renderUI(<MediaSecretKeyField secretName={SECRET_NAME} value="" onChange={onChange} />, bridge);
    fireEvent.change(screen.getByLabelText("API 密钥"), { target: { value: "sk-x" } });
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(setSecrets).toHaveBeenCalled());
    expect(await screen.findByText("保存失败：boom")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("金库不可用（safeStorage 降级）:禁输入并展示 reason", async () => {
    const { bridge } = makeBridge({ storageAvailable: false });
    renderUI(<MediaSecretKeyField secretName={SECRET_NAME} value="" onChange={vi.fn()} />, bridge);
    // health 快照异步到达后切换到禁用态
    expect(await screen.findByText("密钥库不可用：libsecret 缺失")).toBeInTheDocument();
    expect(screen.queryByLabelText("API 密钥", { selector: "input" })).toBeNull();
  });

  it("桥方法缺失（Web 端）:渲染 unsupported 降级文案", () => {
    renderUI(<MediaSecretKeyField secretName={SECRET_NAME} value="" onChange={vi.fn()} />, null);
    expect(screen.getByText("当前环境不支持密钥库,请在桌面端配置。")).toBeInTheDocument();
  });
});
