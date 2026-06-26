import { cleanup, render, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { CoreProvider } from "@cortex-work/core";
import type { DesktopBridge, DirectoryGrant } from "@cortex-work/core";
import { DirectoryGrantPill } from "./DirectoryGrantPill";

function renderPill(props: Partial<Parameters<typeof DirectoryGrantPill>[0]> = {}, bridge?: Partial<DesktopBridge>) {
  return render(
    <CoreProvider wsId="ws" identity={{ userId: "me", name: "我" }} desktopBridge={(bridge ?? {}) as DesktopBridge}>
      <DirectoryGrantPill
        grants={[{ kind: "workspace" }]}
        onChange={() => {}}
        permissionMode="plan"
        running={false}
        agent="claude"
        onToast={() => {}}
        {...props}
      />
    </CoreProvider>,
  );
}

function openPanel(container: HTMLElement) {
  fireEvent.click(container.querySelector(".pw-grant-trigger")!);
}

describe("DirectoryGrantPill", () => {
  afterEach(() => cleanup());

  it("折叠标签:多授权显示「首项 +N」", () => {
    const { container } = renderPill({
      grants: [{ kind: "workspace" }, { kind: "generated-images" }, { kind: "custom", dirs: [] }],
    });
    expect(container.querySelector(".pw-grant-trigger")!.textContent).toContain("+2");
  });

  it("all-files 在非 full-auto 下置灰", () => {
    const { container } = renderPill({ permissionMode: "plan" });
    openPanel(container);
    const allFiles = container.querySelector('input[type="checkbox"]:disabled');
    expect(allFiles).not.toBeNull();
  });

  it("all-files 在 full-auto 下可勾(不再置灰)", () => {
    const { container } = renderPill({ permissionMode: "full-auto" });
    openPanel(container);
    // 4 个 checkbox 都不应 disabled
    expect(container.querySelectorAll('input[type="checkbox"]:disabled').length).toBe(0);
  });

  it("running 时触发器禁用", () => {
    const { container } = renderPill({ running: true });
    expect((container.querySelector(".pw-grant-trigger") as HTMLButtonElement).disabled).toBe(true);
  });

  it("agent=pi:custom/generated-images 行显示降级 ⚠", () => {
    const { container } = renderPill({
      agent: "pi",
      grants: [{ kind: "workspace" }, { kind: "generated-images" }],
    });
    openPanel(container);
    expect(container.querySelector(".pw-grant-warn")).not.toBeNull();
  });

  it("经目录选择器添加 custom → onChange 含该目录", async () => {
    const onChange = vi.fn();
    const pickDirectory = vi.fn().mockResolvedValue("/picked/dir");
    const { container } = renderPill(
      { grants: [{ kind: "custom", dirs: [] }], onChange },
      { pickDirectory },
    );
    openPanel(container);
    const addBtn = container.querySelector(".pw-grant-add") as HTMLButtonElement;
    fireEvent.click(addBtn);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    const next = onChange.mock.calls[0][0] as DirectoryGrant[];
    const custom = next.find((g) => g.kind === "custom") as Extract<DirectoryGrant, { kind: "custom" }>;
    expect(custom.dirs).toContain("/picked/dir");
  });
});
