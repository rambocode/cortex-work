import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  SlidesPipelineRun,
  SlidesPipelineRunKind,
  SlidesPipelineRunStatus,
  SlidesRole,
  SlidesNotesWriterResult,
  SlidesNarrativeReviewResult,
  SlidesRenderReviewResult,
  SlidesRoleResultByRole,
  SlidesRoleResult,
} from "@cortex-work/core/design/slides/slides-pipeline-types";
import { slidesRoleArtifactFileName } from "@cortex-work/core/design/slides/slides-pipeline-types";
import type { SlidesDeckManifest, SlidesError } from "@cortex-work/core/design/slides/slides-types";
import { createLogger } from "../../../log";
import type { SlidesSessionState } from "../session";
import { loadDeckManifest, readSlideNotes, writeSlideNotesBatch, type SlidesWorkspaceResult } from "../workspace";
import {
  createSlidesPipelineRun,
  loadSlidesPipelineRun,
  readSlidesRoleArtifact,
  transactSlidesPipelineRun,
  type SlidesPipelineWorkspaceResult,
} from "./workspace";

const log = createLogger("slides-pipeline");

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export type SlidesPipelineNextAction =
  | { type: "record_role_result"; role: SlidesRole }
  | { type: "accept_role_result"; role: SlidesRole }
  | { type: "reject_role_result"; role: SlidesRole }
  | { type: "done" };

export type SlidesPipelineActionValue = {
  run: SlidesPipelineRun;
  nextActions: SlidesPipelineNextAction[];
  artifacts?: Partial<Record<SlidesRole, SlidesRoleResult>>;
  artifact?: SlidesRoleResult;
  review?: Record<string, unknown>;
  appliedNotes?: { slotIds: string[]; revision: number };
};

export type SlidesPipelineActionResult = SlidesPipelineWorkspaceResult<SlidesPipelineActionValue>;

type ActionCtx = {
  workspaceRoot: string;
  deckId: string;
};

const ROLES_BY_KIND: Record<SlidesPipelineRunKind, SlidesRole[]> = {
  research: ["topic-researcher", "visual-researcher"],
  review: ["narrative-reviewer", "render-reviewer"],
  notes: ["notes-writer"],
};

function fail<T>(code: SlidesError["code"], message: string): SlidesWorkspaceResult<T> {
  return { ok: false, error: { code, message } };
}

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(code: string, message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, code, message }) }], isError: true };
}

function fromWorkspaceError(result: { ok: false; error: { code: string; message: string } }): ToolResult {
  return errorResult(result.error.code, result.error.message);
}

function makeRunId(now: string): string {
  const digits = now.replace(/\D/g, "").slice(0, 17);
  const stamp = digits || Date.now().toString(10);
  return `run-${stamp}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function computeRunStatus(roles: SlidesPipelineRun["roles"]): SlidesPipelineRunStatus {
  if (roles.some((role) => role.status === "failed")) return "failed";
  if (roles.every((role) => role.status === "canceled")) return "canceled";
  if (roles.some((role) => role.status === "awaiting-approval")) return "awaiting-approval";
  if (roles.every((role) => role.status === "accepted" || role.status === "rejected")) return "completed";
  return "running";
}

function buildNextActions(run: SlidesPipelineRun): SlidesPipelineNextAction[] {
  const actions: SlidesPipelineNextAction[] = [];
  for (const role of run.roles) {
    if (role.status === "awaiting-approval") {
      actions.push({ type: "accept_role_result", role: role.role });
      actions.push({ type: "reject_role_result", role: role.role });
      continue;
    }
    if (role.status === "queued" || role.status === "running") {
      actions.push({ type: "record_role_result", role: role.role });
    }
  }
  return actions.length > 0 ? actions : [{ type: "done" }];
}

async function loadDeck(ctx: ActionCtx): Promise<SlidesWorkspaceResult<SlidesDeckManifest>> {
  const loaded = await loadDeckManifest(ctx);
  return loaded.ok ? { ok: true, value: loaded.value.manifest } : loaded;
}

async function collectArtifacts(
  ctx: ActionCtx,
  run: SlidesPipelineRun,
): Promise<SlidesPipelineWorkspaceResult<Partial<Record<SlidesRole, SlidesRoleResult>>>> {
  const artifacts: Partial<Record<SlidesRole, SlidesRoleResult>> = {};
  for (const role of run.roles) {
    const artifact = await readSlidesRoleArtifact({ ...ctx, runId: run.id, role: role.role });
    if (!artifact.ok) {
      if (artifact.error.code === "not_found") continue;
      return artifact as SlidesPipelineWorkspaceResult<Partial<Record<SlidesRole, SlidesRoleResult>>>;
    }
    artifacts[role.role] = artifact.value;
  }
  return { ok: true, value: artifacts };
}

function buildActionValue(
  run: SlidesPipelineRun,
  extras: Omit<Partial<SlidesPipelineActionValue>, "run" | "nextActions"> = {},
): SlidesPipelineActionValue {
  return {
    run,
    nextActions: buildNextActions(run),
    ...extras,
  };
}

const TERMINAL_RUN_STATUSES = new Set<SlidesPipelineRunStatus>(["completed", "failed", "canceled"]);

function ensureRunMutable(run: SlidesPipelineRun, action: string): SlidesPipelineWorkspaceResult<SlidesPipelineRun> {
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return fail("invalid_payload", `run 已终态，不能再执行 ${action}: ${run.status}`);
  }
  return { ok: true, value: run };
}

function ensureRoleStatus(
  run: SlidesPipelineRun,
  roleIndex: number,
  allowed: SlidesPipelineRun["roles"][number]["status"][],
  action: string,
): SlidesPipelineWorkspaceResult<SlidesPipelineRun> {
  const currentStatus = run.roles[roleIndex]?.status;
  if (!currentStatus || !allowed.includes(currentStatus)) {
    return fail(
      "invalid_payload",
      `角色状态不允许执行 ${action}: ${run.roles[roleIndex]?.role ?? "unknown"} 当前为 ${currentStatus ?? "missing"}`,
    );
  }
  return { ok: true, value: run };
}

function ensureAwaitingApproval(run: SlidesPipelineRun, roleIndex: number): SlidesPipelineWorkspaceResult<SlidesPipelineRun> {
  const mutable = ensureRunMutable(run, "approval");
  if (!mutable.ok) return mutable;
  if (run.roles[roleIndex]?.status !== "awaiting-approval") {
    return fail("invalid_payload", `角色尚未进入待批准状态: ${run.roles[roleIndex]?.role ?? "unknown"}`);
  }
  return { ok: true, value: run };
}

function ensureDeckRevisionAtStart(deck: SlidesDeckManifest, run: SlidesPipelineRun): SlidesPipelineWorkspaceResult<SlidesDeckManifest> {
  if (deck.revision !== run.deckRevisionAtStart) {
    return fail(
      "revision_conflict",
      `deck revision 已变化: 运行开始于 ${run.deckRevisionAtStart},当前 ${deck.revision}`,
    );
  }
  return { ok: true, value: deck };
}

export async function createSlidesPipelineRunAction(options: {
  workspaceRoot: string;
  deckId: string;
  kind: SlidesPipelineRunKind;
  now?: string;
  runId?: string;
}): Promise<SlidesPipelineActionResult> {
  const ctx = { workspaceRoot: options.workspaceRoot, deckId: options.deckId };
  const manifest = await loadDeck(ctx);
  if (!manifest.ok) return manifest;
  const now = options.now ?? new Date().toISOString();
  const run: SlidesPipelineRun = {
    schemaVersion: 1,
    id: options.runId ?? makeRunId(now),
    deckId: options.deckId,
    kind: options.kind,
    deckRevisionAtStart: manifest.value.revision,
    status: "running",
    roles: ROLES_BY_KIND[options.kind].map((role) => ({
      role,
      status: "queued",
      artifactFile: slidesRoleArtifactFileName(role),
      updatedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  };
  const created = await createSlidesPipelineRun({ workspaceRoot: options.workspaceRoot, run });
  if (!created.ok) return created;
  log.info(`[slides] pipeline run created deck=${options.deckId} run=${created.value.id} kind=${options.kind}`);
  return { ok: true, value: buildActionValue(created.value) };
}

export async function getSlidesPipelineRunAction(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
}): Promise<SlidesPipelineActionResult> {
  const ctx = { workspaceRoot: options.workspaceRoot, deckId: options.deckId };
  const loaded = await loadSlidesPipelineRun({ ...ctx, runId: options.runId });
  if (!loaded.ok) return loaded;
  const artifacts = await collectArtifacts(ctx, loaded.value);
  if (!artifacts.ok) return artifacts;
  return { ok: true, value: buildActionValue(loaded.value, { artifacts: artifacts.value }) };
}

export async function recordSlidesPipelineRoleResult<R extends SlidesRole>(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  role: R;
  result: SlidesRoleResultByRole[R];
}): Promise<SlidesPipelineActionResult> {
  const tx = await transactSlidesPipelineRun({
    workspaceRoot: options.workspaceRoot,
    deckId: options.deckId,
    runId: options.runId,
    transaction: async ({ run, now, writeArtifact }) => {
      const roleIndex = run.roles.findIndex((entry) => entry.role === options.role);
      if (roleIndex === -1) return fail("not_found", `run 中不存在角色: ${options.role}`);
      const mutable = ensureRunMutable(run, "record_role_result");
      if (!mutable.ok) return mutable;
      const statusOk = ensureRoleStatus(run, roleIndex, ["running"], "record_role_result");
      if (!statusOk.ok) return statusOk;
      const artifact = await writeArtifact(options.role, options.result);
      if (!artifact.ok) return artifact;
      const role = run.roles[roleIndex]!;
      role.status = "awaiting-approval";
      role.updatedAt = now;
      delete role.errorMessage;
      delete role.rawSummary;
      run.status = computeRunStatus(run.roles);
      return {
        ok: true,
        value: {
          nextRun: run,
          value: {
            artifact: artifact.value.result as SlidesRoleResultByRole[SlidesRole],
          },
        },
      };
    },
  });
  if (!tx.ok) return tx;
  return {
    ok: true,
    value: buildActionValue(tx.value.run, {
      artifact: tx.value.value.artifact,
    }),
  };
}

export async function acceptSlidesPipelineRoleResult(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  role: SlidesRole;
  expectedUpdatedAt?: string;
}): Promise<SlidesPipelineActionResult> {
  const ctx = { workspaceRoot: options.workspaceRoot, deckId: options.deckId };
  const tx = await transactSlidesPipelineRun({
    ...ctx,
    runId: options.runId,
    expectedUpdatedAt: options.expectedUpdatedAt,
    transaction: async ({ run, now, readArtifact }) => {
      const roleIndex = run.roles.findIndex((entry) => entry.role === options.role);
      if (roleIndex === -1) return fail("not_found", `run 中不存在角色: ${options.role}`);
      const awaiting = ensureAwaitingApproval(run, roleIndex);
      if (!awaiting.ok) return awaiting;

      const deck = await loadDeck(ctx);
      if (!deck.ok) return deck;
      const artifact = await readArtifact(options.role);
      if (!artifact.ok) return artifact;

      if (options.role !== "notes-writer") {
        const stableDeck = ensureDeckRevisionAtStart(deck.value, run);
        if (!stableDeck.ok) return stableDeck;
      }

      let review: Record<string, unknown> | undefined;
      let appliedNotes: { slotIds: string[]; revision: number } | undefined;

      if (options.role === "narrative-reviewer") {
        const narrative = artifact.value as SlidesNarrativeReviewResult;
        review = {
          deckFindings: narrative.deckFindings,
          slideFindings: narrative.slideFindings,
          suggestedOrder: narrative.suggestedOrder,
        };
      } else if (options.role === "render-reviewer") {
        const render = artifact.value as SlidesRenderReviewResult;
        review = { findings: render.findings };
      } else if (options.role === "notes-writer") {
        const notes = artifact.value as SlidesNotesWriterResult;
        const slotIds = notes.slots.map((slot) => slot.slotId);
        for (const slotId of slotIds) {
          if (!deck.value.slides.some((slide) => slide.id === slotId)) {
            return fail("not_found", `slot 不存在: ${slotId}`);
          }
        }
        if (deck.value.revision !== run.deckRevisionAtStart) {
          const currentNotes = await Promise.all(
            notes.slots.map((slot) => readSlideNotes({ ...ctx, slotId: slot.slotId })),
          );
          const alreadyApplied = currentNotes.every(
            (result, index) => result.ok && result.value === notes.slots[index]!.markdown,
          );
          if (!alreadyApplied) {
            return fail(
              "revision_conflict",
              `deck revision 已变化: 运行开始于 ${run.deckRevisionAtStart},当前 ${deck.value.revision}`,
            );
          }
          appliedNotes = { slotIds, revision: deck.value.revision };
        } else {
          const written = await writeSlideNotesBatch({
            ...ctx,
            notes: notes.slots,
            expectedRevision: deck.value.revision,
            now,
          });
          if (!written.ok) return written;
          appliedNotes = { slotIds, revision: written.value.revision };
        }
      }

      const role = run.roles[roleIndex]!;
      role.status = "accepted";
      role.updatedAt = now;
      run.status = computeRunStatus(run.roles);
      return {
        ok: true,
        value: {
          nextRun: run,
          value: {
            artifact: artifact.value as SlidesRoleResultByRole[SlidesRole],
            review,
            appliedNotes,
          },
        },
      };
    },
  });
  if (!tx.ok) return tx;

  return {
    ok: true,
    value: buildActionValue(tx.value.run, {
      artifact: tx.value.value.artifact,
      review: tx.value.value.review,
      appliedNotes: tx.value.value.appliedNotes,
    }),
  };
}

export async function rejectSlidesPipelineRoleResult(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  role: SlidesRole;
  expectedUpdatedAt?: string;
}): Promise<SlidesPipelineActionResult> {
  const tx = await transactSlidesPipelineRun({
    workspaceRoot: options.workspaceRoot,
    deckId: options.deckId,
    runId: options.runId,
    expectedUpdatedAt: options.expectedUpdatedAt,
    transaction: async ({ run, now }) => {
      const roleIndex = run.roles.findIndex((entry) => entry.role === options.role);
      if (roleIndex === -1) return fail("not_found", `run 中不存在角色: ${options.role}`);
      const awaiting = ensureAwaitingApproval(run, roleIndex);
      if (!awaiting.ok) return awaiting;
      const role = run.roles[roleIndex]!;
      role.status = "rejected";
      role.updatedAt = now;
      run.status = computeRunStatus(run.roles);
      return { ok: true, value: { nextRun: run, value: undefined } };
    },
  });
  if (!tx.ok) return tx;
  return { ok: true, value: buildActionValue(tx.value.run) };
}

export async function failSlidesPipelineRoleResult(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  role: SlidesRole;
  errorMessage: string;
  rawSummary?: string;
}): Promise<SlidesPipelineActionResult> {
  const tx = await transactSlidesPipelineRun({
    workspaceRoot: options.workspaceRoot,
    deckId: options.deckId,
    runId: options.runId,
    transaction: async ({ run, now }) => {
      const roleIndex = run.roles.findIndex((entry) => entry.role === options.role);
      if (roleIndex === -1) return fail("not_found", `run 中不存在角色: ${options.role}`);
      const mutable = ensureRunMutable(run, "fail_role_result");
      if (!mutable.ok) return mutable;
      const statusOk = ensureRoleStatus(run, roleIndex, ["queued", "running"], "fail_role_result");
      if (!statusOk.ok) return statusOk;
      const role = run.roles[roleIndex]!;
      role.status = "failed";
      role.updatedAt = now;
      role.errorMessage = options.errorMessage.slice(0, 2_000);
      role.rawSummary = options.rawSummary?.slice(0, 2_000);
      run.status = computeRunStatus(run.roles);
      return { ok: true, value: { nextRun: run, value: undefined } };
    },
  });
  if (!tx.ok) return tx;
  return { ok: true, value: buildActionValue(tx.value.run) };
}

export async function startSlidesPipelineRole(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  role: SlidesRole;
}): Promise<SlidesPipelineActionResult> {
  const tx = await transactSlidesPipelineRun({
    workspaceRoot: options.workspaceRoot,
    deckId: options.deckId,
    runId: options.runId,
    transaction: async ({ run, now }) => {
      const roleIndex = run.roles.findIndex((entry) => entry.role === options.role);
      if (roleIndex === -1) return fail("not_found", `run 中不存在角色: ${options.role}`);
      const mutable = ensureRunMutable(run, "start_role");
      if (!mutable.ok) return mutable;
      const statusOk = ensureRoleStatus(run, roleIndex, ["queued"], "start_role");
      if (!statusOk.ok) return statusOk;
      const role = run.roles[roleIndex]!;
      role.status = "running";
      role.updatedAt = now;
      delete role.errorMessage;
      delete role.rawSummary;
      run.status = computeRunStatus(run.roles);
      return { ok: true, value: { nextRun: run, value: undefined } };
    },
  });
  if (!tx.ok) return tx;
  return { ok: true, value: buildActionValue(tx.value.run) };
}

export function registerSlidesPipelineTools(mcp: McpServer, state: SlidesSessionState): void {
  const ctx = { workspaceRoot: state.workspaceRoot, deckId: state.documentId };

  mcp.registerTool(
    "create_pipeline_run",
    {
      description: "Create a Slides pipeline run. kind=research/review/notes; the fixed roles are set up automatically per kind.",
      inputSchema: {
        kind: z.enum(["research", "review", "notes"]),
      },
    },
    async ({ kind }): Promise<ToolResult> => {
      const result = await createSlidesPipelineRunAction({ ...ctx, kind });
      return result.ok ? jsonResult({ ok: true, ...result.value }) : fromWorkspaceError(result);
    },
  );

  mcp.registerTool(
    "get_pipeline_run",
    {
      description: "Read the pipeline run status and recorded structured role artifacts; absolute paths are never exposed.",
      inputSchema: {
        run_id: z.string().min(1),
      },
    },
    async ({ run_id }): Promise<ToolResult> => {
      const result = await getSlidesPipelineRunAction({ ...ctx, runId: run_id });
      return result.ok ? jsonResult({ ok: true, ...result.value }) : fromWorkspaceError(result);
    },
  );

  mcp.registerTool(
    "record_role_result",
    {
      description: "Record a Slides role's structured result. It is validated against a strict schema, written to a fixed artifact file, and the role becomes awaiting-approval.",
      inputSchema: {
        run_id: z.string().min(1),
        role: z.enum(["topic-researcher", "visual-researcher", "narrative-reviewer", "render-reviewer", "notes-writer"]),
        result: z.record(z.string(), z.unknown()),
      },
    },
    async ({ run_id, role, result }): Promise<ToolResult> => {
      const action = await recordSlidesPipelineRoleResult({
        ...ctx,
        runId: run_id,
        role,
        result: result as SlidesRoleResultByRole[typeof role],
      });
      return action.ok ? jsonResult({ ok: true, ...action.value }) : fromWorkspaceError(action);
    },
  );

  mcp.registerTool(
    "accept_role_result",
    {
      description:
        "Accept a Slides role's result. research is merely marked accepted; review keeps the artifact and returns findings/suggestedOrder; notes-writer writes official notes along the revision chain.",
      inputSchema: {
        run_id: z.string().min(1),
        role: z.enum(["topic-researcher", "visual-researcher", "narrative-reviewer", "render-reviewer", "notes-writer"]),
      },
    },
    async ({ run_id, role }): Promise<ToolResult> => {
      const action = await acceptSlidesPipelineRoleResult({ ...ctx, runId: run_id, role });
      return action.ok ? jsonResult({ ok: true, ...action.value }) : fromWorkspaceError(action);
    },
  );

  mcp.registerTool(
    "reject_role_result",
    {
      description: "Reject a Slides role's result. Only updates the run status; the deck is never modified automatically.",
      inputSchema: {
        run_id: z.string().min(1),
        role: z.enum(["topic-researcher", "visual-researcher", "narrative-reviewer", "render-reviewer", "notes-writer"]),
      },
    },
    async ({ run_id, role }): Promise<ToolResult> => {
      const action = await rejectSlidesPipelineRoleResult({ ...ctx, runId: run_id, role });
      return action.ok ? jsonResult({ ok: true, ...action.value }) : fromWorkspaceError(action);
    },
  );
}
