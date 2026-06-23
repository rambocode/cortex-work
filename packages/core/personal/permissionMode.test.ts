import { describe, expect, it } from "vitest";
import { derivePiCapabilities } from "./permissionMode";
import { PI_PLAN_TOOL_WHITELIST } from "../desktop/types";

describe("derivePiCapabilities", () => {
  it("plan:只读白名单(含浏览器控制工具)+ 关审批,不带 approvalTools", () => {
    const caps = derivePiCapabilities("plan");
    expect(caps.toolWhitelist).toEqual(PI_PLAN_TOOL_WHITELIST);
    // 只读文件工具 + 浏览器控制工具(沙箱,plan 下亦放行)。
    expect(caps.toolWhitelist).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "browser_navigate"]));
    expect(caps.enableToolApproval).toBe(false);
    expect(caps.approvalTools).toBeUndefined();
  });

  it("accept-edits:开审批,从审批集剔除 write/edit(放行编辑),保留 bash", () => {
    const caps = derivePiCapabilities("accept-edits");
    expect(caps.enableToolApproval).toBe(true);
    expect(caps.toolWhitelist).toBeUndefined();
    expect(caps.approvalTools).not.toContain("write");
    expect(caps.approvalTools).not.toContain("edit");
    expect(caps.approvalTools).toContain("bash");
  });

  it("accept-edits:尊重用户自定义审批集,仅剔除 write/edit", () => {
    const caps = derivePiCapabilities("accept-edits", {
      toolApproval: true,
      approvalTools: ["bash", "write", "edit", "read"],
    });
    expect(caps.approvalTools).toEqual(["bash", "read"]);
  });

  it("accept-edits:自定义审批集恰为 write/edit 时,bash 仍兜底进审批(不退化为零审批)", () => {
    const caps = derivePiCapabilities("accept-edits", {
      toolApproval: true,
      approvalTools: ["write", "edit"],
    });
    // 剔除 write/edit 后本应为空 → 必须强制保留 bash,避免 NEEDS=Set([]) 放行全部工具。
    expect(caps.approvalTools).toEqual(["bash"]);
    expect(caps.enableToolApproval).toBe(true);
  });

  it("full-auto:沿用用户 piCustom 审批设置(回归);关闭则无审批", () => {
    expect(derivePiCapabilities("full-auto")).toEqual({
      toolWhitelist: undefined,
      enableToolApproval: undefined,
      approvalTools: undefined,
    });
    const withApproval = derivePiCapabilities("full-auto", {
      toolApproval: true,
      approvalTools: ["bash"],
    });
    expect(withApproval.enableToolApproval).toBe(true);
    expect(withApproval.approvalTools).toEqual(["bash"]);
    expect(withApproval.toolWhitelist).toBeUndefined();
  });

  it("缺省(undefined)按 full-auto 处理(回归保护)", () => {
    expect(derivePiCapabilities(undefined)).toEqual(derivePiCapabilities("full-auto"));
  });
});
