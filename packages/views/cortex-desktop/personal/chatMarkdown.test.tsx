import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DesktopBridge } from "@cortex-work/core";
import { chatMarkdownComponents } from "./chatMarkdown";

function renderMd(text: string, projectPath = "/proj") {
  const onOpenFile = vi.fn<(ref: string) => void>();
  const openExternal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  const bridge = { openExternal } as unknown as DesktopBridge;
  const { container } = render(
    <Markdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents({ onOpenFile, projectPath, bridge })}>
      {text}
    </Markdown>,
  );
  return { container, onOpenFile, openExternal };
}

describe("chatMarkdownComponents", () => {
  afterEach(() => cleanup());

  it("inline code 为项目内路径 → .file-link,点击触发 onOpenFile", () => {
    const { container, onOpenFile } = renderMd("see `packages/core/x.ts` now");
    const el = container.querySelector("code.file-link");
    expect(el).not.toBeNull();
    fireEvent.click(el!);
    expect(onOpenFile).toHaveBeenCalledWith("packages/core/x.ts");
  });

  it("inline code 非路径 → 普通 code,不可点", () => {
    const { container, onOpenFile } = renderMd("call `const x` here");
    expect(container.querySelector("code.file-link")).toBeNull();
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    fireEvent.click(code!);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("inline code 为项目外绝对路径 → 不可点", () => {
    const { container, onOpenFile } = renderMd("read `/etc/passwd` file");
    expect(container.querySelector("code.file-link")).toBeNull();
    fireEvent.click(container.querySelector("code")!);
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("markdown 相对链接 → 点击触发 onOpenFile,不触发 openExternal", () => {
    const { container, onOpenFile, openExternal } = renderMd("[doc](docs/a.md)");
    fireEvent.click(container.querySelector("a")!);
    expect(onOpenFile).toHaveBeenCalledWith("docs/a.md");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("markdown 外链 → 点击触发 openExternal,不触发 onOpenFile", () => {
    const { container, onOpenFile, openExternal } = renderMd("[site](https://x.com)");
    fireEvent.click(container.querySelector("a")!);
    expect(openExternal).toHaveBeenCalledWith("https://x.com");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("键盘可达:.file-link 上 Enter / Space 触发 onOpenFile", () => {
    const { container, onOpenFile } = renderMd("`src/a.ts`");
    const el = container.querySelector("code.file-link")!;
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyDown(el, { key: " " });
    expect(onOpenFile).toHaveBeenCalledTimes(2);
  });
});
