import { describe, expect, it } from "vitest";
import { derivePiCapabilities, toAdapterPermissions, fromAdapterPermissions } from "./permissionMode";
import {
  COMPUTER_USE_READONLY_TOOLS,
  COMPUTER_USE_WRITE_TOOLS,
  PI_PLAN_TOOL_WHITELIST,
  EXEC_PERMISSIONS,
  type ExecPermission,
} from "../desktop/types";

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

  it("auto(自动执行)+ Computer Use 关:不收窄工具,审批沿用 piCustom(历史默认)", () => {
    expect(derivePiCapabilities("full-auto", "auto", undefined, false)).toEqual({
      toolWhitelist: undefined,
      enableToolApproval: undefined,
      approvalTools: undefined,
    });
    const withApproval = derivePiCapabilities(
      "full-auto",
      "auto",
      { toolApproval: true, approvalTools: ["bash"] },
      false,
    );
    expect(withApproval.enableToolApproval).toBe(true);
    expect(withApproval.approvalTools).toEqual(["bash"]);
  });
});

// 【安全红线】gui_* 写工具能真实点击/输入到用户电脑上,误操作可发消息、删文件、确认付款。
// 因此只要 Computer Use 没被关掉,这些工具**必须**逐次确认——尤其 auto 档:那里用户可能压根
// 没开「工具执行审批」,而历史行为是「没开就不审批」。这组用例守的就是这个不可让步的例外。
describe("derivePiCapabilities:Computer Use 写工具强制审批", () => {
  it("auto 档 + 用户没开审批 → 仍强制开审批,且审批集含全部 gui 写工具", () => {
    const caps = derivePiCapabilities("full-auto", "auto");
    expect(caps.enableToolApproval).toBe(true);
    expect(caps.approvalTools).toEqual(expect.arrayContaining(COMPUTER_USE_WRITE_TOOLS));
    // 不收窄工具集(auto 档语义不变)。
    expect(caps.toolWhitelist).toBeUndefined();
  });

  it("auto 档:保留用户原有审批集,不覆盖其选择", () => {
    const caps = derivePiCapabilities("full-auto", "auto", { toolApproval: true, approvalTools: ["bash", "read"] });
    expect(caps.approvalTools).toEqual(expect.arrayContaining(["bash", "read", ...COMPUTER_USE_WRITE_TOOLS]));
  });

  it("ask 档:gui 写工具与 write/edit/bash 一并进审批集", () => {
    const caps = derivePiCapabilities("full-auto", "ask");
    expect(caps.approvalTools).toEqual(expect.arrayContaining(["write", "edit", "bash", ...COMPUTER_USE_WRITE_TOOLS]));
  });

  it("审批集去重:用户已勾 gui_click 时不重复出现", () => {
    const caps = derivePiCapabilities("full-auto", "ask", { toolApproval: true, approvalTools: ["gui_click"] });
    expect(caps.approvalTools!.filter((x) => x === "gui_click")).toHaveLength(1);
  });

  it("每个 gui 写工具都在审批集里（新增工具漏加保护:升级 package 时必须同步 WRITE_TOOLS）", () => {
    const caps = derivePiCapabilities("full-auto", "auto");
    for (const tool of COMPUTER_USE_WRITE_TOOLS) {
      expect(caps.approvalTools).toContain(tool);
    }
  });

  it("plan 档不靠审批兜底,而是靠 --tools 物理拦下:gui 写工具不在白名单里", () => {
    const caps = derivePiCapabilities("plan", "auto");
    for (const tool of COMPUTER_USE_WRITE_TOOLS) {
      expect(caps.toolWhitelist).not.toContain(tool);
    }
    // 只读 gui 工具则放行（计划档可看屏幕取证）。
    expect(caps.toolWhitelist).toEqual(expect.arrayContaining(COMPUTER_USE_READONLY_TOOLS));
  });

  it("Computer Use 关闭时不往审批集里塞 gui 工具（不给无关噪音）", () => {
    const caps = derivePiCapabilities("full-auto", "ask", undefined, false);
    for (const tool of COMPUTER_USE_WRITE_TOOLS) {
      expect(caps.approvalTools).not.toContain(tool);
    }
  });
});

describe("derivePiCapabilities(其余)", () => {

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
