// ComposerShell 运行时插话（steer）门控（计划 U6）:仅 pi + running + onSteer 时,
// 运行中输入框可发插话(Enter/按钮 → onSteer);claude 运行中只剩停止按钮。

import type { ReactNode } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore, type AgentKind, type DesktopBridge, type PendingImage, type PersonalAttachment } from "@cortex-work/core";
import { ComposerShell } from "./ComposerShell";

const bridge = { loadChat: async () => [], saveChat: async () => {} } as unknown as DesktopBridge;

function renderShell(props: {
  agent: AgentKind;
  running: boolean;
  onSteer?: (text: string) => void;
  onStop?: () => void;
  onSend?: (text: string) => void;
}) {
  const node: ReactNode = (
    <CoreProvider wsId="w" identity={{ userId: "u", name: "n" }} desktopBridge={bridge}>
      <ComposerShell
        agent={props.agent}
        model={undefined}
        providerId={undefined}
        useOwnSkills={false}
        running={props.running}
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

describe("ComposerShell 运行模式选择器（U7）", () => {
  function renderMode(props: { permissionMode?: "plan" | "accept-edits" | "full-auto"; onChangeMode?: (m: string) => void }) {
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
          permissionMode={props.permissionMode}
          onChangeMode={props.onChangeMode}
          onToggleSkills={() => {}}
          onToast={() => {}}
        />
      </CoreProvider>,
    );
  }

  // 模式 select = 含 full-auto 选项的那个 .pw-model-select（与模型 select 区分）。
  function modeSelect(container: HTMLElement): HTMLSelectElement {
    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>(".comp-foot .pw-model-select"));
    const sel = selects.find((s) => Array.from(s.options).some((o) => o.value === "full-auto"));
    if (!sel) throw new Error("模式选择器未渲染");
    return sel;
  }

  it("提供 onChangeMode → 渲染三档选择器,缺省回显 full-auto", () => {
    const { container } = renderMode({ onChangeMode: () => {} });
    const sel = modeSelect(container);
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["plan", "accept-edits", "full-auto"]);
    expect(sel.value).toBe("full-auto");
  });

  it("选择 plan → 触发 onChangeMode('plan')", () => {
    const onChangeMode = vi.fn();
    const { container } = renderMode({ permissionMode: "full-auto", onChangeMode });
    fireEvent.change(modeSelect(container), { target: { value: "plan" } });
    expect(onChangeMode).toHaveBeenCalledWith("plan");
  });

  it("受控回显:permissionMode=accept-edits → select 显示该档", () => {
    const { container } = renderMode({ permissionMode: "accept-edits", onChangeMode: () => {} });
    expect(modeSelect(container).value).toBe("accept-edits");
  });

  it("未提供 onChangeMode → 不渲染模式选择器(隐藏入口)", () => {
    const { container } = renderMode({});
    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>(".comp-foot .pw-model-select"));
    expect(selects.some((s) => Array.from(s.options).some((o) => o.value === "full-auto"))).toBe(false);
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
