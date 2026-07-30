import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreProvider, usePersonalStore } from "@cortex-work/core";
import type { DesktopBridge, PromptNode } from "@cortex-work/core";
import { PromptPanel } from "./PromptPanel";

// 一个 skill 目录树:含 .md / .json / .py + 子目录,验证「全部文件」而非仅 .md。
const TREE: PromptNode = {
  kind: "dir",
  name: "报告技能",
  path: "/sk/报告技能",
  children: [
    { kind: "file", name: "SKILL.md", path: "/sk/报告技能/SKILL.md" },
    { kind: "file", name: "content-schema.json", path: "/sk/报告技能/content-schema.json" },
    {
      kind: "dir",
      name: "scripts",
      path: "/sk/报告技能/scripts",
      children: [{ kind: "file", name: "generate_report.py", path: "/sk/报告技能/scripts/generate_report.py" }],
    },
  ],
};

function makeBridge(over: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    scanDirTree: vi.fn().mockResolvedValue(TREE),
    readFile: vi.fn().mockResolvedValue({ content: "# 技能说明", truncated: false }),
    ...over,
  } as unknown as DesktopBridge;
}

function renderPanel(bridge: DesktopBridge) {
  return render(
    <CoreProvider wsId="test-ws" identity={{ userId: "me", name: "我" }} desktopBridge={bridge}>
      <PromptPanel onToast={() => {}} bare />
    </CoreProvider>,
  );
}

describe("PromptPanel(Skills 面板)两栏 + 全部文件", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    usePersonalStore.setState({ promptRoot: "/sk/报告技能", promptTree: TREE });
  });

  it("列出全部文件(含 .json/.py),不再仅限 .md", () => {
    renderPanel(makeBridge());
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
    expect(screen.getByText("content-schema.json")).toBeInTheDocument();
    // 顶层子目录 scripts 默认展开(depth 0),其中的 .py 直接可见。
    expect(screen.getByText("scripts")).toBeInTheDocument();
    expect(screen.getByText("generate_report.py")).toBeInTheDocument();
  });

  it("点文件:左树保留 + 右侧出现预览 + 容器加 is-fileopen(触发向中栏延展)", async () => {
    const bridge = makeBridge();
    const { container } = renderPanel(bridge);
    // 打开前无 is-fileopen。
    expect(container.querySelector(".pw-rp-view.is-fileopen")).toBeNull();

    fireEvent.click(screen.getByText("SKILL.md"));

    // 树仍在(列表未被替换),预览挂载,容器带 is-fileopen。
    expect(screen.getByText("content-schema.json")).toBeInTheDocument();
    expect(container.querySelector(".pw-skills-preview")).toBeTruthy();
    expect(container.querySelector(".pw-rp-view.is-fileopen")).toBeTruthy();
    await waitFor(() => expect(bridge.readFile).toHaveBeenCalledWith("/sk/报告技能/SKILL.md"));
  });

  it("预览头「返回列表」→ 回到纯列表(去掉 is-fileopen)", async () => {
    const { container } = renderPanel(makeBridge());
    fireEvent.click(screen.getByText("SKILL.md"));
    expect(container.querySelector(".pw-rp-view.is-fileopen")).toBeTruthy();

    fireEvent.click(await screen.findByTitle("返回列表"));
    expect(container.querySelector(".pw-rp-view.is-fileopen")).toBeNull();
    expect(container.querySelector(".pw-skills-preview")).toBeNull();
    // 树仍在。
    expect(screen.getByText("SKILL.md")).toBeInTheDocument();
  });
});
