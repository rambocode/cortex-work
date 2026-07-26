// CRE 的运行时装配（唯一接触 Electron 的研究模块）。
//
// 这里把 P3（仓储 / blob / 启动恢复）、P4（Worker 进程）与 P5（编排 / Facade）拼成一个可用的
// ResearchService，并暴露给 ipc/research.ts 与 main/index.ts。
//
// 装配原则：**所有带副作用的东西都懒加载**。研究引擎默认关闭（settings.enabled = false），
// 绝大多数用户永远不会用到它——在 app 启动路径上无条件建 SQLite 连接、fork Worker，
// 是纯粹的启动耗时与内存浪费。
import { app, safeStorage } from "electron";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ProviderSettings } from "@cortex-work/core/desktop/types";
import {
  DEFAULT_RESEARCH_ENGINE_SETTINGS,
  normalizeResearchEngineSettings,
  type ResearchDirectSearchSettings,
  type ResearchEngineSettings,
} from "@cortex-work/core/research/settings";
import type { DirectSearchProviderId } from "@cortex-work/core/research/direct-search";
import { createLogger } from "../log";
import { resolveAgentBrowserBinary } from "../capabilities/agent-browser/locate";
import { getPersistedState, updatePersistedState } from "../ipc/store";
// U10：已批准的记忆候选写入 / 撤销（研究服务经 researchMemorySink 调它）。
import { userMemoryStore } from "../ipc/memory";
import { applyApprovedResearchMemory, revokeResearchMemory } from "../memory/research-memory";
import type { PersistedState } from "../ipc/types";
import type { ResearchSearchServerSettings } from "../ipc/types-research";
import { researchBlobsDir, researchDbPath, researchDir, researchTmpDir } from "../paths";
import { ResearchBlobStore } from "./blob-store";
import { buildResearchLlmHooks } from "./llm-hooks-wiring";
import { SearchServerClient } from "./clients/search-server-client";
import { DirectSearchClient } from "./clients/direct-search-client";
import { StealthFetchClient } from "./clients/stealth-fetch-client";
import { openResearchDatabase } from "./db-open";
import { applyMigrations } from "./migrations";
import { redactResearchLog } from "./redact-research";
import { SqliteResearchRepository, type ResearchRepository } from "./research-repository";
import {
  mergeDirectSearchSettings,
  mergeSearchServerSettings,
  probeDirectSearch,
  probeSearchServer,
  type SearchServerProbeResult,
} from "./search-credential";
import {
  ResearchService,
  type ResearchWorkerProvider,
} from "./research-service";
import { QuickRetrieval } from "./quick-retrieval";
import type { ResearchWorkerLike, SearchClientLike } from "./research-orchestrator";
import { createNodeSqliteDriver } from "./sqlite-driver";
import { runResearchStartupRecovery } from "./startup-recovery";
import { resolveResearchWorkerEntry } from "./worker/entry-resolver";
import { registerResearchWorker, unregisterResearchWorker } from "./worker/kill-all";
import { ResearchWorkerProcess } from "./worker/process-manager";
import { forkUtilityWorkerTransport, type WorkerTransport } from "./worker/transport";

const log = createLogger("research");

/// 当前设置快照。由 store 落盘回调经 syncResearchEngineRuntime 更新，读取方永远拿最新值。
let settingsSnapshot: ResearchEngineSettings = { ...DEFAULT_RESEARCH_ENGINE_SETTINGS };

/// 懒加载的服务实例（连同它的 SQLite 连接）。
let servicePromise: Promise<ResearchService> | null = null;

/// KTD9 的隔离键。桌面端当前是单账号本地应用，固定 "local"；
/// 多账号（U9）落地后改成账号 id，届时旧数据会因 scope 不同而自然停止跨账号复用——
/// 这正是我们要的安全默认值，不需要迁移。
const USER_SCOPE = "local";

/// 同步研究引擎设置（register.ts 的 store 落盘回调 + 启动时各调一次）。
///
/// 关掉总开关时**主动停 Worker**：否则用户"关掉功能"之后进程还在后台占着内存，
/// 与设置页显示的状态不一致。
export function syncResearchEngineRuntime(raw: unknown): void {
  settingsSnapshot = normalizeResearchEngineSettings(raw);
  // 供应商配置与 researchEngine 设置同在 personal-workspace.json，落盘回调是它变更的唯一时机。
  // 这里 fire-and-forget 刷新快照：llmHooks 是同步回调（每个 Session 建一次），拿不到 await。
  // getPersistedState() 有内存镜像，这次读几乎无成本。
  void refreshProviderSnapshot();
  if (!settingsSnapshot.enabled) {
    if (servicePromise) {
      void servicePromise
        .then((service) => service.shutdown())
        .catch((err) => log.warn("[research] 关闭引擎时停 Worker 失败", err));
    }
    // 窄面（agent 的 web_search / web_read）也会 fork 同一个 Worker，且它不经 ResearchService。
    // 只停 service 的话，「从没开过深度研究、只用过 agent 联网」的用户关掉总开关后，
    // 后台仍留着一个 Worker 进程——与设置页显示的状态不一致。
    void workerProviderSingleton
      ?.stop()
      .catch((err) => log.warn("[research] 关闭引擎时停共享 Worker 失败", err));
  }
}

/// 供应商配置快照。仅供 llmHooks 这个同步回调使用；其余地方一律现读 getPersistedState()。
let providerSettingsSnapshot: ProviderSettings | null = null;

/// 刷新供应商快照。读失败不抛（研究引擎不该因为读设置失败而整体不可用），
/// 只是本次装配拿不到 LLM 能力，编排层降级为确定性行为。
async function refreshProviderSnapshot(): Promise<void> {
  try {
    providerSettingsSnapshot = (await getPersistedState()).providerSettings ?? null;
  } catch (err) {
    log.warn("[research] 读取供应商配置失败，LLM 能力本轮降级", redactResearchLog(err));
  }
}

/// 当前设置快照（IPC 层用它决定要不要报"未开启"）。
export function getResearchEngineSettings(): ResearchEngineSettings {
  return settingsSnapshot;
}

/// 取（必要时创建）研究服务实例。
export function getResearchService(): Promise<ResearchService> {
  servicePromise ??= assembleService().catch((err) => {
    // 装配失败不缓存失败的 Promise：用户修好磁盘权限后重试应该能成功。
    servicePromise = null;
    throw err;
  });
  return servicePromise;
}

/// 启动恢复（main/index.ts 在 whenReady 后调用）。
///
/// **只有引擎已开启时才跑**：恢复要开数据库，而关闭状态下连数据库都不该碰。
/// 引擎关闭时磁盘上的非终态 Session 会在下次开启时被归一，语义不受影响。
export async function runResearchStartupTasks(): Promise<void> {
  if (!settingsSnapshot.enabled) return;
  try {
    const repository = await getResearchRepository();
    const report = await runResearchStartupRecovery({
      repository,
      tmpDir: researchTmpDir(),
      now: new Date(),
      logger: log,
    });
    log.info("[research] 启动恢复完成", redactResearchLog(report));
  } catch (err) {
    // 启动恢复失败不该阻断应用启动：最坏情况是几个 Session 显示"进行中"，用户仍能新建研究。
    log.warn("[research] 启动恢复失败", err);
  }
}

/// 停掉研究运行时（应用退出钩子）。
export async function shutdownResearchRuntime(): Promise<void> {
  try {
    if (servicePromise) {
      await (await servicePromise).shutdown();
      repositoryRef?.close();
    }
    // Worker 提供方是 service 与窄面共享的：只在 servicePromise 存在时才停，
    // 会漏掉「只用过 agent 的 web_search、从没开过深度研究」这条路径上 fork 出来的 Worker。
    await workerProviderSingleton?.stop();
  } catch (err) {
    log.warn("[research] 停止研究运行时失败", err);
  }
}

// ── 装配细节 ────────────────────────────────────────────────────────────────

/// 仓储实例（与 service 共享同一个 SQLite 连接）。
let repositoryRef: ResearchRepository | null = null;

/// 打开（必要时重建）数据库并返回仓储。
async function getResearchRepository(): Promise<ResearchRepository> {
  if (repositoryRef) return repositoryRef;
  const driver = await openResearchDatabase({
    dbPath: researchDbPath(),
    // 首启时 ~/.cortex-desktop/research/ 尚不存在；blob/tmp 各自会 mkdir，唯独主库没人建目录。
    ensureDbDir: async () => {
      await mkdir(researchDir(), { recursive: true });
    },
    createDriver: (path) => createNodeSqliteDriver(path),
    migrate: (db) => {
      applyMigrations(db);
    },
    quarantine: quarantineDatabase,
    logger: log,
  });
  repositoryRef = new SqliteResearchRepository(driver);
  return repositoryRef;
}

/// 隔离损坏的数据库：**先复制后删除**（spec §13.2「不静默覆盖」）。
/// WAL / SHM 一并处理——只挪主库文件会让重建时读到旧 WAL，等于没隔离干净。
async function quarantineDatabase(dbPath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.corrupt-${stamp}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    try {
      await copyFile(source, `${backupPath}${suffix}`);
      await rm(source, { force: true });
    } catch (err) {
      // 主库必须挪成功；WAL/SHM 不存在是常态（未开 WAL 或已 checkpoint）。
      if (suffix === "") throw err;
    }
  }
  return backupPath;
}

/// 窄同步检索面（discover / prepare）。
///
/// **与 ResearchService 共用同一个 Worker 提供方实例**：两者都可能同时在跑，
/// 各起一个 utilityProcess 等于把抓取进程数翻倍，而 Worker 内部本来就有并发闸。
/// 它不碰 SQLite / blob，所以不需要等 assembleService，独立懒加载即可。
let quickRetrieval: QuickRetrieval | null = null;

/// 取（必要时创建）窄面实例。
///
/// 与 getResearchService 不同，这里是同步的：窄面不开数据库、不做启动恢复，
/// 没有任何需要 await 的装配步骤。MCP 工具 handler 因此不必为拿它多一次异步跳转。
export function getQuickRetrieval(): QuickRetrieval {
  quickRetrieval ??= new QuickRetrieval({
    settings: () => settingsSnapshot,
    createSearchClient: () => createSearchClient(),
    workerProvider: sharedWorkerProvider(),
    newId: () => randomUUID(),
    logger: log,
  });
  return quickRetrieval;
}

/// 进程内共享的 Worker 提供方。ResearchService 与 QuickRetrieval 都取这一个。
let workerProviderSingleton: ElectronResearchWorkerProvider | null = null;
function sharedWorkerProvider(): ElectronResearchWorkerProvider {
  workerProviderSingleton ??= new ElectronResearchWorkerProvider();
  return workerProviderSingleton;
}

/// 组装 ResearchService。
async function assembleService(): Promise<ResearchService> {
  const repository = await getResearchRepository();
  const blobStore = new ResearchBlobStore({
    blobsDir: researchBlobsDir,
    tmpDir: researchTmpDir,
  });
  // 首个 Session 就要能用上 LLM，故这里先同步读一次；此后靠 syncResearchEngineRuntime 保鲜。
  await refreshProviderSnapshot();

  return new ResearchService({
    repository,
    blobStore: {
      putBlob: (hash, text) => blobStore.putBlob(hash, text),
      gcOrphanBlobs: (hashes) => blobStore.gcOrphanBlobs(hashes),
    },
    settings: () => settingsSnapshot,
    createSearchClient: () => createSearchClient(),
    // 服务端 stealth 抓取（反爬站点）。未配置 Search Server 或密钥库不可用时返回 null，
    // 编排层据此跳过该路径，行为与从前完全一致。
    createStealthFetchClient: () => createStealthFetchClient(),
    workerProvider: sharedWorkerProvider(),
    userScope: () => USER_SCOPE,
    newId: () => randomUUID(),
    // Browser 兜底的二进制。**每次现取而不是启动时取一次**：dev 态下 node_modules 可能在
    // 应用启动之后才装好，缓存一个 null 会让整个进程周期内都用不上浏览器。
    // 取不到返回 null，worker 侧据此跳过兜底（不是失败，只是这个候选救不回来）。
    agentBrowserBinary: () =>
      resolveAgentBrowserBinary({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        platform: process.platform,
        arch: process.arch,
      }),
    // P7：按 Session 装配 Planner / Report Generator。返回 null（未配供应商）时编排层沿用
    // 确定性的种子计划 + 单轮 + 证据摘要，**不让 Session 失败**。
    // 研究模型偏好取自设置快照：与 providerSettings 同一份 personal-workspace.json，
    // 两者都在落盘回调里刷新，所以同一个 Session 内选型稳定（见 refreshProviderSnapshot）。
    llmHooks: ({ summary }) =>
      buildResearchLlmHooks({
        summary,
        providerSettings: providerSettingsSnapshot,
        preference: {
          ...(settingsSnapshot.modelProviderId
            ? { providerId: settingsSnapshot.modelProviderId }
            : {}),
          ...(settingsSnapshot.modelId ? { modelId: settingsSnapshot.modelId } : {}),
        },
        logger: log,
      }),
    // U10：已批准候选 → 用户记忆的 research 段（含 provenance sidecar）。
    // 这里是把「记忆模块」接进研究服务的唯一一处；service 本身不知道记忆文件在哪。
    researchMemorySink: {
      approve: (candidate, chunkIds, approvedAt) =>
        applyApprovedResearchMemory(userMemoryStore, candidate, chunkIds, approvedAt),
      revoke: (candidateId) => revokeResearchMemory(userMemoryStore, candidateId),
    },
    logger: log,
  });
}

/// 依据当前设置构造搜索客户端；选中的那条未配置（或密文解不开）时返回 null（上层报"未配置"）。
///
/// **两条路径是单选，按 settings.searchBackend 走，彼此不回落**（曾经是
/// `createSearchServerClient() ?? createDirectSearchClient()` 的优先级链）。
/// 不回落是刻意的：两条路径的隐私边界不同——Search Server 的查询词经服务端转发、有限流与审计，
/// 直连是查询词从本机直接出站给第三方。选了 server 却因为令牌解不开而静默改走直连，
/// 等于把查询词发去了用户没有选择的地方。报「未配置」让用户自己决定怎么修。
function createSearchClient(): SearchClientLike | null {
  return settingsSnapshot.searchBackend === "server"
    ? createSearchServerClient()
    : createDirectSearchClient();
}

/// 自建 Search Server 客户端；未配置或密文解不开时返回 null。
function createSearchServerClient(): SearchClientLike | null {
  const config = settingsSnapshot.searchServer;
  if (!config?.baseUrl || !config.workspaceId) return null;

  const token = decryptToken(config.encryptedToken);
  if (token === null) return null;

  return new SearchServerClient(
    { baseUrl: config.baseUrl, workspaceId: config.workspaceId, token },
    { clientVersion: app.getVersion() },
  );
}

/// 直连商业搜索客户端；未配置或密文解不开时返回 null。
function createDirectSearchClient(): DirectSearchClient | null {
  const config = settingsSnapshot.directSearch;
  if (!config?.provider) return null;

  const apiKey = decryptToken(config.encryptedApiKey);
  if (apiKey === null) return null;

  return new DirectSearchClient({ provider: config.provider, apiKey });
}

/// 写入 Search Server 连接配置（设置页「保存令牌」）。
///
/// 明文 PAT 的**唯一**归宿是这里：safeStorage 加密 → base64 → 落进
/// personal-workspace.json 的 generalSettings.researchEngine.searchServer.encryptedToken。
/// 那份 JSON 是明文文件，所以明文 token 绝不能进去；这也是本函数存在的全部理由——
/// 让 renderer 无法绕过加密直接写该字段。
///
/// 写入走 updatePersistedState（main 侧窄写），而不是让 renderer 传全量状态：
/// 后者会有陈旧快照 clobber（见 store.ts 注释）。写完顺带同步 settingsSnapshot，
/// 使下一次搜索立即用上新凭据，无需重启。
///
/// **返回落盘后的切片（含密文，不含明文）**：renderer 必须拿它更新自己的 store，
/// 否则它那份没有 encryptedToken 的副本会在下一次全量写回时把刚存的令牌抹掉。
export async function setSearchServerCredential(input: {
  baseUrl: string;
  workspaceId: string;
  token?: string;
}): Promise<ResearchSearchServerSettings> {
  let encryptedToken: string | undefined;
  if (input.token) {
    if (!safeStorage.isEncryptionAvailable()) {
      // fail closed：钥匙串不可用时**宁可拒绝保存**，也不把明文写进 JSON。
      throw new Error("系统密钥库不可用，无法安全保存令牌");
    }
    encryptedToken = safeStorage.encryptString(input.token).toString("base64");
  }

  const next = await updatePersistedState((state) => {
    const general = state.generalSettings;
    // 基线取**磁盘上的**旧值而非 settingsSnapshot：后者可能还没被落盘回调刷新，
    // 用它当基线会把刚存的密文覆盖掉。
    const research = normalizeResearchEngineSettings(general?.researchEngine);
    const researchEngine = {
      ...research,
      searchServer: mergeSearchServerSettings(research.searchServer, {
        baseUrl: input.baseUrl,
        workspaceId: input.workspaceId,
        encryptedToken,
      }),
    };
    return {
      ...state,
      // 这个断言只在「磁盘上压根没有 generalSettings」时不成立（缺 desktopBehavior /
      // notifications / log 三个必填字段）。那只发生在全新 profile 上，而设置页要能点到
      // 「保存令牌」，用户必须先填地址与工作区，那一步已经让 renderer 落过一次完整
      // generalSettings。即便真撞上，main 侧对这三个字段全是 optional 读法，
      // renderer 下一次全量 save 也会补齐——不值得为此在这里编一份默认值出来。
      generalSettings: { ...(general ?? {}), researchEngine } as NonNullable<
        PersistedState["generalSettings"]
      >,
    };
  });
  syncResearchEngineRuntime(next.generalSettings?.researchEngine);
  // 从落盘后的状态里回读，而不是回传合并前构造的对象——保证 renderer 拿到的
  // 与磁盘上的完全一致（归一化可能剥掉字段）。
  return next.generalSettings?.researchEngine?.searchServer ?? {
    baseUrl: input.baseUrl.trim(),
    workspaceId: input.workspaceId.trim(),
  };
}

/// 连通性探测（设置页「连接测试」）。
///
/// **不接受也不回传任何凭据**：用已落盘的密文自行解密发起，只回成败与一句人话（spec §16）。
export async function testSearchServer(): Promise<SearchServerProbeResult> {
  const config = settingsSnapshot.searchServer;
  if (!config?.baseUrl || !config.workspaceId) {
    return { ok: false, message: "请先填写服务地址与工作区 ID。" };
  }
  const token = decryptToken(config.encryptedToken);
  if (token === null) {
    return { ok: false, message: "尚未保存访问令牌，或本机密钥库无法解密它，请重新保存令牌。" };
  }
  const client = new SearchServerClient(
    { baseUrl: config.baseUrl, workspaceId: config.workspaceId, token },
    { clientVersion: app.getVersion() },
  );
  // 把明文交给 probe 只为擦除服务端可能回显的凭据，probe 自身不发送也不记录它。
  return probeSearchServer(client, token);
}

/// 写入直连搜索配置（设置页「保存密钥」）。
///
/// 与 setSearchServerCredential 同一套安全约定：明文 API key 的唯一归宿是这里，
/// safeStorage 加密 → base64 → 落进 researchEngine.directSearch.encryptedApiKey；
/// 钥匙串不可用时 **fail closed**（宁可拒绝保存，也不把明文写进那份明文 JSON）。
///
/// 返回落盘后的切片（含密文、不含明文），renderer 必须拿它更新自己的 store——
/// 否则它那份没有 encryptedApiKey 的副本会在下一次全量写回时把刚存的密钥抹掉
/// （这个坑在 Search Server 那条路径上真实踩过，见 setSearchServerCredential 的注释）。
export async function setDirectSearchCredential(input: {
  provider: DirectSearchProviderId;
  apiKey?: string;
}): Promise<ResearchDirectSearchSettings> {
  let encryptedApiKey: string | undefined;
  if (input.apiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统密钥库不可用，无法安全保存搜索密钥");
    }
    encryptedApiKey = safeStorage.encryptString(input.apiKey).toString("base64");
  }

  const next = await updatePersistedState((state) => {
    const general = state.generalSettings;
    // 基线取磁盘上的旧值而非 settingsSnapshot（后者可能还没被落盘回调刷新）。
    const research = normalizeResearchEngineSettings(general?.researchEngine);
    const researchEngine = {
      ...research,
      directSearch: mergeDirectSearchSettings(research.directSearch, {
        provider: input.provider,
        ...(encryptedApiKey !== undefined ? { encryptedApiKey } : {}),
      }),
    };
    return {
      ...state,
      generalSettings: { ...(general ?? {}), researchEngine } as NonNullable<
        PersistedState["generalSettings"]
      >,
    };
  });
  syncResearchEngineRuntime(next.generalSettings?.researchEngine);
  return next.generalSettings?.researchEngine?.directSearch ?? { provider: input.provider };
}

/// 直连搜索的连通性探测（设置页「连接测试」的直连分支）。
export async function testDirectSearch(): Promise<SearchServerProbeResult> {
  const config = settingsSnapshot.directSearch;
  if (!config?.provider) {
    return { ok: false, message: "请先选择搜索服务商。" };
  }
  const apiKey = decryptToken(config.encryptedApiKey);
  if (apiKey === null) {
    return { ok: false, message: "尚未保存 API 密钥，或本机密钥库无法解密它，请重新保存密钥。" };
  }
  return probeDirectSearch(
    new DirectSearchClient({ provider: config.provider, apiKey }),
    config.provider,
    apiKey,
  );
}

/// 依据当前设置构造服务端 stealth 抓取客户端；未配置或密文解不开时返回 null。
///
/// **复用 searchServer 的那套配置**（baseUrl / workspaceId / 加密 PAT）而不是新增一组：
/// 两者打的是同一个 backend、同一个 workspace、同一个凭据，拆成两份配置只会让用户填两遍、
/// 且给「只配了一半」留下空间。服务端是否真的装了 fetch sidecar 由它自己回
/// 503 fetch_unconfigured 告知，编排层据此跳过该路径——不需要客户端提前知道。
function createStealthFetchClient(): StealthFetchClient | null {
  const config = settingsSnapshot.searchServer;
  if (!config?.baseUrl || !config.workspaceId) return null;

  const token = decryptToken(config.encryptedToken);
  if (token === null) return null;

  return new StealthFetchClient({
    baseUrl: config.baseUrl,
    workspaceId: config.workspaceId,
    token,
  });
}

/// 解密 safeStorage 密文。失败返回 null 而不是抛错——钥匙串不可用时应表现为"未配置"，
/// 而不是每次研究都抛一条看不懂的解密错误。**明文只在本函数返回值里短暂存在，不进日志。**
function decryptToken(encryptedToken: string | undefined): string | null {
  if (!encryptedToken) return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
  } catch (err) {
    log.warn("[research] 搜索服务凭据解密失败", err instanceof Error ? err.name : "unknown");
    return null;
  }
}

/// Worker 提供方的生产实现。
///
/// 崩溃策略：**不自动重启**（process-manager 明确不重启，避免"每次都在同一份 PDF 上崩"变成
/// 无限重启风暴）。这里只把实例置空，下一次 ensure() 会重新 fork ——
/// 即"按需惰性重拉"，代价是用户重试一次，收益是不会烧 CPU。
class ElectronResearchWorkerProvider implements ResearchWorkerProvider {
  private process: ResearchWorkerProcess | null = null;
  private transport: WorkerTransport | null = null;
  private starting: Promise<ResearchWorkerLike> | null = null;

  async ensure(): Promise<ResearchWorkerLike> {
    if (this.process?.isRunning) return this.process;
    // 单飞：两个 Session 同时发起研究时只 fork 一个 Worker。
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    const current = this.process;
    this.process = null;
    if (current) await current.stop();
    if (this.transport) {
      unregisterResearchWorker(this.transport);
      this.transport = null;
    }
  }

  private async start(): Promise<ResearchWorkerLike> {
    const entry = resolveResearchWorkerEntry({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
    });
    if (!entry) throw new Error("找不到 Research Worker 入口（out/worker/research-worker.js）");

    const worker = new ResearchWorkerProcess({
      createTransport: () => {
        const transport = forkUtilityWorkerTransport(entry);
        // 注册进全局表：退出钩子的 killAllResearchWorkers 靠它一把杀干净
        //（utilityProcess 子进程不会随主进程退出自动消失）。
        registerResearchWorker(transport);
        this.transport = transport;
        return transport;
      },
      desktopVersion: app.getVersion(),
      onEvent: (event) => {
        if (event.type === "crashed") {
          log.error("[research] Worker 崩溃，下次研究时按需重拉", event.error.message);
          this.process = null;
        }
        if (event.type === "stopped" && this.transport) {
          unregisterResearchWorker(this.transport);
          this.transport = null;
        }
      },
      log: (message) => log.debug(message),
    });

    await worker.start();
    this.process = worker;
    return worker;
  }
}
