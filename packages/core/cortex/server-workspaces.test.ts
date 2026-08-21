// server-workspaces 纯函数单测：分组、占用态、runtime 挑选与错误码映射。
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import type { ServerRuntime, ServerWorkspace } from "../api/types";
import {
  createServerWorkspaceErrorKey,
  groupServerWorkspaces,
  invokeServerWorkspaceErrorKey,
  pickRuntime,
  workspaceOccupancy,
} from "./server-workspaces";

function sw(partial: Partial<ServerWorkspace>): ServerWorkspace {
  return {
    id: "sw-1",
    workspace_id: "ws-1",
    daemon_id: "daemon-a",
    name: "工作区",
    slug: "ws",
    repo_url: "git@example.com:a/b.git",
    mode: "shared",
    visibility: "workspace",
    status: "ready",
    created_at: "2026-08-22T00:00:00Z",
    updated_at: "2026-08-22T00:00:00Z",
    ...partial,
  };
}

function rt(partial: Partial<ServerRuntime>): ServerRuntime {
  return { id: "rt-1", daemon_id: "daemon-a", name: "Build Server", online: true, ...partial };
}

describe("groupServerWorkspaces", () => {
  it("按 daemon_id 分组，label 取第一个 runtime 名，任一 runtime 在线即在线", () => {
    const groups = groupServerWorkspaces(
      [sw({ id: "s1" }), sw({ id: "s2", daemon_id: "daemon-b", name: "另一台" })],
      [
        rt({ id: "r1", online: false }),
        rt({ id: "r2", name: "Codex", online: true }),
        rt({ id: "r3", daemon_id: "daemon-b", name: "Zeta", online: false }),
      ],
    );
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.daemonId === "daemon-a")!;
    expect(a.label).toBe("Build Server");
    expect(a.online).toBe(true);
    expect(a.runtimes).toHaveLength(2);
    expect(a.workspaces.map((w) => w.id)).toEqual(["s1"]);
    const b = groups.find((g) => g.daemonId === "daemon-b")!;
    expect(b.online).toBe(false);
  });

  it("archived 工作区不进分组；无 runtime 的 daemon 也成组（label 回退 daemonId）", () => {
    const groups = groupServerWorkspaces([sw({ id: "s1", status: "archived" }), sw({ id: "s2", daemon_id: "d-x" })], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.daemonId).toBe("d-x");
    expect(groups[0]!.label).toBe("d-x");
  });
});

describe("workspaceOccupancy", () => {
  it("无运行任务 → free；他人任务 → occupied；自己任务 → mine", () => {
    expect(workspaceOccupancy(sw({}), "me")).toBe("free");
    expect(workspaceOccupancy(sw({ running_task_id: "t1", running_caller_id: "other" }), "me")).toBe("occupied");
    expect(workspaceOccupancy(sw({ running_task_id: "t1", running_caller_id: "me" }), "me")).toBe("mine");
  });
});

describe("pickRuntime", () => {
  it("优先在线 runtime；全离线回退第一个（让服务端给明确错误）", () => {
    const g = groupServerWorkspaces([], [rt({ id: "r1", online: false }), rt({ id: "r2", online: true })])[0]!;
    expect(pickRuntime(g)!.id).toBe("r2");
    const offline = groupServerWorkspaces([], [rt({ id: "r1", online: false })])[0]!;
    expect(pickRuntime(offline)!.id).toBe("r1");
  });
});

describe("错误码映射", () => {
  it("创建：403 → 权限 key；409/slug_conflict → 撞名 key；其余 → 通用失败", () => {
    expect(createServerWorkspaceErrorKey(new ApiError("x", 403, "Forbidden"))).toBe("serverWs.errNeedAdmin");
    expect(createServerWorkspaceErrorKey(new ApiError("x", 409, "Conflict"))).toBe("serverWs.errNameConflict");
    expect(createServerWorkspaceErrorKey(new Error("boom"))).toBe("serverWs.errCreateFailed");
  });

  it("invoke：instance_provisioning / runtime_offline 分别映射；其余 → 通用失败", () => {
    expect(invokeServerWorkspaceErrorKey(new ApiError("x", 202, "Accepted", "instance_provisioning"))).toBe(
      "serverWs.errProvisioning",
    );
    expect(invokeServerWorkspaceErrorKey(new ApiError("x", 409, "Conflict", "runtime_offline"))).toBe("serverWs.errOffline");
    expect(invokeServerWorkspaceErrorKey(new Error("boom"))).toBe("serverWs.errInvokeFailed");
  });
});
