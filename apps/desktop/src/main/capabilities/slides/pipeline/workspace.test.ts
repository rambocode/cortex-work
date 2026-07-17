import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  SlidesPipelineRoleRun,
  SlidesPipelineRun,
  SlidesRole,
} from "@cortex-work/core/design/slides/slides-pipeline-types";
import { SLIDES_PIPELINE_MAX_MARKDOWN_CHARS } from "@cortex-work/core/design/slides/slides-pipeline-schema";
import { createDeckWorkspace } from "../workspace";
import {
  cancelSlidesPipelineRun,
  createSlidesPipelineRun,
  hasCompletedSlidesPipelineRunKind,
  listLatestRecoverableSlidesPipelineRun,
  loadSlidesPipelineRun,
  updateSlidesPipelineRun,
  writeSlidesRoleArtifact,
} from "./workspace";

const DECK = "deckabc1";
const NOW = "2026-07-17T00:00:00.000Z";
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cortex-slides-pipeline-"));
  const created = await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "Pipeline Deck", now: NOW });
  expect(created.ok).toBe(true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function roleRun(role: SlidesRole, overrides: Partial<SlidesPipelineRoleRun> = {}): SlidesPipelineRoleRun {
  return {
    role,
    status: "queued",
    artifactFile:
      role === "topic-researcher"
        ? "topic-research.json"
        : role === "visual-researcher"
          ? "visual-research.json"
          : role === "narrative-reviewer"
            ? "narrative-review.json"
            : role === "render-reviewer"
              ? "render-review.json"
              : "notes-draft.json",
    updatedAt: NOW,
    ...overrides,
  };
}

function run(id: string, overrides: Partial<SlidesPipelineRun> = {}): SlidesPipelineRun {
  return {
    schemaVersion: 1,
    id,
    deckId: DECK,
    kind: "review",
    deckRevisionAtStart: 3,
    status: "running",
    roles: [roleRun("narrative-reviewer", { status: "running" }), roleRun("render-reviewer")],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function runDir(id: string): string {
  return join(root, ".cortex-design", DECK, "drafts", "runs", id);
}

describe("slides pipeline workspace", () => {
  it("create/load 在固定 run 目录中原子写入 run.json", async () => {
    const created = await createSlidesPipelineRun({ workspaceRoot: root, run: run("run-001") });
    expect(created.ok).toBe(true);
    expect(existsSync(join(runDir("run-001"), "run.json"))).toBe(true);
    expect(readdirSync(runDir("run-001")).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const loaded = await loadSlidesPipelineRun({ workspaceRoot: root, deckId: DECK, runId: "run-001" });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.id).toBe("run-001");
  });

  it("update 用 expectedUpdatedAt 做乐观锁，cancel 只取消未终态角色", async () => {
    const created = await createSlidesPipelineRun({ workspaceRoot: root, run: run("run-002") });
    expect(created.ok).toBe(true);

    const updated = await updateSlidesPipelineRun({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-002",
      expectedUpdatedAt: NOW,
      now: "2026-07-17T00:00:01.000Z",
      mutate: (current) => ({
        ...current,
        status: "awaiting-approval",
        roles: current.roles.map((entry) =>
          entry.role === "narrative-reviewer" ? { ...entry, status: "awaiting-approval" } : entry,
        ),
      }),
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.value.updatedAt).toBe("2026-07-17T00:00:01.000Z");

    const conflict = await updateSlidesPipelineRun({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-002",
      expectedUpdatedAt: NOW,
      now: "2026-07-17T00:00:02.000Z",
      mutate: (current) => current,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("revision_conflict");

    const canceled = await cancelSlidesPipelineRun({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-002",
      expectedUpdatedAt: "2026-07-17T00:00:01.000Z",
      now: "2026-07-17T00:00:03.000Z",
    });
    expect(canceled.ok).toBe(true);
    if (canceled.ok) {
      expect(canceled.value.status).toBe("canceled");
      expect(canceled.value.roles.map((entry) => entry.status)).toEqual(["canceled", "canceled"]);
    }
  });

  it("读取损坏 run 返回结构化错误，不抛异常", async () => {
    const created = await createSlidesPipelineRun({ workspaceRoot: root, run: run("run-003") });
    expect(created.ok).toBe(true);
    writeFileSync(join(runDir("run-003"), "run.json"), "{ broken");

    const loaded = await loadSlidesPipelineRun({ workspaceRoot: root, deckId: DECK, runId: "run-003" });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("invalid_manifest");
  });

  it("listLatestRecoverable 返回最近 running/awaiting-approval run，并跳过 completed 与损坏 run", async () => {
    await createSlidesPipelineRun({
      workspaceRoot: root,
      run: run("run-010", { status: "completed", updatedAt: "2026-07-17T00:00:01.000Z" }),
    });
    await createSlidesPipelineRun({
      workspaceRoot: root,
      run: run("run-011", { status: "awaiting-approval", updatedAt: "2026-07-17T00:00:02.000Z" }),
    });
    await createSlidesPipelineRun({
      workspaceRoot: root,
      run: run("run-012", { status: "running", updatedAt: "2026-07-17T00:00:03.000Z" }),
    });
    writeFileSync(join(runDir("run-012"), "run.json"), "{ broken");

    const recoverable = await listLatestRecoverableSlidesPipelineRun({ workspaceRoot: root, deckId: DECK });
    expect(recoverable.ok).toBe(true);
    if (recoverable.ok) expect(recoverable.value?.id).toBe("run-011");
  });

  it("可确认已持久化的 completed review，供 notes-writer gate 使用", async () => {
    expect((await hasCompletedSlidesPipelineRunKind({ workspaceRoot: root, deckId: DECK, kind: "review" })).ok).toBe(true);
    await createSlidesPipelineRun({
      workspaceRoot: root,
      run: run("run-review-done", {
        status: "completed",
        roles: [
          roleRun("narrative-reviewer", { status: "accepted" }),
          roleRun("render-reviewer", { status: "rejected" }),
        ],
      }),
    });
    const result = await hasCompletedSlidesPipelineRunKind({ workspaceRoot: root, deckId: DECK, kind: "review" });
    expect(result).toEqual({ ok: true, value: true });
  });

  it("runId 路径逃逸被拒绝", async () => {
    const result = await createSlidesPipelineRun({ workspaceRoot: root, run: run("../evil") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_path");
  });

  it("deck 内祖先目录若经 symlink 逃出 deck 也会被拒绝", async () => {
    const escaped = join(root, "escaped-runs");
    mkdirSync(escaped, { recursive: true });
    rmSync(join(root, ".cortex-design", DECK, "drafts", "runs"), { recursive: true, force: true });
    symlinkSync(escaped, join(root, ".cortex-design", DECK, "drafts", "runs"));

    const result = await createSlidesPipelineRun({ workspaceRoot: root, run: run("run-escape") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_path");
    expect(existsSync(join(escaped, "run-escape", "run.json"))).toBe(false);
  });

  it("cancel 对已终态 run 拒绝迟到事件", async () => {
    const created = await createSlidesPipelineRun({
      workspaceRoot: root,
      run: run("run-030", {
        status: "completed",
        roles: [
          roleRun("narrative-reviewer", { status: "accepted" }),
          roleRun("render-reviewer", { status: "rejected" }),
        ],
      }),
    });
    expect(created.ok).toBe(true);

    const canceled = await cancelSlidesPipelineRun({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-030",
      expectedUpdatedAt: NOW,
      now: "2026-07-17T00:00:04.000Z",
    });
    expect(canceled.ok).toBe(false);
    if (!canceled.ok) expect(canceled.error.code).toBe("invalid_payload");
  });

  it("角色产物只写固定文件名，且写前先做 schema 校验", async () => {
    const created = await createSlidesPipelineRun({
      workspaceRoot: root,
      run: run("run-020", {
        kind: "notes",
        roles: [roleRun("notes-writer", { status: "running" })],
      }),
    });
    expect(created.ok).toBe(true);

    const written = await writeSlidesRoleArtifact({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-020",
      role: "notes-writer",
      result: {
        slots: [{ slotId: "slot-001", markdown: "## 讲稿\n\n先讲问题，再给方案。" }],
      },
    });
    expect(written.ok).toBe(true);
    if (written.ok) {
      expect(written.value.fileName).toBe("notes-draft.json");
      expect(written.value.artifactPath.endsWith(join(".cortex-design", DECK, "drafts", "runs", "run-020", "notes-draft.json"))).toBe(true);
    }
    expect(existsSync(join(runDir("run-020"), "notes-draft.json"))).toBe(true);
    expect(readdirSync(runDir("run-020")).sort()).toEqual(["notes-draft.json", "run.json"]);
    expect(JSON.parse(readFileSync(join(runDir("run-020"), "notes-draft.json"), "utf8"))).toEqual({
      slots: [{ slotId: "slot-001", markdown: "## 讲稿\n\n先讲问题，再给方案。" }],
    });

    const rejected = await writeSlidesRoleArtifact({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-020",
      role: "notes-writer",
      result: {
        slots: [{ slotId: "slot-001", markdown: "x".repeat(SLIDES_PIPELINE_MAX_MARKDOWN_CHARS + 1) }],
      },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("invalid_payload");
    expect(readdirSync(dirname(join(runDir("run-020"), "notes-draft.json"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
