import { describe, expect, it } from "vitest";
import { derivePiCapabilities, toAdapterPermissions, fromAdapterPermissions } from "./permissionMode";
import { PI_PLAN_TOOL_WHITELIST, EXEC_PERMISSIONS, type ExecPermission } from "../desktop/types";

describe("derivePiCapabilities(线格式 → pi 能力)", () => {
  it("plan(只读):只读白名单(含浏览器控制工具)+ 关审批", () => {
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
    const caps = derivePiCapabilities("full-auto", "ask");
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

  it("auto(自动执行):不收窄工具,审批沿用 piCustom", () => {
    expect(derivePiCapabilities("full-auto", "auto")).toEqual({
      toolWhitelist: undefined,
      enableToolApproval: undefined,
      approvalTools: undefined,
    });
    const withApproval = derivePiCapabilities("full-auto", "auto", { toolApproval: true, approvalTools: ["bash"] });
    expect(withApproval.enableToolApproval).toBe(true);
    expect(withApproval.approvalTools).toEqual(["bash"]);
  });

  it("能力对象不再含 confineToCwd(目录轴/路径闸已删除)", () => {
    expect(derivePiCapabilities("full-auto", "auto")).not.toHaveProperty("confineToCwd");
    expect(derivePiCapabilities("full-auto", "ask")).not.toHaveProperty("confineToCwd");
    expect(derivePiCapabilities("plan", "auto")).not.toHaveProperty("confineToCwd");
  });

  it("缺省(undefined×undefined)= auto 的历史默认", () => {
    expect(derivePiCapabilities(undefined, undefined)).toEqual(derivePiCapabilities("full-auto", "auto"));
  });
});

describe("toAdapterPermissions(执行权限单轴 → 线格式)", () => {
  // 3 行映射表:plan→{plan,auto};ask→{full-auto,ask};auto→{full-auto,auto}。
  const cases: Array<[ExecPermission, string, string]> = [
    ["plan", "plan", "auto"],
    ["ask", "full-auto", "ask"],
    ["auto", "full-auto", "auto"],
  ];
  it.each(cases)("exec=%s → {permissionMode:%s, approvalPolicy:%s}", (exec, mode, approval) => {
    expect(toAdapterPermissions(exec)).toEqual({ permissionMode: mode, approvalPolicy: approval });
  });

  it("ask 显式映射 full-auto + ask(不设目录限制;防止未来误改回 accept-edits)", () => {
    expect(toAdapterPermissions("ask").permissionMode).toBe("full-auto");
  });

  it("缺省回退:undefined → 历史 full-auto + auto", () => {
    expect(toAdapterPermissions(undefined)).toEqual({ permissionMode: "full-auto", approvalPolicy: "auto" });
  });
});

describe("fromAdapterPermissions(线格式 → 执行权限,迁移用)", () => {
  it("plan → exec=plan,丢弃 approval", () => {
    expect(fromAdapterPermissions("plan", "auto")).toEqual({ execPermission: "plan" });
    expect(fromAdapterPermissions("plan", "ask")).toEqual({ execPermission: "plan" });
  });

  it("非 plan 各档:目录语义有损丢弃,按 approval 归入 ask/auto", () => {
    expect(fromAdapterPermissions("accept-edits", "auto")).toEqual({ execPermission: "auto" });
    expect(fromAdapterPermissions("accept-edits", "ask")).toEqual({ execPermission: "ask" });
    expect(fromAdapterPermissions("full-auto", "auto")).toEqual({ execPermission: "auto" });
    expect(fromAdapterPermissions("sandbox", "ask")).toEqual({ execPermission: "ask" });
  });

  it("缺省 permissionMode(undefined)→ 历史 full-auto 还原 = auto", () => {
    expect(fromAdapterPermissions(undefined, undefined)).toEqual({ execPermission: "auto" });
  });

  it("往返一致性 to∘from:所有 exec 档恒等", () => {
    for (const exec of EXEC_PERMISSIONS) {
      const wire = toAdapterPermissions(exec);
      expect(fromAdapterPermissions(wire.permissionMode, wire.approvalPolicy)).toEqual({ execPermission: exec });
    }
  });
});
