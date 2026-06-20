import { describe, expect, it } from "vitest";
import { derivePiCapabilities } from "./permissionMode";

describe("derivePiCapabilities", () => {
  it("plan:只读白名单 + 关审批,不带 approvalTools", () => {
    const caps = derivePiCapabilities("plan");
    expect(caps.toolWhitelist).toEqual(["read", "grep", "find", "ls"]);
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
