import { describe, expect, it } from "vitest";
import { derivePiCapabilities } from "./permissionMode";
import { PI_PLAN_TOOL_WHITELIST } from "../desktop/types";

describe("derivePiCapabilities(访问范围 × 执行审批)", () => {
  it("访问范围 plan(只读):只读白名单(含浏览器控制工具)+ 关审批", () => {
    const caps = derivePiCapabilities("plan", "auto");
    expect(caps.toolWhitelist).toEqual(PI_PLAN_TOOL_WHITELIST);
    expect(caps.toolWhitelist).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "browser_navigate"]));
    expect(caps.enableToolApproval).toBe(false);
    expect(caps.approvalTools).toBeUndefined();
  });

  it("plan 优先于审批:plan + ask 仍走只读白名单(无写/执行工具,审批无意义)", () => {
    const caps = derivePiCapabilities("plan", "ask");
    expect(caps.toolWhitelist).toEqual(PI_PLAN_TOOL_WHITELIST);
    expect(caps.enableToolApproval).toBe(false);
  });

  it("执行审批 ask(询问后执行):开审批,审批集至少覆盖 write/edit/bash", () => {
    const caps = derivePiCapabilities("accept-edits", "ask");
    expect(caps.enableToolApproval).toBe(true);
    expect(caps.toolWhitelist).toBeUndefined();
    expect(caps.approvalTools).toEqual(expect.arrayContaining(["write", "edit", "bash"]));
  });

  it("ask:合并用户自定义审批集 + 安全底线工具(去重)", () => {
    const caps = derivePiCapabilities("full-auto", "ask", { toolApproval: true, approvalTools: ["read", "bash"] });
    expect(caps.approvalTools).toEqual(expect.arrayContaining(["read", "write", "edit", "bash"]));
    // 去重:bash 只出现一次。
    expect(caps.approvalTools!.filter((t) => t === "bash")).toHaveLength(1);
  });

  it("auto(自动执行)+ 非 plan:不收窄工具,审批沿用 piCustom(关闭则无审批,= 历史默认)", () => {
    expect(derivePiCapabilities("full-auto", "auto")).toEqual({
      toolWhitelist: undefined,
      enableToolApproval: undefined,
      approvalTools: undefined,
    });
    const withApproval = derivePiCapabilities("accept-edits", "auto", { toolApproval: true, approvalTools: ["bash"] });
    expect(withApproval.enableToolApproval).toBe(true);
    expect(withApproval.approvalTools).toEqual(["bash"]);
  });

  it("sandbox(外部沙箱):pi 无原生沙箱 → 不收窄工具(同 auto 非 plan)", () => {
    expect(derivePiCapabilities("sandbox", "auto")).toEqual(derivePiCapabilities("full-auto", "auto"));
  });

  it("缺省(undefined×undefined)= auto + 非 plan 的历史默认", () => {
    expect(derivePiCapabilities(undefined, undefined)).toEqual(derivePiCapabilities("full-auto", "auto"));
  });
});
