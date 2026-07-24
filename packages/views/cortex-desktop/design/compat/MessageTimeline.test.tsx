import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatBlock } from "@cortex-work/core/design/compat/agent-types";
import { MessageTimeline } from "./MessageTimeline";

function tool(status: "running" | "success" | "error"): ChatBlock {
  return {
    kind: "tool",
    id: `tool-${status}`,
    summary: "get_deck_state",
    status,
    meta: { toolName: "get_deck_state" },
  };
}

describe("MessageTimeline 工具状态", () => {
  it("完成的 get_deck_state 明确显示为“已读取状态”", () => {
    const html = renderToStaticMarkup(createElement(MessageTimeline, { blocks: [tool("success")] }));
    expect(html).toContain("已读取状态");
  });

  it("run 忙碌但没有运行中工具时显示后续处理状态", () => {
    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks: [tool("success")],
        busy: true,
        busyLabel: "正在生成演示文稿…",
      }),
    );
    expect(html).toContain("正在生成演示文稿…");
  });
});
