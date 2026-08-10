// 旧 providerSettings 清理（计划 §5，不迁移）：删除字段与全部明文 apiKey、落一次性提示标记、
// 幂等且对「字段本就不存在」无副作用。
//
// store.ts 有模块级 cached / writeQueue，故每个用例都 resetModules + 动态 import 拿一份干净的。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, promises as fsp } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const state = vi.hoisted(() => ({ home: "" }));

vi.mock("electron", () => ({
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../paths", () => ({
  ensureMigrated: async () => undefined,
  workspaceStorePath: () => join(state.home, "personal-workspace.json"),
}));

vi.mock("../log", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// 金库替身（migrateMediaGenPlaintextKeys 用）：可切换 safeStorage 可用性、记录/注入 setSecrets 行为。
// secrets.ts（isAllowedSensitiveValue）是纯函数，不 mock、走真实现。
const credVault = vi.hoisted(() => ({
  available: true,
  setSecretsCalls: [] as Record<string, string>[],
  setSecretsError: null as Error | null,
}));

vi.mock("../providers/credentials", () => ({
  getCredentialStoreHealth: () =>
    credVault.available ? { available: true } : { available: false, reason: "keychain unavailable" },
  setSecrets: async (patch: Record<string, string>) => {
    if (credVault.setSecretsError) throw credVault.setSecretsError;
    credVault.setSecretsCalls.push({ ...patch });
  },
}));

const storePath = () => join(state.home, "personal-workspace.json");
const recoveryPath = () => join(state.home, "personal-workspace.recovery.json");

/** 带旧供应商配置（含明文 apiKey）的历史存档。 */
const LEGACY_STATE = {
  version: 1,
  projects: [],
  sessions: [],
  providerSettings: {
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-live-PLAINTEXT-KEY",
        endpointFormat: "chat_completions",
        models: [{ id: "deepseek-chat" }],
        enabled: true,
      },
    ],
    defaultProviderId: "deepseek",
  },
  generalSettings: { workspaceRoot: "/tmp/ws" },
};

async function writeStore(value: unknown): Promise<void> {
  await fsp.writeFile(storePath(), JSON.stringify(value, null, 2), "utf8");
}

async function readStore(): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(storePath(), "utf8")) as Record<string, unknown>;
}

async function loadModule() {
  vi.resetModules();
  return import("./store");
}

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), "cortex-store-"));
  credVault.available = true;
  credVault.setSecretsCalls = [];
  credVault.setSecretsError = null;
});

afterEach(async () => {
  await fsp.rm(state.home, { recursive: true, force: true });
});

describe("purgeLegacyProviderSettings", () => {
  it("删除旧字段与全部明文密钥，并落一次性提示标记", async () => {
    await writeStore(LEGACY_STATE);
    const { purgeLegacyProviderSettings } = await loadModule();

    expect(await purgeLegacyProviderSettings()).toBe(true);

    const raw = await fsp.readFile(storePath(), "utf8");
    expect(raw).not.toContain("sk-live-PLAINTEXT-KEY");
    expect(raw).not.toContain("providerSettings");

    const next = await readStore();
    expect(next.providerSettings).toBeUndefined();
    expect(next.legacyProviderSettingsCleared).toMatchObject({ noticeAcknowledged: false });
    // 其它分片不受影响。
    expect(next.generalSettings).toEqual({ workspaceRoot: "/tmp/ws" });
  });

  // 「不保留明文备份」是硬要求：不能出现 .bak / providerSettingsLegacy 之类的残留。
  it("不留任何明文备份文件", async () => {
    await writeStore(LEGACY_STATE);
    const { purgeLegacyProviderSettings } = await loadModule();
    await purgeLegacyProviderSettings();

    const files = await fsp.readdir(state.home);
    for (const file of files) {
      const content = await fsp.readFile(join(state.home, file), "utf8");
      expect(content).not.toContain("sk-live-PLAINTEXT-KEY");
    }
  });

  it("幂等：第二次调用不再改写", async () => {
    await writeStore(LEGACY_STATE);
    const { purgeLegacyProviderSettings } = await loadModule();
    await purgeLegacyProviderSettings();
    const firstMark = (await readStore()).legacyProviderSettingsCleared;

    expect(await purgeLegacyProviderSettings()).toBe(false);
    expect((await readStore()).legacyProviderSettingsCleared).toEqual(firstMark);
  });

  it("字段本就不存在时完全不写盘", async () => {
    await writeStore({ version: 1, projects: [], sessions: [] });
    const before = (await fsp.stat(storePath())).mtimeMs;
    const { purgeLegacyProviderSettings } = await loadModule();

    expect(await purgeLegacyProviderSettings()).toBe(false);
    expect((await fsp.stat(storePath())).mtimeMs).toBe(before);
    expect((await readStore()).legacyProviderSettingsCleared).toBeUndefined();
  });

  it("存档文件不存在（首启）时安全返回 false", async () => {
    const { purgeLegacyProviderSettings } = await loadModule();
    expect(await purgeLegacyProviderSettings()).toBe(false);
    await expect(fsp.access(storePath())).rejects.toBeTruthy();
  });

  it("清理后仍能正常读出状态（提示标记进入内存镜像）", async () => {
    await writeStore(LEGACY_STATE);
    const { getPersistedState, purgeLegacyProviderSettings } = await loadModule();
    await purgeLegacyProviderSettings();

    const loaded = await getPersistedState();
    expect(loaded.providerSettings).toBeUndefined();
    expect(loaded.legacyProviderSettingsCleared?.noticeAcknowledged).toBe(false);
  });
});

describe("主进程窄写通道", () => {
  it("updatePersistedState 在权威态上就地合并后落盘", async () => {
    await writeStore({ version: 1, projects: [], sessions: [], generalSettings: { workspaceRoot: "/tmp/ws" } });
    const { updatePersistedState } = await loadModule();

    await updatePersistedState((current) => ({ ...current, rightPanelWidth: 420 }));
    const next = await readStore();
    expect(next.rightPanelWidth).toBe(420);
    expect(next.generalSettings).toEqual({ workspaceRoot: "/tmp/ws" });
  });

  it("全量快照把非空项目和会话清零前，先保留不含设置密钥的恢复索引", async () => {
    const previous = {
      version: 1,
      projects: [{ id: "p1", name: "项目", path: "/workspace", createdAt: 1 }],
      sessions: [{ id: "s1", title: "历史会话", agent: "pi", projectId: "p1", createdAt: 1, updatedAt: 1 }],
      providerSettings: { providers: [{ id: "custom", apiKey: "sk-DO-NOT-BACKUP" }] },
    };
    await writeStore(previous);
    const { getPersistedState, updatePersistedState } = await loadModule();
    await getPersistedState();

    await updatePersistedState((current) => ({ ...current, projects: [], sessions: [] }));

    const recovery = JSON.parse(await fsp.readFile(recoveryPath(), "utf8")) as Record<string, unknown>;
    expect(recovery).toMatchObject({ version: 1, projects: previous.projects, sessions: previous.sessions });
    expect(JSON.stringify(recovery)).not.toContain("sk-DO-NOT-BACKUP");
    expect(recovery).not.toHaveProperty("providerSettings");
  });
});

// ── 阶段③·4.1：写作 / 日报设置里残留的明文凭据 ──────────────────────────────────
//
// 为什么主进程还要抹一遍（渲染端 hydrate 已经丢弃这些键）：hydrate 的丢弃结果要等
// **渲染端下一次全量保存**才落盘。用户升级后不碰任何设置的话，明文 apiKey 会一直留在
// personal-workspace.json 里。首启抹除不依赖用户做任何事。
describe("purgeLegacyPlaintextCredentials", () => {
  /** 旧档：writingLlmSettings 与 timelineSettings 各自带一份明文密钥。 */
  const LEGACY_PLAINTEXT = {
    version: 1,
    projects: [],
    sessions: [],
    writingLlmSettings: {
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-live-WRITING-KEY",
      model: "gpt-x",
      completionEnabled: false,
      debounceMs: 900,
      maxTokens: 128,
    },
    timelineSettings: {
      summaryModel: { kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "sk-live-TIMELINE-KEY", model: "gpt-x" },
    },
  };

  it("摘掉 baseUrl/apiKey/model，但保留用户调过的行为参数", async () => {
    await writeStore(LEGACY_PLAINTEXT);
    const { purgeLegacyPlaintextCredentials } = await loadModule();

    expect(await purgeLegacyPlaintextCredentials()).toBe(true);

    const writing = (await readStore()).writingLlmSettings as Record<string, unknown>;
    // 断言「键不存在」而不是「值为空串」——空串同样会被 JSON 写回磁盘，等于没抹干净。
    expect("apiKey" in writing).toBe(false);
    expect("baseUrl" in writing).toBe(false);
    expect("model" in writing).toBe(false);
    // 行为调优是无害的，用户调过的值没理由跟着一起丢。
    expect(writing.completionEnabled).toBe(false);
    expect(writing.debounceMs).toBe(900);
    expect(writing.maxTokens).toBe(128);
  });

  it("日报的旧 kind:\"openai\" 整条丢弃 → 未配置的 gateway 态（不迁移、不猜模型）", async () => {
    await writeStore(LEGACY_PLAINTEXT);
    const { purgeLegacyPlaintextCredentials } = await loadModule();
    await purgeLegacyPlaintextCredentials();

    const timeline = (await readStore()).timelineSettings as { summaryModel: Record<string, unknown> };
    expect(timeline.summaryModel).toEqual({ kind: "gateway" });
    expect("ref" in timeline.summaryModel).toBe(false); // 未配置态，绝不回退任何模型
  });

  it("落盘后整份存档里搜不到任何明文密钥", async () => {
    await writeStore(LEGACY_PLAINTEXT);
    const { purgeLegacyPlaintextCredentials } = await loadModule();
    await purgeLegacyPlaintextCredentials();

    const raw = JSON.stringify(await readStore());
    expect(raw).not.toContain("sk-live-WRITING-KEY");
    expect(raw).not.toContain("sk-live-TIMELINE-KEY");
  });

  it("幂等：无残留键时返回 false 且不写盘（避免每次启动都产生无谓提交）", async () => {
    const clean = {
      version: 1,
      projects: [],
      sessions: [],
      writingLlmSettings: { providerId: "anthropic", modelId: "m", completionEnabled: true, debounceMs: 650, maxTokens: 96 },
      timelineSettings: { summaryModel: { kind: "gateway", ref: { providerId: "anthropic", modelId: "m" } } },
    };
    await writeStore(clean);
    const { purgeLegacyPlaintextCredentials } = await loadModule();

    expect(await purgeLegacyPlaintextCredentials()).toBe(false);
    expect(await readStore()).toEqual(clean); // 逐字未变，包括已配置的 ref 没被抹掉
  });

  it("两块设置都不存在（全新安装）也不报错、不写盘", async () => {
    await writeStore({ version: 1, projects: [], sessions: [] });
    const { purgeLegacyPlaintextCredentials } = await loadModule();
    expect(await purgeLegacyPlaintextCredentials()).toBe(false);
  });
});

// ── 设计 §4.3：媒体生成明文密钥一次性迁移金库 ────────────────────────────────────
//
// 与 purge 系不同：明文**不能删**（那是用户唯一的一份 key），必须「先落金库、后改写引用」，
// 任一环失败都要保证下次启动可重试收敛、绝不丢 key。
describe("migrateMediaGenPlaintextKeys", () => {
  /** 四模态混合形态旧档：image 明文待迁；speech 已是引用、music $ENV、video !cmd 均不迁。 */
  const mixedMediaGen = () => ({
    image: { enabled: true, providerId: "custom", apiKey: "sk-plain-IMAGE-KEY", baseUrl: "https://a", model: "m" },
    speech: { enabled: false, providerId: "custom", apiKey: "${secret:media.speech.custom}" },
    music: { enabled: false, providerId: "custom", apiKey: "$MEDIA_MUSIC_KEY" },
    video: { enabled: false, providerId: "custom", apiKey: "!op read video-key" },
  });

  const stateWith = (mediaGenSettings: unknown) => ({ version: 1, projects: [], sessions: [], mediaGenSettings });

  it("明文 → 先落金库（media.<modality>.custom），再把 apiKey 改写为引用", async () => {
    await writeStore(stateWith(mixedMediaGen()));
    const { migrateMediaGenPlaintextKeys } = await loadModule();

    expect(await migrateMediaGenPlaintextKeys()).toBe(true);

    // 金库收到的是明文，且只含待迁模态。
    expect(credVault.setSecretsCalls).toEqual([{ "media.image.custom": "sk-plain-IMAGE-KEY" }]);

    const mg = (await readStore()).mediaGenSettings as Record<string, { apiKey: string }>;
    expect(mg.image.apiKey).toBe("${secret:media.image.custom}");
    // 已是允许形态的三个模态原样保留。
    expect(mg.speech.apiKey).toBe("${secret:media.speech.custom}");
    expect(mg.music.apiKey).toBe("$MEDIA_MUSIC_KEY");
    expect(mg.video.apiKey).toBe("!op read video-key");
    // 落盘后整份存档搜不到明文。
    expect(await fsp.readFile(storePath(), "utf8")).not.toContain("sk-plain-IMAGE-KEY");
  });

  it("多模态明文一次批量进金库（同一把锁内落盘，避免部分成功）", async () => {
    const mg = mixedMediaGen();
    mg.video.apiKey = "sk-plain-VIDEO-KEY";
    await writeStore(stateWith(mg));
    const { migrateMediaGenPlaintextKeys } = await loadModule();

    expect(await migrateMediaGenPlaintextKeys()).toBe(true);
    expect(credVault.setSecretsCalls).toEqual([
      { "media.image.custom": "sk-plain-IMAGE-KEY", "media.video.custom": "sk-plain-VIDEO-KEY" },
    ]);
    const next = (await readStore()).mediaGenSettings as Record<string, { apiKey: string }>;
    expect(next.video.apiKey).toBe("${secret:media.video.custom}");
  });

  it("幂等：迁移完成后二跑返回 false 且不写盘、不再触碰金库", async () => {
    await writeStore(stateWith(mixedMediaGen()));
    const { migrateMediaGenPlaintextKeys } = await loadModule();
    await migrateMediaGenPlaintextKeys();
    credVault.setSecretsCalls = [];
    const before = (await fsp.stat(storePath())).mtimeMs;

    expect(await migrateMediaGenPlaintextKeys()).toBe(false);
    expect(credVault.setSecretsCalls).toEqual([]);
    expect((await fsp.stat(storePath())).mtimeMs).toBe(before);
  });

  it("safeStorage 不可用：整体跳过（原值保留、不触金库），下次可用时重试成功", async () => {
    await writeStore(stateWith(mixedMediaGen()));
    const { migrateMediaGenPlaintextKeys } = await loadModule();
    credVault.available = false;

    expect(await migrateMediaGenPlaintextKeys()).toBe(false);
    expect(credVault.setSecretsCalls).toEqual([]);
    const mg = (await readStore()).mediaGenSettings as Record<string, { apiKey: string }>;
    expect(mg.image.apiKey).toBe("sk-plain-IMAGE-KEY"); // 绝不丢 key

    // 「下次启动重试」路径：钥匙串恢复后同一函数即可收敛。
    credVault.available = true;
    expect(await migrateMediaGenPlaintextKeys()).toBe(true);
    expect(credVault.setSecretsCalls).toEqual([{ "media.image.custom": "sk-plain-IMAGE-KEY" }]);
  });

  it("全部已是允许形态（引用/$ENV/!cmd/空串）时完全不写盘", async () => {
    const mg = mixedMediaGen();
    mg.image.apiKey = ""; // 空串不算待迁移
    await writeStore(stateWith(mg));
    const before = (await fsp.stat(storePath())).mtimeMs;
    const { migrateMediaGenPlaintextKeys } = await loadModule();

    expect(await migrateMediaGenPlaintextKeys()).toBe(false);
    expect(credVault.setSecretsCalls).toEqual([]);
    expect((await fsp.stat(storePath())).mtimeMs).toBe(before);
  });

  it("mediaGenSettings 不存在（全新安装）返回 false 不报错", async () => {
    await writeStore({ version: 1, projects: [], sessions: [] });
    const { migrateMediaGenPlaintextKeys } = await loadModule();
    expect(await migrateMediaGenPlaintextKeys()).toBe(false);
  });

  it("金库写入失败：状态不改写、明文保留（下次启动重试，不产生悬空引用）", async () => {
    await writeStore(stateWith(mixedMediaGen()));
    const { migrateMediaGenPlaintextKeys } = await loadModule();
    credVault.setSecretsError = new Error("vault write failed");

    await expect(migrateMediaGenPlaintextKeys()).rejects.toThrowError(/vault write failed/);
    const mg = (await readStore()).mediaGenSettings as Record<string, { apiKey: string }>;
    expect(mg.image.apiKey).toBe("sk-plain-IMAGE-KEY"); // 原值仍在，可重试
  });
});
