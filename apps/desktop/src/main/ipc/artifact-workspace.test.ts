import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertConversationArtifactRunIdentity,
  assertConversationArtifactRequestShape,
  createConversationArtifact,
  resolveConversationArtifactRoot,
  validateConversationArtifact,
} from "./artifact-workspace";

describe("conversation artifact workspace", () => {
  it("项目会话使用项目根,无项目会话回退全局设计根", () => {
    const state = {
      projects: [{ id: "p1", name: "Project", path: "/projects/one", addedAt: 1 }],
    };
    expect(resolveConversationArtifactRoot({ projectId: "p1" }, state, "/global/design")).toBe(
      "/projects/one",
    );
    expect(resolveConversationArtifactRoot({}, state, "/global/design")).toBe("/global/design");
    expect(() =>
      resolveConversationArtifactRoot({ projectId: "missing" }, state, "/global/design"),
    ).toThrow("找不到项目");
  });

  it("创建设计稿时保留已有 documents.json 并追加新文稿", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-artifact-"));
    const first = await createConversationArtifact({
      kind: "design",
      title: "First",
      workspaceRoot: root,
      now: new Date("2026-07-27T00:00:00.000Z"),
      documentId: "doc-one",
    });
    const second = await createConversationArtifact({
      kind: "slides",
      title: "Deck",
      workspaceRoot: root,
      now: new Date("2026-07-27T00:01:00.000Z"),
      documentId: "doc-two",
      createSlidesDeck: async () => ({ ok: true }),
    });

    expect(first.entryPath).toBe(join(root, ".cortex-design/doc-one"));
    expect(second.entryPath).toBe(join(root, ".cortex-design/doc-two/deck.bento.html"));
    const index = JSON.parse(await readFile(join(root, ".cortex-design/documents.json"), "utf8"));
    expect(index.documents).toHaveLength(2);
    expect(index.documents[1]).toMatchObject({
      id: "doc-two",
      kind: "slides",
      slidesManifestPath: ".cortex-design/doc-two/deck.bento.html",
    });
  });

  it("并发创建同一工作区产物时不丢失索引条目", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-artifact-"));
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createConversationArtifact({
          kind: "design",
          title: `Design ${index}`,
          workspaceRoot: root,
          documentId: `design-${index}`,
        }),
      ),
    );
    const index = JSON.parse(await readFile(join(root, ".cortex-design/documents.json"), "utf8"));
    expect(index.documents.map((document: { id: string }) => document.id).sort()).toEqual(
      Array.from({ length: 8 }, (_, item) => `design-${item}`),
    );
  });

  it("拒绝通过 .cortex-design 符号链接向工作区外写入", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-artifact-root-"));
    const outside = await mkdtemp(join(tmpdir(), "cortex-artifact-outside-"));
    await symlink(outside, join(root, ".cortex-design"));
    await expect(
      createConversationArtifact({
        kind: "design",
        title: "Escaped",
        workspaceRoot: root,
        documentId: "escaped",
      }),
    ).rejects.toThrow("符号链接");
  });

  it("按索引校验持久产物并拒绝伪造的入口路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-artifact-"));
    const artifact = await createConversationArtifact({
      kind: "design",
      title: "Settings",
      workspaceRoot: root,
      documentId: "design-1",
    });

    await expect(validateConversationArtifact(artifact)).resolves.toEqual(artifact);
    await expect(
      validateConversationArtifact({ ...artifact, entryPath: join(root, "secrets") }),
    ).rejects.toThrow("产物路径不匹配");
  });

  it("索引损坏时拒绝创建且不覆盖原文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "cortex-artifact-"));
    const indexPath = join(root, ".cortex-design/documents.json");
    await mkdir(join(root, ".cortex-design"));
    await writeFile(indexPath, "{broken", "utf8");

    await expect(
      createConversationArtifact({
        kind: "design",
        title: "Do not overwrite",
        workspaceRoot: root,
        documentId: "design-1",
      }),
    ).rejects.toThrow("设计文稿索引损坏");
    await expect(readFile(indexPath, "utf8")).resolves.toBe("{broken");
  });

  it("校验产物回合的 cwd 与 run identity", () => {
    const artifact = {
      kind: "slides" as const,
      documentId: "deck-1",
      title: "Deck",
      workspaceRoot: "/project",
      entryPath: "/project/.cortex-design/deck-1/deck.bento.html",
      createdAt: 1,
      updatedAt: 1,
    };
    expect(() =>
      assertConversationArtifactRunIdentity(
        artifact,
        "/project",
        "artifact:slides:deck-1:run-1",
      ),
    ).not.toThrow();
    expect(() =>
      assertConversationArtifactRunIdentity(
        artifact,
        "/other",
        "artifact:slides:deck-1:run-1",
      ),
    ).toThrow("cwd");
    expect(() =>
      assertConversationArtifactRunIdentity(
        artifact,
        "/project",
        "artifact:slides:other:run-1",
      ),
    ).toThrow("runId");
  });

  it("artifact runId 与 artifactContext 必须成对出现", () => {
    expect(() =>
      assertConversationArtifactRequestShape("artifact:design:doc-1:run", undefined),
    ).toThrow("artifactContext");
    expect(() =>
      assertConversationArtifactRequestShape("ordinary-run", {
        kind: "design",
        documentId: "doc-1",
        title: "Design",
        workspaceRoot: "/project",
        entryPath: "/project/.cortex-design/doc-1",
        createdAt: 1,
        updatedAt: 1,
      }),
    ).toThrow("runId");
  });
});
