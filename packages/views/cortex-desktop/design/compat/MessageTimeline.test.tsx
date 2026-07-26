import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ChatBlock } from "@cortex-work/core/design/compat/agent-types";
import { MessageTimeline, shouldExpandToolGroup } from "./MessageTimeline";

type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;

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

  // 回归(用户实测):一屏三个「MCP」看不出各自在做什么。codex 的 mcp_tool_call item
  // 整体作为 input JSON 落进 detail,而摘要提取原先只认 file_path/command/label/pattern。
  const mcpTool = (id: string, tool: string): ChatBlock => ({
    kind: "tool",
    id,
    summary: "MCP",
    status: "success",
    detail: JSON.stringify({ id, type: "mcp_tool_call", server: "cortex-slides", tool, arguments: {} }),
    meta: { toolName: "MCP" },
  });

  it("MCP 调用显示具体工具名(而非只有一个 MCP)", () => {
    const html = renderToStaticMarkup(
      createElement(MessageTimeline, { blocks: [mcpTool("t1", "get_deck_state")] }),
    );
    expect(html).toContain("get_deck_state");
    expect(html).toContain("cortex-slides");
  });

  // 多条连续工具默认折叠成一行,详情要展开才渲染 —— 用户截图正是展开态下三行都只写「MCP」。
  it("展开后多条 MCP 调用逐条可分辨", async () => {
    const { getByRole } = render(
      createElement(MessageTimeline, {
        blocks: [mcpTool("t1", "get_deck_state"), mcpTool("t2", "set_slides"), mcpTool("t3", "add_asset")],
      }),
    );
    await userEvent.click(getByRole("button", { name: /个操作/ }));
    for (const name of ["get_deck_state", "set_slides", "add_asset"]) {
      expect(document.body.textContent).toContain(name);
    }
  });

  it("非 MCP 工具的既有摘要不受影响(file_path / command 优先级不变)", () => {
    const edit = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks: [{ kind: "tool", id: "e1", summary: "Edit", status: "success", detail: JSON.stringify({ file_path: "/a/b.ts" }), meta: { toolName: "Edit" } } as ChatBlock],
      }),
    );
    expect(edit).toContain("/a/b.ts");
    const shell = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks: [{ kind: "tool", id: "s1", summary: "Shell", status: "success", detail: JSON.stringify({ command: "ls -la" }), meta: { toolName: "Shell" } } as ChatBlock],
      }),
    );
    expect(shell).toContain("ls -la");
  });

  // 优先级:MCP 的 tool 字段只在存在时才抢先,不能盖掉带 file_path 的普通工具。
  it("同时带 tool 与 file_path 时以 MCP 工具名为准", () => {
    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks: [{ kind: "tool", id: "m1", summary: "MCP", status: "success", detail: JSON.stringify({ tool: "add_asset", file_path: "/tmp/x.png" }), meta: { toolName: "MCP" } } as ChatBlock],
      }),
    );
    expect(html).toContain("add_asset");
  });

  // 回归(用户实测):回合因 402 Insufficient Balance 失败后,原话只留在气泡里,
  // 只能手打一遍才能重试 —— 用户气泡上应有「编辑并重新发送」把原话放回输入框。
  const userBlock = (text: string, displayText?: string): ChatBlock =>
    ({ kind: "user", id: "u1", text, ...(displayText ? { meta: { displayText } } : {}) }) as ChatBlock;

  it("点编辑把用户原话回填输入框", async () => {
    const seen: string[] = [];
    const { getByRole } = render(
      createElement(MessageTimeline, {
        blocks: [userBlock("曲线图没有显示")],
        onEditUserMessage: (t: string) => seen.push(t),
      }),
    );
    await userEvent.click(getByRole("button", { name: "编辑并重新发送" }));
    expect(seen).toEqual(["曲线图没有显示"]);
  });

  // 回填的必须是用户原话,不能是拼了合同/选区上下文的完整 prompt。
  it("回填 displayText 而非完整 prompt", async () => {
    const seen: string[] = [];
    const { getByRole } = render(
      createElement(MessageTimeline, {
        blocks: [userBlock("<contract>…</contract>\nUser request:\n改成折线图", "改成折线图")],
        onEditUserMessage: (t: string) => seen.push(t),
      }),
    );
    await userEvent.click(getByRole("button", { name: "编辑并重新发送" }));
    expect(seen).toEqual(["改成折线图"]);
  });

  it("未接线时不渲染编辑按钮(不打扰只读场景)", () => {
    const html = renderToStaticMarkup(
      createElement(MessageTimeline, { blocks: [userBlock("hi")] }),
    );
    expect(html).not.toContain("编辑并重新发送");
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

describe("MessageTimeline slides 工具芯片", () => {
  const slidesTool = (over: Partial<ToolBlock> = {}): ChatBlock =>
    ({
      kind: "tool",
      id: "t1",
      summary: "mcp__cortex-slides__set_slides",
      status: "success",
      meta: { toolName: "mcp__cortex-slides__set_slides" },
      ...over,
    }) as ChatBlock;

  it("set_slides 有中文标签(此前落到 mono 兜底,看不出在做什么)", () => {
    const html = renderToStaticMarkup(createElement(MessageTimeline, { blocks: [slidesTool()] }));
    expect(html).toContain("已更新页面");
  });

  it("详情显示页码与 revision(主进程随结果回传的 replacedPages)", () => {
    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks: [
          slidesTool({
            meta: {
              toolName: "mcp__cortex-slides__set_slides",
              output: JSON.stringify({ ok: true, revision: 72, replacedPages: [3, 7] }),
            },
          } as Partial<ToolBlock>),
        ],
      }),
    );
    expect(html).toContain("第3、7页 · rev 72");
  });

  it("运行中的工具组默认展开(改稿进度必须可见)", () => {
    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks: [
          slidesTool({ id: "a", status: "running" } as Partial<ToolBlock>),
          slidesTool({ id: "b", status: "running" } as Partial<ToolBlock>),
        ],
      }),
    );
    expect(html).toContain("2 个操作");
    // 展开时逐条渲染 → 「正在改写页面」出现在明细行里。
    expect(html).toContain("正在改写页面");
  });

  it("全部完成的工具组默认折叠(不让一长串读取芯片刷屏)", () => {
    const html = renderToStaticMarkup(
      createElement(MessageTimeline, {
        blocks: [slidesTool({ id: "a" } as Partial<ToolBlock>), slidesTool({ id: "b" } as Partial<ToolBlock>)],
      }),
    );
    expect(html).toContain("2 个操作");
    expect(html).not.toContain("已更新页面 ");
  });
});

describe("shouldExpandToolGroup", () => {
  it("有运行中 → 展开;全完成 → 折叠", () => {
    expect(shouldExpandToolGroup([{ status: "running" }, { status: "success" }], null)).toBe(true);
    expect(shouldExpandToolGroup([{ status: "success" }], null)).toBe(false);
  });

  it("用户手动表态后一律尊重用户(运行中也不强行展开)", () => {
    expect(shouldExpandToolGroup([{ status: "running" }], false)).toBe(false);
    expect(shouldExpandToolGroup([{ status: "success" }], true)).toBe(true);
  });
});

// system 块此前一律红框(只用于报错)。演示文稿改稿活动条复用它,必须按 severity 分叉,
// 否则「已更新 第3页」会被渲染成一条报错。
describe("MessageTimeline system 块按 severity 分叉", () => {
  const systemBlock = (severity?: "info" | "warning" | "error"): ChatBlock => ({
    kind: "system",
    id: `sys-${severity ?? "default"}`,
    text: "已更新 第3页 · rev 72",
    ...(severity ? { severity } : {}),
  });

  it("severity=info → 中性芯片,不带红色类", () => {
    const html = renderToStaticMarkup(createElement(MessageTimeline, { blocks: [systemBlock("info")] }));
    expect(html).toContain("已更新 第3页 · rev 72");
    expect(html).not.toContain("text-red-600");
  });

  it("severity=warning → 琥珀色提示", () => {
    const html = renderToStaticMarkup(createElement(MessageTimeline, { blocks: [systemBlock("warning")] }));
    expect(html).toContain("amber");
    expect(html).not.toContain("text-red-600");
  });

  it("severity=error 与缺省一律保持红框(既有报错不被静默降级)", () => {
    expect(renderToStaticMarkup(createElement(MessageTimeline, { blocks: [systemBlock("error")] }))).toContain(
      "text-red-600",
    );
    expect(renderToStaticMarkup(createElement(MessageTimeline, { blocks: [systemBlock()] }))).toContain("text-red-600");
  });
});
