// pi-extensions.ts 渲染纯函数 + 落盘的单测。electron(app.getPath) + fs 全 mock。
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writeFileSync: vi.fn(), mkdirSync: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "/userData" } }));
vi.mock("fs", () => ({ writeFileSync: h.writeFileSync, mkdirSync: h.mkdirSync }));

import {
  DEFAULT_APPROVAL_TOOLS,
  renderApprovalExtension,
  renderCustomToolExtension,
  renderSlashCommandExtension,
  writeApprovalExtension,
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
