// 个人工作区持久化：~/.cortex-desktop/personal-workspace.json 全量读写。
// renderer 侧节流后调 store:save 覆盖；主进程串行化写入避免交错。

import { BrowserWindow, ipcMain } from "electron";
import { existsSync, promises as fsp } from "fs";
import { dirname, join } from "path";
import { mediaCustomSecretName, type MediaModality } from "@cortex-work/core/desktop/media-provider-directory";
import type { PersistedState, PushSettings } from "./types";
import { ensureMigrated, workspaceStorePath } from "../paths";
import { createLogger } from "../log";
import { isAllowedSensitiveValue } from "../providers/secrets";
import { getCredentialStoreHealth, setSecrets } from "../providers/credentials";

const log = createLogger("personal-workspace");

const EMPTY: PersistedState = { version: 1, projects: [], sessions: [] };

function storePath(): string {
  return workspaceStorePath();
}

let writeQueue: Promise<void> = Promise.resolve();

// 内存镜像：store:save 一到就同步更新,使后续 IPC（如 fs 路径白名单校验）立即
// 看到最新 projects,不必等磁盘写完——否则「添加项目 → 马上扫描目录」会因
// 落盘节流被误拒。
let cached: PersistedState | null = null;

export async function getPersistedState(): Promise<PersistedState> {
  if (cached) return cached;
  await ensureMigrated();
  try {
    const raw = await fsp.readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.projects) && Array.isArray(parsed.sessions)) {
      cached = parsed;
      return parsed;
    }
  } catch {
    // 首次启动或文件损坏，回退空状态（不缓存,等首次 save 建立镜像）。
  }
  return EMPTY;
}

// 通用设置里的默认工作目录（agent 启动未显式传 cwd 时兜底）。读 in-memory 镜像
//（generalSettings 立即落盘,反映 renderer 最新设置）。空串/失效目录视为未设置,
// 让调用方回退主目录,避免把失效路径交给 spawn 触发 ENOENT。
export async function getWorkspaceRoot(): Promise<string | undefined> {
  const root = (await getPersistedState()).generalSettings?.workspaceRoot;
  if (!root || !root.trim()) return undefined;
  return existsSync(root) ? root : undefined;
}

type RecoverySnapshot = Pick<PersistedState, "version" | "projects" | "sessions"> & {
  capturedAt: number;
};

function recoveryScore(snapshot: Pick<PersistedState, "projects" | "sessions">): number {
  return snapshot.projects.length + snapshot.sessions.length;
}

/**
 * 全量快照即将把非空项目或会话数组清零时，先保存一份只含索引的恢复点。
 *
 * 恢复文件刻意不复制 settings/provider/reply 等其它分片，避免把明文旧密钥或无关隐私再备份
 * 一份；若已有恢复点更完整则保留旧文件，防止连续空写把最后一份有效索引也覆盖掉。
 */
async function preserveRecoverySnapshot(path: string, next: PersistedState): Promise<void> {
  let previous: PersistedState;
  try {
    previous = JSON.parse(await fsp.readFile(path, "utf8")) as PersistedState;
  } catch {
    return;
  }
  if (!Array.isArray(previous.projects) || !Array.isArray(previous.sessions)) return;
  const clearsProjects = previous.projects.length > 0 && next.projects.length === 0;
  const clearsSessions = previous.sessions.length > 0 && next.sessions.length === 0;
  if (!clearsProjects && !clearsSessions) return;

  const recoveryPath = join(dirname(path), "personal-workspace.recovery.json");
  try {
    const existing = JSON.parse(await fsp.readFile(recoveryPath, "utf8")) as RecoverySnapshot;
    if (
      Array.isArray(existing.projects) &&
      Array.isArray(existing.sessions) &&
      recoveryScore(existing) >= recoveryScore(previous)
    ) {
      return;
    }
  } catch {
    // 首次生成或旧恢复点损坏时，继续用当前有效权威态重建。
  }

  const recovery: RecoverySnapshot = {
    version: 1,
    capturedAt: Date.now(),
    projects: previous.projects,
    sessions: previous.sessions,
  };
  const tmp = `${recoveryPath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(recovery, null, 2), "utf8");
  await fsp.rename(tmp, recoveryPath);
  log.warn(
    `检测到破坏性全量快照，已保存恢复索引：projects=${previous.projects.length} sessions=${previous.sessions.length}`,
  );
}

async function savePersistedState(state: PersistedState): Promise<void> {
  await ensureMigrated();
  const path = storePath();
  await fsp.mkdir(dirname(path), { recursive: true });
  await preserveRecoverySnapshot(path, state);
  const tmp = path + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, path);
}

// pushSettings 变更广播：推给**所有**窗口（含发起方）。项目管理等二级窗口刻意不挂全量持久化
// （防陈旧快照 clobber，见 ProjectsWorkbench 注释），它们的 pushSettings 镜像只能靠这条窄通道
// 保持新鲜；主窗口收到自己发起的变更时内容相等、渲染端跳过写入，不会形成 save→广播→save 回环。
function broadcastPushSettingsIfChanged(prev: PushSettings | undefined, next: PushSettings | undefined): void {
  if (JSON.stringify(prev ?? {}) === JSON.stringify(next ?? {})) return;
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send("store:push-settings-changed", next ?? {});
  }
}

// onSaved 的模块级引用。提到模块作用域是为了让 updatePersistedState（main 内部发起的窄写）
// 与 renderer 发起的 store:save 走**完全相同**的提交路径——否则 main 侧写入不会触发订阅方
// （如 syncResearchEngineRuntime），改了设置却要重启才生效。
let onSavedCallback: ((state: PersistedState) => void) | undefined;

/// 统一的提交路径：更新内存镜像 → 通知订阅方 → 广播 → 串行落盘。
function commit(prev: PersistedState | null, state: PersistedState): Promise<void> {
  cached = state;
  onSavedCallback?.(state);
  broadcastPushSettingsIfChanged(prev?.pushSettings, state.pushSettings);
  writeQueue = writeQueue.then(() => savePersistedState(state)).catch((err) => {
    log.error("save failed:", err);
  });
  return writeQueue;
}

/// main 内部的窄写通道：在**权威态**上就地合并后落盘，返回合并后的状态。
///
/// 为什么不让 renderer 传全量状态过来：那会有「陈旧全量快照 clobber」问题
/// （同 store:patchPushSettings 的注释）。main 侧要写的东西——比如 safeStorage 加密后的
/// Search Server 密文——renderer 根本不该持有全量上下文，只能由 main 读最新态再改一处。
export async function updatePersistedState(
  mutate: (state: PersistedState) => PersistedState,
): Promise<PersistedState> {
  const base = await getPersistedState();
  const next = mutate(base);
  await commit(base, next);
  return next;
}

/// 阶段②·§5：删除旧 `providerSettings`（含全部明文 apiKey），**不迁移、不留备份**。
///
/// 为什么直接删而不是迁移：旧结构的 models[] 会覆盖 pi 内置模型目录（本次能力事故根因），
/// 迁过来只会把坏配置带进新体系；且 apiKey 明文本就该消失，任何"备份"都违背这次修复的目的。
/// 新体系里用户重新添加 Provider（凭据进 safeStorage 金库）。
///
/// 幂等性：字段不存在时**完全不写盘**（避免每次启动都产生一次无谓提交），
/// 删除后落一个 legacyProviderSettingsCleared 标记，让升级提示只弹一次。
/// 写入刻意走既有的 commit/writeQueue 提交路径，不另起写通道——否则会与 renderer 的
/// store:save 竞争、互相 clobber。
export async function purgeLegacyProviderSettings(): Promise<boolean> {
  const base = await getPersistedState();
  if (base.providerSettings === undefined) return false;
  const next: PersistedState = { ...base, legacyProviderSettingsCleared: { at: Date.now(), noticeAcknowledged: false } };
  delete next.providerSettings;
  await commit(base, next);
  log.info("已清除旧版供应商配置（含明文密钥），用户需在新体系中重新添加");
  return true;
}

/// 阶段③·4.1：抹掉 `writingLlmSettings` 与 `timelineSettings.summaryModel` 里残留的**明文凭据**。
///
/// 为什么主进程还要再抹一遍（渲染端的 hydrate 已经丢弃这些键了）：hydrate 只在**渲染端下一次
/// 全量保存**时才把丢弃结果写回磁盘。用户如果升级后再没碰过任何设置，那份明文 apiKey 就一直
/// 躺在 personal-workspace.json 里。首启抹除不依赖用户做任何事，是确定性的。
///
/// 只删凭据字段、不删整块：`writingLlmSettings` 的 debounceMs / maxTokens / completionEnabled
/// 是无害的行为调优，用户调过的值没有理由跟着一起丢。而寻址字段（baseUrl/apiKey/model）
/// **不迁移**——旧 baseUrl 是用户自建端点，映射不到 Catalog 引用，只能请用户重选一次模型。
///
/// 幂等：没有任何残留键时完全不写盘，避免每次启动都产生一次无谓提交。
/// 同样走既有 commit/writeQueue 路径，不另起写通道（否则与 renderer 的 store:save 互相 clobber）。
export async function purgeLegacyPlaintextCredentials(): Promise<boolean> {
  const base = await getPersistedState();
  // timelineSettings 只镜像在 core 侧（主进程不消费它），故这里按结构读而不是给
  // PersistedState 加字段 —— 为了抹一次旧凭据去扩主进程契约不划算，也会与 core 镜像多一处要同步。
  const withTimeline = base as PersistedState & {
    timelineSettings?: { summaryModel?: Record<string, unknown> };
  };
  const writing = base.writingLlmSettings as (Record<string, unknown> & { providerId?: string }) | undefined;
  const summary = withTimeline.timelineSettings?.summaryModel;

  const LEGACY_KEYS = ["baseUrl", "apiKey", "model"] as const;
  const writingDirty = writing !== undefined && LEGACY_KEYS.some((k) => k in writing);
  // 旧的 `kind:"openai"` 分支自带 baseUrl/apiKey，是第三处明文落盘点；整条丢弃后落到未配置态。
  const summaryDirty = summary?.kind === "openai";
  if (!writingDirty && !summaryDirty) return false;

  const next: PersistedState = { ...base };
  if (writingDirty) {
    const cleaned = { ...writing };
    for (const key of LEGACY_KEYS) delete cleaned[key];
    next.writingLlmSettings = cleaned as unknown as PersistedState["writingLlmSettings"];
  }
  if (summaryDirty) {
    (next as typeof withTimeline).timelineSettings = {
      ...withTimeline.timelineSettings,
      summaryModel: { kind: "gateway" },
    };
  }
  await commit(base, next);
  log.info("已清除写作 / 日报设置里残留的明文凭据，相关模型需重新选择");
  return true;
}

/// 媒体生成明文密钥一次性迁移（设计 §4.3，与 purgeLegacyPlaintextCredentials 并排、同一注册点触发）：
/// 把四模态 mediaGenSettings.<m>.apiKey 里残留的明文搬进 safeStorage 金库命名 Secret
/// （media.<modality>.custom，与设置 UI 共用 mediaCustomSecretName 常量），
/// 并把持久化字段改写为 `${secret:media.<modality>.custom}` 引用。
///
/// 判定：apiKey 非空、且不是 `${secret:}` / `$ENV` / `!cmd` 三种允许形态（isAllowedSensitiveValue）
/// 才算待迁移明文；无待迁移项**完全不写盘**（幂等，同 purge 先例）。
/// safeStorage 不可用（部分 Linux）时整体跳过、下次启动重试——绝不能出现「金库写失败、
/// 原值又被抹掉」的丢 key 事故，也绝不明文进金库。
///
/// 顺序刻意：先 setSecrets 落金库，成功后才 updatePersistedState 改写引用。反过来的话，
/// 状态先改写、金库写失败会立即产生悬空引用（媒体生成直接断档）；现顺序下状态改写失败
/// 只是金库多存一份副本，下次启动重跑仍能收敛到一致态。
export async function migrateMediaGenPlaintextKeys(): Promise<boolean> {
  const base = await getPersistedState();
  const mediaGen = base.mediaGenSettings;
  if (!mediaGen) return false;

  const modalities: readonly MediaModality[] = ["image", "speech", "music", "video"];
  const pending = modalities.filter((m) => {
    const raw = mediaGen[m]?.apiKey;
    const key = typeof raw === "string" ? raw.trim() : "";
    return key !== "" && !isAllowedSensitiveValue(key);
  });
  if (pending.length === 0) return false;

  if (!getCredentialStoreHealth().available) {
    log.warn("系统密钥库不可用，媒体生成明文密钥迁移跳过（原值保留，下次启动重试）");
    return false;
  }

  // 金库先行（见函数头注释的顺序说明）；一次 setSecrets 批量落盘，避免部分成功。
  const secretPatch: Record<string, string> = {};
  for (const m of pending) secretPatch[mediaCustomSecretName(m)] = mediaGen[m].apiKey.trim();
  await setSecrets(secretPatch);

  const migrated = new Set<MediaModality>(pending);
  const ref = (m: MediaModality) => `\${secret:${mediaCustomSecretName(m)}}`;
  await updatePersistedState((state) => {
    const cur = state.mediaGenSettings;
    if (!cur) return state;
    // 逐模态显式改写（四模态类型各异，绕开联合索引赋值的类型收窄问题）。
    return {
      ...state,
      mediaGenSettings: {
        image: migrated.has("image") ? { ...cur.image, apiKey: ref("image") } : cur.image,
        speech: migrated.has("speech") ? { ...cur.speech, apiKey: ref("speech") } : cur.speech,
        music: migrated.has("music") ? { ...cur.music, apiKey: ref("music") } : cur.music,
        video: migrated.has("video") ? { ...cur.video, apiKey: ref("video") } : cur.video,
      },
    };
  });
  log.info(`媒体生成明文密钥已迁入金库并改写为引用：${pending.join(", ")}`);
  return true;
}

// onSaved：每次 renderer 全量落设置后同步调用（cached 已更新）。用于让 main 侧订阅方即时
// 反应设置变更——当前唯一订阅方是任务提醒调度器（读 pushSettings.internal.enabled opt-in 变化，
// off→on 建 Cron/补跑、on→off 拆全部）。回调抛错不阻断落盘（调用方自行兜底）。
export function registerStoreHandlers(onSaved?: (state: PersistedState) => void): void {
  onSavedCallback = onSaved;
  ipcMain.handle("store:load", () => getPersistedState());
  ipcMain.handle("store:save", (_e, state: PersistedState) => commit(cached, state));
  // pushSettings 窄写通道：main 在权威态上就地合并后落盘，供不挂全量持久化的窗口
  // （项目管理等）安全写入推送开关——绕开「陈旧全量快照 clobber」问题。
  ipcMain.handle("store:patchPushSettings", async (_e, patch: Partial<PushSettings>) => {
    const base = await getPersistedState();
    return commit(base, { ...base, pushSettings: { ...base.pushSettings, ...patch } });
  });
}
