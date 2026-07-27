import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  parseDocumentsIndex,
  type DesignDocumentIndexEntry,
  type DesignDocumentsIndex,
} from "@cortex-work/core/design/design-document-persistence";
import { bentoDeckHtmlPath } from "@cortex-work/core/design/slides/slides-paths";
import type {
  ConversationArtifactKind,
  ConversationArtifactRef,
  ProjectMeta,
} from "./types";

type ArtifactRootState = { projects: ProjectMeta[] };
const indexQueues = new Map<string, Promise<void>>();

export function resolveConversationArtifactRoot(
  request: { projectId?: string },
  state: ArtifactRootState,
  fallbackRoot: string,
): string {
  if (!request.projectId) return fallbackRoot;
  const project = state.projects.find((candidate) => candidate.id === request.projectId);
  if (!project) throw new Error(`找不到项目: ${request.projectId}`);
  return project.path;
}

export function isKnownConversationArtifactRoot(
  workspaceRoot: string,
  state: ArtifactRootState,
  fallbackRoot: string,
): boolean {
  const candidate = resolve(workspaceRoot);
  return [fallbackRoot, ...state.projects.map((project) => project.path)].some(
    (root) => resolve(root) === candidate,
  );
}

export function assertConversationArtifactRunIdentity(
  artifact: ConversationArtifactRef,
  cwd: string,
  runId: string,
): void {
  if (resolve(cwd) !== resolve(artifact.workspaceRoot)) {
    throw new Error("产物 cwd 不匹配");
  }
  const expectedPrefix = `artifact:${artifact.kind}:${safeDocumentId(artifact.documentId)}:`;
  if (!runId.startsWith(expectedPrefix)) throw new Error("产物 runId 不匹配");
}

export function assertConversationArtifactRequestShape(
  runId: string,
  artifact: ConversationArtifactRef | undefined,
): void {
  const artifactRun = runId.startsWith("artifact:");
  if (artifactRun && !artifact) throw new Error("产物 runId 缺少 artifactContext");
  if (!artifactRun && artifact) throw new Error("artifactContext 必须使用产物 runId");
}

type SlidesCreateResult = { ok: true } | { ok: false; error?: { message?: string } };

export interface CreateConversationArtifactOptions {
  kind: ConversationArtifactKind;
  title: string;
  workspaceRoot: string;
  now?: Date;
  documentId?: string;
  createSlidesDeck?: (documentId: string) => Promise<SlidesCreateResult>;
}

function safeDocumentId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`非法产物 id: ${value}`);
  }
  return value;
}

async function readIndex(path: string): Promise<DesignDocumentsIndex | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = parseDocumentsIndex(raw);
  if (!parsed) throw new Error("设计文稿索引损坏，已拒绝覆盖");
  return parsed;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await fsp.mkdir(dirname(path), { recursive: true });
  try {
    await fsp.writeFile(temp, content, "utf8");
    await fsp.rename(temp, path);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function withIndexLock<T>(indexPath: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(indexPath);
  const previous = indexQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((done) => {
    release = done;
  });
  const queued = previous.then(() => current);
  indexQueues.set(key, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (indexQueues.get(key) === queued) indexQueues.delete(key);
  }
}

async function assertContainedNonSymlink(
  workspaceRoot: string,
  path: string,
): Promise<void> {
  const stat = await fsp.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`产物路径不得使用符号链接: ${path}`);
  const [realRoot, realPath] = await Promise.all([
    fsp.realpath(workspaceRoot),
    fsp.realpath(path),
  ]);
  const child = relative(realRoot, realPath);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`产物路径越出工作区: ${path}`);
  }
}

export async function createConversationArtifact(
  options: CreateConversationArtifactOptions,
): Promise<ConversationArtifactRef> {
  if (options.kind !== "design" && options.kind !== "slides") {
    throw new Error(`非法产物类型: ${String(options.kind)}`);
  }
  const now = options.now ?? new Date();
  const documentId = safeDocumentId(options.documentId ?? randomUUID().slice(0, 8));
  const title = options.title.trim() || (options.kind === "slides" ? "新演示文稿" : "新设计稿");
  const designRoot = join(options.workspaceRoot, ".cortex-design");
  const documentRoot = join(designRoot, documentId);
  const indexPath = join(designRoot, "documents.json");
  return withIndexLock(indexPath, async () => {
    await fsp.mkdir(options.workspaceRoot, { recursive: true });
    await assertContainedNonSymlink(options.workspaceRoot, designRoot);
    await fsp.mkdir(designRoot, { recursive: true });
    await assertContainedNonSymlink(options.workspaceRoot, designRoot);
    await assertContainedNonSymlink(options.workspaceRoot, indexPath);
    const current = await readIndex(indexPath);
    if (current?.documents.some((document) => document.id === documentId)) {
      throw new Error(`产物已存在: ${documentId}`);
    }

    await assertContainedNonSymlink(options.workspaceRoot, documentRoot);
    await fsp.mkdir(documentRoot, { recursive: true });
    await assertContainedNonSymlink(options.workspaceRoot, documentRoot);
    if (options.kind === "slides") {
      if (!options.createSlidesDeck) throw new Error("缺少 Slides deck 创建能力");
      const created = await options.createSlidesDeck(documentId);
      if (!created.ok) throw new Error(created.error?.message || "创建演示文稿失败");
      await assertContainedNonSymlink(
        options.workspaceRoot,
        join(options.workspaceRoot, bentoDeckHtmlPath(documentId)),
      );
    }

    const iso = now.toISOString();
    const entry: DesignDocumentIndexEntry = {
      id: documentId,
      title,
      order: current?.documents.length ?? 0,
      createdAt: iso,
      updatedAt: iso,
      activeArtifactId: null,
      ...(options.kind === "slides"
        ? {
            kind: "slides" as const,
            slidesManifestPath: bentoDeckHtmlPath(documentId),
          }
        : {}),
    };
    const next: DesignDocumentsIndex = {
      version: 1,
      activeDocumentId: documentId,
      documents: [...(current?.documents ?? []), entry],
    };
    await atomicWrite(indexPath, `${JSON.stringify(next, null, 2)}\n`);

    return {
      kind: options.kind,
      documentId,
      title,
      workspaceRoot: options.workspaceRoot,
      entryPath:
        options.kind === "slides"
          ? join(options.workspaceRoot, bentoDeckHtmlPath(documentId))
          : documentRoot,
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };
  });
}

export async function validateConversationArtifact(
  artifact: ConversationArtifactRef,
): Promise<ConversationArtifactRef> {
  const documentId = safeDocumentId(artifact.documentId);
  const designRoot = join(artifact.workspaceRoot, ".cortex-design");
  const indexPath = join(designRoot, "documents.json");
  await assertContainedNonSymlink(artifact.workspaceRoot, designRoot);
  await assertContainedNonSymlink(artifact.workspaceRoot, indexPath);
  const index = await readIndex(indexPath);
  const entry = index?.documents.find((document) => document.id === documentId);
  if (!entry) throw new Error(`找不到产物: ${documentId}`);

  const indexedKind: ConversationArtifactKind = entry.kind === "slides" ? "slides" : "design";
  if (indexedKind !== artifact.kind) throw new Error("产物类型不匹配");
  const expectedEntryPath =
    indexedKind === "slides"
      ? join(artifact.workspaceRoot, bentoDeckHtmlPath(documentId))
      : join(designRoot, documentId);
  if (resolve(expectedEntryPath) !== resolve(artifact.entryPath)) {
    throw new Error("产物路径不匹配");
  }
  await assertContainedNonSymlink(artifact.workspaceRoot, expectedEntryPath);
  const stat = await fsp.stat(expectedEntryPath).catch(() => null);
  if (!stat || (indexedKind === "design" ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`产物入口不存在: ${documentId}`);
  }
  return artifact;
}
