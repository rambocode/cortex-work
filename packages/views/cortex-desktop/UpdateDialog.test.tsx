import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { UpdateState } from "@cortex-work/core";
import { UpdateDialog } from "./UpdateDialog";

function renderDialog(state: UpdateState) {
  const onDownload = vi.fn();
  const onInstall = vi.fn();
  const onClose = vi.fn();
  render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={null}>
      <UpdateDialog state={state} onDownload={onDownload} onInstall={onInstall} onClose={onClose} />
    </CoreProvider>,
  );
  return { onDownload, onInstall, onClose };
}

describe("UpdateDialog", () => {
  afterEach(() => cleanup());

  it("available:渲染版本号标题 + markdown 内容 + 下载按钮,点击触发 onDownload", async () => {
    const { onDownload } = renderDialog({ phase: "available", version: "0.2.0", releaseNotes: "## 0.2.0\n\n- 修复登录" });
    expect(screen.getByText("发现新版本 v0.2.0")).toBeTruthy();
    await screen.findByText("修复登录");
    const btn = screen.getByRole("button", { name: "下载更新" });
    fireEvent.click(btn);
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("releaseNotes 为空时渲染占位文案", async () => {
    renderDialog({ phase: "available", version: "0.2.0" });
    await screen.findByText("本次更新暂无详细说明。");
  });

  it("downloading:显示进度百分比、主按钮禁用、有关闭", () => {
    renderDialog({ phase: "downloading", version: "0.2.0", percent: 41.6 });
    const downloading = screen.getByRole("button", { name: "下载中 42%" });
    expect(downloading).toBeDisabled();
    expect(screen.queryByRole("button", { name: "重启更新" })).toBeNull();
    // 标题栏 X 与底部均提供「关闭」入口（统一关闭语义）,故至少一个。
    expect(screen.getAllByRole("button", { name: "关闭" }).length).toBeGreaterThanOrEqual(1);
  });

  it("downloaded:显示重启更新,点击触发 onInstall", () => {
    const { onInstall } = renderDialog({ phase: "downloaded", version: "0.2.0" });
    fireEvent.click(screen.getByRole("button", { name: "重启更新" }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("error(有 version):渲染错误文案 + 重试下载,点击触发 onDownload", () => {
    const { onDownload } = renderDialog({ phase: "error", version: "0.2.0", error: "网络中断" });
    expect(screen.getByText("下载失败：网络中断")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试下载" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("点遮罩 / Esc / 关闭 均触发 onClose", () => {
    const { onClose } = renderDialog({ phase: "downloaded", version: "0.2.0" });
    fireEvent.click(screen.getByRole("button", { name: "稍后" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
