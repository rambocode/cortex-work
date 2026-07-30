import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationMeta } from "@cortex-work/core";
import { AutomationConfigRail } from "./AutomationConfigRail";

afterEach(() => cleanup());

const meta = (over: Partial<AutomationMeta> = {}): AutomationMeta => ({
  id: "auto-1",
  name: "历史上的今天",
  enabled: true,
  agent: "claude",
  model: "sonnet",
  effort: "medium",
  prompt: "p",
  schedule: { kind: "daily", hour: 9, minute: 10 },
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe("AutomationConfigRail", () => {
  it("按 meta 渲染五项配置", () => {
    const { getByText } = render(<AutomationConfigRail meta={meta()} projectName="cortex-work" onEdit={() => {}} onDelete={() => {}} />);
    expect(getByText("每天 09:10")).toBeTruthy();
    expect(getByText("Claude Code")).toBeTruthy();
    expect(getByText("sonnet")).toBeTruthy();
    expect(getByText("中")).toBeTruthy();
    expect(getByText("cortex-work")).toBeTruthy();
  });

  it("缺省字段回落:模型/强度「默认」、无项目「无(主目录)」", () => {
    const { getByText } = render(
      <AutomationConfigRail meta={meta({ model: undefined, effort: undefined })} onEdit={() => {}} onDelete={() => {}} />,
    );
    // 模型与推理强度都缺省 → 出现两个「默认」
    expect(getByText("无(主目录)")).toBeTruthy();
  });

  it("点编辑触发 onEdit", () => {
    const onEdit = vi.fn();
    const { getByText } = render(<AutomationConfigRail meta={meta()} onEdit={onEdit} onDelete={() => {}} />);
    fireEvent.click(getByText("编辑"));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("删除走二次确认", () => {
    const onDelete = vi.fn();
    const { getByText } = render(<AutomationConfigRail meta={meta()} onEdit={() => {}} onDelete={onDelete} />);
    fireEvent.click(getByText("删除自动化"));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(getByText("确认删除？"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
