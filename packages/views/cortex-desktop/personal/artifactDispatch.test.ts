import { describe, expect, it, vi } from "vitest";
import type {
  ConversationArtifactRef,
  DesktopBridge,
  SessionMeta,
} from "@cortex-work/core";
import {
  conversationArtifacts,
  prepareArtifactDispatch,
  upsertConversationArtifact,
} from "./artifactDispatch";

const design: ConversationArtifactRef = {
  kind: "design",
  documentId: "design-1",
  title: "Home",
  workspaceRoot: "/project",
  entryPath: "/project/.cortex-design/design-1",
  createdAt: 1,
  updatedAt: 1,
};
const session: SessionMeta = {
  id: "s1",
  title: "Session",
  agent: "claude",
  createdAt: 1,
  updatedAt: 1,
  activeArtifact: design,
};

describe("conversation artifact dispatch", () => {
  it("移除当前绑定后仍从会话历史展示已创建产物", () => {
    const withoutBinding = { ...session, activeArtifact: undefined, artifacts: [design] };
    expect(conversationArtifacts(withoutBinding)).toEqual([design]);
  });

  it("按工作区与文稿 ID 去重更新会话产物历史", () => {
    const updated = { ...design, title: "Home v2", updatedAt: 2 };
    expect(upsertConversationArtifact([design], updated)).toEqual([updated]);
  });

  it("普通追问继续绑定当前产物", async () => {
    const result = await prepareArtifactDispatch(
      {} as DesktopBridge,
      session,
      "把按钮改成蓝色",
    );
    expect(result).toMatchObject({
      handledSkill: false,
      outText: "把按钮改成蓝色",
      artifact: design,
    });
  });

  it("同类 skill 复用并校验当前产物", async () => {
    const validate = vi.fn(async () => ({ ok: true as const, artifact: design }));
    const create = vi.fn();
    const result = await prepareArtifactDispatch(
      {
        artifactValidate: validate,
        artifactCreate: create,
      } as unknown as DesktopBridge,
      session,
      "/skill:design 调整首页",
    );
    expect(result.artifact).toEqual(design);
    expect(validate).toHaveBeenCalledWith(design);
    expect(create).not.toHaveBeenCalled();
  });

  it("Artifact 固定使用第一方 skill，不接受同名用户 skill 覆盖", async () => {
    const result = await prepareArtifactDispatch(
      {
        artifactCreate: vi.fn(),
        artifactValidate: async () => ({ ok: true as const, artifact: design }),
        builtinSkillGet: async () => ({
          name: "design",
          description: "Builtin",
          dir: "/builtin/design",
          skillMdPath: "/builtin/design/SKILL.md",
        }),
        skillGet: async () => ({
          name: "design",
          description: "Override",
          dir: "/user/design",
          skillMdPath: "/user/design/SKILL.md",
        }),
      } as unknown as DesktopBridge,
      { ...session, agent: "codex" },
      "/skill:design 调整首页",
    );
    expect(result.invokedSkill).toEqual({
      name: "design",
      path: "/builtin/design",
    });
    expect(result.outText).toBe("调整首页");
  });

  it("Pi 产物调用保留原生 slash，并把第一方 skill 路径交给发送层", async () => {
    const result = await prepareArtifactDispatch(
      {
        artifactCreate: vi.fn(),
        artifactValidate: async () => ({ ok: true as const, artifact: design }),
        builtinSkillGet: async () => ({
          name: "design",
          description: "Builtin",
          dir: "/builtin/design",
          skillMdPath: "/builtin/design/SKILL.md",
        }),
      } as unknown as DesktopBridge,
      { ...session, agent: "pi" },
      "/skill:design 调整首页",
    );

    expect(result.outText).toBe("/skill:design 调整首页");
    expect(result.invokedSkill).toEqual({
      name: "design",
      path: "/builtin/design",
    });
  });

  // 会话标题取自发给 agent 的文本,而 pi 走原生 slash、claude 走 prose,两种都会把
  // 「/skill:design …」「请使用 skill「design」…」搬进标题栏(用户实测)。userText 是给
  // 标题用的那句用户原话。
  it("透出用户原话供会话标题使用(不含 /skill: 前缀)", async () => {
    const result = await prepareArtifactDispatch(
      {
        artifactCreate: vi.fn(),
        artifactValidate: async () => ({ ok: true as const, artifact: design }),
        builtinSkillGet: async () => ({
          name: "design",
          description: "Builtin",
          dir: "/builtin/design",
          skillMdPath: "/builtin/design/SKILL.md",
        }),
      } as unknown as DesktopBridge,
      { ...session, agent: "pi" },
      "/skill:design   设计一张海报  ",
    );

    expect(result.userText).toBe("设计一张海报");
  });

  it("不是 skill 派发时没有 userText(普通消息的标题照旧走原路径)", async () => {
    const result = await prepareArtifactDispatch(
      { artifactValidate: async () => ({ ok: true as const, artifact: design }) } as unknown as DesktopBridge,
      session,
      "继续改一下配色",
    );
    expect(result.userText).toBeUndefined();
  });

  it("切换产物类型时创建新产物", async () => {
    const slides = {
      ...design,
      kind: "slides" as const,
      documentId: "slides-1",
      title: "Quarterly",
      entryPath: "/project/.cortex-design/slides-1/deck.bento.html",
    };
    const create = vi.fn(async () => ({ ok: true as const, artifact: slides }));
    const result = await prepareArtifactDispatch(
      { artifactCreate: create } as unknown as DesktopBridge,
      { ...session, projectId: "project-1" },
      "/skill:slides Quarterly",
    );
    expect(create).toHaveBeenCalledWith({
      kind: "slides",
      title: "Quarterly",
      projectId: "project-1",
    });
    expect(result).toMatchObject({ handledSkill: true, created: true, artifact: slides });
  });
});
