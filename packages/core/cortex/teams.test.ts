import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import {
  teamKeys,
  workspaceKeys,
  invitationKeys,
  squadMemberKeys,
  invalidateAfterCreateSquad,
  invalidateAfterMembershipChange,
  invalidateAfterAcceptInvitation,
  invalidateAfterRemoveMember,
  createSquadErrorKey,
  joinSquadErrorKey,
  inviteMemberErrorKey,
  acceptInvitationErrorKey,
  updateSquadErrorKey,
  removeMemberErrorKey,
  resolveWorkspaceRole,
  canManageWorkspace,
  mapSquadMemberRows,
} from "./teams";
import { contactKeys, conversationKeys } from "./queries";
import type { SquadMember, WorkspaceMember } from "../api/types";

describe("teamKeys", () => {
  it("按 wsId 命名空间隔离,切 workspace 不共享缓存键", () => {
    expect(teamKeys.list("ws1")).toEqual(["squads", "ws1", "list"]);
    expect(teamKeys.all("ws1")).not.toEqual(teamKeys.all("ws2"));
  });
});

describe("invalidateAfterCreateSquad", () => {
  it("建团成功仅失效该 wsId 的 squads 键(不误伤通讯录/会话)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateAfterCreateSquad(qc, "ws1");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ queryKey: teamKeys.all("ws1") });
  });
});

describe("invalidateAfterMembershipChange", () => {
  it("退团/加入成功失效 squads + contacts + conversation(成员及其分身即刻变化)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateAfterMembershipChange(qc, "ws1");
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(teamKeys.all("ws1"));
    expect(keys).toContainEqual(contactKeys.all("ws1"));
    expect(keys).toContainEqual(conversationKeys.all("ws1"));
  });
});

describe("createSquadErrorKey", () => {
  it("403 → 需要管理员权限文案", () => {
    expect(createSquadErrorKey(new ApiError("forbidden", 403, "Forbidden"))).toBe("team.errNeedAdmin");
  });
  it("其它错误 → 通用建团失败文案", () => {
    expect(createSquadErrorKey(new ApiError("boom", 500, "Err"))).toBe("team.errCreateFailed");
    expect(createSquadErrorKey(new Error("x"))).toBe("team.errCreateFailed");
  });
});

describe("joinSquadErrorKey", () => {
  it("code_expired → 邀请码过期/无效文案", () => {
    expect(joinSquadErrorKey(new ApiError("gone", 410, "Gone", "code_expired"))).toBe("team.errCodeExpired");
  });
  it("其它错误 → 通用加入失败文案", () => {
    expect(joinSquadErrorKey(new ApiError("boom", 500, "Err"))).toBe("team.errJoinFailed");
    expect(joinSquadErrorKey(undefined)).toBe("team.errJoinFailed");
  });
});

// ── W2：新增 query key / 失效范围 / 错误映射 / 纯 transform ────────────────────

describe("W2 query keys", () => {
  it("workspaceKeys.members 按 wsId 命名空间隔离", () => {
    expect(workspaceKeys.members("ws1")).toEqual(["workspace-members", "ws1"]);
    expect(workspaceKeys.members("ws1")).not.toEqual(workspaceKeys.members("ws2"));
  });
  it("invitationKeys.mine 不按 wsId 命名空间(跨 workspace 收件人视角)", () => {
    expect(invitationKeys.mine()).toEqual(["invitations", "mine"]);
  });
  it("squadMemberKeys.detail 含 wsId + squadId", () => {
    expect(squadMemberKeys.detail("ws1", "sq1")).toEqual(["squad-members", "ws1", "sq1"]);
  });
});

describe("invalidateAfterAcceptInvitation", () => {
  it("接受邀请失效 workspaces + contacts + squads + invitations", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateAfterAcceptInvitation(qc, "ws1");
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(workspaceKeys.all());
    expect(keys).toContainEqual(contactKeys.all("ws1"));
    expect(keys).toContainEqual(teamKeys.all("ws1"));
    expect(keys).toContainEqual(invitationKeys.all());
  });
});

describe("invalidateAfterRemoveMember", () => {
  it("移除成员失效 squad members + contacts(联动注销共享分身)", () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateAfterRemoveMember(qc, "ws1");
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);
    expect(keys).toContainEqual(squadMemberKeys.all("ws1"));
    expect(keys).toContainEqual(contactKeys.all("ws1"));
    // 不误伤会话缓存(移除成员不需要重取 conversation 全表)
    expect(keys).not.toContainEqual(conversationKeys.all("ws1"));
  });
});

describe("W2 错误映射", () => {
  it("inviteMemberErrorKey：403 → 需要管理员权限,其它 → 通用邀请失败", () => {
    expect(inviteMemberErrorKey(new ApiError("f", 403, "Forbidden"))).toBe("team.errNeedAdmin");
    expect(inviteMemberErrorKey(new ApiError("f", 500, "Err"))).toBe("team.errInviteFailed");
  });
  it("acceptInvitationErrorKey：410 过期 / 409 已是成员 / 其它通用失败", () => {
    expect(acceptInvitationErrorKey(new ApiError("g", 410, "Gone"))).toBe("team.errInviteExpired");
    expect(acceptInvitationErrorKey(new ApiError("c", 409, "Conflict"))).toBe("team.alreadyMember");
    expect(acceptInvitationErrorKey(new ApiError("x", 500, "Err"))).toBe("team.errAcceptFailed");
  });
  it("updateSquadErrorKey / removeMemberErrorKey：403 → 需要管理员权限", () => {
    expect(updateSquadErrorKey(new ApiError("f", 403, "Forbidden"))).toBe("team.errNeedAdmin");
    expect(updateSquadErrorKey(new ApiError("f", 500, "Err"))).toBe("team.errSaveFailed");
    expect(removeMemberErrorKey(new ApiError("f", 403, "Forbidden"))).toBe("team.errNeedAdmin");
    expect(removeMemberErrorKey(new ApiError("f", 500, "Err"))).toBe("team.removeFailed");
  });
});

describe("resolveWorkspaceRole / canManageWorkspace", () => {
  const members: WorkspaceMember[] = [
    {
      id: "wm1",
      workspace_id: "ws1",
      user_id: "u1",
      role: "owner",
      created_at: "",
      name: "Owner",
      email: "o@x.com",
      avatar_url: null,
    },
    {
      id: "wm2",
      workspace_id: "ws1",
      user_id: "u2",
      role: "member",
      created_at: "",
      name: "Member",
      email: "m@x.com",
      avatar_url: null,
    },
  ];

  it("按 user_id 找到角色,找不到返回 null", () => {
    expect(resolveWorkspaceRole(members, "u1")).toBe("owner");
    expect(resolveWorkspaceRole(members, "u2")).toBe("member");
    expect(resolveWorkspaceRole(members, "u9")).toBeNull();
  });
  it("owner/admin 可管理,member/null 不可", () => {
    expect(canManageWorkspace("owner")).toBe(true);
    expect(canManageWorkspace("admin")).toBe(true);
    expect(canManageWorkspace("member")).toBe(false);
    expect(canManageWorkspace(null)).toBe(false);
  });
});

describe("mapSquadMemberRows", () => {
  const wsMembers: WorkspaceMember[] = [
    {
      id: "wm1",
      workspace_id: "ws1",
      user_id: "u1",
      role: "member",
      created_at: "",
      name: "张三",
      email: "z@x.com",
      avatar_url: "http://a/1.png",
    },
  ];
  const squadMembers: SquadMember[] = [
    { id: "sm1", squad_id: "sq1", member_type: "member", member_id: "u1", role: "leader", created_at: "" },
    { id: "sm2", squad_id: "sq1", member_type: "member", member_id: "u_unknown", role: "member", created_at: "" },
    { id: "sm3", squad_id: "sq1", member_type: "agent", member_id: "agent_9", role: "member", created_at: "" },
  ];

  it("人类成员按 member_id===user_id 解析名字/邮箱/头像", () => {
    const rows = mapSquadMemberRows(squadMembers, wsMembers);
    expect(rows[0]).toMatchObject({
      memberId: "u1",
      name: "张三",
      email: "z@x.com",
      avatarUrl: "http://a/1.png",
      isAgent: false,
      isLeader: true,
    });
  });
  it("找不到对应 workspace 成员时名字回落 member_id、无邮箱", () => {
    const rows = mapSquadMemberRows(squadMembers, wsMembers);
    expect(rows[1]).toMatchObject({ name: "u_unknown", email: null, isAgent: false, isLeader: false });
  });
  it("agent 成员标 isAgent、无用户信息", () => {
    const rows = mapSquadMemberRows(squadMembers, wsMembers);
    expect(rows[2]).toMatchObject({ memberType: "agent", isAgent: true, name: "agent_9", email: null });
  });
});
