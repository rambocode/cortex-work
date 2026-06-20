// 模板画廊：渲染全部模板卡片;点击某卡片回调 onPick 并原样上抛该模板。

import { cleanup, render, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationTemplateGallery } from "./AutomationTemplateGallery";
import { AUTOMATION_TEMPLATES } from "./automationTemplates";

afterEach(() => cleanup());

describe("AutomationTemplateGallery", () => {
  it("渲染全部模板卡片(按名称可见)", () => {
    const { getByText } = render(<AutomationTemplateGallery onPick={() => {}} />);
    for (const t of AUTOMATION_TEMPLATES) {
      expect(getByText(t.name)).toBeTruthy();
    }
  });

  it("点击卡片回调 onPick 并原样上抛对应模板", () => {
    const onPick = vi.fn();
    const { getByText } = render(<AutomationTemplateGallery onPick={onPick} />);
    const target = AUTOMATION_TEMPLATES[0]!;
    fireEvent.click(getByText(target.name));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(target);
  });
});
