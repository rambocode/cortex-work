import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DesktopBridge } from "@cortex-work/core";
import { chatMarkdownComponents } from "./chatMarkdown";

function renderMd(
  text: string,
  opts: { projectPath?: string; resolveProjectFile?: (root: string, ref: string) => Promise<string | null> } = {},
) {
  const { projectPath = "/proj", resolveProjectFile } = opts;
  const onOpenFile = vi.fn<(ref: string) => void>();
  const openExternal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  const bridge = {
    openExternal,
    ...(resolveProjectFile ? { resolveProjectFile } : {}),
  } as unknown as DesktopBridge;
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

  it("定位不到(真已删除)→ 标 .file-link-missing 且点击不打开", async () => {
    const resolveProjectFile = vi.fn<(r: string, ref: string) => Promise<string | null>>().mockResolvedValue(null);
    const { container, onOpenFile } = renderMd("see `packages/core/gone.ts` now", { resolveProjectFile });
    await waitFor(() => expect(container.querySelector("code.file-link-missing")).not.toBeNull());
    expect(resolveProjectFile).toHaveBeenCalledWith("/proj", "packages/core/gone.ts");
    const el = container.querySelector("code.file-link-missing")!;
    expect(el.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(el);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("裸文件名能在项目内定位 → 不标 missing,点击仍传原始 ref", async () => {
    // 真实文件在子目录,resolveProjectFile 命中 → 可点击(回归本次反馈的核心 bug)。
    const resolveProjectFile = vi
      .fn<(r: string, ref: string) => Promise<string | null>>()
      .mockResolvedValue("/proj/outputs/docs/002.md");
    const { container, onOpenFile } = renderMd("见 `002.md` 文件", { resolveProjectFile });
    await waitFor(() => expect(resolveProjectFile).toHaveBeenCalledWith("/proj", "002.md"));
    expect(container.querySelector("code.file-link-missing")).toBeNull();
    fireEvent.click(container.querySelector("code.file-link")!);
    expect(onOpenFile).toHaveBeenCalledWith("002.md");
  });

  it("失效的 markdown 链接 → 标 missing 且点击不打开", async () => {
    const resolveProjectFile = vi.fn<(r: string, ref: string) => Promise<string | null>>().mockResolvedValue(null);
    const { container, onOpenFile } = renderMd("[doc](docs/gone.md)", { resolveProjectFile });
    await waitFor(() => expect(container.querySelector("a.file-link-missing")).not.toBeNull());
    fireEvent.click(container.querySelector("a")!);
    expect(onOpenFile).not.toHaveBeenCalled();
  });
});
