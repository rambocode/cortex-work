import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";
import { SkillFilePreview } from "./SkillFilePreview";

// docx 预览依赖 docx-preview,jsdom 无法真解析 → mock 成写入占位正文。
vi.mock("docx-preview", () => ({
  renderAsync: vi.fn(async (_bytes: ArrayBuffer, body: HTMLElement) => {
    body.innerHTML = "<p>DOCX 预览正文</p>";
    return {};
  }),
}));

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    readFile: vi.fn().mockResolvedValue({ content: "# Hello", truncated: false }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFileBinary: vi.fn().mockResolvedValue({ data: "AAAA", truncated: false, size: 4, mtimeMs: 1 }),
    imageReadAny: vi.fn().mockResolvedValue({ dataUrl: "data:image/png;base64,AAA" }),
    openPath: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as DesktopBridge;
}

function renderPreview(name: string, bridge: DesktopBridge, onClose = () => {}) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <SkillFilePreview path={`/s/${name}`} name={name} bridge={bridge} onToast={() => {}} onClose={onClose} />
    </CoreProvider>,
  );
}

describe("SkillFilePreview 按类型分派", () => {
  afterEach(() => cleanup());

  it(".md 默认渲染 Markdown,点「编辑」出 textarea,保存调 writeFile", async () => {
    const bridge = makeBridge();
    const { container } = renderPreview("SKILL.md", bridge);
    // 渲染态:标题文本出现(MarkdownView),readFile 被调。
    expect(await screen.findByText("Hello")).toBeInTheDocument();
    expect(bridge.readFile).toHaveBeenCalledWith("/s/SKILL.md");

    // 切编辑态:出现 textarea 源码。
    fireEvent.click(screen.getByTitle("编辑"));
    const ta = container.querySelector<HTMLTextAreaElement>("textarea.pw-editor-ta")!;
    expect(ta).toBeTruthy();
    expect(ta.value).toBe("# Hello");

    // 改动 → 保存按钮可用 → 点保存写回。
    fireEvent.change(ta, { target: { value: "# Hi" } });
    fireEvent.click(screen.getByTitle("保存"));
    await waitFor(() => expect(bridge.writeFile).toHaveBeenCalledWith("/s/SKILL.md", "# Hi"));
  });

  it(".json 走代码分支(非 Markdown 渲染)", async () => {
    const bridge = makeBridge({ readFile: vi.fn().mockResolvedValue({ content: '{"a":1}', truncated: false }) });
    const { container } = renderPreview("data.json", bridge);
    await waitFor(() => expect(bridge.readFile).toHaveBeenCalledWith("/s/data.json"));
    expect(container.querySelector(".pw-skill-code")).toBeTruthy();
    expect(container.querySelector(".pw-skill-md")).toBeNull();
  });

  it(".png 经 imageReadAny 回读并内联 <img>", async () => {
    const bridge = makeBridge();
    const { container } = renderPreview("logo.png", bridge);
    await waitFor(() => expect(bridge.imageReadAny).toHaveBeenCalledWith("/s/logo.png"));
    const img = await waitFor(() => {
      const el = container.querySelector<HTMLImageElement>(".pw-skill-img img");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
    // 图片不读文本。
    expect(bridge.readFile).not.toHaveBeenCalled();
  });

  it(".docx 走内置文档预览分支", async () => {
    const bridge = makeBridge();
    const { container } = renderPreview("report.docx", bridge);
    expect(container.querySelector(".pw-skill-doc")).toBeTruthy();
    // 不当作文本读。
    expect(bridge.readFile).not.toHaveBeenCalled();
  });

  it("未知二进制(.zip)显示占位并可交系统程序打开", async () => {
    const bridge = makeBridge();
    renderPreview("bundle.zip", bridge);
    const btn = await screen.findByText("用系统程序打开");
    fireEvent.click(btn);
    await waitFor(() => expect(bridge.openPath).toHaveBeenCalledWith("/s/bundle.zip"));
    expect(bridge.readFile).not.toHaveBeenCalled();
  });

  it("返回按钮调用 onClose", async () => {
    const bridge = makeBridge();
    const onClose = vi.fn();
    renderPreview("SKILL.md", bridge, onClose);
    fireEvent.click(screen.getByTitle("返回列表"));
    expect(onClose).toHaveBeenCalled();
  });
});
