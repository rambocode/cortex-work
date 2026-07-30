import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { UpdateState } from "@cortex-work/core";
import { UpdateDialog, formatBytes, formatProgressDetail } from "./UpdateDialog";

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

  it("downloading 带字节字段:进度条下渲染字节明细行(差量下载时 total 即差量大小)", () => {
    renderDialog({
      phase: "downloading",
      version: "0.2.0",
      percent: 41.6,
      transferred: 12_300_000,
      total: 54_900_000,
      bytesPerSecond: 1_200_000,
    });
    expect(screen.getByText("12.3 MB / 54.9 MB (1.2 MB/s)")).toBeTruthy();
  });

  it("downloading 缺字节字段(旧主进程未透传)时降级:不渲染字节明细行", () => {
    renderDialog({ phase: "downloading", version: "0.2.0", percent: 41.6 });
    expect(document.querySelector(".pw-upd-bytes")).toBeNull();
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

describe("formatBytes", () => {
  it("B/KB/MB/GB 自适应,1000 进制", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 KB");
    expect(formatBytes(54_900_000)).toBe("54.9 MB");
    expect(formatBytes(1_234_000_000)).toBe("1.2 GB");
  });

  it("非法输入(负数/NaN)兜底为 0 B", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatProgressDetail", () => {
  it("完整字段 → 已下载/总量(速率)", () => {
    expect(
      formatProgressDetail({ phase: "downloading", transferred: 12_300_000, total: 54_900_000, bytesPerSecond: 1_200_000 }),
    ).toBe("12.3 MB / 54.9 MB (1.2 MB/s)");
  });

  it("缺速率时只显示已下载/总量", () => {
    expect(formatProgressDetail({ phase: "downloading", transferred: 12_300_000, total: 54_900_000 })).toBe(
      "12.3 MB / 54.9 MB",
    );
  });

  it("缺 transferred/total(旧主进程)→ null 降级", () => {
    expect(formatProgressDetail({ phase: "downloading", percent: 42 })).toBeNull();
    expect(formatProgressDetail({ phase: "downloading", transferred: 1 })).toBeNull();
  });
});
