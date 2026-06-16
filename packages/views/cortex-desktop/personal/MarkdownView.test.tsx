import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge } from "@cortex-work/core";

// mermaid 默认导出 mock:可控 initialize / render(静态 import 由本 mock 接管)。
const mermaidInitialize = vi.fn();
const mermaidRender = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => mermaidInitialize(...args),
    render: (...args: unknown[]) => mermaidRender(...args),
  },
}));

// 在 mock 之后导入被测组件。
const { MarkdownView } = await import("./MarkdownView");

const bridge = { openExternal: vi.fn() } as unknown as DesktopBridge;

function setClipboard(writeText: ReturnType<typeof vi.fn> | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
    writable: true,
  });
}

function renderMd(content: string) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <div className="pw-todo-md">
        <MarkdownView content={content} />
      </div>
    </CoreProvider>,
  );
}

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```";

describe("MarkdownView 代码高亮与复制", () => {
  beforeEach(() => {
    // 注意:不重置 mermaidInitialize —— 用它验证模块级单例(全程仅一次)。
    mermaidRender.mockReset();
    mermaidRender.mockResolvedValue({ svg: "<svg data-mmd='1'></svg>" });
    setClipboard(vi.fn().mockResolvedValue(undefined));
  });
  afterEach(() => cleanup());

  it("有语言的围栏块 → 注入 hljs 高亮 span", () => {
    const { container } = renderMd(fence("js", "const x = 1;"));
    expect(container.querySelector("code.hljs")).not.toBeNull();
    // js 的 const 是关键字 → 高亮为 .hljs-keyword,证明高亮已生效。
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
  });

  it("无语言围栏块 → 不报错、文本原样、仍在 .pw-md-codeblock 外壳内", () => {
    const { container } = renderMd("```\nplain text\n```");
    const block = container.querySelector(".pw-md-codeblock");
    expect(block).not.toBeNull();
    expect(block!.textContent).toContain("plain text");
  });

  it("行内 code → 不进 .pw-md-codeblock,无复制按钮", () => {
    const { container } = renderMd("用 `foo` 调用");
    expect(container.querySelector(".pw-md-codeblock")).toBeNull();
    expect(container.querySelector(".pw-md-copy")).toBeNull();
    expect(container.querySelector("code")).not.toBeNull();
  });

  it("复制按钮点击 → 写入剪贴板,入参为代码原文(跨高亮 span 取文正确)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const { container } = renderMd(fence("js", "const x = 1;"));
    const btn = container.querySelector(".pw-md-copy") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const x = 1;"));
  });

  it("复制后按钮进入 data-copied 反馈态", async () => {
    const { container } = renderMd(fence("js", "const x = 1;"));
    const btn = container.querySelector(".pw-md-copy") as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("data-copied")).toBe("true"));
  });

  it("navigator.clipboard 不可用 → 点击不抛错", () => {
    setClipboard(undefined);
    const { container } = renderMd(fence("js", "const x = 1;"));
    const btn = container.querySelector(".pw-md-copy") as HTMLButtonElement;
    expect(() => fireEvent.click(btn)).not.toThrow();
  });
});

describe("MarkdownView mermaid 渲染", () => {
  beforeEach(() => {
    mermaidRender.mockReset();
    mermaidRender.mockResolvedValue({ svg: "<svg data-mmd='1'></svg>" });
    setClipboard(vi.fn().mockResolvedValue(undefined));
  });
  afterEach(() => cleanup());

  it("mermaid 块 → 渲染注入的 svg,且不带复制壳", async () => {
    const { container } = renderMd(fence("mermaid", "flowchart TD\n  A-->B"));
    await waitFor(() => expect(container.querySelector(".pw-md-mermaid svg")).not.toBeNull());
    expect(container.querySelector(".pw-md-codeblock")).toBeNull();
    expect(container.querySelector(".pw-md-copy")).toBeNull();
    // render 收到 mermaid 源码(去尾换行)。
    expect(mermaidRender).toHaveBeenCalledWith(expect.stringMatching(/^mmd-/), "flowchart TD\n  A-->B");
  });

  it("mermaid 渲染失败 → 降级显示原始源码,不影响其他内容", async () => {
    mermaidRender.mockReset();
    mermaidRender.mockRejectedValue(new Error("parse error"));
    const { container } = renderMd("# 标题\n\n" + fence("mermaid", "bad-syntax"));
    await waitFor(() => expect(container.querySelector(".pw-md-mermaid-error")).not.toBeNull());
    expect(container.querySelector(".pw-md-mermaid-error")!.textContent).toContain("bad-syntax");
    // 标题等其他内容仍正常渲染。
    expect(container.querySelector("h1")).not.toBeNull();
  });

  it("多个 mermaid 块 → 各自 render 收到互异的 id", async () => {
    const md = fence("mermaid", "flowchart TD\n  A-->B") + "\n\n" + fence("mermaid", "sequenceDiagram\n  A->>B: hi");
    renderMd(md);
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(2));
    const id1 = mermaidRender.mock.calls[0]![0];
    const id2 = mermaidRender.mock.calls[1]![0];
    expect(id1).not.toBe(id2);
  });

  it("组件卸载后 render resolve 不触发 setState(mounted 守护)", async () => {
    let resolveRender: (v: { svg: string }) => void = () => {};
    mermaidRender.mockReset();
    mermaidRender.mockReturnValue(
      new Promise<{ svg: string }>((res) => {
        resolveRender = res;
      }),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderMd(fence("mermaid", "flowchart TD\n  A-->B"));
    await waitFor(() => expect(mermaidRender).toHaveBeenCalled());
    unmount();
    resolveRender({ svg: "<svg></svg>" });
    await Promise.resolve();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("mermaid.initialize 全程仅调用一次(模块级单例)", () => {
    // 前面的 mermaid 测试已触发渲染;无论多少块,initialize 累计仅一次。
    expect(mermaidInitialize).toHaveBeenCalledTimes(1);
    expect(mermaidInitialize).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false }));
  });
});

describe("MarkdownView 综合冒烟", () => {
  beforeEach(() => {
    mermaidRender.mockReset();
    mermaidRender.mockResolvedValue({ svg: "<svg data-mmd='1'></svg>" });
    setClipboard(vi.fn().mockResolvedValue(undefined));
  });
  afterEach(() => cleanup());

  it("frontmatter + callout + 高亮代码 + mermaid 一次性渲染无异常", async () => {
    const doc = [
      "---",
      "title: 示例",
      "---",
      "",
      "> [!important] 提示内容",
      "",
      fence("js", "const x = 1;"),
      "",
      fence("mermaid", "flowchart TD\n  A-->B"),
    ].join("\n");
    const { container } = renderMd(doc);
    expect(container.querySelector(".pw-md-fm")).not.toBeNull();
    expect(container.querySelector(".pw-md-codeblock")).not.toBeNull();
    expect(container.querySelector(".hljs-keyword")).not.toBeNull();
    await waitFor(() => expect(container.querySelector(".pw-md-mermaid svg")).not.toBeNull());
  });
});
