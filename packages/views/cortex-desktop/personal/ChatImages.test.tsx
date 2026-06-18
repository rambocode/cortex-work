// ChatImages 缩略图渲染（U7）:统一经 bridge.imageRead 回读;reject/无能力 → 受控占位。
import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, type ChatImageRef, type DesktopBridge } from "@cortex-work/core";
import { ChatImages } from "./ChatImages";

function renderImages(images: ChatImageRef[], over: Partial<DesktopBridge> = {}) {
  const bridge = {
    imageRead: vi.fn(async (p: string) => ({ dataUrl: `data:image/png;base64,${encodeURIComponent(p)}` })),
    ...over,
  } as unknown as DesktopBridge;
  const r = render(
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <ChatImages images={images} />
    </CoreProvider>,
  );
  return { ...r, bridge };
}

const ref = (path: string, name: string): ChatImageRef => ({ path, name, mimeType: "image/png" });

afterEach(cleanup);

describe("ChatImages", () => {
  it("逐张 imageRead → 渲染缩略图(alt + 顺序)", async () => {
    const { container, bridge } = renderImages([ref("/a.png", "a.png"), ref("/b.png", "b.png")]);
    await waitFor(() => expect(container.querySelectorAll("img.msg-img").length).toBe(2));
    expect(bridge.imageRead as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(2);
    const alts = [...container.querySelectorAll("img.msg-img")].map((i) => (i as HTMLImageElement).alt);
    expect(alts).toEqual(["a.png", "b.png"]);
  });

  it("imageRead reject → 受控占位(图片不可用 + 文件名),不渲染 broken-image,不崩", async () => {
    const { container } = renderImages([ref("/x.png", "gone.png")], {
      imageRead: vi.fn(async () => Promise.reject(new Error("ENOENT"))),
    });
    await waitFor(() => expect(container.querySelector(".msg-img-missing")).toBeTruthy());
    expect(container.textContent).toContain("图片不可用");
    expect(container.textContent).toContain("gone.png");
    expect(container.querySelector("img.msg-img")).toBeNull();
  });

  it("bridge 无 imageRead(web/旧壳)→ 占位,不崩", async () => {
    const { container } = renderImages([ref("/x.png", "x.png")], { imageRead: undefined });
    await waitFor(() => expect(container.querySelector(".msg-img-missing")).toBeTruthy());
  });
});
