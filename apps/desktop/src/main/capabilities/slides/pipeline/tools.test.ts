import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SlidesRole } from "@cortex-work/core/design/slides/slides-pipeline-types";

vi.mock("../../../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import {
  acceptSlidesPipelineRoleResult,
  createSlidesPipelineRunAction,
  failSlidesPipelineRoleResult,
  getSlidesPipelineRunAction,
  recordSlidesPipelineRoleResult,
  registerSlidesPipelineTools,
  rejectSlidesPipelineRoleResult,
  startSlidesPipelineRole,
} from "./tools";
import { createDeckWorkspace, loadDeckManifest, readSlideNotes, updateDeckManifest, writeSlideNotesBatch } from "../workspace";

const DECK = "deckpipe1";
const NOW = "2026-07-17T09:00:00.000Z";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "cortex-slides-pipeline-tools-"));
  const created = await createDeckWorkspace({ workspaceRoot: root, deckId: DECK, title: "Pipeline Tools", now: NOW });
  expect(created.ok).toBe(true);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function currentManifest() {
  const loaded = await loadDeckManifest({ workspaceRoot: root, deckId: DECK });
  if (!loaded.ok) throw new Error("manifest load failed");
  return loaded.value.manifest;
}

async function seedSlides(slotIds: string[]) {
  const manifest = await currentManifest();
  const updated = await updateDeckManifest({
    workspaceRoot: root,
    deckId: DECK,
    expectedRevision: manifest.revision,
    mutate: (deck) => {
      deck.slides = slotIds.map((slotId, index) => ({
        id: slotId,
        order: index,
        title: `第 ${index + 1} 页`,
        htmlPath: `.cortex-design/${DECK}/slides/${slotId}.html`,
        revision: 0,
        status: "ready",
        updatedAt: NOW,
      }));
      return deck;
    },
  });
  expect(updated.ok).toBe(true);
}

type ToolHandler = (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

describe("pipeline business actions", () => {
  it("create 根据 kind 建固定角色并返回 nextActions", async () => {
    const created = await createSlidesPipelineRunAction({
      workspaceRoot: root,
      deckId: DECK,
      kind: "research",
      now: NOW,
      runId: "run-100",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.run.kind).toBe("research");
    expect(created.value.run.deckRevisionAtStart).toBe(0);
    expect(created.value.run.roles.map((entry) => entry.role)).toEqual(["topic-researcher", "visual-researcher"]);
    expect(created.value.nextActions).toEqual([
      { type: "record_role_result", role: "topic-researcher" },
      { type: "record_role_result", role: "visual-researcher" },
    ]);
  });

  it("同毫秒自动生成的 run id 也不会碰撞", async () => {
    const first = await createSlidesPipelineRunAction({
      workspaceRoot: root,
      deckId: DECK,
      kind: "research",
      now: NOW,
    });
    const second = await createSlidesPipelineRunAction({
      workspaceRoot: root,
      deckId: DECK,
      kind: "review",
      now: NOW,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.run.id).not.toBe(second.value.run.id);
  });

  it("record 解析 schema、写固定 artifact、角色置 awaiting-approval，get 不暴露绝对路径", async () => {
    const created = await createSlidesPipelineRunAction({
      workspaceRoot: root,
      deckId: DECK,
      kind: "review",
      now: NOW,
      runId: "run-101",
    });
    expect(created.ok).toBe(true);
    const started = await startSlidesPipelineRole({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-101",
      role: "narrative-reviewer",
    });
    expect(started.ok).toBe(true);

    const recorded = await recordSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-101",
      role: "narrative-reviewer",
      result: {
        deckFindings: [{ code: "hook", message: "开场偏弱" }],
        slideFindings: [{ slideId: "slot-001", code: "dense-copy", message: "文字偏多" }],
        suggestedOrder: ["slot-001", "slot-002"],
      },
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.value.run.status).toBe("awaiting-approval");
    expect(recorded.value.run.roles.find((entry) => entry.role === "narrative-reviewer")?.status).toBe("awaiting-approval");
    expect(recorded.value.nextActions).toContainEqual({ type: "accept_role_result", role: "narrative-reviewer" });
    expect(recorded.value.nextActions).toContainEqual({ type: "reject_role_result", role: "narrative-reviewer" });
    expect(existsSync(join(root, ".cortex-design", DECK, "drafts", "runs", "run-101", "narrative-review.json"))).toBe(true);

    const loaded = await getSlidesPipelineRunAction({ workspaceRoot: root, deckId: DECK, runId: "run-101" });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.artifacts?.["narrative-reviewer"]).toEqual(recorded.value.artifact);
    expect(JSON.stringify(loaded.value)).not.toContain("/private/");
    expect(JSON.stringify(loaded.value)).not.toContain(`${root}/`);
  });

  it("start/record/fail/reject/accept 都有显式合法状态守卫，终态拒绝迟到事件", async () => {
    const created = await createSlidesPipelineRunAction({
      workspaceRoot: root,
      deckId: DECK,
      kind: "review",
      now: NOW,
      runId: "run-guards",
    });
    expect(created.ok).toBe(true);

    const recordBeforeStart = await recordSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-guards",
      role: "narrative-reviewer",
      result: {
        deckFindings: [{ code: "hook", message: "开场偏弱" }],
        slideFindings: [],
        suggestedOrder: [],
      },
    });
    expect(recordBeforeStart.ok).toBe(false);
    if (!recordBeforeStart.ok) expect(recordBeforeStart.error.code).toBe("invalid_payload");

    const rejectBeforeApproval = await rejectSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-guards",
      role: "narrative-reviewer",
    });
    expect(rejectBeforeApproval.ok).toBe(false);
    if (!rejectBeforeApproval.ok) expect(rejectBeforeApproval.error.code).toBe("invalid_payload");

    const started = await startSlidesPipelineRole({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-guards",
      role: "narrative-reviewer",
    });
    expect(started.ok).toBe(true);

    const startedAgain = await startSlidesPipelineRole({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-guards",
      role: "narrative-reviewer",
    });
    expect(startedAgain.ok).toBe(false);
    if (!startedAgain.ok) expect(startedAgain.error.code).toBe("invalid_payload");

    const failed = await failSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-guards",
      role: "narrative-reviewer",
      errorMessage: "role failed",
    });
    expect(failed.ok).toBe(true);

    const lateRecord = await recordSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-guards",
      role: "narrative-reviewer",
      result: {
        deckFindings: [{ code: "late", message: "不该再写入" }],
        slideFindings: [],
        suggestedOrder: [],
      },
    });
    expect(lateRecord.ok).toBe(false);
    if (!lateRecord.ok) expect(lateRecord.error.code).toBe("invalid_payload");

    const lateAccept = await acceptSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-guards",
      role: "narrative-reviewer",
    });
    expect(lateAccept.ok).toBe(false);
    if (!lateAccept.ok) expect(lateAccept.error.code).toBe("invalid_payload");

    const lateReject = await rejectSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-guards",
      role: "narrative-reviewer",
    });
    expect(lateReject.ok).toBe(false);
    if (!lateReject.ok) expect(lateReject.error.code).toBe("invalid_payload");
  });

  it("accept review 只标接受并返回 findings/suggestedOrder，不自动改 deck", async () => {
    await seedSlides(["slot-001", "slot-002"]);
    const created = await createSlidesPipelineRunAction({
      workspaceRoot: root,
      deckId: DECK,
      kind: "review",
      now: NOW,
      runId: "run-102",
    });
    expect(created.ok).toBe(true);
    const started = await startSlidesPipelineRole({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-102",
      role: "narrative-reviewer",
    });
    expect(started.ok).toBe(true);

    const recorded = await recordSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-102",
      role: "narrative-reviewer",
      result: {
        deckFindings: [{ code: "story-gap", message: "故事转折不够清晰" }],
        slideFindings: [{ slideId: "slot-001", code: "weak-title", message: "标题不够具体" }],
        suggestedOrder: ["slot-002", "slot-001"],
      },
    });
    expect(recorded.ok).toBe(true);

    const accepted = await acceptSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-102",
      role: "narrative-reviewer",
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.run.roles.find((entry) => entry.role === "narrative-reviewer")?.status).toBe("accepted");
    expect(accepted.value.review).toEqual({
      deckFindings: [{ code: "story-gap", message: "故事转折不够清晰" }],
      slideFindings: [{ slideId: "slot-001", code: "weak-title", message: "标题不够具体" }],
      suggestedOrder: ["slot-002", "slot-001"],
    });
    const manifest = await currentManifest();
    expect(manifest.slides.map((slide) => slide.id)).toEqual(["slot-001", "slot-002"]);
  });

  it("accept notes 先校验 revision，再原子批量落 notes", async () => {
    await seedSlides(["slot-001", "slot-002"]);
    const manifestAtStart = await currentManifest();
    const created = await createSlidesPipelineRunAction({
      workspaceRoot: root,
      deckId: DECK,
      kind: "notes",
      now: NOW,
      runId: "run-103",
    });
    expect(created.ok).toBe(true);
    const started = await startSlidesPipelineRole({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-103",
      role: "notes-writer",
    });
    expect(started.ok).toBe(true);

    const recorded = await recordSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-103",
      role: "notes-writer",
      result: {
        slots: [
          { slotId: "slot-001", markdown: "## 第 1 页\n\n先讲背景。" },
          { slotId: "slot-002", markdown: "## 第 2 页\n\n再讲方案。" },
        ],
      },
    });
    expect(recorded.ok).toBe(true);

    const accepted = await acceptSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-103",
      role: "notes-writer",
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.appliedNotes).toEqual({
      slotIds: ["slot-001", "slot-002"],
      revision: manifestAtStart.revision + 1,
    });
    expect(accepted.value.run.status).toBe("completed");

    const note1 = await readSlideNotes({ workspaceRoot: root, deckId: DECK, slotId: "slot-001" });
    const note2 = await readSlideNotes({ workspaceRoot: root, deckId: DECK, slotId: "slot-002" });
    expect(note1.ok && note1.value).toContain("先讲背景");
    expect(note2.ok && note2.value).toContain("再讲方案");
  });

  it("accept notes 多页落盘必须原子化，不能留下部分写入", async () => {
    await seedSlides(["slot-001", "slot-002"]);
    const created = await createSlidesPipelineRunAction({
      workspaceRoot: root,
      deckId: DECK,
      kind: "notes",
      now: NOW,
      runId: "run-notes-atomic",
    });
    expect(created.ok).toBe(true);

    const started = await startSlidesPipelineRole({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-notes-atomic",
      role: "notes-writer",
    });
    expect(started.ok).toBe(true);

    const recorded = await recordSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-notes-atomic",
      role: "notes-writer",
      result: {
        slots: [
          { slotId: "slot-001", markdown: "## 第 1 页\n\n第一页备注。" },
          { slotId: "slot-002", markdown: "## 第 2 页\n\n第二页备注。" },
        ],
      },
    });
    expect(recorded.ok).toBe(true);

    mkdirSync(join(root, ".cortex-design", DECK, "notes"), { recursive: true });
    symlinkSync(join(root, "escaped-notes.md"), join(root, ".cortex-design", DECK, "notes", "slot-002.md"));

    const accepted = await acceptSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-notes-atomic",
      role: "notes-writer",
    });
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.error.code).toBe("invalid_path");

    const note1 = await readSlideNotes({ workspaceRoot: root, deckId: DECK, slotId: "slot-001" });
    const note2 = await readSlideNotes({ workspaceRoot: root, deckId: DECK, slotId: "slot-002" });
    expect(note1).toEqual({ ok: true, value: "" });
    expect(note2).toEqual({ ok: false, error: { code: "invalid_path", message: "备注文件不允许是符号链接" } });
  });

  it("notes 已落盘但 run 状态未写入时，重试批准可幂等收敛", async () => {
    await seedSlides(["slot-001"]);
    const created = await createSlidesPipelineRunAction({
      workspaceRoot: root, deckId: DECK, kind: "notes", now: NOW, runId: "run-105",
    });
    expect(created.ok).toBe(true);
    expect((await startSlidesPipelineRole({ workspaceRoot: root, deckId: DECK, runId: "run-105", role: "notes-writer" })).ok).toBe(true);
    expect((await recordSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-105",
      role: "notes-writer",
      result: { slots: [{ slotId: "slot-001", markdown: "已恢复的备注" }] },
    })).ok).toBe(true);

    const deck = await currentManifest();
    const halfCommitted = await writeSlideNotesBatch({
      workspaceRoot: root,
      deckId: DECK,
      notes: [{ slotId: "slot-001", markdown: "已恢复的备注" }],
      expectedRevision: deck.revision,
    });
    expect(halfCommitted.ok).toBe(true);

    const accepted = await acceptSlidesPipelineRoleResult({
      workspaceRoot: root, deckId: DECK, runId: "run-105", role: "notes-writer",
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.run.status).toBe("completed");
  });

  it("accept 遇到 deck revision 漂移返回 conflict；reject 只标 rejected", async () => {
    const created = await createSlidesPipelineRunAction({
      workspaceRoot: root,
      deckId: DECK,
      kind: "research",
      now: NOW,
      runId: "run-104",
    });
    expect(created.ok).toBe(true);
    const started = await startSlidesPipelineRole({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-104",
      role: "topic-researcher",
    });
    expect(started.ok).toBe(true);

    const recorded = await recordSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-104",
      role: "topic-researcher",
      result: {
        facts: ["事实 1"],
        sources: [{ title: "来源 A", url: "https://example.com/a" }],
        claims: ["判断 1"],
        openQuestions: ["问题 1"],
      },
    });
    expect(recorded.ok).toBe(true);

    const changed = await updateDeckManifest({
      workspaceRoot: root,
      deckId: DECK,
      expectedRevision: 0,
      mutate: (deck) => {
        deck.title = "已改动";
        return deck;
      },
    });
    expect(changed.ok).toBe(true);

    const conflict = await acceptSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-104",
      role: "topic-researcher",
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("revision_conflict");

    const rejected = await rejectSlidesPipelineRoleResult({
      workspaceRoot: root,
      deckId: DECK,
      runId: "run-104",
      role: "topic-researcher",
    });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.run.roles.find((entry) => entry.role === "topic-researcher")?.status).toBe("rejected");
  });
});

describe("pipeline MCP handlers", () => {
  it("handler 只做 JSON envelope 适配", async () => {
    const tools = new Map<string, ToolHandler>();
    const fakeMcp = {
      registerTool: (name: string, _def: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;
    registerSlidesPipelineTools(fakeMcp, { sessionId: "s1", runId: "slides:deckpipe1:r1", documentId: DECK, workspaceRoot: root });

    const createHandler = tools.get("create_pipeline_run");
    const getHandler = tools.get("get_pipeline_run");
    const recordHandler = tools.get("record_role_result");
    const acceptHandler = tools.get("accept_role_result");
    const rejectHandler = tools.get("reject_role_result");

    expect(createHandler && getHandler && recordHandler && acceptHandler && rejectHandler).toBeTruthy();

    const createdRaw = await createHandler!({ kind: "research" });
    const created = JSON.parse(createdRaw.content[0]!.text) as { ok: boolean; run: { id: string } };
    expect(created.ok).toBe(true);

    const runId = created.run.id;
    const started = await startSlidesPipelineRole({
      workspaceRoot: root,
      deckId: DECK,
      runId,
      role: "topic-researcher",
    });
    expect(started.ok).toBe(true);
    const recordedRaw = await recordHandler!({
      run_id: runId,
      role: "topic-researcher" satisfies SlidesRole,
      result: {
        facts: ["事实 1"],
        sources: [{ title: "来源 A" }],
        claims: ["判断 1"],
        openQuestions: ["问题 1"],
      },
    });
    const recorded = JSON.parse(recordedRaw.content[0]!.text) as { ok: boolean; artifactPath?: string; nextActions: Array<{ type: string }> };
    expect(recorded.ok).toBe(true);
    expect(recorded.artifactPath).toBeUndefined();
    expect(recorded.nextActions.some((item) => item.type === "accept_role_result")).toBe(true);

    const loadedRaw = await getHandler!({ run_id: runId });
    const loaded = JSON.parse(loadedRaw.content[0]!.text) as { ok: boolean; artifacts?: Record<string, unknown> };
    expect(loaded.ok).toBe(true);
    expect(loaded.artifacts?.["topic-researcher"]).toBeTruthy();

    const rejectedRaw = await rejectHandler!({ run_id: runId, role: "topic-researcher" });
    const rejected = JSON.parse(rejectedRaw.content[0]!.text) as { ok: boolean; run: { roles: Array<{ role: string; status: string }> } };
    expect(rejected.ok).toBe(true);
    expect(rejected.run.roles.find((role) => role.role === "topic-researcher")?.status).toBe("rejected");
  });
});
