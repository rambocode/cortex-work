// pi-extensions.ts 渲染纯函数 + 落盘的单测。electron(app.getPath) + fs 全 mock。
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writeFileSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "/userData" } }));
vi.mock("fs", () => ({ writeFileSync: h.writeFileSync, mkdirSync: h.mkdirSync }));

import {
  DEFAULT_APPROVAL_TOOLS,
  renderApprovalExtension,
  renderAskQuestionExtension,
  renderCustomToolExtension,
  renderSlashCommandExtension,
  writeApprovalExtension,
  writeAskQuestionExtension,
} from "./pi-extensions";

describe("renderApprovalExtension（阶段3 U7）", () => {
  it("拦 tool_call → ctx.ui.confirm → block 的审批结构", () => {
    const src = renderApprovalExtension();
    expect(src).toContain("export default function (pi)");
    expect(src).toContain('pi.on("tool_call"');
    expect(src).toContain("ctx.hasUI"); // 无 UI 放行
    expect(src).toContain("ctx.ui.confirm");
    expect(src).toContain("block: true");
    expect(src).toContain(JSON.stringify(DEFAULT_APPROVAL_TOOLS)); // 默认审批工具集
  });

  it("自定义审批工具集注入 NEEDS 集合", () => {
    const src = renderApprovalExtension(["bash"]);
    expect(src).toContain('const NEEDS = new Set(["bash"]);');
  });

  it("空数组 → 空 NEEDS 集（不审批任何工具,而非兜回默认三件）", () => {
    const src = renderApprovalExtension([]);
    expect(src).toContain("const NEEDS = new Set([]);");
  });

  it("无参（undefined）→ 默认三件 bash/write/edit", () => {
    const src = renderApprovalExtension();
    expect(src).toContain(`const NEEDS = new Set(${JSON.stringify(DEFAULT_APPROVAL_TOOLS)});`);
  });

  it("写文件:落 userData/pi-extensions/approval.js,mode 0600", () => {
    const path = writeApprovalExtension();
    expect(path).toContain("pi-extensions");
    expect(path.endsWith("approval.js")).toBe(true);
    expect(h.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("approval.js"), expect.any(String), {
      mode: 0o600,
    });
  });
});

describe("renderCustomToolExtension（阶段3 U8）", () => {
  it("registerTool + execute + 普通对象 parameters,无 typebox import", () => {
    const src = renderCustomToolExtension();
    expect(src).toContain("pi.registerTool");
    expect(src).toContain('name: "echo_upper"');
    expect(src).toContain("async execute(");
    expect(src).toContain('parameters: { type: "object"');
    expect(src).not.toContain("import"); // 零 import（spike 已证无需 typebox）
    expect(src).not.toContain("typebox");
  });
});

describe("renderSlashCommandExtension（阶段3 U9）", () => {
  it("registerCommand greet + handler", () => {
    const src = renderSlashCommandExtension();
    expect(src).toContain('pi.registerCommand("greet"');
    expect(src).toContain("handler:");
    expect(src).toContain("ctx.ui.notify");
  });
});

describe("renderAskQuestionExtension（askquestion 工具）", () => {
  it("registerTool askquestion + execute + 借 ctx.ui.input(sentinel),无 import/typebox", () => {
    const src = renderAskQuestionExtension("@@SENT@@");
    expect(src).toContain("pi.registerTool");
    expect(src).toContain('name: "askquestion"');
    expect(src).toContain("async execute(");
    expect(src).toContain("ctx.ui.input(SENTINEL +");
    expect(src).toContain('const SENTINEL = "@@SENT@@";');
    expect(src).toContain("parameters: PARAMS");
    expect(src).not.toContain("import");
    expect(src).not.toContain("typebox");
  });

  it("execute 处理取消:value === undefined → 合法 result(不崩)", () => {
    const src = renderAskQuestionExtension("@@SENT@@");
    expect(src).toContain("value === undefined");
    expect(src).toContain("用户取消了提问");
  });

  it("答案汇总逐组携带问题原文(问/答),非仅 value", () => {
    const src = renderAskQuestionExtension("@@SENT@@");
    expect(src).toContain("qById[g.id] = g.question");
    expect(src).toContain('"问: "');
  });

  it("写文件:落 userData/pi-extensions/askquestion.js,mode 0600", () => {
    const path = writeAskQuestionExtension("@@SENT@@");
    expect(path.endsWith("askquestion.js")).toBe(true);
    expect(h.writeFileSync).toHaveBeenCalledWith(expect.stringContaining("askquestion.js"), expect.any(String), {
      mode: 0o600,
    });
  });
});
