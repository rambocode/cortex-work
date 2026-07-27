import { ipcMain } from "electron";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import {
  createConversationArtifact,
  isKnownConversationArtifactRoot,
  resolveConversationArtifactRoot,
  validateConversationArtifact,
  type CreateConversationArtifactOptions,
} from "./artifact-workspace";
import { assertAllowed } from "./fs";
import { getPersistedState } from "./store";
import { documentsCortexDir } from "../paths";
import { createBentoDeck } from "../capabilities/slides/bento-workspace";
import { readBentoRuntimeHtml } from "../capabilities/slides/bento-runtime";
import type {
  ConversationArtifactCreateRequest,
  ConversationArtifactRef,
  ConversationArtifactResult,
  PersistedState,
} from "./types";

type SlidesCreateResult = { ok: true } | { ok: false; error?: { message?: string } };

interface ArtifactIpcDeps {
  loadState(): Promise<PersistedState>;
  fallbackRoot(): string;
  assertAllowed(path: string): Promise<void>;
  create(options: CreateConversationArtifactOptions): Promise<ConversationArtifactRef>;
  validate(artifact: ConversationArtifactRef): Promise<ConversationArtifactRef>;
  createSlidesDeck(
    workspaceRoot: string,
    documentId: string,
    title: string,
  ): Promise<SlidesCreateResult>;
}

export function createArtifactIpcHandlers(deps: ArtifactIpcDeps): {
  create(request: ConversationArtifactCreateRequest): Promise<ConversationArtifactResult>;
  validate(artifact: ConversationArtifactRef): Promise<ConversationArtifactResult>;
} {
  return {
    async create(request) {
      try {
        if (request.kind !== "design" && request.kind !== "slides") {
          throw new Error(`非法产物类型: ${String(request.kind)}`);
        }
        const state = await deps.loadState();
        const workspaceRoot = resolveConversationArtifactRoot(
          request,
          state,
          deps.fallbackRoot(),
        );
        await deps.assertAllowed(workspaceRoot);
        const artifact = await deps.create({
          kind: request.kind,
          title: request.title,
          workspaceRoot,
          createSlidesDeck: (documentId) =>
            deps.createSlidesDeck(workspaceRoot, documentId, request.title),
        });
        return { ok: true, artifact };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async validate(artifact) {
      try {
        const state = await deps.loadState();
        const fallbackRoot = deps.fallbackRoot();
        if (!isKnownConversationArtifactRoot(artifact.workspaceRoot, state, fallbackRoot)) {
          throw new Error("产物工作区未注册");
        }
        await deps.assertAllowed(artifact.workspaceRoot);
        return { ok: true, artifact: await deps.validate(artifact) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function registerArtifactHandlers(): void {
  const handlers = createArtifactIpcHandlers({
    loadState: getPersistedState,
    fallbackRoot: () => join(documentsCortexDir(), "design"),
    assertAllowed,
    create: createConversationArtifact,
    validate: validateConversationArtifact,
    async createSlidesDeck(workspaceRoot, documentId, title) {
      await fsp.mkdir(workspaceRoot, { recursive: true });
      const result = await createBentoDeck({
        workspaceRoot,
        deckId: documentId,
        title: title.trim() || "新演示文稿",
        runtimeHtml: await readBentoRuntimeHtml(),
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
  });
  ipcMain.handle("artifact:create", (_event, request: ConversationArtifactCreateRequest) =>
    handlers.create(request),
  );
  ipcMain.handle("artifact:validate", (_event, artifact: ConversationArtifactRef) =>
    handlers.validate(artifact),
  );
}
