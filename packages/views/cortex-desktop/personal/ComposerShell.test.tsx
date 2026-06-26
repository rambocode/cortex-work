// ComposerShell 运行时插话（steer）门控（计划 U6）:仅 pi + running + onSteer 时,
// 运行中输入框可发插话(Enter/按钮 → onSteer);claude 运行中只剩停止按钮。

import type { ReactNode } from "react";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type AgentKind, type DesktopBridge, type PendingImage, type PersonalAttachment } from "@cortex-work/core";
import type { AsrSettings } from "@cortex-work/core/desktop/media-gen-types";
import type { LocalWhisperModelStatus } from "@cortex-work/core/whisper/models";
import { ComposerShell, type SlashCommand } from "./ComposerShell";
import { FILE_DRAG_MIME } from "./FilesView";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

function renderShell(props: {
  agent: AgentKind;
  running: boolean;
  onSteer?: (text: string) => void;
  onStop?: () => void;
  onSend?: (text: string) => void;
  slashCommands?: SlashCommand[];
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

describe("ComposerShell slash skill 项(argHint + 插入模式 + KTD7)", () => {
  const SKILL_CMDS: SlashCommand[] = [
    { cmd: "/clear", desc: "清屏", kind: "builtin" },
    { cmd: "/skill:agent-browser", desc: "浏览器自动化", argHint: "<url>", kind: "skill" },
  ];

  it("R4:skill 项渲染 argHint;内建项不渲染 argHint", () => {
    const { container } = renderShell({ agent: "pi", running: false, slashCommands: SKILL_CMDS });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    const args = container.querySelectorAll(".pw-slash-arg");
    expect(args).toHaveLength(1);
    expect(args[0]?.textContent).toBe("<url>");
  });

  it("R5:选 skill 项 → 插入 '/skill:name '、不发送、菜单关闭(KTD7),随后 Enter 发送", () => {
    const onSend = vi.fn();
    const { container } = renderShell({ agent: "pi", running: false, onSend, slashCommands: SKILL_CMDS });
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "/skill" } });
    fireEvent.keyDown(ta, { key: "Enter" }); // 选中高亮的 skill 项
    expect(onSend).not.toHaveBeenCalled(); // skill 不立即发送
    expect(ta.value).toBe("/skill:agent-browser "); // 插入带尾随空格
    expect(container.querySelector(".pw-slash-item")).toBeNull(); // 有空格 → 菜单关闭
    // 模拟填参后回车发送。
    fireEvent.change(ta, { target: { value: "/skill:agent-browser https://x.com" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/skill:agent-browser https://x.com");
  });

  it("KTD4:高亮 skill 项动作提示为「插入」,内建为「执行/运行」", () => {
    const { container } = renderShell({ agent: "pi", running: false, slashCommands: SKILL_CMDS });
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "/" } });
    // 首项 /clear(内建)高亮 → 运行提示。
    expect(container.querySelector(".pw-slash-item.is-active .pw-slash-kbd")?.textContent).toMatch(/执行|运行|run/i);
    fireEvent.keyDown(ta, { key: "ArrowDown" }); // 高亮 skill 项
    expect(container.querySelector(".pw-slash-item.is-active .pw-slash-kbd")?.textContent).toMatch(/插入|insert/i);
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

  it("非 Pi agent 也渲染思考强度选择器", () => {
    renderShell({ agent: "claude", running: false });
    expect(screen.getByTitle("思考强度")).toBeInTheDocument();
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

// composerInsert 的 submit 标志:tasks「插入并运行」自动提交（U2）。
describe("ComposerShell 插入并运行（submit 标志）", () => {
  function renderInsert(opts: {
    onSend: (t: string, a: PersonalAttachment[], imgs?: PendingImage[]) => void | boolean | Promise<void | boolean>;
    running?: boolean;
    accept?: boolean;
  }) {
    return render(
      <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
        <ComposerShell
          agent="claude"
          model={undefined}
          providerId={undefined}
          useOwnSkills={false}
          running={opts.running ?? false}
          acceptComposerInsert={opts.accept ?? true}
          onSend={opts.onSend}
          onChangeModel={() => {}}
          onChangePiModel={() => {}}
          onToggleSkills={() => {}}
          onToast={() => {}}
        />
      </CoreProvider>,
    );
  }

  it("submit:true 且空闲 → 以插入文本自动提交", async () => {
    const onSend = vi.fn(() => true);
    renderInsert({ onSend });
    act(() => usePersonalStore.getState().insertToComposer("跑这个", { submit: true }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("跑这个", expect.anything(), undefined, undefined));
  });

  it("submit 缺省 → 只插入不发送", async () => {
    const onSend = vi.fn(() => true);
    renderInsert({ onSend });
    act(() => usePersonalStore.getState().insertToComposer("仅插入"));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("仅插入"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("submit:true 但 running → 降级为仅插入", async () => {
    const onSend = vi.fn(() => true);
    renderInsert({ onSend, running: true });
    act(() => usePersonalStore.getState().insertToComposer("运行中", { submit: true }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("运行中"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("acceptComposerInsert=false → 既不插入也不发送", async () => {
    const onSend = vi.fn(() => true);
    renderInsert({ onSend, accept: false });
    act(() => usePersonalStore.getState().insertToComposer("忽略", { submit: true }));
    await Promise.resolve();
    expect(onSend).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("composerInsert 携带 images → 文本插入 + 缩略图并入 composer(U4 批注始终包含截图)", async () => {
    const onSend = vi.fn(() => true);
    const { container } = renderInsert({ onSend });
    const img: PendingImage = {
      id: "shot1",
      name: "annotation.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      data: new ArrayBuffer(8),
    };
    act(() => usePersonalStore.getState().insertToComposer("标注内容", { images: [img] }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("标注内容"));
    expect(container.querySelector(".img-attach-thumb")).toBeTruthy();
  });
});

describe("ComposerShell 文件预览拖入会话（U6）", () => {
  function fileBridge(readFile: (p: string) => Promise<{ content: string; truncated: boolean }>): DesktopBridge {
    return { loadChat: async () => [], saveChat: async () => {}, readFile: vi.fn(readFile) } as unknown as DesktopBridge;
  }

  function renderWithBridge(b: DesktopBridge, onToast: (t: string) => void = () => {}) {
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
          onToast={onToast}
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

  it("拖入二进制文档(.pdf) → 走文档通道出现文件 chip,不调 readFile", async () => {
    const b = fileBridge(async () => ({ content: "不该被读到", truncated: false }));
    const { container } = renderWithBridge(b);
    dropFile(container, { path: "/p/report.pdf", name: "report.pdf" });
    await waitFor(() => expect(screen.getByText("report.pdf")).toBeInTheDocument());
    expect(b.readFile as ReturnType<typeof vi.fn>).not.toHaveBeenCalled(); // 二进制文档不走 readFile
  });

  it("拖入文本文件(.md) → 仍走 readFile 注入(不改道文档通道,零回归)", async () => {
    const b = fileBridge(async () => ({ content: "# 笔记", truncated: false }));
    const { container } = renderWithBridge(b);
    dropFile(container, { path: "/p/note.md", name: "note.md" });
    await waitFor(() => expect(screen.getByText("note.md")).toBeInTheDocument());
    expect(b.readFile as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("/p/note.md");
  });

  it("truncated:true → toast 提示文件过大截断(composer.fileTruncated)", async () => {
    const b = fileBridge(async () => ({ content: "巨长内容", truncated: true }));
    const onToast = vi.fn();
    const { container } = renderWithBridge(b, onToast);
    dropFile(container, { path: "/p/big.md", name: "big.md" });
    await waitFor(() => expect(container.querySelectorAll(".attach-pill").length).toBe(1));
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("big.md")); // fileTruncated 含文件名
  });

  it("readFile 失败 → 走 catch 给可读 toast,不新增 pill、不崩", async () => {
    const b = fileBridge(async () => {
      throw new Error("ENOENT");
    });
    const onToast = vi.fn();
    const { container } = renderWithBridge(b, onToast);
    dropFile(container, { path: "/p/gone.md", name: "gone.md" });
    await waitFor(() => expect(onToast).toHaveBeenCalled());
    expect(container.querySelectorAll(".attach-pill").length).toBe(0); // 失败不入附件
  });
});

// ── U9：语音按钮可用条件（R11）与 transcribeSpeech 路由 ──────────────────────────

/** 构造 bridge，带 transcribeSpeech 或不带，以及 whisper 模型状态。 */
function makeBridge(opts: {
  transcribeSpeech?: (req: unknown, asr: unknown) => Promise<{ text: string }>;
  getWhisperModelStatus?: (modelId: string) => Promise<LocalWhisperModelStatus>;
  onWhisperDownloadProgress?: (cb: (p: unknown) => void) => () => void;
}): DesktopBridge {
  return {
    loadChat: async () => [],
    saveChat: async () => {},
    readFile: async () => ({ content: "", truncated: false }),
    ...opts,
  } as unknown as DesktopBridge;
}

function makeAsrSettings(overrides: Partial<AsrSettings> = {}): AsrSettings {
  return {
    enabled: true,
    providerId: "openai",
    protocol: "openai-transcriptions",
    baseUrl: "http://localhost:8080",
    apiKey: "test-key",
    model: "whisper-1",
    localWhisperDownloadSource: "huggingface",
    language: "zh",
    timeoutMs: 60_000,
    ...overrides,
  };
}

function makeLocalStatus(state: LocalWhisperModelStatus["state"]): LocalWhisperModelStatus {
  return {
    modelId: "whisper-small-q5_1",
    label: "Whisper Small",
    fileName: "ggml-small-q5_1.bin",
    sha256: "ae85",
    sizeBytes: 190_085_487,
    maxBytes: 400 * 1024 * 1024,
    resourceEstimate: { memory: "300-600 MB", cpuThreads: "2-4" },
    qualityTier: "balanced",
    recommended: true,
    state,
    downloadedBytes: state === "downloading" ? 50_000_000 : undefined,
    totalBytes: state === "downloading" ? 190_085_487 : undefined,
  };
}

/** 渲染 ComposerShell，注入自定义 bridge 和 asrSettings。 */
function renderVoice(bridge: DesktopBridge, asrSettings?: AsrSettings, onToast = vi.fn()) {
  if (asrSettings) {
    // 在 store 中预置 asrSettings，让 ComposerShell 能从 store 读到
    usePersonalStore.setState({ asrSettings });
  }
  return render(
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
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
        onToast={onToast}
      />
    </CoreProvider>,
  );
}

describe("ComposerShell 语音按钮可用条件（U9 R11）", () => {
  afterEach(() => {
    cleanup();
    // 重置 store，下次渲染从默认（enabled:false）开始
    usePersonalStore.setState({ asrSettings: undefined as unknown as AsrSettings });
  });

  it("STT disabled → 语音按钮隐藏", () => {
    const b = makeBridge({ transcribeSpeech: async () => ({ text: "x" }) });
    renderVoice(b, makeAsrSettings({ enabled: false }));
    // micVisible 为 false → pw-mic-btn 不渲染
    expect(document.querySelector(".pw-mic-btn")).toBeNull();
  });

  it("bridge 无 transcribeSpeech 能力 → 语音按钮隐藏", () => {
    // bridge 没有 transcribeSpeech 方法
    const b = makeBridge({});
    renderVoice(b, makeAsrSettings({ enabled: true }));
    expect(document.querySelector(".pw-mic-btn")).toBeNull();
  });

  it("在线协议配置就绪（有 baseUrl）→ 按钮显示且可点击", async () => {
    const b = makeBridge({ transcribeSpeech: async () => ({ text: "hello" }) });
    renderVoice(b, makeAsrSettings({ protocol: "openai-transcriptions", baseUrl: "http://api.test", enabled: true }));
    await waitFor(() => expect(document.querySelector(".pw-mic-btn")).not.toBeNull());
    const btn = document.querySelector(".pw-mic-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("在线协议 baseUrl 为空 → 按钮禁用（配置不就绪）", async () => {
    const b = makeBridge({ transcribeSpeech: async () => ({ text: "hello" }) });
    renderVoice(b, makeAsrSettings({ protocol: "openai-transcriptions", baseUrl: "", enabled: true }));
    await waitFor(() => expect(document.querySelector(".pw-mic-btn")).not.toBeNull());
    const btn = document.querySelector(".pw-mic-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("本地协议模型 ready → 按钮可点击", async () => {
    const b = makeBridge({
      transcribeSpeech: async () => ({ text: "hello" }),
      getWhisperModelStatus: async () => makeLocalStatus("ready"),
    });
    renderVoice(b, makeAsrSettings({ protocol: "local-whisper", model: "whisper-small-q5_1", enabled: true }));
    await waitFor(() => {
      const btn = document.querySelector(".pw-mic-btn") as HTMLButtonElement | null;
      return btn && !btn.disabled;
    });
    const btn = document.querySelector(".pw-mic-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("本地协议模型 downloading → 按钮禁用，tooltip 含百分比", async () => {
    const b = makeBridge({
      transcribeSpeech: async () => ({ text: "hello" }),
      getWhisperModelStatus: async () => makeLocalStatus("downloading"),
    });
    renderVoice(b, makeAsrSettings({ protocol: "local-whisper", model: "whisper-small-q5_1", enabled: true }));
    await waitFor(() => {
      const btn = document.querySelector(".pw-mic-btn") as HTMLButtonElement | null;
      return btn !== null;
    });
    const btn = document.querySelector(".pw-mic-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // tooltip 应含下载中文案（含 % 字样或中文「下载中」）
    expect(btn.title).toMatch(/下载中|downloading/i);
  });

  it("本地协议模型 missing → 按钮禁用，tooltip 含「未就绪」", async () => {
    const b = makeBridge({
      transcribeSpeech: async () => ({ text: "hello" }),
      getWhisperModelStatus: async () => makeLocalStatus("missing"),
    });
    renderVoice(b, makeAsrSettings({ protocol: "local-whisper", model: "whisper-small-q5_1", enabled: true }));
    await waitFor(() => {
      const btn = document.querySelector(".pw-mic-btn") as HTMLButtonElement | null;
      return btn !== null;
    });
    const btn = document.querySelector(".pw-mic-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/未就绪|not ready/i);
  });
});

describe("ComposerShell 转写路由与失败处理（U9）", () => {
  // 因 jsdom 没有 AudioContext / MediaRecorder，无法走完整录音链路。
  // 测试重点：bridge 不支持录音时，点击麦克风按钮后 onToast 被调用（含「不支持」字样）；
  // 且输入框已有内容不会被清空（失败不清空输入框的约束）。

  afterEach(() => {
    cleanup();
    usePersonalStore.setState({ asrSettings: undefined as unknown as AsrSettings });
  });

  it("转写失败（bridge 无 transcribeSpeech）→ 点击麦克风触发 onToast，输入框内容不变", async () => {
    // bridge 有 transcribeSpeech 但 jsdom 无 getUserMedia → 录音失败 → toast
    // 注：useComposerVoice 中若 navigator.mediaDevices?.getUserMedia 不存在，
    // startRecording 会直接调用 onToast("当前浏览器不支持录音")，无需真实录音。
    const b = makeBridge({ transcribeSpeech: async () => ({ text: "x" }) });
    const onToast = vi.fn();
    renderVoice(b, makeAsrSettings({ protocol: "openai-transcriptions", baseUrl: "http://api.test" }), onToast);

    // 等待麦克风按钮渲染
    await waitFor(() => expect(document.querySelector(".pw-mic-btn")).not.toBeNull());

    // 输入框预填内容，验证失败后不被清空
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "已输入的文字" } });
    expect(ta.value).toBe("已输入的文字");

    // 点击麦克风按钮；jsdom 无 MediaRecorder → startRecording 触发 onToast
    fireEvent.click(document.querySelector(".pw-mic-btn")!);

    // onToast 应被调用，输入框内容保持不变
    await waitFor(() => expect(onToast).toHaveBeenCalled());
    expect(onToast.mock.calls[0]?.[0]).toMatch(/录音|转写|支持/);
    expect(ta.value).toBe("已输入的文字");
  });
});
