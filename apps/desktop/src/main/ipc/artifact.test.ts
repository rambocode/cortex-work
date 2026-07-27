import { describe, expect, it, vi } from "vitest";
import type {
  ConversationArtifactCreateRequest,
  ConversationArtifactRef,
  PersistedState,
} from "./types";
import { createArtifactIpcHandlers } from "./artifact";

const state: PersistedState = {
  version: 1,
  projects: [{ id: "project-1", name: "Project", path: "/project", addedAt: 1 }],
  sessions: [],
};

const artifact: ConversationArtifactRef = {
  kind: "design",
  documentId: "doc-1",
  title: "Home",
  workspaceRoot: "/project",
  entryPath: "/project/.cortex-design/doc-1",
  createdAt: 1,
  updatedAt: 1,
};

describe("artifact IPC handlers", () => {
  it("rejects an invalid runtime kind before creating files", async () => {
    const create = vi.fn(async () => artifact);
    const handlers = createArtifactIpcHandlers({
      loadState: async () => state,
      fallbackRoot: () => "/global/design",
      assertAllowed: async () => undefined,
      create,
      validate: async (value) => value,
      createSlidesDeck: async () => ({ ok: true }),
    });

    await expect(
      handlers.create({ kind: "other", title: "Invalid" } as unknown as ConversationArtifactCreateRequest),
    ).resolves.toEqual({ ok: false, error: "非法产物类型: other" });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates project artifacts from the registered project root", async () => {
    const create = vi.fn(async () => artifact);
    const handlers = createArtifactIpcHandlers({
      loadState: async () => state,
      fallbackRoot: () => "/global/design",
      assertAllowed: async () => undefined,
      create,
      validate: async (value) => value,
      createSlidesDeck: async () => ({ ok: true }),
    });

    const request: ConversationArtifactCreateRequest = {
      kind: "design",
      title: "Home",
      projectId: "project-1",
    };
    await expect(handlers.create(request)).resolves.toEqual({ ok: true, artifact });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "design", title: "Home", workspaceRoot: "/project" }),
    );
  });

  it("rejects validation when the renderer supplies an unregistered workspace root", async () => {
    const validate = vi.fn(async (value: ConversationArtifactRef) => value);
    const handlers = createArtifactIpcHandlers({
      loadState: async () => state,
      fallbackRoot: () => "/global/design",
      assertAllowed: async () => undefined,
      create: async () => artifact,
      validate,
      createSlidesDeck: async () => ({ ok: true }),
    });

    const result = await handlers.validate({ ...artifact, workspaceRoot: "/project/nested" });
    expect(result).toEqual({ ok: false, error: "产物工作区未注册" });
    expect(validate).not.toHaveBeenCalled();
  });
});
