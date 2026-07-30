// ChatInlineImage 模块级 dataURL 缓存(问题2/3):codex 流式正文持续增长 → react-markdown 反复
// 重解析 → ChatInlineImage 反复 remount。无缓存时每次 remount 都回到 loading 占位 + 重新
// imageReadAny,表现为「图片多次渲染闪烁」+ loading↔loaded 高度往返「抖动」。缓存后 remount
// 同步命中、首帧即图片、不再回读,闪烁与反复抖动消除。

import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@cortex-work/core";
import { ChatInlineImage } from "./ChatInlineImage";

afterEach(cleanup);

// 只需 imageReadAny;src 用绝对路径(/ 开头)绕过 resolveProjectFileRef 的项目内解析。
function mkBridge(dataUrl: string): DesktopBridge {
  return { imageReadAny: vi.fn(async () => ({ dataUrl })) } as unknown as DesktopBridge;
}
const baseProps = { alt: "img", projectPath: "/proj", onOpenFile: () => {} };

describe("ChatInlineImage 模块缓存", () => {
  it("首次:先 loading 占位,回读后显示图片,imageReadAny 调用一次", async () => {
    const bridge = mkBridge("data:image/png;base64,AAA");
    const { container } = render(<ChatInlineImage src="/abs/first.png" bridge={bridge} {...baseProps} />);
    expect(container.querySelector(".chat-inline-img--loading")).toBeTruthy(); // 初始占位
    await waitFor(() => expect(container.querySelector("img.chat-inline-img")).toBeTruthy());
    expect(bridge.imageReadAny).toHaveBeenCalledTimes(1);
  });

  it("同一 src remount:同步命中缓存,不回 loading 占位,不再回读", async () => {
    const bridge = mkBridge("data:image/png;base64,BBB");
    const first = render(<ChatInlineImage src="/abs/cached.png" bridge={bridge} {...baseProps} />);
    await waitFor(() => expect(first.container.querySelector("img.chat-inline-img")).toBeTruthy());
    expect(bridge.imageReadAny).toHaveBeenCalledTimes(1);
    first.unmount();
    // 重新挂载:模拟 markdown 重解析导致的 remount。
    const second = render(<ChatInlineImage src="/abs/cached.png" bridge={bridge} {...baseProps} />);
    // 关键:首帧就是图片、无 loading 占位(命中模块缓存同步渲染)。
    expect(second.container.querySelector(".chat-inline-img--loading")).toBeNull();
    expect(second.container.querySelector("img.chat-inline-img")).toBeTruthy();
    expect(bridge.imageReadAny).toHaveBeenCalledTimes(1); // 未再触发回读
  });
});
