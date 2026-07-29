import { describe, expect, it, vi, beforeEach } from "vitest";

// 记录落盘状态的假 store：updatePersistedState 收敛到这里，便于断言「磁盘上到底存了什么」。
let disk: Record<string, unknown> = {};

vi.mock("./store", () => ({
  getPersistedState: async () => disk,
  updatePersistedState: async (fn: (s: Record<string, unknown>) => Record<string, unknown>) => {
    disk = fn(disk);
    return disk;
  },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    // 加密替身：明文加 "enc:" 前缀。断言密文里不含明文是没意义的（前缀方案必然含），
    // 故本文件只断言「密文被完整保留」这件事——真正的加密由 Electron 负责。
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
}));

vi.mock("../log", () => ({ createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) }));

import { setKnowledgeCredential, clearKnowledgeCredential } from "./knowledge";

beforeEach(() => {
  disk = { generalSettings: { desktopBehavior: {}, notifications: {}, log: {} } };
});

describe("setKnowledgeCredential", () => {
  it("明文令牌加密后落盘，不以明文形式存在", async () => {
    await setKnowledgeCredential({ enabled: true, baseUrl: "http://kb:8501", token: "kbmcp_secret" });
    const saved = (disk.generalSettings as Record<string, { encryptedToken?: string }>).knowledgeBase;
    expect(saved.encryptedToken).toBe(Buffer.from("enc:kbmcp_secret", "utf8").toString("base64"));
  });

  // 这是本文件存在的首要理由：曾经回传值刻意抹掉了 encryptedToken，
  // renderer 拿它更新 store 后，usePersonalPersistence 的全量写回把磁盘上的密文覆盖成 undefined，
  // 表现为「保存成功，但测试连接说没填令牌」。回传必须带密文，否则必然重演。
  it("回传切片必须含 encryptedToken —— 否则 renderer 全量写回会把令牌抹掉", async () => {
    const returned = await setKnowledgeCredential({
      enabled: true,
      baseUrl: "http://kb:8501",
      token: "kbmcp_secret",
    });
    expect(returned.encryptedToken).toBeTruthy();
    expect(returned.hasToken).toBe(true);

    // 模拟 renderer 拿回传值做一次全量写回：磁盘上的密文必须还在。
    disk = { ...disk, generalSettings: { ...(disk.generalSettings as object), knowledgeBase: returned } };
    const afterWriteBack = (disk.generalSettings as Record<string, { encryptedToken?: string }>)
      .knowledgeBase;
    expect(afterWriteBack.encryptedToken).toBeTruthy();
  });

  it("回传切片不含明文令牌", async () => {
    const returned = await setKnowledgeCredential({
      enabled: true,
      baseUrl: "http://kb:8501",
      token: "kbmcp_secret",
    });
    expect(JSON.stringify(returned)).not.toContain("kbmcp_secret");
  });

  // 用户改地址时不必重填令牌——不保留的话每次改地址都会把令牌弄丢。
  it("不传 token 时保留已存密文", async () => {
    await setKnowledgeCredential({ enabled: true, baseUrl: "http://kb:8501", token: "kbmcp_secret" });
    const returned = await setKnowledgeCredential({ enabled: true, baseUrl: "http://kb2:8501" });
    expect(returned.encryptedToken).toBe(Buffer.from("enc:kbmcp_secret", "utf8").toString("base64"));
    expect(returned.baseUrl).toBe("http://kb2:8501");
    expect(returned.hasToken).toBe(true);
  });

  it("空白 token 视为未提供，不覆盖已存密文", async () => {
    await setKnowledgeCredential({ enabled: true, baseUrl: "http://kb:8501", token: "kbmcp_secret" });
    const returned = await setKnowledgeCredential({ enabled: true, baseUrl: "http://kb:8501", token: "   " });
    expect(returned.hasToken).toBe(true);
  });

  it("baseUrl 存前去首尾空白", async () => {
    const returned = await setKnowledgeCredential({ enabled: true, baseUrl: "  http://kb:8501  " });
    expect(returned.baseUrl).toBe("http://kb:8501");
  });
});

describe("clearKnowledgeCredential", () => {
  it("清除密文但保留地址与开关", async () => {
    await setKnowledgeCredential({ enabled: true, baseUrl: "http://kb:8501", token: "kbmcp_secret" });
    const returned = await clearKnowledgeCredential();
    expect(returned.hasToken).toBe(false);
    expect(returned.encryptedToken).toBeUndefined();
    expect(returned.baseUrl).toBe("http://kb:8501");
    expect(returned.enabled).toBe(true);
  });
});
