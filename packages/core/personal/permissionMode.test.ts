import { describe, expect, it } from "vitest";
import { derivePiCapabilities, toAdapterPermissions, fromAdapterPermissions } from "./permissionMode";
import {
  PI_PLAN_TOOL_WHITELIST,
  EXEC_PERMISSIONS,
  DIR_PERMISSIONS,
  type ExecPermission,
  type DirPermission,
} from "../desktop/types";

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

  it("auto(自动执行)+ 所有文件(full-auto):不收窄工具、不闸目录(confineToCwd=false),审批沿用 piCustom", () => {
    expect(derivePiCapabilities("full-auto", "auto")).toEqual({
      toolWhitelist: undefined,
      enableToolApproval: undefined,
      approvalTools: undefined,
      confineToCwd: false,
    });
    const withApproval = derivePiCapabilities("accept-edits", "auto", { toolApproval: true, approvalTools: ["bash"] });
    expect(withApproval.enableToolApproval).toBe(true);
    expect(withApproval.approvalTools).toEqual(["bash"]);
  });

  it("目录执行权限 confineToCwd 派生:仅工作目录(accept-edits)/外部沙箱(sandbox)→ true;所有文件(full-auto)→ false;plan 不闸", () => {
    expect(derivePiCapabilities("accept-edits", "auto").confineToCwd).toBe(true);
    expect(derivePiCapabilities("accept-edits", "ask").confineToCwd).toBe(true);
    expect(derivePiCapabilities("sandbox", "auto").confineToCwd).toBe(true);
    expect(derivePiCapabilities("full-auto", "auto").confineToCwd).toBe(false);
    expect(derivePiCapabilities("full-auto", "ask").confineToCwd).toBe(false);
    // plan 走只读白名单,读全盘(与 codex read-only 一致),不闸目录。
    expect(derivePiCapabilities("plan", "auto").confineToCwd).toBeUndefined();
  });

  it("缺省(undefined×undefined)= auto + 所有文件的历史默认(不闸目录)", () => {
    expect(derivePiCapabilities(undefined, undefined)).toEqual(derivePiCapabilities("full-auto", "auto"));
    expect(derivePiCapabilities(undefined, undefined).confineToCwd).toBe(false);
  });
});

describe("toAdapterPermissions(执行 × 目录 → 线格式)", () => {
  // 7 行映射表(对齐方案):exec=plan 忽略目录;否则 dir 定范围、exec 定审批。
  const cases: Array<[ExecPermission, DirPermission, string, string]> = [
    ["plan", "workspace", "plan", "auto"],
    ["plan", "all", "plan", "auto"], // plan 忽略目录轴
    ["ask", "workspace", "accept-edits", "ask"],
    ["ask", "all", "full-auto", "ask"],
    ["ask", "sandbox", "sandbox", "ask"],
    ["auto", "workspace", "accept-edits", "auto"],
    ["auto", "all", "full-auto", "auto"],
    ["auto", "sandbox", "sandbox", "auto"],
  ];
  it.each(cases)("exec=%s dir=%s → {permissionMode:%s, approvalPolicy:%s}", (exec, dir, mode, approval) => {
    expect(toAdapterPermissions(exec, dir)).toEqual({ permissionMode: mode, approvalPolicy: approval });
  });

  it("缺省回退:undefined×undefined → 历史 full-auto + auto", () => {
    expect(toAdapterPermissions(undefined, undefined)).toEqual({ permissionMode: "full-auto", approvalPolicy: "auto" });
  });

  it("新会话默认(auto + workspace)派生 = 历史 landing 默认 {accept-edits, auto}", () => {
    expect(toAdapterPermissions("auto", "workspace")).toEqual({ permissionMode: "accept-edits", approvalPolicy: "auto" });
  });
});

describe("fromAdapterPermissions(线格式 → 执行 × 目录,迁移用)", () => {
  it("plan → exec=plan,目录落新会话默认 workspace(不暴露 all),丢弃 approval(无损)", () => {
    expect(fromAdapterPermissions("plan", "auto")).toEqual({ execPermission: "plan", dirPermission: "workspace" });
    expect(fromAdapterPermissions("plan", "ask")).toEqual({ execPermission: "plan", dirPermission: "workspace" });
  });

  it("accept-edits/full-auto/sandbox × auto/ask → 目录 + 执行 正确还原", () => {
    expect(fromAdapterPermissions("accept-edits", "auto")).toEqual({ execPermission: "auto", dirPermission: "workspace" });
    expect(fromAdapterPermissions("accept-edits", "ask")).toEqual({ execPermission: "ask", dirPermission: "workspace" });
    expect(fromAdapterPermissions("full-auto", "auto")).toEqual({ execPermission: "auto", dirPermission: "all" });
    expect(fromAdapterPermissions("sandbox", "ask")).toEqual({ execPermission: "ask", dirPermission: "sandbox" });
  });

  it("缺省 permissionMode(undefined)→ 历史 full-auto 还原 = auto + all", () => {
    expect(fromAdapterPermissions(undefined, undefined)).toEqual({ execPermission: "auto", dirPermission: "all" });
  });

  it("往返一致性 to∘from:除 plan 丢 approval 外,所有 exec≠plan 组合恒等", () => {
    for (const exec of EXEC_PERMISSIONS) {
      for (const dir of DIR_PERMISSIONS) {
        const wire = toAdapterPermissions(exec, dir);
        const back = fromAdapterPermissions(wire.permissionMode, wire.approvalPolicy);
        if (exec === "plan") {
          expect(back.execPermission).toBe("plan"); // 目录轴 plan 下无意义,不校验 dir
        } else {
          expect(back).toEqual({ execPermission: exec, dirPermission: dir });
        }
      }
    }
  });
});
