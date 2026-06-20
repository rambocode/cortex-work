// ComposerShell 运行时插话（steer）门控（计划 U6）:仅 pi + running + onSteer 时,
// 运行中输入框可发插话(Enter/按钮 → onSteer);claude 运行中只剩停止按钮。

import type { ReactNode } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type AgentKind, type DesktopBridge, type PendingImage, type PersonalAttachment } from "@cortex-work/core";
import { ComposerShell } from "./ComposerShell";
import { FILE_DRAG_MIME } from "./FilesView";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

function renderShell(props: {
  agent: AgentKind;
  running: boolean;
  onSteer?: (text: string) => void;
  onStop?: () => void;
  onSend?: (text: string) => void;
  slashCommands?: { cmd: string; desc: string }[];
}) {
  const node: ReactNode = (
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <ComposerShell
        agent={props.agent}
        model={undefined}
        providerId={undefined}
        useOwnSkills={false}
        running={props.running}
        slashCommands={props.slashCommands}
        onSend={(t) => props.onSend?.(t)}
        onStop={props.onStop}
        onSteer={props.onSteer}
        onChangeModel={() => {}}
        onChangePiModel={() => {}}
        onToggleSkills={() => {}}
        onToast={() => {}}
      />
    </CoreProvider>
  );
  return render(node);
}

afterEach(() => {
  cleanup();
  usePersonalStore.setState({ providerSettings: { providers: [], defaultProviderId: undefined, defaultModel: undefined } });
});

describe("ComposerShell slash 键盘导航", () => {
  const CMDS = [
    { cmd: "/clear", desc: "清屏" },
    { cmd: "/compact", desc: "压缩" },
  ];

  it("输入 / → 列出命令,首项高亮", () => {
    const { container } = renderShell({ agent: "pi", running: false, slashCommands: CMDS });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "/" } });
    const items = container.querySelectorAll(".pw-slash-item");
    expect(items).toHaveLength(2);
    expect(items[0]?.className).toContain("is-active");
    expect(items[1]?.className).not.toContain("is-active");
  });

  it("↓ 移动高亮,Enter 执行高亮项", () => {
    const onSend = vi.fn();
    const { container } = renderShell({ agent: "pi", running: false, onSend, slashCommands: CMDS });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "/" } });
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    const items = container.querySelectorAll(".pw-slash-item");
    expect(items[1]?.className).toContain("is-active"); // 第二项高亮
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/compact");
  });

  it("↑ 循环到末项,Tab 执行高亮项", () => {
    const onSend = vi.fn();
    renderShell({ agent: "pi", running: false, onSend, slashCommands: CMDS });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "/" } });
    fireEvent.keyDown(ta, { key: "ArrowUp" }); // 首项再上 → 循环到末项
    fireEvent.keyDown(ta, { key: "Tab" });
    expect(onSend).toHaveBeenCalledWith("/compact");
  });

  it("Esc 收起下拉(Enter 不再执行命令而是正常发送)", () => {
    const onSend = vi.fn();
    const { container } = renderShell({ agent: "pi", running: false, onSend, slashCommands: CMDS });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "/clear" } });
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(container.querySelector(".pw-slash-item")).toBeNull(); // 已收起
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/clear"); // 走正常发送(交给 onSend 拦截层)
  });
});

describe("ComposerShell steer 门控（U6）", () => {
  it("底部工具条保留窄宽布局所需的稳定结构", () => {
    const { container } = renderShell({ agent: "codex", running: false });
    const foot = container.querySelector(".composer .comp-foot");
    const modelPill = container.querySelector(".composer .comp-foot .pw-model-pill");
    const send = container.querySelector(".composer .comp-foot .send");

    expect(foot).toBeInTheDocument();
    expect(modelPill).toBeInTheDocument();
    expect(send).toBeInTheDocument();
  });

  it("pi + running:输入回车 → onSteer(注入当前轮),不影响停止", () => {
    const onSteer = vi.fn();
    const onStop = vi.fn();
    renderShell({ agent: "pi", running: true, onSteer, onStop });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "往左走" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSteer).toHaveBeenCalledWith("往左走");
    // 停止按钮仍在。
    expect(screen.getByTitle("停止")).toBeInTheDocument();
  });

  it("pi + running:插话按钮存在,点击 → onSteer", () => {
    const onSteer = vi.fn();
    renderShell({ agent: "pi", running: true, onSteer, onStop: () => {} });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "改用方案B" } });
    fireEvent.click(screen.getByTitle(/插话/));
    expect(onSteer).toHaveBeenCalledWith("改用方案B");
  });

  it("claude + running:无插话能力,只显示停止按钮", () => {
    const onSteer = vi.fn();
    renderShell({ agent: "claude", running: true, onSteer, onStop: () => {} });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "x" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSteer).not.toHaveBeenCalled();
    expect(screen.queryByTitle(/插话/)).toBeNull();
    expect(screen.getByTitle("停止")).toBeInTheDocument();
  });

  it("pi 未运行:回车走正常发送,不 steer", () => {
    const onSteer = vi.fn();
    const onSend = vi.fn();
    renderShell({ agent: "pi", running: false, onSteer, onSend });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "新问题" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("新问题");
    expect(onSteer).not.toHaveBeenCalled();
  });
});

// 图片采集（U3）。用隐藏文件 input(可靠)为主、一条粘贴用例。
function renderFull(
  onSend: (t: string, a: PersonalAttachment[], imgs?: PendingImage[]) => void | boolean | Promise<void | boolean>,
  running = false,
) {
  return render(
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <ComposerShell
        agent="claude"
        model={undefined}
        providerId={undefined}
        useOwnSkills={false}
        running={running}
        onSend={onSend}
        onChangeModel={() => {}}
        onChangePiModel={() => {}}
        onToggleSkills={() => {}}
        onToast={() => {}}
      />
    </CoreProvider>,
  );
}

function pngFile(name: string, type = "image/png"): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, { type });
}

function pickImage(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe("ComposerShell 图片采集（U3）", () => {
  it("上传按钮存在(aria-label 可达)", () => {
    renderFull(() => true);
    expect(screen.getByLabelText("上传图片")).toBeInTheDocument();
  });

  it("选择图片 → 出现缩略图(alt + 移除按钮)", async () => {
    const { container } = renderFull(() => true);
    pickImage(container, pngFile("shot.png"));
    await waitFor(() => expect(container.querySelector(".img-attach-thumb")).toBeTruthy());
    expect((container.querySelector(".img-attach-thumb") as HTMLImageElement).alt).toBe("shot.png");
    expect(screen.getByLabelText("移除 shot.png")).toBeInTheDocument();
  });

  it("粘贴图片 → 出现缩略图", async () => {
    const { container } = renderFull(() => true);
    const ta = screen.getByRole("textbox");
    fireEvent.paste(ta, {
      clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => pngFile("p.png") }] },
    });
    await waitFor(() => expect(container.querySelector(".img-attach-thumb")).toBeTruthy());
  });

  it("不支持格式被拒(不进缩略图)", async () => {
    const { container } = renderFull(() => true);
    pickImage(container, pngFile("a.svg", "image/svg+xml"));
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector(".img-attach")).toBeNull();
  });

  it("纯图(无文本)可发:send 携带 images;consumed=true 后清空缩略图", async () => {
    const onSend = vi.fn<(t: string, a: PersonalAttachment[], imgs?: PendingImage[]) => boolean>(() => true);
    const { container } = renderFull(onSend);
    pickImage(container, pngFile("a.png"));
    await waitFor(() => expect(container.querySelector(".img-attach-thumb")).toBeTruthy());
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const imgs = onSend.mock.calls[0]?.[2] as PendingImage[] | undefined;
    expect(imgs?.length).toBe(1);
    await waitFor(() => expect(container.querySelector(".img-attach")).toBeNull());
  });

  it("未消费(onSend 返回 false)→ 待发图保留(KTD9)", async () => {
    const onSend = vi.fn(() => false);
    const { container } = renderFull(onSend);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "x" } });
    pickImage(container, pngFile("a.png"));
    await waitFor(() => expect(container.querySelector(".img-attach-thumb")).toBeTruthy());
    fireEvent.click(screen.getByTitle("发送 (Enter)"));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(container.querySelector(".img-attach")).toBeTruthy(); // 未消费 → 保留
  });

  it("移除缩略图", async () => {
    const { container } = renderFull(() => true);
    pickImage(container, pngFile("a.png"));
    await waitFor(() => expect(container.querySelector(".img-attach-thumb")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("移除 a.png"));
    expect(container.querySelector(".img-attach")).toBeNull();
  });

  it("同名同尺寸去重(选两次同一文件只留一张)", async () => {
    const { container } = renderFull(() => true);
    pickImage(container, pngFile("dup.png"));
    await waitFor(() => expect(container.querySelectorAll(".img-attach").length).toBe(1));
    pickImage(container, pngFile("dup.png"));
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelectorAll(".img-attach").length).toBe(1);
  });
});

describe("ComposerShell 文件预览拖入会话（U6）", () => {
  function fileBridge(readFile: (p: string) => Promise<{ content: string; truncated: boolean }>): DesktopBridge {
    return { loadChat: async () => [], saveChat: async () => {}, readFile: vi.fn(readFile) } as unknown as DesktopBridge;
  }

  function renderWithBridge(b: DesktopBridge) {
    return render(
      <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={b}>
        <ComposerShell
          agent="claude"
          model={undefined}
          providerId={undefined}
          useOwnSkills={false}
          running={false}
          onSend={() => true}
          onChangeModel={() => {}}
          onChangePiModel={() => {}}
          onToggleSkills={() => {}}
          onToast={() => {}}
        />
      </CoreProvider>,
    );
  }

  function dropFile(container: HTMLElement, payload: { path: string; name: string }) {
    const composer = container.querySelector(".composer")!;
    const data: Record<string, string> = { [FILE_DRAG_MIME]: JSON.stringify(payload) };
    fireEvent.drop(composer, {
      dataTransfer: { getData: (type: string) => data[type] ?? "", types: [FILE_DRAG_MIME], files: [] },
    });
  }

  it("拖入文件 → readFile 并出现附件 pill(显示文件名)", async () => {
    const b = fileBridge(async () => ({ content: "# 文件内容", truncated: false }));
    const { container } = renderWithBridge(b);
    dropFile(container, { path: "/p/notes.md", name: "notes.md" });
    await waitFor(() => expect(screen.getByText("notes.md")).toBeInTheDocument());
    expect(b.readFile as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("/p/notes.md");
  });

  it("含 name: frontmatter 的普通文件名不被 deriveSkillName 改写", async () => {
    const b = fileBridge(async () => ({ content: "---\nname: 无关技能名\n---\n", truncated: false }));
    const { container } = renderWithBridge(b);
    dropFile(container, { path: "/p/config.md", name: "config.md" });
    await waitFor(() => expect(screen.getByText("config.md")).toBeInTheDocument());
    expect(screen.queryByText("无关技能名")).toBeNull(); // 文件名保持,未被 frontmatter name 污染
  });

  it("同路径重复拖入 → 去重 no-op,不新增第二枚 pill", async () => {
    const b = fileBridge(async () => ({ content: "x", truncated: false }));
    const { container } = renderWithBridge(b);
    dropFile(container, { path: "/p/a.md", name: "a.md" });
    await waitFor(() => expect(container.querySelectorAll(".attach-pill").length).toBe(1));
    dropFile(container, { path: "/p/a.md", name: "a.md" });
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelectorAll(".attach-pill").length).toBe(1);
  });
});
