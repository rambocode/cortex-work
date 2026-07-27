// ComposerShell 运行时插话（steer）门控（计划 U6）:仅 pi + running + onSteer 时,
// 运行中输入框可发插话(Enter/按钮 → onSteer);claude 运行中只剩停止按钮。

import type { ReactNode } from "react";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type AgentKind, type DerivedAgentMeta, type DesktopBridge, type PendingImage, type PersonalAttachment } from "@cortex-work/core";
import { defaultAsrSettings, type AsrSettings } from "@cortex-work/core/desktop/media-gen-types";
import type { LocalWhisperModelStatus } from "@cortex-work/core/whisper/models";
import { ComposerShell, matchSlashCommands, rankSlashMatch, type SlashCommand } from "./ComposerShell";
import { FILE_DRAG_MIME } from "./FilesView";
import { DOC_ACCEPT_ATTR } from "./docIntake";

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
        onChangeThinking={() => {}}
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

describe("slash 模糊匹配 rankSlashMatch / matchSlashCommands", () => {
  const CMDS: SlashCommand[] = [
    { cmd: "/clear", desc: "清屏" },
    { cmd: "/compact", desc: "压缩" },
    { cmd: "/skill:agent-browser", desc: "浏览器" },
    { cmd: "/skill:code-review", desc: "评审" },
  ];

  it("rankSlashMatch:前缀=0、去斜杠子串=1、子序列=2、不匹配=-1", () => {
    expect(rankSlashMatch("/cl", "/clear")).toBe(0); // 前缀
    expect(rankSlashMatch("/browser", "/skill:agent-browser")).toBe(1); // 去斜杠子串 "browser"
    expect(rankSlashMatch("/agbr", "/skill:agent-browser")).toBe(2); // 子序列 /,a,g,b,r
    expect(rankSlashMatch("/xyz", "/clear")).toBe(-1);
    expect(rankSlashMatch("/", "/clear")).toBe(0); // 裸 / → 前缀命中全部
  });

  it("matchSlashCommands:'/br' 命中 agent-browser(旧前缀匹配匹配不到)", () => {
    const out = matchSlashCommands("/br", CMDS).map((c) => c.cmd);
    expect(out).toContain("/skill:agent-browser");
    expect(out).not.toContain("/clear");
  });

  it("matchSlashCommands:按档位排序,前缀命中排在子串/子序列前", () => {
    // "/c" 前缀命中 /clear /compact /skill:code-review? "/c" 前缀:/clear /compact(是),/skill:code-review 否(前缀是 /s)
    // 但 code-review 含 "c" 子串 → 档 1。前缀两项应排前。
    const out = matchSlashCommands("/c", CMDS).map((c) => c.cmd);
    expect(out.slice(0, 2)).toEqual(["/clear", "/compact"]);
    expect(out).toContain("/skill:code-review");
  });

  it("matchSlashCommands:裸 / → 保留全部原顺序", () => {
    expect(matchSlashCommands("/", CMDS).map((c) => c.cmd)).toEqual(CMDS.map((c) => c.cmd));
  });
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

describe("ComposerShell slash skill 项(argHint + pill 模式 + KTD7)", () => {
  const SKILL_CMDS: SlashCommand[] = [
    { cmd: "/clear", desc: "清屏", kind: "builtin" },
    { cmd: "/skill:agent-browser", displayName: "Agent Browser", desc: "浏览器自动化", argHint: "<url>", kind: "skill" },
  ];

  it("R4:skill 项渲染 argHint;内建项不渲染 argHint", () => {
    const { container } = renderShell({ agent: "pi", running: false, slashCommands: SKILL_CMDS });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "/" } });
    const args = container.querySelectorAll(".pw-slash-arg");
    expect(args).toHaveLength(1);
    expect(args[0]?.textContent).toBe("<url>");
  });

  it("R5(选项1):选 skill 项 → 显示 pill、清空输入、不发送;填参后 Enter 拼回 /skill:name args", () => {
    const onSend = vi.fn();
    const { container } = renderShell({ agent: "pi", running: false, onSend, slashCommands: SKILL_CMDS });
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "/skill" } });
    fireEvent.keyDown(ta, { key: "Enter" }); // 选中高亮的 skill 项
    expect(onSend).not.toHaveBeenCalled(); // skill 不立即发送
    expect(container.querySelector(".pw-skill-pill")).not.toBeNull(); // 显示 skill pill
    expect(screen.getByText("Agent Browser")).toBeTruthy(); // 友好名
    expect(ta.value).toBe(""); // 输入框清空供填参(不再插入 /skill:name 文本)
    expect(container.querySelector(".pw-slash-item")).toBeNull(); // 菜单关闭
    // 填参后回车 → pill 的 cmd 与参数拼回 /skill:name args。
    fireEvent.change(ta, { target: { value: "https://x.com" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onSend.mock.calls.at(-1)?.[0]).toBe("/skill:agent-browser https://x.com");
  });

  it("del:参数为空时 Backspace 删除已选 skill chip", () => {
    const { container } = renderShell({ agent: "pi", running: false, slashCommands: SKILL_CMDS });
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "/skill" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(container.querySelector(".pw-skill-pill")).not.toBeNull();
    fireEvent.keyDown(ta, { key: "Backspace" }); // 空参数 + 退格 → 移除 chip
    expect(container.querySelector(".pw-skill-pill")).toBeNull();
  });

  it("无参数直接 Enter → 仅发送 /skill:name", () => {
    const onSend = vi.fn();
    renderShell({ agent: "pi", running: false, onSend, slashCommands: SKILL_CMDS });
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "/skill" } });
    fireEvent.keyDown(ta, { key: "Enter" }); // 选中 → pill
    fireEvent.keyDown(ta, { key: "Enter" }); // 空参数直接发送
    expect(onSend.mock.calls.at(-1)?.[0]).toBe("/skill:agent-browser");
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

  it("非 Pi agent:合并 pill 打开后含推理强度区", () => {
    const { container } = renderShell({ agent: "claude", running: false });
    fireEvent.click(container.querySelector(".pw-mt-trigger")!);
    // 菜单含「推理」分区表头。
    expect(screen.getByText("推理")).toBeInTheDocument();
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
  it("合并「+」按钮:单个入口存在,点击弹出「文件」与「Skills」菜单项", () => {
    const { container } = renderFull(() => true);
    // 工具栏只剩一个「+」入口(aria-label「添加文件 / Skills」),图片/文档/Skills 都收进菜单。
    const trigger = screen.getByLabelText("添加文件 / Skills");
    expect(trigger).toBeInTheDocument();
    expect(container.querySelector(".pw-tb-menu")).toBeNull(); // 默认收起
    fireEvent.click(trigger);
    // 菜单上弹(避免被 GitBar/终端遮挡),含「文件」与「Skills」两项。
    expect(container.querySelector(".pw-tb-menu.pw-tb-menu--up")).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "文件" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: /Skills/ })).toBeInTheDocument();
  });

  it("点击菜单「文件」→ 触发统一文件选择(accept 含图片与文档)并收起菜单", () => {
    const { container } = renderFull(() => true);
    // 仅一个隐藏 input:同时接受图片与文档类型。
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.getAttribute("accept")).toContain("image/png");
    expect(input.getAttribute("accept")).toContain(DOC_ACCEPT_ATTR);
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByLabelText("添加文件 / Skills"));
    fireEvent.click(screen.getByRole("menuitem", { name: "文件" }));
    expect(clickSpy).toHaveBeenCalled();
    expect(container.querySelector(".pw-tb-menu")).toBeNull(); // 选完收起
  });

  it("点击菜单「Skills」→ 触发 onToggleSkills 且菜单保持展开(可见状态变化)", () => {
    const onToggleSkills = vi.fn();
    const { container } = render(
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
          onToggleSkills={onToggleSkills}
          onToast={() => {}}
        />
      </CoreProvider>,
    );
    fireEvent.click(screen.getByLabelText("添加文件 / Skills"));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Skills/ }));
    expect(onToggleSkills).toHaveBeenCalledTimes(1);
    // Skills 是开关,点击后菜单不收起,便于看到当前状态。
    expect(container.querySelector(".pw-tb-menu")).not.toBeNull();
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
describe("ComposerShell 发送即乐观清空（问题1回归）", () => {
  // 回归:回车发送后必须「发送瞬间」清空输入框,不能等 onSend 的 Promise resolve。
  // core 的 send 直到 agent 本轮流式结束才 resolve,若把 setText("") 留到 await 之后,
  // 输入框文字会滞留到本轮 agent 跑完(用户报告的 bug)。此处 onSend 返回一个「挂起」的
  // Promise 模拟 agent 仍在跑,断言 textarea 在其 resolve 前就已清空。
  it("回车后立即清空输入框,不等 onSend(agent 本轮)结束", async () => {
    let resolveSend!: (v: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((r) => (resolveSend = r)));
    renderFull(onSend);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "还在跑的问题" } });
    expect(ta.value).toBe("还在跑的问题");
    fireEvent.keyDown(ta, { key: "Enter" });
    // onSend 已被调用(消息已发出),但其 Promise 尚未 resolve(agent 仍在跑)。
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    // 核心断言:此刻输入框已清空(乐观清空);修复前 setText 在 await 之后 → 这里仍是原文,断言失败。
    expect(ta.value).toBe("");
    // 收尾:resolve 掉挂起的 Promise,避免悬挂 / act 警告。
    await act(async () => resolveSend(true));
  });
});

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

  // 落地页场景 chip:纯预置 skill pill（text 为空），用户补主题后回车才拼成 `/skill:xxx 主题`。
  it("composerInsert 携带 skill → 出现 skill pill,补主题回车发出 `/skill:slides 主题`", async () => {
    const onSend = vi.fn(() => true);
    renderInsert({ onSend });
    act(() =>
      usePersonalStore.getState().insertToComposer("", { skill: { cmd: "/skill:slides", displayName: "Slides" } }),
    );
    await waitFor(() => expect(screen.getByText("Slides")).toBeInTheDocument());
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.value).toBe("");
    fireEvent.change(ta, { target: { value: "季度汇报" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("/skill:slides 季度汇报", expect.anything(), undefined, undefined),
    );
  });

  // 产物 pill 的标题来自用户那句话,可能很长(点场景示例填入的提示词就是整段需求)。
  // 视觉上靠 CSS 省略号截断,但截掉的部分必须能找回来——hover 提示要带全名,而不只是路径。
  it("产物 pill 的 title 含完整标题(长标题被省略号截断后仍可读全)", () => {
    const longTitle = "做一份 6 页的产品介绍 PPT,像素游戏风格排版,配色炫酷丰富";
    render(
      <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
        <ComposerShell
          agent="claude"
          model={undefined}
          providerId={undefined}
          useOwnSkills={false}
          running={false}
          artifact={{
            kind: "slides",
            documentId: "d1",
            title: longTitle,
            workspaceRoot: "/w",
            entryPath: "/w/.cortex-slides/d1",
            createdAt: 1,
            updatedAt: 1,
          }}
          onSend={() => true}
          onChangeModel={() => {}}
          onChangePiModel={() => {}}
          onToggleSkills={() => {}}
          onToast={() => {}}
        />
      </CoreProvider>,
    );
    const pill = screen.getByText(longTitle).closest(".pw-artifact-pill");
    expect(pill).toHaveAttribute("title", expect.stringContaining(longTitle));
  });

  // 撤销:程序化 setText 不进浏览器原生撤销栈,Cmd+Z 撤不回被填入的示例提示词。
  // 走 execCommand("insertText") 才算「用户编辑」——这里断言它被用上,且不支持时仍能回退填入。
  it("插入文本走 execCommand 以进入原生撤销栈", async () => {
    const exec = vi.fn(() => true);
    const original = document.execCommand;
    // jsdom 未实现 execCommand,显式打桩后再断言调用。
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true, writable: true });
    try {
      renderInsert({ onSend: vi.fn(() => true) });
      act(() => usePersonalStore.getState().insertToComposer("做一份 6 页的产品介绍 PPT"));
      await waitFor(() => expect(exec).toHaveBeenCalledWith("insertText", false, "做一份 6 页的产品介绍 PPT"));
    } finally {
      Object.defineProperty(document, "execCommand", { value: original, configurable: true, writable: true });
    }
  });

  it("execCommand 不可用时回退到直接填入", async () => {
    const exec = vi.fn(() => false);
    const original = document.execCommand;
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true, writable: true });
    try {
      renderInsert({ onSend: vi.fn(() => true) });
      act(() => usePersonalStore.getState().insertToComposer("回退文本"));
      await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("回退文本"));
    } finally {
      Object.defineProperty(document, "execCommand", { value: original, configurable: true, writable: true });
    }
  });

  // 选中的 skill pill 单向镜像进 store,落地页示例区据此联动;发送 / 手动移除后必须同步清掉。
  it("skill pill 镜像到 store.composerSkill,发送后清空", async () => {
    const onSend = vi.fn(() => true);
    renderInsert({ onSend });
    act(() =>
      usePersonalStore.getState().insertToComposer("", { skill: { cmd: "/skill:slides", displayName: "Slides" } }),
    );
    await waitFor(() =>
      expect(usePersonalStore.getState().composerSkill).toEqual({ cmd: "/skill:slides", displayName: "Slides" }),
    );
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "季度汇报" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => expect(usePersonalStore.getState().composerSkill).toBeUndefined());
  });

  // 回归:空文本 insert 不能往已有输入后面追加空行（chip 点击时用户可能已经打了字）。
  it("已有输入时 composerInsert 空文本 → 只加 pill,输入框原文不变", async () => {
    const onSend = vi.fn(() => true);
    renderInsert({ onSend });
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "已经写了一半" } });
    act(() =>
      usePersonalStore.getState().insertToComposer("", { skill: { cmd: "/skill:design", displayName: "Design" } }),
    );
    await waitFor(() => expect(screen.getByText("Design")).toBeInTheDocument());
    expect(ta.value).toBe("已经写了一半");
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

// U2: agent 选择器 opt-in —— 仅传 onChangeAgent 时渲染,会话内不传则不渲染。
describe("ComposerShell agent 选择器(opt-in)", () => {
  // 前序 voice 测试把 asrSettings 置 undefined 且未还原,这里恢复默认,避免 ComposerShell 渲染期读 undefined.protocol 崩。
  beforeEach(() => {
    usePersonalStore.setState({ asrSettings: defaultAsrSettings() });
  });

  function renderWithAgentProps(onChangeAgent?: (a: AgentKind, d?: DerivedAgentMeta) => void) {
    return render(
      <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
        <ComposerShell
          agent="claude"
          derivedAgents={[{ id: "my-cx", base: "codex", label: "我的CX" }]}
          agentsAvailable={{ claude: true, codex: true }}
          model={undefined}
          providerId={undefined}
          useOwnSkills={false}
          running={false}
          onSend={() => {}}
          onChangeAgent={onChangeAgent}
          onChangeModel={() => {}}
          onChangePiModel={() => {}}
          onToggleSkills={() => {}}
          onToast={() => {}}
        />
      </CoreProvider>,
    );
  }

  it("传 onChangeAgent → 工具栏渲染 agent 选择器,点击派生项触发回调", () => {
    const onChangeAgent = vi.fn();
    renderWithAgentProps(onChangeAgent);
    const trigger = screen.getByRole("button", { name: /Claude Code/ });
    expect(trigger).toBeTruthy();
    fireEvent.click(trigger);
    // composer 工具栏在底部 → 菜单向上弹出,避免被 GitBar/终端遮挡。
    expect(document.querySelector(".pw-tb-menu.pw-tb-menu--up")).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: /我的CX/ }));
    expect(onChangeAgent).toHaveBeenCalledWith("codex", { id: "my-cx", base: "codex", label: "我的CX" });
  });

  it("不传 onChangeAgent(会话内)→ 不渲染 agent 选择器", () => {
    const { container } = renderWithAgentProps(undefined);
    expect(container.querySelector(".pw-sh-agent")).toBeNull();
  });
});

// ── 会话级「联网」pill ────────────────────────────────────────────────────────
//
// 这个 pill 是「本会话要不要联网」的唯一入口（全局 chatEnabled 已移除），四条要守住：
//   1. **opt-in**：宿主不传 onToggleWebSearch（研究引擎未开 / 无桥）时整个 pill 不渲染——
//      给一个点了没反应的出站开关比不给更糟；
//   2. **状态一眼可见**：aria-pressed 与 .is-on 必须跟着 webSearch 走。联网带数据出站语义，
//      当前是开还是关不能靠猜；
//   3. 搜索后端没配好时**禁用而非消失**，tooltip 指向设置页（主进程那侧本来就不会注入）；
//   4. 运行中禁用：claude/codex 的工具集在本轮 spawn 时已定，此刻可点只会造成「改了没用」的误解。
describe("ComposerShell 联网 pill", () => {
  function renderWebSearch(props: {
    webSearch?: boolean;
    onToggleWebSearch?: () => void;
    webSearchUnavailable?: boolean;
    running?: boolean;
  }) {
    return render(
      <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
        <ComposerShell
          agent="claude"
          model={undefined}
          providerId={undefined}
          useOwnSkills={false}
          running={props.running ?? false}
          onSend={() => {}}
          onChangeModel={() => {}}
          onChangePiModel={() => {}}
          onToggleSkills={() => {}}
          webSearch={props.webSearch}
          {...(props.onToggleWebSearch ? { onToggleWebSearch: props.onToggleWebSearch } : {})}
          webSearchUnavailable={props.webSearchUnavailable}
          onToast={() => {}}
        />
      </CoreProvider>,
    );
  }

  /// 用 aria-pressed 定位：不依赖 i18n 文案是否已加载，也不锁死类名细节。
  /// comp-foot 里其余按钮走的是 aria-haspopup/aria-expanded，不会误命中。
  const pill = (c: HTMLElement) =>
    c.querySelector<HTMLButtonElement>(".comp-foot button[aria-pressed]");

  it("不传 onToggleWebSearch（研究引擎未开 / 无桥）→ 不渲染", () => {
    const { container } = renderWebSearch({});
    expect(pill(container)).toBeNull();
  });

  it("传回调即渲染；点击触发 toggle", () => {
    const onToggleWebSearch = vi.fn();
    const { container } = renderWebSearch({ onToggleWebSearch });
    const btn = pill(container);
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onToggleWebSearch).toHaveBeenCalledTimes(1);
  });

  it("开启态反映在 aria-pressed 与 is-on 上", () => {
    const { container } = renderWebSearch({ webSearch: true, onToggleWebSearch: () => {} });
    const btn = pill(container)!;
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.className).toContain("is-on");
  });

  it("关闭态不带 is-on", () => {
    const { container } = renderWebSearch({ webSearch: false, onToggleWebSearch: () => {} });
    const btn = pill(container)!;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.className).not.toContain("is-on");
  });

  it("搜索后端未配置 → 禁用且点不动，但仍渲染（tooltip 指路，而不是让入口凭空消失）", () => {
    const onToggleWebSearch = vi.fn();
    const { container } = renderWebSearch({ onToggleWebSearch, webSearchUnavailable: true });
    const btn = pill(container);
    expect(btn).not.toBeNull();
    expect(btn!.disabled).toBe(true);
    fireEvent.click(btn!);
    expect(onToggleWebSearch).not.toHaveBeenCalled();
  });

  it("运行中禁用（本轮工具集已定，改了也要等下一轮）", () => {
    const { container } = renderWebSearch({ onToggleWebSearch: () => {}, running: true });
    expect(pill(container)!.disabled).toBe(true);
  });
});

// 「转为深度研究」菜单项：套一个 skill pill，而不是直接发起研究。
//
// 走 pill 意味着与用户手敲 `/skill:research` 完全同一条路径——发起前还能改词、
// 也能按退格取消。**已写的文本必须原样留在输入框**：它就是研究目标，
// 清空它等于让用户白写一遍（这是把「直接发起」改成「套 pill」时最容易摔的一跤）。
describe("ComposerShell 转为深度研究", () => {
  function renderResearch(available: boolean) {
    return render(
      <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
        <ComposerShell
          agent="claude"
          model={undefined}
          providerId={undefined}
          useOwnSkills={false}
          running={false}
          onSend={() => {}}
          onChangeModel={() => {}}
          onChangePiModel={() => {}}
          onToggleSkills={() => {}}
          researchSkillAvailable={available}
          onToast={() => {}}
        />
      </CoreProvider>,
    );
  }

  /// 「+」菜单：用 aria-haspopup 定位触发器，避免锁死 i18n 文案。
  const openAttachMenu = (c: HTMLElement) => {
    fireEvent.click(c.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!);
  };
  const researchItem = (c: HTMLElement) =>
    [...c.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
      b.textContent?.includes("研究"),
    );

  it("研究不可用时整个菜单项不渲染（点了没反应的入口比没有更糟）", () => {
    const { container } = renderResearch(false);
    openAttachMenu(container);
    expect(researchItem(container)).toBeUndefined();
  });

  it("点击后套上 skill pill，且输入框里已写的文本原样保留", () => {
    const { container } = renderResearch(true);
    const ta = container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "调研向量数据库选型" } });

    openAttachMenu(container);
    fireEvent.click(researchItem(container)!);

    expect(container.querySelector(".pw-skill-pill")?.textContent).toContain("深度研究");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "调研向量数据库选型",
    );
  });

  /// 先套 pill 再想目标是常见顺序，所以不能按「文本为空」禁用——
  /// 空目标的拒绝留给发送那一刻（那里才有机会给出人话提示）。
  it("输入为空时菜单项仍可点（先套 pill 再写目标）", () => {
    const { container } = renderResearch(true);
    openAttachMenu(container);
    const item = researchItem(container)!;
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    expect(container.querySelector(".pw-skill-pill")).not.toBeNull();
  });
});
