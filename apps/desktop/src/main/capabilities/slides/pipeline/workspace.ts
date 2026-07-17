import { promises as fsp } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  SLIDES_PIPELINE_RECOVERABLE_RUN_STATUSES,
  slidesRoleArtifactFileName,
  type SlidesPipelineRun,
  type SlidesPipelineRunKind,
  type SlidesRole,
  type SlidesRoleArtifactFileName,
  type SlidesRoleResultByRole,
} from "@cortex-work/core/design/slides/slides-pipeline-types";
import type { SlidesError } from "@cortex-work/core/design/slides/slides-types";
import { resolveDeckPaths, type SlidesWorkspaceResult } from "../workspace";
import {
  parseSlidesPipelineRun,
  parseSlidesRoleResult,
  serializeSlidesPipelineRun,
  serializeSlidesRoleResult,
} from "./role-schemas";

export type SlidesPipelineWorkspaceResult<T> = SlidesWorkspaceResult<T>;

interface RunPaths {
  realWorkspaceRoot: string;
  deckRootAbs: string;
  runRootAbs: string;
  runJsonAbs: string;
}

type SlidesPipelineRunTransactionContext = {
  run: SlidesPipelineRun;
  now: string;
  readArtifact: <R extends SlidesRole>(role: R) => Promise<SlidesPipelineWorkspaceResult<SlidesRoleResultByRole[R]>>;
  writeArtifact: <R extends SlidesRole>(
    role: R,
    result: SlidesRoleResultByRole[R],
  ) => Promise<
    SlidesPipelineWorkspaceResult<{
      fileName: SlidesRoleArtifactFileName;
      artifactPath: string;
      result: SlidesRoleResultByRole[R];
    }>
  >;
};

const runQueues = new Map<string, Promise<unknown>>();
const RECOVERABLE_STATUSES = new Set<string>(SLIDES_PIPELINE_RECOVERABLE_RUN_STATUSES);
const RUN_ID_PATTERN = /^run-[a-z0-9][a-z0-9-]{0,63}$/;

function fail<T>(code: SlidesError["code"], message: string): SlidesPipelineWorkspaceResult<T> {
  return { ok: false, error: { code, message } };
}

function enqueueRun<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = runQueues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  runQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function isInsideRoot(rootAbs: string, targetAbs: string): boolean {
  return targetAbs === rootAbs || targetAbs.startsWith(rootAbs + sep);
}

function isValidRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId);
}

async function assertManagedPath(paths: RunPaths, targetAbs: string): Promise<SlidesError | null> {
  if (!isInsideRoot(paths.deckRootAbs, targetAbs)) {
    return { code: "invalid_path", message: `目标路径越出 deck 根: ${targetAbs}` };
  }
  let ancestor = dirname(targetAbs);
  while (true) {
    try {
      const real = await fsp.realpath(ancestor);
      if (!isInsideRoot(paths.deckRootAbs, real)) {
        return { code: "invalid_path", message: "路径祖先目录解析后越出 deck 根" };
      }
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  try {
    const st = await fsp.lstat(targetAbs);
    if (st.isSymbolicLink()) return { code: "invalid_path", message: "目标不允许是符号链接" };
  } catch {
    // 不存在 = 新建或待读取不存在文件。
  }
  return null;
}

async function atomicWriteFile(targetAbs: string, content: string): Promise<void> {
  const tmp = `${targetAbs}.tmp`;
  await fsp.mkdir(dirname(targetAbs), { recursive: true });
  await fsp.writeFile(tmp, content, "utf8");
  try {
    await fsp.rename(tmp, targetAbs);
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function cloneRun(run: SlidesPipelineRun): SlidesPipelineRun {
  return JSON.parse(JSON.stringify(run)) as SlidesPipelineRun;
}

async function resolveRunPaths(
  workspaceRoot: string,
  deckId: string,
  runId: string,
): Promise<SlidesPipelineWorkspaceResult<RunPaths>> {
  if (!isValidRunId(runId)) return fail("invalid_path", `非法 run id: ${runId}`);
  const resolved = await resolveDeckPaths(workspaceRoot, deckId);
  if (!resolved.ok) return resolved;
  const runRootAbs = resolve(resolved.value.deckRootAbs, "drafts", "runs", runId);
  if (!isInsideRoot(resolved.value.deckRootAbs, runRootAbs)) {
    return fail("invalid_path", `run 根越界: ${runId}`);
  }
  try {
    const st = await fsp.lstat(runRootAbs);
    if (st.isSymbolicLink()) return fail("invalid_path", "run 根不允许是符号链接");
    const real = await fsp.realpath(runRootAbs);
    if (!isInsideRoot(resolved.value.deckRootAbs, real)) {
      return fail("invalid_path", "run 根解析后越出 deck 根");
    }
  } catch {
    // create 路径允许先不存在。
  }
  return {
    ok: true,
    value: {
      realWorkspaceRoot: resolved.value.realWorkspaceRoot,
      deckRootAbs: resolved.value.deckRootAbs,
      runRootAbs,
      runJsonAbs: join(runRootAbs, "run.json"),
    },
  };
}

async function loadSlidesPipelineRunUnlocked(
  paths: RunPaths,
  deckId: string,
  runId: string,
): Promise<SlidesPipelineWorkspaceResult<SlidesPipelineRun>> {
  const pathError = await assertManagedPath(paths, paths.runJsonAbs);
  if (pathError) return fail(pathError.code, pathError.message);

  let raw: string;
  try {
    raw = await fsp.readFile(paths.runJsonAbs, "utf8");
  } catch {
    return fail("not_found", `run 不存在: ${runId}`);
  }

  const parsed = parseSlidesPipelineRun(raw);
  if (!parsed.ok) return fail("invalid_manifest", parsed.error.message);
  if (parsed.run.id !== runId || parsed.run.deckId !== deckId) {
    return fail("invalid_manifest", `run.json 与目标路径不匹配: ${runId}`);
  }
  return { ok: true, value: parsed.run };
}

export async function createSlidesPipelineRun(options: {
  workspaceRoot: string;
  run: SlidesPipelineRun;
}): Promise<SlidesPipelineWorkspaceResult<SlidesPipelineRun>> {
  const resolved = await resolveRunPaths(options.workspaceRoot, options.run.deckId, options.run.id);
  if (!resolved.ok) return resolved;
  const parsed = parseSlidesPipelineRun(options.run);
  if (!parsed.ok) return fail("invalid_manifest", parsed.error.message);
  const paths = resolved.value;
  return enqueueRun(paths.runRootAbs, async () => {
    try {
      await fsp.access(paths.runJsonAbs);
      return fail<SlidesPipelineRun>("already_exists", `run 已存在: ${options.run.id}`);
    } catch {
      // 不存在，继续创建。
    }

    const rootError = await assertManagedPath(paths, paths.runRootAbs);
    if (rootError) return fail(rootError.code, rootError.message);
    const fileError = await assertManagedPath(paths, paths.runJsonAbs);
    if (fileError) return fail(fileError.code, fileError.message);

    try {
      await fsp.mkdir(paths.runRootAbs, { recursive: true });
      await atomicWriteFile(paths.runJsonAbs, serializeSlidesPipelineRun(parsed.run));
    } catch {
      return fail("io_error", `写入 run.json 失败: ${options.run.id}`);
    }
    return { ok: true as const, value: parsed.run };
  });
}

export async function loadSlidesPipelineRun(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
}): Promise<SlidesPipelineWorkspaceResult<SlidesPipelineRun>> {
  const resolved = await resolveRunPaths(options.workspaceRoot, options.deckId, options.runId);
  if (!resolved.ok) return resolved;
  return enqueueRun(resolved.value.runRootAbs, () =>
    loadSlidesPipelineRunUnlocked(resolved.value, options.deckId, options.runId),
  );
}

export async function updateSlidesPipelineRun(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  expectedUpdatedAt: string;
  now?: string;
  mutate: (run: SlidesPipelineRun) => SlidesPipelineRun;
}): Promise<SlidesPipelineWorkspaceResult<SlidesPipelineRun>> {
  const resolved = await resolveRunPaths(options.workspaceRoot, options.deckId, options.runId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueRun(paths.runRootAbs, async () => {
    const current = await loadSlidesPipelineRunUnlocked(paths, options.deckId, options.runId);
    if (!current.ok) return current;
    if (current.value.updatedAt !== options.expectedUpdatedAt) {
      return fail("revision_conflict", `run 已更新，请刷新后重试: ${options.runId}`);
    }
    let next: SlidesPipelineRun;
    try {
      next = options.mutate(cloneRun(current.value));
    } catch (error) {
      return fail("invalid_payload", error instanceof Error ? error.message : "更新 run 失败");
    }
    if (
      next.id !== current.value.id ||
      next.deckId !== current.value.deckId ||
      next.createdAt !== current.value.createdAt ||
      next.schemaVersion !== current.value.schemaVersion
    ) {
      return fail("invalid_manifest", "run 核心字段不可变");
    }
    next.updatedAt = options.now ?? new Date().toISOString();
    const parsed = parseSlidesPipelineRun(next);
    if (!parsed.ok) return fail("invalid_manifest", parsed.error.message);

    try {
      await atomicWriteFile(paths.runJsonAbs, serializeSlidesPipelineRun(parsed.run));
    } catch {
      return fail("io_error", `更新 run.json 失败: ${options.runId}`);
    }
    return { ok: true as const, value: parsed.run };
  });
}

export async function cancelSlidesPipelineRun(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  expectedUpdatedAt: string;
  now?: string;
}): Promise<SlidesPipelineWorkspaceResult<SlidesPipelineRun>> {
  return updateSlidesPipelineRun({
    ...options,
    mutate: (run) => {
      if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
        throw new Error(`run 已终态，不能取消: ${run.status}`);
      }
      return {
        ...run,
        status: "canceled",
        roles: run.roles.map((role) =>
          role.status === "queued" || role.status === "running" || role.status === "awaiting-approval"
            ? { ...role, status: "canceled" }
            : role,
        ),
      };
    },
  });
}

async function writeSlidesRoleArtifactUnlocked<R extends SlidesRole>(options: {
  paths: RunPaths;
  run: SlidesPipelineRun;
  role: R;
  result: SlidesRoleResultByRole[R];
}): Promise<
  SlidesPipelineWorkspaceResult<{
    fileName: SlidesRoleArtifactFileName;
    artifactPath: string;
    result: SlidesRoleResultByRole[R];
  }>
> {
  if (!options.run.roles.some((entry) => entry.role === options.role)) {
    return fail("not_found", `run 中不存在角色: ${options.role}`);
  }
  const parsed = parseSlidesRoleResult(options.role, options.result);
  if (!parsed.ok) return fail("invalid_payload", parsed.error.message);
  const fileName = slidesRoleArtifactFileName(options.role);
  const artifactPath = join(options.paths.runRootAbs, fileName);
  const pathError = await assertManagedPath(options.paths, artifactPath);
  if (pathError) return fail(pathError.code, pathError.message);
  try {
    await atomicWriteFile(artifactPath, serializeSlidesRoleResult(options.role, parsed.result));
  } catch {
    return fail("io_error", `写入角色产物失败: ${options.role}`);
  }
  return {
    ok: true,
    value: {
      fileName,
      artifactPath,
      result: parsed.result,
    },
  };
}

async function readSlidesRoleArtifactUnlocked<R extends SlidesRole>(options: {
  paths: RunPaths;
  run: SlidesPipelineRun;
  role: R;
}): Promise<SlidesPipelineWorkspaceResult<SlidesRoleResultByRole[R]>> {
  if (!options.run.roles.some((entry) => entry.role === options.role)) {
    return fail("not_found", `run 中不存在角色: ${options.role}`);
  }
  const artifactPath = join(options.paths.runRootAbs, slidesRoleArtifactFileName(options.role));
  const pathError = await assertManagedPath(options.paths, artifactPath);
  if (pathError) return fail(pathError.code, pathError.message);
  try {
    const raw = await fsp.readFile(artifactPath, "utf8");
    const parsed = parseSlidesRoleResult(options.role, raw);
    if (!parsed.ok) return fail("invalid_payload", parsed.error.message);
    return { ok: true, value: parsed.result };
  } catch {
    return fail("not_found", `角色产物不存在: ${options.role}`);
  }
}

function validateNextRun(current: SlidesPipelineRun, next: SlidesPipelineRun): SlidesPipelineWorkspaceResult<SlidesPipelineRun> {
  if (
    next.id !== current.id ||
    next.deckId !== current.deckId ||
    next.createdAt !== current.createdAt ||
    next.schemaVersion !== current.schemaVersion
  ) {
    return fail("invalid_manifest", "run 核心字段不可变");
  }
  return { ok: true, value: next };
}

export async function transactSlidesPipelineRun<T>(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  expectedUpdatedAt?: string;
  now?: string;
  transaction: (
    ctx: SlidesPipelineRunTransactionContext,
  ) => Promise<SlidesPipelineWorkspaceResult<{ nextRun: SlidesPipelineRun; value: T }>>;
}): Promise<SlidesPipelineWorkspaceResult<{ run: SlidesPipelineRun; value: T }>> {
  const resolved = await resolveRunPaths(options.workspaceRoot, options.deckId, options.runId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueRun(paths.runRootAbs, async () => {
    const current = await loadSlidesPipelineRunUnlocked(paths, options.deckId, options.runId);
    if (!current.ok) return current;
    if (options.expectedUpdatedAt && current.value.updatedAt !== options.expectedUpdatedAt) {
      return fail("revision_conflict", `run 已更新，请刷新后重试: ${options.runId}`);
    }
    const now = options.now ?? new Date().toISOString();
    const tx = await options.transaction({
      run: cloneRun(current.value),
      now,
      readArtifact: (role) => readSlidesRoleArtifactUnlocked({ paths, run: current.value, role }),
      writeArtifact: (role, result) => writeSlidesRoleArtifactUnlocked({ paths, run: current.value, role, result }),
    });
    if (!tx.ok) return tx;
    const validated = validateNextRun(current.value, tx.value.nextRun);
    if (!validated.ok) return validated;
    validated.value.updatedAt = now;
    const parsed = parseSlidesPipelineRun(validated.value);
    if (!parsed.ok) return fail("invalid_manifest", parsed.error.message);
    try {
      await atomicWriteFile(paths.runJsonAbs, serializeSlidesPipelineRun(parsed.run));
    } catch {
      return fail("io_error", `更新 run.json 失败: ${options.runId}`);
    }
    return { ok: true, value: { run: parsed.run, value: tx.value.value } };
  });
}

export async function listLatestRecoverableSlidesPipelineRun(options: {
  workspaceRoot: string;
  deckId: string;
}): Promise<SlidesPipelineWorkspaceResult<SlidesPipelineRun | null>> {
  const deck = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!deck.ok) return deck;
  const runsDirAbs = resolve(deck.value.deckRootAbs, "drafts", "runs");
  try {
    const entries = await fsp.readdir(runsDirAbs, { withFileTypes: true });
    const candidates: SlidesPipelineRun[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
      const resolved = await resolveRunPaths(options.workspaceRoot, options.deckId, entry.name);
      if (!resolved.ok) continue;
      const loaded = await loadSlidesPipelineRunUnlocked(resolved.value, options.deckId, entry.name);
      if (!loaded.ok) continue;
      if (RECOVERABLE_STATUSES.has(loaded.value.status)) candidates.push(loaded.value);
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return { ok: true, value: candidates[0] ?? null };
  } catch {
    return { ok: true, value: null };
  }
}

export async function hasCompletedSlidesPipelineRunKind(options: {
  workspaceRoot: string;
  deckId: string;
  kind: SlidesPipelineRunKind;
}): Promise<SlidesPipelineWorkspaceResult<boolean>> {
  const deck = await resolveDeckPaths(options.workspaceRoot, options.deckId);
  if (!deck.ok) return deck;
  const runsDirAbs = resolve(deck.value.deckRootAbs, "drafts", "runs");
  try {
    const entries = await fsp.readdir(runsDirAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
      const resolved = await resolveRunPaths(options.workspaceRoot, options.deckId, entry.name);
      if (!resolved.ok) continue;
      const loaded = await loadSlidesPipelineRunUnlocked(resolved.value, options.deckId, entry.name);
      if (loaded.ok && loaded.value.kind === options.kind && loaded.value.status === "completed") return { ok: true, value: true };
    }
    return { ok: true, value: false };
  } catch {
    return { ok: true, value: false };
  }
}

export async function writeSlidesRoleArtifact<R extends SlidesRole>(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  role: R;
  result: SlidesRoleResultByRole[R];
}): Promise<
  SlidesPipelineWorkspaceResult<{
    fileName: SlidesRoleArtifactFileName;
    artifactPath: string;
    result: SlidesRoleResultByRole[R];
  }>
> {
  const resolved = await resolveRunPaths(options.workspaceRoot, options.deckId, options.runId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueRun(paths.runRootAbs, async () => {
    const current = await loadSlidesPipelineRunUnlocked(paths, options.deckId, options.runId);
    if (!current.ok) return current;
    return writeSlidesRoleArtifactUnlocked({
      paths,
      run: current.value,
      role: options.role,
      result: options.result,
    });
  });
}

export async function readSlidesRoleArtifact<R extends SlidesRole>(options: {
  workspaceRoot: string;
  deckId: string;
  runId: string;
  role: R;
}): Promise<SlidesPipelineWorkspaceResult<SlidesRoleResultByRole[R]>> {
  const resolved = await resolveRunPaths(options.workspaceRoot, options.deckId, options.runId);
  if (!resolved.ok) return resolved;
  const paths = resolved.value;
  return enqueueRun(paths.runRootAbs, async () => {
    const current = await loadSlidesPipelineRunUnlocked(paths, options.deckId, options.runId);
    if (!current.ok) return current;
    return readSlidesRoleArtifactUnlocked({ paths, run: current.value, role: options.role });
  });
}
