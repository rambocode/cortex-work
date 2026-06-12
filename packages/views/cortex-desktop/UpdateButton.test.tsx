import { cleanup, render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge, UpdateState } from "@cortex-work/core";
import { UpdateButton, updateButtonUi } from "./UpdateButton";

// 可控的更新桥:initial 为挂载补拉结果,push() 模拟主进程推送。
function fakeUpdateBridge(initial: UpdateState) {
  let listener: ((s: UpdateState) => void) | null = null;
  const updateDownload = vi.fn(async () => {});
  const updateInstall = vi.fn(async () => {});
  const bridge = {
    updateGetState: async () => initial,
    updateDownload,
    updateInstall,
    onUpdateState: (cb: (s: UpdateState) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  } as unknown as DesktopBridge;
  return { bridge, updateDownload, updateInstall, push: (s: UpdateState) => act(() => listener?.(s)) };
}

function renderButton(bridge: DesktopBridge | null) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <UpdateButton />
    </CoreProvider>,
  );
}

describe("UpdateButton", () => {
  afterEach(() => cleanup());

  it("web 端（无 bridge）不渲染", () => {
    const { container } = renderButton(null);
    expect(container.querySelector(".tb-update")).toBeNull();
  });

  it("idle 状态不显示按钮", async () => {
    const { bridge } = fakeUpdateBridge({ phase: "idle" });
    const { container } = renderButton(bridge);
    await waitFor(() => expect(container.querySelector(".tb-update")).toBeNull());
  });

  it("挂载补拉到 available:显示「更新」,点击触发下载", async () => {
    const { bridge, updateDownload } = fakeUpdateBridge({ phase: "available", version: "0.2.0" });
    renderButton(bridge);
    const btn = await screen.findByRole("button", { name: "更新" });
    fireEvent.click(btn);
    expect(updateDownload).toHaveBeenCalledTimes(1);
  });

  it("主进程推送驱动:available → 下载进度 → 重启更新(触发安装)", async () => {
    const { bridge, updateInstall, push } = fakeUpdateBridge({ phase: "idle" });
    renderButton(bridge);

    push({ phase: "available", version: "0.2.0" });
    await screen.findByRole("button", { name: "更新" });

    push({ phase: "downloading", version: "0.2.0", percent: 41.6 });
    const downloading = await screen.findByRole("button", { name: "更新 42%" });
    expect(downloading).toBeDisabled();

    push({ phase: "downloaded", version: "0.2.0" });
    const install = await screen.findByRole("button", { name: "重启更新" });
    fireEvent.click(install);
    expect(updateInstall).toHaveBeenCalledTimes(1);
  });

  it("下载失败显示「重试更新」,点击重新下载", async () => {
    const { bridge, updateDownload, push } = fakeUpdateBridge({ phase: "idle" });
    renderButton(bridge);
    push({ phase: "error", version: "0.2.0", error: "网络中断" });
    const retry = await screen.findByRole("button", { name: "重试更新" });
    expect(retry).toHaveAttribute("title", "网络中断");
    fireEvent.click(retry);
    expect(updateDownload).toHaveBeenCalledTimes(1);
  });
});

describe("updateButtonUi 纯映射", () => {
  it("idle / checking / 无 version 的 error 都不显示", () => {
    expect(updateButtonUi({ phase: "idle" })).toBeNull();
    expect(updateButtonUi({ phase: "checking" })).toBeNull();
    expect(updateButtonUi({ phase: "error", error: "404" })).toBeNull();
  });

  it("进度取整并夹在 0-100", () => {
    expect(updateButtonUi({ phase: "downloading", percent: 99.7 })?.label).toBe("更新 100%");
    expect(updateButtonUi({ phase: "downloading" })?.label).toBe("更新 0%");
  });
});
